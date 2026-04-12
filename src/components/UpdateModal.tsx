import { Download, X } from 'lucide-react';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import type { ReleaseInfo } from '../lib/updater';

type Props = {
  isOpen: boolean;
  currentVersion: string;
  release: ReleaseInfo | null;
  onClose: () => void;
};

export function UpdateModal({ isOpen, currentVersion, release, onClose }: Props) {
  if (!isOpen || !release) return null;

  const handleDownload = async () => {
    try {
      await openUrl(release.url);
      onClose();
    } catch (err) {
      console.error('Failed to open download URL:', err);
    }
  };

  return (
    <div 
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/40 backdrop-blur-[4px]"
      style={{ animation: 'update-fade-in 0.25s ease-out' }}
      onClick={onClose}
    >
      <style>{`
        @keyframes update-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes update-zoom-in {
          from { opacity: 0; transform: scale(0.9); translateY(10px); }
          to { opacity: 1; transform: scale(1); translateY(0); }
        }
      `}</style>
      <div 
        className="w-full max-w-[420px] bg-white rounded-3xl shadow-[0_32px_64px_rgba(0,0,0,0.25)] border border-[var(--border-subtle)] overflow-hidden"
        style={{ animation: 'update-zoom-in 0.3s cubic-bezier(0.16, 1, 0.3, 1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-8">
          <div className="flex justify-between items-start mb-6">
            <div>
              <h3 className="text-20px font-700 text-[var(--text-primary)] mb-1.5 tracking-tight">
                软件更新
              </h3>
              <p className="text-15px text-[var(--text-secondary)] font-500 opacity-70">
                发现新版本可用
              </p>
            </div>
            <button 
              onClick={onClose}
              className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400 transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          <div className="flex items-center gap-4 py-3 px-4 bg-gray-50/80 rounded-2xl mb-6 border border-gray-100/50">
            <span className="font-mono text-14px font-600 text-[var(--text-secondary)] opacity-60">
              {currentVersion}
            </span>
            <span className="text-gray-300">→</span>
            <span className="font-mono text-14px font-700 text-[var(--accent-soft-strong)]">
              {release.version}
            </span>
          </div>

          <div className="mb-6">
            <h4 className="text-13px font-700 text-[var(--text-secondary)] uppercase tracking-wider mb-3 opacity-60">
              更新内容
            </h4>
            <div className="max-h-[180px] overflow-y-auto pr-2 custom-scrollbar">
              <div className="prose prose-sm prose-slate max-w-none">
                {release.notes ? (
                  <div className="text-14px text-[var(--text-primary)] leading-relaxed space-y-1 opacity-90">
                    {release.notes.split('\n').map((line, i) => {
                      const trimmed = line.trim();
                      if (!trimmed) return <div key={i} className="h-2" />;
                      if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
                        return (
                          <div key={i} className="flex gap-2 items-start">
                            <span className="text-[var(--accent-soft-strong)] mt-1.5 w-1 h-1 rounded-full bg-current shrink-0" />
                            <span>{trimmed.slice(1).trim()}</span>
                          </div>
                        );
                      }
                      return <p key={i}>{trimmed}</p>;
                    })}
                  </div>
                ) : (
                  <p className="text-14px text-[var(--text-secondary)] italic">此版本暂无具体更新说明</p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="px-8 py-5 bg-gray-50/30 border-t border-gray-100 flex justify-end items-center gap-4">
          <button
            onClick={onClose}
            className="text-14px font-600 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleDownload}
            className="flex items-center gap-2 px-6 py-2.5 text-14px font-600 rounded-xl bg-[var(--accent-soft-strong)] text-white shadow-[0_4px_12px_-2px_rgba(79,123,116,0.3)] hover:brightness-110 active:scale-[0.97] transition-all"
          >
            <Download size={16} />
            立即下载
          </button>
        </div>
      </div>
    </div>
  );
}
