import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

const variants: Record<Variant, string> = {
  primary:
    'bg-accent-600 text-white hover:bg-accent-500 active:bg-accent-700 disabled:bg-surface-700 disabled:text-surface-300',
  secondary:
    'bg-surface-700 text-gray-100 hover:bg-surface-650 active:bg-surface-750 border border-surface-600',
  ghost:
    'text-surface-300 hover:bg-surface-750 hover:text-gray-100 active:bg-surface-700',
  danger:
    'bg-error-600/90 text-white hover:bg-error-500 active:bg-error-600',
};

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-2xs gap-1.5 rounded-md',
  md: 'h-8 px-3 text-xs gap-2 rounded-md',
};

export function Button({ variant = 'secondary', size = 'md', className = '', children, ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center whitespace-nowrap font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60 disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
