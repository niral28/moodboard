import { clickByText, extractGoogleSerp, extractPage, scrollPage } from './lib/extract';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'extract_page') {
    sendResponse(extractPage());
    return false;
  }
  if (msg?.type === 'click_text') {
    const r = clickByText(document, msg.text || '');
    if (r.ok) {
      setTimeout(() => sendResponse({ ...extractPage(), clicked: msg.text }), 700);
      return true;
    }
    sendResponse({ error: r.error });
    return false;
  }
  if (msg?.type === 'scroll') {
    scrollPage(msg.direction === 'up' ? 'up' : 'down', Number(msg.amount_px) || 800);
    setTimeout(() => sendResponse(extractPage()), 500);
    return true;
  }
  if (msg?.type === 'extract_google_serp') {
    sendResponse({ results: extractGoogleSerp() });
    return false;
  }
  if (msg?.type === 'extract_for_ingest') {
    const data = extractPage();
    sendResponse({
      url: data.url,
      title: data.title,
      content: data.url,
      og_image: data.og_image,
    });
    return false;
  }
  return false;
});
