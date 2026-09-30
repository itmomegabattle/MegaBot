import React from 'react';

export function Field({
  label,
  hint,
  error,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const labelledChild = React.isValidElement<Record<string, unknown>>(children)
    && typeof children.type === 'string'
    && ['input', 'select', 'textarea'].includes(children.type)
    ? React.cloneElement(children, {
        'aria-label': children.props['aria-label'] || label,
        'aria-invalid': error ? true : children.props['aria-invalid'],
      })
    : children;

  return (
    <div className={`block min-w-0 max-w-full ${className}`} role="group" aria-label={label}>
      <span className="mb-1.5 block text-xs font-black uppercase text-slate-500">{label}</span>
      {labelledChild}
      {hint && !error && <p className="mt-1.5 text-xs font-semibold text-slate-500">{hint}</p>}
      {error && <p role="alert" className="mt-1.5 text-xs font-black text-rose-600">{error}</p>}
    </div>
  );
}
