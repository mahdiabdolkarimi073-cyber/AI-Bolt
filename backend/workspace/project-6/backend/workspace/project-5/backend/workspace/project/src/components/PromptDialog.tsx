import { useState, useEffect, useCallback } from 'react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';

interface Props {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

export function PromptDialog({
  open,
  title,
  label,
  initialValue = '',
  placeholder,
  confirmLabel = 'OK',
  onConfirm,
  onClose,
}: Props) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const handleConfirm = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    onClose();
  }, [value, onConfirm, onClose]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="md" disabled={!value.trim()} onClick={handleConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-2xs font-medium uppercase tracking-wider text-surface-300">
          {label}
        </label>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConfirm();
          }}
          placeholder={placeholder}
          className="w-full rounded-md border border-surface-600 bg-surface-800 px-3 py-2 font-mono text-xs text-gray-100 placeholder:text-surface-400 focus:border-accent-500/50 focus:outline-none"
        />
      </div>
    </Dialog>
  );
}
