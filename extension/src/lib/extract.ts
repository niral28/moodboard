/** Page extraction logic — shared by content script and background injection. */

export interface PageExtract {
  title: string;
  url: string;
  cleaned_text: string;
  clickables: string[];
  og_image?: string;
  price?: string;
  products_json_ld?: unknown[];
}

function metaContent(doc: Document, selectors: string[]): string | undefined {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    const v = el?.getAttribute('content')?.trim();
    if (v) return v;
  }
  return undefined;
}

function parseJsonLdProducts(doc: Document): unknown[] {
  const out: unknown[] = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || '');
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item?.['@type'] === 'Product' || item?.['@type']?.includes?.('Product')) {
          out.push(item);
        }
        if (Array.isArray(item?.['@graph'])) {
          for (const g of item['@graph']) {
            if (g?.['@type'] === 'Product' || g?.['@type']?.includes?.('Product')) out.push(g);
          }
        }
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function captureClickables(doc: Document): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const sel =
    'button, a[href], [role="button"], [role="link"], [role="menuitem"], input[type="submit"], input[type="button"]';
  for (const el of doc.querySelectorAll(sel)) {
    const htmlEl = el as HTMLElement;
    const r = htmlEl.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > window.innerHeight) continue;
    const style = window.getComputedStyle(htmlEl);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const role =
      htmlEl.getAttribute('role') ||
      (htmlEl.tagName.toLowerCase() === 'a' ? 'link' : 'button');
    const text = (
      htmlEl.innerText ||
      htmlEl.getAttribute('aria-label') ||
      htmlEl.getAttribute('title') ||
      ''
    )
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    if (!text) continue;
    const key = `${role}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${role}: "${text}"`);
    if (out.length >= 40) break;
  }
  return out;
}

export function extractPage(doc: Document = document, pageUrl: string = location.href): PageExtract {
  const ogImage = metaContent(doc, [
    'meta[property="og:image"]',
    'meta[property="og:image:secure_url"]',
    'meta[name="twitter:image"]',
  ]);
  const price = metaContent(doc, [
    'meta[property="og:price:amount"]',
    'meta[property="product:price:amount"]',
    'meta[itemprop="price"]',
  ]);
  const bodyText = doc.body?.innerText || '';
  return {
    title: doc.title || '',
    url: pageUrl,
    cleaned_text: bodyText.slice(0, 6000),
    clickables: captureClickables(doc),
    og_image: ogImage,
    price,
    products_json_ld: parseJsonLdProducts(doc),
  };
}

export function clickByText(doc: Document, text: string): { ok: boolean; error?: string } {
  const needle = text.trim().toLowerCase();
  if (!needle) return { ok: false, error: 'empty text' };
  const sel =
    'button, a[href], [role="button"], [role="link"], input[type="submit"], input[type="button"]';
  for (const el of doc.querySelectorAll(sel)) {
    const htmlEl = el as HTMLElement;
    const label = (
      htmlEl.innerText ||
      htmlEl.getAttribute('aria-label') ||
      htmlEl.getAttribute('title') ||
      ''
    )
      .trim()
      .toLowerCase();
    if (!label) continue;
    if (label === needle || label.includes(needle) || needle.includes(label)) {
      htmlEl.click();
      return { ok: true };
    }
  }
  return { ok: false, error: `no clickable element found matching '${text}'` };
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Extract organic Google SERP links from the current page. */
export function extractGoogleSerp(doc: Document = document, limit = 8): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();

  const candidates = doc.querySelectorAll('div.g, div[data-sokoban-container] div.Gx5Zad');
  for (const block of candidates) {
    const link = block.querySelector('a[href^="http"]') as HTMLAnchorElement | null;
    const heading = block.querySelector('h3');
    if (!link || !heading) continue;
    const url = link.href;
    if (!url || url.includes('google.com/search') || seen.has(url)) continue;
    const title = heading.textContent?.trim() || '';
    if (!title) continue;
    const snippetEl =
      block.querySelector('.VwiC3b, .yXK7lf, .MUxGbd, [data-sncf]') ||
      block.querySelector('div[style*="line-clamp"]');
    const snippet = snippetEl?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 300) || '';
    seen.add(url);
    out.push({ title, url, snippet });
    if (out.length >= limit) break;
  }

  return out;
}

export function scrollPage(direction: 'up' | 'down', amountPx: number): { new_text: string } {
  const prev = document.body?.innerText || '';
  const delta = direction === 'down' ? amountPx : -amountPx;
  window.scrollBy(0, delta);
  const next = document.body?.innerText || '';
  const added = next.startsWith(prev) ? next.slice(prev.length) : next;
  return { new_text: (added || next).slice(0, 2500) };
}
