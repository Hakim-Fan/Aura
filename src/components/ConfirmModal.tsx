import { AlertCircle, X } from 'lucide-react'

type Props = {
  isOpen: boolean
  title: string
  description: string
  confirmText?: string
  cancelText?: string
  onConfirm: () => void
  onCancel: () => void
  variant?: 'danger' | 'warning' | 'info'
}

export function ConfirmModal({
  isOpen,
  title,
  description,
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
  variant = 'info',
}: Props) {
  if (!isOpen) return null

  const variantColors = {
    danger: {
      icon: 'text-red-500',
      bg: 'bg-red-50',
      button: 'bg-red-500 hover:bg-red-600 text-white',
      border: 'border-red-100',
    },
    warning: {
      icon: 'text-amber-500',
      bg: 'bg-amber-50',
      button: 'bg-amber-500 hover:bg-amber-600 text-white',
      border: 'border-amber-100',
    },
    info: {
      icon: 'text-[var(--accent-soft-strong)]',
      bg: 'bg-[rgba(79,123,116,0.05)]',
      button: 'bg-[var(--accent-soft-strong)] hover:filter hover:brightness-110 text-white',
      border: 'border-[rgba(79,123,116,0.1)]',
    },
  }

  const colors = variantColors[variant]

  return (
    <div 
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/40 backdrop-blur-[2px]"
      style={{ animation: 'confirm-fade-in 0.2s ease-out' }}
      onClick={onCancel}
    >
      <style>{`
        @keyframes confirm-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes confirm-zoom-in {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div 
        className="w-full max-w-[400px] bg-white rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.2)] border border-[var(--border-subtle)] overflow-hidden"
        style={{ animation: 'confirm-zoom-in 0.2s ease-out' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className={`p-2.5 rounded-xl ${colors.bg} ${colors.icon} shrink-0`}>
              <AlertCircle size={24} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-17px font-700 text-[var(--text-primary)] mb-1.5 leading-tight">
                {title}
              </h3>
              <p className="text-14px text-[var(--text-secondary)] leading-relaxed opacity-80">
                {description}
              </p>
            </div>
            <button 
              onClick={onCancel}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="px-6 py-4 bg-gray-50/50 border-t border-gray-100 flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-13px font-600 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`px-5 py-2 text-13px font-600 rounded-xl shadow-sm transition-all active:scale-95 ${colors.button}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
