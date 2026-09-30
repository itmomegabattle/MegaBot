import React, { useEffect, useRef } from 'react';

const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function DialogSheet({
  titleId,
  descriptionId,
  children,
  className = '',
  onClose,
  closeDisabled = false,
}: {
  titleId: string;
  descriptionId?: string;
  children: React.ReactNode;
  className?: string;
  onClose: () => void;
  closeDisabled?: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = overlayRef.current;
    const siblings = overlay?.parentElement
      ? Array.from(overlay.parentElement.children).filter((element) => element !== overlay) as HTMLElement[]
      : [];
    const previousState = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
    siblings.forEach((element) => {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => {
      const initial = panelRef.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
        || panelRef.current?.querySelector<HTMLElement>(focusableSelector)
        || panelRef.current;
      initial?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousState.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      });
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!closeDisabled) onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    const focusable = (panel ? Array.from(panel.querySelectorAll(focusableSelector)) : [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element.offsetParent !== null);
    if (!focusable.length) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div ref={overlayRef} className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/65 p-3 sm:items-center">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`max-h-[calc(100dvh-24px)] w-full max-w-md overflow-y-auto rounded-[var(--mega-radius-card)] bg-white p-4 shadow-[var(--mega-shadow-raised)] outline-none ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
