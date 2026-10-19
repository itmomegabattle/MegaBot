import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  CalendarDots,
  UsersThree,
  GraduationCap,
  Briefcase,
  Shield,
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
import { Meeting, MeetingKind, SimulationState, Task, User, WorkEvent } from '../types';
import { alignAvailabilityToWeek, currentAvailabilityWeekStart, normalizeAvailabilityConfig } from '../availabilityConfig';
import { mergeAvailabilityDraft } from '../availabilityWeekMutation';
import { meetingDurationError, meetingKindText, normalizeMeetingKind } from '../meetingKind';
import { meetingEndTimestamp, meetingPhase, meetingStartTimestamp } from '../meetingLifecycle';
import { meetingRsvpFor, normalizedMeetingRsvps } from '../meetingRsvp';
import { readFormDraft, readLatestFormDraft, removeFormDraft, writeFormDraft } from '../formDrafts';
import { drawAvatarCrop } from '../avatarCrop';
import { projectDateDeadlineInstant } from '../projectTime';
import { idempotentPost } from '../idempotentRequest';
import { broadcastJson, broadcastRequestKey, broadcastScheduledAt, broadcastTimeLabel } from '../broadcastClient';
import BroadcastHistory from './BroadcastHistory';
import BroadcastGroupPicker, { BroadcastGroupOption } from './BroadcastGroupPicker';
import {
  TASK_EVENT_SCOPE_ALL,
  TASK_EVENT_SCOPE_ARCHIVED,
  TASK_EVENT_SCOPE_NONE,
  filterTasksByEventScope,
  newTaskEventIdForScope,
} from '../taskEventScope';
import { Badge, Button, DialogSheet, Field, InlineNotice, SegmentedControl as Segmented } from './ui';

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
  onSaveAvailability: (weekStart: string, days: Record<number, number[]>, hardUnavailableDays: number[], out: boolean, expectedVersion: number) => Promise<boolean>;
  onScheduleMeeting: (meetingData: any) => Promise<boolean>;
  onCreateTask: (taskData: any) => Promise<boolean>;
  onClaimTask: (taskId: string) => Promise<boolean>;
  onCompleteTask: (taskId: string, timeSpentMinutes?: number, completionComment?: string) => Promise<boolean>;
  onReleaseTask: (taskId: string) => void;
  onRefreshState: () => boolean | Promise<boolean>;
  onRenameAvailabilityWeek: (weekIndex: number, weekStart: string, name: string, description: string) => Promise<boolean>;
}

