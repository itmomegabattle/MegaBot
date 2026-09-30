import React from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'regular' | 'compact';

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'mega-primary-button border border-transparent bg-[#0069E0] text-white shadow-[0_12px_28px_rgba(0,105,224,0.24)] hover:bg-[#1677E8] active:bg-[#0058BD]',
  secondary: 'mega-secondary-button border border-blue-100 bg-blue-50 text-[#0069E0] hover:bg-blue-100 active:bg-blue-200',
  ghost: 'border border-transparent bg-transparent text-[#4D647A] hover:bg-slate-100 active:bg-slate-200',
  danger: 'border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 active:bg-rose-200',
};

const sizeClasses: Record<ButtonSize, string> = {
  regular: 'min-h-11 rounded-[var(--mega-radius-control)] px-5 py-3 text-sm',
  compact: 'min-h-11 rounded-[var(--mega-radius-control)] px-3 py-2 text-xs',
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  pending?: boolean;
};

export function Button({
  variant = 'primary',
  size = 'regular',
  fullWidth = true,
  pending = false,
  disabled,
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={`mega-ui-button flex items-center justify-center gap-2 font-black transition duration-150 hover:brightness-105 active:scale-[0.98] active:brightness-90 disabled:cursor-not-allowed disabled:opacity-60 ${fullWidth ? 'w-full' : 'w-auto'} ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export type IconButtonProps = Omit<ButtonProps, 'fullWidth'> & {
  label: string;
};

export function IconButton({ label, className = '', children, ...props }: IconButtonProps) {
  return (
    <Button {...props} fullWidth={false} aria-label={label} className={`aspect-square shrink-0 px-0 ${className}`}>
      {children}
    </Button>
  );
}
