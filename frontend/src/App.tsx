import React, { useState, useEffect } from 'react';
import { DndContext, DragEndEvent } from '@dnd-kit/core';
import { Canvas } from './components/Canvas';
import { DropZone } from './components/DropZone';
import { Sidebar, Candidate } from './components/Sidebar';
import { ActivityLog, LogEntry } from './components/ActivityLog';
import { CardType } from './components/Card';
import { Sparkles, Trash2, RotateCcw, AlertTriangle, CheckCircle, Info, Loader2 } from 'lucide-react';

const API_BASE = 'http://localhost:8000';

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

export default function App() {
  const [cards, setCards] = useState<CardType[]>([]);
  const [suggestions, setSuggestions] = useState<Candidate[]>([]);
  const [tasteProfile, setTasteProfile] = useState('');
  const [gaps, setGaps] = useState<string[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [isStagingUrl, setIsStagingUrl] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // 1. Load from LocalStorage or initialize with 4 premium demo cards
  useEffect(() => {
    const savedCards = localStorage.getItem('moodboard_cards');
    const savedSuggestions = localStorage.getItem('moodboard_suggestions');
    const savedTaste = localStorage.getItem('moodboard_taste');
    const savedGaps = localStorage.getItem('moodboard_gaps');

    if (savedCards) {
      setCards(JSON.parse(savedCards));
    } else {
      // Prepopulate with 4 beautiful demo cards (Kyoto theme)
      const demoCards: CardType[] = [
        {
          id: 'demo-1',
          type: 'link',
          title: 'Kyoto Arashiyama Bamboo Forest Guide',
          summary: 'A comprehensive travel guide to Arashiyama bamboo trails, highlighting crowd-free visiting hours.',
          entities: ['Kyoto', 'bamboo forest', 'scenic', 'trails'],
          url: 'https://example.com/kyoto-bamboo',
          x: 40,
          y: 40,
        },
        {
          id: 'demo-2',
          type: 'email',
          title: 'Partner Meeting & Kaiseki Reservation',
          summary: 'Kaiseki dinner reservation details confirmed by the operations partner in Kyoto.',
          entities: ['Gion', 'kaiseki', 'dining', 'meeting'],
          sender: 'kenji.sato@kyototours.co.jp',
          subject: 'Kaiseki Dining Reservation Confirmed - Gion Kyoto',
          date: 'May 23, 2026',
          body_summary: 'Dinner confirmed at Gion Karyo at 7:00 PM for 3 guests. Kaiseki traditional multi-course tasting menu.',
          x: 360,
          y: 60,
        },
        {
          id: 'demo-3',
          type: 'image',
          title: 'Arashiyama Scenic Snapshot',
          summary: 'Visual scenery concept showing misty emerald green stalks under natural ambient lighting.',
          entities: ['emerald green', 'misty lighting', 'scenic imagery'],
          visual_features: 'Deep emerald greens, vertical towering symmetry, high-key ambient shafts',
          url: 'https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?auto=format&fit=crop&w=400&q=80',
          x: 80,
          y: 280,
        },
        {
          id: 'demo-4',
          type: 'text',
          title: 'Idea: Traditional Machiya Stay',
          summary: 'Explore booking a fully renovated traditional Japanese townhouse (machiya) instead of standard hotels to enhance the cultural immersion.',
          entities: ['machiya', 'townhouse', 'cultural lodging', 'immersion'],
          x: 400,
          y: 340,
        },
      ];
      setCards(demoCards);
    }

    if (savedSuggestions) setSuggestions(JSON.parse(savedSuggestions));
    if (savedTaste) setTasteProfile(savedTaste);
    if (savedGaps) setGaps(JSON.parse(savedGaps));
  }, []);

  // 2. Save state to LocalStorage
  useEffect(() => {
    if (cards.length > 0) {
      localStorage.setItem('moodboard_cards', JSON.stringify(cards));
    } else {
      localStorage.removeItem('moodboard_cards');
    }
  }, [cards]);

  useEffect(() => {
    localStorage.setItem('moodboard_suggestions', JSON.stringify(suggestions));
  }, [suggestions]);

  useEffect(() => {
    localStorage.setItem('moodboard_taste', tasteProfile);
  }, [tasteProfile]);

  useEffect(() => {
    localStorage.setItem('moodboard_gaps', JSON.stringify(gaps));
  }, [gaps]);

  // 3. Connect to backend Server-Sent Events log stream
  useEffect(() => {
    const eventSource = new EventSource(`${API_BASE}/events`);

    eventSource.onmessage = (event) => {
      try {
        const logData = JSON.parse(event.data);
        setLogs((prevLogs) => {
          // Avoid duplicate entries based on identical content + timestamp
          const isDuplicate = prevLogs.some(
            (l) => l.message === logData.message && l.timestamp === logData.timestamp
          );
          if (isDuplicate) return prevLogs;
          return [...prevLogs, logData];
        });
      } catch (err) {
        console.error('Failed to parse SSE event:', err);
      }
    };

    eventSource.onerror = (err) => {
      console.warn('SSE EventSource lost connection. Retrying...');
    };

    return () => {
      eventSource.close();
    };
  }, []);

  // 4. Toast notifications helper
  const showToast = (message: string, type: Toast['type'] = 'info') => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // --- Handlers ---

  // Drag and drop updating card positions
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, delta } = event;
    if (!active) return;

    setCards((prevCards) =>
      prevCards.map((card) => {
        if (card.id === active.id) {
          return {
            ...card,
            x: Math.max(10, Math.min(card.x + delta.x, 800)),
            y: Math.max(10, Math.min(card.y + delta.y, 800)),
          };
        }
        return card;
      })
    );
  };

  // Paste / text ingesting
  const handleIngestText = async (text: string, forceEmail: boolean) => {
    try {
      const response = await fetch(`${API_BASE}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: text,
          hint: forceEmail ? 'email' : null,
        }),
      });

      if (!response.ok) throw new Error('Ingest failed');
      const card: CardType = await response.json();
      
      // Position card semi-randomly near the top-center to prevent overlap
      card.x = 100 + Math.random() * 200;
      card.y = 100 + Math.random() * 200;
      
      setCards((prev) => [...prev, card]);
      showToast(`Ingested new ${card.type} card: "${card.title}"`, 'success');
    } catch (err) {
      showToast('Failed to ingest content', 'error');
      console.error(err);
    }
  };

  // File uploading (Snapshot / .eml file)
  const handleIngestFile = async (file: File) => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      // If file ends with .eml, send an email hint
      if (file.name.endsWith('.eml')) {
        formData.append('hint', 'email');
      }

      const response = await fetch(`${API_BASE}/ingest`, {
        method: 'POST',
        body: formData, // Automatically handled as multipart/form-data
      });

      if (!response.ok) throw new Error('File ingest failed');
      const card: CardType = await response.json();
      
      card.x = 100 + Math.random() * 200;
      card.y = 100 + Math.random() * 200;
      
      setCards((prev) => [...prev, card]);
      showToast(`Multimodal uploaded ${card.type} card: "${card.title}"`, 'success');
    } catch (err) {
      showToast('Failed to upload and ingest file', 'error');
      console.error(err);
    }
  };

  // In-canvas removal
  const handleRemoveCard = (id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id));
    showToast('Card removed from canvas', 'info');
  };

  // Suggestions panel actions
  const handleAddSuggestion = (candidate: Candidate) => {
    // Map suggestion Candidate to CardType
    const newCard: CardType = {
      id: Math.random().toString(36).substr(2, 9),
      type: 'link', // Suggestions default to product/excursion link cards
      title: candidate.title,
      summary: candidate.match_reason,
      entities: ['scouted', 'suggestion'],
      url: candidate.url,
      x: 200 + Math.random() * 200,
      y: 200 + Math.random() * 200,
    };
    
    // Add to board and remove from suggestions
    setCards((prev) => [...prev, newCard]);
    setSuggestions((prev) => prev.filter((s) => s.url !== candidate.url));
    showToast(`Added suggestion: "${candidate.title}" to board`, 'success');
  };

  const handleDismissSuggestion = (url: string) => {
    setSuggestions((prev) => prev.filter((s) => s.url !== url));
    showToast('Suggestion dismissed', 'info');
  };

  // Stage cart URL page in real Chrome context
  const handleStageSuggestion = async (url: string) => {
    setIsStagingUrl(url);
    try {
      const response = await fetch(`${API_BASE}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) throw new Error('Staging failed');
      const data = await response.json();
      
      if (data.status === 'success') {
        showToast('Cart Staged! Browser window left open for purchase.', 'success');
      } else {
        showToast(`Staging failed: ${data.message}`, 'error');
      }
    } catch (err) {
      showToast('Staging browser failed', 'error');
      console.error(err);
    } finally {
      setIsStagingUrl(null);
    }
  };

  // "Tick" orchestration button triggering Curator -> Orchestrator -> Scout concurrent pipeline
  const handleTickPipeline = async () => {
    if (cards.length === 0) {
      showToast('Add at least one card to the board before starting curation!', 'warning');
      return;
    }

    setLoading(true);
    showToast('Curation Agent analyzing board clusters...', 'info');

    try {
      // 1. Curate Board
      const curateResponse = await fetch(`${API_BASE}/curate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cards }),
      });
      if (!curateResponse.ok) throw new Error('Curator failed');
      const curateData = await curateResponse.json();

      setTasteProfile(curateData.taste_profile);
      setGaps(curateData.gaps);

      // 2. Orchestrate Dispatches
      showToast('Orchestrator matching gaps into scout briefs...', 'info');
      const orchestrateResponse = await fetch(`${API_BASE}/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clusters: curateData.clusters,
          taste_profile: curateData.taste_profile,
          gaps: curateData.gaps,
        }),
      });
      if (!orchestrateResponse.ok) throw new Error('Orchestrator failed');
      const orchestrateData = await orchestrateResponse.json();

      // 3. Batch Scout Concurrent gather
      if (orchestrateData.scout_dispatches && orchestrateData.scout_dispatches.length > 0) {
        showToast('Scouts dispatched. Searching shopping & info channels...', 'info');
        
        // Map dispatches into ScoutRequests for batch scouting
        const scoutRequests = orchestrateData.scout_dispatches.map((dispatch: any) => {
          // Find cluster label
          const matchedCluster = curateData.clusters.find((c: any) => c.id === dispatch.cluster_id);
          return {
            cluster_id: dispatch.cluster_id,
            cluster_label: matchedCluster ? matchedCluster.label : 'Style Cluster',
            search_hints: dispatch.search_hints,
            taste_profile: curateData.taste_profile,
          };
        });

        const scoutResponse = await fetch(`${API_BASE}/scout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scoutRequests),
        });
        if (!scoutResponse.ok) throw new Error('Scouts fanning out failed');
        const scoutCandidates: Candidate[] = await scoutResponse.json();

        // Update suggestions
        setSuggestions(scoutCandidates);
        showToast(`Scouts retrieved ${scoutCandidates.length} curated design matches!`, 'success');
      } else {
        showToast('Curator found no style gaps. Your board is perfect!', 'success');
      }
    } catch (err) {
      showToast('Multi-agent pipeline failed', 'error');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Reset local storage board state to default
  const handleResetBoard = () => {
    localStorage.removeItem('moodboard_cards');
    localStorage.removeItem('moodboard_suggestions');
    localStorage.removeItem('moodboard_taste');
    localStorage.removeItem('moodboard_gaps');
    window.location.reload();
  };

  return (
    <DndContext onDragEnd={handleDragEnd}>
      
      {/* Toast Notification Container */}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none max-w-sm">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border shadow-2xl backdrop-blur-md animate-fade-in pointer-events-auto ${
              toast.type === 'success'
                ? 'bg-emerald-950/80 border-emerald-500/20 text-emerald-300'
                : toast.type === 'error'
                ? 'bg-rose-950/80 border-rose-500/20 text-rose-300'
                : toast.type === 'warning'
                ? 'bg-amber-950/80 border-amber-500/20 text-amber-300'
                : 'bg-indigo-950/80 border-indigo-500/20 text-indigo-300'
            }`}
          >
            {toast.type === 'success' && <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />}
            {toast.type === 'error' && <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />}
            {toast.type === 'warning' && <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />}
            {toast.type === 'info' && <Info className="w-4 h-4 text-indigo-400 shrink-0" />}
            <span className="text-[11.5px] font-sans font-medium">{toast.message}</span>
          </div>
        ))}
      </div>

      {/* Main Page Layout */}
      <div className="w-screen h-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden font-sans p-4 gap-4">
        
        {/* Header Navigation Section */}
        <header className="flex justify-between items-center bg-slate-900/40 border border-white/5 rounded-2xl px-5 py-3.5 glass-panel shrink-0 select-none">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 shadow-[0_0_15px_rgba(99,102,241,0.1)]">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="flex flex-col">
              <h1 id="moodboard-heading" className="text-sm font-bold tracking-tight text-white uppercase tracking-widest">
                Moodboard Spatial Canvas
              </h1>
              <p className="text-[10px] text-slate-500 font-medium">
                Multi-Agent Web scouting & cart staging engine
              </p>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleResetBoard}
              className="px-3 py-1.5 rounded-lg border border-white/5 text-[11px] font-semibold text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-all flex items-center gap-1.5"
              title="Reset board to demo cards"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
            <button
              onClick={handleTickPipeline}
              disabled={loading}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[11px] font-bold text-white shadow-lg hover:shadow-indigo-500/25 transition-all disabled:opacity-50 flex items-center gap-1.5"
              title="Trigger curate and dispatch scouts"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Curating...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Tick Pipeline</span>
                </>
              )}
            </button>
          </div>
        </header>

        {/* Dashboard workspace grid */}
        <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">
          
          {/* Main workspace section (Canvas & Dropzone) */}
          <div className="flex-1 flex flex-col gap-4 min-h-0">
            {/* The absolute canvas container */}
            <div className="flex-1 min-h-0">
              <Canvas cards={cards} onRemoveCard={handleRemoveCard} />
            </div>
            
            {/* The ingestion dropzone */}
            <div className="shrink-0">
              <DropZone onIngestText={handleIngestText} onIngestFile={handleIngestFile} />
            </div>
          </div>

          {/* Right sidebar pane */}
          <div className="w-[320px] shrink-0 min-h-0 flex flex-col">
            <Sidebar
              tasteProfile={tasteProfile}
              gaps={gaps}
              suggestions={suggestions}
              onAddSuggestion={handleAddSuggestion}
              onDismissSuggestion={handleDismissSuggestion}
              onStageSuggestion={handleStageSuggestion}
              isStagingUrl={isStagingUrl}
            />
          </div>
        </div>

        {/* Live streaming activities bar */}
        <footer className="h-[160px] shrink-0">
          <ActivityLog logs={logs} onClearLogs={() => setLogs([])} />
        </footer>

      </div>
    </DndContext>
  );
}
