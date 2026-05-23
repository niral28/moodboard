import React from 'react';
import { Sparkles, ShoppingCart, Plus, X, Lightbulb, AlertCircle, ExternalLink, Loader2 } from 'lucide-react';

export interface Candidate {
  title: string;
  url: string;
  price?: string;
  image_url?: string;
  match_reason: string;
}

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
      
      {/* 1. Taste Profile & Gaps Panel */}
      <div className="glass-panel rounded-2xl p-4 flex flex-col gap-3.5 border border-white/5 max-h-[45%] overflow-y-auto custom-scrollbar">
        <div className="flex items-center gap-2 pb-2 border-b border-white/5">
          <Lightbulb className="w-4 h-4 text-amber-400" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">
            Style Curation
          </h2>
        </div>

        {/* Taste Profile Text */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[9px] uppercase font-semibold text-slate-500 tracking-wider">Taste Profile</span>
          {tasteProfile ? (
            <p className="text-[12px] text-slate-300 leading-relaxed font-sans italic bg-slate-950/30 p-3 rounded-xl border border-white/5">
              "{tasteProfile}"
            </p>
          ) : (
            <div className="text-[11px] text-slate-600 bg-slate-950/20 p-3 rounded-xl border border-white/5 border-dashed">
              No curation profile generated yet. Click the "Tick" button to analyze.
            </div>
          )}
        </div>

        {/* Gaps List */}
        {gaps && gaps.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[9px] uppercase font-semibold text-slate-500 tracking-wider">Identified Gaps</span>
            <div className="flex flex-col gap-1.5">
              {gaps.map((gap, i) => (
                <div
                  key={i}
                  className="flex gap-2 items-start p-2 rounded-lg bg-rose-500/5 border border-rose-500/10 text-[11px] text-rose-300 font-sans"
                >
                  <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                  <span className="leading-normal">{gap}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 2. Scout Suggestions Panel */}
      <div className="glass-panel rounded-2xl p-4 flex flex-col gap-3.5 border border-white/5 flex-1 overflow-hidden">
        <div className="flex items-center justify-between pb-2 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-400" />
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Scouted Suggestions
            </h2>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/20 font-semibold font-mono">
            {suggestions.length}
          </span>
        </div>

        {/* Suggestions Scrollable List */}
        <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-3 pr-0.5">
          {suggestions.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-600 gap-2 border border-dashed border-white/5 rounded-xl bg-slate-950/20">
              <Sparkles className="w-5 h-5 text-slate-700 animate-pulse" />
              <p className="text-[11px] max-w-[200px] leading-relaxed">
                No active suggestions. Drop items onto the board and trigger "Tick" to dispatch scouts!
              </p>
            </div>
          ) : (
            suggestions.map((item, index) => (
              <div
                key={index}
                className="group relative rounded-xl border border-white/5 bg-slate-900/30 p-3 hover:bg-slate-900/50 hover:border-indigo-500/20 hover:shadow-[0_0_15px_rgba(99,102,241,0.04)] transition-all duration-300 flex flex-col gap-2.5"
              >
                {/* Header: Title and Price */}
                <div className="flex justify-between items-start gap-2">
                  <div className="flex flex-col gap-0.5">
                    <h4 className="text-xs font-bold text-slate-200 group-hover:text-white transition-colors leading-tight">
                      {item.title}
                    </h4>
                    {item.price && (
                      <span className="text-[10px] text-slate-400 font-semibold font-mono">
                        {item.price}
                      </span>
                    )}
                  </div>
                  
                  {/* Action buttons overlay */}
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Stage button */}
                    <button
                      onClick={() => onStageSuggestion(item.url)}
                      disabled={isStagingUrl !== null}
                      className="p-1 rounded bg-slate-800/80 hover:bg-indigo-600 border border-white/5 text-slate-300 hover:text-white transition-all disabled:opacity-50 disabled:hover:bg-slate-800"
                      title="Stage Cart Page via Playwright"
                    >
                      {isStagingUrl === item.url ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <ShoppingCart className="w-3 h-3" />
                      )}
                    </button>
                    {/* Add to Board button */}
                    <button
                      onClick={() => onAddSuggestion(item)}
                      className="p-1 rounded bg-slate-800/80 hover:bg-emerald-600 border border-white/5 text-slate-300 hover:text-white transition-all"
                      title="Add to Canvas Moodboard"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                    {/* Dismiss button */}
                    <button
                      onClick={() => onDismissSuggestion(item.url)}
                      className="p-1 rounded bg-slate-800/80 hover:bg-rose-600 border border-white/5 text-slate-400 hover:text-white transition-all"
                      title="Dismiss suggestion"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* Match Reason Description */}
                <p className="text-[10.5px] text-slate-400 leading-relaxed font-sans">
                  {item.match_reason}
                </p>

                {/* Image Placeholder or representation */}
                {item.image_url && (
                  <div className="relative rounded-lg overflow-hidden border border-white/5 aspect-[21/9] bg-slate-950/30 flex items-center justify-center">
                    <img
                      src={item.image_url}
                      alt={item.title}
                      className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity pointer-events-none"
                    />
                  </div>
                )}

                {/* Small external link preview */}
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[9px] text-indigo-400 hover:text-indigo-300 self-start font-medium"
                >
                  <span>View Details</span>
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
