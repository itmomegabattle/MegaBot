import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  Bell,
  ChatCircleText,
  X,
  ArrowSquareOut,
  Camera,
  Moon,
  Sun,
  MagnifyingGlass,
  UserCircle,
  CaretUp,
  CaretDown,
  ArrowClockwise,
  PaperPlaneTilt,
} from '@phosphor-icons/react';
import { Meeting, SimulationState, Task, User, WorkEvent } from '../types';
import { normalizeAvailabilityConfig } from '../availabilityConfig';
import { drawAvatarCrop } from '../avatarCrop';

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
  onClaimTask: (taskId: string) => Promise<boolean>;
  onCompleteTask: (taskId: string, timeSpentMinutes?: number, completionComment?: string) => Promise<boolean>;
  onReleaseTask: (taskId: string) => void;
  onRefreshState: () => boolean | Promise<boolean>;
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

const maxSlotWeeks = 5;
const telegramLink = (username: string) => `https://t.me/${username.replace('@', '')}`;
const openTelegramProfile = (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
  event.preventDefault();
  event.stopPropagation();
  const webApp = (window as any).Telegram?.WebApp;
  const supportsNonClosingTelegramLinks = !webApp?.isVersionAtLeast || webApp.isVersionAtLeast('7.0');
  if (webApp?.openTelegramLink && supportsNonClosingTelegramLinks) {
    webApp.openTelegramLink(url);
    return;
  }
  if (webApp?.openLink) {
    webApp.openLink(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
};
const taskAssigneeIds = (task: Task) => {
  return task.assignedTo || [];
};
const taskCompetencyNames = (task: Task) => task.competencies?.length ? task.competencies : task.competency ? [task.competency] : [];
const workEventStatusClass = (status: WorkEvent['status']) => status === 'active'
  ? 'bg-emerald-50 text-emerald-700'
  : 'bg-slate-100 text-slate-500';
const meetingAudienceOptionClass = (selected: boolean) => selected
  ? 'border-[#0069E0] bg-blue-50 text-[#005BC4]'
  : 'border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:text-[#005BC4]';
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

const deadlineTimestamp = (value?: string) => {
  const normalized = shortDateToInputDate(value);
  if (!normalized) return null;
  const timestamp = new Date(`${normalized}T23:59:59`).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
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
  if (status === 'cancelled') return 'Отменена';
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
  const [visibleWeeks, setVisibleWeeks] = useState(2);
  const [savingWeekCount, setSavingWeekCount] = useState(false);
  const [slotSettingsWeeks, setSlotSettingsWeeks] = useState(2);
  const [slotSettingsDays, setSlotSettingsDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [slotSettingsStartHour, setSlotSettingsStartHour] = useState(17);
  const [slotSettingsEndHour, setSlotSettingsEndHour] = useState(23);
  const [suggestions, setSuggestions] = useState<MeetingSuggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [savingWeekIndex, setSavingWeekIndex] = useState<number | null>(null);
  const [savedWeekIndexes, setSavedWeekIndexes] = useState<number[]>([]);
  const [dirtyWeekIndexes, setDirtyWeekIndexes] = useState<number[]>([]);
  const [slotError, setSlotError] = useState('');
  const [slotNotice, setSlotNotice] = useState('');
  const [taskError, setTaskError] = useState('');
  const [taskNotice, setTaskNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState('');

  const [showMeetingForm, setShowMeetingForm] = useState(false);
  const [savingMeeting, setSavingMeeting] = useState(false);
  const [expandedMeetingId, setExpandedMeetingId] = useState<string | null>(null);
  const [meetingTitle, setMeetingTitle] = useState('Общее собрание');
  const [meetingDate, setMeetingDate] = useState('');
  const [meetingTime, setMeetingTime] = useState('18:00');
  const [meetingDuration, setMeetingDuration] = useState('1');
  const [meetingTopic, setMeetingTopic] = useState('');
  const [meetingDescription, setMeetingDescription] = useState('');
  const [meetingType, setMeetingType] = useState<'general' | 'custom' | 'competency'>('general');
  const [meetingCompetency, setMeetingCompetency] = useState('');
  const [participants, setParticipants] = useState<string[]>([]);
  const [editingMeetingId, setEditingMeetingId] = useState<string | null>(null);
  const [meetingError, setMeetingError] = useState('');
  const [rsvpMeetingId, setRsvpMeetingId] = useState<string | null>(null);

  const [showTaskForm, setShowTaskForm] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDesc, setTaskDesc] = useState('');
  const [taskCompetencies, setTaskCompetencies] = useState<string[]>([]);
  const [taskDeadline, setTaskDeadline] = useState('');
  const [taskAssignedTo, setTaskAssignedTo] = useState<string[]>([]);
  const [taskAssignmentMode, setTaskAssignmentMode] = useState<'blocks' | 'people' | 'open'>('blocks');
  const [taskAssigneeSearch, setTaskAssigneeSearch] = useState('');
  const [showAllTaskAssignees, setShowAllTaskAssignees] = useState(false);
  const [showTaskBlocks, setShowTaskBlocks] = useState(false);
  const [taskSow, setTaskSow] = useState('');
  const [taskPriority, setTaskPriority] = useState<Task['priority']>('normal');
  const [taskReminders, setTaskReminders] = useState<any[]>([]);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [completionHours, setCompletionHours] = useState('');
  const [completionMinutes, setCompletionMinutes] = useState('');
  const [completionComment, setCompletionComment] = useState('');
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
  const [adminSection, setAdminSection] = useState<'team' | 'events' | 'slots' | 'meetings' | 'tasks' | 'faculties'>('team');
  const [showEventForm, setShowEventForm] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [eventName, setEventName] = useState('');
  const [eventDescription, setEventDescription] = useState('');
  const [eventStartsAt, setEventStartsAt] = useState('');
  const [eventEndsAt, setEventEndsAt] = useState('');
  const [eventSaving, setEventSaving] = useState(false);
  const [eventError, setEventError] = useState('');
  const [eventNotice, setEventNotice] = useState('');
  const [selectedTaskEventId, setSelectedTaskEventId] = useState('');
  const [avatarEditorSource, setAvatarEditorSource] = useState<string | null>(null);
  const [avatarSaving, setAvatarSaving] = useState(false);

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
  const [profileBlocksOpen, setProfileBlocksOpen] = useState(false);
  const [userDraft, setUserDraft] = useState({ realName: '', username: '', birthday: '', role: 'organizer' as User['role'], competencies: [] as string[], primaryCompetency: '' });
  const [newCompetency, setNewCompetency] = useState('');
  const [showAllCompetencies, setShowAllCompetencies] = useState(false);
  const [teamError, setTeamError] = useState('');
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastMode, setBroadcastMode] = useState<'all' | 'blocks' | 'people'>('all');
  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastBody, setBroadcastBody] = useState('');
  const [broadcastBlocks, setBroadcastBlocks] = useState<string[]>([]);
  const [broadcastRecipients, setBroadcastRecipients] = useState<string[]>([]);
  const [broadcastSearch, setBroadcastSearch] = useState('');
  const [showBroadcastBlocks, setShowBroadcastBlocks] = useState(false);
  const [showBroadcastPeople, setShowBroadcastPeople] = useState(false);
  const [broadcastSaving, setBroadcastSaving] = useState(false);
  const [broadcastNotice, setBroadcastNotice] = useState('');
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [facultyUserDraft, setFacultyUserDraft] = useState({ realName: '', username: '', role: 'faculty_responsible' as User['role'], facultyId: '', competencies: [] as string[] });
  const [facultyTaskDraft, setFacultyTaskDraft] = useState({ facultyId: '', competency: '', eventId: '', title: '', description: '', deadline: '', assignedTo: [] as string[], reminders: [] as any[] });
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

  useEffect(() => {
    setFacultyTaskErrors((current) => ({
      ...current,
      facultyId: current.facultyId && facultyTaskDraft.facultyId ? false : current.facultyId,
      assignedTo: current.assignedTo && facultyTaskDraft.assignedTo.length > 0 ? false : current.assignedTo,
      title: current.title && facultyTaskDraft.title.trim() ? false : current.title,
      deadline: current.deadline && facultyTaskDraft.deadline.trim() ? false : current.deadline,
    }));
  }, [facultyTaskDraft.assignedTo.length, facultyTaskDraft.deadline, facultyTaskDraft.facultyId, facultyTaskDraft.title]);

  const isAdmin = currentUser.role === 'admin';
  const isAdminPanel = isAdmin && activeTab === 'admin';

  useEffect(() => {
    if (!isAdmin && activeTab === 'admin') {
      setActiveTab('profile');
      return;
    }
    if (activeTab === 'admin') return;

    // Admin edit state is intentionally scoped to the panel. Clearing it here
    // keeps every ordinary section identical to the participant experience.
    setShowAddUserForm(false);
    setEditingUserId(null);
    setEditingFacultyUserId(null);
    setEditingFacultyTaskId(null);
    setShowTaskLog(false);
    setShowFullCalendar(false);
    setEditingMeetingId(null);
    setShowMeetingForm(false);
  }, [activeTab, isAdmin, setActiveTab]);

  const availabilityConfig = useMemo(() => normalizeAvailabilityConfig(state.settings), [state.settings]);
  const { activeDays, hours } = availabilityConfig;
  const activeDayLabels = activeDays.map((dayIndex) => ({ ...dayLabels[dayIndex], dayIndex }));
  const configuredWeekCount = Math.min(maxSlotWeeks, Math.max(2, Number(state.settings?.availabilityWeekCount || 2)));
  const coreTeamUsers = state.users.filter((user) => user.role === 'admin' || user.role === 'organizer');
  const activeEvents = (state.events || [])
    .filter((item) => item.status === 'active')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const allEvents = (state.events || []).slice().sort((a, b) => (
    Number(a.status === 'archived') - Number(b.status === 'archived')
    || a.name.localeCompare(b.name, 'ru')
  ));
  const activeEventIds = activeEvents.map((item) => item.id).join('|');
  useEffect(() => {
    if (!activeEvents.some((item) => item.id === selectedTaskEventId)) setSelectedTaskEventId(activeEvents[0]?.id || '');
  }, [activeEventIds, selectedTaskEventId]);
  const selectedTaskEvent = activeEvents.find((item) => item.id === selectedTaskEventId);
  const eligibleTaskAssignees = coreTeamUsers;
  const normalizedTaskAssigneeSearch = taskAssigneeSearch.trim().toLowerCase();
  const matchedTaskAssignees = normalizedTaskAssigneeSearch
    ? eligibleTaskAssignees.filter((user) => `${user.realName} ${user.username} ${(user.competencies || []).join(' ')}`.toLowerCase().includes(normalizedTaskAssigneeSearch))
    : eligibleTaskAssignees;
  const visibleTaskAssignees = normalizedTaskAssigneeSearch || showAllTaskAssignees
    ? matchedTaskAssignees
    : matchedTaskAssignees.slice(0, 3);
  const normalizedBroadcastSearch = broadcastSearch.trim().toLowerCase();
  const matchedBroadcastUsers = normalizedBroadcastSearch
    ? coreTeamUsers.filter((user) => `${user.realName} ${user.username} ${(user.competencies || []).join(' ')}`.toLowerCase().includes(normalizedBroadcastSearch))
    : coreTeamUsers;
  const filterTasksBySelectedEvent = (tasks: Task[]) => selectedTaskEventId ? tasks.filter((task) => task.eventId === selectedTaskEventId) : [];
  const votedUsers = useMemo(
    () => state.users.filter((user) => {
      if (user.role !== 'admin' && user.role !== 'organizer') return false;
      const availability = state.availabilities[user.id];
      return Object.values(alignedSlots(availability)).some((day) => day.length > 0);
    }),
    [state.availabilities, state.users],
  );
  const majority = Math.floor(coreTeamUsers.length / 2) + 1;
  const allMyTasks = state.tasks.filter((task) => taskAssigneeIds(task).includes(currentUser.id) && !['completed', 'cancelled'].includes(task.status));
  const allOpenTasks = state.tasks.filter((task) => task.status === 'open');
  const allCompletedTasks = state.tasks
    .filter((task) => task.status === 'completed')
    .slice()
    .sort((a, b) => String(b.completedAt || b.createdAt || '').localeCompare(String(a.completedAt || a.createdAt || '')));
  const myTasks = filterTasksBySelectedEvent(allMyTasks);
  const openTasks = filterTasksBySelectedEvent(allOpenTasks);
  const completedTasks = filterTasksBySelectedEvent(allCompletedTasks);
  const assignedByMeTasks = filterTasksBySelectedEvent(state.tasks.filter((task) => (
    task.creatorId === currentUser.id && !['completed', 'cancelled'].includes(task.status) && taskAssigneeIds(task).length > 0
  )));
  const latestCompletedTasks = completedTasks.slice(0, 10);
  const editingCompletedTask = Boolean(completingTaskId && state.tasks.find((task) => task.id === completingTaskId)?.status === 'completed');
  const scheduledMeetings = state.meetings.filter((meeting) => meeting.status === 'scheduled');
  const visibleScheduledMeetings = showAllMeetings ? scheduledMeetings : scheduledMeetings.slice(0, 3);
  const profileAssignedTasks = state.tasks.filter((task) => taskAssigneeIds(task).includes(currentUser.id));
  const profileCompletedTasks = allCompletedTasks.filter((task) => taskAssigneeIds(task).includes(currentUser.id));
  const profileDatedCompletedTasks = profileCompletedTasks.filter((task) => (
    Boolean(task.completedAt) && deadlineTimestamp(task.deadline) !== null
  ));
  const profileOnTimeTasks = profileDatedCompletedTasks.filter((task) => (
    new Date(task.completedAt as string).getTime() <= (deadlineTimestamp(task.deadline) as number)
  ));
  const profileTimedTasks = profileCompletedTasks.filter((task) => Number(task.timeSpentMinutes) > 0);
  const profileTrackedMinutes = profileTimedTasks.reduce((sum, task) => sum + Number(task.timeSpentMinutes), 0);
  const profileAverageMinutes = profileTimedTasks.length
    ? Math.round(profileTrackedMinutes / profileTimedTasks.length)
    : null;
  const profileCreatedTasks = state.tasks.filter((task) => task.creatorId === currentUser.id);
  const profileCreatedCompletedTasks = profileCreatedTasks.filter((task) => task.status === 'completed');
  const profileImportantTasks = allMyTasks.filter((task) => task.priority === 'important' || task.priority === 'critical');
  const profileCompletedByCompetency = profileCompletedTasks.reduce<Record<string, number>>((acc, task) => {
    const taskBlocks = taskCompetencyNames(task);
    for (const competency of taskBlocks.length ? taskBlocks : ['Без блока']) acc[competency] = (acc[competency] || 0) + 1;
    return acc;
  }, {});
  const profileTopCompetency = Object.entries(profileCompletedByCompetency)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'пока нет данных';
  const profileAvailability = alignedSlots(state.availabilities[currentUser.id]);
  const profileAvailableHours = activeDays.map((dayIndex) => profileAvailability[dayIndex] || [])
    .reduce((sum, dayHours) => sum + dayHours.length, 0);
  const profileAvailableDays = activeDays.map((dayIndex) => profileAvailability[dayIndex] || [])
    .filter((dayHours) => dayHours.length > 0).length;
  const profileBestAvailability = activeDays.map((dayIndex) => ({
    day: dayLabels[dayIndex].full,
    hours: (profileAvailability[dayIndex] || []).length,
  })).sort((a, b) => b.hours - a.hours)[0];
  const profileUnavailableDays = new Set(alignedUnavailableDays(state.availabilities[currentUser.id]).filter((day) => day < 7));
  const profileSlotsCompleted = activeDays.some((dayIndex) => (
    (profileAvailability[dayIndex] || []).length > 0 || profileUnavailableDays.has(dayIndex)
  ));
  const profileAge = ageFromBirthday(currentUser.birthday);
  const facultyTasks = state.tasks.filter((task) => task.facultyId && task.status !== 'cancelled');
  const visibleFacultyTasks = showAllFacultyTasks ? facultyTasks : facultyTasks.slice(0, 3);
  const tasksByCompetency = filterTasksBySelectedEvent(state.tasks.filter((task) => task.status === 'completed')).reduce<Record<string, Task[]>>((acc, task) => {
    const key = taskCompetencyNames(task).join(' · ') || 'Без блока';
    if (!acc[key]) acc[key] = [];
    acc[key].push(task);
    return acc;
  }, {});
  const allTasksByCompetency = state.tasks.filter((task) => task.status === 'completed').reduce<Record<string, Task[]>>((acc, task) => {
    const key = taskCompetencyNames(task).join(' · ') || 'Без блока';
    if (!acc[key]) acc[key] = [];
    acc[key].push(task);
    return acc;
  }, {});
  const facultyTasksByCompetency = state.tasks
    .filter((task) => task.facultyId && task.status !== 'cancelled')
    .reduce<Record<string, Task[]>>((acc, task) => {
      const key = task.competency || 'Факультет';
      if (!acc[key]) acc[key] = [];
      acc[key].push(task);
      return acc;
    }, {});
  const teamUsers = [currentUser, ...coreTeamUsers.filter((user) => user.id !== currentUser.id)];
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
        dayIndex,
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
    setVisibleWeeks(Math.min(maxSlotWeeks, Math.max(configuredWeekCount, lastFilledDay === undefined ? configuredWeekCount : Math.floor(lastFilledDay / 7) + 1)));
    setSlots(nextSlots);
  }, [configuredWeekCount, currentUser.id, state.availabilities]);

  useEffect(() => {
    setSlotSettingsWeeks(configuredWeekCount);
    setSlotSettingsDays(activeDays);
    setSlotSettingsStartHour(availabilityConfig.startHour);
    setSlotSettingsEndHour(availabilityConfig.endHour);
  }, [activeDays, availabilityConfig.endHour, availabilityConfig.startHour, configuredWeekCount]);

  const updateAvailabilitySettings = async (notifyTeam = false) => {
    setSavingWeekCount(true);
    setSlotError('');
    setSlotNotice('');
    try {
      const response = await fetch('/api/availability/weeks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requesterId: currentUser.id,
          weeks: slotSettingsWeeks,
          activeDays: slotSettingsDays,
          startHour: slotSettingsStartHour,
          endHour: slotSettingsEndHour,
          notifyTeam,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Не удалось изменить количество недель');
      await onRefreshState();
      setSlotNotice(notifyTeam
        ? `Уведомление отправлено: ${body.notified || 0} получателей.`
        : `Настройки сохранены: ${body.activeDays.length} дн., ${String(body.startHour).padStart(2, '0')}:00–${String(body.endHour).padStart(2, '0')}:00.`);
    } catch (error: any) {
      setSlotError(error.message || 'Не удалось изменить количество недель');
    } finally {
      setSavingWeekCount(false);
    }
  };

  const toggleSlot = (day: number, hour: number) => {
    setSlotError('');
    const weekIndex = Math.floor(day / 7);
    setSavedWeekIndexes((current) => current.filter((item) => item !== weekIndex));
    setDirtyWeekIndexes((current) => current.includes(weekIndex) ? current : [...current, weekIndex]);
    setSlots((prev) => {
      const daySlots = prev[day] || [];
      const nextDay = daySlots.includes(hour)
        ? daySlots.filter((item) => item !== hour)
        : [...daySlots, hour].sort((a, b) => a - b);
      return { ...prev, [day]: nextDay };
    });
  };

  const selectWholeDay = (day: number) => {
    setSlotError('');
    const weekIndex = Math.floor(day / 7);
    setSavedWeekIndexes((current) => current.filter((item) => item !== weekIndex));
    setDirtyWeekIndexes((current) => current.includes(weekIndex) ? current : [...current, weekIndex]);
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

  const toggleTaskCompetency = (name: string) => {
    const next = taskCompetencies.includes(name) ? taskCompetencies.filter((item) => item !== name) : [...taskCompetencies, name];
    setTaskCompetencies(next);
    const blockMemberIds = coreTeamUsers
      .filter((user) => next.some((item) => user.primaryCompetency === item || user.competencies?.includes(item)))
      .map((user) => user.id);
    setTaskAssignedTo(blockMemberIds);
    setShowAllTaskAssignees(false);
  };

  const saveWeek = async (weekIndex: number) => {
    setSlotError('');
    setSavingWeekIndex(weekIndex);
    const ok = await onSaveAvailability(slots, currentWeekStart(), []);
    setSavingWeekIndex(null);
    if (ok) {
      setSavedWeekIndexes((current) => current.includes(weekIndex) ? current : [...current, weekIndex]);
      setDirtyWeekIndexes((current) => current.filter((item) => item !== weekIndex));
      setSlotNotice(`Неделя ${weekIndex + 1} сохранена независимо от остальных.`);
    }
  };

  const resetMeetingForm = () => {
    setEditingMeetingId(null);
    setShowMeetingForm(false);
    setMeetingTitle('Общее собрание');
    setMeetingDate('');
    setMeetingTime('18:00');
    setMeetingDuration('1');
    setMeetingTopic('');
    setMeetingDescription('');
    setMeetingType('general');
    setMeetingCompetency('');
    setParticipants([]);
    setShowAllMeetingParticipants(false);
    setMeetingError('');
  };

  const startMeetingEdit = (meeting: Meeting) => {
    setEditingMeetingId(meeting.id);
    setShowMeetingForm(true);
    setMeetingTitle(meeting.title);
    setMeetingDate(formatDateShort(meeting.date));
    setMeetingTime(meeting.time);
    setMeetingDuration(String(meeting.duration || 1));
    setMeetingTopic(meeting.topic || '');
    setMeetingDescription(meeting.description || '');
    setMeetingType(meeting.competency ? 'competency' : meeting.type);
    setMeetingCompetency(meeting.competency || '');
    setParticipants(Array.isArray(meeting.participants) ? meeting.participants : []);
  };

  const submitMeeting = async (event: React.FormEvent) => {
    event.preventDefault();
    setMeetingError('');
    if (!meetingTitle.trim()) {
      setMeetingError('Укажи название собрания.');
      return;
    }
    if (!meetingDate) {
      setMeetingError('Выбери дату собрания.');
      return;
    }
    if (meetingType !== 'general' && participants.length === 0) {
      setMeetingError(meetingType === 'competency' ? 'В выбранном блоке пока нет участников.' : 'Выбери хотя бы одного участника.');
      return;
    }
    setSavingMeeting(true);
    const payload = {
      title: meetingTitle || 'Собрание',
      type: meetingType === 'competency' ? 'custom' : meetingType,
      date: meetingDate || nextDateForDay(0),
      time: meetingTime,
      duration: Number(meetingDuration) || 1,
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
      const body = await res.json();
      if (res.ok) {
        resetMeetingForm();
        await onRefreshState();
      } else {
        setMeetingError(body.error || 'Не удалось сохранить собрание.');
      }
      setSavingMeeting(false);
      return;
    }

    const ok = await onScheduleMeeting(payload);
    setSavingMeeting(false);
    if (ok) resetMeetingForm();
    else setMeetingError('Не удалось назначить собрание. Проверь поля и соединение.');
  };

  const setMeetingAudience = (nextType: 'general' | 'custom' | 'competency') => {
    setMeetingType(nextType);
    setMeetingError('');
    setShowAllMeetingParticipants(false);
    if (nextType === 'general') {
      setParticipants([]);
      setMeetingCompetency('');
    }
    if (nextType === 'custom') {
      setMeetingCompetency('');
      setParticipants([]);
    }
  };

  const setMeetingAttendance = async (meeting: Meeting, attending: boolean) => {
    if (rsvpMeetingId) return;
    setRsvpMeetingId(meeting.id);
    setMeetingError('');
    try {
      const response = await fetch('/api/meeting/rsvp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterId: currentUser.id, meetingId: meeting.id, attending }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Не удалось обновить участие');
      await onRefreshState();
    } catch (error: any) {
      setMeetingError(error.message || 'Не удалось обновить участие.');
    } finally {
      setRsvpMeetingId(null);
    }
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
    setTaskCompetencies([]);
    setTaskDeadline('');
    setTaskAssignedTo([]);
    setTaskAssignmentMode('blocks');
    setTaskAssigneeSearch('');
    setShowAllTaskAssignees(false);
    setShowTaskBlocks(false);
    setTaskSow('');
    setTaskPriority('normal');
    setTaskReminders([]);
    setEditingTaskId(null);
  };

  const openTaskForm = () => {
    if (!showTaskForm && !selectedTaskEventId) {
      setTaskError('Сначала добавь активное мероприятие в админской панели.');
      return;
    }
    if (!showTaskForm) setTaskError('');
    if (showTaskForm) resetTaskForm();
    setShowTaskForm((value) => !value);
  };

  const startTaskEdit = (task: Task) => {
    setEditingTaskId(task.id);
    setTaskTitle(task.title);
    setTaskDesc(task.description);
    setTaskCompetencies(taskCompetencyNames(task));
    setTaskDeadline(formatDateShort(task.deadline));
    setTaskAssignedTo(taskAssigneeIds(task));
    setTaskAssignmentMode(taskAssigneeIds(task).length === 0 ? 'open' : taskCompetencyNames(task).length ? 'blocks' : 'people');
    setTaskAssigneeSearch('');
    setShowTaskBlocks(false);
    setTaskSow(task.sow || '');
    setTaskPriority(task.priority || 'normal');
    setTaskReminders(task.reminders?.map((reminder) => ({ ...reminder })) || []);
    setTaskError('');
    setShowTaskForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submitTask = async (event: React.FormEvent) => {
    event.preventDefault();
    setTaskError('');
    setTaskNotice('');
    if (!selectedTaskEventId) {
      setTaskError('Выбери мероприятие в верхней части страницы.');
      return;
    }
    if (taskAssignmentMode === 'blocks' && !taskCompetencies.length) {
      setTaskError('Выбери хотя бы один блок исполнителей.');
      return;
    }
    if (taskAssignmentMode !== 'open' && !taskAssignedTo.length) {
      setTaskError('Выбери хотя бы одного исполнителя или сделай задачу открытой.');
      return;
    }
    setSavingTask(true);
    const payload = {
      title: taskTitle.trim() || 'Без названия',
      description: taskDesc.trim(),
      competency: taskCompetencies[0] || '',
      competencies: taskCompetencies,
      eventId: selectedTaskEventId,
      deadline: taskDeadline,
      assignedTo: taskAssignmentMode === 'open' ? [] : taskAssignedTo,
      sow: taskSow,
      tips: [],
      priority: taskPriority,
      creatorId: currentUser.id,
      reminders: taskReminders,
    };
    let ok = false;
    if (editingTaskId) {
      try {
        const response = await fetch('/api/task/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requesterId: currentUser.id, taskId: editingTaskId, ...payload }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Не удалось сохранить задачу');
        await onRefreshState();
        setTaskNotice('Задача и исполнители обновлены.');
        ok = true;
      } catch (error: any) {
        setTaskError(error.message || 'Не удалось сохранить задачу.');
      }
    } else {
      ok = await onCreateTask(payload);
    }
    setSavingTask(false);
    if (ok) {
      resetTaskForm();
      setShowTaskForm(false);
    }
  };

  const openCompletionPrompt = (taskId: string) => {
    const task = state.tasks.find((item) => item.id === taskId);
    const totalMinutes = Number(task?.timeSpentMinutes || 0);
    setCompletingTaskId(taskId);
    setCompletionHours(totalMinutes ? String(Math.floor(totalMinutes / 60)) : '');
    setCompletionMinutes(totalMinutes ? String(totalMinutes % 60) : '');
    setCompletionComment(task?.completionComments?.[currentUser.id] || '');
  };

  const closeCompletionPrompt = () => {
    if (savingCompletion) return;
    setCompletingTaskId(null);
    setCompletionHours('');
    setCompletionMinutes('');
    setCompletionComment('');
  };

  const completeTaskWithTime = async (includeTime: boolean) => {
    if (!completingTaskId || savingCompletion) return;
    const hoursValue = Math.max(0, Number.parseInt(completionHours || '0', 10) || 0);
    const minutesValue = Math.max(0, Number.parseInt(completionMinutes || '0', 10) || 0);
    const totalMinutes = hoursValue * 60 + minutesValue;
    setSavingCompletion(true);
    const ok = await onCompleteTask(
      completingTaskId,
      includeTime && totalMinutes > 0 ? totalMinutes : undefined,
      completionComment.trim() || undefined,
    );
    setSavingCompletion(false);
    if (ok) closeCompletionPrompt();
  };

  const reopenCompletedTask = async () => {
    if (!completingTaskId || savingCompletion) return;
    setSavingCompletion(true);
    setTaskError('');
    try {
      const response = await fetch('/api/task/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: completingTaskId, status: 'in_progress', requesterId: currentUser.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Не удалось вернуть задачу в работу');
      await onRefreshState();
      setTaskNotice('Задача снова в работе. Комментарий можно исправить при следующем завершении.');
      setSavingCompletion(false);
      closeCompletionPrompt();
    } catch (error: any) {
      setTaskError(error.message || 'Не удалось вернуть задачу в работу.');
    } finally {
      setSavingCompletion(false);
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

  const notifyTaskAssignees = async (taskId: string) => {
    setTaskError('');
    setTaskNotice('');
    try {
      const response = await fetch('/api/task/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterId: currentUser.id, taskId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Не удалось отправить напоминание');
      setTaskNotice(`Напоминание отправляется ${body.queued || 0} исполнителям.`);
    } catch (error: any) {
      setTaskError(error.message || 'Не удалось отправить напоминание.');
    }
  };

  const saveTaskComment = async (taskId: string, assigneeId: string, side: 'executor' | 'coordinator', text: string) => {
    setTaskError('');
    try {
      const response = await fetch('/api/task/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterId: currentUser.id, taskId, assigneeId, side, text }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Не удалось сохранить комментарий');
      await onRefreshState();
      setTaskNotice('Комментарий сохранён.');
      return true;
    } catch (error: any) {
      setTaskError(error.message || 'Не удалось сохранить комментарий.');
      return false;
    }
  };

  const deleteTask = async (taskId: string) => {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task || !window.confirm(`Удалить задачу «${task.title}»? Исполнители получат уведомление, а запись останется в логе.`)) return;
    setTaskError('');
    setTaskNotice('');
    try {
      const response = await fetch('/api/task/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterId: currentUser.id, taskId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Не удалось удалить задачу');
      await onRefreshState();
      setTaskNotice('Задача отменена и убрана из активных списков.');
    } catch (error: any) {
      setTaskError(error.message || 'Не удалось удалить задачу.');
    }
  };

  const refreshPage = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshNotice('');
    const refreshed = await onRefreshState();
    setRefreshNotice(refreshed ? 'Данные обновлены' : 'Не удалось обновить');
    setRefreshing(false);
    window.setTimeout(() => setRefreshNotice(''), 2500);
  };

  const setBroadcastRecipientMode = (mode: 'all' | 'blocks' | 'people') => {
    setBroadcastMode(mode);
    setBroadcastSearch('');
    setShowBroadcastBlocks(false);
    setShowBroadcastPeople(false);
    if (mode === 'all') {
      setBroadcastBlocks([]);
      setBroadcastRecipients([]);
    } else if (mode === 'people') {
      setBroadcastBlocks([]);
    }
  };

  const toggleBroadcastBlock = (name: string) => {
    setBroadcastBlocks((current) => {
      const next = current.includes(name) ? current.filter((item) => item !== name) : [...current, name];
      setBroadcastRecipients(coreTeamUsers
        .filter((user) => next.some((block) => user.primaryCompetency === block || user.competencies?.includes(block)))
        .map((user) => user.id));
      return next;
    });
  };

  const submitBroadcast = async (event: React.FormEvent) => {
    event.preventDefault();
    if (broadcastSaving) return;
    setTeamError('');
    setBroadcastNotice('');
    if (!broadcastBody.trim()) {
      setTeamError('Напиши текст рассылки.');
      return;
    }
    if (broadcastMode === 'blocks' && !broadcastBlocks.length) {
      setTeamError('Выбери хотя бы один блок получателей.');
      return;
    }
    if (broadcastMode === 'people' && !broadcastRecipients.length) {
      setTeamError('Выбери хотя бы одного получателя.');
      return;
    }
    setBroadcastSaving(true);
    try {
      const response = await fetch('/api/team/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requesterId: currentUser.id,
          recipientMode: broadcastMode,
          competencies: broadcastBlocks,
          recipientIds: broadcastRecipients,
          title: broadcastTitle,
          body: broadcastBody,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось отправить рассылку');
      setBroadcastNotice([
        `Доставлено в личку: ${result.delivered || 0} из ${result.recipients || 0}.`,
        result.unavailable ? `Не запускали бота: ${result.unavailable}.` : '',
        result.failed ? `Ошибка Telegram: ${result.failed}.` : '',
      ].filter(Boolean).join(' '));
      setBroadcastTitle('');
      setBroadcastBody('');
      setBroadcastBlocks([]);
      setBroadcastRecipients([]);
      setBroadcastSearch('');
      setShowBroadcastBlocks(false);
      setShowBroadcastPeople(false);
      await onRefreshState();
    } catch (error: any) {
      setTeamError(error.message || 'Не удалось отправить рассылку. Проверь соединение и повтори.');
    } finally {
      setBroadcastSaving(false);
    }
  };

  const submitWorkEvent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isAdmin || eventSaving) return;
    setEventError('');
    setEventNotice('');
    if (!eventName.trim()) {
      setEventError('Укажи название мероприятия.');
      return;
    }
    setEventSaving(true);
    try {
      const response = await fetch(editingEventId ? '/api/event/update' : '/api/event/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requesterId: currentUser.id,
          eventId: editingEventId,
          name: eventName,
          description: eventDescription,
          startsAt: eventStartsAt,
          endsAt: eventEndsAt,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Не удалось добавить мероприятие');
      setEventName('');
      setEventDescription('');
      setEventStartsAt('');
      setEventEndsAt('');
      setEditingEventId(null);
      setShowEventForm(false);
      setEventNotice(editingEventId ? 'Изменения мероприятия сохранены.' : 'Мероприятие добавлено и доступно в задачах.');
      await onRefreshState();
    } catch (error: any) {
      setEventError(error.message || 'Не удалось добавить мероприятие.');
    } finally {
      setEventSaving(false);
    }
  };

  const startWorkEventEdit = (workEvent: WorkEvent) => {
    setEditingEventId(workEvent.id);
    setEventName(workEvent.name);
    setEventDescription(workEvent.description || '');
    setEventStartsAt(workEvent.startsAt || '');
    setEventEndsAt(workEvent.endsAt || '');
    setEventError('');
    setShowEventForm(true);
  };

  const closeWorkEventForm = () => {
    setShowEventForm(false);
    setEditingEventId(null);
    setEventName('');
    setEventDescription('');
    setEventStartsAt('');
    setEventEndsAt('');
    setEventError('');
  };

  const setWorkEventStatus = async (workEvent: WorkEvent, status: WorkEvent['status']) => {
    if (!isAdmin || eventSaving) return;
    setEventSaving(true);
    setEventError('');
    setEventNotice('');
    try {
      const response = await fetch('/api/event/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterId: currentUser.id, eventId: workEvent.id, status }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Не удалось изменить мероприятие');
      setEventNotice(status === 'archived' ? 'Мероприятие завершено. Его задачи сохранены в истории.' : 'Мероприятие снова активно.');
      await onRefreshState();
    } catch (error: any) {
      setEventError(error.message || 'Не удалось изменить мероприятие.');
    } finally {
      setEventSaving(false);
    }
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
    setTeamError('');
    setProfileBlocksOpen(false);
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
    if (savingUserId) return;
    setSavingUserId(userId);
    setTeamError('');
    const payload = isAdminPanel
      ? { requesterId: currentUser.id, userId, ...userDraft }
      : userId === currentUser.id
        ? {
            requesterId: currentUser.id,
            userId,
            realName: userDraft.realName,
            username: userDraft.username,
            birthday: userDraft.birthday,
            competencies: userDraft.competencies,
            primaryCompetency: userDraft.primaryCompetency,
          }
        : { requesterId: currentUser.id, userId, competencies: userDraft.competencies, primaryCompetency: userDraft.primaryCompetency };
    try {
      const res = await fetch('/api/user/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Не удалось сохранить профиль');
      await onRefreshState();
      setEditingUserId(null);
    } catch (error: any) {
      setTeamError(error.message || 'Не удалось сохранить профиль.');
    } finally {
      setSavingUserId(null);
    }
  };

  const chooseAvatarFile = (file?: File) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => setAvatarEditorSource(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const saveAvatar = async (avatarDataUrl: string) => {
    if (avatarSaving) return;
    setAvatarSaving(true);
    setTeamError('');
    try {
      const response = await fetch('/api/user/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterId: currentUser.id, userId: currentUser.id, avatarDataUrl }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Не удалось сохранить аватар');
      await onRefreshState();
      setAvatarEditorSource(null);
    } catch (error: any) {
      setTeamError(error.message || 'Не удалось сохранить аватар.');
    } finally {
      setAvatarSaving(false);
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
      setFacultyTaskDraft({ facultyId: faculties[0]?.id || '', competency: '', eventId: '', title: '', description: '', deadline: '', assignedTo: [], reminders: [] });
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
    admin: 'Админская панель',
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
              <button
                type="button"
                onClick={() => void refreshPage()}
                disabled={refreshing}
                className={`${iconButtonClass} h-11 w-11 disabled:opacity-60`}
                title="Обновить данные"
                aria-label="Обновить данные страницы"
                aria-busy={refreshing}
              >
                <ArrowClockwise className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`} weight="bold" />
              </button>
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
        {refreshNotice && (
          <div role="status" className={`rounded-2xl px-3 py-2 text-center text-sm font-black ${refreshNotice === 'Данные обновлены' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>
            {refreshNotice}
          </div>
        )}
        {activeTab === 'profile' && (
          <section className="space-y-4">
            <div className="rounded-3xl border border-blue-100 bg-white p-5 shadow-sm">
              <div className="mb-4 flex min-w-0 items-center justify-between gap-3">
                <h2 className="min-w-0 text-lg font-black text-slate-950">Профиль</h2>
                <button
                  type="button"
                  onClick={() => editingUserId === currentUser.id ? setEditingUserId(null) : startUserEdit(currentUser)}
                  className={`${miniButtonClass} min-h-11 shrink-0 px-3`}
                  aria-expanded={editingUserId === currentUser.id}
                >
                  <PencilSimple className="h-4 w-4" weight="bold" />
                  {editingUserId === currentUser.id ? 'Закрыть' : 'Редактировать'}
                </button>
              </div>
              <div className="flex items-center gap-4">
                <label className="group relative shrink-0 cursor-pointer" aria-label="Изменить фотографию профиля">
                  <UserAvatar user={currentUser} className="h-16 w-16 rounded-2xl" />
                  <span className="absolute inset-0 flex items-center justify-center rounded-2xl bg-slate-950/0 text-transparent transition group-hover:bg-slate-950/45 group-hover:text-white group-focus-within:bg-slate-950/45 group-focus-within:text-white"><Camera className="h-5 w-5" /></span>
                  <input type="file" accept="image/*" className="sr-only" onChange={(event) => { chooseAvatarFile(event.target.files?.[0]); event.currentTarget.value = ''; }} />
                </label>
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-black">{currentUser.realName}</h2>
                  <a href={telegramLink(currentUser.username)} onClick={(event) => openTelegramProfile(event, telegramLink(currentUser.username))} className="text-sm font-bold text-[#0069E0]">
                    {currentUser.username}
                  </a>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    {isAdmin ? 'Администратор' : 'Организатор'}
                    {currentUser.birthday ? ` · ${formatDateShort(currentUser.birthday)}` : ''}
                    {profileAge !== null ? ` · ${profileAge} лет` : ''}
                  </p>
                </div>
              </div>
              {currentUser.avatarDataUrl && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" disabled={avatarSaving} onClick={() => void saveAvatar('')} className={`${miniButtonClass} border-rose-100 bg-rose-50 text-rose-600 disabled:opacity-60`}>Удалить фото</button>
                </div>
              )}

              {editingUserId === currentUser.id && (
                <div className="mt-4 space-y-3 rounded-2xl border border-blue-100 bg-slate-50 p-3">
                  <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Имя">
                      <input value={userDraft.realName} onChange={(event) => setUserDraft((prev) => ({ ...prev, realName: event.target.value }))} className={inputClass} autoComplete="name" />
                    </Field>
                    <Field label="Telegram">
                      <input value={userDraft.username} onChange={(event) => setUserDraft((prev) => ({ ...prev, username: event.target.value }))} className={inputClass} autoCapitalize="none" autoCorrect="off" />
                    </Field>
                  </div>
                  <Field label="Дата рождения">
                    <DatePickerField value={userDraft.birthday} onChange={(value) => setUserDraft((prev) => ({ ...prev, birthday: value }))} placeholder="Выбери дату" fullYear />
                  </Field>
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => setProfileBlocksOpen((open) => !open)}
                      aria-expanded={profileBlocksOpen}
                      className={`${secondaryButtonClass} min-h-11 w-full justify-between px-3`}
                    >
                      <span className="min-w-0 truncate text-left">Блоки · {userDraft.competencies.length} выбрано</span>
                      {profileBlocksOpen ? <CaretUp className="h-4 w-4 shrink-0" /> : <CaretDown className="h-4 w-4 shrink-0" />}
                    </button>
                    {profileBlocksOpen && <div className="mt-2 grid grid-cols-1 gap-2 rounded-2xl border border-slate-200 bg-white p-2">
                      {competencies.length === 0 ? (
                        <div className="px-2 py-1 text-xs font-bold text-slate-400">Админ ещё не добавил блоки</div>
                      ) : competencies.map((name) => (
                        <div key={name} className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold">
                          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                            <input type="checkbox" checked={userDraft.competencies.includes(name)} onChange={() => toggleDraftCompetency(name)} />
                            <span className="min-w-0 break-words">{name}</span>
                          </label>
                          <label className={`flex shrink-0 cursor-pointer items-center gap-1.5 text-xs font-black ${userDraft.competencies.includes(name) ? 'text-[#0069E0]' : 'text-slate-300'}`}>
                            <input
                              type="radio"
                              name="profile-primary-competency"
                              disabled={!userDraft.competencies.includes(name)}
                              checked={userDraft.primaryCompetency === name}
                              onChange={() => setUserDraft((prev) => ({ ...prev, primaryCompetency: name }))}
                            />
                            Главный
                          </label>
                        </div>
                      ))}
                    </div>}
                  </div>
                  {teamError && <p role="alert" className="text-sm font-bold text-rose-600">{teamError}</p>}
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => setEditingUserId(null)} className={secondaryButtonClass}>Отмена</button>
                    <button type="button" onClick={() => void updateUser(currentUser.id)} disabled={savingUserId === currentUser.id} className={`${primaryButtonClass} disabled:opacity-60`}>
                      {savingUserId === currentUser.id ? 'Сохраняю…' : 'Сохранить'}
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-5 grid grid-cols-2 overflow-hidden rounded-2xl border border-blue-100 bg-slate-50 sm:grid-cols-4">
                {[
                  ['Завершено из назначенных', `${profileCompletedTasks.length} из ${profileAssignedTasks.length}`],
                  ['Сейчас в работе', myTasks.length],
                  ['В срок среди задач с дедлайном', profileDatedCompletedTasks.length ? `${profileOnTimeTasks.length} из ${profileDatedCompletedTasks.length}` : '—'],
                  ['Учтено времени', taskDurationText(profileTrackedMinutes) || '—'],
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
                <InfoRow label="Статус слотов" value={profileSlotsCompleted ? 'неделя сохранена' : 'нужно отметить'} />
              </div>
            </div>

            {isAdmin && (
              <button
                type="button"
                onClick={() => setActiveTab('admin')}
                className={`${primaryButtonClass} py-4 text-base`}
              >
                <Shield className="h-5 w-5" weight="fill" />
                Админская панель
              </button>
            )}

            <div className="rounded-3xl border border-blue-100 bg-white p-5 shadow-sm">
              <h3 className="text-lg font-black">Статистика задач</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">Только задачи, которые были назначены тебе или созданы тобой</p>
              <div className="mt-4 space-y-3 text-sm text-slate-600">
                <InfoRow label="Создано задач" value={String(profileCreatedTasks.length)} />
                <InfoRow label="Завершено из созданных" value={String(profileCreatedCompletedTasks.length)} />
                <InfoRow label="Важных сейчас в работе" value={String(profileImportantTasks.length)} />
                <InfoRow label="Блок завершённых задач" value={profileTopCompetency} />
                <InfoRow
                  label="Время указано"
                  value={`${profileTimedTasks.length} из ${profileCompletedTasks.length} выполненных`}
                />
              </div>
            </div>

            <div className="rounded-3xl border border-blue-100 bg-white p-5 shadow-sm">
              <h3 className="text-lg font-black">Ритм недели</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">Как распределены доступность и нагрузка</p>
              <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-blue-100 bg-blue-100">
                {[
                  ['Дней со слотами', `${profileAvailableDays} из ${activeDays.length}`],
                  ['Свободных часов', profileAvailableHours],
                  ['Самый свободный день', profileBestAvailability?.hours ? profileBestAvailability.day : '—'],
                  ['Среднее время задачи', profileAverageMinutes ? taskDurationText(profileAverageMinutes) : '—'],
                ].map(([label, value]) => (
                  <div key={String(label)} className="min-w-0 bg-slate-50 p-3">
                    <div className="break-words text-base font-black text-[#0069E0]">{value}</div>
                    <div className="mt-1 text-xs font-bold text-slate-500">{label}</div>
                  </div>
                ))}
              </div>
              {!profileSlotsCompleted && (
                <p className="mt-4 rounded-2xl bg-blue-50 px-3 py-2 text-sm font-bold text-[#005BC4]">
                  Отметь хотя бы один свободный слот и сохрани неделю.
                </p>
              )}
            </div>
          </section>
        )}

        {isAdminPanel && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-blue-100 bg-white p-1.5 shadow-sm" role="tablist" aria-label="Разделы админской панели">
              <div className="grid grid-cols-3 gap-1 sm:grid-cols-6">
                {([
                  ['team', 'Команда'],
                  ['events', 'Меро'],
                  ['slots', 'Слоты'],
                  ['meetings', 'Встречи'],
                  ['tasks', 'Задачи'],
                  ['faculties', 'МФ'],
                ] as const).map(([section, label]) => (
                  <button
                    key={section}
                    type="button"
                    role="tab"
                    aria-selected={adminSection === section}
                    onClick={() => setAdminSection(section)}
                    className={`min-h-11 min-w-0 rounded-xl px-1 text-xs font-black transition sm:px-4 ${adminSection === section ? 'bg-[#0069E0] text-white shadow-[0_8px_20px_rgba(0,105,224,0.2)]' : 'text-[#4D647A] hover:bg-blue-50 hover:text-[#005BC4] active:bg-blue-100'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {adminSection === 'events' && (
              <div className="space-y-4">
                <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <h2 className="font-black">Мероприятия в работе</h2>
                      <p className="mt-1 text-sm font-semibold text-slate-500">Мероприятие объединяет задачи и фильтры. Одновременно активными могут быть несколько.</p>
                    </div>
                    <button type="button" onClick={() => showEventForm ? closeWorkEventForm() : setShowEventForm(true)} className={`${primaryCompactButtonClass} w-full sm:w-auto`}>
                      {showEventForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                      {showEventForm ? 'Закрыть' : 'Добавить мероприятие'}
                    </button>
                  </div>
                  {eventNotice && <p role="status" className="mt-3 rounded-2xl bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-800">{eventNotice}</p>}
                  {eventError && <p role="alert" className="mt-3 rounded-2xl bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">{eventError}</p>}
                </div>

                {showEventForm && (
                  <form onSubmit={submitWorkEvent} className="space-y-3 rounded-3xl border border-blue-100 bg-white p-4 shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
                    <h2 className="font-black">{editingEventId ? 'Редактировать мероприятие' : 'Новое мероприятие'}</h2>
                    <Field label="Название"><input value={eventName} onChange={(event) => setEventName(event.target.value)} className={inputClass} placeholder="Например, MegaBattle 2027" /></Field>
                    <Field label="Описание"><textarea value={eventDescription} onChange={(event) => setEventDescription(event.target.value)} className={inputClass} rows={3} placeholder="Коротко: что проводим и для кого" /></Field>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Начало"><DatePickerField value={eventStartsAt} onChange={setEventStartsAt} placeholder="Не указано" /></Field>
                      <Field label="Завершение"><DatePickerField value={eventEndsAt} onChange={setEventEndsAt} placeholder="Не указано" /></Field>
                    </div>
                    <button disabled={eventSaving} className={`${primaryButtonClass} disabled:opacity-60`}>{eventSaving ? 'Сохраняю...' : editingEventId ? 'Сохранить изменения' : 'Создать мероприятие'}</button>
                  </form>
                )}

                <div className="space-y-2">
                  {allEvents.length === 0 ? <EmptyState text="Добавь первое мероприятие, чтобы разделять задачи" /> : allEvents.map((workEvent) => {
                    const eventTaskCount = state.tasks.filter((task) => task.eventId === workEvent.id).length;
                    return (
                      <div key={workEvent.id} className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="break-words font-black">{workEvent.name}</h3>
                              <span className={`rounded-full px-2.5 py-1 text-xs font-black ${workEventStatusClass(workEvent.status)}`}>{workEvent.status === 'active' ? 'В работе' : 'Завершено'}</span>
                            </div>
                            {workEvent.description && <p className="mt-2 break-words text-sm text-slate-500">{workEvent.description}</p>}
                            <p className="mt-2 text-xs font-bold text-slate-500">Задач: {eventTaskCount}{workEvent.startsAt || workEvent.endsAt ? ` · ${workEvent.startsAt || '…'} — ${workEvent.endsAt || '…'}` : ''}</p>
                          </div>
                          <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto">
                            <button type="button" disabled={eventSaving} onClick={() => startWorkEventEdit(workEvent)} className={`${secondaryButtonClass} w-full disabled:opacity-60`}>
                              <PencilSimple className="h-4 w-4" /> Редактировать
                            </button>
                            <button type="button" disabled={eventSaving} onClick={() => setWorkEventStatus(workEvent, workEvent.status === 'active' ? 'archived' : 'active')} className={`${secondaryButtonClass} w-full disabled:opacity-60`}>
                              {workEvent.status === 'active' ? 'Завершить' : 'Вернуть в работу'}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {adminSection === 'slots' && (
              <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                <h2 className="font-black">Правила заполнения слотов</h2>
                <p className="mt-1 text-sm font-semibold text-slate-500">Эти дни и часы одновременно применяются в Mini App, чате и подборе времени встреч.</p>

                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Недель вперёд">
                    <select value={slotSettingsWeeks} onChange={(event) => setSlotSettingsWeeks(Number(event.target.value))} className={inputClass}>
                      {[2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}
                    </select>
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="С">
                      <select value={slotSettingsStartHour} onChange={(event) => {
                        const hour = Number(event.target.value);
                        setSlotSettingsStartHour(hour);
                        setSlotSettingsEndHour((current) => Math.max(current, hour));
                      }} className={inputClass}>
                        {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}
                      </select>
                    </Field>
                    <Field label="До">
                      <select value={slotSettingsEndHour} onChange={(event) => setSlotSettingsEndHour(Number(event.target.value))} className={inputClass}>
                        {Array.from({ length: 24 - slotSettingsStartHour }, (_, index) => slotSettingsStartHour + index).map((hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}
                      </select>
                    </Field>
                  </div>
                </div>

                <fieldset className="mt-4">
                  <legend className="text-xs font-black text-slate-600">Рабочие дни</legend>
                  <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-7">
                    {dayLabels.map((day, dayIndex) => {
                      const selected = slotSettingsDays.includes(dayIndex);
                      return (
                        <button
                          key={day.short}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setSlotSettingsDays((current) => selected ? current.filter((value) => value !== dayIndex) : [...current, dayIndex].sort((a, b) => a - b))}
                          className={`min-h-11 rounded-xl border text-xs font-black ${pressClass} ${selected ? 'border-[#0069E0] bg-[#0069E0] text-white' : 'border-slate-200 bg-slate-50 text-[#3A526A] hover:bg-blue-50 hover:text-blue-800'}`}
                        >
                          {day.short}
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                <p className="mt-3 text-xs font-semibold text-slate-500">Сейчас: {slotSettingsDays.length} дн. · {String(slotSettingsStartHour).padStart(2, '0')}:00–{String(slotSettingsEndHour).padStart(2, '0')}:00</p>
                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button disabled={savingWeekCount || !slotSettingsDays.length || slotSettingsEndHour < slotSettingsStartHour} onClick={() => updateAvailabilitySettings(false)} className={`${secondaryButtonClass} w-full disabled:opacity-50`}>
                    {savingWeekCount ? 'Сохраняю…' : 'Сохранить правила'}
                  </button>
                  <button disabled={savingWeekCount || !slotSettingsDays.length || slotSettingsEndHour < slotSettingsStartHour} onClick={() => updateAvailabilitySettings(true)} className={`${primaryButtonClass} w-full disabled:opacity-50`}>
                    Сохранить и уведомить
                  </button>
                </div>
                {slotNotice && <p role="status" className="mt-3 rounded-2xl bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-800">{slotNotice}</p>}
                {slotError && <p role="alert" className="mt-3 rounded-2xl bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800">{slotError}</p>}
              </div>
            )}

            {adminSection === 'meetings' && (
              <div className="space-y-4">
                {showMeetingForm && editingMeetingId && (
                  <form onSubmit={submitMeeting} className="space-y-3 rounded-3xl border border-blue-100 bg-white p-4 shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="font-black">Редактировать собрание</h2>
                      <button type="button" onClick={resetMeetingForm} className={miniButtonClass}><X className="h-4 w-4" /> Отмена</button>
                    </div>
                    {meetingError && <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">{meetingError}</div>}
                    <MeetingAudiencePicker value={meetingType} onChange={setMeetingAudience} />
                    <Field label="Название"><input value={meetingTitle} onChange={(event) => setMeetingTitle(event.target.value)} className={inputClass} /></Field>
                    <div className="grid min-w-0 grid-cols-1 gap-3 min-[720px]:grid-cols-3">
                      <Field label="Дата"><DatePickerField value={meetingDate} onChange={setMeetingDate} placeholder="Выбери дату" /></Field>
                      <Field label="Время"><input type="time" min={`${String(availabilityConfig.startHour).padStart(2, '0')}:00`} max={`${String(availabilityConfig.endHour).padStart(2, '0')}:00`} value={meetingTime} onChange={(event) => setMeetingTime(event.target.value)} className={inputClass} /></Field>
                      <Field label="Длительность">
                        <select value={meetingDuration} onChange={(event) => setMeetingDuration(event.target.value)} className={selectClass}>
                          <option value="0.5">30 минут</option><option value="1">1 час</option><option value="1.5">1,5 часа</option><option value="2">2 часа</option><option value="2.5">2,5 часа</option><option value="3">3 часа</option><option value="4">4 часа</option><option value="5">5 часов</option><option value="6">6 часов</option>
                        </select>
                      </Field>
                    </div>
                    <Field label="Тема"><textarea value={meetingTopic} onChange={(event) => setMeetingTopic(event.target.value)} className={inputClass} rows={3} /></Field>
                    <Field label="Описание"><textarea value={meetingDescription} onChange={(event) => setMeetingDescription(event.target.value)} className={inputClass} rows={3} placeholder="Можно оставить пустым" /></Field>
                    {meetingType === 'competency' && (
                      <Field label="Блок">
                        <select value={meetingCompetency} onChange={(event) => selectMeetingCompetency(event.target.value)} className={selectClass}>
                          <option value="">Выбери блок</option>
                          {competencies.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                      </Field>
                    )}
                    {(meetingType === 'custom' || meetingType === 'competency') && (
                      <div className="grid grid-cols-1 gap-2">
                        {coreTeamUsers.length > 3 && <ListDisclosure expanded={showAllMeetingParticipants} onToggle={() => setShowAllMeetingParticipants((value) => !value)} total={coreTeamUsers.length} />}
                        {(showAllMeetingParticipants ? coreTeamUsers : coreTeamUsers.slice(0, 3)).map((user) => (
                          <label key={user.id} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                            <span>{user.realName}</span>
                            <input type="checkbox" checked={participants.includes(user.id)} onChange={() => setParticipants((prev) => prev.includes(user.id) ? prev.filter((id) => id !== user.id) : [...prev, user.id])} />
                          </label>
                        ))}
                      </div>
                    )}
                    <button disabled={savingMeeting} className={`${primaryButtonClass} disabled:opacity-70`}>{savingMeeting ? 'Сохраняю...' : 'Сохранить встречу'}</button>
                  </form>
                )}

                <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                  <h2 className="font-black">Управление встречами</h2>
                  <p className="mt-1 text-xs font-semibold text-slate-500">Редактирование и удаление встреч всей команды.</p>
                  <div className="mt-4 space-y-3">
                    {scheduledMeetings.length === 0 ? <EmptyState text="Встреч пока нет" /> : scheduledMeetings.map((meeting) => {
                      const host = state.users.find((user) => user.id === meeting.hostId);
                      return (
                        <div key={meeting.id} className="rounded-2xl bg-slate-50 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-black">{meeting.title}</div>
                              <div className="mt-1 text-xs font-semibold text-slate-500">{formatDateShort(meeting.date)} · {meeting.time} · {host?.realName || 'Организатор'}</div>
                            </div>
                            <div className="flex shrink-0 gap-2">
                              <button type="button" onClick={() => startMeetingEdit(meeting)} className={miniButtonClass} aria-label={`Редактировать встречу ${meeting.title}`}><PencilSimple className="h-4 w-4" /></button>
                              <button type="button" onClick={() => deleteMeeting(meeting.id)} className={`${miniButtonClass} border-rose-100 bg-rose-50 text-rose-600 hover:bg-rose-100 active:bg-rose-200`} aria-label={`Удалить встречу ${meeting.title}`}><Trash className="h-4 w-4" /></button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {adminSection === 'tasks' && (
              <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="font-black">Управление журналом задач</h2>
                    <p className="mt-1 text-xs font-semibold text-slate-500">Экспортируй историю или полностью очисти журнал задач.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a href="https://docs.google.com/spreadsheets/d/1R1MtYJfEuGNw0JI_laNmRk_Un7wIQwxt0xRYTp3mih4/edit?gid=326388773#gid=326388773" target="_blank" rel="noreferrer" className={miniButtonClass}>
                      <ArrowSquareOut className="h-4 w-4" /> Таблица лога
                    </a>
                    <button onClick={clearTaskLog} className={`${miniButtonClass} border-rose-100 bg-rose-50 text-rose-600 hover:bg-rose-100 active:bg-rose-200`}>
                      <Trash className="h-4 w-4" /> Удалить лог
                    </button>
                    <button onClick={() => setShowTaskLog((value) => !value)} className={miniButtonClass}>
                      {showTaskLog ? 'Свернуть' : 'Открыть лог'}
                    </button>
                  </div>
                </div>
                {showTaskLog && <div className="mt-4"><TaskLogView tasksByCompetency={allTasksByCompetency} users={state.users} events={allEvents} currentUser={currentUser} onEditCompletion={openCompletionPrompt} onEditTask={startTaskEdit} /></div>}
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
                        {formatDayMonth(dateForSlotDay(weekIndex * 7 + activeDays[0]))} – {formatDayMonth(dateForSlotDay(weekIndex * 7 + activeDays[activeDays.length - 1]))}
                      </p>
                    </div>
                  </div>

                  {activeDayLabels.map((day) => {
                    const absoluteDayIndex = weekIndex * 7 + day.dayIndex;
                    const selected = slots[absoluteDayIndex] || [];
                    const date = dateForSlotDay(absoluteDayIndex);
                    return (
                      <div key={`${weekIndex}-${day.full}`} className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                        <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                          <div className="min-w-0">
                            <h2 className="whitespace-nowrap text-sm font-black leading-tight sm:text-base"><span className="sm:hidden">{day.short},</span><span className="hidden sm:inline">{day.full},</span> {formatDayMonth(date)}</h2>
                            <p className="text-xs text-slate-500">
                              {selected.length ? `${selected.length} ч. свободно` : 'Пока ничего не выбрано'}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <button onClick={() => selectWholeDay(absoluteDayIndex)} className={`${secondaryButtonClass} min-h-11 whitespace-nowrap px-2.5`}>
                              {selected.length === hours.length ? 'Снять' : 'Весь день'}
                            </button>
                          </div>
                        </div>
                        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.ceil(hours.length / 2))}, minmax(0, 1fr))` }}>
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
                  <button
                    type="button"
                    onClick={() => void saveWeek(weekIndex)}
                    disabled={savingWeekIndex !== null || (!dirtyWeekIndexes.includes(weekIndex) && savedWeekIndexes.includes(weekIndex))}
                    aria-busy={savingWeekIndex === weekIndex}
                    className={`${primaryButtonClass} py-3 disabled:opacity-70`}
                  >
                    <Check className="h-5 w-5" />
                    <span aria-live="polite">
                      {savingWeekIndex === weekIndex ? 'Сохраняю...' : savedWeekIndexes.includes(weekIndex) ? 'Неделя сохранена' : `Сохранить неделю ${weekIndex + 1}`}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeTab === 'meetings' && (
          <section className="space-y-4">
            {meetingError && !showMeetingForm && <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm font-bold text-rose-800">{meetingError}</div>}
            <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-black">Общий календарь</h2>
                  <p className="mt-1 text-xs font-semibold text-slate-500">Все свободные часы команды на текущей неделе</p>
                </div>
                <a href="https://docs.google.com/spreadsheets/d/16sbBKwmrUm2b6n7nZG2UYyjBk-8IkUaGJqEd-nQwtWo/edit?gid=1910422522#gid=1910422522" target="_blank" rel="noreferrer" className={miniButtonClass}>
                  <ArrowSquareOut className="h-4 w-4" /> Открыть ОСНОВА
                </a>
              </div>
              {calendarUsers.length > 3 && (
                <ListDisclosure expanded={showFullCalendar} onToggle={() => setShowFullCalendar((value) => !value)} total={calendarUsers.length} className="mt-3" />
              )}
              <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-100">
                <table className="w-full min-w-[560px] border-collapse text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 font-black">Участник</th>
                      {activeDayLabels.map((day) => (
                        <th key={day.short} className="px-3 py-2 text-center font-black">{day.short} {formatDayMonth(dateForSlotDay(day.dayIndex))}</th>
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
                        {activeDayLabels.map((day) => {
                          const text = formatHours(alignedSlots(state.availabilities[user.id])?.[day.dayIndex] || []);
                          const filled = text !== '—';
                          return (
                            <td key={day.dayIndex} className="px-2 py-2 align-top">
                              <div className={`min-h-10 rounded-xl px-2 py-1.5 text-center font-bold ${filled ? 'bg-blue-50 text-[#0069E0]' : 'bg-slate-50 text-[#718293]'}`}>{text}</div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
              <h2 className="font-black">Календарь свободных дней</h2>
              <div className="mt-3 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${activeDays.length}, minmax(0, 1fr))` }}>
                {availabilityByDay.filter((day) => activeDays.includes(day.dayIndex)).map((day) => {
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
                            <a href={telegramLink(user.username)} onClick={(event) => openTelegramProfile(event, telegramLink(user.username))} className="text-xs font-bold text-[#0069E0]">{user.username}</a>
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
                          <a key={user.id} href={telegramLink(user.username)} onClick={(event) => openTelegramProfile(event, telegramLink(user.username))} className="rounded-xl bg-white px-3 py-2 text-sm font-bold text-slate-700">
                            {user.realName} <span className="text-[#0069E0]">{user.username}</span>
                          </a>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

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
              {meetingError && <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">{meetingError}</div>}
              <MeetingAudiencePicker value={meetingType} onChange={setMeetingAudience} />
              <Field label="Название">
                <input value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} className={inputClass} />
              </Field>
                  <div className="grid min-w-0 grid-cols-1 gap-3 min-[720px]:grid-cols-3">
                <Field label="Дата">
                  <DatePickerField value={meetingDate} onChange={setMeetingDate} placeholder="Выбери дату" />
                </Field>
                <Field label="Время">
                  <input type="time" min={`${String(availabilityConfig.startHour).padStart(2, '0')}:00`} max={`${String(availabilityConfig.endHour).padStart(2, '0')}:00`} value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} className={inputClass} />
                </Field>
                <Field label="Длительность">
                  <select value={meetingDuration} onChange={(event) => setMeetingDuration(event.target.value)} className={selectClass}>
                    <option value="0.5">30 минут</option><option value="1">1 час</option><option value="1.5">1,5 часа</option><option value="2">2 часа</option><option value="2.5">2,5 часа</option><option value="3">3 часа</option><option value="4">4 часа</option><option value="5">5 часов</option><option value="6">6 часов</option>
                  </select>
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
                  const canManage = meeting.hostId === currentUser.id;
                  const expanded = expandedMeetingId === meeting.id;
                  const invited = meeting.participants === 'all' || meeting.participants.includes(currentUser.id) || meeting.hostId === currentUser.id;
                  const attending = (meeting.attendeeIds || []).includes(currentUser.id);
                  const attendeeNames = (meeting.attendeeIds || [])
                    .map((id) => state.users.find((user) => user.id === id)?.realName)
                    .filter(Boolean);
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
                          <InfoRow label="Длительность" value={taskDurationText(Math.round(Number(meeting.duration || 1) * 60))} />
                          <InfoRow label="Формат" value={meeting.type === 'general' ? 'Общее — вся команда' : meeting.competency ? `По блоку «${meeting.competency}»` : 'По выбранным людям'} />
                          {meeting.competency && <InfoRow label="Блок" value={meeting.competency} />}
                          <InfoRow label="Тема" value={meeting.topic || 'Без темы'} />
                          {meeting.description && <InfoRow label="Описание" value={meeting.description} />}
                          <InfoRow label="Придут" value={attendeeNames.length ? `${attendeeNames.length}: ${attendeeNames.join(', ')}` : 'пока никто не подтвердил'} />
                          {!invited && !attending && <p className="rounded-2xl bg-blue-50 px-3 py-2 text-xs font-bold text-[#005BC4]">Тебя не добавили в исходный состав, но к этому собранию можно присоединиться.</p>}
                          <button
                            type="button"
                            disabled={rsvpMeetingId === meeting.id}
                            onClick={() => setMeetingAttendance(meeting, !attending)}
                            className={`${miniButtonClass} w-full disabled:opacity-60 ${attending ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100' : 'border-blue-100 bg-blue-50 text-[#005BC4] hover:bg-blue-100'}`}
                          >
                            <Check className="h-4 w-4" />
                            {rsvpMeetingId === meeting.id ? 'Сохраняю...' : attending ? 'Я приду ✓' : invited ? 'Я приду' : 'Присоединиться и приду'}
                          </button>
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
            <EventScopePicker
              events={activeEvents}
              value={selectedTaskEventId}
              onChange={(eventId) => {
                setSelectedTaskEventId(eventId);
                resetTaskForm();
                setShowTaskForm(false);
                setTaskError('');
              }}
            />
            {taskError && <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm font-bold text-rose-800">{taskError}</div>}
            {taskNotice && <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-bold text-emerald-800">{taskNotice}</div>}
            <button onClick={openTaskForm} className={primaryButtonClass}>
              {showTaskForm ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {showTaskForm ? 'Скрыть форму' : 'Создать задачу'}
            </button>
            {showTaskForm && (
              <form onSubmit={submitTask} className="space-y-3 rounded-3xl border border-blue-100 bg-white p-4 shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-black">{editingTaskId ? 'Редактировать задачу' : 'Новая задача'}</h2>
                  {editingTaskId && <button type="button" onClick={() => { resetTaskForm(); setShowTaskForm(false); }} className={miniButtonClass}><X className="h-4 w-4" /> Отмена</button>}
                </div>
                <Field label="Мероприятие">
                  <div className="rounded-2xl bg-blue-50 px-3 py-3 text-sm font-black text-[#005BC4]">{selectedTaskEvent?.name || 'Не выбрано'}</div>
                </Field>
                <Field label="Название задачи">
                  <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} className={inputClass} />
                </Field>
                <Field label="Описание">
                  <textarea value={taskDesc} onChange={(e) => setTaskDesc(e.target.value)} className={inputClass} rows={2} />
                </Field>
                <Field label="Исполнители">
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-1.5 rounded-2xl bg-slate-100 p-1.5">
                      {([
                        ['blocks', 'По блоку'],
                        ['people', 'Конкретным людям'],
                        ['open', 'Открытая'],
                      ] as const).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          aria-pressed={taskAssignmentMode === mode}
                          onClick={() => {
                            setTaskAssignmentMode(mode);
                            if (mode === 'open') setTaskAssignedTo([]);
                            if (mode === 'blocks') setTaskAssignedTo(coreTeamUsers.filter((user) => taskCompetencies.some((name) => user.primaryCompetency === name || user.competencies?.includes(name))).map((user) => user.id));
                            if (mode !== 'blocks') setShowTaskBlocks(false);
                            setTaskAssigneeSearch('');
                            setShowAllTaskAssignees(false);
                          }}
                          className={`min-h-11 min-w-0 rounded-xl px-1.5 py-2 text-xs font-black leading-tight sm:text-sm ${pressClass} ${taskAssignmentMode === mode ? 'bg-[#0069E0] text-white shadow-sm' : 'bg-white text-slate-700'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {taskAssignmentMode === 'blocks' && (
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2">
                        <button type="button" onClick={() => setShowTaskBlocks((value) => !value)} className={`${secondaryButtonClass} w-full justify-between`}>
                          <span>{taskCompetencies.length ? `Выбрано блоков: ${taskCompetencies.length}` : 'Выбрать блоки'}</span>
                          {showTaskBlocks ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
                        </button>
                        {showTaskBlocks && (
                          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {(competencies.length ? competencies : ['Общее']).map((name) => {
                              const selected = taskCompetencies.includes(name);
                              return (
                                <button key={name} type="button" aria-pressed={selected} onClick={() => toggleTaskCompetency(name)} className={`min-h-11 rounded-xl border px-3 py-2 text-left text-sm font-black ${pressClass} ${selected ? 'border-[#0069E0] bg-[#0069E0] text-white' : 'border-slate-200 bg-white text-slate-700'}`}>
                                  {selected ? '✓ ' : ''}{name}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {taskAssignmentMode !== 'open' && (
                      <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-2">
                        <div className="flex flex-col gap-2 min-[390px]:flex-row">
                          <label className="relative min-w-0 flex-1">
                            <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                            <input value={taskAssigneeSearch} onChange={(event) => setTaskAssigneeSearch(event.target.value)} className={`${inputClass} pl-10`} placeholder="Поиск по имени" aria-label="Поиск исполнителя" />
                          </label>
                          <button type="button" onClick={() => setTaskAssignedTo(taskAssignedTo.length === coreTeamUsers.length ? [] : coreTeamUsers.map((user) => user.id))} className={`${secondaryButtonClass} shrink-0 px-3`}>
                            <UsersThree className="h-4 w-4" /> {taskAssignedTo.length === coreTeamUsers.length ? 'Снять всех' : 'Выбрать всех'}
                          </button>
                        </div>
                        {!normalizedTaskAssigneeSearch && coreTeamUsers.length > 3 && <ListDisclosure expanded={showAllTaskAssignees} onToggle={() => setShowAllTaskAssignees((value) => !value)} total={coreTeamUsers.length} />}
                        {visibleTaskAssignees.map((user) => (
                          <label key={user.id} className="flex min-h-11 items-center justify-between rounded-xl bg-white px-3 py-2 text-sm font-semibold">
                            <span className="min-w-0 truncate">{user.realName}{user.id === currentUser.id ? ' · это вы' : ''}</span>
                            <input type="checkbox" checked={taskAssignedTo.includes(user.id)} onChange={() => setTaskAssignedTo((prev) => prev.includes(user.id) ? prev.filter((id) => id !== user.id) : [...prev, user.id])} />
                          </label>
                        ))}
                        {normalizedTaskAssigneeSearch && visibleTaskAssignees.length === 0 && <p className="px-2 py-3 text-center text-sm font-bold text-slate-500">Никого не нашли</p>}
                      </div>
                    )}
                  </div>
                </Field>
                <div className="grid min-w-0 grid-cols-1 gap-3 overflow-hidden sm:grid-cols-2">
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
                <Field label="ТЗ">
                  <textarea value={taskSow} onChange={(e) => setTaskSow(e.target.value)} className={inputClass} rows={2} />
                </Field>
                <Field label="Напоминания исполнителям">
                  <div className="space-y-2">
                    {taskReminders.map((reminder, index) => (
                      <div key={reminder.id || index} className="grid grid-cols-1 gap-2 rounded-2xl border border-blue-100 bg-slate-50 p-2 sm:grid-cols-[1fr_72px_88px_auto]">
                        <select value={reminder.type} onChange={(event) => setTaskReminders((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value } : item))} className={selectClass}>
                          <option value="before_deadline">За N до дедлайна</option>
                          <option value="repeat">Каждые N</option>
                        </select>
                        <input type="number" min="1" value={reminder.value ?? ''} onChange={(event) => setTaskReminders((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value === '' ? '' : Number(event.target.value) } : item))} className={inputClass} aria-label={`Интервал напоминания ${index + 1}`} />
                        <select value={reminder.unit} onChange={(event) => setTaskReminders((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, unit: event.target.value } : item))} className={selectClass}>
                          <option value="days">дней</option>
                          <option value="hours">часов</option>
                        </select>
                        <button type="button" onClick={() => setTaskReminders((current) => current.filter((_, itemIndex) => itemIndex !== index))} className={miniButtonClass} aria-label={`Удалить напоминание ${index + 1}`}><X className="h-4 w-4" /></button>
                      </div>
                    ))}
                    {taskReminders.length < 3 && (
                      <button type="button" onClick={() => setTaskReminders((current) => [...current, { id: `draft_${Date.now()}`, type: 'before_deadline', value: 1, unit: 'days' }])} className={secondaryButtonClass}>
                        <Bell className="h-4 w-4" /> Добавить напоминание
                      </button>
                    )}
                    <p className="text-xs font-semibold text-slate-500">Они отправятся автоматически. После сохранения можно также нажать «Уведомить сейчас».</p>
                  </div>
                </Field>
                <button disabled={savingTask} className={`${primaryButtonClass} disabled:opacity-70`}>
                  {savingTask ? 'Сохраняю...' : editingTaskId ? 'Сохранить изменения' : 'Сохранить задачу'}
                </button>
              </form>
            )}
            <TaskList title="Мои задачи" tasks={myTasks} users={state.users} events={allEvents} currentUser={currentUser} actionLabel="Готово" onAction={openCompletionPrompt} onRelease={onReleaseTask} onEdit={startTaskEdit} onDelete={deleteTask} onNotify={notifyTaskAssignees} onSaveComment={saveTaskComment} />
            <TaskList title="Назначенные мной" tasks={assignedByMeTasks} users={state.users} events={allEvents} currentUser={currentUser} onEdit={startTaskEdit} onDelete={deleteTask} onNotify={notifyTaskAssignees} onSaveComment={saveTaskComment} />
            <TaskList title="Открытые задачи" tasks={openTasks} users={state.users} events={allEvents} currentUser={currentUser} actionLabel="Взять" onAction={claimTask} onEdit={startTaskEdit} onDelete={deleteTask} onNotify={notifyTaskAssignees} onSaveComment={saveTaskComment} />
            <button onClick={() => setShowCompletedTasks((value) => !value)} className={secondaryButtonClass}>
              {showCompletedTasks ? <Minus className="h-4 w-4" /> : <Check className="h-4 w-4" />}
              {showCompletedTasks ? 'Скрыть выполненные задачи' : 'Посмотреть выполненные задачи'}
            </button>
            {showCompletedTasks && (
              <>
                <TaskList title="Последние выполненные" tasks={latestCompletedTasks} users={state.users} events={allEvents} currentUser={currentUser} actionLabel="Готово" onAction={() => undefined} onEdit={startTaskEdit} onEditCompletion={openCompletionPrompt} onSaveComment={saveTaskComment} />
              </>
            )}

            <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-black">Бэклог задач</h2>
                  <p className="text-xs font-semibold text-slate-500">Все задачи за всё время, разбитые по блокам.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a href="https://docs.google.com/spreadsheets/d/1R1MtYJfEuGNw0JI_laNmRk_Un7wIQwxt0xRYTp3mih4/edit?gid=326388773#gid=326388773" target="_blank" rel="noreferrer" className={miniButtonClass}>
                    <ArrowSquareOut className="h-4 w-4" />
                    Полный лог в таблице
                  </a>
                  <button onClick={() => setShowTaskLog((value) => !value)} className={miniButtonClass}>
                    {showTaskLog ? 'Свернуть' : 'Открыть лог'}
                  </button>
                </div>
              </div>
              {showTaskLog && (
                <div className="mt-4 space-y-3">
                  <TaskLogView tasksByCompetency={tasksByCompetency} users={state.users} events={allEvents} currentUser={currentUser} onEditCompletion={openCompletionPrompt} onEditTask={startTaskEdit} />
                </div>
              )}
            </div>
          </section>
        )}

        {(activeTab === 'team' || (isAdminPanel && adminSection === 'team')) && (
          <section className="space-y-4">
            {teamError && <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm font-bold text-rose-800">{teamError}</div>}
            <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                <button type="button" onClick={() => setBroadcastOpen((value) => !value)} className={`${secondaryButtonClass} w-full justify-between`} aria-expanded={broadcastOpen}>
                  <span className="flex items-center gap-2"><PaperPlaneTilt className="h-4 w-4" /> Создать рассылку</span>
                  {broadcastOpen ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
                </button>
                {broadcastOpen && (
                  <form onSubmit={submitBroadcast} className="mt-4 space-y-3">
                    <Field label="Получатели">
                      <div className="grid grid-cols-2 gap-1.5 rounded-2xl bg-slate-100 p-1.5 min-[520px]:grid-cols-3">
                        {([['all', 'Все'], ['blocks', 'По блоку'], ['people', 'Конкретные люди']] as const).map(([mode, label]) => (
                          <button key={mode} type="button" aria-pressed={broadcastMode === mode} onClick={() => setBroadcastRecipientMode(mode)} className={`min-h-11 min-w-0 rounded-xl px-1.5 py-2 text-xs font-black leading-tight ${mode === 'people' ? 'col-span-2 min-[520px]:col-span-1' : ''} ${pressClass} ${broadcastMode === mode ? 'bg-[#0069E0] text-white shadow-sm' : 'bg-white text-slate-700'}`}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </Field>

                    {broadcastMode === 'blocks' && (
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2">
                        <button type="button" onClick={() => setShowBroadcastBlocks((value) => !value)} className={`${secondaryButtonClass} w-full justify-between`} aria-expanded={showBroadcastBlocks}>
                          <span>{broadcastBlocks.length ? `Выбрано блоков: ${broadcastBlocks.length}` : 'Выбрать блоки'}</span>
                          {showBroadcastBlocks ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
                        </button>
                        {showBroadcastBlocks && (
                          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {competencies.map((name) => {
                              const selected = broadcastBlocks.includes(name);
                              return <button key={name} type="button" aria-pressed={selected} onClick={() => toggleBroadcastBlock(name)} className={`min-h-11 rounded-xl border px-3 py-2 text-left text-sm font-black ${pressClass} ${selected ? 'border-[#0069E0] bg-[#0069E0] text-white' : 'border-slate-200 bg-white text-slate-700'}`}>{selected ? '✓ ' : ''}{name}</button>;
                            })}
                            {!competencies.length && <p className="px-2 py-3 text-sm font-bold text-slate-500">Сначала добавь блоки команды.</p>}
                          </div>
                        )}
                      </div>
                    )}

                    {broadcastMode !== 'all' && (
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2">
                        <button type="button" onClick={() => setShowBroadcastPeople((value) => !value)} className={`${secondaryButtonClass} w-full justify-between`} aria-expanded={showBroadcastPeople}>
                          <span>{broadcastRecipients.length ? `Выбрано людей: ${broadcastRecipients.length}` : 'Выбрать людей'}</span>
                          {showBroadcastPeople ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
                        </button>
                        {showBroadcastPeople && (
                          <div className="mt-2 space-y-2">
                            <label className="relative block min-w-0">
                              <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                              <input type="search" value={broadcastSearch} onChange={(event) => setBroadcastSearch(event.target.value)} className={`${inputClass} pl-10`} placeholder="Поиск по имени" aria-label="Поиск получателя рассылки" />
                            </label>
                            <button type="button" onClick={() => setBroadcastRecipients(broadcastRecipients.length === coreTeamUsers.length ? [] : coreTeamUsers.map((user) => user.id))} className={`${secondaryButtonClass} w-full`}>
                              <UsersThree className="h-4 w-4" /> {broadcastRecipients.length === coreTeamUsers.length ? 'Снять всех' : 'Выбрать всех'}
                            </button>
                            {matchedBroadcastUsers.map((user) => (
                              <label key={user.id} className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 text-sm font-semibold">
                                <span className="min-w-0">
                                  <strong className="block truncate">{user.realName}{user.id === currentUser.id ? ' · это вы' : ''}</strong>
                                  {!user.telegramId && <span className="block truncate text-xs font-bold text-amber-700">Нужно открыть бота через /start</span>}
                                </span>
                                <input type="checkbox" checked={broadcastRecipients.includes(user.id)} onChange={() => setBroadcastRecipients((current) => current.includes(user.id) ? current.filter((id) => id !== user.id) : [...current, user.id])} />
                              </label>
                            ))}
                            {!matchedBroadcastUsers.length && <p className="px-2 py-3 text-center text-sm font-bold text-slate-500">Никого не нашли</p>}
                          </div>
                        )}
                      </div>
                    )}

                    <Field label="Заголовок — необязательно"><input value={broadcastTitle} onChange={(event) => setBroadcastTitle(event.target.value)} className={inputClass} maxLength={120} placeholder="Например, Важное обновление" /></Field>
                    <Field label="Текст рассылки"><textarea required value={broadcastBody} onChange={(event) => setBroadcastBody(event.target.value)} className={inputClass} rows={4} maxLength={4000} placeholder="Что нужно сообщить команде" /></Field>
                    <button disabled={broadcastSaving} className={`${primaryButtonClass} disabled:opacity-60`}><PaperPlaneTilt className="h-4 w-4" /> {broadcastSaving ? 'Отправляю...' : 'Отправить рассылку'}</button>
                    {broadcastNotice && <p role="status" className="rounded-2xl bg-emerald-50 px-3 py-2 text-sm font-black text-emerald-800">{broadcastNotice}</p>}
                  </form>
                )}
            </div>
            {isAdminPanel && (
              <button onClick={() => setShowAddUserForm((value) => !value)} className={primaryButtonClass}>
                {showAddUserForm ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                Добавить человека
              </button>
            )}

            {isAdminPanel && showAddUserForm && (
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

            {isAdminPanel && (
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
                        <div className="flex min-w-0 items-center gap-3">
                          <UserAvatar user={user} className="h-11 w-11 shrink-0 rounded-xl" />
                          <div className="min-w-0">
                          <div className="font-black">{user.realName}</div>
                          <a href={telegramLink(user.username)} className="text-sm font-bold text-[#0069E0]" onClick={(event) => openTelegramProfile(event, telegramLink(user.username))}>
                            {user.username}
                          </a>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-[#0069E0]">{user.primaryCompetency || 'Блок не выбран'}</div>
                          <div className={`mt-1 rounded-full px-2.5 py-1 text-xs font-black ${user.registered ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-[#4D647A]'}`}>
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
                              <InfoRow label="Последняя активность" value={formatDateTimeShort(user.lastSeenAt) || 'ещё не заходил'} />
                              <InfoRow label="Главный блок" value={user.primaryCompetency || 'не выбран'} />
                              <InfoRow label="Блоки" value={(user.competencies || []).join(', ') || 'не выбраны'} />
                              {(isAdminPanel || user.id === currentUser.id) && (
                                <div className="flex gap-2 pt-2">
                                  <button onClick={() => startUserEdit(user)} className={miniButtonClass}>
                                    <PencilSimple className="h-4 w-4" />
                                    Редактировать
                                  </button>
                                  {isAdminPanel && (
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
                              <div className={`grid gap-3 ${isAdminPanel ? 'grid-cols-2' : 'grid-cols-1'}`}>
                                <Field label="ДР">
                                  <DatePickerField value={userDraft.birthday} onChange={(value) => setUserDraft((prev) => ({ ...prev, birthday: value }))} placeholder="Выбери дату" fullYear />
                                </Field>
                                {isAdminPanel && (
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
                                <button type="button" disabled={savingUserId === user.id} onClick={(event) => { event.stopPropagation(); void updateUser(user.id); }} className={`${miniButtonClass} disabled:opacity-60`}>
                                  {savingUserId === user.id ? 'Сохраняю...' : 'Сохранить'}
                                </button>
                                <button type="button" disabled={savingUserId === user.id} onClick={(event) => { event.stopPropagation(); setEditingUserId(null); }} className={miniButtonClass}>Отмена</button>
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

        {(activeTab === 'faculties' || (isAdminPanel && adminSection === 'faculties')) && (
          <section className="space-y-4">
            {isAdminPanel && (
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
                        value={facultyUserDraft.role}
                        onChange={(e) => setFacultyUserDraft((prev) => ({ ...prev, role: e.target.value as User['role'] }))}
                        className={selectClass}
                      >
                        <option value="faculty_responsible">Ответственный</option>
                        <option value="faculty_helper">Помощник</option>
                      </select>
                    </Field>
                    <Field label="Компетенция">
                      <select value={facultyUserDraft.competencies[0] || ''} onChange={(e) => setFacultyUserDraft((prev) => ({ ...prev, competencies: e.target.value ? [e.target.value] : [] }))} className={selectClass}>
                        <option value="">Не выбрана</option>
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
              </>
            )}

            {activeTab === 'faculties' && (
              <>
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
                                          <a href={telegramLink(user.username)} onClick={(event) => openTelegramProfile(event, telegramLink(user.username))} className="font-bold text-[#0069E0]">{user.username}</a>
                                          <div className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-black ${user.registered ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-[#4D647A]'}`}>
                                            {user.registered ? 'Зарегистрирован' : 'Не зарегистрирован'}
                                          </div>
                                        </div>
                                        <div className="flex flex-wrap justify-end gap-2">
                                          <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-black text-[#0069E0]">{user.role === 'faculty_helper' ? user.competencies?.[0] || 'Роль не выбрана' : 'Ответственный'}</span>
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
                                            value={facultyEditDraft.role}
                                            onChange={(e) => setFacultyEditDraft((prev) => ({ ...prev, role: e.target.value as User['role'] }))}
                                            className={selectClass}
                                          >
                                            <option value="faculty_responsible">Ответственный</option>
                                            <option value="faculty_helper">Помощник</option>
                                          </select>
                                        </Field>
                                        <Field label="Компетенция">
                                          <select value={facultyEditDraft.competencies[0] || ''} onChange={(e) => setFacultyEditDraft((prev) => ({ ...prev, competencies: e.target.value ? [e.target.value] : [] }))} className={selectClass}>
                                            <option value="">Не выбрана</option>
                                            {facultyCompetencies.map((name) => <option key={name} value={name}>{name}</option>)}
                                          </select>
                                        </Field>
                                      </div>
                                      <div className="flex gap-2">
                                        <button type="button" onClick={() => updateFacultyUser(user.id)} className={miniButtonClass}>Сохранить</button>
                                        <button type="button" onClick={() => setEditingFacultyUserId(null)} className={miniButtonClass}>Отмена</button>
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
                  <Field label="Мероприятие">
                    <select value={facultyTaskDraft.eventId} onChange={(event) => setFacultyTaskDraft((current) => ({ ...current, eventId: event.target.value }))} className={selectClass}>
                      <option value="">Без мероприятия</option>
                      {(editingFacultyTaskId ? allEvents : activeEvents).map((workEvent) => <option key={workEvent.id} value={workEvent.id}>{workEvent.name}{workEvent.status === 'archived' ? ' · завершено' : ''}</option>)}
                    </select>
                  </Field>
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
                  <Field label="Описание — необязательно">
                    <textarea value={facultyTaskDraft.description} onChange={(e) => setFacultyTaskDraft((prev) => ({ ...prev, description: e.target.value }))} className={inputClass} rows={3} />
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
                    <button type="button" onClick={() => { setEditingFacultyTaskId(null); setCollapsedFacultyReminders([]); setFacultyTaskDraft({ facultyId: faculties[0]?.id || '', competency: '', eventId: '', title: '', description: '', deadline: '', assignedTo: [], reminders: [] }); }} className={secondaryButtonClass}>
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
                        const canEdit = isAdminPanel || task.creatorId === currentUser.id;
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
                                <div className="flex shrink-0 flex-col gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingFacultyTaskId(task.id);
                                      setFacultyTaskErrors({});
                                      setFacultyTaskDraft({
                                        facultyId: task.facultyId || '',
                                        competency: task.competency || '',
                                        eventId: task.eventId || '',
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
                                    <PencilSimple className="h-4 w-4" /> Редактировать
                                  </button>
                                  <button type="button" onClick={() => deleteTask(task.id)} className={`${miniButtonClass} border-rose-200 bg-rose-50 text-rose-700`}>
                                    <Trash className="h-4 w-4" /> Удалить
                                  </button>
                                </div>
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
                      <a href="/api/integrations/google-sheets/task-log" target="_blank" rel="noreferrer" className={miniButtonClass}>
                        <ArrowSquareOut className="h-4 w-4" />
                        Таблица лога
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
                <h2 id="task-completion-title" className="text-xl font-black">{editingCompletedTask ? 'Исправить выполнение' : 'Сколько времени заняла задача?'}</h2>
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
            <div className="mt-4">
              <Field label="Комментарий по результату">
                <textarea
                  value={completionComment}
                  onChange={(event) => setCompletionComment(event.target.value)}
                  className={inputClass}
                  rows={3}
                  placeholder="Что заняло больше времени, что получилось и что важно знать автору"
                />
              </Field>
              <p className="mt-2 text-xs font-semibold text-slate-500">Комментарий необязателен, но останется в истории задачи.</p>
            </div>
            <div className="mt-5 space-y-2">
              <button type="button" disabled={savingCompletion} onClick={() => completeTaskWithTime(true)} className={`${primaryButtonClass} disabled:opacity-60`}>
                {savingCompletion ? 'Сохраняю...' : editingCompletedTask ? 'Сохранить исправления' : 'Сохранить и завершить'}
              </button>
              {editingCompletedTask ? (
                <button type="button" disabled={savingCompletion} onClick={() => void reopenCompletedTask()} className={`${secondaryButtonClass} w-full border-amber-200 bg-amber-50 text-amber-800 disabled:opacity-60`}>
                  Вернуть в работу
                </button>
              ) : (
                <button type="button" disabled={savingCompletion} onClick={() => completeTaskWithTime(false)} className={`${secondaryButtonClass} w-full disabled:opacity-60`}>
                  Завершить без времени
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {avatarEditorSource && (
        <AvatarCropEditor source={avatarEditorSource} saving={avatarSaving} onCancel={() => setAvatarEditorSource(null)} onSave={saveAvatar} />
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
const inputClass = 'min-w-0 max-w-full w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-base font-semibold outline-none transition focus:border-[#0069E0] focus:bg-white';
const selectClass = 'min-w-0 max-w-full w-full appearance-none rounded-2xl border border-blue-100 bg-white px-3 py-3 pr-10 text-base font-black text-slate-950 shadow-sm outline-none transition hover:border-[#0069E0]/40 hover:bg-slate-50 focus:border-[#0069E0] focus:bg-white focus:shadow-[0_0_0_4px_rgba(0,105,224,0.10)] [background-image:linear-gradient(45deg,transparent_50%,#0069E0_50%),linear-gradient(135deg,#0069E0_50%,transparent_50%)] [background-position:calc(100%-18px)_50%,calc(100%-13px)_50%] [background-repeat:no-repeat] [background-size:6px_6px,6px_6px]';
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
    <div className="block min-w-0 max-w-full" role="group" aria-label={label}>
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
  const focusedRef = useRef(false);
  const dirtyRef = useRef(false);
  const [draft, setDraft] = useState(() => shortDateToInputDate(value));
  useEffect(() => {
    if (!focusedRef.current) setDraft(shortDateToInputDate(value));
  }, [value]);
  return (
    <div className="min-w-0 max-w-full">
      <input
        type="date"
        value={draft}
        onFocus={() => { focusedRef.current = true; dirtyRef.current = false; }}
        onChange={(event) => {
          const next = event.target.value;
          dirtyRef.current = true;
          setDraft(next);
          if (/^\d{4}-\d{2}-\d{2}$/.test(next)) onChange(inputDateToShortDate(next, withYear, fullYear));
        }}
        onBlur={() => {
          focusedRef.current = false;
          if (dirtyRef.current && !draft) onChange('');
          setDraft(shortDateToInputDate(draft ? inputDateToShortDate(draft, withYear, fullYear) : ''));
        }}
        className={`${inputClass} mega-date-input block min-w-0 max-w-full cursor-pointer overflow-hidden pr-2 [inline-size:100%] [min-inline-size:0] ${error ? 'border-rose-300 bg-rose-50 focus:border-rose-500' : ''}`}
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

function MeetingAudiencePicker({ value, onChange }: { value: 'general' | 'custom' | 'competency'; onChange: (value: 'general' | 'custom' | 'competency') => void }) {
  const options = [
    { id: 'general' as const, title: 'Общее', description: 'Приглашена вся команда' },
    { id: 'competency' as const, title: 'По блоку', description: 'Люди выбранного блока' },
    { id: 'custom' as const, title: 'По людям', description: 'Состав выбирается вручную' },
  ];
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-black uppercase tracking-wide text-slate-500">Кого приглашаем</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
            className={`rounded-2xl border px-3 py-3 text-left transition ${pressClass} ${meetingAudienceOptionClass(value === option.id)}`}
          >
            <span className="block text-sm font-black">{option.title}</span>
            <span className="mt-1 block text-xs font-semibold opacity-75">{option.description}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function EventScopePicker({ events, value, onChange }: { events: WorkEvent[]; value: string; onChange: (value: string) => void }) {
  if (!events.length) {
    return <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900">Нет активных мероприятий. Администратору нужно добавить или вернуть мероприятие в работу.</div>;
  }
  const useSingleColumn = events.some((workEvent) => workEvent.name.length > 24)
    || events.some((workEvent, index) => index % 2 === 1 && workEvent.name.length + events[index - 1].name.length > 38);
  return (
    <div className="rounded-3xl border border-blue-100 bg-white p-3 shadow-sm">
      <div className="mb-2 px-1 text-xs font-black uppercase tracking-wide text-slate-500">Мероприятие</div>
      <div className={`grid gap-2 ${useSingleColumn ? 'grid-cols-1' : 'grid-cols-2'}`} role="radiogroup" aria-label="Фильтр задач по мероприятию">
        {events.map((workEvent, index) => {
          const selected = value === workEvent.id;
          const fillsOddLastRow = !useSingleColumn && events.length % 2 === 1 && index === events.length - 1;
          return (
            <button key={workEvent.id} type="button" role="radio" aria-checked={selected} onClick={() => onChange(workEvent.id)} className={`min-h-12 min-w-0 break-words rounded-2xl border px-3 py-2 text-sm font-black leading-tight ${fillsOddLastRow ? 'col-span-2' : ''} ${pressClass} ${selected ? 'border-[#0069E0] bg-[#0069E0] text-white shadow-[0_8px_20px_rgba(0,105,224,0.2)]' : 'border-blue-100 bg-blue-50 text-[#005BC4] hover:bg-blue-100'}`}>
              {workEvent.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UserAvatar({ user, className = '' }: { user: User; className?: string }) {
  return user.avatarDataUrl
    ? <img src={user.avatarDataUrl} alt={`Аватар ${user.realName}`} className={`shrink-0 bg-blue-50 object-cover ${className}`} />
    : <div className={`flex shrink-0 items-center justify-center bg-[#0069E0] text-white ${className}`}><UserCircle className="h-3/5 w-3/5" weight="fill" /></div>;
}

function AvatarCropEditor({ source, saving, onCancel, onSave }: { source: string; saving: boolean; onCancel: () => void; onSave: (dataUrl: string) => Promise<void> }) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);

  useEffect(() => {
    const image = imageRef.current;
    const canvas = previewRef.current;
    if (!imageLoaded || !image || !canvas) return;
    drawAvatarCrop(image, canvas, zoom, offsetX, offsetY);
  }, [imageLoaded, offsetX, offsetY, source, zoom]);

  const crop = async () => {
    const image = imageRef.current;
    if (!image?.naturalWidth || !image.naturalHeight) return;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    if (!drawAvatarCrop(image, canvas, zoom, offsetX, offsetY)) return;
    const dataUrl = canvas.toDataURL('image/webp', 0.82);
    await onSave(dataUrl.startsWith('data:image/webp') ? dataUrl : canvas.toDataURL('image/jpeg', 0.82));
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/65 p-3 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-labelledby="avatar-editor-title">
      <div className="w-full max-w-md rounded-3xl bg-white p-4 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <div><h2 id="avatar-editor-title" className="text-lg font-black">Обрезать аватар</h2><p className="text-xs font-semibold text-slate-500">Перемести кадр ползунками и выбери масштаб.</p></div>
          <button type="button" onClick={onCancel} className={miniButtonClass} aria-label="Закрыть"><X className="h-4 w-4" /></button>
        </div>
        <div className="mx-auto mt-4 aspect-square w-full max-w-[280px] overflow-hidden rounded-3xl bg-slate-100">
          <canvas ref={previewRef} width="560" height="560" aria-label="Предпросмотр аватара" className="h-full w-full" />
          <img ref={imageRef} src={source} onLoad={() => setImageLoaded(true)} alt="" className="sr-only" />
        </div>
        <div className="mt-4 space-y-3">
          <Field label="Масштаб"><input type="range" min="1" max="3" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} className="w-full" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="По горизонтали"><input type="range" min="-100" max="100" value={offsetX} onChange={(event) => setOffsetX(Number(event.target.value))} className="w-full" /></Field>
            <Field label="По вертикали"><input type="range" min="-100" max="100" value={offsetY} onChange={(event) => setOffsetY(Number(event.target.value))} className="w-full" /></Field>
          </div>
          <button type="button" disabled={saving || !imageLoaded} onClick={() => void crop()} className={`${primaryButtonClass} disabled:opacity-60`}>{saving ? 'Сохраняю...' : imageLoaded ? 'Сохранить аватар' : 'Загружаю фото...'}</button>
        </div>
      </div>
    </div>
  );
}

function TaskList({
  title,
  tasks,
  users,
  events,
  currentUser,
  actionLabel,
  onAction,
  onRelease,
  onEdit,
  onDelete,
  onNotify,
  onSaveComment,
  onEditCompletion,
}: {
  title: string;
  tasks: Task[];
  users: User[];
  events: WorkEvent[];
  currentUser: User;
  actionLabel?: string;
  onAction?: (taskId: string) => void;
  onRelease?: (taskId: string) => void;
  onEdit?: (task: Task) => void;
  onDelete?: (taskId: string) => void;
  onNotify?: (taskId: string) => void;
  onSaveComment?: (taskId: string, assigneeId: string, side: 'executor' | 'coordinator', text: string) => Promise<boolean>;
  onEditCompletion?: (taskId: string) => void;
}) {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [savingNoteKey, setSavingNoteKey] = useState('');
  const [savedNoteKey, setSavedNoteKey] = useState('');
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
          const workEvent = events.find((item) => item.id === task.eventId);
          const executors = taskAssigneeIds(task).map((id) => users.find((user) => user.id === id)).filter(Boolean) as User[];
          const isMine = taskAssigneeIds(task).includes(currentUser.id);
          const canCoordinate = currentUser.role === 'admin' || task.creatorId === currentUser.id;
          return (
          <div key={task.id} className={`rounded-3xl border border-blue-100 bg-white p-4 shadow-sm ${pressClass}`} onClick={() => setExpandedTaskId(expanded ? null : task.id)}>
            <div className="flex flex-col items-stretch gap-3 min-[380px]:flex-row min-[380px]:items-start min-[380px]:justify-between">
              <div className="min-w-0">
                <h3 className="font-black">{task.title}</h3>
                <p className="mt-1 text-sm text-slate-500">{task.description}</p>
              </div>
              {task.status !== 'completed' && onAction && actionLabel && (
                <button onClick={(event) => { event.stopPropagation(); onAction(task.id); }} className={`mega-primary-button w-full shrink-0 rounded-full bg-[#0069E0] px-3 py-2 text-xs font-black text-white hover:bg-[#1677E8] active:bg-[#0058BD] min-[380px]:w-auto ${pressClass}`}>
                  {actionLabel}
                </button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold text-slate-500">
              <span className="max-w-full truncate rounded-full bg-slate-950 px-2.5 py-1 text-white">
                {workEvent?.name || 'Без мероприятия'}
              </span>
              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[#0069E0]">
                {taskCompetencyNames(task).join(', ') || 'Без блока'}
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
                <InfoRow label="Мероприятие" value={workEvent?.name || 'Без мероприятия'} />
                <InfoRow label="Блоки" value={taskCompetencyNames(task).join(', ') || 'Без блока'} />
                <InfoRow label="Статус" value={task.status === 'open' ? 'Открытая' : task.status === 'completed' ? 'Готово' : 'В работе'} />
                <InfoRow label="Исполнители" value={executors.length ? executors.map((user) => user.realName).join(', ') : 'пока никто'} />
                {executors.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <div className="text-xs font-black uppercase tracking-wide text-slate-500">Что делает каждый исполнитель</div>
                    {executors.map((executor) => {
                      const note = task.assigneeNotes?.[executor.id] || {};
                      const completionComment = task.completionComments?.[executor.id] || '';
                      const side = executor.id === currentUser.id ? 'executor' as const : canCoordinate ? 'coordinator' as const : null;
                      const draftKey = `${task.id}:${executor.id}:${side || 'view'}`;
                      const history = note.history?.length ? note.history : [
                        ...(note.executor ? [{ id: `${task.id}:${executor.id}:legacy-executor`, authorId: executor.id, side: 'executor' as const, text: note.executor, createdAt: note.updatedAt || '' }] : []),
                        ...(note.coordinator ? [{ id: `${task.id}:${executor.id}:legacy-coordinator`, authorId: task.creatorId || '', side: 'coordinator' as const, text: note.coordinator, createdAt: note.updatedAt || '' }] : []),
                      ];
                      return (
                        <details key={executor.id} className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                          <summary className="cursor-pointer list-none font-black text-slate-800">
                            {executor.realName}
                            <span className="ml-2 text-xs font-semibold text-slate-500">{history.length || completionComment ? `${history.length + (completionComment ? 1 : 0)} комм.` : 'без комментариев'}</span>
                          </summary>
                          <div className="mt-3 space-y-2 text-xs">
                            {history.length ? history.map((comment) => {
                              const author = users.find((user) => user.id === comment.authorId);
                              return (
                                <div key={comment.id} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                                  <div className="flex flex-wrap items-center justify-between gap-2 font-black text-slate-700">
                                    <span>{author?.realName || (comment.side === 'executor' ? executor.realName : 'Координатор')}</span>
                                    {comment.createdAt && <span className="font-semibold text-slate-400">{formatDateTimeShort(comment.createdAt)}</span>}
                                  </div>
                                  <p className="mt-1 whitespace-pre-wrap text-slate-600">{comment.text}</p>
                                </div>
                              );
                            }) : <p className="text-slate-500">Комментариев пока нет</p>}
                            {completionComment && <InfoRow label="При завершении" value={completionComment} />}
                            {task.status !== 'completed' && side && onSaveComment && (
                              <div className="space-y-2 pt-1">
                                <textarea
                                  value={noteDrafts[draftKey] ?? ''}
                                  onChange={(event) => setNoteDrafts((current) => ({ ...current, [draftKey]: event.target.value }))}
                                  className={inputClass}
                                  rows={2}
                                  placeholder={side === 'executor' ? 'Напиши, что сейчас делаешь или что мешает' : 'Уточнение или обратная связь исполнителю'}
                                />
                                <button
                                  type="button"
                                  disabled={savingNoteKey === draftKey || !(noteDrafts[draftKey] || '').trim()}
                                  onClick={async () => {
                                    setSavingNoteKey(draftKey);
                                    setSavedNoteKey('');
                                    const saved = await onSaveComment(task.id, executor.id, side, noteDrafts[draftKey] || '');
                                    if (saved) {
                                      setSavedNoteKey(draftKey);
                                      setNoteDrafts((current) => ({ ...current, [draftKey]: '' }));
                                    }
                                    setSavingNoteKey('');
                                  }}
                                  className={`${miniButtonClass} disabled:opacity-60`}
                                >
                                  <ChatCircleText className="h-4 w-4" /> {savingNoteKey === draftKey ? 'Сохраняю...' : 'Сохранить комментарий'}
                                </button>
                                {savedNoteKey === draftKey && <p role="status" className="text-xs font-black text-emerald-700">Комментарий сохранён</p>}
                              </div>
                            )}
                          </div>
                        </details>
                      );
                    })}
                  </div>
                )}
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
                {canCoordinate && (
                  <div className="flex flex-wrap gap-2 pt-2">
                    {onEdit && <button type="button" onClick={() => onEdit(task)} className={miniButtonClass}><PencilSimple className="h-4 w-4" /> Редактировать</button>}
                    {onNotify && task.status !== 'completed' && <button type="button" onClick={() => onNotify(task.id)} className={miniButtonClass}><Bell className="h-4 w-4" /> Уведомить сейчас</button>}
                    {onDelete && task.status !== 'completed' && <button type="button" onClick={() => onDelete(task.id)} className={`${miniButtonClass} border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100`}><Trash className="h-4 w-4" /> Удалить задачу</button>}
                  </div>
                )}
                {task.status === 'completed' && (isMine || currentUser.role === 'admin') && onEditCompletion && (
                  <button type="button" onClick={() => onEditCompletion(task.id)} className={`${miniButtonClass} border-amber-200 bg-amber-50 text-amber-800`}>
                    <PencilSimple className="h-4 w-4" /> Исправить выполнение
                  </button>
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

function TaskLogView({ tasksByCompetency, users, events, currentUser, onEditCompletion, onEditTask }: { tasksByCompetency: Record<string, Task[]>; users: User[]; events: WorkEvent[]; currentUser: User; onEditCompletion: (taskId: string) => void; onEditTask: (task: Task) => void }) {
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
                const workEvent = events.find((item) => item.id === task.eventId);
                const executors = taskAssigneeIds(task)
                  .map((id) => users.find((user) => user.id === id)?.realName)
                  .filter(Boolean)
                  .join(', ');
                const canEditCompletion = currentUser.role === 'admin' || taskAssigneeIds(task).includes(currentUser.id);
                const canEditTask = currentUser.role === 'admin' || task.creatorId === currentUser.id;
                return (
                  <div key={task.id} className="rounded-2xl bg-white p-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-black">{task.title}</div>
                        <div className="mt-1 text-xs font-black text-[#0069E0]">{workEvent?.name || 'Без мероприятия'}</div>
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
                    {(canEditCompletion || canEditTask) && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {canEditCompletion && <button type="button" onClick={() => onEditCompletion(task.id)} className={`${miniButtonClass} border-amber-200 bg-amber-50 text-amber-800`}><PencilSimple className="h-4 w-4" /> Исправить выполнение</button>}
                        {canEditTask && <button type="button" onClick={() => onEditTask(task)} className={miniButtonClass}><PencilSimple className="h-4 w-4" /> Редактировать задачу</button>}
                      </div>
                    )}
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
              <a href={telegramLink(user.username)} onClick={(event) => openTelegramProfile(event, telegramLink(user.username))} className="font-bold text-[#0069E0] underline decoration-blue-200">
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
    <div className="flex items-start justify-between gap-4">
      <span className="min-w-0 text-slate-400">{label}</span>
      {href ? (
        <a href={href} onClick={(event) => openTelegramProfile(event, href)} className="min-w-0 max-w-[60%] break-words text-right font-bold text-[#0069E0] [overflow-wrap:anywhere]">{value}</a>
      ) : (
        <span className="min-w-0 max-w-[60%] break-words text-right font-bold text-slate-700 [overflow-wrap:anywhere]">{value}</span>
      )}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-3xl border border-dashed border-blue-100 bg-white/70 p-5 text-center text-sm font-bold text-slate-400">{text}</div>;
}
