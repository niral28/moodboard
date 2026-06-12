import React, { useState, useEffect } from 'react';
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { Canvas } from '@frontend/components/Canvas';
import { DropZone } from '@frontend/components/DropZone';
import { Sidebar } from '@frontend/components/Sidebar';
import type { Candidate } from '@frontend/components/Sidebar';
import { ActivityLog } from '@frontend/components/ActivityLog';
import type { LogEntry } from '@frontend/components/ActivityLog';
import type { CardType } from '@frontend/components/Card';
import type { SuggestionType } from '@frontend/components/SuggestionCard';
import { Sparkles, RotateCcw, AlertTriangle, CheckCircle, Info, Loader2, PanelRightClose, PanelRightOpen, ChevronDown, ChevronUp, ZoomIn, ZoomOut, Maximize2, Download, Upload, Settings, X } from 'lucide-react';
import { getApiBase } from '../lib/config';
import { loadBoardState, saveBoardKey, clearBoardStorage } from '../lib/storage';

// Map browser locale → display currency. Falls back to USD.
const REGION_CURRENCY: Record<string, string> = {
  US: 'USD', GB: 'GBP', JP: 'JPY', CN: 'CNY', IN: 'INR',
  CA: 'CAD', AU: 'AUD', NZ: 'NZD', CH: 'CHF', KR: 'KRW',
  BR: 'BRL', MX: 'MXN', SE: 'SEK', NO: 'NOK', DK: 'DKK',
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR',
  IE: 'EUR', AT: 'EUR', BE: 'EUR', PT: 'EUR', FI: 'EUR',
};
function detectCurrency(): string {
  try {
    const lang = navigator.language || 'en-US';
    const region = (lang.split('-')[1] || 'US').toUpperCase();
    return REGION_CURRENCY[region] || 'USD';
  } catch {
    return 'USD';
  }
}
const USER_CURRENCY = detectCurrency();

// Downsize uploaded images to ~720px max before storing as the card's cover.
// Keeps localStorage manageable and shrinks the curate payload too.
async function resizeImageFileToDataUrl(file: File, maxDim = 720, quality = 0.85): Promise<string> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(maxDim / img.width, maxDim / img.height, 1);
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(original); return; }
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch {
        resolve(original);
      }
    };
    img.onerror = () => resolve(original);
    img.src = original;
  });
}

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

export interface ClusterType {
  id: string;
  label: string;          // original from curator
  custom_label?: string;  // user-renamed (preserved across re-curates)
  card_ids: string[];
}

// Auto-layout cards into a 2-column grid of clusters. Cards in the same cluster
// land in their own internal 2-column grid below a label band.
const LAYOUT = {
  PAD: 80,
  COLS: 2,
  CLUSTER_W: 620,
  CLUSTER_H: 700,
  CLUSTER_GAP: 80,
  INNER_PAD: 28,
  LABEL_BAND: 56,
  CARD_W: 260,
  CARD_H: 340,
  CARD_GAP: 20,
};

function autoLayoutByCluster(clusters: ClusterType[], cards: CardType[]) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const positioned = new Set<string>();
  const out: typeof cards = [];

  clusters.forEach((cluster, ci) => {
    const col = ci % LAYOUT.COLS;
    const row = Math.floor(ci / LAYOUT.COLS);
    const cx = LAYOUT.PAD + col * (LAYOUT.CLUSTER_W + LAYOUT.CLUSTER_GAP);
    const cy = LAYOUT.PAD + row * (LAYOUT.CLUSTER_H + LAYOUT.CLUSTER_GAP);

    cluster.card_ids.forEach((cid, ki) => {
      const card = byId.get(cid);
      if (!card) return;
      const kCol = ki % LAYOUT.COLS;
      const kRow = Math.floor(ki / LAYOUT.COLS);
      out.push({
        ...card,
        x: cx + LAYOUT.INNER_PAD + kCol * (LAYOUT.CARD_W + LAYOUT.CARD_GAP),
        y: cy + LAYOUT.LABEL_BAND + LAYOUT.INNER_PAD + kRow * (LAYOUT.CARD_H + LAYOUT.CARD_GAP),
      });
      positioned.add(cid);
    });
  });

  cards.forEach((c) => {
    if (!positioned.has(c.id)) out.push(c);
  });

  return out;
}

