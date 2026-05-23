import React from 'react';
import { Card, CardType } from './Card';
import { Sparkles } from 'lucide-react';

interface CanvasProps {
  cards: CardType[];
  onRemoveCard: (id: string) => void;
}

export const Canvas: React.FC<CanvasProps> = ({ cards, onRemoveCard }) => {
  return (
    <div className="w-full h-full relative overflow-hidden canvas-grid min-h-[500px] border border-white/5 rounded-2xl bg-slate-950/40 shadow-inner">
      {cards.length === 0 ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 pointer-events-none gap-3">
          <div className="p-4 rounded-full bg-white/5 border border-white/5 shadow-2xl animate-pulse">
            <Sparkles className="w-6 h-6 text-indigo-400" />
          </div>
          <div className="text-center flex flex-col gap-1">
            <p className="text-sm font-semibold text-slate-400">Your spatial moodboard is empty</p>
            <p className="text-[11px] text-slate-600 max-w-[280px] leading-relaxed mx-auto">
              Paste a URL, type notes, drop an email, or drag-and-drop a beautiful design snapshot into the box below.
            </p>
          </div>
        </div>
      ) : (
        cards.map((card) => (
          <Card key={card.id} card={card} onRemove={onRemoveCard} />
        ))
      )}
    </div>
  );
};
