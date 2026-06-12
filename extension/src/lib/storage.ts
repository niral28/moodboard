/** chrome.storage.local wrapper matching the web app's localStorage keys. */

const KEYS = {
  cards: 'moodboard_cards',
  suggestions: 'moodboard_suggestions',
  taste: 'moodboard_taste',
  gaps: 'moodboard_gaps',
  clusters: 'moodboard_clusters',
} as const;

export async function loadBoardState(): Promise<{
  cards: string | null;
  suggestions: string | null;
  taste: string | null;
  gaps: string | null;
  clusters: string | null;
}> {
  const data = await chrome.storage.local.get(Object.values(KEYS));
  return {
    cards: (data[KEYS.cards] as string) ?? null,
    suggestions: (data[KEYS.suggestions] as string) ?? null,
    taste: (data[KEYS.taste] as string) ?? null,
    gaps: (data[KEYS.gaps] as string) ?? null,
    clusters: (data[KEYS.clusters] as string) ?? null,
  };
}

export async function saveBoardKey(key: keyof typeof KEYS, value: string | null): Promise<void> {
  const storageKey = KEYS[key];
  if (value === null) {
    await chrome.storage.local.remove(storageKey);
  } else {
    await chrome.storage.local.set({ [storageKey]: value });
  }
}

export async function clearBoardStorage(): Promise<void> {
  await chrome.storage.local.remove(Object.values(KEYS));
}

export { KEYS };
