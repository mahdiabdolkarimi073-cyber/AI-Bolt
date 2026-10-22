import { type ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}

export function Dialog({ open, onClose, title, description, children, footer, width = 'max-w-lg' }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${width} rounded-xl border border-surface-600 bg-surface-850 shadow-modal animate-slide-up`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-surface-700 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
            {description && <p className="mt-1 text-xs text-surface-300">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-surface-300 transition-colors hover:bg-surface-700 hover:text-gray-100"
            aria-label="Close dialog"
          >
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto scrollbar-thin px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-surface-700 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
