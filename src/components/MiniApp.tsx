import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarDots,
  UsersThree,
  GraduationCap,
  Briefcase,
  Shield,
  Check,
  Plus,
  Minus,
  Trash,
  Clock,
  UserPlus,
  PencilSimple,
  X,
  DownloadSimple,
  Moon,
  Sun,
  MagnifyingGlass,
  UserCircle,
} from '@phosphor-icons/react';
import { Meeting, SimulationState, Task, User } from '../types';

/*
THESIS: MegaBattle is a compact operations surface, not a generic blue card dashboard.
OWN-WORLD: #0069E0, black and white, Druk/Raleway, official logo, wave and soft-star assets, pill controls, disciplined radii.
STORY: See current status, coordinate availability and meetings, then act on tasks and team responsibilities without leaving Telegram.
FIRST VIEWPORT: Branded compact header, current page and role context, then the active workflow; no marketing hero.
FORM: Operate. Brief-pinned direction; DESIGN_VARIANCE=4, MOTION_INTENSITY=4, VISUAL_DENSITY=7.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
*/

interface MiniAppProps {
  state: SimulationState;
  currentUser: User;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onSaveAvailability: (slots: Record<number, number[]>, weekStart: string, hardUnavailableDays?: number[]) => Promise<boolean>;
  onScheduleMeeting: (meetingData: any) => Promise<boolean>;
  onCreateTask: (taskData: any) => Promise<boolean>;
  onClaimTask: (taskId: string) => void;
  onCompleteTask: (taskId: string, timeSpentMinutes?: number) => Promise<boolean>;
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
const maxSlotWeeks = 5;
const telegramLink = (username: string) => `https://t.me/${username.replace('@', '')}`;
const taskAssigneeIds = (task: Task) => {
  if (!task.assignedTo) return [];
  return Array.isArray(task.assignedTo) ? task.assignedTo : [task.assignedTo];
};
const formatDateShort = (value?: string) => {
  if (!value) return '';
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(value)) return value;
  if (/^\d{2}\.\d{2}\.\d{2}$/.test(value)) return value;
  if (/^\d{2}\.\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}.${match[2]}.${match[1].slice(2)}`;
  return value;
};

const shortDateToInputDate = (value?: string) => {
  const normalized = formatDateShort(value);
  const match = normalized.match(/^(\d{2})\.(\d{2})(?:\.(\d{2}|\d{4}))?$/);
  if (!match) return '';
  const year = match[3]
    ? match[3].length === 4 ? match[3] : `20${match[3]}`
    : String(new Date().getFullYear());
  return `${year}-${match[2]}-${match[1]}`;
};

const inputDateToShortDate = (value: string, withYear = true, fullYear = false) => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  return withYear
    ? `${match[3]}.${match[2]}.${fullYear ? match[1] : match[1].slice(2)}`
    : `${match[3]}.${match[2]}`;
};

const ageFromBirthday = (value?: string) => {
  const match = String(value || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  const today = new Date();
  let age = today.getFullYear() - Number(match[3]);
  if (
    today.getMonth() + 1 < Number(match[2])
    || (today.getMonth() + 1 === Number(match[2]) && today.getDate() < Number(match[1]))
  ) age -= 1;
  return age;
};

const formatDateTimeShort = (value?: string) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDateShort(value);
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getFullYear()).slice(2)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const taskStatusText = (status: Task['status']) => {
  if (status === 'completed') return 'Выполнено';
  if (status === 'waiting') return 'Ждет';
  if (status === 'in_progress' || status === 'assigned') return 'В работе';
  return 'Открытая';
};

const taskPriorityText = (priority?: Task['priority']) => {
  if (priority === 'critical') return 'Очень важная';
  if (priority === 'important') return 'Важная';
  return 'Обычная';
};

const taskDurationText = (minutes?: number) => {
  if (!minutes) return '';
  const hoursPart = Math.floor(minutes / 60);
  const minutesPart = minutes % 60;
  return [hoursPart ? `${hoursPart} ч` : '', minutesPart ? `${minutesPart} мин` : ''].filter(Boolean).join(' ');
};

const mondayOfCurrentWeek = () => {
  const today = new Date();
  const day = today.getDay() === 0 ? 6 : today.getDay() - 1;
  const monday = new Date(today);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(today.getDate() - day);
  return monday;
};

const toIsoDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const currentWeekStart = () => toIsoDate(mondayOfCurrentWeek());

const dateForSlotDay = (absoluteDayIndex: number) => {
  const date = mondayOfCurrentWeek();
  date.setDate(date.getDate() + absoluteDayIndex);
  return date;
};

const formatDayMonth = (date: Date) => `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;
const weekdayShortByDate = (value?: string) => {
  const normalized = formatDateShort(value);
  const match = normalized.match(/^(\d{2})\.(\d{2})(?:\.(\d{2}|\d{4}))?$/);
  if (!match) return '';
  const year = match[3]
    ? Number(match[3].length === 4 ? match[3] : `20${match[3]}`)
    : new Date().getFullYear();
  const date = new Date(year, Number(match[2]) - 1, Number(match[1]));
  return dayLabels[date.getDay() === 0 ? 6 : date.getDay() - 1]?.short || '';
};

const alignedSlots = (availability?: { slots?: Record<number, number[]>; weekStart?: string }) => {
  const result: Record<number, number[]> = {};
  if (!availability?.slots) return result;
  const savedWeekStart = availability.weekStart || currentWeekStart();
  const weekOffset = Math.floor((new Date(currentWeekStart()).getTime() - new Date(savedWeekStart).getTime()) / (7 * 24 * 60 * 60 * 1000));
  Object.entries(availability.slots).forEach(([key, value]) => {
    const nextKey = Number(key) - weekOffset * 7;
    if (nextKey >= 0 && nextKey < maxSlotWeeks * 7) result[nextKey] = value;
  });
  return result;
};

const alignedUnavailableDays = (availability?: { hardUnavailableDays?: number[]; weekStart?: string }) => {
  if (!availability?.hardUnavailableDays) return [];
  const savedWeekStart = availability.weekStart || currentWeekStart();
  const weekOffset = Math.floor((new Date(currentWeekStart()).getTime() - new Date(savedWeekStart).getTime()) / (7 * 24 * 60 * 60 * 1000));
  return availability.hardUnavailableDays
    .map((day) => Number(day) - weekOffset * 7)
    .filter((day) => Number.isFinite(day) && day >= 0 && day < maxSlotWeeks * 7);
};

const meetingDateTime = (meeting: Pick<Meeting, 'date' | 'time'>) => {
  const normalized = formatDateShort(meeting.date);
  const dateMatch = normalized.match(/^(\d{2})\.(\d{2})(?:\.(\d{2}|\d{4}))?$/);
  const timeMatch = String(meeting.time || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!dateMatch) return Number.POSITIVE_INFINITY;
  const year = dateMatch[3]
    ? Number(dateMatch[3].length === 4 ? dateMatch[3] : `20${dateMatch[3]}`)
    : new Date().getFullYear();
  return new Date(
    year,
    Number(dateMatch[2]) - 1,
    Number(dateMatch[1]),
    Number(timeMatch?.[1] || 0),
    Number(timeMatch?.[2] || 0),
  ).getTime();
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
  const [visibleWeeks, setVisibleWeeks] = useState(1);
  const [suggestions, setSuggestions] = useState<MeetingSuggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [savingWeek, setSavingWeek] = useState(false);
  const [weekSaved, setWeekSaved] = useState(false);
  const [hasUnsavedSlots, setHasUnsavedSlots] = useState(false);
  const [slotError, setSlotError] = useState('');
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
  const [showAllTaskAssignees, setShowAllTaskAssignees] = useState(false);
  const [taskSow, setTaskSow] = useState('');
  const [taskPriority, setTaskPriority] = useState<Task['priority']>('normal');
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [completionHours, setCompletionHours] = useState('');
  const [completionMinutes, setCompletionMinutes] = useState('');
  const [savingCompletion, setSavingCompletion] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [showCompletedTasks, setShowCompletedTasks] = useState(false);
  const [showTaskLog, setShowTaskLog] = useState(false);
  const [showFullCalendar, setShowFullCalendar] = useState(false);
  const [expandedAvailabilityDay, setExpandedAvailabilityDay] = useState<number | null>(null);
  const [expandedUnavailableDay, setExpandedUnavailableDay] = useState<number | null>(null);
  const [showAllAvailabilityUsers, setShowAllAvailabilityUsers] = useState(false);
  const [showAllUnavailableUsers, setShowAllUnavailableUsers] = useState(false);
  const [showAllMeetingParticipants, setShowAllMeetingParticipants] = useState(false);
  const [showAllMeetings, setShowAllMeetings] = useState(false);
  const [darkTheme, setDarkTheme] = useState(() => {
    const savedTheme = window.localStorage.getItem('megabattle-theme');
    if (savedTheme) return savedTheme === 'dark';
    const telegramTheme = (window as any).Telegram?.WebApp?.colorScheme;
    if (telegramTheme) return telegramTheme === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  const [newUserRealName, setNewUserRealName] = useState('');
  const [newUserUsername, setNewUserUsername] = useState('');
  const [newUserRole, setNewUserRole] = useState<'admin' | 'organizer'>('organizer');
  const [newUserBirthday, setNewUserBirthday] = useState('');
  const [showAddUserForm, setShowAddUserForm] = useState(false);
  const [showAllTeamUsers, setShowAllTeamUsers] = useState(false);
  const [teamSearchOpen, setTeamSearchOpen] = useState(false);
  const [teamSearch, setTeamSearch] = useState('');
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [userDraft, setUserDraft] = useState({ realName: '', username: '', birthday: '', role: 'organizer' as User['role'], competencies: [] as string[], primaryCompetency: '' });
  const [newCompetency, setNewCompetency] = useState('');
  const [showAllCompetencies, setShowAllCompetencies] = useState(false);
  const [facultyUserDraft, setFacultyUserDraft] = useState({ realName: '', username: '', role: 'faculty_responsible' as User['role'], facultyId: '', competencies: [] as string[] });
  const [facultyTaskDraft, setFacultyTaskDraft] = useState({ facultyId: '', competency: '', title: '', description: '', deadline: '', assignedTo: [] as string[], reminders: [] as any[] });
  const [facultyTaskErrors, setFacultyTaskErrors] = useState<Record<string, boolean>>({});
  const [editingFacultyTaskId, setEditingFacultyTaskId] = useState<string | null>(null);
  const [newFacultyCompetency, setNewFacultyCompetency] = useState('');
  const [showAllFacultyCompetencies, setShowAllFacultyCompetencies] = useState(false);
  const [showFacultyPeople, setShowFacultyPeople] = useState(false);
  const [showAllFacultyTaskUsers, setShowAllFacultyTaskUsers] = useState(false);
  const [showAllFacultyTasks, setShowAllFacultyTasks] = useState(false);
  const [showAllFacultyBacklog, setShowAllFacultyBacklog] = useState(false);
  const [collapsedFacultyReminders, setCollapsedFacultyReminders] = useState<number[]>([]);
  const [editingFacultyUserId, setEditingFacultyUserId] = useState<string | null>(null);
  const [facultyEditDraft, setFacultyEditDraft] = useState({ realName: '', username: '', role: 'faculty_responsible' as User['role'], facultyId: '', competencies: [] as string[] });

  const isAdmin = currentUser.role === 'admin';
  const coreTeamUsers = state.users.filter((user) => user.role === 'admin' || user.role === 'organizer');
  const votedUsers = useMemo(
    () => state.users.filter((user) => {
      if (user.role !== 'admin' && user.role !== 'organizer') return false;
      const availability = state.availabilities[user.id];
      return Object.values(alignedSlots(availability)).some((day) => day.length > 0);
    }),
    [state.availabilities, state.users],
  );
  const majority = Math.floor(coreTeamUsers.length / 2) + 1;
  const firstWeekFilled = Array.from({ length: 7 }, (_, dayIndex) => (slots[dayIndex] || []).length > 0).some(Boolean);
  const myTasks = state.tasks.filter((task) => taskAssigneeIds(task).includes(currentUser.id) && task.status !== 'completed');
  const openTasks = state.tasks.filter((task) => task.status === 'open');
  const completedTasks = state.tasks
    .filter((task) => task.status === 'completed')
    .slice()
    .sort((a, b) => String(b.completedAt || b.createdAt || '').localeCompare(String(a.completedAt || a.createdAt || '')));
  const latestCompletedTasks = completedTasks.slice(0, 10);
  const scheduledMeetings = state.meetings.filter((meeting) => meeting.status === 'scheduled');
  const visibleScheduledMeetings = showAllMeetings ? scheduledMeetings : scheduledMeetings.slice(0, 3);
  const profileMeetings = scheduledMeetings
    .filter((meeting) => (
      (meeting.participants === 'all'
        || meeting.participants.includes(currentUser.id)
        || meeting.hostId === currentUser.id)
      && meetingDateTime(meeting) >= Date.now()
    ))
    .slice()
    .sort((a, b) => meetingDateTime(a) - meetingDateTime(b));
  const profileCompletedTasks = completedTasks.filter((task) => taskAssigneeIds(task).includes(currentUser.id));
  const profileAvailability = alignedSlots(state.availabilities[currentUser.id]);
  const profileAvailableHours = Array.from({ length: 7 }, (_, dayIndex) => profileAvailability[dayIndex] || [])
    .reduce((sum, dayHours) => sum + dayHours.length, 0);
  const profileUnavailableDays = new Set(alignedUnavailableDays(state.availabilities[currentUser.id]).filter((day) => day < 7));
  const profileSlotsCompleted = Array.from({ length: 7 }, (_, dayIndex) => (
    (profileAvailability[dayIndex] || []).length > 0 || profileUnavailableDays.has(dayIndex)
  )).every(Boolean);
  const profileAge = ageFromBirthday(currentUser.birthday);
  const facultyTasks = state.tasks.filter((task) => task.facultyId);
  const visibleFacultyTasks = showAllFacultyTasks ? facultyTasks : facultyTasks.slice(0, 3);
  const tasksByCompetency = state.tasks.reduce<Record<string, Task[]>>((acc, task) => {
    const key = task.competency || 'Без блока';
    if (!acc[key]) acc[key] = [];
    acc[key].push(task);
    return acc;
  }, {});
  const facultyTasksByCompetency = state.tasks
    .filter((task) => task.facultyId)
    .reduce<Record<string, Task[]>>((acc, task) => {
      const key = task.competency || 'Факультет';
      if (!acc[key]) acc[key] = [];
      acc[key].push(task);
      return acc;
    }, {});
  const teamUsers = isAdmin
    ? coreTeamUsers
    : [currentUser, ...coreTeamUsers.filter((user) => user.id !== currentUser.id)];
  const normalizedTeamSearch = teamSearch.trim().toLocaleLowerCase('ru');
  const filteredTeamUsers = normalizedTeamSearch
    ? teamUsers.filter((user) => `${user.realName} ${user.username}`.toLocaleLowerCase('ru').includes(normalizedTeamSearch))
    : teamUsers;
  const visibleTeamUsers = showAllTeamUsers || normalizedTeamSearch ? filteredTeamUsers : filteredTeamUsers.slice(0, 3);
  const calendarUsers = [currentUser, ...coreTeamUsers.filter((user) => user.id !== currentUser.id)];
  const visibleCalendarUsers = showFullCalendar ? calendarUsers : calendarUsers.slice(0, 3);
  const competencies = state.competencies || [];
  const visibleCompetencies = showAllCompetencies ? competencies : competencies.slice(0, 3);
  const faculties = state.faculties || [];
  const facultyCompetencies = state.facultyCompetencies || [];
  const visibleFacultyCompetencies = showAllFacultyCompetencies ? facultyCompetencies : facultyCompetencies.slice(0, 3);
  const facultyUsers = state.users.filter((user) => user.role === 'faculty_responsible' || user.role === 'faculty_helper');
  const visibleFacultyUserIds = new Set((showFacultyPeople ? facultyUsers : facultyUsers.slice(0, 3)).map((user) => user.id));
  const facultyTaskUsers = facultyUsers.filter((user) => facultyTaskDraft.facultyId === 'all' || user.facultyId === facultyTaskDraft.facultyId);
  const visibleFacultyTaskUsers = showAllFacultyTaskUsers ? facultyTaskUsers : facultyTaskUsers.slice(0, 3);
  const facultyTaskMatchedUsers = facultyTaskDraft.competency
    ? facultyTaskUsers.filter((user) => (
        facultyTaskDraft.competency === 'Ответственные'
          ? user.role === 'faculty_responsible'
          : user.competencies?.includes(facultyTaskDraft.competency)
      ))
    : facultyTaskUsers;

  const availabilityByDay = useMemo(
    () =>
      dayLabels.map((day, dayIndex) => ({
        ...day,
        users: coreTeamUsers
          .map((user) => ({
            ...user,
            daySlots: alignedSlots(state.availabilities[user.id])?.[dayIndex] || [],
          }))
          .filter((user) => user.daySlots.length > 0),
        unavailableUsers: coreTeamUsers.filter((user) => (alignedSlots(state.availabilities[user.id])?.[dayIndex] || []).length === 0),
        count: coreTeamUsers.filter((user) => {
          const daySlots = alignedSlots(state.availabilities[user.id])?.[dayIndex] || [];
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
    const rows = coreTeamUsers.map((user) => [
      user.realName,
      user.username,
      ...dayLabels.map((_, dayIndex) => formatHours(alignedSlots(state.availabilities[user.id])?.[dayIndex] || [])),
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
    const availability = state.availabilities[currentUser.id];
    const saved = alignedSlots(availability);
    const nextSlots: Record<number, number[]> = {};
    Array.from({ length: maxSlotWeeks * 7 }, (_, index) => {
      nextSlots[index] = [...(saved?.[index] || [])];
    });
    const lastFilledDay = Object.entries(nextSlots)
      .filter(([, value]) => value.length > 0)
      .map(([key]) => Number(key))
      .sort((a, b) => b - a)[0];
    setVisibleWeeks(Math.min(maxSlotWeeks, Math.max(1, lastFilledDay === undefined ? 1 : Math.floor(lastFilledDay / 7) + 1)));
    setSlots(nextSlots);
  }, [currentUser.id, state.availabilities]);

  const toggleSlot = (day: number, hour: number) => {
    setWeekSaved(false);
    setSlotError('');
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
    setSlotError('');
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
    setParticipants(coreTeamUsers.filter((user) => user.competencies?.includes(name)).map((user) => user.id));
    setShowAllMeetingParticipants(false);
  };

  const selectTaskCompetency = (name: string) => {
    setTaskCompetency(name);
    setTaskAssignedTo(
      name
        ? coreTeamUsers
            .filter((user) => user.primaryCompetency === name || user.competencies?.includes(name))
            .map((user) => user.id)
        : [],
    );
    setShowAllTaskAssignees(false);
  };

  const saveWeek = async () => {
    if (!firstWeekFilled) {
      setSlotError('Сначала отметь хотя бы один свободный час на первой неделе. Следующие недели можно заполнить дополнительно.');
      setHasUnsavedSlots(true);
      return;
    }
    setSlotError('');
    setSavingWeek(true);
    const ok = await onSaveAvailability(slots, currentWeekStart(), []);
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
    setShowAllMeetingParticipants(false);
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
    setShowAllTaskAssignees(false);
    setTaskSow('');
    setTaskPriority('normal');
  };

  const openTaskForm = () => {
    if (!showTaskForm) setTaskError('');
    setShowTaskForm((value) => !value);
  };

  const submitTask = async (event: React.FormEvent) => {
    event.preventDefault();
    setTaskError('');
    setSavingTask(true);
    const ok = await onCreateTask({
      title: taskTitle.trim() || 'Без названия',
      description: taskDesc.trim(),
      competency: taskCompetency.trim(),
      deadline: taskDeadline,
      assignedTo: taskAssignedTo,
      sow: taskSow,
      tips: [],
      priority: taskPriority,
      creatorId: currentUser.id,
    });
    setSavingTask(false);
    if (ok) {
      resetTaskForm();
      setShowTaskForm(false);
    }
  };

  const openCompletionPrompt = (taskId: string) => {
    setCompletingTaskId(taskId);
    setCompletionHours('');
    setCompletionMinutes('');
  };

  const closeCompletionPrompt = () => {
    if (savingCompletion) return;
    setCompletingTaskId(null);
    setCompletionHours('');
    setCompletionMinutes('');
  };

  const completeTaskWithTime = async (includeTime: boolean) => {
    if (!completingTaskId || savingCompletion) return;
    const hoursValue = Math.max(0, Number.parseInt(completionHours || '0', 10) || 0);
    const minutesValue = Math.max(0, Number.parseInt(completionMinutes || '0', 10) || 0);
    const totalMinutes = hoursValue * 60 + minutesValue;
    setSavingCompletion(true);
    const ok = await onCompleteTask(completingTaskId, includeTime && totalMinutes > 0 ? totalMinutes : undefined);
    setSavingCompletion(false);
    if (ok) closeCompletionPrompt();
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
      setNewUserBirthday('');
      setShowAddUserForm(false);
      onRefreshState();
    }
  };

  const startUserEdit = (user: User) => {
    setEditingUserId(user.id);
    setUserDraft({
      realName: user.realName,
      username: user.username,
      birthday: user.birthday || '',
      role: user.role,
      competencies: user.competencies || [],
      primaryCompetency: user.primaryCompetency || '',
    });
  };

  const updateUser = async (userId: string) => {
    const payload = isAdmin
      ? { requesterId: currentUser.id, userId, ...userDraft }
      : { requesterId: currentUser.id, userId, competencies: userDraft.competencies, primaryCompetency: userDraft.primaryCompetency };
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

  const addFacultyCompetency = async () => {
    if (!newFacultyCompetency.trim()) return;
    const res = await fetch('/api/faculty/competency/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id, name: newFacultyCompetency.trim() }),
    });
    if (res.ok) {
      setNewFacultyCompetency('');
      onRefreshState();
    }
  };

  const deleteFacultyCompetency = async (name: string) => {
    if (!window.confirm(`Удалить компетенцию факультетов "${name}"? Она пропадёт у всех ответственных.`)) return;
    const res = await fetch('/api/faculty/competency/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id, name }),
    });
    if (res.ok) onRefreshState();
  };

  const addFacultyUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isAdmin) return;
    const res = await fetch('/api/faculty/user/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id, ...facultyUserDraft }),
    });
    if (res.ok) {
      setFacultyUserDraft({ realName: '', username: '', role: 'faculty_responsible', facultyId: faculties[0]?.id || '', competencies: [] });
      onRefreshState();
    }
  };

  const deleteFacultyUser = async (userId: string) => {
    if (!isAdmin) return;
    const confirmed = window.confirm('Удалить ответственного факультета? Его активные задачи останутся в бэклоге без этого исполнителя.');
    if (!confirmed) return;
    const res = await fetch('/api/faculty/user/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id, userId }),
    });
    if (res.ok) onRefreshState();
  };

  const createFacultyTask = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextErrors = {
      facultyId: !facultyTaskDraft.facultyId,
      assignedTo: facultyTaskDraft.assignedTo.length === 0,
      title: !facultyTaskDraft.title.trim(),
      description: !facultyTaskDraft.description.trim(),
      deadline: !facultyTaskDraft.deadline.trim(),
    };
    setFacultyTaskErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    const res = await fetch(editingFacultyTaskId ? '/api/faculty/task/update' : '/api/faculty/task/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id, taskId: editingFacultyTaskId, ...facultyTaskDraft }),
    });
    if (res.ok) {
      setFacultyTaskDraft({ facultyId: faculties[0]?.id || '', competency: '', title: '', description: '', deadline: '', assignedTo: [], reminders: [] });
      setFacultyTaskErrors({});
      setCollapsedFacultyReminders([]);
      setEditingFacultyTaskId(null);
      onRefreshState();
    }
  };

  const startFacultyUserEdit = (user: User) => {
    setEditingFacultyUserId(user.id);
    setFacultyEditDraft({
      realName: user.realName,
      username: user.username,
      role: user.role,
      facultyId: user.facultyId || '',
      competencies: user.competencies || [],
    });
  };

  const updateFacultyUser = async (userId: string) => {
    if (!isAdmin) return;
    const res = await fetch('/api/faculty/user/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id, userId, ...facultyEditDraft }),
    });
    if (res.ok) {
      setEditingFacultyUserId(null);
      onRefreshState();
    }
  };

