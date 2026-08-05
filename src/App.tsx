import React, { useEffect, useState } from 'react';
import { CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { SimulationState } from './types';
import MiniApp from './components/MiniApp';

type ToastType = 'info' | 'success' | 'warning';

export default function App() {
  const [state, setState] = useState<SimulationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeMiniAppTab, setActiveMiniAppTab] = useState('slots');
  const [notifications, setNotifications] = useState<{ id: string; text: string; type: ToastType }[]>([]);
  const [currentUserId, setCurrentUserId] = useState('');
  const [externalOnlyMessage, setExternalOnlyMessage] = useState('');

  const fetchState = async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) throw new Error(`State request failed: ${res.status}`);
      const data = await res.json();
      setState(data);
      const isLocalPreview = ['localhost', '127.0.0.1'].includes(window.location.hostname);
      if (isLocalPreview && !currentUserId) {
        const previewUser = data.users?.find((user: any) => user.registered && (user.role === 'admin' || user.role === 'organizer'));
        if (previewUser) setCurrentUserId(previewUser.id);
      }
    } catch (err) {
      console.error('Error fetching app state:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    const tgUser = tg?.initDataUnsafe?.user;

    if (tg?.initData && tgUser) {
      tg.ready();
      tg.expand();

      fetch('/api/user/get-or-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: tg.initData,
          telegramId: String(tgUser.id),
          username: tgUser.username,
          first_name: tgUser.first_name,
          last_name: tgUser.last_name,
        }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.success && data.user) {
            setCurrentUserId(data.user.id);
            fetchState();
          } else if (data.externalOnly) {
            setExternalOnlyMessage(data.error || 'Mini App закрыт для вашей роли. Пользуйтесь задачами в чате с ботом.');
            if (data.user) setCurrentUserId(data.user.id);
            setLoading(false);
          } else {
            setExternalOnlyMessage(data.error || 'Вас нет в списке участников. Напишите админу, чтобы вас добавили в команду.');
            setLoading(false);
          }
        })
        .catch((err) => {
          console.error('Error authenticating Telegram user:', err);
          setExternalOnlyMessage('Не удалось подтвердить доступ через Telegram. Закройте Mini App и откройте его кнопкой в боте.');
          setLoading(false);
        });
      return;
    }

    fetchState();
  }, []);

  const triggerToast = (text: string, type: ToastType = 'info') => {
    const id = Date.now().toString();
    setNotifications((prev) => [...prev, { id, text, type }]);
    setTimeout(() => {
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, 4500);
  };

  const handleSaveAvailability = async (slots: Record<number, number[]>, weekStart: string, hardUnavailableDays: number[] = []): Promise<boolean> => {
    if (!state || !currentUserId) return false;

    try {
      const res = await fetch('/api/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId, slots, weekStart, hardUnavailableDays }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        await fetchState();
        return true;
      }
    } catch (err) {
      console.error(err);
    }
    return false;
  };

  const handleScheduleMeeting = async (meetingData: any): Promise<boolean> => {
    try {
      const res = await fetch('/api/meeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meetingData),
      });
      const data = await res.json();
      if (data.success) {
        await fetchState();
        triggerToast(`Встреча "${meetingData.title}" запланирована`, 'success');
        return true;
      }
      triggerToast(data.error || 'Не удалось назначить встречу', 'warning');
    } catch (err) {
      console.error(err);
    }
    return false;
  };

  const handleCreateTask = async (taskData: any): Promise<boolean> => {
    try {
      const res = await fetch('/api/task/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskData),
      });
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
        triggerToast('Задача возвращена на биржу', 'success');
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

  const handleCompleteTask = async (taskId: string, timeSpentMinutes?: number, completionComment?: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/task/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, status: 'completed', requesterId: currentUserId, timeSpentMinutes, completionComment }),
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

  if (loading || !state) {
    return (
      <div className="mega-gate min-h-screen flex flex-col justify-center items-center gap-4">
        <img src="/brand/megabattle-logo.svg" alt="ITMO MegaBattle" className="mega-gate-logo" />
        <div className="w-11 h-11 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin" role="status" aria-label="Загрузка" />
        <p className="text-sm text-slate-500 font-medium">Загрузка приложения...</p>
      </div>
    );
  }

  if (externalOnlyMessage) {
    return (
      <div className="mega-gate flex min-h-screen items-center justify-center px-6 text-center">
        <div className="mega-gate-card max-w-sm">
          <img src="/brand/megabattle-logo.svg" alt="ITMO MegaBattle" className="mega-gate-logo mx-auto" />
          <h1 className="text-xl font-black">Доступ через чат</h1>
          <p className="mt-3 text-sm font-semibold text-slate-500">{externalOnlyMessage}</p>
        </div>
      </div>
    );
  }

  const currentUser = state.users.find((u) => u.id === currentUserId);

  if (!currentUser) {
    return (
      <div className="mega-gate flex min-h-screen items-center justify-center px-6 text-center">
        <div className="mega-gate-card max-w-sm">
          <img src="/brand/megabattle-logo.svg" alt="ITMO MegaBattle" className="mega-gate-logo mx-auto" />
          <h1 className="mt-2 text-2xl font-black">Открой через Telegram</h1>
          <p className="mt-3 text-sm font-semibold text-slate-500">
            Mini App показывает данные только после проверки Telegram-аккаунта. Открой приложение кнопкой в чате с ботом.
          </p>
        </div>
      </div>
    );
  }

  if (!currentUser.registered) {
    return (
      <div className="mega-gate min-h-screen flex flex-col justify-center items-center gap-5 px-6 text-center">
        <div className="mega-gate-card max-w-sm">
          <img src="/brand/megabattle-logo.svg" alt="ITMO MegaBattle" className="mega-gate-logo mx-auto" />
          <h1 className="mt-2 text-2xl font-black">Доступ ещё не активирован</h1>
          <p className="mt-3 text-sm font-semibold text-slate-500">
            Попроси администратора проверить Telegram username в твоём профиле, затем отправь боту команду /start.
          </p>
          <button
            onClick={() => (window as any).Telegram?.WebApp?.close?.()}
            className="mt-5 w-full rounded-3xl bg-[#0069E0] px-5 py-3 text-sm font-black text-white transition hover:bg-[#1677E8] active:scale-[0.97] active:bg-[#0058BD]"
          >
            Вернуться в чат
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-slate-50 text-slate-900 flex flex-col">
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
              <CheckCircle className="w-4.5 h-4.5 shrink-0" weight="fill" />
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
        />
      </div>
    </div>
  );
}
