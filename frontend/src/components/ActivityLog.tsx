import React, { useEffect, useRef, useState } from 'react';
import { Terminal, Trash2, ChevronRight } from 'lucide-react';

export interface LogEntry {
  agent: 'ingest' | 'curate' | 'orchestrate' | 'scout' | 'stage';
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
  timestamp: string;
  details?: string;
}

interface ActivityLogProps {
  logs: LogEntry[];
  onClearLogs: () => void;
}

export const ActivityLog: React.FC<ActivityLogProps> = ({ logs, onClearLogs }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  // Auto scroll to bottom of logs
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs]);

  const getAgentLabel = (agent: string) => {
    switch (agent) {
      case 'ingest':
        return 'Ingestor';
      case 'curate':
        return 'Curator';
      case 'orchestrate':
        return 'Orchestrator';
      case 'scout':
        return 'Scout';
      case 'stage':
        return 'Stager';
      default:
        return agent;
    }
  };

  const getAgentStyle = (agent: string) => {
    switch (agent) {
      case 'ingest':
        return 'bg-[#7A8B6E]/10 text-[#4A5A3E] border-[#7A8B6E]/40';
      case 'curate':
        return 'bg-[#C77B5C]/10 text-[#7E4D34] border-[#C77B5C]/40';
      case 'orchestrate':
        return 'bg-[#C9974A]/10 text-[#7E5A24] border-[#C9974A]/40';
      case 'scout':
        return 'bg-[#5E4A35]/10 text-[#3D2F23] border-[#5E4A35]/40';
      case 'stage':
        return 'bg-[#A85E40]/10 text-[#6E3F2A] border-[#A85E40]/40';
      default:
        return 'bg-stone-200 text-stone-600 border-stone-300';
    }
  };

  const getLevelStyle = (level: string) => {
    switch (level) {
      case 'success':
        return 'text-[#4A5A3E] font-semibold';
      case 'warning':
        return 'text-[#9C7522] font-semibold';
      case 'error':
        return 'text-[#A85E40] font-semibold';
      case 'info':
      default:
        return 'text-stone-700';
    }
  };

  return (
    <div className="panel-surface rounded-xl p-4 h-full flex flex-col overflow-hidden select-none">

      <div className="flex items-center justify-between pb-3 border-b border-[#D4C5AC] shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#7A8B6E] opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[#7A8B6E]"></span>
          </div>
          <Terminal className="w-4 h-4 text-stone-600" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-stone-700">
            Multi-Agent Activity
          </h2>
        </div>
        <button
          onClick={onClearLogs}
          className="text-stone-500 hover:text-[#A85E40] transition-colors p-1 rounded hover:bg-[#A85E40]/10"
          title="Clear logs"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto custom-scrollbar font-mono text-[10.5px] p-3 bg-[#FAF4E4] rounded-lg border border-[#D4C5AC] mt-3 flex flex-col gap-1 leading-relaxed"
      >
        {logs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-stone-500 italic select-none">
            Awaiting agent signals…
          </div>
        ) : (
          logs.map((log, i) => {
            const hasDetails = !!log.details;
            const isOpen = expanded.has(i);
            return (
              <div
                key={i}
                className="flex flex-col animate-fade-in py-0.5"
              >
                <div
                  className={`flex gap-2 items-start ${hasDetails ? 'cursor-pointer hover:bg-[#EDE0C6]/60 rounded' : ''}`}
                  onClick={hasDetails ? () => toggle(i) : undefined}
                >
                  <span className="shrink-0 w-3 text-stone-500 select-none">
                    {hasDetails ? (
                      <ChevronRight
                        className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      />
                    ) : null}
                  </span>
                  <span className="text-stone-500 shrink-0 select-none">
                    [{log.timestamp}]
                  </span>
                  <span
                    className={`text-[8.5px] font-bold uppercase px-1.5 py-0.5 rounded border tracking-wider shrink-0 select-none font-sans ${getAgentStyle(
                      log.agent
                    )}`}
                  >
                    {getAgentLabel(log.agent)}
                  </span>
                  <span className={`flex-1 break-words ${getLevelStyle(log.level)}`}>
                    {log.message}
                  </span>
                </div>
                {hasDetails && isOpen && (
                  <pre className="ml-7 mt-1 mb-2 p-2 rounded bg-[#EDE0C6] border border-[#D4C5AC] text-[10px] text-stone-700 whitespace-pre-wrap break-words leading-relaxed select-text">
                    {log.details}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