type MeetingSuggestion = {
  weekIndex: number;
  date: string;
  dayIndex: number;
  hour: number;
  endHour?: number;
  duration?: number;
  count: number;
  total: number;
  canUsers: Pick<User, 'id' | 'realName' | 'username'>[];
  cannotUsers: (Pick<User, 'id' | 'realName' | 'username'> & { reason: 'out' | 'not_marked' | 'inconvenient' })[];
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
const formatDecimalHour = (value: number) => {
  const hour = Math.floor(value);
  const minutes = Math.round((value - hour) * 60);
  return `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};
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
const meetingDraftFingerprint = (meeting?: Meeting) => meeting ? JSON.stringify({
  title: meeting.title,
  kind: normalizeMeetingKind(meeting.kind),
  eventId: meeting.eventId || '',
  type: meeting.type,
  date: formatDateShort(meeting.date),
  time: meeting.time,
  duration: String(meeting.duration || 1),
  topic: meeting.topic || '',
  description: meeting.description || '',
  competency: meeting.competency || '',
  participants: meeting.participants === 'all' ? 'all' : [...meeting.participants].sort(),
}) : '';
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
  return projectDateDeadlineInstant(value)?.getTime() ?? null;
};

type TaskFormDraft = {
  editingTaskId: string | null;
  baseline: string;
  baseVersion: number | null;
  title: string;
  description: string;
  competencies: string[];
  deadline: string;
  assignedTo: string[];
  assignmentMode: 'blocks' | 'people' | 'open';
  sow: string;
  priority: Task['priority'];
  reminders: any[];
  eventId: string;
};

type MeetingFormDraft = {
  editingMeetingId: string | null;
  baseline: string;
  baseFingerprint: string;
  kind: MeetingKind;
  eventId: string;
  title: string;
  date: string;
  time: string;
  duration: string;
  topic: string;
  description: string;
  type: 'general' | 'custom' | 'competency';
  competency: string;
  participants: string[];
};

type BroadcastFormDraft = {
  dispatchMode?: 'now' | 'scheduled';
  date?: string;
  time?: string;
  misfirePolicy?: 'send_late' | 'skip';
  mode: 'all' | 'blocks' | 'people' | 'missing_slots' | 'groups';
  groupTargetIds?: string[];
  weekIndex: number;
  title: string;
  body: string;
  blocks: string[];
  recipients: string[];
};

type DeliveryIssue = {
  id: string;
  category: string;
  recipientName?: string;
  status: 'failed' | 'unknown';
  attempts: number;
  updatedAt: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  textPreview: string;
};

type OperationalDiagnostics = {
  generatedAt: string;
  requestId?: string;
  status: 'healthy' | 'degraded' | 'unavailable';
  warnings: string[];
  service: { revision: string; uptimeSeconds: number; updateMode: string; timeZone: string };
  persistence: {
    status: 'healthy' | 'degraded' | 'unavailable'; mode: string; durableRevision: number;
    replicatedRevision: number; pendingReplication: boolean; lastSuccessAt?: string; lastErrorAt?: string;
    lastError?: string; lastReplicationSuccessAt?: string; lastReplicationErrorAt?: string; lastReplicationError?: string;
  };
  queues: {
    notificationDelivery: { total: number; pending: number; attention: number; oldestPendingAgeSeconds: number };
    telegramInbox: { total: number; pending: number; failed: number; oldestPendingAgeSeconds: number };
    calendar: { pending: number };
    availabilitySheets: { pending: number };
  };
  integrations: Record<string, { configured: boolean; lastSuccessAt?: string; lastErrorAt?: string; lastError?: string }>;
  workers: Record<string, string>;
};

type SlotsFormDraft = {
  slots: Record<number, number[]>;
  hardUnavailableDays: number[];
  outWeekIndexes: number[];
  dirtyWeekBaselines: Record<string, number>;
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

const currentWeekStart = currentAvailabilityWeekStart;
const toIsoDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const formatDiagnosticTime = (value?: string) => {
  if (!value) return 'ещё нет данных';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date);
};

const dateForWeekDay = (absoluteDayIndex: number, weekStart: string) => {
  const [year, month, day] = weekStart.split('-').map(Number);
  return new Date(year, month - 1, day + absoluteDayIndex);
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

const alignedSlots = (availability?: Parameters<typeof alignAvailabilityToWeek>[0]) => alignAvailabilityToWeek(availability).slots;
const alignedUnavailableDays = (availability?: Parameters<typeof alignAvailabilityToWeek>[0]) => alignAvailabilityToWeek(availability).hardUnavailableDays;
const alignedOutWeekIndexes = (availability?: Parameters<typeof alignAvailabilityToWeek>[0]) => alignAvailabilityToWeek(availability).outWeekIndexes;

const hasSubmittedAvailabilityWeek = (
  availability: { slots?: Record<number, number[]>; hardUnavailableDays?: number[]; outWeekIndexes?: number[]; weekStart?: string } | undefined,
  activeDays: number[],
  weekIndex: number,
) => {
  if (!availability) return false;
  if (alignedOutWeekIndexes(availability).includes(weekIndex)) return true;
  const slots = alignedSlots(availability);
  const unavailableDays = new Set(alignedUnavailableDays(availability));
  const firstDay = weekIndex * 7;
  return activeDays.every((dayOffset) => (
    (slots[firstDay + dayOffset] || []).length > 0 || unavailableDays.has(firstDay + dayOffset)
  ));
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
  onRenameAvailabilityWeek,
}: MiniAppProps) {
  const [slotWeekStart, setSlotWeekStart] = useState(currentWeekStart);
  const dateForSlotDay = (day: number) => dateForWeekDay(day, slotWeekStart);
  const [slots, setSlots] = useState<Record<number, number[]>>({});
  const [hardUnavailableDays, setHardUnavailableDays] = useState<number[]>([]);
  const [outWeekIndexes, setOutWeekIndexes] = useState<number[]>([]);
  const [visibleWeeks, setVisibleWeeks] = useState(2);
  const [savingWeekCount, setSavingWeekCount] = useState(false);
  const [slotSettingsWeeks, setSlotSettingsWeeks] = useState(2);
  const [slotSettingsDays, setSlotSettingsDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [slotSettingsStartHour, setSlotSettingsStartHour] = useState(17);
  const [slotSettingsEndHour, setSlotSettingsEndHour] = useState(23);
  const [suggestions, setSuggestions] = useState<MeetingSuggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionDays, setSuggestionDays] = useState<number[]>(() => normalizeAvailabilityConfig(state.settings).activeDays);
  const [suggestionDuration, setSuggestionDuration] = useState('1');
  const [suggestionWeekIndex, setSuggestionWeekIndex] = useState(0);
  const [expandedWeekInfoIndex, setExpandedWeekInfoIndex] = useState<number | null>(null);
  const [weekNameDraft, setWeekNameDraft] = useState('');
  const [weekDescriptionDraft, setWeekDescriptionDraft] = useState('');
  const [savingWeekInfoIndex, setSavingWeekInfoIndex] = useState<number | null>(null);
  const [suggestionError, setSuggestionError] = useState('');
  const [savingWeekIndex, setSavingWeekIndex] = useState<number | null>(null);
  const [dirtyWeekBaselines, setDirtyWeekBaselines] = useState<Record<string, number>>({});
  const [slotError, setSlotError] = useState('');
  const [slotNotice, setSlotNotice] = useState('');
  const [taskError, setTaskError] = useState('');
  const [taskNotice, setTaskNotice] = useState('');
  const [taskDraftNotice, setTaskDraftNotice] = useState('');
  const [taskDraftBaseline, setTaskDraftBaseline] = useState('');
  const [taskDraftBaseVersion, setTaskDraftBaseVersion] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState('');

  const [showMeetingForm, setShowMeetingForm] = useState(false);
  const [savingMeeting, setSavingMeeting] = useState(false);
  const [expandedMeetingId, setExpandedMeetingId] = useState<string | null>(null);
  const [expandedMeetingAttendeeIds, setExpandedMeetingAttendeeIds] = useState<string[]>([]);
  const [meetingKind, setMeetingKind] = useState<MeetingKind>('meeting');
  const [meetingEventId, setMeetingEventId] = useState('');
  const [meetingTitle, setMeetingTitle] = useState('Общее собрание');
  const [meetingDate, setMeetingDate] = useState('');
  const [meetingTime, setMeetingTime] = useState('18:00');
  const [meetingDuration, setMeetingDuration] = useState('1');
  const [meetingTopic, setMeetingTopic] = useState('');
  const [meetingDescription, setMeetingDescription] = useState('');
  const [showMeetingExtras, setShowMeetingExtras] = useState(false);
  const [meetingType, setMeetingType] = useState<'general' | 'custom' | 'competency'>('general');
  const [meetingCompetency, setMeetingCompetency] = useState('');
  const [participants, setParticipants] = useState<string[]>([]);
  const [editingMeetingId, setEditingMeetingId] = useState<string | null>(null);
  const [meetingError, setMeetingError] = useState('');
  const [meetingDraftNotice, setMeetingDraftNotice] = useState('');
  const [meetingDraftBaseline, setMeetingDraftBaseline] = useState('');
  const [meetingDraftBaseFingerprint, setMeetingDraftBaseFingerprint] = useState('');
  const [rsvpMeetingId, setRsvpMeetingId] = useState<string | null>(null);
  const meetingFormRef = useRef<HTMLFormElement | null>(null);
  const restoredDraftUserRef = useRef('');
  const restoredSlotsDraftKeyRef = useRef('');

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
  const [taskEventId, setTaskEventId] = useState('');
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [completionHours, setCompletionHours] = useState('');
  const [completionMinutes, setCompletionMinutes] = useState('');
  const [completionComment, setCompletionComment] = useState('');
  const [completionBaseline, setCompletionBaseline] = useState('');
  const [savingCompletion, setSavingCompletion] = useState(false);
  const [taskListView, setTaskListView] = useState<'mine' | 'open' | 'assigned' | 'completed'>('mine');
  const [showTaskLog, setShowTaskLog] = useState(false);
  const [showFullCalendar, setShowFullCalendar] = useState(false);
  const [expandedAvailabilityDay, setExpandedAvailabilityDay] = useState<number | null>(null);
  const [expandedAvailabilityGroup, setExpandedAvailabilityGroup] = useState<'available' | 'missing' | 'unavailable' | null>(null);
  const [showAllMeetingParticipants, setShowAllMeetingParticipants] = useState(false);
  const [showAllMeetings, setShowAllMeetings] = useState(false);
  const [showMeetingHistory, setShowMeetingHistory] = useState(false);
  const [darkTheme, setDarkTheme] = useState(() => {
    const savedTheme = window.localStorage.getItem('megabattle-theme');
    if (savedTheme) return savedTheme === 'dark';
    const telegramTheme = (window as any).Telegram?.WebApp?.colorScheme;
    if (telegramTheme) return telegramTheme === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const [calmBackground, setCalmBackground] = useState(() => (
    window.localStorage.getItem('megabattle-calm-background') === 'true'
  ));
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
  const [selectedTaskEventId, setSelectedTaskEventId] = useState(TASK_EVENT_SCOPE_ALL);
  const [avatarEditorSource, setAvatarEditorSource] = useState<string | null>(null);
  const [avatarSaving, setAvatarSaving] = useState(false);

  const [newUserRealName, setNewUserRealName] = useState('');
  const [newUserUsername, setNewUserUsername] = useState('');
  const [newUserRole, setNewUserRole] = useState<'admin' | 'organizer'>('organizer');
  const [newUserBirthday, setNewUserBirthday] = useState('');
  const [showAddUserForm, setShowAddUserForm] = useState(false);
  const [showAllTeamUsers, setShowAllTeamUsers] = useState(false);
  const [teamSearch, setTeamSearch] = useState('');
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [profilePrimaryBlockOpen, setProfilePrimaryBlockOpen] = useState(false);
  const [profileSecondaryBlocksOpen, setProfileSecondaryBlocksOpen] = useState(false);
  const [userDraft, setUserDraft] = useState({ realName: '', username: '', birthday: '', role: 'organizer' as User['role'], competencies: [] as string[], primaryCompetency: '' });
  const [newCompetency, setNewCompetency] = useState('');
  const [showAllCompetencies, setShowAllCompetencies] = useState(false);
  const [teamError, setTeamError] = useState('');
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastMode, setBroadcastMode] = useState<BroadcastFormDraft['mode']>('all');
  const [broadcastGroupIds, setBroadcastGroupIds] = useState<string[]>([]);
  const [broadcastGroupOptions, setBroadcastGroupOptions] = useState<BroadcastGroupOption[]>([]);
  const [broadcastGroupsLoading, setBroadcastGroupsLoading] = useState(false);
  const [broadcastWeekIndex, setBroadcastWeekIndex] = useState(0);
  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastBody, setBroadcastBody] = useState('');
  const [broadcastBlocks, setBroadcastBlocks] = useState<string[]>([]);
  const [broadcastRecipients, setBroadcastRecipients] = useState<string[]>([]);
  const [broadcastSearch, setBroadcastSearch] = useState('');
  const [showBroadcastBlocks, setShowBroadcastBlocks] = useState(false);
  const [showBroadcastPeople, setShowBroadcastPeople] = useState(false);
  const [broadcastSaving, setBroadcastSaving] = useState(false);
  const [broadcastNotice, setBroadcastNotice] = useState('');
  const [broadcastError, setBroadcastError] = useState('');
  const [broadcastDraftNotice, setBroadcastDraftNotice] = useState('');
  const [broadcastDispatchMode, setBroadcastDispatchMode] = useState<'now' | 'scheduled'>('now');
  const [broadcastDate, setBroadcastDate] = useState('');
  const [broadcastTime, setBroadcastTime] = useState('12:00');
  const [broadcastMisfirePolicy, setBroadcastMisfirePolicy] = useState<'send_late' | 'skip'>('send_late');
  const [broadcastHistoryRevision, setBroadcastHistoryRevision] = useState(0);
  const durableBroadcasts = state.capabilities?.durableBroadcasts === true;
  const [deliveryJournalOpen, setDeliveryJournalOpen] = useState(false);
  const [deliveryIssues, setDeliveryIssues] = useState<DeliveryIssue[]>([]);
  const [selectedDeliveryIds, setSelectedDeliveryIds] = useState<string[]>([]);
  const [deliveryJournalBusy, setDeliveryJournalBusy] = useState(false);
  const [deliveryJournalError, setDeliveryJournalError] = useState('');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<OperationalDiagnostics | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState('');
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
  const tabScrollPositionsRef = useRef<Record<string, number>>({});
  const tabHistoryRef = useRef<string[]>([]);
  const editorReturnScrollRef = useRef<Record<string, number>>({});

  const restoreTabScroll = useCallback((tab: string) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      window.scrollTo({ top: tabScrollPositionsRef.current[tab] || 0, behavior: 'auto' });
    }));
  }, []);

  const navigateToTab = useCallback((tab: string) => {
    if (tab === activeTab) return;
    tabScrollPositionsRef.current[activeTab] = window.scrollY;
    tabHistoryRef.current.push(activeTab);
    setActiveTab(tab);
    restoreTabScroll(tab);
  }, [activeTab, restoreTabScroll, setActiveTab]);

  const navigateBack = useCallback(() => {
    tabScrollPositionsRef.current[activeTab] = window.scrollY;
    let target = tabHistoryRef.current.pop() || 'meetings';
    while (target === activeTab && tabHistoryRef.current.length) target = tabHistoryRef.current.pop() || 'meetings';
    setActiveTab(target);
    restoreTabScroll(target);
  }, [activeTab, restoreTabScroll, setActiveTab]);

  const rememberEditorScroll = useCallback((editor: string) => {
    if (editorReturnScrollRef.current[editor] === undefined) editorReturnScrollRef.current[editor] = window.scrollY;
  }, []);

  const restoreEditorScroll = useCallback((editor: string) => {
    const top = editorReturnScrollRef.current[editor];
    delete editorReturnScrollRef.current[editor];
    if (top === undefined) return;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.scrollTo({ top, behavior: 'auto' })));
  }, []);

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

    // Editor state remains mounted across tabs so returning to the panel does
    // not destroy a partially completed form.
  }, [activeTab, isAdmin, setActiveTab]);

  const availabilityConfig = useMemo(() => normalizeAvailabilityConfig(state.settings, slotWeekStart), [state.settings, slotWeekStart]);
  const { activeDays, hours } = availabilityConfig;
  const dirtyWeekIndexes = useMemo(() => Object.keys(dirtyWeekBaselines)
    .map((weekStart) => availabilityConfig.weekStarts.indexOf(weekStart))
    .filter((weekIndex) => weekIndex >= 0), [availabilityConfig.weekStarts, dirtyWeekBaselines]);
  const markWeekDirty = (weekIndex: number) => {
    const weekStart = availabilityConfig.weekStarts[weekIndex];
    if (!weekStart) return;
    setDirtyWeekBaselines((current) => current[weekStart] !== undefined ? current : {
      ...current,
      [weekStart]: Number(state.availabilities[currentUser.id]?.weekVersions?.[weekStart] || 0),
    });
  };
  const activeDayLabels = activeDays.map((dayIndex) => ({ ...dayLabels[dayIndex], dayIndex }));
  const configuredWeekCount = Math.min(maxSlotWeeks, Math.max(2, Number(state.settings?.availabilityWeekCount || 2)));
  useEffect(() => {
    let anchor = slotWeekStart;
    let timer: ReturnType<typeof setTimeout>;
    const checkWeek = () => {
      clearTimeout(timer);
      const nextWeekStart = currentWeekStart();
      if (anchor !== nextWeekStart) {
        const oldAnchor = anchor;
        anchor = nextWeekStart;
        const align = (value: Parameters<typeof alignAvailabilityToWeek>[0]) => (
          alignAvailabilityToWeek({ ...value, weekStart: oldAnchor }, nextWeekStart, configuredWeekCount)
        );
        setSlots((value) => align({ slots: value }).slots);
        setHardUnavailableDays((value) => align({ hardUnavailableDays: value }).hardUnavailableDays);
        setOutWeekIndexes((value) => align({ outWeekIndexes: value }).outWeekIndexes);
        const nextWeekStarts = new Set(normalizeAvailabilityConfig(state.settings, nextWeekStart).weekStarts);
        setDirtyWeekBaselines((value) => Object.fromEntries(Object.entries(value).filter(([weekStart]) => nextWeekStarts.has(weekStart))));
        setExpandedWeekInfoIndex(null);
        setWeekNameDraft('');
        setWeekDescriptionDraft('');
        setSuggestions([]);
        setSlotNotice('Началась новая неделя. В конце списка добавлена пустая неделя.');
        setSlotWeekStart(nextWeekStart);
      }
      const nextMonday = Date.parse(`${nextWeekStart}T00:00:00+03:00`) + 7 * 86_400_000;
      timer = setTimeout(checkWeek, Math.max(1, nextMonday - Date.now()));
    };
    checkWeek();
    window.addEventListener('focus', checkWeek);
    document.addEventListener('visibilitychange', checkWeek);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', checkWeek);
      document.removeEventListener('visibilitychange', checkWeek);
    };
  }, [slotWeekStart, configuredWeekCount]);
  useEffect(() => {
    if (broadcastWeekIndex >= configuredWeekCount) setBroadcastWeekIndex(0);
  }, [broadcastWeekIndex, configuredWeekCount]);
  const coreTeamUsers = state.users.filter((user) => user.active !== false && (user.role === 'admin' || user.role === 'organizer'));
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
    const isNamedScope = [TASK_EVENT_SCOPE_ALL, TASK_EVENT_SCOPE_NONE, TASK_EVENT_SCOPE_ARCHIVED].includes(selectedTaskEventId);
    if (!isNamedScope && !activeEvents.some((item) => item.id === selectedTaskEventId)) {
      setSelectedTaskEventId(TASK_EVENT_SCOPE_ALL);
    }
  }, [activeEventIds, selectedTaskEventId]);
  const eligibleTaskAssignees = coreTeamUsers;
  const normalizedTaskAssigneeSearch = taskAssigneeSearch.trim().toLowerCase();
  const matchedTaskAssignees = normalizedTaskAssigneeSearch
    ? eligibleTaskAssignees.filter((user) => `${user.realName} ${user.username} ${(user.competencies || []).join(' ')}`.toLowerCase().includes(normalizedTaskAssigneeSearch))
    : eligibleTaskAssignees;
  const visibleTaskAssignees = normalizedTaskAssigneeSearch || showAllTaskAssignees
    ? matchedTaskAssignees
    : matchedTaskAssignees.slice(0, 3);
  const broadcastEligibleUsers = coreTeamUsers.filter(user => !durableBroadcasts || user.registered);
  const normalizedBroadcastSearch = broadcastSearch.trim().toLowerCase();
  const matchedBroadcastUsers = normalizedBroadcastSearch
    ? broadcastEligibleUsers.filter((user) => `${user.realName} ${user.username} ${(user.competencies || []).join(' ')}`.toLowerCase().includes(normalizedBroadcastSearch))
    : broadcastEligibleUsers;
  const missingSlotBroadcastUsers = broadcastEligibleUsers.filter((user) => (
    !hasSubmittedAvailabilityWeek(state.availabilities[user.id], activeDays, broadcastWeekIndex)
  ));
  const broadcastAudienceUsers = broadcastMode === 'groups' ? [] : broadcastMode === 'all'
    ? broadcastEligibleUsers
    : broadcastMode === 'missing_slots'
      ? missingSlotBroadcastUsers
      : broadcastEligibleUsers.filter((user) => broadcastRecipients.includes(user.id));
  const broadcastAvailableUsers = broadcastAudienceUsers.filter((user) => user.registered && (!durableBroadcasts || user.telegramConnected === true));
  const broadcastUnavailableUsers = broadcastAudienceUsers.filter((user) => !broadcastAvailableUsers.includes(user));
  const broadcastGroupsReady = durableBroadcasts && !broadcastGroupsLoading && broadcastGroupIds.length > 0 && broadcastGroupIds.length <= 100 && broadcastGroupIds.every(id => broadcastGroupOptions.some(item => item.id === id));
  const broadcastDraftDirty = broadcastOpen && (
    broadcastMode !== 'all'
    || broadcastWeekIndex !== 0
    || broadcastDispatchMode !== 'now' || Boolean(broadcastDate) || broadcastMisfirePolicy !== 'send_late'
    || Boolean(broadcastTitle.trim() || broadcastBody.trim() || broadcastBlocks.length || broadcastRecipients.length)
  );
  const filterTasksBySelectedEvent = (tasks: Task[]) => filterTasksByEventScope(tasks, allEvents, selectedTaskEventId);
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
  const completionTask = completingTaskId ? state.tasks.find((task) => task.id === completingTaskId) : undefined;
  const editingCompletedTask = completionTask?.status === 'completed';
  const sharedCompletionAssigneeCount = completionTask ? taskAssigneeIds(completionTask).length : 0;
  const projectNow = new Date(state.serverNow || Date.now());
  const scheduledMeetings = state.meetings
    .filter((meeting) => meeting.status === 'scheduled' && meetingPhase(meeting, projectNow) !== 'past')
    .slice()
    .sort((a, b) => {
      const phaseOrder = Number(meetingPhase(a, projectNow) !== 'ongoing') - Number(meetingPhase(b, projectNow) !== 'ongoing');
      return phaseOrder || meetingStartTimestamp(a, projectNow) - meetingStartTimestamp(b, projectNow);
    });
  const visibleScheduledMeetings = showAllMeetings ? scheduledMeetings : scheduledMeetings.slice(0, 3);
  const meetingHistory = state.meetings
    .filter((meeting) => meeting.status !== 'scheduled' || meetingPhase(meeting, projectNow) === 'past')
    .slice()
    .sort((a, b) => meetingEndTimestamp(b, projectNow) - meetingEndTimestamp(a, projectNow));
  const taskFormSnapshot = JSON.stringify({
    editingTaskId, title: taskTitle, description: taskDesc, competencies: taskCompetencies,
    deadline: taskDeadline, assignedTo: taskAssignedTo, assignmentMode: taskAssignmentMode,
    sow: taskSow, priority: taskPriority, reminders: taskReminders, eventId: taskEventId,
  });
  const meetingFormSnapshot = JSON.stringify({
    editingMeetingId, kind: meetingKind, eventId: meetingEventId, title: meetingTitle,
    date: meetingDate, time: meetingTime, duration: meetingDuration, topic: meetingTopic,
    description: meetingDescription, type: meetingType, competency: meetingCompetency,
    participants,
  });
  const taskDraftDirty = showTaskForm && Boolean(taskDraftBaseline) && taskFormSnapshot !== taskDraftBaseline;
  const meetingDraftDirty = showMeetingForm && Boolean(meetingDraftBaseline) && meetingFormSnapshot !== meetingDraftBaseline;
  const editingTaskSource = editingTaskId ? state.tasks.find((task) => task.id === editingTaskId) : undefined;
  const editingMeetingSource = editingMeetingId ? state.meetings.find((meeting) => meeting.id === editingMeetingId) : undefined;
  const taskDraftConflict = Boolean(editingTaskId && taskDraftBaseVersion !== null && Number(editingTaskSource?.version) !== taskDraftBaseVersion);
  const meetingDraftConflict = Boolean(editingMeetingId && meetingDraftBaseFingerprint && meetingDraftFingerprint(editingMeetingSource) !== meetingDraftBaseFingerprint);

  useEffect(() => {
    if (restoredDraftUserRef.current === currentUser.id) return;
    restoredDraftUserRef.current = currentUser.id;
    const taskDraft = readLatestFormDraft<TaskFormDraft>(window.sessionStorage, currentUser.id, 'task');
    if (taskDraft) {
      const draft = taskDraft.payload;
      setEditingTaskId(draft.editingTaskId);
      setTaskTitle(draft.title);
      setTaskDesc(draft.description);
      setTaskCompetencies(draft.competencies);
      setTaskDeadline(draft.deadline);
      setTaskAssignedTo(draft.assignedTo);
      setTaskAssignmentMode(draft.assignmentMode);
      setTaskSow(draft.sow);
      setTaskPriority(draft.priority);
      setTaskReminders(draft.reminders);
      setTaskEventId(draft.eventId);
      setTaskDraftBaseline(draft.baseline);
      setTaskDraftBaseVersion(draft.baseVersion);
      setTaskDraftNotice('Восстановлен несохранённый черновик задачи.');
      setShowTaskForm(true);
    }
    const meetingDraft = readLatestFormDraft<MeetingFormDraft>(window.sessionStorage, currentUser.id, 'meeting');
    if (meetingDraft) {
      const draft = meetingDraft.payload;
      setEditingMeetingId(draft.editingMeetingId);
      setMeetingKind(draft.kind);
      setMeetingEventId(draft.eventId);
      setMeetingTitle(draft.title);
      setMeetingDate(draft.date);
      setMeetingTime(draft.time);
      setMeetingDuration(draft.duration);
      setMeetingTopic(draft.topic);
      setMeetingDescription(draft.description);
      setShowMeetingExtras(Boolean(draft.topic || draft.description));
      setMeetingType(draft.type);
      setMeetingCompetency(draft.competency);
      setParticipants(draft.participants);
      setMeetingDraftBaseline(draft.baseline);
      setMeetingDraftBaseFingerprint(draft.baseFingerprint);
      setMeetingDraftNotice('Восстановлен несохранённый черновик встречи.');
      setShowMeetingForm(true);
    }
    const broadcastDraft = readFormDraft<BroadcastFormDraft>(window.sessionStorage, currentUser.id, 'broadcast');
    if (broadcastDraft) {
      const draft = broadcastDraft.payload;
      setBroadcastMode(draft.mode);
      setBroadcastWeekIndex(draft.weekIndex);
      setBroadcastTitle(draft.title);
      setBroadcastBody(draft.body);
      setBroadcastBlocks(draft.blocks);
      setBroadcastRecipients(draft.recipients);
      setBroadcastGroupIds(draft.groupTargetIds || []);
      setBroadcastDispatchMode(draft.dispatchMode || 'now');
      setBroadcastDate(draft.date || '');
      setBroadcastTime(draft.time || '12:00');
      setBroadcastMisfirePolicy(draft.misfirePolicy || 'send_late');
      setBroadcastDraftNotice('Восстановлен несохранённый черновик рассылки.');
      setBroadcastOpen(true);
    }
  }, [currentUser.id]);

  useEffect(() => {
    if (!showTaskForm || !taskDraftDirty) return;
    writeFormDraft(window.sessionStorage, {
      userId: currentUser.id, kind: 'task', entityId: editingTaskId || 'new', context: '',
      payload: {
        editingTaskId, baseline: taskDraftBaseline, baseVersion: taskDraftBaseVersion,
        title: taskTitle, description: taskDesc, competencies: taskCompetencies,
        deadline: taskDeadline, assignedTo: taskAssignedTo, assignmentMode: taskAssignmentMode,
        sow: taskSow, priority: taskPriority, reminders: taskReminders, eventId: taskEventId,
      },
    });
  }, [currentUser.id, editingTaskId, showTaskForm, taskDraftDirty, taskDraftBaseline, taskDraftBaseVersion, taskTitle, taskDesc, taskCompetencies, taskDeadline, taskAssignedTo, taskAssignmentMode, taskSow, taskPriority, taskReminders, taskEventId]);

  useEffect(() => {
    if (!showMeetingForm || !meetingDraftDirty) return;
    writeFormDraft(window.sessionStorage, {
      userId: currentUser.id, kind: 'meeting', entityId: editingMeetingId || 'new', context: '',
      payload: {
        editingMeetingId, baseline: meetingDraftBaseline, baseFingerprint: meetingDraftBaseFingerprint,
        kind: meetingKind, eventId: meetingEventId, title: meetingTitle, date: meetingDate,
        time: meetingTime, duration: meetingDuration, topic: meetingTopic,
        description: meetingDescription, type: meetingType, competency: meetingCompetency, participants,
      },
    });
  }, [currentUser.id, editingMeetingId, showMeetingForm, meetingDraftDirty, meetingDraftBaseline, meetingDraftBaseFingerprint, meetingKind, meetingEventId, meetingTitle, meetingDate, meetingTime, meetingDuration, meetingTopic, meetingDescription, meetingType, meetingCompetency, participants]);

  useEffect(() => {
    if (!broadcastOpen) return;
    if (!broadcastDraftDirty) {
      removeFormDraft(window.sessionStorage, currentUser.id, 'broadcast');
      return;
    }
    writeFormDraft(window.sessionStorage, {
      userId: currentUser.id,
      kind: 'broadcast',
      entityId: 'new',
      context: '',
      payload: {
        mode: broadcastMode,
        weekIndex: broadcastWeekIndex,
        title: broadcastTitle,
        body: broadcastBody,
        blocks: broadcastBlocks,
        recipients: broadcastRecipients,
        groupTargetIds: broadcastGroupIds,
        dispatchMode: broadcastDispatchMode, date: broadcastDate, time: broadcastTime, misfirePolicy: broadcastMisfirePolicy,
      } satisfies BroadcastFormDraft,
    });
  }, [broadcastBlocks, broadcastBody, broadcastDraftDirty, broadcastMode, broadcastOpen, broadcastRecipients, broadcastTitle, broadcastWeekIndex, broadcastDispatchMode, broadcastDate, broadcastTime, broadcastMisfirePolicy, broadcastGroupIds, currentUser.id]);
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
  const profileSlotsCompleted = activeDays.every((dayIndex) => (
    (profileAvailability[dayIndex] || []).length > 0 || profileUnavailableDays.has(dayIndex)
  ));
  const profileHasTaskHistory = profileAssignedTasks.length > 0 || profileCreatedTasks.length > 0;
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
  const facultyUsers = state.users.filter((user) => user.active !== false && (user.role === 'faculty_responsible' || user.role === 'faculty_helper'));
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
      dayLabels.map((day, dayIndex) => {
        const people = coreTeamUsers.map((user) => ({
          ...user,
          daySlots: alignedSlots(state.availabilities[user.id])?.[dayIndex] || [],
          unavailable: alignedUnavailableDays(state.availabilities[user.id]).includes(dayIndex),
          outForWeek: alignedOutWeekIndexes(state.availabilities[user.id]).includes(0),
        }));
        const users = people.filter((user) => !user.outForWeek && user.daySlots.length > 0);
        const unavailableUsers = people.filter((user) => user.unavailable || user.outForWeek);
        const missingUsers = people.filter((user) => !user.outForWeek && user.daySlots.length === 0 && !user.unavailable);
        return {
          ...day,
          dayIndex,
          users,
          missingUsers,
          unavailableUsers,
          count: users.length,
          total: people.filter((user) => !user.outForWeek).length,
        };
      }),
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
        ranges.push(`${String(start).padStart(2, '0')}:00–${String((prev + 1) % 24).padStart(2, '0')}:00`);
        start = hour;
        prev = hour;
      }
    }
    ranges.push(`${String(start).padStart(2, '0')}:00–${String((prev + 1) % 24).padStart(2, '0')}:00`);
    return ranges.join(', ');
  };

  const formatHourRange = (hour: number) => (
    `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`
  );

  useEffect(() => {
    const availability = state.availabilities[currentUser.id];
    const aligned = alignAvailabilityToWeek(availability, slotWeekStart, configuredWeekCount);
    const saved = aligned.slots;
    const nextSlots: Record<number, number[]> = {};
    Array.from({ length: configuredWeekCount * 7 }, (_, index) => {
      nextSlots[index] = [...(saved?.[index] || [])];
    });
    const dirtyWeekStarts = Object.keys(dirtyWeekBaselines);
    const savedDraft = {
      slots: nextSlots,
      hardUnavailableDays: aligned.hardUnavailableDays,
      outWeekIndexes: aligned.outWeekIndexes,
    };
    setVisibleWeeks(configuredWeekCount);
    setSlots((current) => mergeAvailabilityDraft(savedDraft, { slots: current, hardUnavailableDays: [], outWeekIndexes: [] }, dirtyWeekStarts, availabilityConfig.weekStarts).slots);
    setHardUnavailableDays((current) => mergeAvailabilityDraft(savedDraft, { slots: {}, hardUnavailableDays: current, outWeekIndexes: [] }, dirtyWeekStarts, availabilityConfig.weekStarts).hardUnavailableDays);
    setOutWeekIndexes((current) => mergeAvailabilityDraft(savedDraft, { slots: {}, hardUnavailableDays: [], outWeekIndexes: current }, dirtyWeekStarts, availabilityConfig.weekStarts).outWeekIndexes);
  }, [availabilityConfig.weekStarts, configuredWeekCount, currentUser.id, dirtyWeekBaselines, slotWeekStart, state.availabilities]);

  useEffect(() => {
    const restoreKey = `${currentUser.id}:${slotWeekStart}`;
    if (restoredSlotsDraftKeyRef.current === restoreKey) return;
    restoredSlotsDraftKeyRef.current = restoreKey;
    const draft = readFormDraft<SlotsFormDraft>(window.sessionStorage, currentUser.id, 'slots', 'availability', slotWeekStart);
    if (!draft?.payload.dirtyWeekBaselines || !Object.keys(draft.payload.dirtyWeekBaselines).length) return;
    setSlots(draft.payload.slots);
    setHardUnavailableDays(draft.payload.hardUnavailableDays);
    setOutWeekIndexes(draft.payload.outWeekIndexes);
    setDirtyWeekBaselines(draft.payload.dirtyWeekBaselines);
    setSlotNotice('Восстановлены несохранённые слоты. Проверь их и сохрани нужные недели.');
  }, [currentUser.id, slotWeekStart]);

  useEffect(() => {
    if (!dirtyWeekIndexes.length) {
      removeFormDraft(window.sessionStorage, currentUser.id, 'slots', 'availability', slotWeekStart);
      return;
    }
    writeFormDraft(window.sessionStorage, {
      userId: currentUser.id, kind: 'slots', entityId: 'availability', context: slotWeekStart,
      payload: { slots, hardUnavailableDays, outWeekIndexes, dirtyWeekBaselines },
    });
  }, [currentUser.id, dirtyWeekBaselines, dirtyWeekIndexes, hardUnavailableDays, outWeekIndexes, slotWeekStart, slots]);

  useEffect(() => {
    setSlotSettingsWeeks(configuredWeekCount);
    setSlotSettingsDays(activeDays);
    setSlotSettingsStartHour(availabilityConfig.startHour);
    setSlotSettingsEndHour(availabilityConfig.endHour);
  }, [activeDays, availabilityConfig.endHour, availabilityConfig.startHour, configuredWeekCount]);

  useEffect(() => {
    setSuggestionDays((current) => {
      const valid = current.filter((day) => activeDays.includes(day));
      const next = valid.length ? valid : [...activeDays];
      return next.length === current.length && next.every((day, index) => day === current[index]) ? current : next;
    });
  }, [activeDays]);

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
    setSlotNotice('');
    const weekIndex = Math.floor(day / 7);
    setOutWeekIndexes((current) => current.filter((item) => item !== weekIndex));
    markWeekDirty(weekIndex);
    setHardUnavailableDays((current) => current.filter((item) => item !== day));
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
    setSlotNotice('');
    const weekIndex = Math.floor(day / 7);
    setOutWeekIndexes((current) => current.filter((item) => item !== weekIndex));
    markWeekDirty(weekIndex);
    setHardUnavailableDays((current) => current.filter((item) => item !== day));
    setSlots((prev) => {
      const full = (prev[day] || []).length === hours.length;
      return { ...prev, [day]: full ? [] : [...hours] };
    });
  };

  const toggleUnavailableDay = (day: number) => {
    setSlotError('');
    setSlotNotice('');
    const weekIndex = Math.floor(day / 7);
    setOutWeekIndexes((current) => current.filter((item) => item !== weekIndex));
    const unavailable = hardUnavailableDays.includes(day);
    markWeekDirty(weekIndex);
    setHardUnavailableDays((current) => unavailable
      ? current.filter((item) => item !== day)
      : [...current.filter((item) => item !== day), day].sort((a, b) => a - b));
    if (!unavailable) setSlots((current) => ({ ...current, [day]: [] }));
  };

  const toggleOutWeek = (weekIndex: number) => {
    setSlotError('');
    setSlotNotice('');
    const wasOut = outWeekIndexes.includes(weekIndex);
    markWeekDirty(weekIndex);
    setOutWeekIndexes((current) => wasOut
      ? current.filter((item) => item !== weekIndex)
      : [...current.filter((item) => item !== weekIndex), weekIndex].sort((a, b) => a - b));
    if (!wasOut) {
      setSlots((current) => Object.fromEntries(Object.entries(current).filter(([day]) => Math.floor(Number(day) / 7) !== weekIndex)));
      setHardUnavailableDays((current) => current.filter((day) => Math.floor(day / 7) !== weekIndex));
    }
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
    setSuggestionError('');
    if (!suggestionDays.length) {
      setSuggestionError('Выбери хотя бы один день для поиска.');
      return;
    }
    setSuggesting(true);
    try {
      const res = await fetch('/api/meeting/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: suggestionDays, duration: Number(suggestionDuration), weekIndex: suggestionWeekIndex }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не удалось найти слоты');
      if (data.success) {
        setSuggestions(data.topSuggestions || []);
        if (!data.topSuggestions?.length) setSuggestionError('Для выбранных дней и длительности пока нет подходящих слотов.');
      }
    } catch (error: any) {
      setSuggestions([]);
      setSuggestionError(error.message || 'Не удалось найти слоты');
    } finally {
      setSuggesting(false);
    }
  };

  const toggleSuggestionDay = (dayIndex: number) => {
    setSuggestionError('');
    setSuggestions([]);
    setSuggestionDays((current) => current.includes(dayIndex)
      ? current.filter((day) => day !== dayIndex)
      : [...current, dayIndex].sort((a, b) => a - b));
  };

  const applySuggestion = (suggestion: MeetingSuggestion) => {
    setMeetingKind('meeting');
    setMeetingEventId('');
    setMeetingType('general');
    setMeetingTitle('Общее собрание');
    setMeetingDate(suggestion.date || nextDateForDay(suggestion.weekIndex * 7 + suggestion.dayIndex));
    setMeetingTime(`${String(suggestion.hour).padStart(2, '0')}:00`);
    setMeetingDuration(String(suggestion.duration || 1));
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
    if (slotWeekStart !== currentWeekStart()) {
      setSlotError('Началась новая неделя. Обнови слоты и повтори сохранение.');
      return;
    }
    setSlotError('');
    setSavingWeekIndex(weekIndex);
    const targetWeekStart = availabilityConfig.weekStarts[weekIndex];
    const firstDay = weekIndex * 7;
    const weekDays = Object.fromEntries(
      Array.from({ length: 7 }, (_, relativeDay) => [relativeDay, [...(slots[firstDay + relativeDay] || [])]]),
    );
    const weekUnavailableDays = hardUnavailableDays
      .filter((day) => Math.floor(day / 7) === weekIndex)
      .map((day) => day - firstDay);
    const expectedVersion = dirtyWeekBaselines[targetWeekStart]
      ?? Number(state.availabilities[currentUser.id]?.weekVersions?.[targetWeekStart] || 0);
    const ok = await onSaveAvailability(targetWeekStart, weekDays, weekUnavailableDays, outWeekIndexes.includes(weekIndex), expectedVersion);
    setSavingWeekIndex(null);
    if (ok && slotWeekStart === currentWeekStart()) {
      setDirtyWeekBaselines((current) => Object.fromEntries(Object.entries(current).filter(([weekStart]) => weekStart !== targetWeekStart)));
      setSlotNotice(`Неделя ${weekIndex + 1} сохранена независимо от остальных.`);
    }
  };

  const resetMeetingForm = () => {
    removeFormDraft(window.sessionStorage, currentUser.id, 'meeting', editingMeetingId || 'new');
    setEditingMeetingId(null);
    setShowMeetingForm(false);
    setMeetingKind('meeting');
    setMeetingEventId('');
    setMeetingTitle('Общее собрание');
    setMeetingDate('');
    setMeetingTime('18:00');
    setMeetingDuration('1');
    setMeetingTopic('');
    setMeetingDescription('');
    setShowMeetingExtras(false);
    setMeetingType('general');
    setMeetingCompetency('');
    setParticipants([]);
    setShowAllMeetingParticipants(false);
    setMeetingError('');
    setMeetingDraftNotice('');
    setMeetingDraftBaseline('');
    setMeetingDraftBaseFingerprint('');
  };

  const discardMeetingForm = () => {
    if (meetingDraftDirty && !window.confirm('Закрыть форму и удалить несохранённый черновик встречи?')) return false;
    resetMeetingForm();
    restoreEditorScroll('meeting');
    return true;
  };

  const startMeetingEdit = (meeting: Meeting) => {
    rememberEditorScroll('meeting');
    setMeetingError('');
    setEditingMeetingId(meeting.id);
    setShowMeetingForm(true);
    setMeetingKind(normalizeMeetingKind(meeting.kind));
    setMeetingEventId(meeting.eventId || '');
    setMeetingTitle(meeting.title);
    setMeetingDate(formatDateShort(meeting.date));
    setMeetingTime(meeting.time);
    setMeetingDuration(String(meeting.duration || 1));
    setMeetingTopic(meeting.topic || '');
    setMeetingDescription(meeting.description || '');
    setShowMeetingExtras(Boolean(meeting.topic || meeting.description));
    setMeetingType(meeting.competency ? 'competency' : meeting.type);
    setMeetingCompetency(meeting.competency || '');
    setParticipants(Array.isArray(meeting.participants) ? meeting.participants : []);
    setShowAllMeetingParticipants(false);
    setMeetingDraftNotice('');
    setMeetingDraftBaseFingerprint(meetingDraftFingerprint(meeting));
    setMeetingDraftBaseline(JSON.stringify({
      editingMeetingId: meeting.id, kind: normalizeMeetingKind(meeting.kind), eventId: meeting.eventId || '', title: meeting.title,
      date: formatDateShort(meeting.date), time: meeting.time, duration: String(meeting.duration || 1), topic: meeting.topic || '',
      description: meeting.description || '', type: meeting.competency ? 'competency' : meeting.type,
      competency: meeting.competency || '', participants: Array.isArray(meeting.participants) ? meeting.participants : [],
    }));
  };

  useEffect(() => {
    if (showMeetingForm && !meetingDraftBaseline) setMeetingDraftBaseline(meetingFormSnapshot);
  }, [meetingDraftBaseline, meetingFormSnapshot, showMeetingForm]);

  useEffect(() => {
    if (!showMeetingForm || !editingMeetingId) return;

    const animationFrame = window.requestAnimationFrame(() => {
      meetingFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [editingMeetingId, showMeetingForm]);

  const submitMeeting = async (event: React.FormEvent) => {
    event.preventDefault();
    setMeetingError('');
    if (meetingDraftConflict) {
      setMeetingError('Встреча изменилась после открытия черновика. Закрой форму, обнови данные и внеси изменения заново.');
      return;
    }
    if (!meetingTitle.trim()) {
      setMeetingError(`Укажи название ${meetingKindText(meetingKind).genitive}.`);
      return;
    }
    if (meetingKind === 'setup' && !meetingEventId) {
      setMeetingError('Выбери мероприятие для монтажа.');
      return;
    }
    if (!meetingDate) {
      setMeetingError(`Выбери дату ${meetingKindText(meetingKind).genitive}.`);
      return;
    }
    if (meetingKind !== 'setup' && meetingType !== 'general' && participants.length === 0) {
      setMeetingError(meetingType === 'competency' ? 'В выбранном блоке пока нет участников.' : 'Выбери хотя бы одного участника.');
      return;
    }
    setSavingMeeting(true);
    const payload = {
      title: meetingTitle || meetingKindText(meetingKind).label,
      kind: meetingKind,
      eventId: meetingKind === 'setup' ? meetingEventId : '',
      type: meetingKind === 'setup' ? 'general' : meetingType === 'competency' ? 'custom' : meetingType,
      date: meetingDate || nextDateForDay(0),
      time: meetingTime,
      duration: Number(meetingDuration) || 1,
      hostId: currentUser.id,
      participants: meetingKind === 'setup' || meetingType === 'general' ? 'all' : participants,
      topic: meetingKind === 'setup' ? '' : meetingTopic,
      description: meetingKind === 'setup' ? '' : meetingDescription,
      competency: meetingKind !== 'setup' && meetingType === 'competency' ? meetingCompetency : '',
    };

    try {
      if (editingMeetingId) {
        const res = await fetch('/api/meeting/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meetingId: editingMeetingId, requesterId: currentUser.id, ...payload }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Не удалось сохранить встречу.');
        resetMeetingForm();
        await onRefreshState();
        return;
      }

      const ok = await onScheduleMeeting(payload);
      if (ok) resetMeetingForm();
      else setMeetingError('Не удалось назначить встречу. Проверь поля и соединение.');
    } catch (error: any) {
      setMeetingError(error.message || 'Не удалось сохранить встречу. Проверь соединение и попробуй ещё раз — черновик сохранён.');
    } finally {
      setSavingMeeting(false);
    }
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

  const selectMeetingKind = (nextKind: MeetingKind) => {
    setMeetingKind(nextKind);
    setMeetingError('');
    setShowAllMeetingParticipants(false);
    if (['Общее собрание', 'Монтаж', 'Вайбик'].includes(meetingTitle)) {
      setMeetingTitle(nextKind === 'meeting' ? 'Общее собрание' : meetingKindText(nextKind).label);
    }
    if (nextKind === 'setup') {
      setMeetingType('general');
      setMeetingCompetency('');
      setParticipants([]);
      setMeetingTopic('');
      setMeetingDescription('');
      setShowMeetingExtras(false);
      return;
    }
    setMeetingEventId('');
  };

  const setMeetingAttendance = async (meeting: Meeting, responseValue: 'yes' | 'no' | 'unanswered') => {
    if (rsvpMeetingId) return;
    setRsvpMeetingId(meeting.id);
    setMeetingError('');
    try {
      const response = await fetch('/api/meeting/rsvp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterId: currentUser.id, meetingId: meeting.id, response: responseValue }),
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
    removeFormDraft(window.sessionStorage, currentUser.id, 'task', editingTaskId || 'new');
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
    setTaskEventId('');
    setEditingTaskId(null);
    setTaskDraftNotice('');
    setTaskDraftBaseline('');
    setTaskDraftBaseVersion(null);
  };

  const discardTaskForm = () => {
    if (taskDraftDirty && !window.confirm('Закрыть форму и удалить несохранённый черновик задачи?')) return false;
    resetTaskForm();
    setShowTaskForm(false);
    restoreEditorScroll('task');
    return true;
  };

  const openTaskForm = () => {
    if (!showTaskForm) {
      rememberEditorScroll('task');
      setTaskError('');
      setTaskEventId(newTaskEventIdForScope(allEvents, selectedTaskEventId));
    }
    if (showTaskForm) return discardTaskForm();
    setShowTaskForm((value) => !value);
  };

  const startTaskEdit = (task: Task) => {
    rememberEditorScroll('task');
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
    setTaskEventId(task.eventId || '');
    setTaskError('');
    setShowTaskForm(true);
    setTaskDraftNotice('');
    setTaskDraftBaseVersion(Number(task.version || 1));
    setTaskDraftBaseline(JSON.stringify({
      editingTaskId: task.id, title: task.title, description: task.description,
      competencies: taskCompetencyNames(task), deadline: formatDateShort(task.deadline), assignedTo: taskAssigneeIds(task),
      assignmentMode: taskAssigneeIds(task).length === 0 ? 'open' : taskCompetencyNames(task).length ? 'blocks' : 'people',
      sow: task.sow || '', priority: task.priority || 'normal', reminders: task.reminders?.map((reminder) => ({ ...reminder })) || [], eventId: task.eventId || '',
    }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    if (showTaskForm && !taskDraftBaseline) setTaskDraftBaseline(taskFormSnapshot);
  }, [showTaskForm, taskDraftBaseline, taskFormSnapshot]);

  const submitTask = async (event: React.FormEvent) => {
    event.preventDefault();
    setTaskError('');
    setTaskNotice('');
    if (taskDraftConflict) {
      setTaskError('Задача изменилась после открытия черновика. Закрой форму, обнови данные и внеси изменения заново.');
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
      eventId: taskEventId,
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
          body: JSON.stringify({
            requesterId: currentUser.id,
            taskId: editingTaskId,
            version: state.tasks.find((task) => task.id === editingTaskId)?.version,
            ...payload,
          }),
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
      if (!ok) setTaskError('Не удалось создать задачу. Проверь соединение и попробуй ещё раз — черновик сохранён.');
    }
    setSavingTask(false);
    if (ok) {
      resetTaskForm();
      setShowTaskForm(false);
    }
  };

  const openCompletionPrompt = (taskId: string) => {
    rememberEditorScroll('completion');
    const task = state.tasks.find((item) => item.id === taskId);
    const totalMinutes = Number(task?.timeSpentMinutes || 0);
    const hours = totalMinutes ? String(Math.floor(totalMinutes / 60)) : '';
    const minutes = totalMinutes ? String(totalMinutes % 60) : '';
    const comment = task?.completionComments?.[currentUser.id] || '';
    setCompletingTaskId(taskId);
    setCompletionHours(hours);
    setCompletionMinutes(minutes);
    setCompletionComment(comment);
    setCompletionBaseline(JSON.stringify({ hours, minutes, comment }));
  };

  const closeCompletionPrompt = (force = false) => {
    if (savingCompletion) return;
    const dirty = JSON.stringify({ hours: completionHours, minutes: completionMinutes, comment: completionComment }) !== completionBaseline;
    if (!force && dirty && !window.confirm('Закрыть окно и удалить несохранённые данные о выполнении?')) return;
    setCompletingTaskId(null);
    setCompletionHours('');
    setCompletionMinutes('');
    setCompletionComment('');
    setCompletionBaseline('');
    restoreEditorScroll('completion');
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
    if (ok) closeCompletionPrompt(true);
  };

  const reopenCompletedTask = async () => {
    if (!completingTaskId || savingCompletion) return;
    setSavingCompletion(true);
    setTaskError('');
    try {
      const response = await fetch('/api/task/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: completingTaskId,
          version: state.tasks.find((task) => task.id === completingTaskId)?.version,
          status: 'in_progress',
          requesterId: currentUser.id,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Не удалось вернуть задачу в работу');
      await onRefreshState();
      setTaskNotice('Задача снова в работе. Комментарий можно исправить при следующем завершении.');
      setSavingCompletion(false);
      closeCompletionPrompt(true);
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
    if (!task || !window.confirm(`Отменить задачу «${task.title}»? Она исчезнет из активных списков, исполнители получат уведомление, а запись останется в журнале.`)) return;
    setTaskError('');
    setTaskNotice('');
    try {
      const response = await fetch('/api/task/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterId: currentUser.id, taskId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Не удалось отменить задачу');
      await onRefreshState();
      setTaskNotice('Задача отменена и убрана из активных списков.');
    } catch (error: any) {
      setTaskError(error.message || 'Не удалось отменить задачу.');
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

  const setBroadcastRecipientMode = (mode: BroadcastFormDraft['mode']) => {
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
      setBroadcastRecipients(broadcastEligibleUsers
        .filter((user) => next.some((block) => user.primaryCompetency === block || user.competencies?.includes(block)))
        .map((user) => user.id));
      return next;
    });
  };

  const submitBroadcast = async (event: React.FormEvent) => {
    event.preventDefault();
    if (broadcastSaving) return;
    setBroadcastError('');
    setBroadcastNotice('');
    if (!broadcastBody.trim()) {
      setBroadcastError('Напиши текст рассылки. Черновик уже сохранён.');
      return;
    }
    if (broadcastMode === 'blocks' && !broadcastBlocks.length) {
      setBroadcastError('Выбери хотя бы один блок получателей.');
      return;
    }
    if (broadcastMode === 'people' && !broadcastRecipients.length) {
      setBroadcastError('Выбери хотя бы одного получателя.');
      return;
    }
    if (broadcastMode === 'missing_slots' && !missingSlotBroadcastUsers.length) {
      setBroadcastError('Все участники уже отметили слоты на выбранную неделю.');
      return;
    }
    if (broadcastMode === 'groups' && !broadcastGroupsReady) {
      setBroadcastError('Выбери разрешённые группы или топики и проверь загруженный список. Черновик сохранён.'); return;
    }
    if (broadcastMode !== 'groups' && !broadcastAvailableUsers.length) {
      setBroadcastError('Среди выбранных людей нет доступных адресатов. Им нужно открыть MegaBot и отправить /start.');
      return;
    }
    const scheduledAt = broadcastDispatchMode === 'scheduled' ? broadcastScheduledAt(broadcastDate, broadcastTime) : null;
    if (broadcastDispatchMode === 'scheduled' && (!durableBroadcasts || !scheduledAt)) {
      setBroadcastError(durableBroadcasts ? 'Укажи корректные дату и время МСК.' : 'Этот сервер ещё не поддерживает расписание. Черновик сохранён.');
      return;
    }
    if (durableBroadcasts && `${broadcastTitle.trim()}${broadcastTitle.trim() ? '\n\n' : ''}${broadcastBody.trim()}`.length > 40000) {
      setBroadcastError('Заголовок и текст вместе должны быть не длиннее 40000 символов.');
      return;
    }
    setBroadcastSaving(true);
    try {
      const timing = durableBroadcasts ? { dispatchMode: broadcastDispatchMode, ...(scheduledAt ? { scheduledAt } : {}), zoneId: 'Europe/Moscow', misfirePolicy: broadcastMisfirePolicy } : {};
      const request = broadcastMode === 'groups' ? {
        recipientMode: 'groups', groupTargetIds: broadcastGroupIds, title: broadcastTitle, body: broadcastBody, ...timing,
      } : {
          requesterId: currentUser.id,
          recipientMode: broadcastMode,
          availabilityWeekIndex: broadcastWeekIndex,
          competencies: broadcastBlocks,
          recipientIds: broadcastRecipients,
          title: broadcastTitle,
          body: broadcastBody,
          ...timing,
        };
      const result = durableBroadcasts
        ? await broadcastJson(broadcastMode === 'groups' ? '/api/v1/broadcasts' : '/api/team/broadcast', { body: request, key: broadcastRequestKey(window.sessionStorage, currentUser.id, request, () => window.confirm('Поля изменены после запроса без подтверждённого результата. Сервер мог уже сохранить предыдущую рассылку. Проверь историю. Создать отдельную новую рассылку с изменёнными полями?')) })
        : await (async () => {
          const response = await idempotentPost('/api/team/broadcast', request);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Не удалось отправить рассылку');
          return data;
        })();
      const broadcastId = broadcastMode === 'groups' ? result.id : result.broadcastId;
      if (broadcastMode === 'groups' && (!Number.isSafeInteger(result.targetCount) || result.targetCount < 1)) throw new Error('Сервер не подтвердил адресатов. Проверь историю и повтори запрос; черновик сохранён.');
      if (durableBroadcasts && (typeof broadcastId !== 'string' || !broadcastId)) {
        throw new Error('Сервер не подтвердил создание. Повтори запрос с тем же текстом; черновик сохранён.');
      }
      setBroadcastNotice(durableBroadcasts
        ? `Рассылка сохранена в очереди${scheduledAt ? ': ' + broadcastTimeLabel(scheduledAt) : ' для отправки сейчас'}. ${broadcastMode === 'groups' ? result.targetCount + ' разрешённых адресатов. Доступность бота проверяется при отправке.' : result.recipients + ' адресатов, недоступно: ' + (result.unavailable || 0) + '.'} Это ещё не подтверждение Telegram. Результат — в истории рассылок.`
        : [
        `Telegram подтвердил отправку: ${result.delivered || 0} из ${result.recipients || 0}. Это не означает прочтение.`,
        result.unavailable ? `Недоступно без /start: ${result.unavailable}.` : '',
        result.pending ? `Ожидают автоматического повтора: ${result.pending}.` : '',
        result.attention ? `Нужно решение администратора: ${result.attention}.` : '',
        result.failed ? `Не подтверждено Telegram: ${result.failed}.` : '',
      ].filter(Boolean).join(' '));
      setBroadcastTitle('');
      setBroadcastBody('');
      setBroadcastBlocks([]);
      setBroadcastRecipients([]);
      setBroadcastGroupIds([]);
      setBroadcastSearch('');
      setShowBroadcastBlocks(false);
      setShowBroadcastPeople(false);
      setBroadcastDraftNotice('');
      setBroadcastDispatchMode('now'); setBroadcastDate(''); setBroadcastTime('12:00'); setBroadcastMisfirePolicy('send_late');
      setBroadcastHistoryRevision(value => value + 1);
      removeFormDraft(window.sessionStorage, currentUser.id, 'broadcast');
      removeFormDraft(window.sessionStorage, currentUser.id, 'broadcast-request');
      // Queue acceptance is already confirmed. A state refresh cannot undo it.
      void Promise.resolve().then(() => onRefreshState()).catch(() => {});
    } catch (error: any) {
      const message = error instanceof TypeError || /failed to fetch|network/i.test(String(error?.message || ''))
        ? 'Нет соединения с сервером. Проверь интернет и повтори отправку — черновик сохранён.'
        : error.message || 'Не удалось отправить рассылку. Проверь соединение и повтори — черновик сохранён.';
      setBroadcastError(message);
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

  const clearArchivedTasks = async () => {
    if (!isAdmin) return;
    const previewResponse = await fetch('/api/task/archive/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id }),
    });
    const preview = await previewResponse.json();
    if (!previewResponse.ok) return setTaskError(preview.error || 'Не удалось проверить архив');
    if (!preview.count) return setTaskNotice('Архив уже пуст. Активные задачи не затронуты.');
    const confirmed = window.confirm(`Удалить ${preview.count} архивных задач: выполнено — ${preview.completedCount}, отменено — ${preview.cancelledCount}? Открытые и активные задачи останутся.`);
    if (!confirmed) return;
    const response = await fetch('/api/task/archive/clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id, taskIds: preview.taskIds }),
    });
    const body = await response.json();
    if (!response.ok) return setTaskError(body.error || 'Не удалось очистить архив');
    setTaskNotice(`Удалено архивных задач: ${body.removedCount}. Резервная копия: ${body.backupId}.`);
    await onRefreshState();
  };

  const loadDeliveryIssues = async () => {
    if (!isAdmin) return;
    setDeliveryJournalBusy(true);
    setDeliveryJournalError('');
    try {
      const response = await fetch('/api/notification-deliveries');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось загрузить журнал доставки');
      const issues = (result.deliveries || []).filter((item: DeliveryIssue) => item.status === 'failed' || item.status === 'unknown');
      setDeliveryIssues(issues);
      setSelectedDeliveryIds((current) => current.filter((id) => issues.some((item: DeliveryIssue) => item.id === id)));
    } catch (error: any) {
      setDeliveryJournalError(error.message || 'Не удалось загрузить журнал доставки');
    } finally {
      setDeliveryJournalBusy(false);
    }
  };

  const toggleDeliveryJournal = async () => {
    const next = !deliveryJournalOpen;
    setDeliveryJournalOpen(next);
    setDiagnosticsOpen(false);
    if (next) await loadDeliveryIssues();
  };

  const loadDiagnostics = async () => {
    if (!isAdmin || diagnosticsBusy) return;
    setDiagnosticsBusy(true);
    setDiagnosticsError('');
    try {
      const response = await fetch('/api/admin/diagnostics');
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Не удалось получить состояние сервиса');
      setDiagnostics(result as OperationalDiagnostics);
    } catch (error: any) {
      setDiagnosticsError(error.message || 'Не удалось получить состояние сервиса');
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const toggleDiagnostics = async () => {
    const next = !diagnosticsOpen;
    setDiagnosticsOpen(next);
    setDeliveryJournalOpen(false);
    if (next && !diagnostics) await loadDiagnostics();
  };

  const retrySelectedDeliveries = async () => {
    if (!selectedDeliveryIds.length || deliveryJournalBusy) return;
    setDeliveryJournalBusy(true);
    setDeliveryJournalError('');
    try {
      const response = await fetch('/api/notification-deliveries/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterId: currentUser.id, ids: selectedDeliveryIds }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось повторить доставку');
      setSelectedDeliveryIds([]);
      await onRefreshState();
      await loadDeliveryIssues();
    } catch (error: any) {
      setDeliveryJournalError(error.message || 'Не удалось повторить доставку');
      setDeliveryJournalBusy(false);
    }
  };

  const resetTaskSeason = async () => {
    if (!isAdmin) return;
    const previewResponse = await fetch('/api/task/season-reset/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requesterId: currentUser.id }),
    });
    const preview = await previewResponse.json();
    if (!previewResponse.ok) return setTaskError(preview.error || 'Не удалось проверить задачи');
    if (!preview.count) return setTaskNotice('Задач для сезонного сброса нет.');
    const confirmation = window.prompt(`Сезонный сброс удалит все задачи (${preview.count}), включая активные. Перед удалением будет создана резервная копия. Введите: СБРОСИТЬ СЕЗОН`);
    if (confirmation === null) return;
    const response = await fetch('/api/task/season-reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id, taskIds: preview.taskIds, confirmation }),
    });
    const body = await response.json();
    if (!response.ok) return setTaskError(body.error || 'Не удалось выполнить сезонный сброс');
    setTaskNotice(`Сезон сброшен: удалено задач — ${body.removedCount}. Резервная копия: ${body.backupId}.`);
    await onRefreshState();
  };

  const addUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isAdmin) return;
    const res = await idempotentPost('/api/user/add', {
        requesterId: currentUser.id,
        realName: newUserRealName,
        username: newUserUsername,
        role: newUserRole,
        birthday: newUserBirthday,
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
    setProfilePrimaryBlockOpen(false);
    setProfileSecondaryBlocksOpen(false);
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
    const res = await idempotentPost('/api/faculty/user/add', { requesterId: currentUser.id, ...facultyUserDraft });
    if (res.ok) {
      setFacultyUserDraft({ realName: '', username: '', role: 'faculty_responsible', facultyId: faculties[0]?.id || '', competencies: [] });
      onRefreshState();
    }
  };

  const deleteFacultyUser = async (userId: string) => {
    if (!isAdmin) return;
    const confirmed = window.confirm('Деактивировать ответственного факультета? История сохранится, вход и новые назначения будут отключены.');
    if (!confirmed) return;
    let res = await fetch('/api/faculty/user/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id, userId }),
    });
    if (res.status === 409) {
      const conflict = await res.json();
      if (conflict.code === 'active_tasks_require_confirmation'
        && window.confirm(`${conflict.error}\nЗадач: ${conflict.impact?.activeTaskIds?.length || 0}. Продолжить?`)) {
        res = await fetch('/api/faculty/user/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requesterId: currentUser.id, userId, confirmTaskRelease: true }),
        });
      } else if (conflict.error) window.alert(conflict.error);
    }
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
    const facultyTaskBody = {
        requesterId: currentUser.id,
        taskId: editingFacultyTaskId,
        version: editingFacultyTaskId
          ? state.tasks.find((task) => task.id === editingFacultyTaskId)?.version
          : undefined,
        ...facultyTaskDraft,
      };
    const res = editingFacultyTaskId
      ? await fetch('/api/faculty/task/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(facultyTaskBody) })
      : await idempotentPost('/api/faculty/task/create', facultyTaskBody);
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
    const confirmed = window.confirm('Деактивировать человека? История сохранится, но вход, рассылки и новые назначения будут отключены.');
    if (!confirmed) return;
    let res = await fetch('/api/user/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: currentUser.id, userId }),
    });
    if (res.status === 409) {
      const conflict = await res.json();
      if (conflict.code === 'active_tasks_require_confirmation'
        && window.confirm(`${conflict.error}\nЗадач: ${conflict.impact?.activeTaskIds?.length || 0}. Продолжить?`)) {
        res = await fetch('/api/user/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requesterId: currentUser.id, userId, confirmTaskRelease: true }),
        });
      } else if (conflict.error) window.alert(conflict.error);
    }
    if (res.ok) onRefreshState();
  };

  const pageTitle = {
    slots: 'Моя неделя',
    meetings: 'Встречи',
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

  useEffect(() => {
    document.documentElement.classList.toggle('mega-calm-background', calmBackground);
    window.localStorage.setItem('megabattle-calm-background', String(calmBackground));
    return () => document.documentElement.classList.remove('mega-calm-background');
  }, [calmBackground]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const syncViewport = () => {
      const viewportHeight = viewport?.height || window.innerHeight;
      document.documentElement.style.setProperty('--mega-visual-viewport-height', `${Math.round(viewportHeight)}px`);
      const keyboardOpen = Boolean(viewport && window.innerHeight - viewport.height > 120);
      document.documentElement.classList.toggle('mega-keyboard-open', keyboardOpen);
    };
    syncViewport();
    viewport?.addEventListener('resize', syncViewport);
    viewport?.addEventListener('scroll', syncViewport);
    window.addEventListener('resize', syncViewport);
    return () => {
      viewport?.removeEventListener('resize', syncViewport);
      viewport?.removeEventListener('scroll', syncViewport);
      window.removeEventListener('resize', syncViewport);
      document.documentElement.classList.remove('mega-keyboard-open');
      document.documentElement.style.removeProperty('--mega-visual-viewport-height');
    };
  }, []);

  const hasUnsavedDraft = taskDraftDirty || meetingDraftDirty || broadcastDraftDirty || dirtyWeekIndexes.length > 0;
  const hasOpenEditor = showTaskForm || showMeetingForm || completingTaskId !== null || avatarEditorSource !== null
    || showEventForm || broadcastOpen || showAddUserForm || editingUserId !== null || editingFacultyTaskId !== null || editingFacultyUserId !== null;

  useEffect(() => {
    if (!hasUnsavedDraft) return;
    const warnBeforeClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeClose);
    return () => window.removeEventListener('beforeunload', warnBeforeClose);
  }, [hasUnsavedDraft]);

  useEffect(() => {
    const webApp = (window as any).Telegram?.WebApp;
    if (typeof webApp?.isVersionAtLeast === 'function' && !webApp.isVersionAtLeast('6.1')) return;
    const backButton = webApp?.BackButton;
    if (!backButton?.show || !backButton?.hide || !backButton?.onClick || !backButton?.offClick) return;
    const shouldShow = hasOpenEditor || activeTab === 'profile' || activeTab === 'admin';
    const goBack = () => {
      if (avatarEditorSource) return setAvatarEditorSource(null);
      if (completingTaskId) return closeCompletionPrompt();
      if (showTaskForm) return discardTaskForm();
      if (showMeetingForm) return discardMeetingForm();
      if (showEventForm) return closeWorkEventForm();
      if (broadcastOpen) return setBroadcastOpen(false);
      if (showAddUserForm) return setShowAddUserForm(false);
      if (editingUserId) return setEditingUserId(null);
      if (editingFacultyTaskId) return setEditingFacultyTaskId(null);
      if (editingFacultyUserId) return setEditingFacultyUserId(null);
      if (activeTab === 'admin' || activeTab === 'profile') return navigateBack();
    };
    if (shouldShow) {
      backButton.show();
      backButton.onClick(goBack);
    } else {
      backButton.hide();
    }
    return () => {
      backButton.offClick(goBack);
      if (shouldShow) backButton.hide();
    };
  }, [activeTab, avatarEditorSource, broadcastOpen, completingTaskId, editingFacultyTaskId, editingFacultyUserId, editingUserId, hasOpenEditor, navigateBack, showAddUserForm, showEventForm, showMeetingForm, showTaskForm]);

  return (
    <div className="mega-shell min-h-screen text-slate-950">
      <header className="mega-header sticky top-0 z-30 overflow-hidden text-white">
        <div className="mega-header-inner relative px-4 pb-3">
          <div className="flex items-center justify-between gap-3">
            <img className="mega-logo" src="/brand/megabattle-logo.svg" alt="ITMO MegaBattle" />
            <div className="mega-profile-trigger min-w-0 flex-1 text-left">
              <p className="mega-context truncate">{currentUser.realName} · {isAdmin ? 'администратор' : 'организатор'}</p>
              <h1 className="mega-page-title line-clamp-2">{pageTitle}</h1>
            </div>
            <div className="mega-header-actions flex shrink-0 items-center gap-2">
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
                onClick={() => navigateToTab('profile')}
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
              <div className="mega-heading-action-row mb-4 flex min-w-0 flex-col items-stretch justify-between gap-3 min-[360px]:flex-row min-[360px]:items-center">
                <h2 className="min-w-0 text-lg font-black text-slate-950">Профиль</h2>
                <button
                  type="button"
                  onClick={() => editingUserId === currentUser.id ? setEditingUserId(null) : startUserEdit(currentUser)}
                  className={`${miniButtonClass} min-h-11 w-full shrink-0 px-3 min-[360px]:w-auto`}
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
                  <h2 className="break-words text-lg font-black">{currentUser.realName}</h2>
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

              <button
                type="button"
                className="mt-4 flex min-h-11 w-full items-center justify-between gap-3 rounded-2xl border border-blue-100 bg-slate-50 px-3 py-2 text-left"
                aria-pressed={calmBackground}
                onClick={() => setCalmBackground((enabled) => !enabled)}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-black">Спокойный фон</span>
                  <span className="block text-xs font-semibold text-slate-500">Остановить движение линий</span>
                </span>
                <span className={`relative h-6 w-11 shrink-0 rounded-full transition ${calmBackground ? 'bg-[#0069E0]' : 'bg-slate-200'}`} aria-hidden="true">
                  <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${calmBackground ? 'translate-x-6' : 'translate-x-1'}`} />
                </span>
              </button>

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
                    <DatePickerField label="Дата рождения" value={userDraft.birthday} onChange={(value) => setUserDraft((prev) => ({ ...prev, birthday: value }))} placeholder="Выбери дату" fullYear />
                  </Field>
                  <ProfileBlockSelectors
                    competencies={competencies}
                    selected={userDraft.competencies}
                    primary={userDraft.primaryCompetency}
                    primaryOpen={profilePrimaryBlockOpen}
                    secondaryOpen={profileSecondaryBlocksOpen}
                    onTogglePrimary={() => setProfilePrimaryBlockOpen((open) => !open)}
                    onToggleSecondary={() => setProfileSecondaryBlocksOpen((open) => !open)}
                    onPrimaryChange={(name) => setUserDraft((prev) => ({
                      ...prev,
                      primaryCompetency: name,
                      competencies: prev.competencies.includes(name) ? prev.competencies : [name, ...prev.competencies],
                    }))}
                    onSecondaryToggle={toggleDraftCompetency}
                  />
                  {teamError && <p role="alert" className="text-sm font-bold text-rose-600">{teamError}</p>}
                  <div className="grid grid-cols-2 gap-2">
                    <Button type="button" variant="secondary" onClick={() => setEditingUserId(null)}>Отмена</Button>
                    <Button type="button" onClick={() => void updateUser(currentUser.id)} pending={savingUserId === currentUser.id}>
                      {savingUserId === currentUser.id ? 'Сохраняю…' : 'Сохранить'}
                    </Button>
                  </div>
                </div>
              )}

              {profileHasTaskHistory ? (
                <div className="mt-5 grid grid-cols-2 overflow-hidden rounded-2xl border border-blue-100 bg-slate-50 sm:grid-cols-4">
                  {[
                    ['Завершено из назначенных', `${profileCompletedTasks.length} из ${profileAssignedTasks.length}`],
                    ['Сейчас в работе', myTasks.length],
                    ['В срок среди задач с дедлайном', profileDatedCompletedTasks.length ? `${profileOnTimeTasks.length} из ${profileDatedCompletedTasks.length}` : 'Нет задач с дедлайном'],
                    ['Учтено времени', taskDurationText(profileTrackedMinutes) || 'Время пока не указано'],
                  ].map(([label, value], index) => (
                    <div key={String(label)} className={`min-w-0 p-3 ${index % 2 ? 'border-l border-blue-100' : ''} ${index > 1 ? 'border-t border-blue-100 sm:border-t-0 sm:border-l' : ''}`}>
                      <div className="break-words text-lg font-black text-[#0069E0]">{value}</div>
                      <div className="mt-1 text-xs font-bold text-slate-500">{label}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <InlineNotice className="mt-5">Статистика появится после первой назначенной или созданной задачи.</InlineNotice>
              )}

              <div className="mt-4 space-y-2 text-sm text-slate-600">
                <InfoRow label="Главный блок" value={currentUser.primaryCompetency || 'не выбран'} />
                <InfoRow label="Другие блоки" value={(currentUser.competencies || []).filter((item) => item !== currentUser.primaryCompetency).join(', ') || 'не выбраны'} />
                <InfoRow label="Статус слотов" value={profileSlotsCompleted ? 'неделя сохранена' : 'нужно отметить'} />
              </div>
            </div>

            {isAdmin && (
              <button
                type="button"
                onClick={() => navigateToTab('admin')}
                className={`${primaryButtonClass} py-4 text-base`}
              >
                <Shield className="h-5 w-5" weight="fill" />
                Админская панель
              </button>
            )}

            {profileHasTaskHistory && (
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
            )}

            <div className="rounded-3xl border border-blue-100 bg-white p-5 shadow-sm">
              <h3 className="text-lg font-black">Ритм недели</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">Как распределены доступность и нагрузка</p>
              <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-blue-100 bg-blue-100">
                {[
                  ['Дней со слотами', `${profileAvailableDays} из ${activeDays.length}`],
                  ['Свободных часов', profileAvailableHours],
                  ['Самый свободный день', profileBestAvailability?.hours ? profileBestAvailability.day : 'Пока не отмечен'],
                  ['Среднее время задачи', profileAverageMinutes ? taskDurationText(profileAverageMinutes) : 'Пока нет данных'],
                ].map(([label, value]) => (
                  <div key={String(label)} className="min-w-0 bg-slate-50 p-3">
                    <div className="break-words text-base font-black text-[#0069E0]">{value}</div>
                    <div className="mt-1 text-xs font-bold text-slate-500">{label}</div>
                  </div>
                ))}
              </div>
              {!profileSlotsCompleted && (
                <p className="mt-4 rounded-2xl bg-blue-50 px-3 py-2 text-sm font-bold text-[#005BC4]">
                  Для каждого рабочего дня выбери свободные часы или нажми «Не смогу», затем сохрани неделю.
                </p>
              )}
            </div>
          </section>
        )}

        {isAdminPanel && (
          <section className="space-y-4">
            <div className="mega-admin-tabs rounded-2xl border border-blue-100 bg-white p-1.5 shadow-sm" role="tablist" aria-label="Разделы админской панели">
              <div className="grid grid-cols-2 gap-1 min-[480px]:grid-cols-3 sm:grid-cols-6">
                {([
                  ['team', 'Команда'],
                  ['events', 'Мероприятия'],
                  ['slots', 'Слоты'],
                  ['meetings', 'Встречи'],
                  ['tasks', 'Задачи'],
                  ['faculties', 'Факультеты'],
                ] as const).map(([section, label]) => (
                  <button
                    key={section}
                    type="button"
                    role="tab"
                    aria-selected={adminSection === section}
                    onClick={() => setAdminSection(section)}
                    className={`min-h-11 min-w-0 break-words rounded-xl px-1.5 py-2 text-[11px] font-black leading-tight transition sm:px-2 ${adminSection === section ? 'bg-[#0069E0] text-white shadow-[0_8px_20px_rgba(0,105,224,0.2)]' : 'text-[#4D647A] hover:bg-blue-50 hover:text-[#005BC4] active:bg-blue-100'}`}
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
                      <Field label="Начало"><DatePickerField label="Дата начала мероприятия" value={eventStartsAt} onChange={setEventStartsAt} placeholder="Не указано" /></Field>
                      <Field label="Завершение"><DatePickerField label="Дата завершения мероприятия" value={eventEndsAt} onChange={setEventEndsAt} placeholder="Не указано" /></Field>
                    </div>
                    <Button pending={eventSaving}>{eventSaving ? 'Сохраняю...' : editingEventId ? 'Сохранить изменения' : 'Создать мероприятие'}</Button>
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
                              <Badge variant={workEvent.status === 'active' ? 'success' : 'neutral'}>{workEvent.status === 'active' ? 'В работе' : 'Завершено'}</Badge>
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
                {slotNotice && <InlineNotice variant="success" className="mt-3">{slotNotice}</InlineNotice>}
                {slotError && <InlineNotice variant="warning" className="mt-3">{slotError}</InlineNotice>}
              </div>
            )}

            {adminSection === 'meetings' && (
              <div className="space-y-4">
                {showMeetingForm && editingMeetingId && (
                  <form ref={meetingFormRef} onSubmit={submitMeeting} className="scroll-mt-24 space-y-3 rounded-3xl border border-blue-100 bg-white p-4 shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="font-black">{`Редактировать ${meetingKindText(meetingKind).accusative}`}</h2>
                      <button type="button" onClick={discardMeetingForm} className={miniButtonClass}><X className="h-4 w-4" /> Закрыть</button>
                    </div>
                    {meetingDraftNotice && <InlineNotice>{meetingDraftNotice}</InlineNotice>}
                    {meetingDraftConflict && <InlineNotice variant="warning">Сохранение приостановлено: встреча была изменена в другом окне.</InlineNotice>}
                    {meetingError && <InlineNotice variant="error" focusOnMount>{meetingError}</InlineNotice>}
                    <MeetingKindPicker value={meetingKind} onChange={selectMeetingKind} />
                    <Field label="Название"><input value={meetingTitle} onChange={(event) => setMeetingTitle(event.target.value)} className={inputClass} /></Field>
                    {meetingKind === 'setup' && (
                      <Field label="Мероприятие">
                        <select value={meetingEventId} onChange={(event) => setMeetingEventId(event.target.value)} className={selectClass} required>
                          <option value="">Выбери мероприятие</option>
                          {allEvents.filter((item) => item.status === 'active' || item.id === meetingEventId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                      </Field>
                    )}
                    <div className="grid min-w-0 grid-cols-1 gap-3 min-[720px]:grid-cols-3">
                      <Field label="Дата"><DatePickerField label="Дата встречи" value={meetingDate} onChange={setMeetingDate} placeholder="Выбери дату" /></Field>
                      <Field label="Время"><input type="time" value={meetingTime} onChange={(event) => setMeetingTime(event.target.value)} className={inputClass} /></Field>
                      <Field label="Длительность">
                        <select value={meetingDuration} onChange={(event) => setMeetingDuration(event.target.value)} className={selectClass}>
                          <MeetingDurationOptions kind={meetingKind} value={meetingDuration} />
                        </select>
                      </Field>
                    </div>
                    {meetingKind !== 'setup' && <MeetingAudiencePicker value={meetingType} onChange={setMeetingAudience} />}
                    {meetingKind !== 'setup' && meetingType === 'competency' && (
                      <Field label="Блок">
                        <select value={meetingCompetency} onChange={(event) => selectMeetingCompetency(event.target.value)} className={selectClass}>
                          <option value="">Выбери блок</option>
                          {competencies.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                      </Field>
                    )}
                    {meetingKind !== 'setup' && (meetingType === 'custom' || meetingType === 'competency') && (
                      <div className="grid grid-cols-1 gap-2">
                        {(showAllMeetingParticipants ? coreTeamUsers : coreTeamUsers.slice(0, 3)).map((user) => (
                          <label key={user.id} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                            <span>{user.realName}</span>
                            <input type="checkbox" checked={participants.includes(user.id)} onChange={() => setParticipants((prev) => prev.includes(user.id) ? prev.filter((id) => id !== user.id) : [...prev, user.id])} />
                          </label>
                        ))}
                        {coreTeamUsers.length > 3 && <ListDisclosure expanded={showAllMeetingParticipants} onToggle={() => setShowAllMeetingParticipants((value) => !value)} total={coreTeamUsers.length} />}
                      </div>
                    )}
                    {meetingKind !== 'setup' && (
                      <div className="border-t border-slate-100 pt-3">
                        <button type="button" aria-expanded={showMeetingExtras} aria-controls="meeting-extra-fields" onClick={() => setShowMeetingExtras((value) => !value)} className={`${secondaryButtonClass} w-full justify-between`}>
                          <span>Дополнительно</span>
                          {showMeetingExtras ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
                        </button>
                        {showMeetingExtras && (
                          <div id="meeting-extra-fields" className="mt-3 space-y-3">
                            <Field label="Тема"><input value={meetingTopic} onChange={(event) => setMeetingTopic(event.target.value)} className={inputClass} /></Field>
                            <Field label="Описание"><textarea value={meetingDescription} onChange={(event) => setMeetingDescription(event.target.value)} className={inputClass} rows={3} /></Field>
                          </div>
                        )}
                      </div>
                    )}
                    <Button pending={savingMeeting} disabled={meetingDraftConflict}>{savingMeeting ? 'Сохраняю...' : meetingKind === 'setup' ? 'Сохранить монтаж' : 'Сохранить встречу'}</Button>
                  </form>
                )}

                <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                  <h2 className="font-black">Управление встречами</h2>
                  <p className="mt-1 text-xs font-semibold text-slate-500">Редактирование и удаление встреч всей команды.</p>
                  <div className="mt-4 space-y-3">
                    {scheduledMeetings.length === 0 ? <EmptyState text="Встреч пока нет" /> : scheduledMeetings.map((meeting) => {
                      const host = state.users.find((user) => user.id === meeting.hostId);
                      const workEvent = allEvents.find((item) => item.id === meeting.eventId);
                      return (
                        <div key={meeting.id} className="rounded-2xl bg-slate-50 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2 font-black">
                                {meeting.title}
                                {normalizeMeetingKind(meeting.kind) !== 'meeting' && <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-black uppercase tracking-wide text-[#005BC4]">{meetingKindText(meeting.kind).label}</span>}
                              </div>
                              {meeting.kind === 'setup' && <div className="mt-1 text-xs font-bold text-[#005BC4]">{workEvent?.name || 'Мероприятие не найдено'}</div>}
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
                    <h2 className="font-black">Архив задач</h2>
                    <p className="mt-1 text-xs font-semibold text-slate-500">Очистка архива удаляет только выполненные и отменённые задачи. Активные задачи остаются.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a href="https://docs.google.com/spreadsheets/d/1R1MtYJfEuGNw0JI_laNmRk_Un7wIQwxt0xRYTp3mih4/edit?gid=326388773#gid=326388773" target="_blank" rel="noreferrer" className={miniButtonClass}>
                      <ArrowSquareOut className="h-4 w-4" /> Таблица лога
                    </a>
                    <button onClick={clearArchivedTasks} className={`${miniButtonClass} border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 active:bg-amber-200`}>
                      <Trash className="h-4 w-4" /> Удалить архив · {state.tasks.filter((task) => task.status === 'completed' || task.status === 'cancelled').length}
                    </button>
                    <button onClick={resetTaskSeason} className={`${miniButtonClass} border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 active:bg-rose-200`}>
                      <Trash className="h-4 w-4" /> Сезонный сброс · {state.tasks.length}
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
            {slotNotice && <InlineNotice variant="success">{slotNotice}</InlineNotice>}

            <div className="space-y-4">
              {Array.from({ length: visibleWeeks }, (_, weekIndex) => {
                const weekRange = `${formatDayMonth(dateForSlotDay(weekIndex * 7 + activeDays[0]))}–${formatDayMonth(dateForSlotDay(weekIndex * 7 + activeDays[activeDays.length - 1]))}`;
                const weekDirty = dirtyWeekIndexes.includes(weekIndex);
                const weekOut = outWeekIndexes.includes(weekIndex);
                return (
                <div key={availabilityConfig.weekStarts[weekIndex]} className="space-y-3">
                  <div className="flex min-w-0 items-start gap-2 px-1">
                    <div className="min-w-0 flex-1">
                      {isAdmin ? (
                        <button
                          type="button"
                          aria-expanded={expandedWeekInfoIndex === weekIndex}
                          aria-controls={`week-info-${weekIndex}`}
                          onClick={() => {
                            const opening = expandedWeekInfoIndex !== weekIndex;
                            setExpandedWeekInfoIndex(opening ? weekIndex : null);
                            if (opening) {
                              setWeekNameDraft(availabilityConfig.weekNames[weekIndex]);
                              setWeekDescriptionDraft(availabilityConfig.weekDescriptions[weekIndex]);
                            }
                          }}
                          className="mega-week-title flex max-w-full items-center gap-2 rounded-xl border border-slate-300 bg-white/70 px-3 py-2 text-left text-slate-950 shadow-sm"
                        >
                          <span className="min-w-0 flex-1 break-words">{availabilityConfig.weekNames[weekIndex]}</span>
                          <CaretDown className={`h-4 w-4 shrink-0 transition-transform ${expandedWeekInfoIndex === weekIndex ? 'rotate-180' : ''}`} aria-hidden="true" />
                        </button>
                      ) : (
                        <div className="mega-week-title max-w-full rounded-xl border border-slate-300 bg-white/70 px-3 py-2 text-slate-950">
                          <span className="break-words">{availabilityConfig.weekNames[weekIndex]}</span>
                        </div>
                      )}
                      <p className="mt-1 text-xs font-semibold text-slate-500">
                        {weekRange}
                      </p>
                      {availabilityConfig.weekDescriptions[weekIndex] && (
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs font-semibold leading-relaxed text-slate-600">{availabilityConfig.weekDescriptions[weekIndex]}</p>
                      )}
                      {weekDirty && <p className="mt-1 text-xs font-black text-[#005BC4]">● Есть несохранённые изменения</p>}
                    </div>
                    <button
                      type="button"
                      aria-pressed={weekOut}
                      aria-describedby={`week-out-help-${weekIndex}`}
                      onClick={() => toggleOutWeek(weekIndex)}
                      className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-2 text-xs font-black ${pressClass} ${
                        weekOut
                          ? 'border-rose-300 bg-rose-50 text-rose-800'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 active:bg-slate-100'
                      }`}
                    >
                      Я в ауте
                    </button>
                  </div>

                  <p id={`week-out-help-${weekIndex}`} className={`mx-1 text-xs font-semibold ${weekOut ? 'text-rose-700' : 'text-slate-500'}`}>
                    {weekOut && 'Недоступен всю неделю. Отдельные дни и часы не отправятся.'}
                  </p>

                  {isAdmin && expandedWeekInfoIndex === weekIndex && (
                    <div id={`week-info-${weekIndex}`} className="mx-1 rounded-2xl border border-blue-100 bg-white p-3 shadow-sm">
                        <form className="space-y-3" onSubmit={async (event) => {
                          event.preventDefault();
                          if (!weekNameDraft.trim()) {
                            setSlotError('Название недели не может быть пустым.');
                            return;
                          }
                          setSlotError('');
                          setSavingWeekInfoIndex(weekIndex);
                          await onRenameAvailabilityWeek(weekIndex, availabilityConfig.weekStarts[weekIndex], weekNameDraft, weekDescriptionDraft);
                          setSavingWeekInfoIndex(null);
                        }}>
                          <Field label="Название недели">
                            <input maxLength={80} value={weekNameDraft} onChange={(event) => setWeekNameDraft(event.target.value)} className={inputClass} />
                          </Field>
                          <Field label="Описание недели">
                            <textarea maxLength={600} rows={3} value={weekDescriptionDraft} onChange={(event) => setWeekDescriptionDraft(event.target.value)} className={inputClass} placeholder="Например, подготовка площадки и финальные согласования" />
                          </Field>
                          <button type="submit" disabled={savingWeekInfoIndex === weekIndex} className={`${primaryCompactButtonClass} w-full disabled:opacity-60`}>
                            {savingWeekInfoIndex === weekIndex ? 'Сохраняю…' : 'Сохранить неделю'}
                          </button>
                        </form>
                    </div>
                  )}

                  {!weekOut && activeDayLabels.map((day) => {
                    const absoluteDayIndex = weekIndex * 7 + day.dayIndex;
                    const selected = slots[absoluteDayIndex] || [];
                    const unavailable = hardUnavailableDays.includes(absoluteDayIndex);
                    const date = dateForSlotDay(absoluteDayIndex);
                    return (
                      <div key={`${weekIndex}-${day.full}`} className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                        <div className="mb-3 min-w-0">
                          <h2 className="whitespace-nowrap text-sm font-black leading-tight sm:text-base"><span className="sm:hidden">{day.short},</span><span className="hidden sm:inline">{day.full},</span> {formatDayMonth(date)}</h2>
                          {(unavailable || !selected.length) && <p className={`text-xs font-semibold ${unavailable ? 'text-slate-700' : 'text-slate-500'}`} role="status">
                            {unavailable ? 'Не смогу' : 'Не заполнено'}
                          </p>}
                        </div>
                        <div className="mb-3 grid grid-cols-2 gap-2">
                          <button type="button" aria-pressed={selected.length === hours.length} onClick={() => selectWholeDay(absoluteDayIndex)} className={`${secondaryButtonClass} min-h-11 min-w-0 !rounded-2xl px-2.5`}>
                            {selected.length === hours.length ? 'Очистить' : 'Весь день'}
                          </button>
                          <button
                            type="button"
                            aria-pressed={unavailable}
                            onClick={() => toggleUnavailableDay(absoluteDayIndex)}
                            className={`min-h-11 min-w-0 rounded-2xl border px-2.5 text-sm font-black ${pressClass} ${
                              unavailable
                                ? 'border-slate-800 bg-slate-800 text-white hover:bg-slate-700 active:bg-slate-950'
                                : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 active:bg-slate-100'
                            }`}
                          >
                            Не смогу
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2 min-[560px]:grid-cols-4">
                          {hours.map((hour) => {
                            const active = selected.includes(hour);
                            return (
                              <button
                                key={hour}
                                type="button"
                                aria-pressed={active}
                                aria-label={`${active ? 'Выбрано' : 'Выбрать'}: ${formatHourRange(hour)}`}
                                onClick={() => toggleSlot(absoluteDayIndex, hour)}
                                className={`min-h-11 rounded-2xl border px-2 text-xs font-black sm:text-sm ${pressClass} ${
                                  active
                                    ? 'border-[#0069E0] bg-[#0069E0] text-white shadow-[0_8px_20px_rgba(0,105,224,0.2)] hover:bg-[#1677E8] active:bg-[#0058BD]'
                                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 active:bg-slate-100'
                                }`}
                              >
                                {formatHourRange(hour)}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  {weekDirty && (
                    <div className="flex flex-col gap-2 rounded-2xl border border-blue-100 bg-white p-2 min-[480px]:flex-row min-[480px]:items-center">
                      <div className="min-w-0 flex-1 px-2 py-1">
                        <p className="text-xs font-black text-[#005BC4]">Есть несохранённые изменения</p>
                        <p className="mt-0.5 break-words text-xs font-semibold text-slate-600">{availabilityConfig.weekNames[weekIndex]} · {weekRange}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void saveWeek(weekIndex)}
                        disabled={savingWeekIndex !== null}
                        aria-busy={savingWeekIndex === weekIndex}
                        className={`${primaryCompactButtonClass} min-h-11 w-full px-4 min-[480px]:w-auto disabled:opacity-70`}
                      >
                        <span aria-live="polite">{savingWeekIndex === weekIndex ? 'Сохраняю…' : 'Сохранить неделю'}</span>
                      </button>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </section>
        )}

        {activeTab === 'meetings' && (
          <section className="flex flex-col gap-4">
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
                          const outForWeek = alignedOutWeekIndexes(state.availabilities[user.id]).includes(0);
                          const text = outForWeek
                            ? 'В ауте'
                            : formatHours(alignedSlots(state.availabilities[user.id])?.[day.dayIndex] || []);
                          const filled = text !== '—';
                          return (
                            <td key={day.dayIndex} className="px-2 py-2 align-top">
                              <div className={`min-h-10 rounded-xl px-2 py-1.5 text-center font-bold ${outForWeek ? 'bg-rose-50 text-rose-700' : filled ? 'bg-blue-50 text-[#0069E0]' : 'bg-slate-50 text-[#718293]'}`}>{text}</div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {calendarUsers.length > 3 && (
                <ListDisclosure expanded={showFullCalendar} onToggle={() => setShowFullCalendar((value) => !value)} total={calendarUsers.length} className="mt-3" />
              )}
            </div>

            <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
              <h2 className="font-black">Календарь свободных дней</h2>
              <div className="mt-3 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${activeDays.length}, minmax(0, 1fr))` }}>
                {availabilityByDay.filter((day) => activeDays.includes(day.dayIndex)).map((day) => {
                  const ratio = day.total ? day.count / day.total : 0;
                  const expanded = expandedAvailabilityDay === dayLabels.findIndex((item) => item.short === day.short);
                  const dayIndex = dayLabels.findIndex((item) => item.short === day.short);
                  return (
                    <button
                      key={day.short}
                      type="button"
                      onClick={() => {
                        setExpandedAvailabilityDay((value) => (value === dayIndex ? null : dayIndex));
                        setExpandedAvailabilityGroup(null);
                      }}
                      className={`rounded-2xl border p-2 text-center ${pressClass} ${expanded ? 'border-[#0069E0] bg-blue-50 shadow-[0_8px_22px_rgba(0,105,224,0.12)]' : 'border-blue-100 bg-slate-50 hover:bg-blue-50 active:bg-blue-100'}`}
                    >
                      <div className="text-xs font-black text-slate-500">{day.short}</div>
                      <div className="mt-2 text-lg font-black text-[#0069E0]">{day.count}</div>
                      <div className="text-xs font-bold text-slate-400">из {day.total}</div>
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
                  <p className="mt-1 text-xs font-semibold text-slate-500">Выбери список, чтобы посмотреть участников.</p>
                  <div className="mt-3 space-y-2">
                    <AvailabilityGroupDisclosure
                      title="Отметились"
                      count={availabilityByDay[expandedAvailabilityDay].users.length}
                      expanded={expandedAvailabilityGroup === 'available'}
                      onToggle={() => setExpandedAvailabilityGroup((value) => value === 'available' ? null : 'available')}
                      countClassName="bg-blue-100 text-[#005BC4]"
                    >
                      {availabilityByDay[expandedAvailabilityDay].users.length === 0 ? (
                        <AvailabilityEmptyState>Никто не отметил свободное время.</AvailabilityEmptyState>
                      ) : availabilityByDay[expandedAvailabilityDay].users.map((user) => (
                        <div key={user.id} className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 text-sm">
                          <div className="min-w-0">
                            <div className="truncate font-black">{user.realName}</div>
                            <a href={telegramLink(user.username)} onClick={(event) => openTelegramProfile(event, telegramLink(user.username))} className="block truncate text-xs font-bold text-[#0069E0]">{user.username}</a>
                          </div>
                          <div className="shrink-0 text-right font-black text-[#0069E0]">{formatHours(user.daySlots)}</div>
                        </div>
                      ))}
                    </AvailabilityGroupDisclosure>

                    <AvailabilityGroupDisclosure
                      title="Не отметились"
                      count={availabilityByDay[expandedAvailabilityDay].missingUsers.length}
                      expanded={expandedAvailabilityGroup === 'missing'}
                      onToggle={() => setExpandedAvailabilityGroup((value) => value === 'missing' ? null : 'missing')}
                      countClassName="bg-amber-100 text-amber-700"
                    >
                      {availabilityByDay[expandedAvailabilityDay].missingUsers.length === 0 ? (
                        <AvailabilityEmptyState>Все отметили этот день.</AvailabilityEmptyState>
                      ) : availabilityByDay[expandedAvailabilityDay].missingUsers.map((user) => (
                        <React.Fragment key={user.id}><AvailabilityPersonLink user={user} /></React.Fragment>
                      ))}
                    </AvailabilityGroupDisclosure>

                    <AvailabilityGroupDisclosure
                      title="Не смогут"
                      count={availabilityByDay[expandedAvailabilityDay].unavailableUsers.length}
                      expanded={expandedAvailabilityGroup === 'unavailable'}
                      onToggle={() => setExpandedAvailabilityGroup((value) => value === 'unavailable' ? null : 'unavailable')}
                      countClassName="bg-slate-200 text-slate-700"
                    >
                      {availabilityByDay[expandedAvailabilityDay].unavailableUsers.length === 0 ? (
                        <AvailabilityEmptyState>Никто не выбрал «Не смогу».</AvailabilityEmptyState>
                      ) : availabilityByDay[expandedAvailabilityDay].unavailableUsers.map((user) => (
                        <div key={user.id} className="flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1"><AvailabilityPersonLink user={user} /></div>
                          {user.outForWeek && <span className="shrink-0 rounded-full bg-rose-100 px-2 py-1 text-[10px] font-black text-rose-700">В ауте всю неделю</span>}
                        </div>
                      ))}
                    </AvailabilityGroupDisclosure>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="font-black">Лучшие слоты</h2>
                  <p className="text-xs text-slate-500">По всей команде — с причиной недоступности</p>
                </div>
                <button onClick={findSuggestions} disabled={suggesting} className={`mega-primary-button min-w-[5.5rem] shrink-0 whitespace-nowrap rounded-full bg-[#0069E0] px-5 py-2.5 text-xs font-black text-white shadow-[0_10px_24px_rgba(0,105,224,0.28)] hover:bg-[#1677E8] active:bg-[#0058BD] ${pressClass} disabled:opacity-70`}>
                  {suggesting ? 'Считаю...' : 'Найти'}
                </button>
              </div>
              <div className="mt-4 space-y-3 rounded-2xl bg-slate-50 p-3">
                <div>
                  <div className="mb-2 text-xs font-black text-slate-600">Неделя поиска</div>
                  <div className="grid grid-cols-2 gap-2">
                    {Array.from({ length: configuredWeekCount }, (_, weekIndex) => (
                      <button
                        key={weekIndex}
                        type="button"
                        aria-pressed={suggestionWeekIndex === weekIndex}
                        onClick={() => {
                          setSuggestionWeekIndex(weekIndex);
                          setSuggestions([]);
                          setSuggestionError('');
                        }}
                        className={`min-h-11 min-w-0 rounded-xl border px-2 text-xs font-black ${pressClass} ${
                          suggestionWeekIndex === weekIndex
                            ? 'border-[#0069E0] bg-[#0069E0] text-white'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        <span className="block break-words">{availabilityConfig.weekNames[weekIndex]}</span>
                        <span className="mt-0.5 block text-[10px] opacity-75">
                          {formatDayMonth(dateForSlotDay(weekIndex * 7))}–{formatDayMonth(dateForSlotDay(weekIndex * 7 + 6))}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-xs font-black text-slate-600">Дни поиска</div>
                  <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${activeDays.length}, minmax(0, 1fr))` }}>
                    {activeDays.map((dayIndex) => {
                      const selected = suggestionDays.includes(dayIndex);
                      return (
                        <button
                          key={dayIndex}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => toggleSuggestionDay(dayIndex)}
                          className={`min-h-11 min-w-0 rounded-xl border px-1 text-xs font-black ${pressClass} ${
                            selected
                              ? 'border-[#0069E0] bg-[#0069E0] text-white'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {dayLabels[dayIndex].short}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <Field label="Продолжительность собрания">
                  <select
                    value={suggestionDuration}
                    onChange={(event) => {
                      setSuggestionDuration(event.target.value);
                      setSuggestions([]);
                      setSuggestionError('');
                    }}
                    className={selectClass}
                  >
                    <option value="0.5">30 минут</option>
                    <option value="1">1 час</option>
                    <option value="1.5">1,5 часа</option>
                    <option value="2">2 часа</option>
                    <option value="2.5">2,5 часа</option>
                    <option value="3">3 часа</option>
                    <option value="4">4 часа</option>
                    <option value="5">5 часов</option>
                    <option value="6">6 часов</option>
                  </select>
                </Field>
              </div>
              {suggestionError && <div role="alert" className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800">{suggestionError}</div>}
              <div className="mt-4 space-y-3">
                {suggestions.length === 0 ? (
                  <EmptyState text="Нажми «Найти», когда команда заполнит слоты." />
                ) : (
                  suggestions.map((suggestion, index) => (
                    <div key={`${suggestion.dayIndex}-${suggestion.hour}-${suggestion.endHour || ''}`} className="overflow-hidden rounded-2xl border border-blue-100 bg-blue-50/60">
                      <button onClick={() => applySuggestion(suggestion)} className={`w-full p-3 text-left hover:bg-blue-100 active:bg-blue-200 ${pressClass}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-black">
                          {index + 1}. {dayLabels[suggestion.dayIndex]?.full}, {suggestion.date}, {formatDecimalHour(suggestion.hour)}–{formatDecimalHour(suggestion.endHour || suggestion.hour + (suggestion.duration || 1))}
                        </div>
                        <div className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-[#0069E0]">
                          {suggestion.count}/{suggestion.total}
                        </div>
                      </div>
                      <div className="mt-1 text-xs font-semibold text-slate-500">
                        Окно: {taskDurationText(Math.round((suggestion.duration || 1) * 60))}
                      </div>
                      </button>
                      <SuggestionPeopleLists canUsers={suggestion.canUsers} cannotUsers={suggestion.cannotUsers} />
                    </div>
                  ))
                )}
              </div>
            </div>

            {showMeetingForm && (
            <form ref={meetingFormRef} onSubmit={submitMeeting} className="order-first scroll-mt-24 space-y-3 rounded-3xl border border-blue-100 bg-white p-4 shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
              <div className="flex min-w-0 items-start justify-between gap-2">
                <h2 className="min-w-0 flex-1 break-words font-black">{editingMeetingId ? `Редактировать ${meetingKindText(meetingKind).accusative}` : 'Назначить событие'}</h2>
                <button type="button" onClick={discardMeetingForm} className={`${miniButtonClass} shrink-0 whitespace-nowrap`}>
                  <X className="h-4 w-4" /> Закрыть
                </button>
              </div>
              {meetingDraftNotice && <InlineNotice>{meetingDraftNotice}</InlineNotice>}
              {meetingDraftConflict && <InlineNotice variant="warning">Сохранение приостановлено: встреча была изменена в другом окне.</InlineNotice>}
              {meetingError && <InlineNotice variant="error" focusOnMount>{meetingError}</InlineNotice>}
              <MeetingKindPicker value={meetingKind} onChange={selectMeetingKind} />
              <Field label="Название">
                <input value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} className={inputClass} />
              </Field>
              {meetingKind === 'setup' && (
                <Field label="Мероприятие">
                  <select value={meetingEventId} onChange={(event) => setMeetingEventId(event.target.value)} className={selectClass} required>
                    <option value="">Выбери мероприятие</option>
                    {allEvents.filter((item) => item.status === 'active' || item.id === meetingEventId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </Field>
              )}
              <div className="grid min-w-0 grid-cols-1 gap-3 min-[520px]:grid-cols-2 min-[820px]:grid-cols-3 [&>*]:min-w-0">
                <Field label="Дата">
                  <DatePickerField label="Дата встречи" value={meetingDate} onChange={setMeetingDate} placeholder="Выбери дату" />
                </Field>
                <Field label="Время">
                  <input type="time" value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} className={inputClass} />
                </Field>
                <Field label="Длительность">
                  <select value={meetingDuration} onChange={(event) => setMeetingDuration(event.target.value)} className={selectClass}>
                    <MeetingDurationOptions kind={meetingKind} value={meetingDuration} />
                  </select>
                </Field>
              </div>
              {meetingKind !== 'setup' && <MeetingAudiencePicker value={meetingType} onChange={setMeetingAudience} />}
              {meetingKind !== 'setup' && meetingType === 'competency' && (
                <Field label="Блок">
                  <select value={meetingCompetency} onChange={(e) => selectMeetingCompetency(e.target.value)} className={selectClass}>
                    <option value="">Выбери блок</option>
                    {competencies.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </Field>
              )}
              {meetingKind !== 'setup' && (meetingType === 'custom' || meetingType === 'competency') && (
                <div className="grid grid-cols-1 gap-2">
                  {(showAllMeetingParticipants ? coreTeamUsers : coreTeamUsers.slice(0, 3)).map((user) => (
                    <label key={user.id} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                      <span>{user.realName}</span>
                      <input type="checkbox" checked={participants.includes(user.id)} onChange={() => setParticipants((prev) => (prev.includes(user.id) ? prev.filter((id) => id !== user.id) : [...prev, user.id]))} />
                    </label>
                  ))}
                  {coreTeamUsers.length > 3 && (
                    <ListDisclosure
                      expanded={showAllMeetingParticipants}
                      onToggle={() => setShowAllMeetingParticipants((value) => !value)}
                      total={coreTeamUsers.length}
                    />
                  )}
                </div>
              )}
              {meetingKind !== 'setup' && (
                <div className="border-t border-slate-100 pt-3">
                  <button
                    type="button"
                    aria-expanded={showMeetingExtras}
                    aria-controls="meeting-extra-fields"
                    onClick={() => setShowMeetingExtras((value) => !value)}
                    className={`${secondaryButtonClass} w-full justify-between`}
                  >
                    <span>Дополнительно</span>
                    {showMeetingExtras ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
                  </button>
                  {showMeetingExtras && (
                    <div id="meeting-extra-fields" className="mt-3 space-y-3">
                      <Field label="Тема">
                        <input value={meetingTopic} onChange={(event) => setMeetingTopic(event.target.value)} className={inputClass} />
                      </Field>
                      <Field label="Описание">
                        <textarea value={meetingDescription} onChange={(event) => setMeetingDescription(event.target.value)} className={inputClass} rows={3} />
                      </Field>
                    </div>
                  )}
                </div>
              )}
              <Button pending={savingMeeting} disabled={meetingDraftConflict}>
                {savingMeeting ? 'Сохраняю...' : editingMeetingId ? meetingKind === 'setup' ? 'Сохранить монтаж' : 'Сохранить встречу' : `Запланировать ${meetingKindText(meetingKind).accusative}`}
              </Button>
            </form>
            )}

            <div className="order-first space-y-3">
              <div className="flex min-w-0 flex-col items-stretch gap-3 px-1 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
                <div className="min-w-0">
                  <h2 className="font-black">Ближайшие и текущие встречи</h2>
                </div>
                {!showMeetingForm && (
                  <button
                    type="button"
                    onClick={() => {
                      rememberEditorScroll('meeting');
                      resetMeetingForm();
                      setShowMeetingForm(true);
                    }}
                    className={`${primaryCompactButtonClass} w-full shrink-0 min-[420px]:w-auto`}
                  >
                    <Plus className="h-4 w-4" />
                    Назначить событие
                  </button>
                )}
              </div>
              {scheduledMeetings.length === 0 ? (
                <EmptyState text="Встреч пока нет" />
              ) : (
                visibleScheduledMeetings.map((meeting) => {
                  const host = state.users.find((user) => user.id === meeting.hostId);
                  const workEvent = allEvents.find((item) => item.id === meeting.eventId);
                  const attendingUsers = (meeting.attendeeIds || [])
                    .map((userId) => state.users.find((user) => user.id === userId))
                    .filter(Boolean) as User[];
                  const rsvps = normalizedMeetingRsvps(meeting);
                  const declinedUsers = Object.entries(rsvps).filter(([, response]) => response === 'no')
                    .map(([userId]) => state.users.find((user) => user.id === userId)).filter(Boolean) as User[];
                  const invitedIds = meeting.audiencePolicy === 'snapshot'
                    ? meeting.audienceUserIds || []
                    : meeting.participants === 'all'
                      ? coreTeamUsers.map((user) => user.id)
                      : [...new Set([...meeting.participants, meeting.hostId])];
                  const unansweredCount = invitedIds.filter((userId) => !rsvps[userId]).length;
                  const canManage = meeting.hostId === currentUser.id;
                  const expanded = expandedMeetingId === meeting.id;
                  const attendeesExpanded = expandedMeetingAttendeeIds.includes(meeting.id);
                  const invited = invitedIds.includes(currentUser.id);
                  const currentResponse = meetingRsvpFor(meeting, currentUser.id);
                  const phase = meetingPhase(meeting, projectNow);
                  const durationLabel = taskDurationText(Math.round(Number(meeting.duration || 1) * 60));
                  const audienceLabel = meeting.kind === 'setup' || meeting.type === 'general'
                    ? 'Вся команда'
                    : meeting.competency
                      ? `Блок: ${meeting.competency}`
                      : `${meeting.participants.length} участников`;
                  const detailsId = `meeting-details-${meeting.id}`;
                  return (
                    <div
                      key={meeting.id}
                      className="overflow-hidden rounded-3xl border border-blue-100 bg-white p-4"
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-start gap-2">
                          <h3 className="min-w-0 flex-1 break-words font-black [overflow-wrap:anywhere]">{meeting.title}</h3>
                          {phase === 'ongoing' && <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-black uppercase tracking-wide text-emerald-700">Идёт сейчас</span>}
                        </div>
                        <time
                          dateTime={`${formatDateShort(meeting.date).split('.').reverse().map((part, index) => index === 0 && part.length === 2 ? `20${part}` : part).join('-')}T${meeting.time}`}
                          className="mt-1 block break-words text-sm font-bold tabular-nums text-slate-600"
                        >
                          {weekdayShortByDate(meeting.date)}, {formatDateShort(meeting.date)} · {meeting.time} · {durationLabel}
                        </time>
                        <div className={`mega-meeting-badges mt-2 gap-2 text-xs font-black ${meeting.kind === 'setup' ? 'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start' : 'flex flex-wrap'}`}>
                          <span className="rounded-full bg-blue-100 px-2.5 py-1 text-[#005BC4]">{meetingKindText(meeting.kind).label}</span>
                          {meeting.kind === 'setup' && <span className="min-w-0 max-w-full justify-self-center break-words rounded-full bg-slate-100 px-2.5 py-1 text-center text-slate-700">{workEvent?.name || 'Мероприятие не найдено'}</span>}
                          <span className={`${meeting.kind === 'setup' ? 'justify-self-end' : 'ml-auto'} max-w-full break-words rounded-full bg-slate-100 px-2.5 py-1 text-right text-slate-700`}>{audienceLabel}</span>
                        </div>
                      </div>

                      <div className="mt-3 border-t border-slate-100 pt-3">
                        <div className="grid grid-cols-2 gap-2">
                          <button type="button" disabled={rsvpMeetingId === meeting.id} onClick={() => void setMeetingAttendance(meeting, 'yes')} aria-pressed={currentResponse === 'yes'} className={`${miniButtonClass} min-w-0 disabled:opacity-60 ${currentResponse === 'yes' ? 'mega-rsvp-yes border-emerald-200 bg-emerald-100' : ''}`}>Приду</button>
                          <button type="button" disabled={rsvpMeetingId === meeting.id} onClick={() => void setMeetingAttendance(meeting, 'no')} aria-pressed={currentResponse === 'no'} className={`${miniButtonClass} min-w-0 disabled:opacity-60 ${currentResponse === 'no' ? 'mega-rsvp-no border-rose-200 bg-rose-100' : ''}`}>Не приду</button>
                        </div>
                      </div>

                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={detailsId}
                        onClick={() => setExpandedMeetingId(expanded ? null : meeting.id)}
                        className={`${secondaryButtonClass} mt-3 w-full justify-between`}
                      >
                        <span>{expanded ? 'Скрыть подробности' : 'Подробнее'}</span>
                        {expanded ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
                      </button>

                      {expanded && (
                        <div id={detailsId} className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm text-slate-600">
                          <InfoRow label="Автор" value={host?.realName || 'Организатор'} />
                          {host?.username && <InfoRow label="Telegram" value={host.username} href={telegramLink(host.username)} />}
                          <InfoRow label="Дата" value={`${weekdayShortByDate(meeting.date)} ${formatDateShort(meeting.date)}`} />
                          <InfoRow label="Время" value={meeting.time} />
                          <InfoRow label="Длительность" value={taskDurationText(Math.round(Number(meeting.duration || 1) * 60))} />
                          <InfoRow label="Формат" value={`${meetingKindText(meeting.kind).label} — ${meeting.kind === 'setup' || meeting.type === 'general' ? 'вся команда' : meeting.competency ? `по блоку «${meeting.competency}»` : 'по выбранным людям'}`} />
                          {meeting.kind === 'setup' && <InfoRow label="Мероприятие" value={workEvent?.name || 'Не указано'} />}
                          {meeting.kind !== 'setup' && meeting.competency && <InfoRow label="Блок" value={meeting.competency} />}
                          {meeting.kind !== 'setup' && <InfoRow label="Тема" value={meeting.topic || 'Без темы'} />}
                          {meeting.kind !== 'setup' && meeting.description && <InfoRow label="Описание" value={meeting.description} />}
                          <MeetingAttendanceList
                            meetingId={meeting.id}
                            users={attendingUsers}
                            expanded={attendeesExpanded}
                            onToggle={() => setExpandedMeetingAttendeeIds((current) => current.includes(meeting.id)
                              ? current.filter((id) => id !== meeting.id)
                              : [...current, meeting.id])}
                          />
                          <div className="grid grid-cols-2 gap-2 text-xs font-bold">
                            <div className="rounded-xl bg-rose-50 px-3 py-2 text-rose-700">Не придут · {declinedUsers.length}</div>
                            <div className="rounded-xl bg-slate-100 px-3 py-2 text-slate-600">Не ответили · {unansweredCount}</div>
                          </div>
                          {declinedUsers.length > 0 && <p className="break-words text-xs text-slate-500">Не придут: {declinedUsers.map((user) => user.realName).join(', ')}</p>}
                          {!invited && currentResponse !== 'yes' && <p className="rounded-2xl bg-blue-50 px-3 py-2 text-xs font-bold text-[#005BC4]">Тебя не добавили в исходный состав, но к этому собранию можно присоединиться.</p>}
                          {canManage && (
                            <div className="flex flex-wrap gap-2 pt-2">
                              <button type="button" onClick={() => startMeetingEdit(meeting)} className={miniButtonClass}>
                                <PencilSimple className="h-4 w-4" />
                                Редактировать
                              </button>
                              <button type="button" onClick={() => deleteMeeting(meeting.id)} className={`${miniButtonClass} border-rose-100 bg-rose-50 text-rose-600 hover:bg-rose-100 active:bg-rose-200`}>
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
              {scheduledMeetings.length > 3 && (
                <ListDisclosure
                  expanded={showAllMeetings}
                  onToggle={() => setShowAllMeetings((value) => !value)}
                  total={scheduledMeetings.length}
                  className="mt-2"
                />
              )}
              {meetingHistory.length > 0 && (
                <div className="pt-2">
                  <button type="button" onClick={() => setShowMeetingHistory((value) => !value)} aria-expanded={showMeetingHistory} className={`${secondaryButtonClass} w-full justify-between`}>
                    <span>История встреч · {meetingHistory.length}</span>
                    {showMeetingHistory ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
                  </button>
                  {showMeetingHistory && <div className="mt-3 space-y-2">{meetingHistory.map((meeting) => (
                    <div key={meeting.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0"><p className="break-words font-black">{meeting.title}</p><p className="mt-1 text-xs font-semibold text-slate-500">{formatDateShort(meeting.date)} · {meeting.time}</p></div>
                        <span className="shrink-0 rounded-full bg-white px-2 py-1 text-xs font-black text-slate-600">{meeting.status === 'cancelled' ? 'Отменена' : 'Завершилась'}</span>
                      </div>
                    </div>
                  ))}</div>}
                </div>
              )}
            </div>
          </section>
        )}

        {activeTab === 'tasks' && (
          <section className="space-y-4">
            <EventScopePicker
              events={allEvents}
              value={selectedTaskEventId}
              onChange={(eventId) => {
                if (taskDraftDirty && !window.confirm('Сменить фильтр и удалить несохранённый черновик задачи?')) return;
                setSelectedTaskEventId(eventId);
                resetTaskForm();
                setShowTaskForm(false);
                setTaskError('');
              }}
            />
            <div className="rounded-3xl border border-blue-100 bg-white p-3">
              <div className="mb-2 px-1 text-xs font-black uppercase tracking-wide text-slate-500">Какие задачи показать</div>
              <Segmented
                value={taskListView}
                onChange={(value) => setTaskListView(value as typeof taskListView)}
                label="Фильтр задач по участию"
                options={[
                  ['mine', 'Мои'],
                  ['open', 'Свободные'],
                  ['assigned', 'Назначенные мной'],
                  ['completed', 'Завершённые'],
                ]}
              />
            </div>
            {taskError && <InlineNotice variant="error" focusOnMount>{taskError}</InlineNotice>}
            {taskNotice && <InlineNotice variant="success">{taskNotice}</InlineNotice>}
            {taskDraftNotice && <InlineNotice>{taskDraftNotice}</InlineNotice>}
            {taskDraftConflict && <InlineNotice variant="warning">Сохранение приостановлено: задача была изменена в другом окне.</InlineNotice>}
            <button onClick={openTaskForm} className={primaryButtonClass}>
              {showTaskForm ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {showTaskForm ? 'Скрыть форму' : 'Создать задачу'}
            </button>
            {showTaskForm && (
              <form onSubmit={submitTask} className="space-y-3 rounded-3xl border border-blue-100 bg-white p-4 shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-black">{editingTaskId ? 'Редактировать задачу' : 'Новая задача'}</h2>
                  <button type="button" onClick={discardTaskForm} className={miniButtonClass}><X className="h-4 w-4" /> Закрыть</button>
                </div>
                <Field label="Мероприятие">
                  <select value={taskEventId} onChange={(event) => setTaskEventId(event.target.value)} className={selectClass}>
                    <option value="">Без мероприятия</option>
                    {activeEvents.map((workEvent) => <option key={workEvent.id} value={workEvent.id}>{workEvent.name}</option>)}
                    {editingTaskId && taskEventId && !activeEvents.some((item) => item.id === taskEventId) && (
                      <option value={taskEventId}>{allEvents.find((item) => item.id === taskEventId)?.name || 'Архивное мероприятие'} · архив</option>
                    )}
                  </select>
                  <p className="mt-1 text-xs font-semibold text-slate-500">Можно оставить задачу вне мероприятия. Архивная привязка сохраняется при редактировании.</p>
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
                                  {name}
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
                        {visibleTaskAssignees.map((user) => (
                          <label key={user.id} className="flex min-h-11 items-center justify-between rounded-xl bg-white px-3 py-2 text-sm font-semibold">
                            <span className="min-w-0 truncate">{user.realName}{user.id === currentUser.id ? ' · это вы' : ''}</span>
                            <input type="checkbox" checked={taskAssignedTo.includes(user.id)} onChange={() => setTaskAssignedTo((prev) => prev.includes(user.id) ? prev.filter((id) => id !== user.id) : [...prev, user.id])} />
                          </label>
                        ))}
                        {!normalizedTaskAssigneeSearch && coreTeamUsers.length > 3 && <ListDisclosure expanded={showAllTaskAssignees} onToggle={() => setShowAllTaskAssignees((value) => !value)} total={coreTeamUsers.length} />}
                        {normalizedTaskAssigneeSearch && visibleTaskAssignees.length === 0 && <p className="px-2 py-3 text-center text-sm font-bold text-slate-500">Никого не нашли</p>}
                      </div>
                    )}
                  </div>
                </Field>
                <div className="grid min-w-0 grid-cols-1 gap-3 overflow-hidden sm:grid-cols-2">
                  <Field label="Дедлайн · до конца дня, МСК">
                    <DatePickerField label="Дедлайн задачи, до конца дня по московскому времени" value={taskDeadline} onChange={setTaskDeadline} placeholder="Дата не выбрана" />
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
                <Button pending={savingTask} disabled={taskDraftConflict}>
                  {savingTask ? 'Сохраняю...' : editingTaskId ? 'Сохранить изменения' : 'Сохранить задачу'}
                </Button>
              </form>
            )}
            {taskListView === 'mine' && <TaskList title="Мои задачи" tasks={myTasks} users={state.users} events={allEvents} currentUser={currentUser} actionLabel="Готово" onAction={openCompletionPrompt} onRelease={onReleaseTask} onEdit={startTaskEdit} onDelete={deleteTask} onNotify={notifyTaskAssignees} onSaveComment={saveTaskComment} />}
            {taskListView === 'open' && <TaskList title="Свободные задачи" tasks={openTasks} users={state.users} events={allEvents} currentUser={currentUser} actionLabel="Взять" onAction={claimTask} onEdit={startTaskEdit} onDelete={deleteTask} onNotify={notifyTaskAssignees} onSaveComment={saveTaskComment} />}
            {taskListView === 'assigned' && <TaskList title="Назначенные мной" tasks={assignedByMeTasks} users={state.users} events={allEvents} currentUser={currentUser} onEdit={startTaskEdit} onDelete={deleteTask} onNotify={notifyTaskAssignees} onSaveComment={saveTaskComment} />}
            {taskListView === 'completed' && <TaskList title="Последние завершённые" tasks={latestCompletedTasks} users={state.users} events={allEvents} currentUser={currentUser} onEdit={startTaskEdit} onEditCompletion={openCompletionPrompt} onSaveComment={saveTaskComment} />}

            <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-black">Журнал задач</h2>
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
            {isAdmin && <div className="grid grid-cols-2 items-start gap-2" aria-label="Состояние приложения">
            {isAdmin && (
              <div className="contents">
                <button type="button" onClick={toggleDiagnostics} className={`${secondaryButtonClass} min-h-12 w-full justify-between px-3 text-xs`} aria-label="Состояние сервиса" aria-expanded={diagnosticsOpen} aria-controls="service-diagnostics">
                  <span className="flex min-w-0 items-center gap-2 text-left">
                    <Shield className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 break-words">Сервис</span>
                  </span>
                  {diagnosticsOpen ? <CaretUp className="h-4 w-4 shrink-0" /> : <CaretDown className="h-4 w-4 shrink-0" />}
                </button>
                {state.settings?.notificationDeliverySummary && (
                <button type="button" onClick={toggleDeliveryJournal} className={`${secondaryButtonClass} min-h-12 w-full justify-between px-3 text-xs`} aria-label="Доставка сообщений" aria-expanded={deliveryJournalOpen} aria-controls="delivery-journal">
                  <span className="flex min-w-0 items-center gap-2 text-left">
                    <Bell className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 break-words">Доставки · {state.settings.notificationDeliverySummary.pending}/{state.settings.notificationDeliverySummary.attention}</span>
                  </span>
                  {deliveryJournalOpen ? <CaretUp className="h-4 w-4 shrink-0" /> : <CaretDown className="h-4 w-4 shrink-0" />}
                </button>
                )}
                {diagnosticsOpen && (
                  <div id="service-diagnostics" className="order-last col-span-2 rounded-3xl border border-blue-100 bg-white px-4 py-4">
                    {diagnosticsError && <InlineNotice variant="error">{diagnosticsError}</InlineNotice>}
                    {diagnosticsBusy && !diagnostics && <p className="text-sm font-bold text-slate-500" role="status">Проверяю хранилище и очереди…</p>}
                    {diagnostics && (
                      <div className="space-y-3">
                        <InlineNotice variant={diagnostics.status === 'healthy' ? 'success' : 'error'}>
                          {diagnostics.status === 'healthy'
                            ? 'Команды сохраняются, очереди не требуют вмешательства.'
                            : diagnostics.status === 'degraded'
                              ? 'Основные функции доступны, но часть очередей или интеграций требует внимания.'
                              : 'Сервис не готов надёжно принимать изменения.'}
                        </InlineNotice>
                        {diagnostics.warnings.length > 0 && (
                          <ul className="space-y-1 text-sm font-semibold text-amber-900">
                            {diagnostics.warnings.map((warning) => <li key={warning} className="break-words">• {warning}</li>)}
                          </ul>
                        )}
                        <dl className="divide-y divide-slate-200 border-y border-slate-200 text-sm">
                          <div className="flex min-w-0 items-start justify-between gap-4 py-3">
                            <dt className="font-black text-slate-900">Хранилище</dt>
                            <dd className="min-w-0 text-right font-semibold text-slate-600">
                              <span className="block">ревизия {diagnostics.persistence.durableRevision}</span>
                              <span className="block break-words">реплика {diagnostics.persistence.replicatedRevision}{diagnostics.persistence.pendingReplication ? ' · ожидает' : ''}</span>
                            </dd>
                          </div>
                          <div className="flex min-w-0 items-start justify-between gap-4 py-3">
                            <dt className="font-black text-slate-900">Доставка</dt>
                            <dd className="min-w-0 text-right font-semibold text-slate-600">ожидают {diagnostics.queues.notificationDelivery.pending} · решить {diagnostics.queues.notificationDelivery.attention}</dd>
                          </div>
                          <div className="flex min-w-0 items-start justify-between gap-4 py-3">
                            <dt className="font-black text-slate-900">Входящие Telegram</dt>
                            <dd className="min-w-0 text-right font-semibold text-slate-600">ожидают {diagnostics.queues.telegramInbox.pending} · ошибок {diagnostics.queues.telegramInbox.failed}</dd>
                          </div>
                          <div className="flex min-w-0 items-start justify-between gap-4 py-3">
                            <dt className="font-black text-slate-900">Повторы интеграций</dt>
                            <dd className="min-w-0 text-right font-semibold text-slate-600">Calendar {diagnostics.queues.calendar.pending} · слоты {diagnostics.queues.availabilitySheets.pending}</dd>
                          </div>
                        </dl>
                        <details className="text-xs font-semibold text-slate-600">
                          <summary className="min-h-11 cursor-pointer py-3 font-black text-slate-800">Технические подробности</summary>
                          <div className="space-y-1 break-words pb-2">
                            <p>Версия: {diagnostics.service.revision} · uptime {Math.floor(diagnostics.service.uptimeSeconds / 60)} мин · {diagnostics.service.timeZone}</p>
                            <p>Последняя запись: {formatDiagnosticTime(diagnostics.persistence.lastSuccessAt)}</p>
                            <p>Последняя репликация: {formatDiagnosticTime(diagnostics.persistence.lastReplicationSuccessAt)}</p>
                            {diagnostics.persistence.lastError && <p className="text-rose-700">Хранилище: {diagnostics.persistence.lastError}</p>}
                            {diagnostics.persistence.lastReplicationError && <p className="text-rose-700">Репликация: {diagnostics.persistence.lastReplicationError}</p>}
                            <p>Снимок: {formatDiagnosticTime(diagnostics.generatedAt)}{diagnostics.requestId ? ` · request ${diagnostics.requestId}` : ''}</p>
                          </div>
                        </details>
                        <button type="button" onClick={loadDiagnostics} disabled={diagnosticsBusy} className={`${secondaryButtonClass} w-full disabled:opacity-60`}>
                          <ArrowClockwise className={`h-4 w-4 ${diagnosticsBusy ? 'animate-spin' : ''}`} /> {diagnosticsBusy ? 'Обновляю…' : 'Обновить состояние'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {isAdmin && state.settings?.notificationDeliverySummary && (
              <div className="contents">
                {deliveryJournalOpen && (
                  <div id="delivery-journal" className="order-last col-span-2 space-y-2 rounded-3xl border border-blue-100 bg-white p-4">
                    <p className="text-sm font-bold">Ожидают {state.settings.notificationDeliverySummary.pending} · требуют решения {state.settings.notificationDeliverySummary.attention}</p>
                    {state.settings.notificationDeliverySummary.overloaded && <InlineNotice variant="error">Очередь перегружена: новые уведомления сохраняются, но доставка отстаёт. Проверь ошибки и состояние Telegram.</InlineNotice>}
                    {deliveryJournalError && <InlineNotice variant="error">{deliveryJournalError}</InlineNotice>}
                    {deliveryJournalBusy && !deliveryIssues.length && <p className="text-sm font-bold text-slate-500">Загружаю журнал…</p>}
                    {!deliveryJournalBusy && !deliveryIssues.length && <InlineNotice variant="success">Ошибок и неоднозначных доставок нет.</InlineNotice>}
                    {deliveryIssues.map((delivery) => (
                      <label key={delivery.id} className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={selectedDeliveryIds.includes(delivery.id)}
                          onChange={() => setSelectedDeliveryIds((current) => current.includes(delivery.id)
                            ? current.filter((id) => id !== delivery.id) : [...current, delivery.id])}
                        />
                        <span className="min-w-0 flex-1">
                          <strong className="block break-words">{delivery.recipientName || 'Командный чат'} · {delivery.status === 'unknown' ? 'результат неизвестен' : 'не доставлено'}</strong>
                          <span className="mt-1 block break-words text-xs font-semibold text-slate-600">{delivery.textPreview}</span>
                          <span className="mt-1 block break-words text-xs font-bold text-rose-700">{delivery.lastErrorCode || 'error'}{delivery.lastErrorMessage ? ` · ${delivery.lastErrorMessage}` : ''}</span>
                        </span>
                      </label>
                    ))}
                    {deliveryIssues.length > 0 && (
                      <button type="button" disabled={!selectedDeliveryIds.length || deliveryJournalBusy} onClick={retrySelectedDeliveries} className={`${primaryButtonClass} w-full disabled:opacity-60`}>
                        <ArrowClockwise className="h-4 w-4" /> Повторить выбранные ({selectedDeliveryIds.length})
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            </div>}
            <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                <button type="button" onClick={() => setBroadcastOpen((value) => !value)} className={`${secondaryButtonClass} w-full justify-between`} aria-expanded={broadcastOpen} aria-controls="broadcast-form">
                  <span className="flex items-center gap-2"><PaperPlaneTilt className="h-4 w-4" /> Создать рассылку</span>
                  {broadcastOpen ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
                </button>
                {broadcastOpen && (
                  <form id="broadcast-form" onSubmit={submitBroadcast} className="mt-4 space-y-3">
                    <fieldset disabled={broadcastSaving} className="min-w-0 space-y-3">
                    {broadcastDraftNotice && <InlineNotice>{broadcastDraftNotice}</InlineNotice>}
                    <Field label="Получатели">
                      <div className="grid grid-cols-2 gap-1.5 rounded-2xl bg-slate-100 p-1.5">
                        {([['all', 'Все'], ['blocks', 'По блоку'], ['people', 'Конкретные люди'], ['missing_slots', 'Не отметили слоты']] as const).map(([mode, label]) => (
                          <button key={mode} type="button" aria-pressed={broadcastMode === mode} onClick={() => setBroadcastRecipientMode(mode)} className={`min-h-11 min-w-0 rounded-xl px-1.5 py-2 text-xs font-black leading-tight ${pressClass} ${broadcastMode === mode ? 'bg-[#0069E0] text-white shadow-sm' : 'bg-white text-slate-700'}`}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </Field>

                    {durableBroadcasts && <Button type="button" variant={broadcastMode === 'groups' ? 'primary' : 'secondary'} aria-pressed={broadcastMode === 'groups'} onClick={() => setBroadcastRecipientMode('groups')}>Группы и топики</Button>}
                    {broadcastMode === 'groups' && durableBroadcasts && <BroadcastGroupPicker userId={currentUser.id} selected={broadcastGroupIds} onChange={setBroadcastGroupIds} onOptions={setBroadcastGroupOptions} onLoading={setBroadcastGroupsLoading} />}
                    {broadcastMode === 'missing_slots' && (
                      <div className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50 p-2">
                        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Неделя для проверки слотов">
                          {Array.from({ length: configuredWeekCount }, (_, weekIndex) => {
                            const selected = broadcastWeekIndex === weekIndex;
                            const fillsOddLastRow = configuredWeekCount % 2 === 1 && weekIndex === configuredWeekCount - 1;
                            return (
                              <button
                                key={weekIndex}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                onClick={() => setBroadcastWeekIndex(weekIndex)}
                                className={`min-h-11 min-w-0 rounded-xl border px-2 py-2 text-xs font-black leading-tight ${fillsOddLastRow ? 'col-span-2' : ''} ${pressClass} ${selected ? 'border-[#0069E0] bg-[#0069E0] text-white' : 'border-amber-200 bg-white text-slate-700'}`}
                              >
                                <span className="block">{weekIndex === 0 ? 'Эта неделя' : weekIndex === 1 ? 'Следующая неделя' : `Неделя ${weekIndex + 1}`}</span>
                                <span className={`mt-0.5 block font-bold ${selected ? 'text-blue-100' : 'text-slate-500'}`}>
                                  {formatDayMonth(dateForSlotDay(weekIndex * 7 + activeDays[0]))}–{formatDayMonth(dateForSlotDay(weekIndex * 7 + activeDays[activeDays.length - 1]))}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <p className={`rounded-xl bg-white px-3 py-2 text-sm font-black ${missingSlotBroadcastUsers.length ? 'text-amber-800' : 'text-emerald-700'}`}>
                          {missingSlotBroadcastUsers.length
                            ? `Получателей сейчас: ${missingSlotBroadcastUsers.length}`
                            : 'Все участники уже отметили эту неделю.'}
                        </p>
                      </div>
                    )}

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
                              return <button key={name} type="button" aria-pressed={selected} onClick={() => toggleBroadcastBlock(name)} className={`min-h-11 rounded-xl border px-3 py-2 text-left text-sm font-black ${pressClass} ${selected ? 'border-[#0069E0] bg-[#0069E0] text-white' : 'border-slate-200 bg-white text-slate-700'}`}>{name}</button>;
                            })}
                            {!competencies.length && <p className="px-2 py-3 text-sm font-bold text-slate-500">Сначала добавь блоки команды.</p>}
                          </div>
                        )}
                      </div>
                    )}

                    {(broadcastMode === 'blocks' || broadcastMode === 'people') && (
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
                            <button type="button" onClick={() => setBroadcastRecipients(broadcastRecipients.length === broadcastEligibleUsers.length ? [] : broadcastEligibleUsers.map((user) => user.id))} className={`${secondaryButtonClass} w-full`}>
                              <UsersThree className="h-4 w-4" /> {broadcastRecipients.length === broadcastEligibleUsers.length ? 'Снять всех' : 'Выбрать всех'}
                            </button>
                            {matchedBroadcastUsers.map((user) => (
                              <label key={user.id} className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 text-sm font-semibold">
                                <span className="min-w-0">
                                  <strong className="block truncate">{user.realName}{user.id === currentUser.id ? ' · это вы' : ''}</strong>
                                  {(!user.registered || (durableBroadcasts && user.telegramConnected !== true)) && <span className="block truncate text-xs font-bold text-amber-700">Нужно открыть бота через /start</span>}
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
                    <Field label="Текст рассылки" hint={durableBroadcasts ? 'До 40000 символов вместе с заголовком. Длинный текст отправляется последовательными частями.' : undefined}><textarea required value={broadcastBody} onChange={(event) => setBroadcastBody(event.target.value)} className={inputClass} rows={4} maxLength={durableBroadcasts ? 40000 : 4000} placeholder="Что нужно сообщить команде" /></Field>

                    {durableBroadcasts && <fieldset disabled={broadcastSaving} className="space-y-3">
                      <legend className="mb-2 text-xs font-black uppercase text-slate-500">Время отправки · МСК</legend>
                      <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2" role="radiogroup" aria-label="Время отправки">
                        {(['now', 'scheduled'] as const).map(mode => <label key={mode} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--mega-radius-control)] bg-slate-100 px-3 py-2 text-sm font-bold">
                          <input type="radio" name="broadcast-dispatch" value={mode} checked={broadcastDispatchMode === mode} onChange={() => setBroadcastDispatchMode(mode)} />
                          {mode === 'now' ? 'Сейчас' : 'Запланировать'}
                        </label>)}
                      </div>
                      {broadcastDispatchMode === 'scheduled' && <>
                        <div className="grid grid-cols-1 gap-3 min-[440px]:grid-cols-2">
                          <Field label="Дата · МСК"><input type="date" required value={broadcastDate} onChange={event => setBroadcastDate(event.target.value)} className={inputClass} /></Field>
                          <Field label="Время · МСК"><input type="time" required value={broadcastTime} onChange={event => setBroadcastTime(event.target.value)} className={inputClass} /></Field>
                        </div>
                        <Field label="Если время пропущено" hint="От 30 секунд в будущем до 365 дней. Точность расписания не означает одновременную доставку всей пачке.">
                          <div role="radiogroup" aria-label="Если время пропущено" className="space-y-2">
                            {([['send_late', 'Отправлять в течение 15 минут'], ['skip', 'Пропустить после 5 секунд задержки']] as const).map(([policy, label]) => <label key={policy} className="flex min-h-11 items-center gap-2 rounded-[var(--mega-radius-control)] bg-slate-100 px-3 py-2 text-sm font-bold">
                              <input type="radio" name="broadcast-misfire" checked={broadcastMisfirePolicy === policy} onChange={() => setBroadcastMisfirePolicy(policy)} />
                              <span className="min-w-0">{label}</span>
                            </label>)}
                          </div>
                        </Field>
                      </>}
                    </fieldset>}

                    <section aria-labelledby="broadcast-summary-title" className="rounded-2xl border border-blue-100 bg-blue-50 p-3">
                      <h3 id="broadcast-summary-title" className="font-black text-[#005BC4]">{broadcastDispatchMode === 'scheduled' ? (broadcastScheduledAt(broadcastDate, broadcastTime) ? broadcastTimeLabel(broadcastScheduledAt(broadcastDate, broadcastTime)!) : 'Выбери дату и время МСК') : 'Отправка сейчас'}</h3>
                      <p className="mt-1 text-sm font-bold text-slate-700">
                        {broadcastMode === 'groups' ? `Выбрано разрешений: ${broadcastGroupIds.length}. Доступность бота проверяется при отправке.` : `${broadcastAudienceUsers.length} получателей · Telegram доступен у ${broadcastAvailableUsers.length}`}
                      </p>
                      {broadcastMode === 'groups' && <ul className="mt-2 space-y-1 text-sm font-bold">{broadcastGroupIds.map(id => <li key={id} className="break-words">{broadcastGroupOptions.find(item => item.id === id)?.label || 'Адресат ещё не загружен или больше не разрешён'}</li>)}</ul>}
                      <p className="mt-1 text-xs font-semibold text-slate-600">
                        Сообщения отправляются по одному. Подтверждение Telegram не означает, что человек прочитал сообщение.
                      </p>
                      {broadcastUnavailableUsers.length > 0 && (
                        <div className="mt-3 rounded-xl bg-white p-3 text-sm text-amber-900">
                          <div className="font-black">Не получат сообщение без /start:</div>
                          <ul className="mt-1 list-disc space-y-1 pl-5 font-semibold">
                            {broadcastUnavailableUsers.map((user) => <li key={user.id} className="break-words">{user.realName}</li>)}
                          </ul>
                        </div>
                      )}
                    </section>

                    {broadcastError && <InlineNotice variant="error" focusOnMount>{broadcastError}</InlineNotice>}
                    <Button type="submit" pending={broadcastSaving} disabled={broadcastMode === 'groups' ? !broadcastGroupsReady : !broadcastAvailableUsers.length || (broadcastMode === 'missing_slots' && !missingSlotBroadcastUsers.length)}>
                      <PaperPlaneTilt className="h-4 w-4" /> {broadcastSaving ? (durableBroadcasts ? 'Сохраняю...' : 'Отправляю...') : broadcastError ? 'Повторить отправку' : broadcastDispatchMode === 'scheduled' ? 'Запланировать' : 'Отправить сейчас'}
                    </Button>
                    {broadcastNotice && <InlineNotice variant="success">{broadcastNotice}</InlineNotice>}
                    </fieldset>
                  </form>
                )}
                {durableBroadcasts && <BroadcastHistory userId={currentUser.id} users={state.users} revision={broadcastHistoryRevision} />}
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
                <div className="grid grid-cols-1 gap-3 min-[440px]:grid-cols-2">
                  <Field label="Роль">
                    <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as any)} className={selectClass}>
                      <option value="organizer">Организатор</option>
                      <option value="admin">Админ</option>
                    </select>
                  </Field>
                  <Field label="ДР">
                    <DatePickerField label="Дата рождения" value={newUserBirthday} onChange={setNewUserBirthday} placeholder="Выбери дату" fullYear />
                  </Field>
                </div>
                <button className={primaryButtonClass}>Добавить</button>
              </form>
            )}

            {isAdminPanel && (
              <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                <h2 className="font-black">Блоки и компетенции</h2>
                <div className="mt-3 flex flex-col gap-2 min-[400px]:flex-row">
                  <input value={newCompetency} onChange={(e) => setNewCompetency(e.target.value)} className={inputClass} placeholder="Например, Дизайн" />
                  <button type="button" onClick={addCompetency} className={`${miniButtonClass} w-full shrink-0 whitespace-nowrap min-[400px]:w-auto`}>
                    <Plus className="h-4 w-4" />
                    Добавить
                  </button>
                </div>
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
                {competencies.length > 3 && (
                  <ListDisclosure
                    expanded={showAllCompetencies}
                    onToggle={() => setShowAllCompetencies((value) => !value)}
                    total={competencies.length}
                    className="mt-3"
                  />
                )}
              </div>
            )}

            <div className="space-y-3">
              <div className="flex flex-col items-stretch gap-2 px-1 min-[520px]:flex-row min-[520px]:items-end min-[520px]:justify-between">
                <Field label="Поиск по команде" className="min-w-0 flex-1">
                  <div className="relative">
                    <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                    <input
                      type="search"
                      value={teamSearch}
                      onChange={(event) => setTeamSearch(event.target.value)}
                      className={`${inputClass} pl-10 pr-10`}
                      placeholder="Имя, фамилия или @username"
                    />
                    {teamSearch && (
                      <button type="button" onClick={() => setTeamSearch('')} className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100" aria-label="Очистить поиск">
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </Field>
              </div>
              {state.users.length === 0 ? (
                <EmptyState text="Пока в команде никого нет" />
              ) : visibleTeamUsers.length === 0 ? (
                <EmptyState text="Никого не найдено" />
              ) : (
                visibleTeamUsers.map((user) => {
                  const expanded = expandedUserId === user.id;
                  const editing = editingUserId === user.id;
                  const detailsId = `team-user-${user.id}-details`;
                  return (
                    <div key={user.id} className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                      <div className="flex flex-col items-stretch gap-3 min-[440px]:flex-row min-[440px]:items-center min-[440px]:justify-between">
                        <div className="flex min-w-0 items-center gap-3">
                          <UserAvatar user={user} className="h-11 w-11 shrink-0 rounded-xl" />
                          <div className="min-w-0">
                          <div className="font-black">{user.realName}</div>
                          <a href={telegramLink(user.username)} className="text-sm font-bold text-[#0069E0]" onClick={(event) => openTelegramProfile(event, telegramLink(user.username))}>
                            {user.username}
                          </a>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2 min-[440px]:max-w-[48%] min-[440px]:justify-end">
                          <div className="max-w-full break-words rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-[#0069E0]">{user.primaryCompetency || 'Блок не выбран'}</div>
                          {!user.registered && <div className="max-w-full break-words rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-[#4D647A]">Не подключён</div>}
                        </div>
                      </div>

                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={detailsId}
                        onClick={() => setExpandedUserId(expanded ? null : user.id)}
                        className={`${secondaryButtonClass} mt-3 w-full justify-between`}
                      >
                        <span>{expanded ? 'Скрыть подробности' : 'Подробнее'}</span>
                        {expanded ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
                      </button>

                      {expanded && (
                        <div id={detailsId} className="mt-4 border-t border-slate-100 pt-4">
                          {!editing ? (
                            <div className="space-y-2 text-sm text-slate-600">
                              <InfoRow label="Имя" value={user.realName} />
                              <InfoRow label="Telegram" value={user.username} href={telegramLink(user.username)} />
                              {(isAdminPanel || user.id === currentUser.id) && <InfoRow label="Дата рождения" value={formatDateShort(user.birthday) || 'не указана'} />}
                              <InfoRow label="Связь с Telegram" value={user.registered ? 'подключена' : 'не подключена'} />
                              {!user.registered && <InlineNotice>Чтобы подключиться, человеку нужно открыть бота и отправить команду /start.</InlineNotice>}
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
                                      Деактивировать
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
                              <div className={`grid min-w-0 grid-cols-1 gap-3 ${isAdminPanel ? 'min-[440px]:grid-cols-2' : ''}`}>
                                <Field label="ДР">
                                  <DatePickerField label="Дата рождения" value={userDraft.birthday} onChange={(value) => setUserDraft((prev) => ({ ...prev, birthday: value }))} placeholder="Выбери дату" fullYear />
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
                              <ProfileBlockSelectors
                                competencies={competencies}
                                selected={userDraft.competencies}
                                primary={userDraft.primaryCompetency}
                                primaryOpen={profilePrimaryBlockOpen}
                                secondaryOpen={profileSecondaryBlocksOpen}
                                onTogglePrimary={() => setProfilePrimaryBlockOpen((open) => !open)}
                                onToggleSecondary={() => setProfileSecondaryBlocksOpen((open) => !open)}
                                onPrimaryChange={(name) => setUserDraft((prev) => ({
                                  ...prev,
                                  primaryCompetency: name,
                                  competencies: prev.competencies.includes(name) ? prev.competencies : [name, ...prev.competencies],
                                }))}
                                onSecondaryToggle={toggleDraftCompetency}
                              />
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
              {!normalizedTeamSearch && filteredTeamUsers.length > 3 && (
                <ListDisclosure
                  expanded={showAllTeamUsers}
                  onToggle={() => setShowAllTeamUsers((value) => !value)}
                  total={filteredTeamUsers.length}
                />
              )}
            </div>
          </section>
        )}

        {(activeTab === 'faculties' || (isAdminPanel && adminSection === 'faculties')) && (
          <section className="space-y-4">
            {activeTab === 'faculties' && (
              <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                <h2 className="text-lg font-black">Факультеты</h2>
                <p className="mt-1 text-sm font-semibold text-slate-500">Ответственные, компетенции и задачи мультифакультетского направления.</p>
              </div>
            )}
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
                  {facultyCompetencies.length > 3 && (
                    <ListDisclosure
                      expanded={showAllFacultyCompetencies}
                      onToggle={() => setShowAllFacultyCompetencies((value) => !value)}
                      total={facultyCompetencies.length}
                      className="mt-3"
                    />
                  )}
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
                                          <div className={`mt-1 inline-flex max-w-full break-words rounded-full px-2.5 py-1 text-xs font-black ${user.registered ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-[#4D647A]'}`}>
                                            {user.registered ? 'Telegram подключён' : 'Не подключён · отправьте /start'}
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
                        <option value="">Все участники факультета</option>
                        <option value="Ответственные">Ответственные</option>
                        {facultyCompetencies.map((name) => <option key={name} value={name}>{name}</option>)}
                      </select>
                      {visibleFacultyTaskUsers.map((user) => (
                        <label key={user.id} className={`flex items-center justify-between rounded-xl px-3 py-2 text-sm font-semibold ${facultyTaskDraft.competency && facultyTaskMatchedUsers.some((item) => item.id === user.id) ? 'bg-blue-50 text-[#0069E0]' : 'bg-white'} ${facultyTaskErrors.assignedTo ? 'ring-2 ring-rose-200' : ''}`}>
                          <span>
                            {user.realName}
                            {user.competencies?.length ? <span className="ml-2 text-xs text-slate-400">{user.competencies.join(', ')}</span> : null}
                          </span>
                          <input type="checkbox" checked={facultyTaskDraft.assignedTo.includes(user.id)} onChange={() => { setFacultyTaskErrors((prev) => ({ ...prev, assignedTo: false })); setFacultyTaskDraft((prev) => ({ ...prev, assignedTo: prev.assignedTo.includes(user.id) ? prev.assignedTo.filter((id) => id !== user.id) : [...prev.assignedTo, user.id] })); }} />
                        </label>
                      ))}
                      {facultyTaskUsers.length > 3 && (
                        <ListDisclosure
                          expanded={showAllFacultyTaskUsers}
                          onToggle={() => setShowAllFacultyTaskUsers((value) => !value)}
                          total={facultyTaskUsers.length}
                        />
                      )}
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
                  <Field label="Дедлайн · до конца дня, МСК">
                    <DatePickerField id="faculty-task-deadline" label="Дедлайн задачи факультету, до конца дня по московскому времени" value={facultyTaskDraft.deadline} onChange={(value) => { setFacultyTaskErrors((prev) => ({ ...prev, deadline: false })); setFacultyTaskDraft((prev) => ({ ...prev, deadline: value })); }} placeholder="Выбери дату" error={facultyTaskErrors.deadline} ariaDescribedBy={facultyTaskErrors.deadline ? 'faculty-task-deadline-error' : undefined} />
                    {facultyTaskErrors.deadline && <RequiredHint id="faculty-task-deadline-error" />}
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
                                    <Trash className="h-4 w-4" /> Отменить задачу
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                  {facultyTasks.length > 3 && (
                    <ListDisclosure
                      expanded={showAllFacultyTasks}
                      onToggle={() => setShowAllFacultyTasks((value) => !value)}
                      total={facultyTasks.length}
                    />
                  )}
                </div>

                <div className="rounded-3xl border border-blue-100 bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="font-black">Журнал задач факультетов</h2>
                    <div className="flex flex-wrap gap-2">
                      <a href="/api/integrations/google-sheets/task-log" target="_blank" rel="noreferrer" className={miniButtonClass}>
                        <ArrowSquareOut className="h-4 w-4" />
                        Таблица лога
                      </a>
                    </div>
                  </div>
                  <div className="mt-3 space-y-3">
                    {Object.keys(facultyTasksByCompetency).length === 0 ? (
                      <EmptyState text="В журнале пока нет задач" />
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
                  {facultyTasks.length > 3 && (
                    <ListDisclosure
                      expanded={showAllFacultyBacklog}
                      onToggle={() => setShowAllFacultyBacklog((value) => !value)}
                      total={facultyTasks.length}
                    />
                  )}
                </div>
              </>
            )}
          </section>
        )}
      </main>

      {completingTaskId && (
        <DialogSheet titleId="task-completion-title" descriptionId="task-completion-description" onClose={() => closeCompletionPrompt()} closeDisabled={savingCompletion} className="border border-blue-100 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="task-completion-title" className="text-xl font-black">{editingCompletedTask ? 'Исправить выполнение' : 'Сколько времени заняла задача?'}</h2>
                <p id="task-completion-description" className="mt-1 text-sm font-semibold text-slate-500">
                  Это необязательно, но поможет точнее планировать нагрузку команды.
                </p>
              </div>
              <button type="button" data-dialog-initial-focus onClick={() => closeCompletionPrompt()} className={miniButtonClass} aria-label="Закрыть">
                <X className="h-4 w-4" />
              </button>
            </div>
            {!editingCompletedTask && sharedCompletionAssigneeCount > 1 && (
              <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900" role="note">
                Общая задача для {sharedCompletionAssigneeCount} исполнителей. Завершение закроет её для всех.
              </div>
            )}
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
        </DialogSheet>
      )}

      {avatarEditorSource && (
        <AvatarCropEditor source={avatarEditorSource} saving={avatarSaving} onCancel={() => setAvatarEditorSource(null)} onSave={saveAvatar} />
      )}

      <nav className="mega-bottom-nav fixed inset-x-0 bottom-0 z-40 border border-blue-100 bg-white/95 p-1.5 shadow-[0_-12px_30px_rgba(0,105,224,0.08)] backdrop-blur">
        <div className="mega-bottom-nav-inner mx-auto grid max-w-3xl grid-cols-5 gap-1">
          <NavButton icon={<CalendarDots />} label="Слоты" active={activeTab === 'slots'} onClick={() => navigateToTab('slots')} />
          <NavButton icon={<Briefcase />} label="Задачи" active={activeTab === 'tasks'} onClick={() => navigateToTab('tasks')} />
          <NavButton icon={<UsersThree />} label="Встречи" active={activeTab === 'meetings'} onClick={() => navigateToTab('meetings')} />
          <NavButton icon={<GraduationCap />} label="МФ" active={activeTab === 'faculties'} onClick={() => navigateToTab('faculties')} />
          <NavButton icon={<Shield />} label="Команда" active={activeTab === 'team'} onClick={() => navigateToTab('team')} />
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
const miniButtonClass = `mega-secondary-button flex min-w-0 items-center justify-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-3 py-2 text-xs font-black text-[#0069E0] hover:bg-blue-100 active:bg-blue-200 ${pressClass}`;
const iconButtonClass = `flex items-center justify-center rounded-full border border-white/25 bg-white/15 text-white backdrop-blur hover:bg-white/25 active:bg-white/30 ${pressClass}`;

function ProfileBlockSelectors({
  competencies,
  selected,
  primary,
  primaryOpen,
  secondaryOpen,
  onTogglePrimary,
  onToggleSecondary,
  onPrimaryChange,
  onSecondaryToggle,
}: {
  competencies: string[];
  selected: string[];
  primary: string;
  primaryOpen: boolean;
  secondaryOpen: boolean;
  onTogglePrimary: () => void;
  onToggleSecondary: () => void;
  onPrimaryChange: (name: string) => void;
  onSecondaryToggle: (name: string) => void;
}) {
  const secondaryCompetencies = competencies.filter((name) => name !== primary);
  const selectedSecondaryCount = selected.filter((name) => name !== primary).length;
  const disclosure = (label: string, value: string, open: boolean, onToggle: () => void) => (
    <button type="button" onClick={onToggle} aria-expanded={open} className={`${secondaryButtonClass} min-h-11 w-full justify-between px-3`}>
      <span className="min-w-0 truncate text-left">{label} · {value}</span>
      {open ? <CaretUp className="h-4 w-4 shrink-0" /> : <CaretDown className="h-4 w-4 shrink-0" />}
    </button>
  );

  return (
    <div className="space-y-2">
      <div className="min-w-0">
        {disclosure('Главный блок', primary || 'не выбран', primaryOpen, onTogglePrimary)}
        {primaryOpen && (
          <div className="mt-2 grid grid-cols-1 gap-2 rounded-2xl border border-slate-200 bg-white p-2">
            {competencies.length === 0 ? (
              <div className="px-2 py-1 text-xs font-bold text-slate-400">Админ ещё не добавил блоки</div>
            ) : competencies.map((name) => (
              <label key={name} className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-semibold">
                <span className="min-w-0 break-words">{name}</span>
                <input type="radio" name="profile-primary-competency" checked={primary === name} onChange={() => onPrimaryChange(name)} />
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="min-w-0">
        {disclosure('Второстепенные блоки', `${selectedSecondaryCount} выбрано`, secondaryOpen, onToggleSecondary)}
        {secondaryOpen && (
          <div className="mt-2 grid grid-cols-1 gap-2 rounded-2xl border border-slate-200 bg-white p-2">
            {secondaryCompetencies.length === 0 ? (
              <div className="px-2 py-1 text-xs font-bold text-slate-400">Других блоков пока нет</div>
            ) : secondaryCompetencies.map((name) => (
              <label key={name} className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-semibold">
                <span className="min-w-0 break-words">{name}</span>
                <input type="checkbox" checked={selected.includes(name)} onChange={() => onSecondaryToggle(name)} />
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DatePickerField({
  id,
  label,
  value,
  onChange,
  placeholder = 'Дата не выбрана',
  withYear = true,
  fullYear = false,
  error = false,
  ariaDescribedBy,
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  withYear?: boolean;
  fullYear?: boolean;
  error?: boolean;
  ariaDescribedBy?: string;
}) {
  const generatedId = useId();
  const inputId = id || `date-${generatedId.replace(/:/g, '')}`;
  const valueHintId = `${inputId}-value`;
  const focusedRef = useRef(false);
  const dirtyRef = useRef(false);
  const [draft, setDraft] = useState(() => shortDateToInputDate(value));
  useEffect(() => {
    if (!focusedRef.current) setDraft(shortDateToInputDate(value));
  }, [value]);
  return (
    <div className="min-w-0 max-w-full">
      <input
        id={inputId}
        type="date"
        aria-label={label}
        aria-invalid={error || undefined}
        aria-describedby={[valueHintId, ariaDescribedBy].filter(Boolean).join(' ') || undefined}
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
      <div id={valueHintId} className={`mt-1 flex items-center gap-1.5 text-xs font-bold ${value ? 'text-[#0069E0]' : 'text-slate-400'}`}>
        <CalendarDots className="h-3.5 w-3.5" />
        {value || placeholder}
      </div>
    </div>
  );
}

function RequiredHint({ text = 'Обязательное поле', id }: { text?: string; id?: string }) {
  return <div id={id} role="alert" className="mt-1 text-xs font-black text-rose-500">{text}</div>;
}

function NavButton({ icon, label, active, onClick }: { icon: React.ReactElement; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-current={active ? 'page' : undefined} className={`flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-2xl px-0.5 text-xs font-black leading-tight sm:h-14 ${pressClass} ${active ? 'bg-[#0069E0] text-white hover:bg-[#1677E8] active:bg-[#0058BD]' : 'text-slate-500 hover:bg-slate-100 active:bg-slate-100'}`}>
      {React.cloneElement(icon, { className: 'h-5 w-5', weight: active ? 'fill' : 'regular' })}
      <span className="truncate">{label}</span>
    </button>
  );
}

function MeetingKindPicker({ value, onChange }: { value: MeetingKind; onChange: (value: MeetingKind) => void }) {
  const options = [
    { id: 'meeting' as const, title: 'Собрание', description: 'Встреча команды или выбранных людей' },
    { id: 'setup' as const, title: 'Монтаж', description: 'Подготовка площадки всей командой' },
    { id: 'vibe' as const, title: 'Вайбик', description: 'Неформальная встреча с командой' },
  ];
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-black uppercase tracking-wide text-slate-500">Что назначаем</legend>
      <div className="grid grid-cols-1 gap-2 min-[520px]:grid-cols-3">
        {options.map((option) => (
          <label
            key={option.id}
            className={`min-w-0 cursor-pointer rounded-2xl border px-3 py-3 text-left transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#0069E0] has-[:focus-visible]:ring-offset-2 ${pressClass} ${meetingAudienceOptionClass(value === option.id)}`}
          >
            <input className="sr-only" type="radio" name="meeting-kind" value={option.id} checked={value === option.id} onChange={() => onChange(option.id)} />
            <span className="block break-words text-sm font-black">{option.title}</span>
            <span className="mt-1 block text-xs font-semibold opacity-75">{option.description}</span>
          </label>
        ))}
      </div>
    </fieldset>
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
          <label
            key={option.id}
            className={`cursor-pointer rounded-2xl border px-3 py-3 text-left transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#0069E0] has-[:focus-visible]:ring-offset-2 ${pressClass} ${meetingAudienceOptionClass(value === option.id)}`}
          >
            <input className="sr-only" type="radio" name="meeting-audience" value={option.id} checked={value === option.id} onChange={() => onChange(option.id)} />
            <span className="block text-sm font-black">{option.title}</span>
            <span className="mt-1 block text-xs font-semibold opacity-75">{option.description}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function EventScopePicker({ events, value, onChange }: { events: WorkEvent[]; value: string; onChange: (value: string) => void }) {
  const activeEvents = events.filter((workEvent) => workEvent.status === 'active');
  const archivedCount = events.filter((workEvent) => workEvent.status === 'archived').length;
  const options = [
    { id: TASK_EVENT_SCOPE_ALL, label: 'Все задачи' },
    { id: TASK_EVENT_SCOPE_NONE, label: 'Без мероприятия' },
    ...activeEvents.map((workEvent) => ({ id: workEvent.id, label: workEvent.name })),
    ...(archivedCount ? [{ id: TASK_EVENT_SCOPE_ARCHIVED, label: `Архив · ${archivedCount}` }] : []),
  ];
  const useSingleColumn = options.some((option) => option.label.length > 24)
    || options.some((option, index) => index % 2 === 1 && option.label.length + options[index - 1].label.length > 38);
  return (
    <div className="rounded-3xl border border-blue-100 bg-white p-3 shadow-sm">
      <div className="mb-2 px-1 text-xs font-black uppercase tracking-wide text-slate-500">Показать задачи</div>
      <div className={`grid gap-2 ${useSingleColumn ? 'grid-cols-1' : 'grid-cols-2'}`} role="radiogroup" aria-label="Фильтр задач по мероприятию">
        {options.map((option, index) => {
          const selected = value === option.id;
          const fillsOddLastRow = !useSingleColumn && options.length % 2 === 1 && index === options.length - 1;
          return (
            <button key={option.id} type="button" role="radio" aria-checked={selected} onClick={() => onChange(option.id)} className={`min-h-12 min-w-0 break-words rounded-2xl border px-3 py-2 text-sm font-black leading-tight ${fillsOddLastRow ? 'col-span-2' : ''} ${pressClass} ${selected ? 'border-[#0069E0] bg-[#0069E0] text-white shadow-[0_8px_20px_rgba(0,105,224,0.2)]' : 'border-blue-100 bg-blue-50 text-[#005BC4] hover:bg-blue-100'}`}>
              {option.label}
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
    <DialogSheet titleId="avatar-editor-title" descriptionId="avatar-editor-description" onClose={onCancel} closeDisabled={saving}>
        <div className="flex items-center justify-between gap-3">
          <div><h2 id="avatar-editor-title" className="text-lg font-black">Обрезать аватар</h2><p id="avatar-editor-description" className="text-xs font-semibold text-slate-500">Перемести кадр ползунками и выбери масштаб.</p></div>
          <button type="button" data-dialog-initial-focus disabled={saving} onClick={onCancel} className={miniButtonClass} aria-label="Закрыть"><X className="h-4 w-4" /></button>
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
    </DialogSheet>
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
      </div>
      {tasks.length === 0 ? (
        <EmptyState text="По выбранным фильтрам задач нет." />
      ) : (
        visibleTasks.map((task) => {
          const expanded = expandedTaskId === task.id;
          const creator = users.find((user) => user.id === task.creatorId);
          const workEvent = events.find((item) => item.id === task.eventId);
          const executors = taskAssigneeIds(task).map((id) => users.find((user) => user.id === id)).filter(Boolean) as User[];
          const completedBy = users.find((user) => user.id === task.completedBy);
          const isMine = taskAssigneeIds(task).includes(currentUser.id);
          const canCoordinate = currentUser.role === 'admin' || task.creatorId === currentUser.id;
          const detailsId = `task-details-${task.id}`;
          return (
          <div key={task.id} className="rounded-3xl border border-blue-100 bg-white p-4">
            <div className="flex flex-col items-stretch gap-3 min-[380px]:flex-row min-[380px]:items-start min-[380px]:justify-between">
              <div className="min-w-0">
                <h3 className="break-words font-black">{task.title}</h3>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-bold text-slate-600">
                  <span className="flex items-center gap-1 tabular-nums"><Clock className="h-4 w-4" /> До {formatDateShort(task.deadline)}</span>
                  <span>{taskPriorityText(task.priority)}</span>
                </div>
              </div>
              {task.status !== 'completed' && onAction && actionLabel && (
                <button type="button" onClick={() => onAction(task.id)} className={`mega-primary-button w-full shrink-0 rounded-full bg-[#0069E0] px-3 py-2 text-xs font-black text-white hover:bg-[#1677E8] active:bg-[#0058BD] min-[380px]:w-auto ${pressClass}`}>
                  {actionLabel}
                </button>
              )}
            </div>
            <p className="mt-3 break-words text-sm font-semibold text-slate-700">
              Исполнители: {executors.length ? executors.map((user) => user.realName).join(', ') : 'пока никто не взял'}
            </p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs font-bold text-slate-500">
              {executors.length > 1 && <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-800">Общая задача</span>}
              <span className="max-w-full break-words rounded-full bg-slate-950 px-2.5 py-1 text-white">
                {workEvent?.name || 'Без мероприятия'}
              </span>
              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[#0069E0]">
                {taskCompetencyNames(task).join(', ') || 'Без блока'}
              </span>
            </div>

            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpandedTaskId(expanded ? null : task.id)}
              className={`${secondaryButtonClass} mt-3 w-full justify-between`}
            >
              <span>{expanded ? 'Скрыть подробности' : 'Подробнее'}</span>
              {expanded ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
            </button>

            {expanded && (
              <div id={detailsId} className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm text-slate-600">
                <InfoRow label="Описание" value={task.description || 'Без описания'} />
                {creator && <InfoRow label="Автор" value={creator.realName} href={telegramLink(creator.username)} />}
                <InfoRow label="Мероприятие" value={workEvent?.name || 'Без мероприятия'} />
                <InfoRow label="Блоки" value={taskCompetencyNames(task).join(', ') || 'Без блока'} />
                <InfoRow label="Статус" value={task.status === 'open' ? 'Открытая' : task.status === 'completed' ? 'Готово' : 'В работе'} />
                <InfoRow label="Исполнители" value={executors.length ? executors.map((user) => user.realName).join(', ') : 'пока никто'} />
                {executors.length > 1 && <InfoRow label="Режим" value="Общая: завершение закроет задачу для всех" />}
                {task.status === 'completed' && completedBy && <InfoRow label="Завершил" value={completedBy.realName} />}
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
                {task.sow && <InfoRow label="ТЗ" value={task.sow} />}
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
                    {onDelete && task.status !== 'completed' && <button type="button" onClick={() => onDelete(task.id)} className={`${miniButtonClass} border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100`}><Trash className="h-4 w-4" /> Отменить задачу</button>}
                  </div>
                )}
                {task.status === 'completed' && (isMine || currentUser.role === 'admin') && onEditCompletion && (
                  <button type="button" onClick={() => onEditCompletion(task.id)} className={`${miniButtonClass} border-amber-200 bg-amber-50 text-amber-800`}>
                    <PencilSimple className="h-4 w-4" /> Исправить выполнение
                  </button>
                )}
                {isMine && task.status === 'assigned' && onRelease && (
                  <button type="button" onClick={() => onRelease(task.id)} className={`${miniButtonClass} border-amber-100 bg-amber-50 text-amber-700 hover:bg-amber-100`}>
                    Отказаться от задачи
                  </button>
                )}
              </div>
            )}
          </div>
        );
        })
      )}
      {tasks.length > 3 && (
        <ListDisclosure expanded={showAll} onToggle={() => setShowAll((value) => !value)} total={tasks.length} />
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
      ))}
    </div>
  );
}

function AvailabilityGroupDisclosure({
  title,
  count,
  expanded,
  onToggle,
  countClassName,
  children,
}: {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  countClassName: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`overflow-hidden rounded-2xl border bg-white transition-colors ${expanded ? 'border-[#0069E0]' : 'border-blue-100'}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm font-black ${pressClass}`}
      >
        <span className="min-w-0 truncate">{title}</span>
        <span className="flex shrink-0 items-center gap-2">
          <span className={`min-w-7 rounded-full px-2 py-1 text-center text-xs tabular-nums ${countClassName}`}>{count}</span>
          {expanded ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
        </span>
      </button>
      {expanded && (
        <div className="max-h-[22rem] space-y-2 overflow-y-auto border-t border-blue-100 bg-slate-50 p-2">
          {children}
        </div>
      )}
    </div>
  );
}

function AvailabilityEmptyState({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-500">{children}</div>;
}

function AvailabilityPersonLink({ user }: { user: Pick<User, 'id' | 'realName' | 'username'> }) {
  const content = (
    <>
      <span className="min-w-0 truncate font-black text-slate-700">{user.realName}</span>
      {user.username && <span className="shrink-0 text-xs font-bold text-[#0069E0]">{user.username}</span>}
    </>
  );
  if (!user.username) {
    return <div className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 text-sm">{content}</div>;
  }
  const href = telegramLink(user.username);
  return (
    <a href={href} onClick={(event) => openTelegramProfile(event, href)} className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 text-sm">
      {content}
    </a>
  );
}

function MeetingDurationOptions({kind, value}: {kind: MeetingKind; value: string}) {
  const hours = kind === 'setup' ? Array.from({length: 12}, (_, index) => index + 1) : [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6];
  return <>
    {meetingDurationError(kind, Number(value)) && <option value={value} disabled>{value.replace('.', ',')} ч — выбери длительность</option>}
    {hours.map(hour => <option key={hour} value={hour}>{taskDurationText(hour * 60)}</option>)}
  </>;
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
      onClick={() => {
        const top = window.scrollY;
        onToggle();
        // The focused disclosure moves below new rows; don't follow it down.
        if (!expanded) requestAnimationFrame(() => window.scrollTo({top, behavior: 'instant'}));
      }}
      aria-expanded={expanded}
      className={`${secondaryButtonClass} mega-list-disclosure w-full shrink-0 ${className}`}
    >
      {expanded ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
      {expanded ? 'Свернуть' : `Развернуть ${Math.max(0, total - 3)}`}
    </button>
  );
}

function MeetingAttendanceList({
  meetingId,
  users,
  expanded,
  onToggle,
}: {
  meetingId: string;
  users: User[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const visibleUsers = expanded ? users : users.slice(0, 3);
  const listId = `meeting-attendees-${meetingId}`;
  return (
    <section className="mt-3 rounded-2xl border border-blue-100 bg-blue-50 p-3" aria-labelledby={`${listId}-title`}>
      <div className="min-w-0">
        <h4 id={`${listId}-title`} className="font-black [color:var(--mega-link)]">Придут · {users.length}</h4>
      </div>
      {visibleUsers.length ? (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 rounded-xl bg-white px-3 py-2.5">
          <p id={listId} className="min-w-0 flex-1 break-words text-sm font-bold leading-6 text-slate-700">
            {visibleUsers.map((user) => user.realName).join(', ')}
          </p>
        </div>
      ) : (
        <p id={listId} className="mt-3 rounded-xl bg-white px-3 py-3 text-sm font-bold text-slate-600">Пока никто не подтвердил участие.</p>
      )}
      {users.length > 3 && <ListDisclosure expanded={expanded} onToggle={onToggle} total={users.length} className="mt-2" />}
    </section>
  );
}

function SuggestionPeopleLists({
  canUsers,
  cannotUsers,
}: {
  canUsers: Pick<User, 'id' | 'realName' | 'username'>[];
  cannotUsers: (Pick<User, 'id' | 'realName' | 'username'> & { reason: 'out' | 'not_marked' | 'inconvenient' })[];
}) {
  const [expandedGroup, setExpandedGroup] = useState<'can' | 'cannot' | null>(null);
  return (
    <div className="space-y-2 border-t border-blue-100 p-3">
      <AvailabilityGroupDisclosure
        title="Смогут"
        count={canUsers.length}
        expanded={expandedGroup === 'can'}
        onToggle={() => setExpandedGroup((value) => value === 'can' ? null : 'can')}
        countClassName="bg-emerald-100 text-emerald-700"
      >
        {canUsers.length ? canUsers.map((user) => <React.Fragment key={user.id}><AvailabilityPersonLink user={user} /></React.Fragment>) : (
          <AvailabilityEmptyState>Никто из отметившихся не сможет прийти.</AvailabilityEmptyState>
        )}
      </AvailabilityGroupDisclosure>
      <AvailabilityGroupDisclosure
        title="Не смогут"
        count={cannotUsers.length}
        expanded={expandedGroup === 'cannot'}
        onToggle={() => setExpandedGroup((value) => value === 'cannot' ? null : 'cannot')}
        countClassName="bg-slate-200 text-slate-700"
      >
        {cannotUsers.length ? cannotUsers.map((user) => <React.Fragment key={user.id}><SuggestionUnavailablePerson user={user} /></React.Fragment>) : (
          <AvailabilityEmptyState>Вся команда сможет прийти.</AvailabilityEmptyState>
        )}
      </AvailabilityGroupDisclosure>
    </div>
  );
}

function SuggestionUnavailablePerson({
  user,
}: {
  user: Pick<User, 'id' | 'realName' | 'username'> & { reason: 'out' | 'not_marked' | 'inconvenient' };
}) {
  const reason = {
    out: { label: 'в ауте', className: 'bg-rose-100 text-rose-700' },
    not_marked: { label: 'не отметился', className: 'bg-amber-100 text-amber-800' },
    inconvenient: { label: 'неудобный слот', className: 'bg-slate-200 text-slate-700' },
  }[user.reason];
  const identity = (
    <span className="min-w-0">
      <span className="block truncate font-black text-slate-700">{user.realName}</span>
      {user.username && <span className="block truncate text-xs font-bold text-[#0069E0]">{user.username}</span>}
    </span>
  );
  return (
    <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm">
      {user.username ? (
        <a href={telegramLink(user.username)} onClick={(event) => openTelegramProfile(event, telegramLink(user.username))} className="min-w-0">{identity}</a>
      ) : identity}
      <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-black ${reason.className}`}>{reason.label}</span>
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
