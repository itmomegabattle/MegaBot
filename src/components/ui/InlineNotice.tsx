import React, { useEffect, useRef } from 'react';

type NoticeVariant = 'info' | 'success' | 'warning' | 'error';

const noticeClasses: Record<NoticeVariant, string> = {
  info: 'border-blue-100 bg-blue-50 text-blue-900',
  success: 'border-emerald-100 bg-emerald-50 text-emerald-800',
  warning: 'border-amber-100 bg-amber-50 text-amber-900',
  error: 'border-rose-100 bg-rose-50 text-rose-800',
};

export function InlineNotice({ variant = 'info', children, className = '', focusOnMount = false }: { variant?: NoticeVariant; children: React.ReactNode; className?: string; focusOnMount?: boolean }) {
  const noticeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusOnMount) noticeRef.current?.focus();
  }, [focusOnMount]);
  return (
    <div ref={noticeRef} role={variant === 'error' ? 'alert' : 'status'} tabIndex={focusOnMount ? -1 : undefined} className={`rounded-[var(--mega-radius-control)] border px-3 py-2 text-sm font-bold outline-none focus-visible:ring-2 focus-visible:ring-[#0069E0] focus-visible:ring-offset-2 ${noticeClasses[variant]} ${className}`}>
      {children}
    </div>
  );
}
