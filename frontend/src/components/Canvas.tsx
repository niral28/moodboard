import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from './Card';
import type { CardType } from './Card';
import { Sparkles, Pencil } from 'lucide-react';
import type { ClusterType } from '../App';

interface CanvasProps {
  cards: CardType[];
  clusters: ClusterType[];
  onRemoveCard: (id: string) => void;
  offset: { x: number; y: number };
  onPanChange: (offset: { x: number; y: number }) => void;
  scale: number;
  onScaleChange: (scale: number) => void;
  onRenameCluster: (id: string, newLabel: string) => void;
  onMoveCluster: (
    id: string,
    dx: number,
    dy: number,
    snapshot: { id: string; x: number; y: number }[],
  ) => void;
}

// Approximate card height for cluster bound calculation (varies with content).
const CARD_W = 260;
const CARD_H_ESTIMATE = 320;
const CLUSTER_LABEL_BAND = 40;

interface ClusterRegionProps {
  cluster: ClusterType;
  memberCards: CardType[];
  onRename: (newLabel: string) => void;
  onMove: (dx: number, dy: number, snapshot: { id: string; x: number; y: number }[]) => void;
  scale: number;
}

const ClusterRegion: React.FC<ClusterRegionProps> = ({ cluster, memberCards, onRename, onMove, scale }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cluster.custom_label || cluster.label);
  const dragRef = useRef<{
    px: number; py: number;
    snapshot: { id: string; x: number; y: number }[];
  } | null>(null);

  useEffect(() => {
    if (!editing) setDraft(cluster.custom_label || cluster.label);
  }, [cluster.custom_label, cluster.label, editing]);

  if (memberCards.length === 0) return null;

  // Bounding box of cluster's member cards (in canvas-local coords).
  const padding = 28;
  const minX = Math.min(...memberCards.map((c) => c.x)) - padding;
  const minY = Math.min(...memberCards.map((c) => c.y)) - padding - CLUSTER_LABEL_BAND;
  const maxX = Math.max(...memberCards.map((c) => c.x + CARD_W)) + padding;
  const maxY = Math.max(...memberCards.map((c) => c.y + CARD_H_ESTIMATE)) + padding;
  const w = maxX - minX;
  const h = maxY - minY;

  const labelText = cluster.custom_label || cluster.label;

  const startLabelDrag = (e: React.PointerEvent) => {
    if (editing) return;
    if ((e.target as HTMLElement).closest('button, input')) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      px: e.clientX,
      py: e.clientY,
      snapshot: memberCards.map((c) => ({ id: c.id, x: c.x, y: c.y })),
    };
  };

  const onLabelMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = (e.clientX - dragRef.current.px) / scale;
    const dy = (e.clientY - dragRef.current.py) / scale;
    onMove(dx, dy, dragRef.current.snapshot);
  };

  const endLabelDrag = () => {
    dragRef.current = null;
  };

  return (
    <div
      className="absolute"
      style={{ left: minX, top: minY, width: w, height: h, pointerEvents: 'none' }}
    >
      {/* Region box */}
      <div
        className="absolute inset-0 rounded-2xl border-2 border-dashed"
        style={{
          borderColor: 'rgba(199, 123, 92, 0.35)',
          backgroundColor: 'rgba(199, 123, 92, 0.05)',
        }}
      />
      {/* Label band */}
      <div
        className="absolute left-4 top-0 -translate-y-1/2 flex items-center gap-1 px-3 py-1 rounded-full shadow"
        style={{
          backgroundColor: '#C77B5C',
          color: 'white',
          pointerEvents: 'auto',
          cursor: editing ? 'text' : 'grab',
          userSelect: editing ? 'text' : 'none',
        }}
        onPointerDown={startLabelDrag}
        onPointerMove={onLabelMove}
        onPointerUp={endLabelDrag}
        onPointerCancel={endLabelDrag}
        onDoubleClick={() => setEditing(true)}
        title={editing ? '' : 'Drag to move cluster · double-click to rename'}
      >
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { onRename(draft); setEditing(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { onRename(draft); setEditing(false); }
              if (e.key === 'Escape') { setEditing(false); setDraft(cluster.custom_label || cluster.label); }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="bg-transparent border-0 outline-none text-[11px] font-bold uppercase tracking-wider text-white placeholder-white/60 min-w-[140px]"
            placeholder="Cluster name"
          />
        ) : (
          <>
            <span className="text-[11px] font-bold uppercase tracking-wider">{labelText}</span>
            <Pencil className="w-2.5 h-2.5 opacity-60" />
          </>
        )}
      </div>
    </div>
  );
};

