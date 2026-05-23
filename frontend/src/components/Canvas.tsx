import React, { useRef } from 'react';
import { Card } from './Card';
import type { CardType } from './Card';
import { Sparkles } from 'lucide-react';

interface CanvasProps {
  cards: CardType[];
  onRemoveCard: (id: string) => void;
  offset: { x: number; y: number };
  onPanChange: (offset: { x: number; y: number }) => void;
}

export const Canvas: React.FC<CanvasProps> = ({ cards, onRemoveCard, offset, onPanChange }) => {
  const panStart = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only pan when the user grabbed empty canvas, not a card.
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

  return (
    <div
      className={`w-full h-full relative overflow-hidden paper-bg ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      {/* Translated card layer */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`,
          willChange: 'transform',
        }}
      >
        {cards.map((card) => (
          <div key={card.id} className="pointer-events-auto">
            <Card card={card} onRemove={onRemoveCard} />
          </div>
        ))}
      </div>

      {/* Empty state stays viewport-centered (not translated) */}
      {cards.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-stone-500 pointer-events-none gap-3">
          <div className="p-4 rounded-full bg-[#EDE0C6] border border-[#D4C5AC]">
            <Sparkles className="w-6 h-6 text-[#C77B5C]" />
          </div>
          <div className="text-center flex flex-col gap-1">
            <p className="text-sm font-semibold text-stone-700">Your moodboard canvas is empty</p>
            <p className="text-[11px] text-stone-500 max-w-[280px] leading-relaxed mx-auto">
              Paste a URL, type a note, drop an email, or drag in an image. Drag empty canvas to pan.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
