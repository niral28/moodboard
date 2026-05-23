import React, { useState, useRef } from 'react';
import { Upload, Link as LinkIcon, FileText, Mail, ArrowRight, Loader2 } from 'lucide-react';

interface DropZoneProps {
  onIngestText: (text: string, isEmail: boolean) => Promise<void>;
  onIngestFile: (file: File) => Promise<void>;
}

export const DropZone: React.FC<DropZoneProps> = ({ onIngestText, onIngestFile }) => {
  const [inputValue, setInputValue] = useState('');
  const [isEmail, setIsEmail] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || loading) return;

    setLoading(true);
    try {
      await onIngestText(inputValue, isEmail);
      setInputValue('');
      setIsEmail(false);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = e.dataTransfer.files;
    if (files.length > 0 && !loading) {
      setLoading(true);
      try {
        await onIngestFile(files[0]);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0 && !loading) {
      setLoading(true);
      try {
        await onIngestFile(files[0]);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    }
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`glass-panel rounded-2xl p-4 transition-all duration-300 border ${
        isDragging
          ? 'border-indigo-500 bg-indigo-500/10 scale-[1.01] shadow-[0_0_20px_rgba(99,102,241,0.2)]'
          : 'border-white/5 hover:border-white/10'
      }`}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {/* Paste Box Container */}
        <div className="relative flex items-center bg-slate-950/60 border border-white/5 rounded-xl px-3 py-2.5 focus-within:border-indigo-500/50 focus-within:ring-1 focus-within:ring-indigo-500/50 transition-all">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={loading}
            placeholder="Paste URL, raw text notes, or email content..."
            className="flex-1 bg-transparent border-0 outline-none text-slate-100 text-xs placeholder-slate-500 disabled:opacity-50"
            id="ingest-input"
          />
          
          {/* Action buttons inside text bar */}
          <div className="flex items-center gap-1.5 pl-2 border-l border-white/5">
            {/* Email parsing toggler */}
            <button
              type="button"
              onClick={() => setIsEmail(!isEmail)}
              className={`p-1.5 rounded-lg border transition-all ${
                isEmail
                  ? 'bg-violet-500/10 border-violet-500/40 text-violet-400'
                  : 'bg-transparent border-transparent text-slate-500 hover:text-slate-300'
              }`}
              title="Force parse as Email card"
            >
              <Mail className="w-3.5 h-3.5" />
            </button>

            {/* Ingest submit */}
            <button
              type="submit"
              disabled={!inputValue.trim() || loading}
              className="p-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-slate-800 disabled:text-slate-600 transition-all flex items-center justify-center"
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ArrowRight className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Bottom Upload Dropzone Info Bar */}
        <div className="flex items-center justify-between text-[11px] text-slate-400 px-1 select-none">
          <div className="flex items-center gap-2">
            <LinkIcon className="w-3.5 h-3.5 text-slate-500" />
            <span>Accepts text, URLs, images, or .eml</span>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              className="hidden"
              accept="image/*,.eml"
            />
            <button
              type="button"
              onClick={triggerFileSelect}
              className="text-indigo-400 hover:text-indigo-300 font-semibold flex items-center gap-1 transition-colors"
            >
              <Upload className="w-3 h-3" />
              <span>Upload snapshot</span>
            </button>
            <span className="text-slate-600">|</span>
            <span className="text-slate-500">Drag files here</span>
          </div>
        </div>
      </form>
    </div>
  );
};
