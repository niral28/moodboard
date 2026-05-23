import React, { useEffect, useState } from 'react';
import { Lightbulb, AlertCircle, Sparkles } from 'lucide-react';

// Re-exported for App.tsx — Candidate is still the network shape from /scout.
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
}

export const Sidebar: React.FC<SidebarProps> = ({ tasteProfile, gaps }) => {
  // Flash a subtle highlight whenever the taste profile changes — gives the
  // user a visual cue that their feedback rippled into the system.
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!tasteProfile) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1400);
    return () => clearTimeout(t);
  }, [tasteProfile]);

  return (
    <div className="w-full h-full flex flex-col gap-4 overflow-hidden select-none">
      <div className="panel-surface rounded-xl p-4 flex flex-col gap-3 flex-1 overflow-y-auto custom-scrollbar">
        <div className="flex items-center gap-2 pb-2 border-b border-[#D4C5AC]">
          <Sparkles className="w-4 h-4 text-[#C77B5C]" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-stone-700">
            User preferences
          </h2>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[9px] uppercase font-semibold text-stone-500 tracking-wider">Taste profile</span>
          {tasteProfile ? (
            <p
              className={`text-[12px] text-stone-700 leading-relaxed italic bg-[#FAF4E4] p-3 rounded-lg border transition-all duration-700 ${
                flash ? 'border-[#7A8B6E] shadow-[0_0_18px_rgba(122,139,110,0.35)]' : 'border-[#D4C5AC]'
              }`}
            >
              "{tasteProfile}"
            </p>
          ) : (
            <div className="text-[11px] text-stone-500 bg-[#FAF4E4] p-3 rounded-lg border border-[#D4C5AC] border-dashed">
              No profile yet — hit "Tick pipeline" to analyze the board.
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

        <div className="mt-auto pt-3 border-t border-[#D4C5AC] flex items-center gap-2 text-[10px] text-stone-500">
          <Lightbulb className="w-3 h-3 text-[#C9974A]" />
          <span>Dismiss a suggestion with a reason and the agents update this profile.</span>
        </div>
      </div>
    </div>
  );
};
