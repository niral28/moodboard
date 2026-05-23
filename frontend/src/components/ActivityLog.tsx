import React, { useEffect, useRef } from 'react';
import { Terminal, Trash2 } from 'lucide-react';

export interface LogEntry {
  agent: 'ingest' | 'curate' | 'orchestrate' | 'scout' | 'stage';
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
  timestamp: string;
}

interface ActivityLogProps {
  logs: LogEntry[];
  onClearLogs: () => void;
}

export const ActivityLog: React.FC<ActivityLogProps> = ({ logs, onClearLogs }) => {
  const containerRef = useRef<HTMLDivElement>(null);

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
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      case 'curate':
        return 'bg-violet-500/10 text-violet-400 border-violet-500/20';
      case 'orchestrate':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      case 'scout':
        return 'bg-sky-500/10 text-sky-400 border-sky-500/20';
      case 'stage':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
      default:
        return 'bg-slate-500/10 text-slate-400 border-slate-500/20';
    }
  };

  const getLevelStyle = (level: string) => {
    switch (level) {
      case 'success':
        return 'text-emerald-400 font-bold';
      case 'warning':
        return 'text-yellow-400 font-semibold';
      case 'error':
        return 'text-rose-500 font-bold';
      case 'info':
      default:
        return 'text-slate-300';
    }
  };

  return (
    <div className="glass-panel border border-white/5 rounded-2xl p-4 h-full flex flex-col overflow-hidden select-none">
      
      {/* Log Console Header */}
      <div className="flex items-center justify-between pb-3 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </div>
          <Terminal className="w-4 h-4 text-slate-400" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">
            Multi-Agent Activity Telemetry
          </h2>
        </div>
        <button
          onClick={onClearLogs}
          className="text-slate-500 hover:text-rose-400 transition-colors p-1 rounded hover:bg-white/5"
          title="Clear logs"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Console Display logs */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto custom-scrollbar font-mono text-[10.5px] p-3 bg-slate-950/40 rounded-xl border border-white/5 mt-3 flex flex-col gap-1.5 leading-relaxed"
      >
        {logs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-600 italic select-none">
            [Awaiting agent signals... Connections established at http://localhost:8000/events]
          </div>
        ) : (
          logs.map((log, i) => (
            <div
              key={i}
              className="flex gap-2 items-start animate-fade-in py-0.5 border-b border-white/[0.01]"
            >
              {/* Timestamp */}
              <span className="text-slate-600 shrink-0 select-none">
                [{log.timestamp}]
              </span>

              {/* Agent Tag */}
              <span
                className={`text-[8.5px] font-bold uppercase px-1.5 py-0.5 rounded border tracking-wider shrink-0 select-none font-sans ${getAgentStyle(
                  log.agent
                )}`}
              >
                {getAgentLabel(log.agent)}
              </span>

              {/* Log Message */}
              <span className={`flex-1 break-all ${getLevelStyle(log.level)}`}>
                {log.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
