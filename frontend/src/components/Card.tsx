import React from 'react';
import { useDraggable } from '@dnd-kit/core';
import { Trash2, ExternalLink, Image as ImageIcon, Link as LinkIcon, FileText, Mail, GripHorizontal } from 'lucide-react';

export interface CardType {
  id: string;
  type: 'text' | 'link' | 'image' | 'email';
  title: string;
  summary: string;
  entities: string[];
  url?: string;
  visual_features?: string;
  // Email-specific fields
  sender?: string;
  subject?: string;
  date?: string;
  body_summary?: string;
  // Spatial
  x: number;
  y: number;
}

interface CardProps {
  card: CardType;
  onRemove: (id: string) => void;
}

export const Card: React.FC<CardProps> = ({ card, onRemove }) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
  });

  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${card.x}px`,
    top: `${card.y}px`,
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    zIndex: isDragging ? 50 : 10,
    opacity: isDragging ? 0.7 : 1,
    cursor: 'default',
    width: '280px',
  };

  // Color theme selectors based on agent/card type
  const getCardStyleClass = () => {
    switch (card.type) {
      case 'email':
        return 'border-violet-500/20 shadow-[0_0_15px_rgba(139,92,246,0.06)] hover:border-violet-500/40 bg-slate-900/80';
      case 'image':
        return 'border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.06)] hover:border-emerald-500/40 bg-slate-900/80';
      case 'link':
        return 'border-sky-500/20 shadow-[0_0_15px_rgba(14,165,233,0.06)] hover:border-sky-500/40 bg-slate-900/80';
      case 'text':
      default:
        return 'border-slate-800 shadow-[0_4px_20px_rgba(0,0,0,0.4)] hover:border-slate-700 bg-slate-900/70';
    }
  };

  const getCardIcon = () => {
    switch (card.type) {
      case 'email':
        return <Mail className="w-4 h-4 text-violet-400" />;
      case 'image':
        return <ImageIcon className="w-4 h-4 text-emerald-400" />;
      case 'link':
        return <LinkIcon className="w-4 h-4 text-sky-400" />;
      case 'text':
      default:
        return <FileText className="w-4 h-4 text-slate-400" />;
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`glass-panel rounded-xl overflow-hidden transition-all duration-200 border group select-none ${getCardStyleClass()}`}
    >
      {/* Card Header & Drag Handle */}
      <div 
        {...attributes} 
        {...listeners} 
        className="flex items-center justify-between px-3 py-2 bg-slate-950/40 border-b border-white/5 cursor-grab active:cursor-grabbing text-slate-400 group-hover:text-slate-300"
      >
        <div className="flex items-center gap-2">
          {getCardIcon()}
          <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 select-none">
            {card.type}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <GripHorizontal className="w-3.5 h-3.5 text-slate-600 group-hover:text-slate-400 transition-colors" />
        </div>
      </div>

      {/* Card Content */}
      <div className="p-4 flex flex-col gap-3">
        {/* Title & Delete button */}
        <div className="flex justify-between items-start gap-2">
          <h3 className="font-semibold text-slate-100 text-sm leading-snug tracking-tight">
            {card.title}
          </h3>
          <button
            onClick={() => onRemove(card.id)}
            className="text-slate-600 hover:text-rose-400 p-1 rounded-lg hover:bg-white/5 transition-all opacity-0 group-hover:opacity-100"
            title="Delete Card"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Email Fields Rendering */}
        {card.type === 'email' && (
          <div className="flex flex-col gap-2 p-2 rounded-lg bg-slate-950/30 border border-white/5 text-[11px] text-slate-300 font-mono">
            {card.sender && (
              <div className="truncate">
                <span className="text-slate-500 font-semibold">From: </span>
                {card.sender}
              </div>
            )}
            {card.date && (
              <div>
                <span className="text-slate-500 font-semibold">Date: </span>
                {card.date}
              </div>
            )}
            {card.body_summary && (
              <div className="text-slate-400 italic pt-1 border-t border-white/5 leading-relaxed font-sans">
                "{card.body_summary}"
              </div>
            )}
          </div>
        )}

        {/* Image Card rendering */}
        {card.type === 'image' && card.url && (
          <div className="relative rounded-lg overflow-hidden border border-white/5 bg-slate-950/20 aspect-video flex items-center justify-center">
            {card.url.startsWith('http') ? (
              <img
                src={card.url}
                alt={card.title}
                className="w-full h-full object-cover pointer-events-none"
              />
            ) : (
              <div className="p-4 text-[10px] text-slate-500 text-center font-mono">
                [Multimodal Uploaded Image]
              </div>
            )}
          </div>
        )}

        {/* Card Summary Description */}
        {card.summary && card.type !== 'email' && (
          <p className="text-[12px] text-slate-300 leading-relaxed font-normal">
            {card.summary}
          </p>
        )}

        {/* Visual Features Rendering */}
        {card.visual_features && (
          <div className="text-[10px] p-2 rounded-lg bg-slate-950/30 border border-emerald-500/10 text-emerald-300 leading-relaxed font-sans">
            <span className="font-semibold text-emerald-400 uppercase tracking-wider text-[8px] block mb-0.5">Visual Signature</span>
            {card.visual_features}
          </div>
        )}

        {/* Entities Tag list */}
        {card.entities && card.entities.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {card.entities.slice(0, 5).map((entity, i) => (
              <span
                key={i}
                className="px-1.5 py-0.5 text-[9px] rounded bg-white/5 border border-white/5 text-slate-400 font-medium"
              >
                {entity}
              </span>
            ))}
          </div>
        )}

        {/* Link anchor */}
        {card.url && card.type === 'link' && (
          <a
            href={card.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[10px] text-sky-400 hover:text-sky-300 font-medium mt-1 self-start transition-colors"
          >
            <span>Visit Reference</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </div>
  );
};
