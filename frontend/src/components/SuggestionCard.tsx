import React, { useState } from 'react';
import {
  Star, Plus, X, ShoppingCart, ExternalLink, ChevronDown, ChevronUp, Loader2, Sparkles,
} from 'lucide-react';

export interface SuggestionType {
  // Identity
  url: string;
  title: string;
  match_reason: string;
  // Optional
  price?: string;
  image_url?: string;
  emoji?: string;
  // Placement / association
  cluster_id?: string;
  x: number;
  y: number;
}

interface Props {
  suggestion: SuggestionType;
  onAdd: () => void;
  onDismiss: (reason: string | null) => void;
  onStage: () => void;
  isStaging: boolean;
  stagingLocked: boolean;
}

function getDomain(url?: string): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

export const SuggestionCard: React.FC<Props> = ({
  suggestion: s, onAdd, onDismiss, onStage, isStaging, stagingLocked,
}) => {
  const [imgFailed, setImgFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [dismissReason, setDismissReason] = useState('');

  const showCover = !!s.image_url && !imgFailed;
  const domain = getDomain(s.url);

  const openDismiss = () => { setDismissReason(''); setDismissOpen(true); };
  const closeDismiss = () => { setDismissOpen(false); setDismissReason(''); };
  const submitDismiss = () => { onDismiss(dismissReason.trim() || null); setDismissOpen(false); };

  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${s.x}px`,
    top: `${s.y}px`,
    width: '260px',
    zIndex: 8,
  };

  return (
    <div
      style={style}
      className="card-surface sticky-card rounded-xl overflow-hidden group"
    >
      {/* Dashed terracotta overlay — the visual "this is a suggestion" cue. */}
      <div className="pointer-events-none absolute inset-0 rounded-xl border-2 border-dashed" style={{ borderColor: 'rgba(199, 123, 92, 0.7)' }} />

      {/* Cover */}
      <div className="relative aspect-[4/3] overflow-hidden">
        {showCover ? (
          <img
            src={s.image_url}
            alt=""
            className="w-full h-full object-cover pointer-events-none"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #C77B5C 0%, #8B4A30 100%)' }}
          >
            {s.emoji ? (
              <span className="text-6xl leading-none select-none" style={{ filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.25))' }}>
                {s.emoji}
              </span>
            ) : (
              <Sparkles className="w-10 h-10 text-white/85" />
            )}
          </div>
        )}

        {/* Star + "Suggested" pill, top-left */}
        <span
          className="absolute top-2 left-2 flex items-center gap-1 text-[9.5px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-white/95 border"
          style={{ color: '#C77B5C', borderColor: 'rgba(199, 123, 92, 0.5)' }}
        >
          <Star className="w-2.5 h-2.5 fill-current" />
          <span>Suggested</span>
        </span>

        {/* Price badge */}
        {s.price && (
          <span className="absolute bottom-2 left-2 text-[11px] font-bold px-2 py-0.5 rounded-full bg-white/95 text-stone-800 shadow-sm">
            {s.price}
          </span>
        )}

        {/* Hover action overlay */}
        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onStage}
            disabled={stagingLocked}
            className="p-1.5 rounded-full bg-white/95 hover:bg-[#C77B5C] hover:text-white text-stone-700 transition-colors disabled:opacity-50"
            title="Open in Chrome"
          >
            {isStaging ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShoppingCart className="w-3 h-3" />}
          </button>
          <button
            onClick={onAdd}
            className="p-1.5 rounded-full bg-white/95 hover:bg-[#7A8B6E] hover:text-white text-stone-700 transition-colors"
            title="Add to canvas"
          >
            <Plus className="w-3 h-3" />
          </button>
          <button
            onClick={openDismiss}
            className="p-1.5 rounded-full bg-white/95 hover:bg-[#A85E40] hover:text-white text-stone-700 transition-colors"
            title="Dismiss with reason"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Caption */}
      <div className="p-3 flex flex-col gap-1.5">
        <h4 className="text-xs font-bold text-stone-800 leading-tight line-clamp-2">{s.title}</h4>
        {domain && <p className="text-[10px] text-stone-500 truncate">{domain}</p>}

        <div className="flex items-center justify-between mt-1">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-stone-500 hover:text-stone-800 font-medium"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            <span>{expanded ? 'Hide why' : 'Why this'}</span>
          </button>
          <a
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-0.5 text-[10px] text-[#C9974A] hover:text-[#A37E37] font-medium"
          >
            <span>Open</span>
            <ExternalLink className="w-2.5 h-2.5" />
          </a>
        </div>

        {expanded && (
          <p className="mt-1.5 pt-1.5 border-t border-[#D4C5AC] text-[11px] text-stone-700 leading-relaxed">
            {s.match_reason}
          </p>
        )}

        {dismissOpen && (
          <div className="mt-2 pt-2 border-t border-[#D4C5AC] flex flex-col gap-1.5 animate-fade-in">
            <label className="text-[10px] text-stone-600 font-semibold uppercase tracking-wider">
              Why doesn't this fit? <span className="text-stone-400 font-normal normal-case">(optional)</span>
            </label>
            <textarea
              autoFocus
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitDismiss(); }
                if (e.key === 'Escape') closeDismiss();
              }}
              placeholder='e.g. "too expensive, max $200" · agents will respect it'
              rows={2}
              className="w-full text-[11px] bg-[#F2E8D5] border border-[#D4C5AC] rounded-md p-2 text-stone-800 placeholder-stone-400 focus:outline-none focus:border-[#A85E40] focus:ring-1 focus:ring-[#A85E40]/40 resize-none"
            />
            <div className="flex items-center gap-1.5 justify-end">
              <button onClick={closeDismiss} className="px-2 py-1 text-[10px] font-semibold text-stone-600 hover:text-stone-800 rounded">
                Cancel
              </button>
              <button onClick={submitDismiss} className="px-2.5 py-1 text-[10px] font-semibold text-white bg-[#A85E40] hover:bg-[#8E4D33] rounded">
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
