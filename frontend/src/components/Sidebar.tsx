import React, { useState } from 'react';
import {
  Sparkles, ShoppingCart, Plus, X, Lightbulb, AlertCircle, ExternalLink, Loader2,
  ChevronDown, ChevronUp, Image as ImageIcon,
} from 'lucide-react';

export interface Candidate {
  title: string;
  url: string;
  price?: string;
  image_url?: string;
  match_reason: string;
}

function getDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

interface SuggestionCardProps {
  item: Candidate;
  isStaging: boolean;
  stagingLocked: boolean;
  onAdd: () => void;
  onDismiss: () => void;
  onStage: () => void;
}

const SuggestionCard: React.FC<SuggestionCardProps> = ({
  item, isStaging, stagingLocked, onAdd, onDismiss, onStage,
}) => {
  const [imgFailed, setImgFailed] = useState(false);
  const showCover = !!item.image_url && !imgFailed;
  const domain = getDomain(item.url);

  return (
    <div className="group relative rounded-xl border border-[#D4C5AC] bg-[#FAF4E4] overflow-hidden hover:border-[#C77B5C]/60 transition-colors flex flex-col">
      {/* Cover image only when we have one */}
      {showCover && (
        <div className="relative aspect-[4/3] overflow-hidden bg-[#F2E8D5]">
          <img
            src={item.image_url}
            alt=""
            className="w-full h-full object-cover pointer-events-none"
            onError={() => setImgFailed(true)}
          />
          {item.price && (
            <span className="absolute bottom-2 left-2 text-[11px] font-bold px-2 py-0.5 rounded-full bg-white/95 text-stone-800 shadow-sm">
              {item.price}
            </span>
          )}
          <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <ActionButton onClick={onStage} disabled={stagingLocked} title="Open in Chrome" hoverColor="#C77B5C">
              {isStaging ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShoppingCart className="w-3 h-3" />}
            </ActionButton>
            <ActionButton onClick={onAdd} title="Add to canvas" hoverColor="#7A8B6E">
              <Plus className="w-3 h-3" />
            </ActionButton>
            <ActionButton onClick={onDismiss} title="Dismiss" hoverColor="#A85E40">
              <X className="w-3 h-3" />
            </ActionButton>
          </div>
        </div>
      )}

      {/* Caption */}
      <div className="p-3 flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-xs font-bold text-stone-800 leading-tight flex-1">
            {item.title}
          </h4>
          {/* Compact action buttons when there's no cover image */}
          {!showCover && (
            <div className="flex items-center gap-1 shrink-0">
              <ActionButton onClick={onStage} disabled={stagingLocked} title="Open in Chrome" hoverColor="#C77B5C" surface>
                {isStaging ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShoppingCart className="w-3 h-3" />}
              </ActionButton>
              <ActionButton onClick={onAdd} title="Add to canvas" hoverColor="#7A8B6E" surface>
                <Plus className="w-3 h-3" />
              </ActionButton>
              <ActionButton onClick={onDismiss} title="Dismiss" hoverColor="#A85E40" surface>
                <X className="w-3 h-3" />
              </ActionButton>
            </div>
          )}
        </div>

        {/* metadata row */}
        <div className="flex items-center gap-2 text-[10px] text-stone-500">
          {item.price && !showCover && (
            <span className="text-[10.5px] font-bold text-stone-700 font-mono">{item.price}</span>
          )}
          {domain && <span className="truncate">{domain}</span>}
        </div>

        {/* Always-visible match reason */}
        <p className="text-[11px] text-stone-700 leading-relaxed">
          {item.match_reason}
        </p>

        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-0.5 text-[10px] text-[#C9974A] hover:text-[#A37E37] font-medium self-start mt-0.5"
        >
          <span>Open source</span>
          <ExternalLink className="w-2.5 h-2.5" />
        </a>
      </div>
    </div>
  );
};

interface ActionButtonProps {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  hoverColor: string;
  surface?: boolean;
  children: React.ReactNode;
}

const ActionButton: React.FC<ActionButtonProps> = ({ onClick, disabled, title, hoverColor, surface, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`p-1.5 rounded-full text-stone-700 transition-colors disabled:opacity-50 hover:text-white ${
      surface ? 'bg-[#EDE0C6] border border-[#D4C5AC]' : 'bg-white/95'
    }`}
    style={{
      // hover bg via inline (simpler than per-color Tailwind classes)
    }}
    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = hoverColor; }}
    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ''; }}
  >
    {children}
  </button>
);

