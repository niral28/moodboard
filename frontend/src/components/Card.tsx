import React, { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import {
  Trash2, ChevronDown, ChevronUp, ExternalLink,
  Image as ImageIcon, Link as LinkIcon, FileText, Mail,
} from 'lucide-react';

export interface CardType {
  id: string;
  type: 'text' | 'link' | 'image' | 'email';
  title: string;
  summary: string;
  entities: string[];
  url?: string;
  cover_image?: string;
  visual_features?: string;
  sender?: string;
  subject?: string;
  date?: string;
  body_summary?: string;
  x: number;
  y: number;
}

interface CardProps {
  card: CardType;
  onRemove: (id: string) => void;
}

// Type-specific accent + gradient fallback (for cards without a cover image).
const TYPE_THEME: Record<CardType['type'], { accent: string; gradient: string; label: string }> = {
  image: { accent: '#7A8B6E', gradient: 'linear-gradient(135deg, #7A8B6E 0%, #4A5A3E 100%)', label: 'image' },
  link:  { accent: '#C9974A', gradient: 'linear-gradient(135deg, #C9974A 0%, #8B6824 100%)', label: 'link' },
  email: { accent: '#A85E40', gradient: 'linear-gradient(135deg, #C77B5C 0%, #6E3F2A 100%)', label: 'email' },
  text:  { accent: '#6B5C4D', gradient: 'linear-gradient(135deg, #8B7D6A 0%, #3D2F23 100%)', label: 'note' },
};

function getDomain(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export const Card: React.FC<CardProps> = ({ card, onRemove }) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.id });
  const [expanded, setExpanded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  const theme = TYPE_THEME[card.type];

  // Resolve the displayable cover: explicit cover_image, or fall back to url
  // for image-type cards (legacy demo cards stored the image directly in url).
  const cover = card.cover_image || (card.type === 'image' ? card.url : null);
  const showCover = cover && !imgFailed;

  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${card.x}px`,
    top: `${card.y}px`,
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    zIndex: isDragging ? 50 : 10,
    width: '260px',
  };

  const TypeIcon = card.type === 'email' ? Mail
    : card.type === 'image' ? ImageIcon
    : card.type === 'link' ? LinkIcon
    : FileText;

  const subtitle =
    card.type === 'email' ? (card.sender || card.date || null)
    : card.type === 'link' ? getDomain(card.url)
    : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card-surface sticky-card rounded-xl overflow-hidden group ${isDragging ? 'is-dragging' : ''}`}
      {...attributes}
      {...listeners}
    >
      {/* Cover (also the drag-handle surface) */}
      <div className="relative aspect-[4/3] overflow-hidden">
        {showCover ? (
          <img
            src={cover!}
            alt=""
            className="w-full h-full object-cover pointer-events-none"
            onError={() => {
              console.warn('Card cover failed', { id: card.id, urlStart: (cover || '').slice(0, 60) });
              setImgFailed(true);
            }}
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{ background: theme.gradient }}
          >
            <TypeIcon className="w-10 h-10 text-white/90" />
          </div>
        )}

        {/* Type chip top-left */}
        <span
          className="absolute top-2 left-2 text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-white/90 backdrop-blur-sm border"
          style={{ color: theme.accent, borderColor: theme.accent + '60' }}
        >
          {theme.label}
        </span>

        {/* Delete on hover (top-right) */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onRemove(card.id); }}
          className="absolute top-2 right-2 p-1 rounded-full bg-white/90 hover:bg-[#A85E40] hover:text-white text-stone-700 opacity-0 group-hover:opacity-100 transition-all"
          title="Delete card"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {/* Caption */}
      <div className="p-3 flex flex-col gap-1.5">
        <h3 className="font-semibold text-stone-800 text-sm leading-snug line-clamp-2">
          {card.title}
        </h3>
        {subtitle && (
          <p className="text-[10.5px] text-stone-500 truncate">{subtitle}</p>
        )}

        <div className="flex items-center justify-between mt-1">
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            className="flex items-center gap-1 text-[10px] text-stone-500 hover:text-stone-800 font-medium"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            <span>{expanded ? 'Hide details' : 'Details'}</span>
          </button>
          {card.url && card.type === 'link' && (
            <a
              href={card.url}
              target="_blank"
              rel="noopener noreferrer"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-0.5 text-[10px] font-medium hover:underline"
              style={{ color: theme.accent }}
            >
              <span>Open</span>
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
        </div>

        {expanded && (
          <div className="mt-2 pt-2 border-t border-[#D4C5AC] flex flex-col gap-2">
            {/* Email-specific fields */}
            {card.type === 'email' && (
              <div className="text-[11px] text-stone-700 leading-snug flex flex-col gap-0.5">
                {card.subject && <div><span className="text-stone-500">Subject: </span>{card.subject}</div>}
                {card.sender && <div className="truncate"><span className="text-stone-500">From: </span>{card.sender}</div>}
                {card.date && <div><span className="text-stone-500">Date: </span>{card.date}</div>}
                {card.body_summary && (
                  <div className="italic text-stone-600 mt-1">"{card.body_summary}"</div>
                )}
              </div>
            )}

            {/* Summary */}
            {card.summary && (
              <p className="text-[11.5px] text-stone-700 leading-relaxed">{card.summary}</p>
            )}

            {/* Visual signature */}
            {card.visual_features && (
              <div className="text-[10.5px] p-2 rounded bg-[#7A8B6E]/10 border border-[#7A8B6E]/30 text-[#4A5A3E] leading-relaxed">
                <span className="font-semibold uppercase tracking-wider text-[8px] block mb-0.5 text-[#5A6A4E]">
                  Visual signature
                </span>
                {card.visual_features}
              </div>
            )}

            {/* Entities */}
            {card.entities && card.entities.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {card.entities.slice(0, 8).map((entity, i) => (
                  <span
                    key={i}
                    className="px-1.5 py-0.5 text-[9.5px] rounded bg-[#EDE0C6] border border-[#D4C5AC] text-stone-600 font-medium"
                  >
                    {entity}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
