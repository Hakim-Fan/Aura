import { useEffect, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { installReleaseUpdate, type ReleaseInfo, type UpdateInstallProgress } from '../lib/updater';

type Props = {
  isOpen: boolean;
  currentVersion: string;
  release: ReleaseInfo | null;
  onClose: () => void;
};

export function UpdateModal({ isOpen, currentVersion, release, onClose }: Props) {
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateInstallProgress | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setInstalling(false);
      setProgress(null);
      setError('');
    }
  }, [isOpen, release?.version]);

  if (!isOpen || !release) return null;

  const handleDownload = async () => {
    if (installing) return;
    setInstalling(true);
    setError('');
    setProgress(null);
    try {
      const result = await installReleaseUpdate(release, setProgress);
      if (result === 'opened-download-page') {
        onClose();
      }
    } catch (err) {
      console.error('Failed to install update:', err);
      setError(err instanceof Error ? err.message : '更新安装失败。');
      setInstalling(false);
    }
  };

  const progressLabel =
    progress?.phase === 'relaunching'
      ? '正在重启应用…'
      : progress?.phase === 'installing'
        ? '正在安装更新…'
        : progress?.percent != null
          ? `正在下载 ${progress.percent}%`
          : installing
            ? '正在准备下载…'
            : '';

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/40 backdrop-blur-[4px]"
      style={{ animation: 'update-fade-in 0.25s ease-out' }}
      onClick={installing ? undefined : onClose}
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
        <div className="p-7 pb-5">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h3 className="text-20px font-700 text-[var(--text-primary)] mb-1.5 tracking-tight">
                软件更新
              </h3>
              <p className="text-15px text-[var(--text-secondary)] font-500 opacity-70">
                发现新版本可用
              </p>
            </div>
            <button
              onClick={installing ? undefined : onClose}
              className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400 transition-colors"
              disabled={installing}
            >
              <X size={20} />
            </button>
          </div>

          {installing ? (
            <div className="mb-4 rounded-2xl border border-[rgba(79,123,116,0.14)] bg-[rgba(79,123,116,0.06)] px-4 py-3">
              <div className="mb-2 flex items-center justify-between gap-3 text-12px font-700 text-[var(--accent-soft-strong)]">
                <span>{progressLabel}</span>
                {progress?.percent != null ? <span>{progress.percent}%</span> : null}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/80">
                <div
                  className="h-full rounded-full bg-[var(--accent-soft-strong)] transition-all"
                  style={{ width: `${progress?.percent ?? 8}%` }}
                />
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="mb-4 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-13px text-red-600">
              {error}
            </div>
          ) : null}

          <div className="flex items-center gap-4 py-2.5 px-4 bg-gray-50/80 rounded-2xl mb-4 border border-gray-100/50">
            <span className="font-mono text-14px font-600 text-[var(--text-secondary)] opacity-60">
              {currentVersion}
            </span>
            <span className="text-gray-300">→</span>
            <span className="font-mono text-14px font-700 text-[var(--accent-soft-strong)]">
              {release.version}
            </span>
          </div>

          <div>
            <h4 className="text-13px font-700 text-[var(--text-secondary)] uppercase tracking-wider mb-2 opacity-60">
              更新内容
            </h4>
            <div className="max-h-[min(220px,28vh)] overflow-y-auto pr-2 custom-scrollbar">
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

        <div className="px-7 py-4 bg-gray-50/30 border-t border-gray-100 flex justify-end items-center gap-4">
          <button
            onClick={onClose}
            disabled={installing}
            className="text-14px font-600 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleDownload}
            disabled={installing}
            className="flex items-center gap-2 px-6 py-2.5 text-14px font-600 rounded-xl bg-[var(--accent-soft-strong)] text-white shadow-[0_4px_12px_-2px_rgba(79,123,116,0.3)] hover:brightness-110 active:scale-[0.97] transition-all disabled:opacity-70 disabled:active:scale-100"
          >
            {installing ? <Loader2 size={16} className="spin-icon" /> : <Download size={16} />}
            {release.source === 'tauri' ? '下载并安装' : '打开下载页'}
          </button>
        </div>
      </div>
    </div>
  );
}
