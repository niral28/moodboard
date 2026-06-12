const DEFAULT_API_BASE = 'http://localhost:8000';

export async function getApiBase(): Promise<string> {
  const stored = await chrome.storage.sync.get(['apiBase']);
  return (stored.apiBase as string) || DEFAULT_API_BASE;
}

export async function setApiBase(url: string): Promise<void> {
  await chrome.storage.sync.set({ apiBase: url.replace(/\/$/, '') });
}

export const DEFAULT_API = DEFAULT_API_BASE;
