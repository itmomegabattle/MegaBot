import React from 'react';

type BadgeVariant = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

const badgeClasses: Record<BadgeVariant, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  primary: 'bg-blue-50 text-[#005BC4]',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-800',
  danger: 'bg-rose-50 text-rose-700',
};

export function Badge({ variant = 'neutral', children, className = '' }: { variant?: BadgeVariant; children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex min-h-6 max-w-full items-center rounded-full px-2.5 py-1 text-xs font-black leading-4 ${badgeClasses[variant]} ${className}`}>{children}</span>;
}
