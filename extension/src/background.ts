import { getApiBase } from './lib/config';
import type { PageExtract } from './lib/extract';

const SCOUT_GROUP_TITLE = 'Moodboard scouts';
const SESSION_GROUP_KEY = 'scoutGroupId';
const SESSION_TAB_KEY = 'activeScoutTabId';

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const inFlightActions = new Set<string>();

async function apiBase(): Promise<string> {
  return getApiBase();
}

async function postJson(path: string, body: unknown): Promise<Response> {
  const base = await apiBase();
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function extensionHello(): Promise<void> {
  try {
    await postJson('/extension/hello', { version: chrome.runtime.getManifest().version });
  } catch (e) {
    console.warn('extension hello failed', e);
  }
}

async function pollPendingActions(): Promise<void> {
  try {
    const base = await apiBase();
    const resp = await fetch(`${base}/extension/pending-actions`);
    if (!resp.ok) return;
    const data = (await resp.json()) as { actions?: Array<Record<string, unknown>> };
    for (const action of data.actions || []) {
      if (action.kind !== 'browser_action' || typeof action.action_id !== 'string') continue;
      void handleBrowserAction(action as Parameters<typeof handleBrowserAction>[0]);
    }
  } catch (e) {
    console.warn('pending-actions poll failed', e);
  }
}

function connectSse(): void {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  void (async () => {
    const base = await apiBase();
    eventSource = new EventSource(`${base}/events`);
    eventSource.onopen = () => {
      console.info('[moodboard] SSE connected');
      void extensionHello();
      void pollPendingActions();
    };
    eventSource.onmessage = (ev) => {
      if (!ev.data) return;
      try {
        const data = JSON.parse(ev.data);
        if (data.kind === 'browser_action') {
          void handleBrowserAction(data);
        }
        if (data.kind === 'ingest_card') {
          void chrome.runtime.sendMessage({ type: 'ingest_card', card: data.card }).catch(() => {});
        }
      } catch (e) {
        console.warn('SSE parse error', e);
      }
    };
    eventSource.onerror = () => {
      eventSource?.close();
      eventSource = null;
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectSse();
        }, 3000);
      }
    };
  })();
}

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    void extensionHello();
    void pollPendingActions();
    if (!eventSource) connectSse();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'add-to-moodboard',
    title: 'Add to Moodboard',
    contexts: ['page', 'link', 'image'],
  });
  connectSse();
});

chrome.runtime.onStartup.addListener(() => connectSse());
connectSse();

async function getStoredScoutGroupId(): Promise<number | undefined> {
  const stored = await chrome.storage.session.get(SESSION_GROUP_KEY);
  const existing = stored[SESSION_GROUP_KEY] as number | undefined;
  if (existing === undefined) return undefined;
  try {
    await chrome.tabGroups.get(existing);
    return existing;
  } catch {
    await chrome.storage.session.remove(SESSION_GROUP_KEY);
    return undefined;
  }
}

async function addTabToScoutGroup(tabId: number): Promise<void> {
  let groupId = await getStoredScoutGroupId();
  if (groupId === undefined) {
    groupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(groupId, {
      title: SCOUT_GROUP_TITLE,
      collapsed: false,
      color: 'yellow',
    });
    await chrome.storage.session.set({ [SESSION_GROUP_KEY]: groupId });
  } else {
    await chrome.tabs.group({ tabIds: tabId, groupId });
  }
  await chrome.storage.session.set({ [SESSION_TAB_KEY]: tabId });
}

async function waitForTabLoad(tabId: number, timeoutMs = 20000): Promise<void> {
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === 'complete') return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function extractFromTab(tabId: number): Promise<PageExtract & { error?: string }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const results = await chrome.tabs.sendMessage(tabId, { type: 'extract_page' });
      return results as PageExtract;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return {
    title: '',
    url: '',
    cleaned_text: '',
    clickables: [],
    error: 'content script not ready on tab',
  };
}

async function handleGoogleSearch(query: string): Promise<Record<string, unknown>> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) return { error: 'failed to create tab' };
  await addTabToScoutGroup(tab.id);
  await waitForTabLoad(tab.id);
  await new Promise((r) => setTimeout(r, 800));
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'extract_google_serp' });
    const results = Array.isArray(resp?.results) ? resp.results : [];
    if (results.length === 0) {
      return { error: 'no Google results extracted (CAPTCHA or layout change?)', tab_id: tab.id };
    }
    return { results, tab_id: tab.id };
  } catch (e) {
    return { error: String(e), tab_id: tab.id };
  }
}

async function handleOpenLink(url: string, active: boolean): Promise<Record<string, unknown>> {
  const tab = await chrome.tabs.create({ url, active });
  if (!tab.id) return { error: 'failed to create tab' };
  await addTabToScoutGroup(tab.id);
  await waitForTabLoad(tab.id);
  await new Promise((r) => setTimeout(r, 600));
  const extracted = await extractFromTab(tab.id);
  if (extracted.error && !extracted.cleaned_text) return { error: extracted.error };
  return {
    title: extracted.title,
    url: extracted.url || url,
    popups_dismissed: 0,
    cleaned_text: extracted.cleaned_text.slice(0, 3000),
    clickables: extracted.clickables,
    og_image: extracted.og_image,
    price: extracted.price,
    tab_id: tab.id,
  };
}

