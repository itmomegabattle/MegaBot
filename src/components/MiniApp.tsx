import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  Users,
  BriefcaseBusiness,
  Shield,
  Check,
  RefreshCw,
  Plus,
  Minus,
  Trash2,
  Clock,
  UserPlus,
  Sparkle,
  CircleAlert,
  Pencil,
  X,
  Download,
} from 'lucide-react';
import { Meeting, SimulationState, Task, User } from '../types';

interface MiniAppProps {
  state: SimulationState;
  currentUser: User;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onSaveAvailability: (slots: Record<number, number[]>) => Promise<boolean>;
  onScheduleMeeting: (meetingData: any) => Promise<boolean>;
  onCreateTask: (taskData: any) => Promise<boolean>;
  onClaimTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onReleaseTask: (taskId: string) => void;
  onRefreshState: () => void;
}

type MeetingSuggestion = {
  dayIndex: number;
  hour: number;
  endHour?: number;
  duration?: number;
  count: number;
  total: number;
  users: string[];
  missingUsers: Pick<User, 'id' | 'realName' | 'username'>[];
};

const dayLabels = [
  { short: 'Пн', full: 'Понедельник' },
  { short: 'Вт', full: 'Вторник' },
  { short: 'Ср', full: 'Среда' },
  { short: 'Чт', full: 'Четверг' },
  { short: 'Пт', full: 'Пятница' },
  { short: 'Сб', full: 'Суббота' },
  { short: 'Вс', full: 'Воскресенье' },
];