  const setFacultyTaskScope = (facultyId: string) => {
    setShowAllFacultyTaskUsers(false);
    setFacultyTaskErrors((prev) => ({ ...prev, facultyId: false, assignedTo: false }));
    setFacultyTaskDraft((prev) => {
      const scopedUsers = facultyUsers.filter((user) => facultyId === 'all' || user.facultyId === facultyId);
      const matched = prev.competency
        ? scopedUsers.filter((user) => (
            prev.competency === 'Ответственные'
              ? user.role === 'faculty_responsible'
              : user.competencies?.includes(prev.competency)
          )).map((user) => user.id)
        : scopedUsers.map((user) => user.id);
      return { ...prev, facultyId, assignedTo: matched };
    });
  };

  const setFacultyTaskCompetency = (competency: string) => {
    setShowAllFacultyTaskUsers(false);
    setFacultyTaskErrors((prev) => ({ ...prev, assignedTo: false }));
    setFacultyTaskDraft((prev) => {
      const scopedUsers = facultyUsers.filter((user) => prev.facultyId === 'all' || user.facultyId === prev.facultyId);
      const matched = competency
        ? scopedUsers.filter((user) => (
            competency === 'Ответственные'
              ? user.role === 'faculty_responsible'
              : user.competencies?.includes(competency)
          )).map((user) => user.id)
        : scopedUsers.map((user) => user.id);
      return { ...prev, competency, assignedTo: matched };
    });
  };

