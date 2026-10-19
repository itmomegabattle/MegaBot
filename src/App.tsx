import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LockKey, PlugsConnected, TelegramLogo, WarningCircle, WifiSlash } from '@phosphor-icons/react';
import { SimulationState } from './types';
import MiniApp from './components/MiniApp';
import BootGate from './components/BootGate';
import { meetingKindText } from './meetingKind';
import { removeUserFormDrafts } from './formDrafts';
import { idempotentPost } from './idempotentRequest';

type ToastType = 'info' | 'success' | 'warning';
type BootStatus = 'loading' | 'ready' | 'telegram-required' | 'unauthorized' | 'forbidden' | 'external-only' | 'offline' | 'unavailable';
type BootState = { status: BootStatus; message?: string };

class RequestTimeoutError extends Error {}

async function requestJson(url: string, init: RequestInit = {}, externalSignal?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromOutside = () => controller.abort();
  externalSignal?.addEventListener('abort', abortFromOutside, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 12_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : {};
    return { response, data };
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError('Request timed out');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromOutside);
  }
}

export default function App() {
  const [state, setState] = useState<SimulationState | null>(null);
  const [boot, setBoot] = useState<BootState>({ status: 'loading' });
  const [activeMiniAppTab, setActiveMiniAppTab] = useState(() => {
    const requestedTab = new URLSearchParams(window.location.search).get('tab');
    return ['slots', 'meetings', 'tasks', 'team', 'faculties', 'profile'].includes(requestedTab || '')
      ? requestedTab as string
      : 'meetings';
  });
  const [notifications, setNotifications] = useState<{ id: string; text: string; type: ToastType }[]>([]);
  const [currentUserId, setCurrentUserId] = useState('');
  const currentUserIdRef = useRef('');
  const bootController = useRef<AbortController | null>(null);

  useEffect(() => { currentUserIdRef.current = currentUserId; }, [currentUserId]);

  const fetchState = useCallback(async (options: { signal?: AbortSignal; initial?: boolean; hadTelegramInitData?: boolean } = {}) => {
    try {
      const { response, data } = await requestJson('/api/state', { cache: 'no-store' }, options.signal);
      if (!response.ok) {
        if (response.status === 401 && currentUserIdRef.current) removeUserFormDrafts(window.sessionStorage, currentUserIdRef.current);
        if (options.initial) {
          if (response.status === 401) {
            setBoot(options.hadTelegramInitData
              ? { status: 'unauthorized', message: 'Сессия закончилась или была отозвана. Открой Mini App заново кнопкой в боте.' }
              : { status: 'telegram-required', message: 'Mini App проверяет аккаунт через Telegram. Открой приложение кнопкой в чате с ботом.' });
          } else if (response.status === 403) {
            setBoot({ status: 'forbidden', message: data.error || 'У этого аккаунта нет доступа к рабочему пространству команды.' });
          } else {
            setBoot({ status: 'unavailable', message: data.error || 'Сервер временно не может загрузить данные. Попробуй ещё раз.' });
          }
        }
        return false;
      }
      setState(data);
      const isLocalPreview = ['localhost', '127.0.0.1'].includes(window.location.hostname);
      if (isLocalPreview) {
        const previewUser = data.users?.find((user: any) => user.registered && (user.role === 'admin' || user.role === 'organizer'));
        if (previewUser) setCurrentUserId((current) => current || previewUser.id);
      }
      if (options.initial) setBoot({ status: 'ready' });
      return true;
    } catch (err: any) {
      if (options.signal?.aborted) return false;
      console.error('Error fetching app state:', err);
      if (options.initial) {
        setBoot(err instanceof RequestTimeoutError
          ? { status: 'unavailable', message: 'Сервер отвечает слишком долго. Проверь соединение и повтори попытку.' }
          : { status: 'offline', message: 'Не удалось подключиться к MegaBot. Проверь интернет и попробуй снова.' });
      }
      return false;
    }
  }, []);

  const runBoot = useCallback(async () => {
    bootController.current?.abort();
    const controller = new AbortController();
    bootController.current = controller;
    setBoot({ status: 'loading' });
    setState(null);
    const tg = (window as any).Telegram?.WebApp;

    if (tg?.initData) {
      tg.ready();
      tg.expand();
      try {
        const { response, data } = await requestJson('/api/user/get-or-create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData: tg.initData }),
        }, controller.signal);
        if (controller.signal.aborted) return;
        if (response.ok && data.success && data.user) {
          if (currentUserIdRef.current && currentUserIdRef.current !== data.user.id) removeUserFormDrafts(window.sessionStorage, currentUserIdRef.current);
          setCurrentUserId(data.user.id);
          await fetchState({ signal: controller.signal, initial: true, hadTelegramInitData: true });
          return;
        }
        if (data.externalOnly) {
          setBoot({ status: 'external-only', message: data.error || 'Эта роль работает с назначенными задачами прямо в чате с ботом.' });
          return;
        }
        if (response.status === 401) {
          setBoot({ status: 'unauthorized', message: data.error || 'Telegram не подтвердил сессию. Закрой Mini App и открой её заново кнопкой в боте.' });
        } else if (response.status === 403) {
          setBoot({ status: 'forbidden', message: data.error || 'Аккаунт не найден в команде. Попроси администратора проверить доступ.' });
        } else {
          setBoot({ status: 'unavailable', message: data.error || 'Сервис временно недоступен. Попробуй ещё раз.' });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Error authenticating Telegram user:', error);
        setBoot(error instanceof RequestTimeoutError
          ? { status: 'unavailable', message: 'Telegram-вход занимает слишком много времени. Попробуй ещё раз.' }
          : { status: 'offline', message: 'Не удалось связаться с MegaBot. Проверь интернет и повтори попытку.' });
      }
      return;
    }

    await fetchState({ signal: controller.signal, initial: true, hadTelegramInitData: false });
  }, [fetchState]);

  useEffect(() => {
    void runBoot();
    return () => bootController.current?.abort();
  }, [runBoot]);

  useEffect(() => {
    if (boot.status !== 'ready') return;
    let lastRefreshAt = Date.now();
    const refreshAfterReturn = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastRefreshAt < 15_000) return;
      lastRefreshAt = Date.now();
      void fetchState();
    };
    window.addEventListener('focus', refreshAfterReturn);
    document.addEventListener('visibilitychange', refreshAfterReturn);
    return () => {
      window.removeEventListener('focus', refreshAfterReturn);
      document.removeEventListener('visibilitychange', refreshAfterReturn);
    };
  }, [boot.status, fetchState]);

  const triggerToast = (text: string, type: ToastType = 'info') => {
    const id = Date.now().toString();
    setNotifications((prev) => [...prev, { id, text, type }]);
    setTimeout(() => {
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, 4500);
  };

  const handleSaveAvailability = async (weekStart: string, days: Record<number, number[]>, hardUnavailableDays: number[], out: boolean, expectedVersion: number): Promise<boolean> => {
    if (!state || !currentUserId) return false;

    try {
      const res = await fetch('/api/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId, weekStart, days, hardUnavailableDays, out, expectedVersion }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        await fetchState();
        return true;
      }
      triggerToast(data.error || 'Не удалось сохранить слоты.', 'warning');
      if (res.status === 409) await fetchState();
    } catch (err) {
      console.error(err);
    }
    return false;
  };

  const handleScheduleMeeting = async (meetingData: any): Promise<boolean> => {
    try {
      const res = await idempotentPost('/api/meeting', meetingData);
      const data = await res.json();
      if (data.success) {
        await fetchState();
        triggerToast(`${meetingKindText(meetingData.kind).label} "${meetingData.title}" ${meetingData.kind === 'setup' || meetingData.kind === 'vibe' ? 'запланирован' : 'запланировано'}`, 'success');
        return true;
      }
      triggerToast(data.error || `Не удалось назначить ${meetingKindText(meetingData.kind).accusative}`, 'warning');
    } catch (err) {
      console.error(err);
    }
    return false;
  };

  const handleCreateTask = async (taskData: any): Promise<boolean> => {
    try {
      const res = await idempotentPost('/api/task/create', taskData);
      const data = await res.json();
      if (data.success) {
        await fetchState();
        triggerToast('Задача создана', 'success');
        return true;
      }
      triggerToast(data.error || 'Не удалось создать задачу', 'warning');
    } catch (err) {
      console.error(err);
      triggerToast('Не удалось создать задачу', 'warning');
    }
    return false;
  };

  const handleReleaseTask = async (taskId: string) => {
    if (!currentUserId) return;
    try {
      const res = await fetch('/api/task/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, userId: currentUserId }),
      });
      const data = await res.json();
      if (data.success) {
        await fetchState();
        triggerToast(data.alreadyReleased
          ? 'Вы уже не назначены на эту задачу'
          : data.becameOpen
            ? 'Вы отказались. Задача снова открыта.'
            : 'Вы отказались. Остальные исполнители сохранены.', 'success');
      } else {
        triggerToast(data.error || 'Не удалось отказаться от задачи', 'warning');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleClaimTask = async (taskId: string): Promise<boolean> => {
    if (!currentUserId) return false;

    setState((current) => current ? {
      ...current,
      tasks: current.tasks.map((task) => task.id === taskId
        ? { ...task, assignedTo: [currentUserId], status: 'assigned' as const }
        : task),
    } : current);

    try {
      const res = await fetch('/api/task/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, userId: currentUserId }),
      });
      const data = await res.json();
      if (data.success) {
        triggerToast('Вы взяли задачу в работу', 'success');
        void fetchState();
        return true;
      } else {
        await fetchState();
        triggerToast(data.error || 'Задача уже занята', 'warning');
      }
    } catch (err) {
      console.error(err);
      await fetchState();
      triggerToast('Не удалось взять задачу — проверьте соединение', 'warning');
    }
    return false;
  };

  const handleRenameAvailabilityWeek = async (weekIndex: number, weekStart: string, name: string, description: string): Promise<boolean> => {
    if (!currentUserId) return false;
    try {
      const res = await fetch('/api/availability/week-name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterId: currentUserId, weekIndex, weekStart, name, description }),
      });
      const data = await res.json();
      if (!res.ok) {
        triggerToast(data.error || 'Не удалось сохранить неделю', 'warning');
        return false;
      }
      await fetchState();
      triggerToast('Название и описание недели сохранены', 'success');
      return true;
    } catch (error) {
      console.error(error);
      triggerToast('Не удалось сохранить неделю — проверьте соединение', 'warning');
      return false;
    }
  };

  const handleCompleteTask = async (taskId: string, timeSpentMinutes?: number, completionComment?: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/task/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          version: state?.tasks.find((task) => task.id === taskId)?.version,
          status: 'completed',
          requesterId: currentUserId,
          timeSpentMinutes,
          completionComment,
        }),
      });
      const data = await res.json();
      if (data.success) {
        await fetchState();
        triggerToast('Задача выполнена', 'success');
        return true;
      }
      triggerToast(data.error || 'Не удалось завершить задачу', 'warning');
    } catch (err) {
      console.error(err);
      triggerToast('Не удалось завершить задачу', 'warning');
    }
    return false;
  };

  if (boot.status === 'loading') {
    return (
      <main className="mega-gate min-h-[100dvh] flex flex-col justify-center items-center gap-4" aria-live="polite">
        <img src="/brand/megabattle-logo.svg" alt="ITMO MegaBattle" className="mega-gate-logo" />
        <div className="w-11 h-11 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin" role="status" aria-label="Загрузка" />
        <p className="text-sm font-semibold">Проверяем доступ и загружаем данные…</p>
      </main>
    );
  }

  if (boot.status === 'telegram-required') return (
    <BootGate
      title="Открой через Telegram"
      message={boot.message || 'Mini App проверяет аккаунт через Telegram. Открой приложение кнопкой в чате с ботом.'}
      icon={TelegramLogo}
      onRetry={() => void runBoot()}
      showClose
    />
  );

  if (boot.status === 'unauthorized') return (
    <BootGate
      title="Сессия закончилась"
      message={boot.message || 'Закрой Mini App и открой её заново кнопкой в боте.'}
      icon={LockKey}
      onRetry={() => void runBoot()}
      showClose
    />
  );

  if (boot.status === 'forbidden') return (
    <BootGate
      title="Нет доступа"
      message={boot.message || 'Попроси администратора проверить твой Telegram-аккаунт в составе команды.'}
      icon={LockKey}
      onRetry={() => void runBoot()}
      showClose
    />
  );

  if (boot.status === 'external-only') return (
    <BootGate
      title="Работа продолжится в чате"
      message={boot.message || 'Эта роль получает и обновляет назначенные задачи через Telegram-бота.'}
      icon={TelegramLogo}
      showClose
    />
  );

  if (boot.status === 'offline') return (
    <BootGate
      title="Нет соединения"
      message={boot.message || 'Проверь интернет и повтори попытку — введённые данные на этом экране не требуются.'}
      icon={WifiSlash}
      onRetry={() => void runBoot()}
    />
  );

  if (boot.status === 'unavailable' || !state) return (
    <BootGate
      title="Сервис временно недоступен"
      message={boot.message || 'Не удалось загрузить рабочие данные. Попробуй ещё раз через несколько секунд.'}
      icon={PlugsConnected}
      onRetry={() => void runBoot()}
    />
  );

  const currentUser = state.users.find((u) => u.id === currentUserId);

  if (!currentUser) {
    return <BootGate title="Аккаунт не найден" message="Обнови доступ через Telegram или попроси администратора проверить состав команды." icon={LockKey} onRetry={() => void runBoot()} showClose />;
  }

  if (!currentUser.registered) {
    return <BootGate title="Доступ ещё не активирован" message="Попроси администратора проверить Telegram username, затем отправь боту команду /start." icon={LockKey} onRetry={() => void runBoot()} showClose />;
  }

  return (
    <div className="min-h-[100dvh] text-slate-900 flex flex-col">
      <div className="fixed top-4 right-4 z-50 space-y-2 pointer-events-none max-w-sm">
        {notifications.map((n) => (
          <div
            key={n.id}
            role={n.type === 'warning' ? 'alert' : 'status'}
            aria-live={n.type === 'warning' ? 'assertive' : 'polite'}
            className={`px-4 py-3 rounded-xl shadow-2xl border text-xs font-semibold flex items-center gap-2 animate-fade-in pointer-events-auto ${
              n.type === 'success'
                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-600'
                : n.type === 'warning'
                  ? 'bg-amber-500/15 border-amber-500/30 text-amber-600'
                  : 'bg-blue-500/15 border-blue-500/30 text-blue-600'
            }`}
          >
            {n.type === 'success' ? (
              <span className="sr-only">Успешно</span>
            ) : (
              <WarningCircle className="w-4.5 h-4.5 shrink-0" weight="fill" />
            )}
            <span>{n.text}</span>
          </div>
        ))}
      </div>

      <div className="flex min-h-[100dvh] flex-1 flex-col">
        <MiniApp
          state={state}
          currentUser={currentUser}
          activeTab={activeMiniAppTab}
          setActiveTab={setActiveMiniAppTab}
          onSaveAvailability={handleSaveAvailability}
          onScheduleMeeting={handleScheduleMeeting}
          onCreateTask={handleCreateTask}
          onClaimTask={handleClaimTask}
          onCompleteTask={handleCompleteTask}
          onReleaseTask={handleReleaseTask}
          onRefreshState={fetchState}
          onRenameAvailabilityWeek={handleRenameAvailabilityWeek}
        />
      </div>
    </div>
  );
}