const hours = [16, 17, 18, 19, 20, 21, 22, 23];
const telegramLink = (username: string) => `https://t.me/${username.replace('@', '')}`;
const taskAssigneeIds = (task: Task) => {
  if (!task.assignedTo) return [];
  return Array.isArray(task.assignedTo) ? task.assignedTo : [task.assignedTo];
};
const formatDateShort = (value?: string) => {
  if (!value) return '';
  if (/^\d{2}\.\d{2}\.\d{2}$/.test(value)) return value;
  if (/^\d{2}\.\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}.${match[2]}.${match[1].slice(2)}`;
  return value;
};

const formatDateTimeShort = (value?: string) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDateShort(value);
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getFullYear()).slice(2)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

export default function MiniApp({
  state,
  currentUser,
  activeTab,
  setActiveTab,
  onSaveAvailability,
  onScheduleMeeting,
  onCreateTask,
  onClaimTask,
  onCompleteTask,
  onReleaseTask,
  onRefreshState,
}: MiniAppProps) {
  const [slots, setSlots] = useState<Record<number, number[]>>({});
  const [suggestions, setSuggestions] = useState<MeetingSuggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [savingWeek, setSavingWeek] = useState(false);
  const [weekSaved, setWeekSaved] = useState(false);
  const [hasUnsavedSlots, setHasUnsavedSlots] = useState(false);
  const [taskError, setTaskError] = useState('');

  const [showMeetingForm, setShowMeetingForm] = useState(false);
  const [savingMeeting, setSavingMeeting] = useState(false);
  const [expandedMeetingId, setExpandedMeetingId] = useState<string | null>(null);
  const [meetingTitle, setMeetingTitle] = useState('Общее собрание');
  const [meetingDate, setMeetingDate] = useState('');
  const [meetingTime, setMeetingTime] = useState('18:00');
  const [meetingTopic, setMeetingTopic] = useState('');
  const [meetingDescription, setMeetingDescription] = useState('');
  const [meetingType, setMeetingType] = useState<'general' | 'custom' | 'competency'>('general');
  const [meetingCompetency, setMeetingCompetency] = useState('');
  const [participants, setParticipants] = useState<string[]>([]);
  const [editingMeetingId, setEditingMeetingId] = useState<string | null>(null);

  const [showTaskForm, setShowTaskForm] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDesc, setTaskDesc] = useState('');
  const [taskCompetency, setTaskCompetency] = useState('');
  const [taskDeadline, setTaskDeadline] = useState('');
  const [taskAssignedTo, setTaskAssignedTo] = useState<string[]>([]);
  const [taskSow, setTaskSow] = useState('');
  const [taskTips, setTaskTips] = useState('');
  const [taskWorkload, setTaskWorkload] = useState<'low' | 'medium' | 'high'>('medium');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [showCompletedTasks, setShowCompletedTasks] = useState(false);
  const [showTaskLog, setShowTaskLog] = useState(false);

  const [newUserRealName, setNewUserRealName] = useState('');
  const [newUserUsername, setNewUserUsername] = useState('');
  const [newUserRole, setNewUserRole] = useState<'admin' | 'organizer'>('organizer');
  const [newUserBirthday, setNewUserBirthday] = useState('01.01');
  const [showAddUserForm, setShowAddUserForm] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [userDraft, setUserDraft] = useState({ realName: '', username: '', birthday: '', role: 'organizer' as User['role'], competencies: [] as string[] });
  const [newCompetency, setNewCompetency] = useState('');

  const isAdmin = currentUser.role === 'admin';
  const votedUsers = useMemo(
    () => state.users.filter((user) => Object.values(state.availabilities[user.id]?.slots || {}).some((day) => day.length > 0)),
    [state.availabilities, state.users],
  );
  const majority = Math.floor(state.users.length / 2) + 1;
  const myTasks = state.tasks.filter((task) => taskAssigneeIds(task).includes(currentUser.id) && task.status !== 'completed');
  const openTasks = state.tasks.filter((task) => task.status === 'open');
  const completedTasks = state.tasks
    .filter((task) => task.status === 'completed')
    .slice()
    .sort((a, b) => String(b.completedAt || b.createdAt || '').localeCompare(String(a.completedAt || a.createdAt || '')));
  const latestCompletedTasks = completedTasks.slice(0, 10);
  const tasksByCompetency = state.tasks.reduce<Record<string, Task[]>>((acc, task) => {
    const key = task.competency || 'Без блока';
    if (!acc[key]) acc[key] = [];
    acc[key].push(task);
    return acc;
  }, {});
  const teamUsers = isAdmin ? state.users : [currentUser, ...state.users.filter((user) => user.id !== currentUser.id)];
  const competencies = state.competencies || [];

  const availabilityByDay = useMemo(
    () =>
      dayLabels.map((day, dayIndex) => ({
        ...day,
        count: state.users.filter((user) => {
          const daySlots = state.availabilities[user.id]?.slots?.[dayIndex] || [];
          return daySlots.length > 0;
        }).length,
      })),
    [state.availabilities, state.users],
  );

  const formatHours = (daySlots: number[] = []) => {
    if (daySlots.length === 0) return '—';
    const sorted = [...daySlots].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (const hour of sorted.slice(1)) {
      if (hour === prev + 1) {
        prev = hour;
      } else {
        ranges.push(start === prev ? `${start}:00` : `${start}:00-${prev + 1}:00`);
        start = hour;
        prev = hour;
      }
    }
    ranges.push(start === prev ? `${start}:00` : `${start}:00-${prev + 1}:00`);
    return ranges.join(', ');
  };

  const downloadAvailabilityCsv = () => {
    const header = ['Имя', 'Telegram', ...dayLabels.map((day) => day.full)];
    const rows = state.users.map((user) => [
      user.realName,
      user.username,
      ...dayLabels.map((_, dayIndex) => formatHours(state.availabilities[user.id]?.slots?.[dayIndex] || [])),
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(';'))
      .join('\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'megabattle-availability.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    const saved = state.availabilities[currentUser.id]?.slots;
    const nextSlots: Record<number, number[]> = {};
    dayLabels.forEach((_, index) => {
      nextSlots[index] = [...(saved?.[index] || [])];
    });
    setSlots(nextSlots);
  }, [currentUser.id, state.availabilities]);

  const toggleSlot = (day: number, hour: number) => {
    setWeekSaved(false);
    setHasUnsavedSlots(true);
    setSlots((prev) => {
      const daySlots = prev[day] || [];
      const nextDay = daySlots.includes(hour)
        ? daySlots.filter((item) => item !== hour)
        : [...daySlots, hour].sort((a, b) => a - b);
      return { ...prev, [day]: nextDay };
    });
  };

  const selectWholeDay = (day: number) => {
    setWeekSaved(false);
    setHasUnsavedSlots(true);
    setSlots((prev) => {
      const full = (prev[day] || []).length === hours.length;
      return { ...prev, [day]: full ? [] : [...hours] };
    });
  };

  const nextDateForDay = (dayIndex: number) => {
    const today = new Date();
    const jsDay = today.getDay() === 0 ? 6 : today.getDay() - 1;
    const diff = dayIndex - jsDay >= 0 ? dayIndex - jsDay : dayIndex - jsDay + 7;
    const target = new Date(today);
    target.setDate(today.getDate() + diff);
    const day = String(target.getDate()).padStart(2, '0');
    const month = String(target.getMonth() + 1).padStart(2, '0');
    const year = String(target.getFullYear()).slice(2);
    return `${day}.${month}.${year}`;
  };

  const findSuggestions = async () => {
    setSuggesting(true);
    try {
      const res = await fetch('/api/meeting/suggest', { method: 'POST' });
      const data = await res.json();
      if (data.success) setSuggestions(data.topSuggestions || []);
    } finally {
      setSuggesting(false);
    }
  };

  const applySuggestion = (suggestion: MeetingSuggestion) => {
    setMeetingType('general');
    setMeetingTitle('Общее собрание');
    setMeetingDate(nextDateForDay(suggestion.dayIndex));
    setMeetingTime(`${String(suggestion.hour).padStart(2, '0')}:00`);
  };

  const selectMeetingCompetency = (name: string) => {
    setMeetingType('competency');
    setMeetingCompetency(name);
    setParticipants(state.users.filter((user) => user.competencies?.includes(name)).map((user) => user.id));
  };

  const saveWeek = async () => {
    setSavingWeek(true);
    const ok = await onSaveAvailability(slots);
    setSavingWeek(false);
    setWeekSaved(ok);
    if (ok) setHasUnsavedSlots(false);
  };

  const resetMeetingForm = () => {
    setEditingMeetingId(null);
    setShowMeetingForm(false);
    setMeetingTitle('Общее собрание');
    setMeetingDate('');
    setMeetingTime('18:00');
    setMeetingTopic('');
    setMeetingDescription('');
    setMeetingType('general');
    setMeetingCompetency('');
    setParticipants([]);
  };

  const startMeetingEdit = (meeting: Meeting) => {
    setEditingMeetingId(meeting.id);
    setShowMeetingForm(true);
    setMeetingTitle(meeting.title);
    setMeetingDate(formatDateShort(meeting.date));
    setMeetingTime(meeting.time);
    setMeetingTopic(meeting.topic || '');
    setMeetingDescription(meeting.description || '');
    setMeetingType(meeting.competency ? 'competency' : meeting.type);
    setMeetingCompetency(meeting.competency || '');
    setParticipants(Array.isArray(meeting.participants) ? meeting.participants : []);
  };

  const submitMeeting = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingMeeting(true);
    const payload = {
      title: meetingTitle || 'Собрание',
      type: meetingType === 'competency' ? 'custom' : meetingType,
      date: meetingDate || nextDateForDay(0),
      time: meetingTime,
      duration: 1,
      hostId: currentUser.id,
      participants: meetingType === 'general' ? 'all' : participants,
      topic: meetingTopic,
      description: meetingDescription,
      competency: meetingType === 'competency' ? meetingCompetency : '',
    };

    if (editingMeetingId) {
      const res = await fetch('/api/meeting/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId: editingMeetingId, requesterId: currentUser.id, ...payload }),
      });
      if (res.ok) {
        resetMeetingForm();
        onRefreshState();
      }
      setSavingMeeting(false);
      return;
    }

    const ok = await onScheduleMeeting(payload);
    setSavingMeeting(false);
    if (ok) resetMeetingForm();
  };

  const deleteMeeting = async (meetingId: string) => {
    const confirmed = window.confirm('Удалить встречу? Это действие нельзя отменить.');
    if (!confirmed) return;
    const res = await fetch('/api/meeting/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId, requesterId: currentUser.id }),
    });
    if (res.ok) onRefreshState();
  };

  const resetTaskForm = () => {
    setTaskTitle('');
    setTaskDesc('');
    setTaskCompetency('');
    setTaskDeadline('');
    setTaskAssignedTo([]);
    setTaskSow('');
    setTaskTips('');
    setTaskWorkload('medium');
  };

  const openTaskForm = () => {
    if (!showTaskForm) {
      resetTaskForm();
      setTaskError('');
    }
    setShowTaskForm((value) => !value);
  };

  const submitTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!taskTitle.trim() || !taskDesc.trim() || !taskCompetency.trim()) {
      setTaskError('Заполни название, описание и блок задачи. Эти поля обязательные.');
      return;
    }
    setTaskError('');
    setSavingTask(true);
    const ok = await onCreateTask({
      title: taskTitle.trim(),
      description: taskDesc.trim(),
      competency: taskCompetency.trim(),
      deadline: taskDeadline || nextDateForDay(4),
      assignedTo: taskAssignedTo,
      sow: taskSow,
      tips: taskTips.split('\n').map((tip) => tip.trim()).filter(Boolean),
      workload: taskWorkload,
      creatorId: currentUser.id,
    });
    setSavingTask(false);
    if (ok) {
      resetTaskForm();
      setShowTaskForm(false);
    }
  };

  const claimTask = async (taskId: string) => {
    setTaskError('');
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task || task.status !== 'open') {
      setTaskError('Эту задачу уже взяли. Обнови доску, чтобы увидеть актуальный список.');
      return;
    }
    await onClaimTask(taskId);
  };

  const clearTaskLog = async () => {
    if (!isAdmin) return;
    const confirmed = window.confirm('Удалить весь бэклог задач из базы? Это безвозвратное действие: исчезнут все открытые, активные и выполненные задачи, а также история для экспорта.');
    if (!confirmed) return;
    const secondConfirm = window.confirm('Точно удалить ВСЕ задачи? Отменить это действие нельзя.');
    if (!secondConfirm) return;
    const res = await fetch('/api/task/log/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id }),
    });
    if (res.ok) onRefreshState();
  };

  const addUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isAdmin) return;
    const res = await fetch('/api/user/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requesterId: currentUser.id,
        realName: newUserRealName,
        username: newUserUsername,
        role: newUserRole,
        birthday: newUserBirthday,
      }),
    });
    if (res.ok) {
      setNewUserRealName('');
      setNewUserUsername('');
      setNewUserBirthday('01.01');
      setShowAddUserForm(false);
      onRefreshState();
    }
  };

  const startUserEdit = (user: User) => {
    setEditingUserId(user.id);
    setUserDraft({
      realName: user.realName,
      username: user.username,
      birthday: user.birthday || '01.01',
      role: user.role,
      competencies: user.competencies || [],
    });
  };

  const updateUser = async (userId: string) => {
    const payload = isAdmin
      ? { requesterId: currentUser.id, userId, ...userDraft }
      : { requesterId: currentUser.id, userId, competencies: userDraft.competencies };
    const res = await fetch('/api/user/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setEditingUserId(null);
      onRefreshState();
    }
  };

  const addCompetency = async () => {
    if (!newCompetency.trim()) return;
    const res = await fetch('/api/competency/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id, name: newCompetency.trim() }),
    });
    if (res.ok) {
      setNewCompetency('');
      onRefreshState();
    }
  };

  const deleteCompetency = async (name: string) => {
    if (!window.confirm(`Удалить блок "${name}"? Он пропадёт у всех участников.`)) return;
    const res = await fetch('/api/competency/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id, name }),
    });
    if (res.ok) onRefreshState();
  };

  const toggleDraftCompetency = (name: string) => {
    setUserDraft((prev) => ({
      ...prev,
      competencies: prev.competencies.includes(name)
        ? prev.competencies.filter((item) => item !== name)
        : [...prev.competencies, name],
    }));
  };

  const deleteUser = async (userId: string) => {
    if (userId === currentUser.id) return;
    const confirmed = window.confirm('Удалить человека из команды? Это безвозвратное действие: профиль, слоты и сообщения будут удалены.');
    if (!confirmed) return;
    const res = await fetch('/api/user/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id, userId }),
    });
    if (res.ok) onRefreshState();
  };

  const pageTitle = {
    slots: 'Моя неделя',
    meetings: 'Собрания',
    tasks: 'Задачи',
    team: 'Мегаорги',
  }[activeTab] || 'Моя неделя';

  return (
    <div className="min-h-screen bg-[#f4f7ff] text-slate-950">
      <header className="sticky top-0 z-30 overflow-hidden bg-[#0050ff] text-white">
        <div className="absolute inset-0 opacity-35">
          <div className="absolute inset-x-0 -top-5 text-white/55">
            <WaveMark />
          </div>
          <Sparkle className="absolute bottom-4 left-6 h-3 w-3 text-white" />
          <Sparkle className="absolute right-1/3 bottom-7 h-3 w-3 text-white" />
          <Sparkle className="absolute right-20 top-9 h-3.5 w-3.5 text-white" />
        </div>
        <div className="relative px-5 pb-4 pt-3">
          <div className="flex items-start justify-between gap-4">
            <div className="font-black italic leading-[0.86] tracking-tight">
              <div className="text-xl">ITMO</div>
              <div className="text-xl">MEGA</div>
              <div className="text-xl">BATTLE</div>
            </div>
            <button onClick={onRefreshState} className={`${iconButtonClass} h-10 w-10`} title="Обновить">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3 flex items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase text-white/70">MegaOrgia</p>
              <h1 className="text-2xl font-black tracking-tight">{pageTitle}</h1>
            </div>
            <div className="rounded-2xl border border-white/20 bg-white/15 px-3 py-2 text-right text-xs backdrop-blur">
              <div className="font-bold">{currentUser.realName}</div>
              <div className="text-white/70">{isAdmin ? 'Админ' : 'Организатор'}</div>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-28 pt-4">
        {activeTab === 'slots' && (
          <section className="space-y-4">
            <HeroCard
              title="Отметь свободные часы"
              text=""
              right={`${votedUsers.length}/${state.users.length}`}
              caption="заполнили"
            />

            <div className={`rounded-3xl border p-4 shadow-sm ${hasUnsavedSlots ? 'border-amber-200 bg-amber-50' : weekSaved ? 'border-emerald-200 bg-emerald-50' : 'border-blue-100 bg-white'}`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className={`font-black ${hasUnsavedSlots ? 'text-amber-900' : weekSaved ? 'text-emerald-800' : 'text-slate-900'}`}>
                    {hasUnsavedSlots ? 'Осталось сохранить неделю' : weekSaved ? 'Неделя сохранена' : 'Выбери свободные часы'}
                  </div>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    Отметки попадут в общий календарь только после сохранения.
                  </p>
                </div>
                <button onClick={saveWeek} disabled={savingWeek || (!hasUnsavedSlots && weekSaved)} className={`${hasUnsavedSlots ? primaryCompactButtonClass : secondaryButtonClass} shrink-0 disabled:opacity-60`}>
                  <Check className="h-4 w-4" />
                  {savingWeek ? 'Сохраняю...' : weekSaved && !hasUnsavedSlots ? 'Сохранено' : 'Сохранить'}
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {dayLabels.map((day, index) => {
                const selected = slots[index] || [];
                return (
                  <div key={day.full} className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <h2 className="text-base font-black">{day.full}</h2>
                        <p className="text-xs text-slate-500">{selected.length ? `${selected.length} ч. свободно` : 'Пока ничего не выбрано'}</p>
                      </div>
                      <button onClick={() => selectWholeDay(index)} className={secondaryButtonClass}>
                        {selected.length === hours.length ? 'Снять' : 'Весь день'}
                      </button>
                    </div>
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
                      {hours.map((hour) => {
                        const active = selected.includes(hour);
                        return (
                          <button
                            key={hour}
                            onClick={() => toggleSlot(index, hour)}
                            className={`h-11 rounded-2xl border text-sm font-black ${pressClass} ${
                              active
                                ? 'border-[#0050ff] bg-[#0050ff] text-white shadow-[0_8px_20px_rgba(0,80,255,0.2)] hover:bg-[#0a5cff] active:bg-[#0045d8]'
                                : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-blue-50 active:bg-blue-100'
                            }`}
                          >
                            {hour}:00
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <button onClick={saveWeek} disabled={savingWeek || (!hasUnsavedSlots && weekSaved)} className={`${primaryButtonClass} sticky bottom-24 z-20 py-4 text-base disabled:opacity-70`}>
              <Check className="h-5 w-5" />
              {savingWeek ? 'Сохраняю...' : weekSaved ? 'Неделя сохранена' : 'Сохранить неделю'}
            </button>
          </section>
        )}

        {activeTab === 'meetings' && (
          <section className="space-y-4">
            <HeroCard
              title="Подобрать время для собрания"
              text=""
              right={votedUsers.length >= majority ? 'Можно' : `${majority - votedUsers.length}`}
              caption={votedUsers.length >= majority ? 'назначать' : 'до большинства'}
            />

            <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
              <h2 className="font-black">Календарь свободных дней</h2>
              <div className="mt-3 grid grid-cols-7 gap-1.5">
                {availabilityByDay.map((day) => {
                  const ratio = state.users.length ? day.count / state.users.length : 0;
                  return (
                    <div key={day.short} className="rounded-2xl border border-blue-100 bg-slate-50 p-2 text-center">
                      <div className="text-xs font-black text-slate-500">{day.short}</div>
                      <div className="mt-2 text-lg font-black text-[#0050ff]">{day.count}</div>
                      <div className="text-[10px] font-bold text-slate-400">из {state.users.length}</div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-blue-100">
                        <div className="h-full rounded-full bg-[#0050ff]" style={{ width: `${Math.round(ratio * 100)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {isAdmin && (
              <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-black">Общий календарь</h2>
                    <p className="text-xs text-slate-500">Кто и когда свободен на неделе</p>
                  </div>
                  <button onClick={downloadAvailabilityCsv} className={miniButtonClass}>
                    <Download className="h-4 w-4" />
                    Скачать
                  </button>
                </div>
                <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-100">
                  <table className="min-w-[720px] w-full border-collapse text-left text-xs">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 font-black">Участник</th>
                        {dayLabels.map((day) => (
                          <th key={day.short} className="px-3 py-2 text-center font-black">{day.short}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {state.users.map((user) => (
                        <tr key={user.id} className="border-t border-slate-100">
                          <td className="sticky left-0 z-10 bg-white px-3 py-2">
                            <div className="font-black">{user.realName}</div>
                            <div className="font-bold text-[#0050ff]">{user.username}</div>
                          </td>
                          {dayLabels.map((_, dayIndex) => {
                            const text = formatHours(state.availabilities[user.id]?.slots?.[dayIndex] || []);
                            const filled = text !== '—';
                            return (
                              <td key={dayIndex} className="px-2 py-2 align-top">
                                <div className={`min-h-10 rounded-xl px-2 py-1.5 text-center font-bold ${filled ? 'bg-blue-50 text-[#0050ff]' : 'bg-slate-50 text-slate-300'}`}>
                                  {text}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-black">Лучшие слоты</h2>
                  <p className="text-xs text-slate-500">По максимуму свободных людей</p>
                </div>
                <button onClick={findSuggestions} disabled={suggesting} className={`rounded-full bg-[#0050ff] px-5 py-2.5 text-xs font-black text-white shadow-[0_10px_24px_rgba(0,80,255,0.28)] hover:bg-[#0a5cff] active:bg-[#0045d8] ${pressClass} disabled:opacity-70`}>
                  {suggesting ? 'Считаю...' : 'Найти'}
                </button>
              </div>
              <div className="mt-4 space-y-3">
                {suggestions.length === 0 ? (
                  <EmptyState text="Нажми «Найти», когда команда заполнит слоты." />
                ) : (
                  suggestions.map((suggestion, index) => (
                    <button key={`${suggestion.dayIndex}-${suggestion.hour}-${suggestion.endHour || ''}`} onClick={() => applySuggestion(suggestion)} className={`w-full rounded-2xl border border-blue-100 bg-blue-50/60 p-3 text-left hover:bg-blue-100 active:bg-blue-200 ${pressClass}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-black">
                          {index + 1}. {dayLabels[suggestion.dayIndex]?.full}, {suggestion.hour}:00-{suggestion.endHour || suggestion.hour + (suggestion.duration || 1)}:00
                        </div>
                        <div className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-[#0050ff]">
                          {suggestion.count}/{suggestion.total}
                        </div>
                      </div>
                      <div className="mt-1 text-xs font-semibold text-slate-500">
                        Окно: {suggestion.duration || 1} ч. подряд
                      </div>
                      <div className="mt-2 text-xs text-slate-600">
                        Не смогут:{' '}
                        {suggestion.missingUsers.length === 0 ? (
                          <span className="font-bold text-emerald-600">никто</span>
                        ) : (
                          suggestion.missingUsers.map((user, userIndex) => (
                            <React.Fragment key={user.id}>
                              <a href={telegramLink(user.username)} target="_blank" rel="noreferrer" className="font-bold text-[#0050ff] underline decoration-blue-200" onClick={(event) => event.stopPropagation()}>
                                {user.realName}
                              </a>
                              {userIndex < suggestion.missingUsers.length - 1 ? ', ' : ''}
                            </React.Fragment>
                          ))
                        )}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            {!showMeetingForm && (
              <button
                onClick={() => {
                  resetMeetingForm();
                  setShowMeetingForm(true);
                }}
                className={primaryButtonClass}
              >
                <Plus className="h-4 w-4" />
                Назначить собрание
              </button>
            )}

            {showMeetingForm && (
            <form onSubmit={submitMeeting} className="space-y-3 rounded-3xl border border-blue-100 bg-white p-4 shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-black">{editingMeetingId ? 'Редактировать собрание' : 'Назначить собрание'}</h2>
                {editingMeetingId && (
                  <button type="button" onClick={resetMeetingForm} className={miniButtonClass}>
                    <X className="h-4 w-4" />
                    Отмена
                  </button>
                )}
              </div>
              <Segmented value={meetingType} onChange={(value) => setMeetingType(value as 'general' | 'custom' | 'competency')} options={[["general", "Вся команда"], ["custom", "Выбрать людей"], ["competency", "Выбрать блок"]]} />
              <Field label="Название">
                <input value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} className={inputClass} />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Дата">
                  <input value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} className={inputClass} inputMode="numeric" placeholder="06.07.26" />
                </Field>
                <Field label="Время">
                  <input type="time" value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} className={inputClass} />
                </Field>
              </div>
              <Field label="Тема">
                <textarea value={meetingTopic} onChange={(e) => setMeetingTopic(e.target.value)} className={inputClass} rows={3} />
              </Field>
              <Field label="Описание">
                <textarea value={meetingDescription} onChange={(e) => setMeetingDescription(e.target.value)} className={inputClass} rows={3} placeholder="Можно оставить пустым" />
              </Field>
              {meetingType === 'competency' && (
                <Field label="Блок">
                  <select value={meetingCompetency} onChange={(e) => selectMeetingCompetency(e.target.value)} className={inputClass}>
                    <option value="">Выбери блок</option>
                    {competencies.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </Field>
              )}
              {(meetingType === 'custom' || meetingType === 'competency') && (
                <div className="grid grid-cols-1 gap-2">
                  {state.users.map((user) => (
                    <label key={user.id} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                      <span>{user.realName}</span>
                      <input type="checkbox" checked={participants.includes(user.id)} onChange={() => setParticipants((prev) => (prev.includes(user.id) ? prev.filter((id) => id !== user.id) : [...prev, user.id]))} />
                    </label>
                  ))}
                </div>
              )}
              <button disabled={savingMeeting} className={`${primaryButtonClass} disabled:opacity-70`}>
                {savingMeeting ? 'Сохраняю...' : editingMeetingId ? 'Сохранить встречу' : 'Запланировать'}
              </button>
            </form>
            )}

            <div className="space-y-3">
              <h2 className="px-1 font-black">Ближайшие встречи</h2>
              {state.meetings.filter((meeting) => meeting.status === 'scheduled').length === 0 ? (
                <EmptyState text="Встреч пока нет" />
              ) : (
                state.meetings.filter((meeting) => meeting.status === 'scheduled').map((meeting) => {
                  const host = state.users.find((user) => user.id === meeting.hostId);
                  const canManage = isAdmin || meeting.hostId === currentUser.id;
                  const expanded = expandedMeetingId === meeting.id;
                  return (
                    <div
                      key={meeting.id}
                      className={`rounded-3xl border border-blue-100 bg-white p-4 shadow-sm ${pressClass}`}
                      onClick={() => setExpandedMeetingId(expanded ? null : meeting.id)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-black">{meeting.title}</h3>
                          <p className="mt-1 text-sm text-slate-500">{meeting.topic || 'Нажми, чтобы посмотреть детали'}</p>
                        </div>
                        <div className="rounded-2xl bg-blue-50 px-3 py-2 text-right text-xs font-black text-[#0050ff]">
                          {formatDateShort(meeting.date)}
                          <br />
                          {meeting.time}
                        </div>
                      </div>

                      {expanded && (
                        <div className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm text-slate-600" onClick={(event) => event.stopPropagation()}>
                          <InfoRow label="Автор" value={host?.realName || 'Организатор'} />
                          {host?.username && <InfoRow label="Telegram" value={host.username} href={telegramLink(host.username)} />}
                          <InfoRow label="Дата" value={formatDateShort(meeting.date)} />
                          <InfoRow label="Время" value={meeting.time} />
                          <InfoRow label="Тип" value={meeting.type === 'general' ? 'Вся команда' : 'Выбранные люди'} />
                          {meeting.competency && <InfoRow label="Блок" value={meeting.competency} />}
                          <InfoRow label="Тема" value={meeting.topic || 'Без темы'} />
                          {meeting.description && <InfoRow label="Описание" value={meeting.description} />}
                          {canManage && (
                            <div className="flex gap-2 pt-2">
                              <button onClick={() => startMeetingEdit(meeting)} className={miniButtonClass}>
                                <Pencil className="h-4 w-4" />
                                Редактировать
                              </button>
                              <button onClick={() => deleteMeeting(meeting.id)} className={`${miniButtonClass} border-rose-100 bg-rose-50 text-rose-600 hover:bg-rose-100 active:bg-rose-200`}>
                                <Trash2 className="h-4 w-4" />
                                Удалить
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}

        {activeTab === 'tasks' && (
          <section className="space-y-4">
            <HeroCard title="Следим за выгоранием" text="" right={myTasks.length} caption="моих задач" />
            <button onClick={openTaskForm} className={primaryButtonClass}>
              {showTaskForm ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {showTaskForm ? 'Скрыть форму' : 'Создать задачу'}
            </button>
            {showTaskForm && (
              <form onSubmit={submitTask} className="space-y-3 rounded-3xl border border-blue-100 bg-white p-4 shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
                <Field label="Название">
                  <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} className={inputClass} />
                </Field>
                <Field label="Описание">
                  <textarea value={taskDesc} onChange={(e) => setTaskDesc(e.target.value)} className={inputClass} rows={3} />
                </Field>
                <Field label="Блок">
                  <select value={taskCompetency} onChange={(e) => setTaskCompetency(e.target.value)} className={inputClass}>
                    <option value="">Выбери блок задачи</option>
                    {competencies.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                    {competencies.length === 0 && <option value="Общее">Общее</option>}
                  </select>
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Дедлайн">
                    <input value={taskDeadline} onChange={(e) => setTaskDeadline(e.target.value)} className={inputClass} inputMode="numeric" placeholder="10.07.26" />
                  </Field>
                  <Field label="Нагрузка">
                    <select value={taskWorkload} onChange={(e) => setTaskWorkload(e.target.value as any)} className={inputClass}>
                      <option value="low">Низкая</option>
                      <option value="medium">Средняя</option>
                      <option value="high">Высокая</option>
                    </select>
                  </Field>
                </div>
                <Field label="Исполнитель">
                  <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-2">
                    <div className="px-1 text-xs font-bold text-slate-500">Никого не выбирай, если задача открытая.</div>
                    {state.users.map((user) => (
                      <label key={user.id} className="flex items-center justify-between rounded-xl bg-white px-3 py-2 text-sm font-semibold">
                        <span>{user.realName}</span>
                        <input
                          type="checkbox"
                          checked={taskAssignedTo.includes(user.id)}
                          onChange={() => setTaskAssignedTo((prev) => (prev.includes(user.id) ? prev.filter((id) => id !== user.id) : [...prev, user.id]))}
                        />
                      </label>
                    ))}
                  </div>
                </Field>
                <Field label="ТЗ">
                  <textarea value={taskSow} onChange={(e) => setTaskSow(e.target.value)} className={inputClass} rows={3} />
                </Field>
                <Field label="Подсказки, каждая с новой строки">
                  <textarea value={taskTips} onChange={(e) => setTaskTips(e.target.value)} className={inputClass} rows={3} />
                </Field>
                <button disabled={savingTask} className={`${primaryButtonClass} disabled:opacity-70`}>
                  {savingTask ? 'Сохраняю...' : 'Сохранить задачу'}
                </button>
              </form>
            )}
            {taskError && <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-800">{taskError}</div>}
            <TaskList title="Мои задачи" tasks={myTasks} users={state.users} currentUser={currentUser} actionLabel="Готово" onAction={(id) => onCompleteTask(id)} onRelease={onReleaseTask} />
            <TaskList title="Открытые задачи" tasks={openTasks} users={state.users} currentUser={currentUser} actionLabel="Взять" onAction={claimTask} />
            <button onClick={() => setShowCompletedTasks((value) => !value)} className={secondaryButtonClass}>
              {showCompletedTasks ? <Minus className="h-4 w-4" /> : <Check className="h-4 w-4" />}
              {showCompletedTasks ? 'Скрыть выполненные задачи' : 'Посмотреть выполненные задачи'}
            </button>
            {showCompletedTasks && (
              <TaskList title="Последние выполненные" tasks={latestCompletedTasks} users={state.users} currentUser={currentUser} actionLabel="Готово" onAction={() => undefined} />
            )}

            <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-black">Бэклог задач</h2>
                  <p className="text-xs font-semibold text-slate-500">Все задачи за всё время, разбитые по блокам.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a href="/api/task/export" className={miniButtonClass}>
                    <Download className="h-4 w-4" />
                    Excel
                  </a>
                  {isAdmin && (
                    <button onClick={clearTaskLog} className={`${miniButtonClass} border-rose-100 bg-rose-50 text-rose-600 hover:bg-rose-100 active:bg-rose-200`}>
                      <Trash2 className="h-4 w-4" />
                      Удалить лог
                    </button>
                  )}
                  <button onClick={() => setShowTaskLog((value) => !value)} className={miniButtonClass}>
                    {showTaskLog ? 'Свернуть' : 'Открыть лог'}
                  </button>
                </div>
              </div>
              {showTaskLog && (
                <TaskLogView tasksByCompetency={tasksByCompetency} users={state.users} />
              )}
            </div>
          </section>
        )}

        {activeTab === 'team' && (
          <section className="space-y-4">
            <HeroCard title="Наша команда" text="" right={state.users.length} caption="человек" />

            {isAdmin && (
              <button onClick={() => setShowAddUserForm((value) => !value)} className={primaryButtonClass}>
                {showAddUserForm ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                Добавить человека
              </button>
            )}

            {isAdmin && showAddUserForm && (
              <form onSubmit={addUser} className="space-y-3 rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                <h2 className="flex items-center gap-2 font-black">
                  <UserPlus className="h-4 w-4 text-[#0050ff]" />
                  Добавить человека
                </h2>
                <Field label="Имя">
                  <input value={newUserRealName} onChange={(e) => setNewUserRealName(e.target.value)} className={inputClass} />
                </Field>
                <Field label="Telegram">
                  <input value={newUserUsername} onChange={(e) => setNewUserUsername(e.target.value)} className={inputClass} placeholder="@username" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Роль">
                    <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as any)} className={inputClass}>
                      <option value="organizer">Организатор</option>
                      <option value="admin">Админ</option>
                    </select>
                  </Field>
                  <Field label="ДР">
                    <input value={newUserBirthday} onChange={(e) => setNewUserBirthday(e.target.value)} className={inputClass} placeholder="12.10" />
                  </Field>
                </div>
                <button className={primaryButtonClass}>Добавить</button>
              </form>
            )}

            {isAdmin && (
              <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                <h2 className="font-black">Блоки и компетенции</h2>
                <div className="mt-3 flex gap-2">
                  <input value={newCompetency} onChange={(e) => setNewCompetency(e.target.value)} className={inputClass} placeholder="Например, Дизайн" />
                  <button type="button" onClick={addCompetency} className={miniButtonClass}>
                    <Plus className="h-4 w-4" />
                    Добавить
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {competencies.length === 0 ? (
                    <span className="text-sm font-bold text-slate-400">Пока нет блоков</span>
                  ) : (
                    competencies.map((name) => (
                      <button key={name} type="button" onClick={() => deleteCompetency(name)} className={`${miniButtonClass} bg-slate-50 text-slate-700`}>
                        {name}
                        <X className="h-3 w-3" />
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            <div className="space-y-3">
              {state.users.length === 0 ? (
                <EmptyState text="Пока в команде никого нет" />
              ) : (
                teamUsers.map((user) => {
                  const expanded = expandedUserId === user.id;
                  const editing = editingUserId === user.id;
                  return (
                    <div key={user.id} className={`rounded-3xl border border-blue-100 bg-white p-4 shadow-sm ${pressClass}`} onClick={() => setExpandedUserId(expanded ? null : user.id)}>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-black">{user.realName}</div>
                          <a href={telegramLink(user.username)} target="_blank" rel="noreferrer" className="text-sm font-bold text-[#0050ff]" onClick={(event) => event.stopPropagation()}>
                            {user.username}
                          </a>
                        </div>
                        <div className="text-right">
                          <div className="rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-[#0050ff]">{user.role === 'admin' ? 'Админ' : 'Орг'}</div>
                          <div className="mt-1 text-xs text-slate-500">{formatDateShort(user.birthday || '01.01')}</div>
                        </div>
                      </div>

                      {expanded && (
                        <div className="mt-4 border-t border-slate-100 pt-4" onClick={(event) => event.stopPropagation()}>
                          {!editing ? (
                            <div className="space-y-2 text-sm text-slate-600">
                              <InfoRow label="Имя" value={user.realName} />
                              <InfoRow label="Telegram" value={user.username} href={telegramLink(user.username)} />
                              <InfoRow label="Дата рождения" value={formatDateShort(user.birthday || '01.01')} />
                              <InfoRow label="Роль" value={user.role === 'admin' ? 'Админ' : 'Организатор'} />
                              <InfoRow label="Блоки" value={(user.competencies || []).join(', ') || 'не выбраны'} />
                              {(isAdmin || user.id === currentUser.id) && (
                                <div className="flex gap-2 pt-2">
                                  <button onClick={() => startUserEdit(user)} className={miniButtonClass}>
                                    <Pencil className="h-4 w-4" />
                                    Редактировать
                                  </button>
                                  {isAdmin && (
                                    <button onClick={() => deleteUser(user.id)} disabled={user.id === currentUser.id} className={`${miniButtonClass} ml-auto border-rose-100 bg-rose-50 text-rose-600 disabled:opacity-40`}>
                                      <Trash2 className="h-4 w-4" />
                                      Удалить
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="space-y-3">
                              <Field label="Имя">
                                <input value={userDraft.realName} onChange={(e) => setUserDraft((prev) => ({ ...prev, realName: e.target.value }))} className={inputClass} />
                              </Field>
                              <Field label="Telegram">
                                <input value={userDraft.username} onChange={(e) => setUserDraft((prev) => ({ ...prev, username: e.target.value }))} className={inputClass} />
                              </Field>
                              <div className={`grid gap-3 ${isAdmin ? 'grid-cols-2' : 'grid-cols-1'}`}>
                                <Field label="ДР">
                                  <input value={userDraft.birthday} onChange={(e) => setUserDraft((prev) => ({ ...prev, birthday: e.target.value }))} className={inputClass} />
                                </Field>
                                {isAdmin && (
                                  <Field label="Роль">
                                    <select value={userDraft.role} onChange={(e) => setUserDraft((prev) => ({ ...prev, role: e.target.value as User['role'] }))} className={inputClass}>
                                      <option value="organizer">Организатор</option>
                                      <option value="admin">Админ</option>
                                    </select>
                                  </Field>
                                )}
                              </div>
                              <Field label="Блоки">
                                <div className="grid grid-cols-1 gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-2">
                                  {competencies.length === 0 ? (
                                    <div className="text-xs font-bold text-slate-400">Админ ещё не добавил блоки</div>
                                  ) : (
                                    competencies.map((name) => (
                                      <label key={name} className="flex items-center justify-between rounded-xl bg-white px-3 py-2 text-sm font-semibold">
                                        <span>{name}</span>
                                        <input type="checkbox" checked={userDraft.competencies.includes(name)} onChange={() => toggleDraftCompetency(name)} />
                                      </label>
                                    ))
                                  )}
                                </div>
                              </Field>
                              <div className="flex gap-2">
                                <button onClick={() => updateUser(user.id)} className={miniButtonClass}>OK</button>
                                <button onClick={() => setEditingUserId(null)} className={miniButtonClass}>Отмена</button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-blue-100 bg-white/95 px-3 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-2 shadow-[0_-12px_30px_rgba(0,80,255,0.08)] backdrop-blur">
        <div className="mx-auto grid max-w-3xl grid-cols-4 gap-1">
          <NavButton icon={<CalendarDays />} label="Слоты" active={activeTab === 'slots'} onClick={() => setActiveTab('slots')} />
          <NavButton icon={<Users />} label="Встречи" active={activeTab === 'meetings'} onClick={() => setActiveTab('meetings')} />
          <NavButton icon={<BriefcaseBusiness />} label="Задачи" active={activeTab === 'tasks'} onClick={() => setActiveTab('tasks')} />
          <NavButton icon={<Shield />} label="Команда" active={activeTab === 'team'} onClick={() => setActiveTab('team')} />
        </div>
      </nav>
    </div>
  );
}

const pressClass = 'transition duration-150 hover:brightness-105 active:scale-[0.97] active:brightness-90 active:rounded-2xl';
const inputClass = 'w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm font-semibold outline-none transition focus:border-[#0050ff] focus:bg-white';
const primaryButtonClass = `flex w-full items-center justify-center gap-2 rounded-3xl bg-[#0050ff] px-5 py-3 text-sm font-black text-white shadow-[0_12px_28px_rgba(0,80,255,0.24)] hover:bg-[#0a5cff] active:bg-[#0045d8] ${pressClass}`;
const primaryCompactButtonClass = `flex items-center justify-center gap-2 rounded-full bg-[#0050ff] px-4 py-2 text-xs font-black text-white shadow-[0_10px_24px_rgba(0,80,255,0.22)] hover:bg-[#0a5cff] active:bg-[#0045d8] ${pressClass}`;
const secondaryButtonClass = `flex items-center justify-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-3 py-2 text-xs font-black text-[#0050ff] hover:bg-blue-100 active:bg-blue-200 ${pressClass}`;
const miniButtonClass = `flex items-center justify-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-3 py-2 text-xs font-black text-[#0050ff] hover:bg-blue-100 active:bg-blue-200 ${pressClass}`;
const iconButtonClass = `flex items-center justify-center rounded-full border border-white/25 bg-white/15 text-white backdrop-blur hover:bg-white/25 active:bg-white/30 ${pressClass}`;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-black uppercase text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function HeroCard({ title, text, right, caption }: { title: string; text: string; right: string | number; caption: string }) {
  return (
    <div className="relative overflow-hidden rounded-[2rem] bg-[linear-gradient(115deg,#111827_0%,#123c8c_48%,#0050ff_100%)] p-5 text-white shadow-[0_18px_50px_rgba(0,80,255,0.18)]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(255,255,255,0.12),transparent_35%)]" />
      <div className="absolute inset-x-0 top-0 opacity-45">
        <WaveMark />
      </div>
      <Sparkle className="absolute right-10 bottom-8 h-4 w-4 text-white" />
      <Sparkle className="absolute left-8 top-8 h-3 w-3 text-white/80" />
      <Sparkle className="absolute right-24 top-6 h-3 w-3 text-white/70" />
      <div className="relative flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black tracking-tight">{title}</h2>
          {text && <p className="mt-2 max-w-[15rem] text-sm font-medium text-white/72">{text}</p>}
        </div>
        <div className="rounded-3xl border border-white/20 bg-white/15 px-4 py-3 text-center backdrop-blur">
          <div className="text-2xl font-black">{right}</div>
          <div className="text-[10px] font-bold uppercase text-white/70">{caption}</div>
        </div>
      </div>
    </div>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: React.ReactElement; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex h-16 flex-col items-center justify-center gap-1 rounded-3xl text-xs font-black ${pressClass} ${active ? 'bg-[#0050ff] text-white shadow-[0_10px_24px_rgba(0,80,255,0.24)] hover:bg-[#0a5cff] active:bg-[#0045d8]' : 'text-slate-500 hover:bg-blue-50 active:bg-blue-100'}`}>
      {React.cloneElement(icon, { className: 'h-5 w-5' })}
      {label}
    </button>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return (
    <div className={`grid gap-2 rounded-3xl bg-slate-100 p-1 ${options.length === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2'}`}>
      {options.map(([key, label]) => (
        <button key={key} type="button" onClick={() => onChange(key)} className={`rounded-2xl px-3 py-2 text-sm font-black ${pressClass} ${value === key ? 'bg-white text-[#0050ff] shadow-sm hover:bg-white' : 'text-slate-500 hover:bg-white/70 active:bg-white'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function TaskList({
  title,
  tasks,
  users,
  currentUser,
  actionLabel,
  onAction,
  onRelease,
}: {
  title: string;
  tasks: Task[];
  users: User[];
  currentUser: User;
  actionLabel: string;
  onAction: (taskId: string) => void;
  onRelease?: (taskId: string) => void;
}) {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <h2 className="px-1 font-black">{title}</h2>
      {tasks.length === 0 ? (
        <EmptyState text="Пока пусто" />
      ) : (
        tasks.map((task) => {
          const expanded = expandedTaskId === task.id;
          const creator = users.find((user) => user.id === task.creatorId);
          const executors = taskAssigneeIds(task).map((id) => users.find((user) => user.id === id)).filter(Boolean) as User[];
          const isMine = taskAssigneeIds(task).includes(currentUser.id);
          return (
          <div key={task.id} className={`rounded-3xl border border-blue-100 bg-white p-4 shadow-sm ${pressClass}`} onClick={() => setExpandedTaskId(expanded ? null : task.id)}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-black">{task.title}</h3>
                <p className="mt-1 text-sm text-slate-500">{task.description}</p>
              </div>
              {task.status !== 'completed' && (
                <button onClick={(event) => { event.stopPropagation(); onAction(task.id); }} className={`shrink-0 rounded-full bg-[#0050ff] px-3 py-2 text-xs font-black text-white hover:bg-[#0a5cff] active:bg-[#0045d8] ${pressClass}`}>
                  {actionLabel}
                </button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold text-slate-500">
              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[#0050ff]">
                {task.competency || 'Без блока'}
              </span>
              <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1">
                <Clock className="h-3 w-3" />
                {formatDateShort(task.deadline)}
              </span>
              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[#0050ff]">
                {task.workload === 'high' ? 'Высокая' : task.workload === 'medium' ? 'Средняя' : 'Низкая'}
              </span>
              {creator && <span className="rounded-full bg-slate-100 px-2.5 py-1">Автор: {creator.realName}</span>}
            </div>

            {expanded && (
              <div className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm text-slate-600" onClick={(event) => event.stopPropagation()}>
                {creator && <InfoRow label="Автор" value={creator.realName} href={telegramLink(creator.username)} />}
                <InfoRow label="Блок" value={task.competency || 'Без блока'} />
                <InfoRow label="Статус" value={task.status === 'open' ? 'Открытая' : task.status === 'completed' ? 'Готово' : 'В работе'} />
                <InfoRow label="Исполнители" value={executors.length ? executors.map((user) => user.realName).join(', ') : 'пока никто'} />
                <InfoRow label="Дата назначения" value={formatDateTimeShort(task.createdAt)} />
                {task.completedAt && <InfoRow label="Дата выполнения" value={formatDateTimeShort(task.completedAt)} />}
                <InfoRow label="Дедлайн" value={formatDateShort(task.deadline)} />
                <InfoRow label="Нагрузка" value={task.workload === 'high' ? 'Высокая' : task.workload === 'medium' ? 'Средняя' : 'Низкая'} />
                {task.sow && <p className="rounded-2xl bg-slate-50 p-3 text-xs text-slate-600">{task.sow}</p>}
                {task.tips?.length > 0 && (
                  <div className="space-y-1 text-xs text-slate-500">
                    {task.tips.map((tip, index) => (
                      <div key={index}>• {tip}</div>
                    ))}
                  </div>
                )}
                {isMine && task.status === 'assigned' && onRelease && (
                  <button onClick={() => onRelease(task.id)} className={`${miniButtonClass} border-amber-100 bg-amber-50 text-amber-700 hover:bg-amber-100`}>
                    Отказаться от задачи
                  </button>
                )}
              </div>
            )}
          </div>
        );
        })
      )}
    </div>
  );
}

function TaskLogView({ tasksByCompetency, users }: { tasksByCompetency: Record<string, Task[]>; users: User[] }) {
  const blockNames = Object.keys(tasksByCompetency).sort((a, b) => a.localeCompare(b, 'ru'));
  if (blockNames.length === 0) return <EmptyState text="В логе пока нет задач" />;

  return (
    <div className="mt-4 space-y-4">
      {blockNames.map((blockName) => (
        <div key={blockName} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-black">{blockName}</h3>
            <span className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-[#0050ff]">
              {tasksByCompetency[blockName].length}
            </span>
          </div>
          <div className="space-y-2">
            {tasksByCompetency[blockName]
              .slice()
              .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
              .map((task) => {
                const creator = users.find((user) => user.id === task.creatorId);
                const executors = taskAssigneeIds(task)
                  .map((id) => users.find((user) => user.id === id)?.realName)
                  .filter(Boolean)
                  .join(', ');
                return (
                  <div key={task.id} className="rounded-2xl bg-white p-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-black">{task.title}</div>
                        <div className="mt-1 text-xs text-slate-500">{task.description}</div>
                      </div>
                      <span className="shrink-0 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-black text-[#0050ff]">
                        {task.status === 'completed' ? 'Готово' : task.status === 'assigned' ? 'В работе' : 'Открытая'}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-slate-500 sm:grid-cols-2">
                      <span>Автор: <b>{creator?.realName || 'Не указан'}</b></span>
                      <span>Исполнитель: <b>{executors || 'Не назначен'}</b></span>
                      <span>Назначена: <b>{formatDateTimeShort(task.createdAt)}</b></span>
                      <span>Дедлайн: <b>{formatDateShort(task.deadline)}</b></span>
                      {task.completedAt && <span>Выполнена: <b>{formatDateTimeShort(task.completedAt)}</b></span>}
                    </div>
                    {task.sow && <div className="mt-2 rounded-xl bg-slate-50 p-2 text-xs text-slate-600">{task.sow}</div>}
                  </div>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}

function InfoRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-slate-400">{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="font-bold text-[#0050ff]">{value}</a>
      ) : (
        <span className="font-bold text-slate-700">{value}</span>
      )}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-3xl border border-dashed border-blue-100 bg-white/70 p-5 text-center text-sm font-bold text-slate-400">{text}</div>;
}

function WaveMark() {
  return (
    <svg className="h-36 w-full" viewBox="0 0 430 140" fill="none" aria-hidden="true" preserveAspectRatio="none">
      {[0, 10, 20, 30, 40, 50, 60].map((offset) => (
        <path key={offset} d={`M0 ${20 + offset} C 65 ${-12 + offset}, 112 ${56 + offset}, 178 ${26 + offset} C 238 ${-2 + offset}, 280 ${22 + offset}, 330 ${36 + offset} C 370 ${48 + offset}, 395 ${28 + offset}, 430 ${18 + offset}`} stroke="currentColor" strokeWidth="2" opacity="0.75" />
      ))}
    </svg>
  );
}
