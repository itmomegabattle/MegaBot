import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
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
      const data = await res.json();
      setState(data);
      setCurrentUserId((current) => current || data.users?.[0]?.id || '');
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
          } else if (data.externalOnly) {
            setExternalOnlyMessage(data.error || 'Mini App закрыт для вашей роли. Пользуйтесь задачами в чате с ботом.');
            if (data.user) setCurrentUserId(data.user.id);
          }
          fetchState();
        })
        .catch((err) => {
          console.error('Error authenticating Telegram user:', err);
          fetchState();
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

  const handleSaveAvailability = async (slots: Record<number, number[]>, weekStart: string): Promise<boolean> => {
    if (!state || !currentUserId) return false;

    try {
      const res = await fetch('/api/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId, slots, weekStart }),
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

  const handleClaimTask = async (taskId: string) => {
    if (!currentUserId) return;

    try {
      const res = await fetch('/api/task/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, userId: currentUserId }),
      });
      const data = await res.json();
      if (data.success) {
        await fetchState();
        triggerToast('Вы взяли задачу в работу', 'success');
      } else {
        await fetchState();
        triggerToast(data.error || 'Задача уже занята', 'warning');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleCompleteTask = async (taskId: string) => {
    try {
      const res = await fetch('/api/task/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, status: 'completed' }),
      });
      const data = await res.json();
      if (data.success) {
        await fetchState();
        triggerToast('Задача выполнена', 'success');
      }
    } catch (err) {
      console.error(err);
    }
  };

  if (loading || !state) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col justify-center items-center gap-4">
        <div className="w-12 h-12 border-4 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
        <p className="text-sm text-slate-500 font-medium">Загрузка приложения...</p>
      </div>
    );
  }

  if (externalOnlyMessage) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f4f7ff] px-6 text-center text-slate-900">
        <div className="max-w-sm rounded-3xl border border-blue-100 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-black">Доступ через чат</h1>
          <p className="mt-3 text-sm font-semibold text-slate-500">{externalOnlyMessage}</p>
        </div>
      </div>
    );
  }

  const currentUser = state.users.find((u) => u.id === currentUserId) || state.users[0];

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col justify-center items-center gap-4 px-6 text-center">
        <div className="w-12 h-12 border-4 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
        <p className="text-sm text-slate-500 font-medium">
          Создаём профиль. Если экран не обновился, открой приложение через кнопку в Telegram ещё раз.
        </p>
      </div>
    );
  }

  if (!currentUser.registered) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col justify-center items-center gap-5 px-6 text-center">
        <div className="max-w-sm rounded-3xl border border-blue-100 bg-white p-6 shadow-sm">
          <div className="text-sm font-black uppercase text-[#0050ff]">MegaBot</div>
          <h1 className="mt-2 text-2xl font-black">Сначала регистрация</h1>
          <p className="mt-3 text-sm font-semibold text-slate-500">
            Напиши боту в чате имя, фамилию и дату рождения одним сообщением:
          </p>
          <div className="mt-4 rounded-2xl bg-blue-50 px-4 py-3 text-sm font-black text-[#0050ff]">
            Иван Кузнецов 12.10
          </div>
          <button
            onClick={() => (window as any).Telegram?.WebApp?.close?.()}
            className="mt-5 w-full rounded-3xl bg-[#0050ff] px-5 py-3 text-sm font-black text-white transition hover:bg-[#0a5cff] active:scale-[0.97] active:bg-[#0045d8]"
          >
            Вернуться в чат
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <div className="fixed top-4 right-4 z-50 space-y-2 pointer-events-none max-w-sm">
        {notifications.map((n) => (
          <div
            key={n.id}
            className={`px-4 py-3 rounded-xl shadow-2xl border text-xs font-semibold flex items-center gap-2 animate-fade-in pointer-events-auto ${
              n.type === 'success'
                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-600'
                : n.type === 'warning'
                  ? 'bg-amber-500/15 border-amber-500/30 text-amber-600'
                  : 'bg-blue-500/15 border-blue-500/30 text-blue-600'
            }`}
          >
            {n.type === 'success' ? (
              <CheckCircle2 className="w-4.5 h-4.5 shrink-0" />
            ) : (
              <AlertCircle className="w-4.5 h-4.5 shrink-0" />
            )}
            <span>{n.text}</span>
          </div>
        ))}
      </div>

      <div className="flex-1 flex flex-col h-screen overflow-hidden">
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