  const toggleDraftCompetency = (name: string) => {
    setUserDraft((prev) => ({
      ...prev,
      primaryCompetency: prev.primaryCompetency === name && prev.competencies.includes(name) ? '' : prev.primaryCompetency,
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
    faculties: 'Факультеты',
    profile: 'Профиль',
  }[activeTab] || 'Моя неделя';

  useEffect(() => {
    document.documentElement.classList.toggle('dark-theme', darkTheme);
    window.localStorage.setItem('megabattle-theme', darkTheme ? 'dark' : 'light');
    return () => document.documentElement.classList.remove('dark-theme');
  }, [darkTheme]);

  return (
    <div className={`mega-shell min-h-screen text-slate-950 ${darkTheme ? 'bg-[#07111f]' : 'bg-[#eef3fb]'}`}>
      <header className="mega-header sticky top-0 z-30 overflow-hidden text-white">
        <div className="relative px-4 pb-3 pt-[calc(env(safe-area-inset-top)+10px)]">
          <div className="flex items-center justify-between gap-3">
            <img className="mega-logo" src="/brand/megabattle-logo.svg" alt="ITMO MegaBattle" />
            <button
              type="button"
              onClick={() => setActiveTab('profile')}
              aria-label="Открыть профиль"
              aria-current={activeTab === 'profile' ? 'page' : undefined}
              className="mega-profile-trigger min-w-0 flex-1 text-left"
            >
              <p className="mega-context truncate">{currentUser.realName} · {isAdmin ? 'администратор' : 'организатор'}</p>
              <h1 className="mega-page-title truncate">{pageTitle}</h1>
            </button>
            <div className="flex items-center gap-2">
              <button onClick={() => setDarkTheme((value) => !value)} className={`${iconButtonClass} h-11 w-11`} title="Тема" aria-label={darkTheme ? 'Включить светлую тему' : 'Включить тёмную тему'}>
                {darkTheme ? <Sun className="h-5 w-5" weight="regular" /> : <Moon className="h-5 w-5" weight="regular" />}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('profile')}
                aria-current={activeTab === 'profile' ? 'page' : undefined}
                className={`${iconButtonClass} h-11 w-11`}
                title="Профиль"
                aria-label="Открыть профиль"
              >
                <UserCircle className="h-6 w-6" weight="fill" />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mega-main mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-24 pt-4">
        {activeTab === 'profile' && (
          <section className="space-y-4">
            <div className="rounded-3xl border border-blue-100 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[#0069E0] text-white">
                  <UserCircle className="h-8 w-8" weight="fill" />
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-black">{currentUser.realName}</h2>
                  <a href={telegramLink(currentUser.username)} target="_blank" rel="noreferrer" className="text-sm font-bold text-[#0069E0]">
                    {currentUser.username}
                  </a>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    {isAdmin ? 'Администратор' : 'Организатор'}
                    {currentUser.birthday ? ` · ${formatDateShort(currentUser.birthday)}` : ''}
                    {profileAge !== null ? ` · ${profileAge} лет` : ''}
                  </p>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 overflow-hidden rounded-2xl border border-blue-100 bg-slate-50 sm:grid-cols-4">
                {[
                  ['Активные задачи', myTasks.length],
                  ['Выполнено', profileCompletedTasks.length],
                  ['Встречи', profileMeetings.length],
                  ['Свободные часы', profileAvailableHours],
                ].map(([label, value], index) => (
                  <div key={String(label)} className={`p-3 ${index % 2 ? 'border-l border-blue-100' : ''} ${index > 1 ? 'border-t border-blue-100 sm:border-t-0 sm:border-l' : ''}`}>
                    <div className="text-xl font-black text-[#0069E0]">{value}</div>
                    <div className="mt-1 text-xs font-bold text-slate-500">{label}</div>
                  </div>
                ))}
              </div>

              <div className="mt-4 space-y-2 text-sm text-slate-600">
                <InfoRow label="Главный блок" value={currentUser.primaryCompetency || 'не выбран'} />
                <InfoRow label="Другие блоки" value={(currentUser.competencies || []).filter((item) => item !== currentUser.primaryCompetency).join(', ') || '—'} />
                <InfoRow label="Статус слотов" value={profileSlotsCompleted ? 'неделя заполнена' : 'нужно заполнить'} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button type="button" onClick={() => setActiveTab('slots')} className={secondaryButtonClass}>
                <CalendarDots className="h-4 w-4" />
                Слоты
              </button>
              <button type="button" onClick={() => setActiveTab('meetings')} className={secondaryButtonClass}>
                <UsersThree className="h-4 w-4" />
                Встречи
              </button>
              <button type="button" onClick={() => setActiveTab('tasks')} className={secondaryButtonClass}>
                <Briefcase className="h-4 w-4" />
                Задачи
              </button>
            </div>

            {profileMeetings[0] && (
              <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                <div className="text-xs font-black uppercase text-slate-400">Следующая встреча</div>
                <h3 className="mt-2 font-black">{profileMeetings[0].title}</h3>
                <p className="mt-1 text-sm font-semibold text-slate-500">
                  {formatDateShort(profileMeetings[0].date)} · {profileMeetings[0].time}
                </p>
              </div>
            )}

            {myTasks.length > 0 && (
              <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                <div className="text-xs font-black uppercase text-slate-400">В фокусе</div>
                <div className="mt-3 space-y-2">
                  {myTasks.slice(0, 3).map((task) => (
                    <div key={task.id} className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-3 py-2">
                      <span className="min-w-0 truncate text-sm font-black">{task.title}</span>
                      <span className="shrink-0 text-xs font-bold text-[#0069E0]">{formatDateShort(task.deadline) || 'без даты'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {activeTab === 'slots' && (
          <section className="space-y-4">
            {slotError && <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-800">{slotError}</div>}

            <div className="space-y-4">
              {Array.from({ length: visibleWeeks }, (_, weekIndex) => (
                <div key={weekIndex} className="space-y-3">
                  <div className="flex items-center justify-between px-1">
                    <div>
                      <h2 className="font-black">{weekIndex === 0 ? 'Эта неделя' : `Неделя ${weekIndex + 1}`}</h2>
                      <p className="text-xs font-semibold text-slate-500">
                        {formatDayMonth(dateForSlotDay(weekIndex * 7))} - {formatDayMonth(dateForSlotDay(weekIndex * 7 + 6))}
                      </p>
                    </div>
                    {weekIndex === visibleWeeks - 1 && weekIndex > 0 && (
                      <button
                        onClick={() => {
                          setSlots((prev) => {
                            const next = { ...prev };
                            for (let day = weekIndex * 7; day < weekIndex * 7 + 7; day += 1) next[day] = [];
                            return next;
                          });
                          setVisibleWeeks((value) => Math.max(1, value - 1));
                          setHasUnsavedSlots(true);
                        }}
                        className={secondaryButtonClass}
                      >
                        <Minus className="h-4 w-4" />
                        Скрыть неделю
                      </button>
                    )}
                  </div>

                  {dayLabels.map((day, dayIndex) => {
                    const absoluteDayIndex = weekIndex * 7 + dayIndex;
                    const selected = slots[absoluteDayIndex] || [];
                    const date = dateForSlotDay(absoluteDayIndex);
                    return (
                      <div key={`${weekIndex}-${day.full}`} className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <h2 className="text-base font-black">{day.full}, {formatDayMonth(date)}</h2>
                            <p className="text-xs text-slate-500">
                              {selected.length ? `${selected.length} ч. свободно` : 'Пока ничего не выбрано'}
                            </p>
                          </div>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <button onClick={() => selectWholeDay(absoluteDayIndex)} className={secondaryButtonClass}>
                              {selected.length === hours.length ? 'Снять' : 'Весь день'}
                            </button>
                          </div>
                        </div>
                        <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
                          {hours.map((hour) => {
                            const active = selected.includes(hour);
                            return (
                              <button
                                key={hour}
                                onClick={() => toggleSlot(absoluteDayIndex, hour)}
                                className={`h-11 rounded-2xl border text-sm font-black ${pressClass} ${
                                  active
                                    ? 'border-[#0069E0] bg-[#0069E0] text-white shadow-[0_8px_20px_rgba(0,105,224,0.2)] hover:bg-[#1677E8] active:bg-[#0058BD]'
                                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 active:bg-slate-100'
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
              ))}
            </div>

            {visibleWeeks < maxSlotWeeks && (
              <button
                onClick={() => setVisibleWeeks((value) => Math.min(maxSlotWeeks, value + 1))}
                className={secondaryButtonClass}
              >
                <Plus className="h-4 w-4" />
                Еще неделя
              </button>
            )}

            <button
              onClick={saveWeek}
              disabled={savingWeek || (!hasUnsavedSlots && weekSaved)}
              aria-busy={savingWeek}
              className={`${primaryButtonClass} mega-save-week z-20 py-4 text-base disabled:opacity-70`}
            >
              <Check className="h-5 w-5" />
              <span aria-live="polite">
                {savingWeek ? 'Сохраняю...' : weekSaved ? 'Неделя сохранена' : 'Сохранить неделю'}
              </span>
            </button>
          </section>
        )}

        {activeTab === 'meetings' && (
          <section className="space-y-4">
            <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
              <h2 className="font-black">Календарь свободных дней</h2>
              <div className="mt-3 grid grid-cols-7 gap-1.5">
                {availabilityByDay.map((day) => {
                  const ratio = coreTeamUsers.length ? day.count / coreTeamUsers.length : 0;
                  const expanded = expandedAvailabilityDay === dayLabels.findIndex((item) => item.short === day.short);
                  const dayIndex = dayLabels.findIndex((item) => item.short === day.short);
                  return (
                    <button
                      key={day.short}
                      type="button"
                      onClick={() => {
                        setExpandedAvailabilityDay((value) => (value === dayIndex ? null : dayIndex));
                        setExpandedUnavailableDay(null);
                        setShowAllAvailabilityUsers(false);
                        setShowAllUnavailableUsers(false);
                      }}
                      className={`rounded-2xl border p-2 text-center ${pressClass} ${expanded ? 'border-[#0069E0] bg-blue-50 shadow-[0_8px_22px_rgba(0,105,224,0.12)]' : 'border-blue-100 bg-slate-50 hover:bg-blue-50 active:bg-blue-100'}`}
                    >
                      <div className="text-xs font-black text-slate-500">{day.short}</div>
                      <div className="mt-2 text-lg font-black text-[#0069E0]">{day.count}</div>
                      <div className="text-xs font-bold text-slate-400">из {coreTeamUsers.length}</div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-blue-100">
                        <div className="h-full rounded-full bg-[#0069E0]" style={{ width: `${Math.round(ratio * 100)}%` }} />
                      </div>
                    </button>
                  );
                })}
              </div>
              {expandedAvailabilityDay !== null && availabilityByDay[expandedAvailabilityDay] && (
                <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50/50 p-3">
                  <div className="font-black">
                    {dayLabels[expandedAvailabilityDay].full}, {formatDayMonth(dateForSlotDay(expandedAvailabilityDay))}
                  </div>
                  {availabilityByDay[expandedAvailabilityDay].users.length > 3 && (
                    <ListDisclosure
                      expanded={showAllAvailabilityUsers}
                      onToggle={() => setShowAllAvailabilityUsers((value) => !value)}
                      total={availabilityByDay[expandedAvailabilityDay].users.length}
                      className="mt-3"
                    />
                  )}
                  <div className="mt-3 space-y-2">
                    {availabilityByDay[expandedAvailabilityDay].users.length === 0 ? (
                      <div className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-500">Никто не отметил свободное время.</div>
                    ) : (
                      (showAllAvailabilityUsers
                        ? availabilityByDay[expandedAvailabilityDay].users
                        : availabilityByDay[expandedAvailabilityDay].users.slice(0, 3)
                      ).map((user) => (
                        <div key={user.id} className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 text-sm">
                          <div>
                            <div className="font-black">{user.realName}</div>
                            <a href={telegramLink(user.username)} target="_blank" rel="noreferrer" className="text-xs font-bold text-[#0069E0]">{user.username}</a>
                          </div>
                          <div className="text-right font-black text-[#0069E0]">{formatHours(user.daySlots)}</div>
                        </div>
                      ))
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setExpandedUnavailableDay((value) => (value === expandedAvailabilityDay ? null : expandedAvailabilityDay));
                      setShowAllUnavailableUsers(false);
                    }}
                    className={`${secondaryButtonClass} mt-3 w-full`}
                  >
                    {expandedUnavailableDay === expandedAvailabilityDay ? 'Скрыть тех, кто не сможет' : `Не смогут (${availabilityByDay[expandedAvailabilityDay].unavailableUsers.length})`}
                  </button>
                  {expandedUnavailableDay === expandedAvailabilityDay && (
                    <div className="mt-3 grid grid-cols-1 gap-2">
                      {availabilityByDay[expandedAvailabilityDay].unavailableUsers.length > 3 && (
                        <ListDisclosure
                          expanded={showAllUnavailableUsers}
                          onToggle={() => setShowAllUnavailableUsers((value) => !value)}
                          total={availabilityByDay[expandedAvailabilityDay].unavailableUsers.length}
                        />
                      )}
                      {availabilityByDay[expandedAvailabilityDay].unavailableUsers.length === 0 ? (
                        <div className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-emerald-600">Все отметили свободное время.</div>
                      ) : (
                        (showAllUnavailableUsers
                          ? availabilityByDay[expandedAvailabilityDay].unavailableUsers
                          : availabilityByDay[expandedAvailabilityDay].unavailableUsers.slice(0, 3)
                        ).map((user) => (
                          <a key={user.id} href={telegramLink(user.username)} target="_blank" rel="noreferrer" className="rounded-xl bg-white px-3 py-2 text-sm font-bold text-slate-700">
                            {user.realName} <span className="text-[#0069E0]">{user.username}</span>
                          </a>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {isAdmin && (
              <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-black">Общий календарь</h2>
                    <p className="text-xs text-slate-500">Кто и когда свободен на неделе</p>
                  </div>
                  <button onClick={downloadAvailabilityCsv} className={miniButtonClass}>
                    <DownloadSimple className="h-4 w-4" />
                    Скачать
                  </button>
                </div>
                {calendarUsers.length > 3 && (
                  <ListDisclosure
                    expanded={showFullCalendar}
                    onToggle={() => setShowFullCalendar((value) => !value)}
                    total={calendarUsers.length}
                    className="mt-3"
                  />
                )}
                <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-100">
                  <table className="min-w-[720px] w-full border-collapse text-left text-xs">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 font-black">Участник</th>
                        {dayLabels.map((day, dayIndex) => (
                          <th key={day.short} className="px-3 py-2 text-center font-black">{day.short} {formatDayMonth(dateForSlotDay(dayIndex))}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleCalendarUsers.map((user) => (
                        <tr key={user.id} className="border-t border-slate-100">
                          <td className="sticky left-0 z-10 bg-white px-3 py-2">
                            <div className="font-black">{user.realName}</div>
                            <div className="font-bold text-[#0069E0]">{user.username}</div>
                          </td>
                          {dayLabels.map((_, dayIndex) => {
                            const text = formatHours(alignedSlots(state.availabilities[user.id])?.[dayIndex] || []);
                            const filled = text !== '—';
                            return (
                              <td key={dayIndex} className="px-2 py-2 align-top">
                                <div className={`min-h-10 rounded-xl px-2 py-1.5 text-center font-bold ${filled ? 'bg-blue-50 text-[#0069E0]' : 'bg-slate-50 text-[#718293]'}`}>
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
                <button onClick={findSuggestions} disabled={suggesting} className={`mega-primary-button rounded-full bg-[#0069E0] px-5 py-2.5 text-xs font-black text-white shadow-[0_10px_24px_rgba(0,105,224,0.28)] hover:bg-[#1677E8] active:bg-[#0058BD] ${pressClass} disabled:opacity-70`}>
                  {suggesting ? 'Считаю...' : 'Найти'}
                </button>
              </div>
              <div className="mt-4 space-y-3">
                {suggestions.length === 0 ? (
                  <EmptyState text="Нажми «Найти», когда команда заполнит слоты." />
                ) : (
                  suggestions.map((suggestion, index) => (
                    <div key={`${suggestion.dayIndex}-${suggestion.hour}-${suggestion.endHour || ''}`} className="overflow-hidden rounded-2xl border border-blue-100 bg-blue-50/60">
                      <button onClick={() => applySuggestion(suggestion)} className={`w-full p-3 text-left hover:bg-blue-100 active:bg-blue-200 ${pressClass}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-black">
                          {index + 1}. {dayLabels[suggestion.dayIndex]?.full}, {suggestion.hour}:00-{suggestion.endHour || suggestion.hour + (suggestion.duration || 1)}:00
                        </div>
                        <div className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-[#0069E0]">
                          {suggestion.count}/{suggestion.total}
                        </div>
                      </div>
                      <div className="mt-1 text-xs font-semibold text-slate-500">
                        Окно: {suggestion.duration || 1} ч. подряд
                      </div>
                      </button>
                      <CompactUserLinks users={suggestion.missingUsers} />
                    </div>
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
              <Segmented
                value={meetingType}
                onChange={(value) => {
                  const nextType = value as 'general' | 'custom' | 'competency';
                  setMeetingType(nextType);
                  setShowAllMeetingParticipants(false);
                  if (nextType === 'general') setParticipants([]);
                  if (nextType === 'custom') {
                    setMeetingCompetency('');
                    setParticipants([]);
                  }
                }}
                options={[["general", "Вся команда"], ["custom", "Выбрать людей"], ["competency", "Выбрать блок"]]}
              />
              <Field label="Название">
                <input value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} className={inputClass} />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Дата">
                  <DatePickerField value={meetingDate} onChange={setMeetingDate} placeholder="Выбери дату" />
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
                  <select value={meetingCompetency} onChange={(e) => selectMeetingCompetency(e.target.value)} className={selectClass}>
                    <option value="">Выбери блок</option>
                    {competencies.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </Field>
              )}
              {(meetingType === 'custom' || meetingType === 'competency') && (
                <div className="grid grid-cols-1 gap-2">
                  {coreTeamUsers.length > 3 && (
                    <ListDisclosure
                      expanded={showAllMeetingParticipants}
                      onToggle={() => setShowAllMeetingParticipants((value) => !value)}
                      total={coreTeamUsers.length}
                    />
                  )}
                  {(showAllMeetingParticipants ? coreTeamUsers : coreTeamUsers.slice(0, 3)).map((user) => (
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
              <div className="flex items-center justify-between gap-3 px-1">
                <h2 className="font-black">Ближайшие встречи</h2>
                {scheduledMeetings.length > 3 && (
                  <ListDisclosure
                    expanded={showAllMeetings}
                    onToggle={() => setShowAllMeetings((value) => !value)}
                    total={scheduledMeetings.length}
                  />
                )}
              </div>
              {scheduledMeetings.length === 0 ? (
                <EmptyState text="Встреч пока нет" />
              ) : (
                visibleScheduledMeetings.map((meeting) => {
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
                        <div className="rounded-2xl bg-blue-50 px-3 py-2 text-right text-xs font-black text-[#0069E0]">
                          {weekdayShortByDate(meeting.date)}
                          <br />
                          {formatDateShort(meeting.date)}
                          <br />
                          {meeting.time}
                        </div>
                      </div>

                      {expanded && (
                        <div className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm text-slate-600" onClick={(event) => event.stopPropagation()}>
                          <InfoRow label="Автор" value={host?.realName || 'Организатор'} />
                          {host?.username && <InfoRow label="Telegram" value={host.username} href={telegramLink(host.username)} />}
                          <InfoRow label="Дата" value={`${weekdayShortByDate(meeting.date)} ${formatDateShort(meeting.date)}`} />
                          <InfoRow label="Время" value={meeting.time} />
                          <InfoRow label="Тип" value={meeting.type === 'general' ? 'Вся команда' : 'Выбранные люди'} />
                          {meeting.competency && <InfoRow label="Блок" value={meeting.competency} />}
                          <InfoRow label="Тема" value={meeting.topic || 'Без темы'} />
                          {meeting.description && <InfoRow label="Описание" value={meeting.description} />}
                          {canManage && (
                            <div className="flex gap-2 pt-2">
                              <button onClick={() => startMeetingEdit(meeting)} className={miniButtonClass}>
                                <PencilSimple className="h-4 w-4" />
                                Редактировать
                              </button>
                              <button onClick={() => deleteMeeting(meeting.id)} className={`${miniButtonClass} border-rose-100 bg-rose-50 text-rose-600 hover:bg-rose-100 active:bg-rose-200`}>
                                <Trash className="h-4 w-4" />
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
                  <select value={taskCompetency} onChange={(e) => selectTaskCompetency(e.target.value)} className={selectClass}>
                    <option value="">Выбери блок задачи</option>
                    {competencies.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                    {competencies.length === 0 && <option value="Общее">Общее</option>}
                  </select>
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Дедлайн">
                    <DatePickerField value={taskDeadline} onChange={setTaskDeadline} placeholder="Дата не выбрана" />
                  </Field>
                  <Field label="Приоритет">
                    <select value={taskPriority} onChange={(e) => setTaskPriority(e.target.value as Task['priority'])} className={selectClass}>
                      <option value="normal">Обычная</option>
                      <option value="important">Важная</option>
                      <option value="critical">Очень важная</option>
                    </select>
                  </Field>
                </div>
                <Field label="Исполнитель">
                  <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-2">
                    <div className="px-1 text-xs font-bold text-slate-500">Никого не выбирай, если задача открытая.</div>
                    <button
                      type="button"
                      onClick={() => setTaskAssignedTo(taskAssignedTo.length === coreTeamUsers.length ? [] : coreTeamUsers.map((user) => user.id))}
                      className={`${secondaryButtonClass} w-full`}
                    >
                      <UsersThree className="h-4 w-4" />
                      {taskAssignedTo.length === coreTeamUsers.length ? 'Снять выбор со всей команды' : 'Назначить всей команде'}
                    </button>
                    {coreTeamUsers.length > 3 && (
                      <ListDisclosure
                        expanded={showAllTaskAssignees}
                        onToggle={() => setShowAllTaskAssignees((value) => !value)}
                        total={coreTeamUsers.length}
                      />
                    )}
                    {(showAllTaskAssignees ? coreTeamUsers : coreTeamUsers.slice(0, 3)).map((user) => (
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
                <button disabled={savingTask} className={`${primaryButtonClass} disabled:opacity-70`}>
                  {savingTask ? 'Сохраняю...' : 'Сохранить задачу'}
                </button>
              </form>
            )}
            {taskError && <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-800">{taskError}</div>}
            <TaskList title="Мои задачи" tasks={myTasks} users={state.users} currentUser={currentUser} actionLabel="Готово" onAction={openCompletionPrompt} onRelease={onReleaseTask} />
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
                    <DownloadSimple className="h-4 w-4" />
                    Excel
                  </a>
                  {isAdmin && (
                    <button onClick={clearTaskLog} className={`${miniButtonClass} border-rose-100 bg-rose-50 text-rose-600 hover:bg-rose-100 active:bg-rose-200`}>
                      <Trash className="h-4 w-4" />
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
            {isAdmin && (
              <button onClick={() => setShowAddUserForm((value) => !value)} className={primaryButtonClass}>
                {showAddUserForm ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                Добавить человека
              </button>
            )}

            {isAdmin && showAddUserForm && (
              <form onSubmit={addUser} className="space-y-3 rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                <h2 className="flex items-center gap-2 font-black">
                  <UserPlus className="h-4 w-4 text-[#0069E0]" />
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
                    <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as any)} className={selectClass}>
                      <option value="organizer">Организатор</option>
                      <option value="admin">Админ</option>
                    </select>
                  </Field>
                  <Field label="ДР">
                    <DatePickerField value={newUserBirthday} onChange={setNewUserBirthday} placeholder="Выбери дату" fullYear />
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
                {competencies.length > 3 && (
                  <ListDisclosure
                    expanded={showAllCompetencies}
                    onToggle={() => setShowAllCompetencies((value) => !value)}
                    total={competencies.length}
                    className="mt-3"
                  />
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {competencies.length === 0 ? (
                    <span className="text-sm font-bold text-slate-400">Пока нет блоков</span>
                  ) : (
                    visibleCompetencies.map((name) => (
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
              <div className="flex items-center justify-between gap-2 px-1">
                <div className={`flex min-w-0 items-center gap-2 transition-all ${teamSearchOpen ? 'flex-1' : ''}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setTeamSearchOpen((value) => !value);
                      if (teamSearchOpen) setTeamSearch('');
                    }}
                    className={miniButtonClass}
                    aria-label={teamSearchOpen ? 'Закрыть поиск' : 'Найти участника'}
                  >
                    {teamSearchOpen ? <X className="h-4 w-4" /> : <MagnifyingGlass className="h-4 w-4" />}
                  </button>
                  {teamSearchOpen && (
                    <input
                      autoFocus
                      type="search"
                      value={teamSearch}
                      onChange={(event) => setTeamSearch(event.target.value)}
                      className={`${inputClass} min-w-0 flex-1`}
                      placeholder="Имя, фамилия или @username"
                      aria-label="Поиск участника"
                    />
                  )}
                </div>
                {!normalizedTeamSearch && filteredTeamUsers.length > 3 && (
                  <ListDisclosure
                    expanded={showAllTeamUsers}
                    onToggle={() => setShowAllTeamUsers((value) => !value)}
                    total={filteredTeamUsers.length}
                  />
                )}
              </div>
              {state.users.length === 0 ? (
                <EmptyState text="Пока в команде никого нет" />
              ) : visibleTeamUsers.length === 0 ? (
                <EmptyState text="Никого не найдено" />
              ) : (
                visibleTeamUsers.map((user) => {
                  const expanded = expandedUserId === user.id;
                  const editing = editingUserId === user.id;
                  return (
                    <div key={user.id} className={`rounded-3xl border border-blue-100 bg-white p-4 shadow-sm ${pressClass}`} onClick={() => setExpandedUserId(expanded ? null : user.id)}>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-black">{user.realName}</div>
                          <a href={telegramLink(user.username)} target="_blank" rel="noreferrer" className="text-sm font-bold text-[#0069E0]" onClick={(event) => event.stopPropagation()}>
                            {user.username}
                          </a>
                        </div>
                        <div className="text-right">
                          <div className="rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-[#0069E0]">{user.primaryCompetency || 'Блок не выбран'}</div>
                          <div className={`mt-1 rounded-full px-2.5 py-1 text-xs font-black ${user.registered ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>
                            {user.registered ? 'В боте' : 'Не в боте'}
                          </div>
                          <div className="mt-1 text-xs text-slate-500">{formatDateShort(user.birthday) || 'Дата не указана'}</div>
                        </div>
                      </div>

                      {expanded && (
                        <div className="mt-4 border-t border-slate-100 pt-4" onClick={(event) => event.stopPropagation()}>
                          {!editing ? (
                            <div className="space-y-2 text-sm text-slate-600">
                              <InfoRow label="Имя" value={user.realName} />
                              <InfoRow label="Telegram" value={user.username} href={telegramLink(user.username)} />
                              <InfoRow label="Дата рождения" value={formatDateShort(user.birthday) || 'не указана'} />
                              <InfoRow label="Регистрация" value={user.registered ? 'зарегистрирован в боте' : 'ещё не заходил в бот'} />
                              <InfoRow label="В команде с" value={formatDateTimeShort(user.joinedAt) || 'дата не сохранена'} />
                              <InfoRow label="Последняя активность" value={formatDateTimeShort(user.lastSeenAt) || 'ещё не заходил'} />
                              <InfoRow label="Главный блок" value={user.primaryCompetency || 'не выбран'} />
                              <InfoRow label="Блоки" value={(user.competencies || []).join(', ') || 'не выбраны'} />
                              {(isAdmin || user.id === currentUser.id) && (
                                <div className="flex gap-2 pt-2">
                                  <button onClick={() => startUserEdit(user)} className={miniButtonClass}>
                                    <PencilSimple className="h-4 w-4" />
                                    Редактировать
                                  </button>
                                  {isAdmin && (
                                    <button onClick={() => deleteUser(user.id)} disabled={user.id === currentUser.id} className={`${miniButtonClass} ml-auto border-rose-100 bg-rose-50 text-rose-600 disabled:opacity-40`}>
                                      <Trash className="h-4 w-4" />
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
                                  <DatePickerField value={userDraft.birthday} onChange={(value) => setUserDraft((prev) => ({ ...prev, birthday: value }))} placeholder="Выбери дату" fullYear />
                                </Field>
                                {isAdmin && (
                                  <Field label="Роль">
                                    <select value={userDraft.role} onChange={(e) => setUserDraft((prev) => ({ ...prev, role: e.target.value as User['role'] }))} className={selectClass}>
                                      <option value="organizer">Организатор</option>
                                      <option value="admin">Админ</option>
                                    </select>
                                  </Field>
                                )}
                              </div>
                              <Field label="Главный блок">
                                <div className="grid grid-cols-1 gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-2">
                                  {competencies.length === 0 ? (
                                    <div className="text-xs font-bold text-slate-400">Админ ещё не добавил блоки</div>
                                  ) : (
                                    competencies.map((name) => (
                                      <label key={name} className="flex items-center justify-between rounded-xl bg-white px-3 py-2 text-sm font-semibold">
                                        <span>{name}</span>
                                        <input
                                          type="radio"
                                          name={`primary-${user.id}`}
                                          checked={userDraft.primaryCompetency === name}
                                          onChange={() => setUserDraft((prev) => ({
                                            ...prev,
                                            primaryCompetency: name,
                                            competencies: prev.competencies.includes(name) ? prev.competencies : [name, ...prev.competencies],
                                          }))}
                                        />
                                      </label>
                                    ))
                                  )}
                                </div>
                              </Field>
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

        {activeTab === 'faculties' && (
          <section className="space-y-4">
            {!isAdmin ? (
              <EmptyState text="Раздел доступен админу" />
            ) : (
              <>
                <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="font-black">Компетенции факультетов</h2>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <input value={newFacultyCompetency} onChange={(e) => setNewFacultyCompetency(e.target.value)} className={inputClass} placeholder="Звук, экраны, свет" />
                    <button type="button" onClick={addFacultyCompetency} className={miniButtonClass}>
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                  {facultyCompetencies.length > 3 && (
                    <ListDisclosure
                      expanded={showAllFacultyCompetencies}
                      onToggle={() => setShowAllFacultyCompetencies((value) => !value)}
                      total={facultyCompetencies.length}
                      className="mt-3"
                    />
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {facultyCompetencies.length === 0 ? (
                      <span className="text-sm font-bold text-slate-400">Пока нет компетенций</span>
                    ) : visibleFacultyCompetencies.map((name) => (
                      <span key={name} className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1.5 text-sm font-black text-[#0069E0]">
                        {name}
                        <button type="button" onClick={() => deleteFacultyCompetency(name)} className="rounded-full p-0.5 text-[#0069E0] transition hover:bg-blue-100 active:scale-95">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>

                <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                  <h2 className="font-black">Добавить человека</h2>
                  <form onSubmit={addFacultyUser} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Факультет">
                      <select value={facultyUserDraft.facultyId} onChange={(e) => setFacultyUserDraft((prev) => ({ ...prev, facultyId: e.target.value }))} className={selectClass}>
                        <option value="">Выбери факультет</option>
                        {faculties.map((faculty) => <option key={faculty.id} value={faculty.id}>{faculty.name}</option>)}
                      </select>
                    </Field>
                    <Field label="Роль">
                      <select
                        value={facultyUserDraft.role === 'faculty_responsible' ? 'faculty_responsible' : facultyUserDraft.competencies[0] || ''}
                        onChange={(e) => setFacultyUserDraft((prev) => (
                          e.target.value === 'faculty_responsible'
                            ? { ...prev, role: 'faculty_responsible', competencies: [] }
                            : { ...prev, role: 'faculty_helper', competencies: e.target.value ? [e.target.value] : [] }
                        ))}
                        className={selectClass}
                      >
                        <option value="faculty_responsible">Ответственный</option>
                        {facultyCompetencies.map((name) => <option key={name} value={name}>{name}</option>)}
                      </select>
                    </Field>
                    <Field label="Имя">
                      <input value={facultyUserDraft.realName} onChange={(e) => setFacultyUserDraft((prev) => ({ ...prev, realName: e.target.value }))} className={inputClass} />
                    </Field>
                    <Field label="Telegram">
                      <input value={facultyUserDraft.username} onChange={(e) => setFacultyUserDraft((prev) => ({ ...prev, username: e.target.value }))} className={inputClass} placeholder="@username" />
                    </Field>
                    <button className={`${primaryButtonClass} sm:col-span-2`}>Добавить</button>
                  </form>
                </div>

                <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                  <button type="button" onClick={() => setShowFacultyPeople((value) => !value)} className="flex w-full items-center justify-between gap-3 text-left">
                    <span className="font-black">Составы ответственных</span>
                    {facultyUsers.length > 3 && (
                      <span className={`${miniButtonClass} w-auto`}>
                        {showFacultyPeople ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                        {showFacultyPeople ? 'Свернуть' : `Показать всех (${facultyUsers.length})`}
                      </span>
                    )}
                  </button>
                  <div className="mt-4 space-y-3">
                    {faculties.map((faculty) => {
                      const allPeople = facultyUsers.filter((user) => user.facultyId === faculty.id);
                      const people = allPeople.filter((user) => visibleFacultyUserIds.has(user.id));
                      if (!showFacultyPeople && allPeople.length > 0 && people.length === 0) return null;
                      return (
                        <div key={faculty.id} className="rounded-2xl bg-slate-50 p-3">
                          <div className="font-black">{faculty.name}</div>
                          <div className="mt-2 space-y-2">
                            {people.length === 0 ? (
                              <div className="text-sm font-bold text-slate-400">Пока никого нет</div>
                            ) : people.map((user) => {
                              const editing = editingFacultyUserId === user.id;
                              return (
                                <div key={user.id} className="rounded-xl bg-white px-3 py-2 text-sm">
                                  {!editing ? (
                                    <>
                                      <div className="flex items-start justify-between gap-3">
                                        <div>
                                          <div className="font-black">{user.realName}</div>
                                          <a href={telegramLink(user.username)} target="_blank" rel="noreferrer" className="font-bold text-[#0069E0]">{user.username}</a>
                                          <div className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-black ${user.registered ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>
                                            {user.registered ? 'Зарегистрирован' : 'Не зарегистрирован'}
                                          </div>
                                        </div>
                                        <div className="flex flex-wrap justify-end gap-2">
                                          <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-black text-[#0069E0]">{user.role === 'faculty_helper' ? user.competencies?.[0] || 'Роль не выбрана' : 'Ответственный'}</span>
                                          <button onClick={() => startFacultyUserEdit(user)} className={miniButtonClass}>
                                            <PencilSimple className="h-4 w-4" />
                                            Редактировать
                                          </button>
                                          <button onClick={() => deleteFacultyUser(user.id)} className={`${miniButtonClass} border-rose-100 bg-rose-50 text-rose-600`}>
                                            <Trash className="h-4 w-4" />
                                          </button>
                                        </div>
                                      </div>
                                      {user.competencies?.length ? (
                                        <div className="mt-2 flex flex-wrap gap-1">
                                          {user.competencies.map((name) => (
                                            <span key={name} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-500">{name}</span>
                                          ))}
                                        </div>
                                      ) : null}
                                    </>
                                  ) : (
                                    <div className="space-y-3">
                                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        <Field label="Имя">
                                          <input value={facultyEditDraft.realName} onChange={(e) => setFacultyEditDraft((prev) => ({ ...prev, realName: e.target.value }))} className={inputClass} />
                                        </Field>
                                        <Field label="Telegram">
                                          <input value={facultyEditDraft.username} onChange={(e) => setFacultyEditDraft((prev) => ({ ...prev, username: e.target.value }))} className={inputClass} />
                                        </Field>
                                        <Field label="Факультет">
                                          <select value={facultyEditDraft.facultyId} onChange={(e) => setFacultyEditDraft((prev) => ({ ...prev, facultyId: e.target.value }))} className={selectClass}>
                                            {faculties.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                                          </select>
                                        </Field>
                                        <Field label="Роль">
                                          <select
                                            value={facultyEditDraft.role === 'faculty_responsible' ? 'faculty_responsible' : facultyEditDraft.competencies[0] || ''}
                                            onChange={(e) => setFacultyEditDraft((prev) => (
                                              e.target.value === 'faculty_responsible'
                                                ? { ...prev, role: 'faculty_responsible', competencies: [] }
                                                : { ...prev, role: 'faculty_helper', competencies: e.target.value ? [e.target.value] : [] }
                                            ))}
                                            className={selectClass}
                                          >
                                            <option value="faculty_responsible">Ответственный</option>
                                            {facultyCompetencies.map((name) => <option key={name} value={name}>{name}</option>)}
                                          </select>
                                        </Field>
                                      </div>
                                      <div className="flex gap-2">
                                        <button onClick={() => updateFacultyUser(user.id)} className={miniButtonClass}>OK</button>
                                        <button onClick={() => setEditingFacultyUserId(null)} className={miniButtonClass}>Отмена</button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <form onSubmit={createFacultyTask} className="space-y-3 rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                  <h2 className="font-black">{editingFacultyTaskId ? 'Редактировать задачу' : 'Задача факультету'}</h2>
                  <Field label="Факультет">
                    <select value={facultyTaskDraft.facultyId} onChange={(e) => setFacultyTaskScope(e.target.value)} className={`${selectClass} ${facultyTaskErrors.facultyId ? 'border-rose-300 bg-rose-50 focus:border-rose-500 focus:shadow-[0_0_0_4px_rgba(244,63,94,0.12)]' : ''}`}>
                      <option value="">Выбери факультет</option>
                      <option value="all">Все факультеты</option>
                      {faculties.map((faculty) => <option key={faculty.id} value={faculty.id}>{faculty.name}</option>)}
                    </select>
                    {facultyTaskErrors.facultyId && <RequiredHint />}
                  </Field>
                  <Field label="Исполнители">
                    <div className="space-y-2">
                      <select value={facultyTaskDraft.competency} onChange={(e) => setFacultyTaskCompetency(e.target.value)} className={selectClass}>
                        <option value="">Все люди выбранного факультета</option>
                        <option value="Ответственные">Ответственные</option>
                        {facultyCompetencies.map((name) => <option key={name} value={name}>{name}</option>)}
                      </select>
                      {facultyTaskUsers.length > 3 && (
                        <ListDisclosure
                          expanded={showAllFacultyTaskUsers}
                          onToggle={() => setShowAllFacultyTaskUsers((value) => !value)}
                          total={facultyTaskUsers.length}
                        />
                      )}
                      {visibleFacultyTaskUsers.map((user) => (
                        <label key={user.id} className={`flex items-center justify-between rounded-xl px-3 py-2 text-sm font-semibold ${facultyTaskDraft.competency && facultyTaskMatchedUsers.some((item) => item.id === user.id) ? 'bg-blue-50 text-[#0069E0]' : 'bg-white'} ${facultyTaskErrors.assignedTo ? 'ring-2 ring-rose-200' : ''}`}>
                          <span>
                            {user.realName}
                            {user.competencies?.length ? <span className="ml-2 text-xs text-slate-400">{user.competencies.join(', ')}</span> : null}
                          </span>
                          <input type="checkbox" checked={facultyTaskDraft.assignedTo.includes(user.id)} onChange={() => { setFacultyTaskErrors((prev) => ({ ...prev, assignedTo: false })); setFacultyTaskDraft((prev) => ({ ...prev, assignedTo: prev.assignedTo.includes(user.id) ? prev.assignedTo.filter((id) => id !== user.id) : [...prev.assignedTo, user.id] })); }} />
                        </label>
                      ))}
                      {facultyTaskErrors.assignedTo && <RequiredHint text="Выбери хотя бы одного исполнителя" />}
                    </div>
                  </Field>
                  <Field label="Название">
                    <input value={facultyTaskDraft.title} onChange={(e) => { setFacultyTaskErrors((prev) => ({ ...prev, title: false })); setFacultyTaskDraft((prev) => ({ ...prev, title: e.target.value })); }} className={`${inputClass} ${facultyTaskErrors.title ? 'border-rose-300 bg-rose-50 focus:border-rose-500' : ''}`} />
                    {facultyTaskErrors.title && <RequiredHint />}
                  </Field>
                  <Field label="Описание">
                    <textarea value={facultyTaskDraft.description} onChange={(e) => { setFacultyTaskErrors((prev) => ({ ...prev, description: false })); setFacultyTaskDraft((prev) => ({ ...prev, description: e.target.value })); }} className={`${inputClass} ${facultyTaskErrors.description ? 'border-rose-300 bg-rose-50 focus:border-rose-500' : ''}`} rows={3} />
                    {facultyTaskErrors.description && <RequiredHint />}
                  </Field>
                  <Field label="Дедлайн">
                    <DatePickerField value={facultyTaskDraft.deadline} onChange={(value) => { setFacultyTaskErrors((prev) => ({ ...prev, deadline: false })); setFacultyTaskDraft((prev) => ({ ...prev, deadline: value })); }} placeholder="Выбери дату" error={facultyTaskErrors.deadline} />
                    {facultyTaskErrors.deadline && <RequiredHint />}
                  </Field>
                  <Field label="Напоминания">
                    <div className="space-y-2">
                      {facultyTaskDraft.reminders.map((reminder, index) => (
                        <div key={index} className="rounded-2xl border border-blue-100 bg-white p-3 shadow-sm">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div className="text-xs font-black uppercase text-slate-400">
                              {['Первое напоминание', 'Второе напоминание', 'Третье напоминание'][index] || 'Напоминание'}
                            </div>
                            {index > 0 && (
                              <button
                                type="button"
                                onClick={() => setCollapsedFacultyReminders((prev) => (
                                  prev.includes(index) ? prev.filter((item) => item !== index) : [...prev, index]
                                ))}
                                className={miniButtonClass}
                              >
                                {collapsedFacultyReminders.includes(index) ? 'Развернуть' : 'Свернуть'}
                              </button>
                            )}
                          </div>
                          {(index === 0 || !collapsedFacultyReminders.includes(index)) && (
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1.2fr_0.9fr_1fr]">
                            <select value={reminder.type} onChange={(e) => setFacultyTaskDraft((prev) => ({ ...prev, reminders: prev.reminders.map((item, i) => i === index ? { ...item, type: e.target.value } : item) }))} className={selectClass}>
                              <option value="before_deadline">За N до дедлайна</option>
                              <option value="repeat">Каждые N</option>
                            </select>
                            <label className="flex items-center gap-2 rounded-2xl border border-blue-100 bg-white px-3 py-2 text-sm font-black text-slate-500 shadow-sm transition focus-within:border-[#0069E0] focus-within:bg-white">
                              <span>N =</span>
                              <input value={reminder.value ?? ''} onChange={(e) => setFacultyTaskDraft((prev) => ({ ...prev, reminders: prev.reminders.map((item, i) => i === index ? { ...item, value: e.target.value === '' ? '' : Number(e.target.value) } : item) }))} className="min-w-0 flex-1 bg-transparent text-slate-950 outline-none" inputMode="numeric" />
                            </label>
                            <select value={reminder.unit} onChange={(e) => setFacultyTaskDraft((prev) => ({ ...prev, reminders: prev.reminders.map((item, i) => i === index ? { ...item, unit: e.target.value } : item) }))} className={selectClass}>
                              <option value="days">дней</option>
                              <option value="hours">часов</option>
                            </select>
                          </div>
                          )}
                        </div>
                      ))}
                      {facultyTaskDraft.reminders.length < 3 && (
                        <button
                          type="button"
                          onClick={() => {
                            const nextIndex = facultyTaskDraft.reminders.length;
                            setFacultyTaskDraft((prev) => ({ ...prev, reminders: [...prev.reminders, { type: 'before_deadline', value: '', unit: 'days' }] }));
                            setCollapsedFacultyReminders((prev) => prev.filter((item) => item !== nextIndex));
                          }}
                          className={miniButtonClass}
                        >
                          <Plus className="h-4 w-4" />
                          Добавить напоминание
                        </button>
                      )}
                    </div>
                  </Field>
                  <button className={primaryButtonClass}>{editingFacultyTaskId ? 'Сохранить изменения' : 'Назначить задачу'}</button>
                  {editingFacultyTaskId && (
                    <button type="button" onClick={() => { setEditingFacultyTaskId(null); setCollapsedFacultyReminders([]); setFacultyTaskDraft({ facultyId: faculties[0]?.id || '', competency: '', title: '', description: '', deadline: '', assignedTo: [], reminders: [] }); }} className={secondaryButtonClass}>
                      Отмена
                    </button>
                  )}
                </form>

                <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="font-black">Задачи факультетов</h2>
                    {facultyTasks.length > 3 && (
                      <ListDisclosure
                        expanded={showAllFacultyTasks}
                        onToggle={() => setShowAllFacultyTasks((value) => !value)}
                        total={facultyTasks.length}
                      />
                    )}
                  </div>
                  <div className="mt-3 space-y-3">
                    {facultyTasks.length === 0 ? (
                      <EmptyState text="Пока нет задач факультетам" />
                    ) : (
                      visibleFacultyTasks.map((task) => {
                        const faculty = task.facultyId === 'all'
                          ? { name: 'Все факультеты' }
                          : faculties.find((item) => item.id === task.facultyId);
                        const executors = taskAssigneeIds(task).map((id) => state.users.find((user) => user.id === id)?.realName).filter(Boolean).join(', ');
                        const canEdit = isAdmin || task.creatorId === currentUser.id;
                        return (
                          <div key={task.id} className="rounded-2xl bg-slate-50 p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="font-black">{task.title}</div>
                                <div className="mt-1 text-xs font-semibold text-slate-500">{faculty?.name || 'Факультет'} · {taskStatusText(task.status)} · дедлайн {formatDateShort(task.deadline)}</div>
                                <div className="mt-2 text-sm text-slate-600">{task.description}</div>
                                <div className="mt-1 text-xs text-slate-500">Исполнители: {executors || 'не выбраны'}</div>
                              </div>
                              {canEdit && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingFacultyTaskId(task.id);
                                    setFacultyTaskErrors({});
                                    setFacultyTaskDraft({
                                      facultyId: task.facultyId || '',
                                      competency: task.competency || '',
                                      title: task.title,
                                      description: task.description,
                                      deadline: formatDateShort(task.deadline),
                                      assignedTo: taskAssigneeIds(task),
                                      reminders: task.reminders?.length ? task.reminders : [],
                                    });
                                    setCollapsedFacultyReminders([]);
                                  }}
                                  className={miniButtonClass}
                                >
                                  <PencilSimple className="h-4 w-4" />
                                  Редактировать
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="font-black">Бэклог задач факультетов</h2>
                    <div className="flex flex-wrap gap-2">
                      {facultyTasks.length > 3 && (
                        <ListDisclosure
                          expanded={showAllFacultyBacklog}
                          onToggle={() => setShowAllFacultyBacklog((value) => !value)}
                          total={facultyTasks.length}
                        />
                      )}
                      <a href="/api/tasks/export" target="_blank" rel="noreferrer" className={miniButtonClass}>
                        <DownloadSimple className="h-4 w-4" />
                        Excel
                      </a>
                    </div>
                  </div>
                  <div className="mt-3 space-y-3">
                    {Object.keys(facultyTasksByCompetency).length === 0 ? (
                      <EmptyState text="Бэклог пока пуст" />
                    ) : Object.entries(facultyTasksByCompetency).map(([name, tasks]) => (
                      <div key={name} className="rounded-2xl bg-slate-50 p-3">
                        <div className="font-black">{name}</div>
                        <div className="mt-2 space-y-2">
                          {tasks.slice(0, showAllFacultyBacklog ? tasks.length : 3).map((task) => {
                            const creator = state.users.find((user) => user.id === task.creatorId);
                            const executors = taskAssigneeIds(task).map((id) => state.users.find((user) => user.id === id)?.realName).filter(Boolean).join(', ');
                            return (
                              <div key={task.id} className="rounded-xl bg-white px-3 py-2 text-sm">
                                <div className="font-black">{task.title}</div>
                                <div className="mt-1 text-xs font-semibold text-slate-500">
                                  {taskStatusText(task.status)} · назначено {formatDateShort(task.createdAt)} · дедлайн {formatDateShort(task.deadline)}
                                </div>
                                <div className="mt-1 text-xs text-slate-500">Автор: {creator?.realName || 'не указан'} · Исполнители: {executors || 'не выбраны'}</div>
                                <div className="mt-2 text-sm text-slate-600">{task.description}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </section>
        )}
      </main>

      {completingTaskId && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/55 p-3 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="task-completion-title">
          <div className="w-full max-w-md rounded-[28px] border border-blue-100 bg-white p-5 shadow-[0_24px_70px_rgba(0,0,0,0.28)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="task-completion-title" className="text-xl font-black">Сколько времени заняла задача?</h2>
                <p className="mt-1 text-sm font-semibold text-slate-500">
                  Это необязательно, но поможет точнее планировать нагрузку команды.
                </p>
              </div>
              <button type="button" onClick={closeCompletionPrompt} className={miniButtonClass} aria-label="Закрыть">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <Field label="Часы">
                <input
                  type="number"
                  min="0"
                  max="999"
                  inputMode="numeric"
                  value={completionHours}
                  onChange={(event) => setCompletionHours(event.target.value)}
                  className={inputClass}
                  placeholder="0"
                />
              </Field>
              <Field label="Минуты">
                <input
                  type="number"
                  min="0"
                  max="60000"
                  inputMode="numeric"
                  value={completionMinutes}
                  onChange={(event) => setCompletionMinutes(event.target.value)}
                  className={inputClass}
                  placeholder="0"
                />
              </Field>
            </div>
            <p className="mt-2 text-xs font-semibold text-slate-500">Минуты можно указать общим числом — например, 75 минут сохранятся как 1 ч 15 мин.</p>
            <div className="mt-5 space-y-2">
              <button type="button" disabled={savingCompletion} onClick={() => completeTaskWithTime(true)} className={`${primaryButtonClass} disabled:opacity-60`}>
                {savingCompletion ? 'Сохраняю...' : 'Сохранить и завершить'}
              </button>
              <button type="button" disabled={savingCompletion} onClick={() => completeTaskWithTime(false)} className={`${secondaryButtonClass} w-full disabled:opacity-60`}>
                Завершить без времени
              </button>
            </div>
          </div>
        </div>
      )}

      <nav className="mega-bottom-nav fixed inset-x-0 bottom-0 z-40 border border-blue-100 bg-white/95 p-1.5 shadow-[0_-12px_30px_rgba(0,105,224,0.08)] backdrop-blur">
        <div className="mega-bottom-nav-inner mx-auto grid max-w-3xl grid-cols-5 gap-1">
          <NavButton icon={<CalendarDots />} label="Слоты" active={activeTab === 'slots'} onClick={() => setActiveTab('slots')} />
          <NavButton icon={<UsersThree />} label="Встречи" active={activeTab === 'meetings'} onClick={() => setActiveTab('meetings')} />
          <NavButton icon={<Briefcase />} label="Задачи" active={activeTab === 'tasks'} onClick={() => setActiveTab('tasks')} />
          <NavButton icon={<Shield />} label="Команда" active={activeTab === 'team'} onClick={() => setActiveTab('team')} />
          <NavButton icon={<GraduationCap />} label="МФ" active={activeTab === 'faculties'} onClick={() => setActiveTab('faculties')} />
        </div>
      </nav>
    </div>
  );
}

const pressClass = 'transition duration-150 hover:brightness-105 active:scale-[0.98] active:brightness-90';
const inputClass = 'w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-base font-semibold outline-none transition focus:border-[#0069E0] focus:bg-white';
const selectClass = 'w-full appearance-none rounded-2xl border border-blue-100 bg-white px-3 py-3 pr-10 text-base font-black text-slate-950 shadow-sm outline-none transition hover:border-[#0069E0]/40 hover:bg-slate-50 focus:border-[#0069E0] focus:bg-white focus:shadow-[0_0_0_4px_rgba(0,105,224,0.10)] [background-image:linear-gradient(45deg,transparent_50%,#0069E0_50%),linear-gradient(135deg,#0069E0_50%,transparent_50%)] [background-position:calc(100%-18px)_50%,calc(100%-13px)_50%] [background-repeat:no-repeat] [background-size:6px_6px,6px_6px]';
const primaryButtonClass = `mega-primary-button flex w-full items-center justify-center gap-2 rounded-3xl bg-[#0069E0] px-5 py-3 text-sm font-black text-white shadow-[0_12px_28px_rgba(0,105,224,0.24)] hover:bg-[#1677E8] active:bg-[#0058BD] ${pressClass}`;
const primaryCompactButtonClass = `mega-primary-button flex items-center justify-center gap-2 rounded-full bg-[#0069E0] px-4 py-2 text-xs font-black text-white shadow-[0_10px_24px_rgba(0,105,224,0.22)] hover:bg-[#1677E8] active:bg-[#0058BD] ${pressClass}`;
const secondaryButtonClass = `mega-secondary-button flex items-center justify-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-3 py-2 text-xs font-black text-[#0069E0] hover:bg-blue-100 active:bg-blue-200 ${pressClass}`;
const miniButtonClass = `mega-secondary-button flex items-center justify-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-3 py-2 text-xs font-black text-[#0069E0] hover:bg-blue-100 active:bg-blue-200 ${pressClass}`;
const iconButtonClass = `flex items-center justify-center rounded-full border border-white/25 bg-white/15 text-white backdrop-blur hover:bg-white/25 active:bg-white/30 ${pressClass}`;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const labelledChild = React.isValidElement<Record<string, unknown>>(children)
    && typeof children.type === 'string'
    && ['input', 'select', 'textarea'].includes(children.type)
    ? React.cloneElement(children, { 'aria-label': children.props['aria-label'] || label })
    : children;

  return (
    <div className="block" role="group" aria-label={label}>
      <span className="mb-1.5 block text-xs font-black uppercase text-slate-500">{label}</span>
      {labelledChild}
    </div>
  );
}

function DatePickerField({
  value,
  onChange,
  placeholder = 'Дата не выбрана',
  withYear = true,
  fullYear = false,
  error = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  withYear?: boolean;
  fullYear?: boolean;
  error?: boolean;
}) {
  const inputValue = shortDateToInputDate(value);
  return (
    <div>
      <input
        type="date"
        value={inputValue}
        onChange={(event) => onChange(inputDateToShortDate(event.target.value, withYear, fullYear))}
        className={`${inputClass} cursor-pointer pr-3 ${error ? 'border-rose-300 bg-rose-50 focus:border-rose-500' : ''}`}
      />
      <div className={`mt-1 flex items-center gap-1.5 text-xs font-bold ${value ? 'text-[#0069E0]' : 'text-slate-400'}`}>
        <CalendarDots className="h-3.5 w-3.5" />
        {value || placeholder}
      </div>
    </div>
  );
}

function RequiredHint({ text = 'Обязательное поле' }: { text?: string }) {
  return <div role="alert" className="mt-1 text-xs font-black text-rose-500">{text}</div>;
}

function NavButton({ icon, label, active, onClick }: { icon: React.ReactElement; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-current={active ? 'page' : undefined} className={`flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-2xl px-0.5 text-xs font-black leading-tight sm:h-14 ${pressClass} ${active ? 'bg-[#0069E0] text-white shadow-[0_10px_24px_rgba(0,105,224,0.20)] hover:bg-[#1677E8] active:bg-[#0058BD]' : 'text-slate-500 hover:bg-slate-100 active:bg-slate-100'}`}>
      {React.cloneElement(icon, { className: 'h-5 w-5', weight: active ? 'fill' : 'regular' })}
      <span className="truncate">{label}</span>
    </button>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return (
    <div className={`grid gap-2 rounded-3xl bg-slate-100 p-1 ${options.length === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2'}`}>
      {options.map(([key, label]) => (
        <button key={key} type="button" onClick={() => onChange(key)} className={`mega-segment-option rounded-2xl px-3 py-2 text-sm font-black ${pressClass} ${value === key ? 'mega-segment-option-active shadow-sm' : 'mega-segment-option-idle'}`}>
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
  const [showAll, setShowAll] = useState(false);
  const visibleTasks = showAll ? tasks : tasks.slice(0, 3);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 className="font-black">{title}</h2>
        {tasks.length > 3 && (
          <ListDisclosure expanded={showAll} onToggle={() => setShowAll((value) => !value)} total={tasks.length} />
        )}
      </div>
      {tasks.length === 0 ? (
        <EmptyState text="Пока пусто" />
      ) : (
        visibleTasks.map((task) => {
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
                <button onClick={(event) => { event.stopPropagation(); onAction(task.id); }} className={`mega-primary-button shrink-0 rounded-full bg-[#0069E0] px-3 py-2 text-xs font-black text-white hover:bg-[#1677E8] active:bg-[#0058BD] ${pressClass}`}>
                  {actionLabel}
                </button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold text-slate-500">
              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[#0069E0]">
                {task.competency || 'Без блока'}
              </span>
              <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1">
                <Clock className="h-3 w-3" />
                {formatDateShort(task.deadline)}
              </span>
              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[#0069E0]">
                {taskPriorityText(task.priority)}
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
                <InfoRow label="Приоритет" value={taskPriorityText(task.priority)} />
                {task.timeSpentMinutes ? <InfoRow label="Затрачено времени" value={taskDurationText(task.timeSpentMinutes)} /> : null}
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
  const [expandedBlocks, setExpandedBlocks] = useState<string[]>([]);
  if (blockNames.length === 0) return <EmptyState text="В логе пока нет задач" />;

  return (
    <div className="mt-4 space-y-4">
      {blockNames.map((blockName) => (
        <div key={blockName} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-black">{blockName}</h3>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-[#0069E0]">
                {tasksByCompetency[blockName].length}
              </span>
              {tasksByCompetency[blockName].length > 3 && (
                <ListDisclosure
                  expanded={expandedBlocks.includes(blockName)}
                  onToggle={() => setExpandedBlocks((current) => (
                    current.includes(blockName)
                      ? current.filter((item) => item !== blockName)
                      : [...current, blockName]
                  ))}
                  total={tasksByCompetency[blockName].length}
                />
              )}
            </div>
          </div>
          <div className="space-y-2">
            {tasksByCompetency[blockName]
              .slice()
              .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
              .slice(0, expandedBlocks.includes(blockName) ? tasksByCompetency[blockName].length : 3)
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
                      <span className="shrink-0 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-black text-[#0069E0]">
                        {task.status === 'completed' ? 'Готово' : task.status === 'assigned' ? 'В работе' : 'Открытая'}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-slate-500 sm:grid-cols-2">
                      <span>Автор: <b>{creator?.realName || 'Не указан'}</b></span>
                      <span>Исполнитель: <b>{executors || 'Не назначен'}</b></span>
                      <span>Назначена: <b>{formatDateTimeShort(task.createdAt)}</b></span>
                      <span>Дедлайн: <b>{formatDateShort(task.deadline)}</b></span>
                      {task.completedAt && <span>Выполнена: <b>{formatDateTimeShort(task.completedAt)}</b></span>}
                      {task.timeSpentMinutes ? <span>Затрачено: <b>{taskDurationText(task.timeSpentMinutes)}</b></span> : null}
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

function ListDisclosure({
  expanded,
  onToggle,
  total,
  className = '',
}: {
  expanded: boolean;
  onToggle: () => void;
  total: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={`${secondaryButtonClass} shrink-0 ${className}`}
    >
      {expanded ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
      {expanded ? 'Свернуть' : `Ещё ${Math.max(0, total - 3)}`}
    </button>
  );
}

function CompactUserLinks({ users }: { users: Pick<User, 'id' | 'realName' | 'username'>[] }) {
  const [expanded, setExpanded] = useState(false);
  const visibleUsers = expanded ? users : users.slice(0, 3);

  return (
    <div className="border-t border-blue-100 px-3 py-3 text-xs text-slate-600">
      {users.length > 3 && (
        <ListDisclosure
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
          total={users.length}
          className="mb-2"
        />
      )}
      <div>
        Не смогут:{' '}
        {users.length === 0 ? (
          <span className="font-bold text-emerald-600">никто</span>
        ) : (
          visibleUsers.map((user, userIndex) => (
            <React.Fragment key={user.id}>
              <a href={telegramLink(user.username)} target="_blank" rel="noreferrer" className="font-bold text-[#0069E0] underline decoration-blue-200">
                {user.realName}
              </a>
              {userIndex < visibleUsers.length - 1 ? ', ' : ''}
            </React.Fragment>
          ))
        )}
        {!expanded && users.length > 3 ? <span className="text-slate-400"> …</span> : null}
      </div>
    </div>
  );
}

function InfoRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-slate-400">{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="font-bold text-[#0069E0]">{value}</a>
      ) : (
        <span className="font-bold text-slate-700">{value}</span>
      )}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-3xl border border-dashed border-blue-100 bg-white/70 p-5 text-center text-sm font-bold text-slate-400">{text}</div>;
}