interface SidebarProps {
  tasteProfile: string;
  gaps: string[];
  suggestions: Candidate[];
  onAddSuggestion: (candidate: Candidate) => void;
  onDismissSuggestion: (url: string) => void;
  onStageSuggestion: (url: string) => Promise<void>;
  isStagingUrl: string | null;
}

export const Sidebar: React.FC<SidebarProps> = ({
  tasteProfile,
  gaps,
  suggestions,
  onAddSuggestion,
  onDismissSuggestion,
  onStageSuggestion,
  isStagingUrl,
}) => {
  return (
    <div className="w-full h-full flex flex-col gap-4 overflow-hidden select-none">

      {/* Curation panel */}
      <div className="panel-surface rounded-xl p-4 flex flex-col gap-3 max-h-[45%] overflow-y-auto custom-scrollbar">
        <div className="flex items-center gap-2 pb-2 border-b border-[#D4C5AC]">
          <Lightbulb className="w-4 h-4 text-[#C9974A]" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-stone-700">
            Style Curation
          </h2>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[9px] uppercase font-semibold text-stone-500 tracking-wider">Taste profile</span>
          {tasteProfile ? (
            <p className="text-[12px] text-stone-700 leading-relaxed italic bg-[#FAF4E4] p-3 rounded-lg border border-[#D4C5AC]">
              "{tasteProfile}"
            </p>
          ) : (
            <div className="text-[11px] text-stone-500 bg-[#FAF4E4] p-3 rounded-lg border border-[#D4C5AC] border-dashed">
              No curation yet — hit "Tick pipeline" to analyze the board.
            </div>
          )}
        </div>

        {gaps && gaps.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[9px] uppercase font-semibold text-stone-500 tracking-wider">Identified gaps</span>
            <div className="flex flex-col gap-1.5">
              {gaps.map((gap, i) => (
                <div
                  key={i}
                  className="flex gap-2 items-start p-2 rounded-md bg-[#A85E40]/8 border border-[#A85E40]/25 text-[11px] text-[#6E3F2A]"
                >
                  <AlertCircle className="w-3.5 h-3.5 text-[#A85E40] shrink-0 mt-0.5" />
                  <span className="leading-normal">{gap}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Suggestions panel */}
      <div className="panel-surface rounded-xl p-4 flex flex-col gap-3 flex-1 overflow-hidden">
        <div className="flex items-center justify-between pb-2 border-b border-[#D4C5AC] shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#C77B5C]" />
            <h2 className="text-xs font-bold uppercase tracking-wider text-stone-700">
              Scouted suggestions
            </h2>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#C77B5C]/15 text-[#7E4D34] border border-[#C77B5C]/30 font-semibold font-mono">
            {suggestions.length}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-3 pr-0.5">
          {suggestions.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 text-stone-500 gap-2 border border-dashed border-[#D4C5AC] rounded-lg bg-[#FAF4E4]">
              <Sparkles className="w-5 h-5 text-stone-400" />
              <p className="text-[11px] max-w-[200px] leading-relaxed">
                No suggestions yet. Drop cards onto the board and hit "Tick pipeline" to dispatch scouts.
              </p>
            </div>
          ) : (
            suggestions.map((item, index) => (
              <SuggestionCard
                key={index}
                item={item}
                isStaging={isStagingUrl === item.url}
                stagingLocked={isStagingUrl !== null}
                onAdd={() => onAddSuggestion(item)}
                onDismiss={() => onDismissSuggestion(item.url)}
                onStage={() => onStageSuggestion(item.url)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
};