export const Canvas: React.FC<CanvasProps> = ({
  cards,
  clusters,
  onRemoveCard,
  offset,
  onPanChange,
  scale,
  onScaleChange,
  onRenameCluster,
  onMoveCluster,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const panStart = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  // Wheel events for ⌘/ctrl-scroll zoom (and trackpad pinch on macOS).
  // Attached imperatively because React's onWheel is passive by default.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      // cursor position in canvas-local coords (before zoom)
      const localX = (cx - offset.x) / scale;
      const localY = (cy - offset.y) / scale;
      const delta = -e.deltaY * 0.0025;
      const newScale = Math.max(0.25, Math.min(2.5, +(scale * Math.exp(delta)).toFixed(3)));
      // adjust offset so the cursor's local point stays put on screen
      const newOffsetX = cx - localX * newScale;
      const newOffsetY = cy - localY * newScale;
      onScaleChange(newScale);
      onPanChange({ x: newOffsetX, y: newOffsetY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scale, offset.x, offset.y, onScaleChange, onPanChange]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.button !== 0 && e.button !== 1) return;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    panStart.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!panStart.current) return;
    onPanChange({
      x: panStart.current.ox + (e.clientX - panStart.current.px),
      y: panStart.current.oy + (e.clientY - panStart.current.py),
    });
  };

  const endPan = () => {
    panStart.current = null;
  };

  const isPanning = panStart.current !== null;

  // Pre-compute cluster → member cards mapping.
  const clusterMembers = useMemo(() => {
    return clusters.map((cluster) => ({
      cluster,
      members: cards.filter((c) => cluster.card_ids.includes(c.id)),
    }));
  }, [clusters, cards]);

  return (
    <div
      ref={rootRef}
      className={`w-full h-full relative overflow-hidden paper-bg ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      {/* Translated + scaled inner layer holds clusters and cards */}
      <div
        className="absolute top-0 left-0 pointer-events-none"
        style={{
          transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
          transformOrigin: '0 0',
          willChange: 'transform',
        }}
      >
        {/* Cluster regions (behind cards) */}
        {clusterMembers.map(({ cluster, members }) => (
          <ClusterRegion
            key={cluster.id}
            cluster={cluster}
            memberCards={members}
            onRename={(newLabel) => onRenameCluster(cluster.id, newLabel)}
            onMove={(dx, dy, snap) => onMoveCluster(cluster.id, dx, dy, snap)}
            scale={scale}
          />
        ))}

        {/* Cards on top */}
        {cards.map((card) => (
          <div key={card.id} className="pointer-events-auto">
            <Card card={card} onRemove={onRemoveCard} />
          </div>
        ))}
      </div>

      {/* Empty state stays viewport-centered (not transformed) */}
      {cards.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-stone-500 pointer-events-none gap-3">
          <div className="p-4 rounded-full bg-[#EDE0C6] border border-[#D4C5AC]">
            <Sparkles className="w-6 h-6 text-[#C77B5C]" />
          </div>
          <div className="text-center flex flex-col gap-1">
            <p className="text-sm font-semibold text-stone-700">Your moodboard canvas is empty</p>
            <p className="text-[11px] text-stone-500 max-w-[300px] leading-relaxed mx-auto">
              Paste a URL, type a note, drop an email, or drag in an image. Drag empty canvas to pan · ⌘-scroll to zoom.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