export default function App() {
  const [apiBase, setApiBase] = useState('http://localhost:8000');
  const [backendStatus, setBackendStatus] = useState<{
    ok: boolean;
    ollama?: boolean;
    extension_connected?: boolean;
    model?: string;
  } | null>(null);
  const [cards, setCards] = useState<CardType[]>([]);
  // Suggestions now live on the canvas as ghost cards, positioned in their cluster.
  const [suggestions, setSuggestions] = useState<SuggestionType[]>([]);
  const [tasteProfile, setTasteProfile] = useState('');
  const [gaps, setGaps] = useState<string[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [isStagingUrl, setIsStagingUrl] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [logOpen, setLogOpen] = useState(true);
  const [canvasOffset, setCanvasOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [canvasScale, setCanvasScale] = useState<number>(1);
  const [clusters, setClusters] = useState<ClusterType[]>([]);
  const [scoutingClusters, setScoutingClusters] = useState<Set<string>>(new Set());

  // dnd-kit: require 5px of movement before starting a drag — so clicks on
  // buttons inside cards (expand, delete) work normally without triggering drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Refs so SSE handlers (which capture state at mount) can read current values
  // when deciding where to place an incoming suggestion.
  const clustersRef = React.useRef<ClusterType[]>([]);
  const cardsRef = React.useRef<CardType[]>([]);
  const suggestionsRef = React.useRef<SuggestionType[]>([]);
  useEffect(() => { clustersRef.current = clusters; }, [clusters]);
  useEffect(() => { cardsRef.current = cards; }, [cards]);
  useEffect(() => { suggestionsRef.current = suggestions; }, [suggestions]);

  // Walk the cluster's grid until we find a slot that doesn't collide with any
  // existing card or already-placed suggestion. Cards/suggestions are treated
  // as CARD_W x CARD_H rects; we accept a free slot when no occupant overlaps.
  function placeSuggestionInCluster(clusterId: string | undefined): { x: number; y: number } {
    const cs = clustersRef.current;
    const clusterIdx = clusterId ? cs.findIndex((c) => c.id === clusterId) : -1;

    // Origin: either the cluster's natural top-left in the global grid, or an
    // off-canvas fallback for unaffiliated suggestions so they don't pile up
    // in the visible region.
    let cx: number;
    let cy: number;
    if (clusterIdx >= 0) {
      const col = clusterIdx % LAYOUT.COLS;
      const row = Math.floor(clusterIdx / LAYOUT.COLS);
      cx = LAYOUT.PAD + col * (LAYOUT.CLUSTER_W + LAYOUT.CLUSTER_GAP);
      cy = LAYOUT.PAD + row * (LAYOUT.CLUSTER_H + LAYOUT.CLUSTER_GAP);
    } else {
      cx = LAYOUT.PAD;
      cy = LAYOUT.PAD;
    }

    const COLLISION_PAD = 8; // a couple px of breathing room
    const occupants: { x: number; y: number }[] = [
      ...cardsRef.current.map((c) => ({ x: c.x, y: c.y })),
      ...suggestionsRef.current.map((s) => ({ x: s.x, y: s.y })),
    ];

    const collides = (x: number, y: number): boolean => {
      for (const o of occupants) {
        const noOverlap =
          x + LAYOUT.CARD_W + COLLISION_PAD < o.x ||
          o.x + LAYOUT.CARD_W + COLLISION_PAD < x ||
          y + LAYOUT.CARD_H + COLLISION_PAD < o.y ||
          o.y + LAYOUT.CARD_H + COLLISION_PAD < y;
        if (!noOverlap) return true;
      }
      return false;
    };

    // Walk up to 60 grid slots (cluster auto-grows downward as needed).
    for (let slot = 0; slot < 60; slot++) {
      const sCol = slot % LAYOUT.COLS;
      const sRow = Math.floor(slot / LAYOUT.COLS);
      const x = cx + LAYOUT.INNER_PAD + sCol * (LAYOUT.CARD_W + LAYOUT.CARD_GAP);
      const y = cy + LAYOUT.LABEL_BAND + LAYOUT.INNER_PAD + sRow * (LAYOUT.CARD_H + LAYOUT.CARD_GAP);
      if (!collides(x, y)) return { x, y };
    }
    // All 60 slots taken — stack below the last row (rare; cluster regions handle it).
    const finalRow = Math.floor(60 / LAYOUT.COLS);
    return {
      x: cx + LAYOUT.INNER_PAD,
      y: cy + LAYOUT.LABEL_BAND + LAYOUT.INNER_PAD + finalRow * (LAYOUT.CARD_H + LAYOUT.CARD_GAP),
    };
  }

  // Resolve API base from extension storage
  useEffect(() => {
    void getApiBase().then(setApiBase);
  }, []);

  // Poll backend / extension status for setup banner
  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch(`${apiBase}/extension/status`);
        if (r.ok) {
          const data = await r.json();
          setBackendStatus({
            ok: data.backend === 'ok',
            ollama: data.ollama?.reachable,
            extension_connected: data.extension_connected,
            model: data.ollama?.model || data.model,
          });
        } else {
          setBackendStatus({ ok: false });
        }
      } catch {
        setBackendStatus({ ok: false });
      }
    };
    check();
    const id = setInterval(check, 15000);
    return () => clearInterval(id);
  }, [apiBase]);

  // 1. Load from chrome.storage or initialize with demo cards
  useEffect(() => {
    void (async () => {
    const saved = await loadBoardState();
    if (saved.clusters) {
      try { setClusters(JSON.parse(saved.clusters)); } catch {}
    }

    if (saved.cards) {
      const restored: CardType[] = JSON.parse(saved.cards);
      // Any card stuck mid-enrichment (page closed before backend responded)
      // gets marked ready so the pulse stops. User can re-paste if they want.
      setCards(restored.map((c) => (c.status && c.status !== 'ready' ? { ...c, status: 'ready' } : c)));
    } else {
      // Prepopulate with 4 beautiful demo cards (Kyoto theme)
      const demoCards: CardType[] = [
        {
          id: 'demo-1',
          type: 'link',
          title: 'Kyoto Arashiyama Bamboo Forest Guide',
          summary: 'A comprehensive travel guide to Arashiyama bamboo trails, highlighting crowd-free visiting hours.',
          entities: ['Kyoto', 'bamboo forest', 'scenic', 'trails'],
          url: 'https://example.com/kyoto-bamboo',
          x: 40,
          y: 40,
        },
        {
          id: 'demo-2',
          type: 'email',
          title: 'Partner Meeting & Kaiseki Reservation',
          summary: 'Kaiseki dinner reservation details confirmed by the operations partner in Kyoto.',
          entities: ['Gion', 'kaiseki', 'dining', 'meeting'],
          sender: 'kenji.sato@kyototours.co.jp',
          subject: 'Kaiseki Dining Reservation Confirmed - Gion Kyoto',
          date: 'May 23, 2026',
          body_summary: 'Dinner confirmed at Gion Karyo at 7:00 PM for 3 guests. Kaiseki traditional multi-course tasting menu.',
          x: 360,
          y: 60,
        },
        {
          id: 'demo-3',
          type: 'image',
          title: 'Arashiyama Scenic Snapshot',
          summary: 'Visual scenery concept showing misty emerald green stalks under natural ambient lighting.',
          entities: ['emerald green', 'misty lighting', 'scenic imagery'],
          visual_features: 'Deep emerald greens, vertical towering symmetry, high-key ambient shafts',
          url: 'https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?auto=format&fit=crop&w=400&q=80',
          x: 80,
          y: 280,
        },
        {
          id: 'demo-4',
          type: 'text',
          title: 'Idea: Traditional Machiya Stay',
          summary: 'Explore booking a fully renovated traditional Japanese townhouse (machiya) instead of standard hotels to enhance the cultural immersion.',
          entities: ['machiya', 'townhouse', 'cultural lodging', 'immersion'],
          x: 400,
          y: 340,
        },
      ];
      setCards(demoCards);
    }

    if (saved.suggestions) setSuggestions(JSON.parse(saved.suggestions));
    if (saved.taste) setTasteProfile(saved.taste);
    if (saved.gaps) setGaps(JSON.parse(saved.gaps));
    })();
  }, []);

  // 2. Save state to chrome.storage.local
  useEffect(() => {
    if (cards.length > 0) {
      void saveBoardKey('cards', JSON.stringify(cards));
    } else {
      void saveBoardKey('cards', null);
    }
  }, [cards]);

  useEffect(() => {
    void saveBoardKey('suggestions', JSON.stringify(suggestions));
  }, [suggestions]);

  useEffect(() => {
    void saveBoardKey('taste', tasteProfile || null);
  }, [tasteProfile]);

  useEffect(() => {
    void saveBoardKey('gaps', JSON.stringify(gaps));
  }, [gaps]);

  useEffect(() => {
    if (clusters.length > 0) {
      void saveBoardKey('clusters', JSON.stringify(clusters));
    } else {
      void saveBoardKey('clusters', null);
    }
  }, [clusters]);

  // Wake the MV3 service worker so scout browser actions work (open_link, etc.)
  useEffect(() => {
    void chrome.runtime.sendMessage({ type: 'wake' }).catch(() => {});
  }, [apiBase]);

  // 3. Connect to backend Server-Sent Events stream — log entries + live candidates
  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      eventSource?.close();
      eventSource = new EventSource(`${apiBase}/events`);

      eventSource.onopen = () => {
        void chrome.runtime.sendMessage({ type: 'wake' }).catch(() => {});
      };

      eventSource.onmessage = (event) => {
      try {
        if (!event.data) return;
        const data = JSON.parse(event.data);

        // Background worker handles browser_action; ignore here.
        if (data.kind === 'browser_action' || data.kind === 'ingest_card') return;

        if (data.kind === 'stage_complete' && data.url) {
          setSuggestions((prev) =>
            prev.map((s) =>
              s.url === data.url
                ? { ...s, image_url: data.image_url || s.image_url, price: data.price || s.price }
                : s,
            ),
          );
          showToast('Staged in Chrome — tab left open', 'success');
          return;
        }

        // Streaming candidate from a scout — drop it into its cluster on the canvas.
        if (data.kind === 'candidate' && data.candidate) {
          const c = data.candidate as Candidate;
          const clusterId: string | undefined = data.cluster_id;
          const pos = placeSuggestionInCluster(clusterId);
          const suggestion: SuggestionType = {
            url: c.url,
            title: c.title,
            match_reason: c.match_reason,
            price: c.price,
            image_url: c.image_url,
            emoji: (c as any).emoji,
            cluster_id: clusterId,
            x: pos.x,
            y: pos.y,
          };
          setSuggestions((prev) => (prev.some((s) => s.url === suggestion.url) ? prev : [...prev, suggestion]));
          return;
        }

        // Otherwise it's a log entry (must have agent + message).
        if (!data.agent || !data.message) return;
        const log = data as LogEntry;
        if (log.cluster_id && log.phase) {
          const cid = log.cluster_id;
          const ph = log.phase;
          setScoutingClusters((prev) => {
            const next = new Set(prev);
            if (ph === 'start') next.add(cid);
            else if (ph === 'end') next.delete(cid);
            return next;
          });
        }

        setLogs((prevLogs) => {
          const isDuplicate = prevLogs.some(
            (l) => l.message === log.message && l.timestamp === log.timestamp
          );
          if (isDuplicate) return prevLogs;
          return [...prevLogs, log];
        });
      } catch (err) {
        console.error('Failed to parse SSE event:', err);
      }
    };

      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;
        if (!disposed && !reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 3000);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      eventSource?.close();
    };
  }, [apiBase]);

  // Cmd+V anywhere → if the clipboard has an image, ingest it as a card.
  // Text paste into focused inputs is unaffected (browser handles it).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            handleIngestFile(file);
            return;
          }
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  // 4. Toast notifications helper
  const showToast = (message: string, type: Toast['type'] = 'info') => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // Context-menu ingest from background service worker
  useEffect(() => {
    const listener = (msg: { type?: string; card?: CardType }) => {
      if (msg?.type === 'ingest_card' && msg.card) {
        const c = msg.card;
        setCards((prev) => [
          ...prev,
          {
            ...c,
            x: 100 + Math.random() * 200,
            y: 100 + Math.random() * 200,
            status: 'ready' as const,
          },
        ]);
        showToast(`Added: "${c.title}"`, 'success');
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // --- Handlers ---

  // Drag and drop updating card positions
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, delta } = event;
    if (!active) return;

    // delta from dnd-kit is in screen pixels; convert to canvas-local by /scale.
    const dx = delta.x / canvasScale;
    const dy = delta.y / canvasScale;
    setCards((prevCards) =>
      prevCards.map((card) =>
        card.id === active.id ? { ...card, x: card.x + dx, y: card.y + dy } : card,
      ),
    );
  };

  // --- Lazy / background ingestion (Option C) ---
  // Card appears on canvas instantly with minimal info, then the backend
  // enriches it in the background. Card.status drives the visual pulse.

  // Infer a usable card from raw input client-side so the UI never waits.
  function inferInitialCard(content: string, hint: string | null): Partial<CardType> {
    const trimmed = content.trim();
    if (hint === 'email' || /^\s*(from|subject|to|date)\s*:/im.test(trimmed)) {
      return { type: 'email', title: 'Email card', summary: '' };
    }
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const u = new URL(trimmed);
        return {
          type: 'link',
          title: u.hostname.replace(/^www\./, ''),
          url: trimmed,
          summary: '',
        };
      } catch {
        return { type: 'link', title: 'Link', url: trimmed, summary: '' };
      }
    }
    return {
      type: 'text',
      title: trimmed.slice(0, 60) || 'Note',
      summary: trimmed.length > 60 ? trimmed.slice(60, 240) : '',
    };
  }

  // Fire-and-forget enrichment. Updates the placeholder card in place.
  const enrichCard = async (
    cardId: string,
    payload: { content: string; hint: string | null; file?: File },
  ) => {
    setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, status: 'enriching' } : c)));
    try {
      let response: Response;
      if (payload.file) {
        const formData = new FormData();
        formData.append('file', payload.file);
        if (payload.hint) formData.append('hint', payload.hint);
        response = await fetch(`${apiBase}/ingest`, { method: 'POST', body: formData });
      } else {
        response = await fetch(`${apiBase}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: payload.content, hint: payload.hint }),
        });
      }
      if (!response.ok) throw new Error('ingest failed');
      const enriched: CardType = await response.json();

      setCards((prev) =>
        prev.map((c) => {
          if (c.id !== cardId) return c;
          // Merge: preserve id, position, frontend-set cover_image (uploads),
          // and overwrite metadata fields from the enriched response.
          return {
            ...c,
            type: c.cover_image ? 'image' : enriched.type,
            title: enriched.title || c.title,
            summary: enriched.summary || c.summary,
            entities: enriched.entities || c.entities,
            url: c.url ?? enriched.url,
            cover_image: c.cover_image || enriched.cover_image,
            visual_features: enriched.visual_features ?? c.visual_features,
            sender: enriched.sender ?? c.sender,
            subject: enriched.subject ?? c.subject,
            date: enriched.date ?? c.date,
            body_summary: enriched.body_summary ?? c.body_summary,
            status: 'ready',
          };
        }),
      );
    } catch (err) {
      console.error('enrich failed', err);
      setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, status: 'ready' } : c)));
      showToast('Background enrichment failed', 'warning');
    }
  };

  const handleIngestText = async (text: string, forceEmail: boolean) => {
    const partial = inferInitialCard(text, forceEmail ? 'email' : null);
    const card: CardType = {
      id: Math.random().toString(36).substr(2, 9),
      type: (partial.type as CardType['type']) || 'text',
      title: partial.title || '...',
      summary: partial.summary || '',
      entities: [],
      url: partial.url,
      x: 100 + Math.random() * 200,
      y: 100 + Math.random() * 200,
      status: 'pending',
    };
    setCards((prev) => [...prev, card]);
    showToast('Card added · analyzing…', 'info');
    enrichCard(card.id, { content: text, hint: forceEmail ? 'email' : null });
  };

  const handleIngestFile = async (file: File) => {
    let previewDataUrl: string | null = null;
    if (file.type.startsWith('image/')) {
      try {
        previewDataUrl = await resizeImageFileToDataUrl(file);
      } catch {
        previewDataUrl = null;
      }
    }

    const isImage = !!previewDataUrl;
    const fileTitle = file.name.replace(/\.[^/.]+$/, '');
    const card: CardType = {
      id: Math.random().toString(36).substr(2, 9),
      type: isImage ? 'image' : file.name.endsWith('.eml') ? 'email' : 'text',
      title: fileTitle.slice(0, 60) || 'Upload',
      summary: '',
      entities: [],
      cover_image: previewDataUrl || undefined,
      x: 100 + Math.random() * 200,
      y: 100 + Math.random() * 200,
      status: 'pending',
    };
    setCards((prev) => [...prev, card]);
    showToast('Card added · analyzing…', 'info');
    enrichCard(card.id, {
      content: file.name,
      hint: file.name.endsWith('.eml') ? 'email' : null,
      file,
    });
  };

  // Cluster operations
  const handleRenameCluster = (id: string, newLabel: string) => {
    const trimmed = newLabel.trim();
    setClusters((prev) =>
      prev.map((c) => (c.id === id ? { ...c, custom_label: trimmed || undefined } : c)),
    );
  };

  // Move a whole cluster by (dx, dy) — applied to the snapshot positions of its cards.
  const handleMoveCluster = (
    id: string,
    dx: number,
    dy: number,
    snapshot: { id: string; x: number; y: number }[],
  ) => {
    const cluster = clusters.find((c) => c.id === id);
    if (!cluster) return;
    const memberIds = new Set(cluster.card_ids);
    const snapBy = new Map(snapshot.map((s) => [s.id, s]));
    setCards((prev) =>
      prev.map((c) => {
        if (!memberIds.has(c.id)) return c;
        const s = snapBy.get(c.id);
        if (!s) return c;
        return { ...c, x: s.x + dx, y: s.y + dy };
      }),
    );
  };

  // In-canvas removal
  const handleRemoveCard = (id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id));
    showToast('Card removed from canvas', 'info');
  };

  // Suggestion → real card: keep the same canvas position so it lands in place.
  const handleAddSuggestion = (s: SuggestionType) => {
    const newCardId = Math.random().toString(36).substr(2, 9);
    const newCard: CardType = {
      id: newCardId,
      type: 'link',
      title: s.title,
      summary: s.match_reason,
      entities: ['scouted', 'suggestion'],
      url: s.url,
      cover_image: s.image_url,
      emoji: s.emoji,
      x: s.x,
      y: s.y,
      status: 'ready',
    };
    setCards((prev) => [...prev, newCard]);
    // If this suggestion was inside a cluster, attach the new card to it so
    // the cluster region grows to include it.
    if (s.cluster_id) {
      setClusters((prev) =>
        prev.map((cl) => (cl.id === s.cluster_id ? { ...cl, card_ids: [...cl.card_ids, newCardId] } : cl)),
      );
    }
    setSuggestions((prev) => prev.filter((x) => x.url !== s.url));
    showToast(`Added: "${s.title}"`, 'success');
  };

  // Light-touch taste profile refresh — runs Curate against the current board
  // but only updates taste_profile + gaps (keeping clusters and card positions
  // stable). Called after feedback so the user visibly sees the profile evolve.
  const refreshTasteProfile = async () => {
    try {
      const r = await fetch(`${apiBase}/curate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cards }),
      });
      if (!r.ok) return;
      const data = await r.json();
      if (typeof data.taste_profile === 'string') setTasteProfile(data.taste_profile);
      if (Array.isArray(data.gaps)) setGaps(data.gaps);
    } catch (err) {
      console.error('taste refresh failed', err);
    }
  };

  const handleDismissSuggestion = async (s: SuggestionType, reason: string | null) => {
    setSuggestions((prev) => prev.filter((x) => x.url !== s.url));
    try {
      await fetch(`${apiBase}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason,
          suggestion_title: s.title,
          suggestion_url: s.url,
          cluster_id: s.cluster_id || null,
        }),
      });
      showToast(reason ? 'Feedback recorded · refreshing taste profile' : 'Suggestion dismissed', 'info');
      if (reason) {
        // Fire-and-forget — the sidebar updates when it returns.
        refreshTasteProfile();
      }
    } catch (err) {
      console.error('feedback failed', err);
      showToast('Dismissed (feedback save failed)', 'warning');
    }
  };

  // Stage cart URL page in real Chrome context
  const handleStageSuggestion = async (url: string) => {
    setIsStagingUrl(url);
    try {
      const response = await fetch(`${apiBase}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) throw new Error('Staging failed');
      const data = await response.json();

      if (data.status === 'success') {
        showToast('Opening in Chrome scout group…', 'success');
      } else {
        showToast('Staging failed', 'error');
      }
    } catch (err) {
      showToast('Staging browser failed', 'error');
      console.error(err);
    } finally {
      setIsStagingUrl(null);
    }
  };

  // "Tick" orchestration button triggering Curator -> Orchestrator -> Scout concurrent pipeline
  const handleTickPipeline = async () => {
    if (cards.length === 0) {
      showToast('Add at least one card to the board before starting curation!', 'warning');
      return;
    }

    setLoading(true);
    // Clear stale suggestions so the new run fills the panel in real time as
    // each scout's `done` candidates stream over SSE.
    setSuggestions([]);
    showToast('Curation Agent analyzing board clusters...', 'info');

    try {
      // 1. Curate Board
      const curateResponse = await fetch(`${apiBase}/curate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cards }),
      });
      if (!curateResponse.ok) throw new Error('Curator failed');
      const curateData = await curateResponse.json();

      setTasteProfile(curateData.taste_profile);
      setGaps(curateData.gaps);

      // Persist clusters, preserving any custom labels across re-curates.
      const incoming: ClusterType[] = (curateData.clusters || []).map((c: any) => {
        const existing = clusters.find((ec) => ec.id === c.id);
        return {
          id: c.id,
          label: c.label,
          custom_label: existing?.custom_label,
          card_ids: c.card_ids,
        };
      });
      setClusters(incoming);
      setCards((prev) => autoLayoutByCluster(incoming, prev));

      // 2. Orchestrate Dispatches
      showToast('Orchestrator matching gaps into scout briefs...', 'info');
      const orchestrateResponse = await fetch(`${apiBase}/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clusters: curateData.clusters,
          taste_profile: curateData.taste_profile,
          gaps: curateData.gaps,
        }),
      });
      if (!orchestrateResponse.ok) throw new Error('Orchestrator failed');
      const orchestrateData = await orchestrateResponse.json();

      // 3. Batch Scout Concurrent gather
      if (orchestrateData.scout_dispatches && orchestrateData.scout_dispatches.length > 0) {
        showToast('Scouts dispatched. Searching shopping & info channels...', 'info');
        
        // Map dispatches into ScoutRequests for batch scouting
        const scoutRequests = orchestrateData.scout_dispatches.map((dispatch: any) => {
          const matchedCluster = curateData.clusters.find((c: any) => c.id === dispatch.cluster_id);
          const memberIds: string[] = matchedCluster?.card_ids || [];
          const memberCards = cards
            .filter((c) => memberIds.includes(c.id))
            .map((c) => ({
              id: c.id,
              type: c.type,
              title: c.title,
              summary: c.summary,
              entities: c.entities,
              visual_features: c.visual_features,
              url: c.url,
            }));
          return {
            cluster_id: dispatch.cluster_id,
            cluster_label: matchedCluster ? matchedCluster.label : 'Style Cluster',
            search_hints: dispatch.search_hints,
            taste_profile: curateData.taste_profile,
            user_currency: USER_CURRENCY,
            cluster_cards: memberCards,
          };
        });

        const scoutResponse = await fetch(`${apiBase}/scout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scoutRequests),
        });
        if (!scoutResponse.ok) throw new Error('Scouts fanning out failed');
        const scoutCandidates: Candidate[] = await scoutResponse.json();

        // SSE has been streaming candidates with positions; merge the bulk
        // response as a safety net (dedupe by URL). Anything missed gets
        // placed against the cluster from the dispatch list — fall back to
        // the canvas origin if we can't tell.
        setSuggestions((prev) => {
          const seen = new Set(prev.map((s) => s.url));
          const merged = [...prev];
          for (const c of scoutCandidates) {
            if (seen.has(c.url)) continue;
            const pos = placeSuggestionInCluster(undefined);
            merged.push({
              url: c.url,
              title: c.title,
              match_reason: c.match_reason,
              price: c.price,
              image_url: c.image_url,
              emoji: (c as any).emoji,
              cluster_id: undefined,
              x: pos.x,
              y: pos.y,
            });
          }
          return merged;
        });
        showToast(`Scouts retrieved ${scoutCandidates.length} curated design matches!`, 'success');
      } else {
        showToast('Curator found no style gaps. Your board is perfect!', 'success');
      }
    } catch (err) {
      showToast('Multi-agent pipeline failed', 'error');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // --- Export / import board state as a portable JSON snapshot ---
  const BOARD_FILE_VERSION = 1;

  const handleExportBoard = () => {
    const snapshot = {
      version: BOARD_FILE_VERSION,
      exported_at: new Date().toISOString(),
      cards,
      clusters,
      taste_profile: tasteProfile,
      gaps,
      suggestions,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.download = `moodboard-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported ${cards.length} card${cards.length === 1 ? '' : 's'}`, 'success');
  };

  const importFileRef = React.useRef<HTMLInputElement>(null);

  const handleImportBoard = async (file: File) => {
    try {
      const text = await file.text();
      const snapshot = JSON.parse(text);
      if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.cards)) {
        throw new Error('Not a valid moodboard snapshot');
      }
      // Apply atomically. status field defaults to ready on import.
      const restoredCards: CardType[] = (snapshot.cards as CardType[]).map((c) => ({
        ...c,
        status: c.status && c.status !== 'ready' ? 'ready' : c.status,
      }));
      setCards(restoredCards);
      setClusters(Array.isArray(snapshot.clusters) ? snapshot.clusters : []);
      setTasteProfile(typeof snapshot.taste_profile === 'string' ? snapshot.taste_profile : '');
      setGaps(Array.isArray(snapshot.gaps) ? snapshot.gaps : []);
      setSuggestions(Array.isArray(snapshot.suggestions) ? snapshot.suggestions : []);
      // Reset viewport so the imported board lands in a known position.
      setCanvasOffset({ x: 0, y: 0 });
      setCanvasScale(1);
      showToast(`Imported ${restoredCards.length} card${restoredCards.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      console.error('import failed', err);
      showToast('Import failed — file is not a valid moodboard snapshot', 'error');
    }
  };

  // Reset local storage board state to default
  const handleResetBoard = () => {
    void clearBoardStorage().then(() => window.location.reload());
  };

  const handleClearScouts = () => {
    chrome.runtime.sendMessage({ type: 'clear_scout_group' });
    showToast('Scout tab group cleared', 'info');
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      
      {/* Setup banner when backend or extension link is down */}
      {backendStatus && (!backendStatus.ok || !backendStatus.extension_connected) && (
        <div className="fixed top-0 left-0 right-0 z-[10000] bg-[#A85E40] text-white px-4 py-2 text-[11px] flex items-center justify-between gap-4 pointer-events-auto">
          <span>
            {!backendStatus.ok
              ? 'Backend offline — run: cd backend && .venv/bin/uvicorn main:app --reload --port 8000'
              : 'Extension not linked to backend — reload extension or check service worker'}
            {backendStatus.model ? ` · Model: ${backendStatus.model}` : ''}
          </span>
          <button
            type="button"
            onClick={() => chrome.runtime.openOptionsPage()}
            className="shrink-0 flex items-center gap-1 underline"
          >
            <Settings className="w-3 h-3" /> Options
          </button>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none max-w-sm">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border shadow-md animate-fade-in pointer-events-auto bg-[#FAF4E4] ${
              toast.type === 'success'
                ? 'border-[#7A8B6E]/50 text-[#4A5A3E]'
                : toast.type === 'error'
                ? 'border-[#A85E40]/50 text-[#6E3F2A]'
                : toast.type === 'warning'
                ? 'border-[#C9974A]/50 text-[#7E5A24]'
                : 'border-[#D4C5AC] text-stone-700'
            }`}
          >
            {toast.type === 'success' && <CheckCircle className="w-4 h-4 text-[#7A8B6E] shrink-0" />}
            {toast.type === 'error' && <AlertTriangle className="w-4 h-4 text-[#A85E40] shrink-0" />}
            {toast.type === 'warning' && <AlertTriangle className="w-4 h-4 text-[#C9974A] shrink-0" />}
            {toast.type === 'info' && <Info className="w-4 h-4 text-stone-600 shrink-0" />}
            <span className="text-[11.5px] font-medium">{toast.message}</span>
          </div>
        ))}
      </div>

      {/* Full-bleed infinite canvas root */}
      <div className="w-screen h-screen relative paper-bg text-stone-800 overflow-hidden">

        {/* Canvas fills everything behind */}
        <div className="absolute inset-0 z-0">
          <Canvas
            cards={cards}
            clusters={clusters}
            scoutingClusters={scoutingClusters}
            suggestions={suggestions}
            onRemoveCard={handleRemoveCard}
            offset={canvasOffset}
            onPanChange={setCanvasOffset}
            scale={canvasScale}
            onScaleChange={setCanvasScale}
            onRenameCluster={handleRenameCluster}
            onMoveCluster={handleMoveCluster}
            onAddSuggestion={handleAddSuggestion}
            onDismissSuggestion={handleDismissSuggestion}
            onStageSuggestion={handleStageSuggestion}
            isStagingUrl={isStagingUrl}
          />
        </div>

        {/* Floating header (top-left) */}
        <header className="absolute top-4 left-4 z-30 flex items-center gap-3 panel-surface rounded-lg px-4 py-2.5 select-none pointer-events-auto">
          <div className="p-1.5 rounded-md bg-[#C77B5C]/15 border border-[#C77B5C]/40 text-[#C77B5C]">
            <Sparkles className="w-4 h-4" />
          </div>
          <div className="flex flex-col">
            <h1 className="text-xs font-bold tracking-widest text-stone-800 uppercase">
              Moodboard
            </h1>
            <p className="text-[10px] text-stone-500 font-medium">
              Local Ollama · extension scouts
            </p>
          </div>
        </header>

        {/* Floating actions (top-right) */}
        <div className="absolute top-4 right-4 z-30 flex items-center gap-2 pointer-events-auto">
          {/* Zoom controls */}
          <div className="flex items-center panel-surface rounded-md overflow-hidden">
            <button
              onClick={() => setCanvasScale((s) => Math.max(0.25, +(s - 0.1).toFixed(2)))}
              className="px-2 py-1.5 text-stone-600 hover:text-stone-800 hover:bg-[#EDE0C6] transition-colors"
              title="Zoom out (⌘-scroll)"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="px-2 text-[10px] font-mono text-stone-600 select-none min-w-[42px] text-center">
              {Math.round(canvasScale * 100)}%
            </span>
            <button
              onClick={() => setCanvasScale((s) => Math.min(2.5, +(s + 0.1).toFixed(2)))}
              className="px-2 py-1.5 text-stone-600 hover:text-stone-800 hover:bg-[#EDE0C6] transition-colors"
              title="Zoom in (⌘-scroll)"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => { setCanvasScale(1); setCanvasOffset({ x: 0, y: 0 }); }}
              className="px-2 py-1.5 text-stone-600 hover:text-stone-800 hover:bg-[#EDE0C6] transition-colors border-l border-[#D4C5AC]"
              title="Reset zoom & pan"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
          {/* Hidden file input for import */}
          <input
            ref={importFileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImportBoard(f);
              if (importFileRef.current) importFileRef.current.value = '';
            }}
          />
          <button
            onClick={() => importFileRef.current?.click()}
            className="px-2.5 py-1.5 rounded-md panel-surface text-stone-600 hover:text-stone-800 hover:bg-[#EDE0C6] transition-colors flex items-center"
            title="Import board from JSON"
          >
            <Upload className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleExportBoard}
            className="px-2.5 py-1.5 rounded-md panel-surface text-stone-600 hover:text-stone-800 hover:bg-[#EDE0C6] transition-colors flex items-center"
            title="Export board as JSON"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleClearScouts}
            className="px-3 py-1.5 rounded-md panel-surface text-[11px] font-semibold text-stone-600 hover:text-stone-800 hover:bg-[#EDE0C6] transition-colors flex items-center gap-1.5"
            title="Close scout tab group"
          >
            <X className="w-3.5 h-3.5" />
            <span>Clear scouts</span>
          </button>
          <button
            onClick={handleResetBoard}
            className="px-3 py-1.5 rounded-md panel-surface text-[11px] font-semibold text-stone-600 hover:text-stone-800 hover:bg-[#EDE0C6] transition-colors flex items-center gap-1.5"
            title="Reset board"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset</span>
          </button>
          <button
            onClick={handleTickPipeline}
            disabled={loading}
            className="px-4 py-1.5 rounded-md bg-[#C77B5C] hover:bg-[#B26A4E] text-[11px] font-bold text-white transition-colors disabled:opacity-60 flex items-center gap-1.5 shadow"
            title="Curate, orchestrate, scout"
          >
            {loading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Searching…</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" />
                <span>Find Inspiration</span>
              </>
            )}
          </button>
        </div>

        {/* Right sidebar drawer */}
        <aside
          className={`absolute top-20 bottom-4 right-4 w-[340px] z-20 transition-transform duration-300 ease-out ${
            sidebarOpen ? 'translate-x-0' : 'translate-x-[calc(100%+1rem)]'
          }`}
        >
          <Sidebar tasteProfile={tasteProfile} gaps={gaps} />
        </aside>
        <button
          onClick={() => setSidebarOpen((o) => !o)}
          className="absolute top-1/2 -translate-y-1/2 z-30 panel-surface px-1.5 py-3 rounded-l-md hover:bg-[#EDE0C6] transition-all"
          style={{ right: sidebarOpen ? '360px' : '16px' }}
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          {sidebarOpen ? <PanelRightClose className="w-4 h-4 text-stone-600" /> : <PanelRightOpen className="w-4 h-4 text-stone-600" />}
        </button>

        {/* Bottom activity log drawer */}
        <footer
          className={`absolute left-4 z-20 transition-all duration-300 ease-out h-[200px] ${
            logOpen ? 'bottom-4 opacity-100' : 'bottom-4 translate-y-[calc(100%+1rem)] opacity-0 pointer-events-none'
          }`}
          style={{ right: sidebarOpen ? '360px' : '16px' }}
        >
          <ActivityLog logs={logs} onClearLogs={() => setLogs([])} />
        </footer>
        <button
          onClick={() => setLogOpen((o) => !o)}
          className="absolute z-30 panel-surface px-3 py-1.5 rounded-t-md hover:bg-[#EDE0C6] transition-all flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone-600"
          style={{
            left: '16px',
            bottom: logOpen ? '208px' : '0',
          }}
          title={logOpen ? 'Hide activity log' : 'Show activity log'}
        >
          {logOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
          <span>Activity</span>
        </button>

        {/* Floating dropzone pill (bottom-center) */}
        <div
          className="absolute z-30 transition-all duration-300 ease-out pointer-events-auto"
          style={{
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: logOpen ? '224px' : '16px',
            width: 'min(640px, calc(100% - 4rem))',
          }}
        >
          <DropZone onIngestText={handleIngestText} onIngestFile={handleIngestFile} />
        </div>

      </div>
    </DndContext>
  );
}
