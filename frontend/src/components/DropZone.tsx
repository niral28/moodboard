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
      className={`panel-surface rounded-xl p-4 transition-colors duration-200 ${
        isDragging ? 'border-[#C77B5C] bg-[#C77B5C]/8' : ''
      }`}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="relative flex items-center bg-[#FAF4E4] border border-[#D4C5AC] rounded-lg px-3 py-2.5 focus-within:border-[#C77B5C] focus-within:ring-1 focus-within:ring-[#C77B5C]/40 transition-all">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={loading}
            placeholder="Paste URL, notes, or email content…"
            className="flex-1 bg-transparent border-0 outline-none text-stone-800 text-xs placeholder-stone-400 disabled:opacity-50"
            id="ingest-input"
          />

          <div className="flex items-center gap-1.5 pl-2 border-l border-[#D4C5AC]">
            <button
              type="button"
              onClick={() => setIsEmail(!isEmail)}
              className={`p-1.5 rounded border transition-colors ${
                isEmail
                  ? 'bg-[#A85E40]/10 border-[#A85E40]/40 text-[#A85E40]'
                  : 'bg-transparent border-transparent text-stone-500 hover:text-stone-700'
              }`}
              title="Force-parse as email"
            >
              <Mail className="w-3.5 h-3.5" />
            </button>

            <button
              type="submit"
              disabled={!inputValue.trim() || loading}
              className="p-1.5 rounded bg-[#C77B5C] hover:bg-[#B26A4E] text-white disabled:bg-[#E5D8C0] disabled:text-stone-500 transition-colors flex items-center justify-center"
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ArrowRight className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between text-[11px] text-stone-600 px-1 select-none">
          <div className="flex items-center gap-2">
            <LinkIcon className="w-3.5 h-3.5 text-stone-500" />
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
              className="text-[#C77B5C] hover:text-[#B26A4E] font-semibold flex items-center gap-1 transition-colors"
            >
              <Upload className="w-3 h-3" />
              <span>Upload image</span>
            </button>
            <span className="text-stone-400">|</span>
            <span className="text-stone-500">or drag in</span>
          </div>
        </div>
      </form>
    </div>
  );
};
