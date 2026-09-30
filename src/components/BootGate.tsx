import type { ComponentType } from 'react';
import { ArrowClockwise, ChatCircleDots } from '@phosphor-icons/react';

type IconProps = { className?: string; weight?: 'regular' | 'bold' | 'fill' };

type BootGateProps = {
  title: string;
  message: string;
  icon: ComponentType<IconProps>;
  onRetry?: () => void;
  retrying?: boolean;
  showClose?: boolean;
};

export default function BootGate({ title, message, icon: Icon, onRetry, retrying = false, showClose = false }: BootGateProps) {
  const closeTelegram = () => (window as any).Telegram?.WebApp?.close?.();

  return (
    <main className="mega-gate flex min-h-[100dvh] items-center justify-center px-5 py-8 text-center">
      <section className="mega-gate-card max-w-sm" aria-labelledby="boot-gate-title" aria-live="polite">
        <img src="/brand/megabattle-logo.svg" alt="ITMO MegaBattle" className="mega-gate-logo mx-auto" />
        <Icon className="mega-gate-icon mx-auto" weight="bold" />
        <h1 id="boot-gate-title" className="text-xl">{title}</h1>
        <p className="mega-gate-message">{message}</p>
        {(onRetry || showClose) && (
          <div className="mega-gate-actions">
            {onRetry && (
              <button type="button" className="mega-gate-primary" onClick={onRetry} disabled={retrying}>
                <ArrowClockwise className={retrying ? 'animate-spin' : ''} weight="bold" aria-hidden="true" />
                {retrying ? 'Проверяем…' : 'Повторить'}
              </button>
            )}
            {showClose && (
              <button type="button" className="mega-gate-secondary" onClick={closeTelegram}>
                <ChatCircleDots weight="bold" aria-hidden="true" />
                Вернуться в Telegram
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