async function handleClick(tabId: number, text: string): Promise<Record<string, unknown>> {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'click_text', text });
    if (result?.error) return { error: result.error };
    return {
      clicked: text,
      url: result.url,
      page_text_after: (result.cleaned_text || '').slice(0, 2500),
      clickables: result.clickables || [],
    };
  } catch (e) {
    return { error: String(e) };
  }
}

async function handleScroll(
  tabId: number,
  direction: string,
  amountPx: number,
): Promise<Record<string, unknown>> {
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'scroll',
      direction,
      amount_px: amountPx,
    });
    return {
      new_text: (result.cleaned_text || '').slice(0, 2500),
      clickables: result.clickables || [],
      url: result.url,
    };
  } catch (e) {
    return { error: String(e) };
  }
}

async function handleExtract(tabId: number): Promise<Record<string, unknown>> {
  const extracted = await extractFromTab(tabId);
  if (extracted.error) return { error: extracted.error };
  return {
    page_url: extracted.url,
    cleaned_text: extracted.cleaned_text.slice(0, 6000),
    products_json_ld: extracted.products_json_ld,
  };
}

async function handleBrowserAction(data: {
  action_id: string;
  scout_id: string;
  tool: string;
  args: Record<string, unknown>;
}): Promise<void> {
  if (inFlightActions.has(data.action_id)) return;
  inFlightActions.add(data.action_id);

  const { action_id, tool, args } = data;
  let result: Record<string, unknown> = {};
  let error: string | undefined;

  try {
    void extensionHello();
    const stored = await chrome.storage.session.get(SESSION_TAB_KEY);
    const tabId = (args.tab_id as number) || (stored[SESSION_TAB_KEY] as number | undefined);

    if (tool === 'google_search') {
      result = await handleGoogleSearch(String(args.query || ''));
    } else if (tool === 'open_link' || tool === 'open_tab') {
      result = await handleOpenLink(String(args.url || ''), true);
    } else if (tool === 'click') {
      if (!tabId) throw new Error('no active tab; call open_link first');
      result = await handleClick(tabId, String(args.text || ''));
    } else if (tool === 'scroll_and_capture') {
      if (!tabId) throw new Error('no active tab; call open_link first');
      result = await handleScroll(tabId, String(args.direction || 'down'), Number(args.amount_px) || 800);
    } else if (tool === 'extract_products' || tool === 'extract_page') {
      if (!tabId) throw new Error('no active tab; call open_link first');
      result = await handleExtract(tabId);
    } else {
      error = `unknown tool: ${tool}`;
    }
  } catch (e) {
    error = String(e);
  } finally {
    inFlightActions.delete(action_id);
  }

  try {
    await postJson('/browser/result', { action_id, result, error });
  } catch (e) {
    console.error('failed to post browser result', e);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    const url = info.linkUrl || info.srcUrl || info.pageUrl || tab?.url;
    if (!url) return;
    let content = url;
    if (tab?.id) {
      try {
        const meta = await chrome.tabs.sendMessage(tab.id, { type: 'extract_for_ingest' });
        if (meta?.title) content = `${meta.title}\n${url}`;
      } catch {
        /* content script may not be ready */
      }
    }
    try {
      const base = await apiBase();
      const resp = await fetch(`${base}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, hint: 'link' }),
      });
      if (!resp.ok) throw new Error('ingest failed');
      const card = await resp.json();
      await chrome.runtime.sendMessage({ type: 'ingest_card', card }).catch(() => {});
      void chrome.tabs.create({ url: chrome.runtime.getURL('src/newtab/index.html') });
    } catch (e) {
      console.error('context menu ingest failed', e);
    }
  })();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'wake') {
    void extensionHello();
    void pollPendingActions();
    if (!eventSource) connectSse();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'clear_scout_group') {
    void (async () => {
      const stored = await chrome.storage.session.get(SESSION_GROUP_KEY);
      const groupId = stored[SESSION_GROUP_KEY] as number | undefined;
      if (groupId !== undefined) {
        const tabs = await chrome.tabs.query({ groupId });
        for (const t of tabs) {
          if (t.id) await chrome.tabs.remove(t.id);
        }
        try {
          await chrome.tabGroups.remove(groupId);
        } catch {
          /* already gone */
        }
      }
      await chrome.storage.session.remove([SESSION_GROUP_KEY, SESSION_TAB_KEY]);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg?.type === 'get_status') {
    void (async () => {
      try {
        const base = await apiBase();
        const r = await fetch(`${base}/extension/status`);
        sendResponse(await r.json());
      } catch (e) {
        sendResponse({ backend: 'offline', error: String(e) });
      }
    })();
    return true;
  }
  return false;
});
