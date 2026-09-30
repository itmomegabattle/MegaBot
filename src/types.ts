export type UserRole = 'admin' | 'organizer' | 'faculty_responsible' | 'faculty_helper';

export interface User {
  id: string;
  username: string;
  realName: string;
  role: UserRole;
  avatarSeed: string;
  avatarDataUrl?: string;
  birthday?: string;
  telegramId?: string;
  registered?: boolean;
  competencies?: string[];
  primaryCompetency?: string;
  facultyId?: string;
  joinedAt?: string;
  lastSeenAt?: string;
  active?: boolean;
  deactivatedAt?: string;
  deactivatedBy?: string;
}

export interface Availability {
  userId: string;
  slots: Record<number, number[]>;
  hardUnavailableDays?: number[];
  outWeekIndexes?: number[];
  weekVersions?: Record<string, number>;
  updatedAt: string;
  weekStart?: string;
}

export type MeetingType = 'general' | 'custom';
export type MeetingKind = 'meeting' | 'setup' | 'vibe';
export type MeetingRsvp = 'yes' | 'no';

export interface Meeting {
  id: string;
  title: string;
  kind?: MeetingKind;
  eventId?: string;
  type: MeetingType;
  date: string;
  time: string;
  duration: number;
  hostId: string;
  participants: string[] | 'all';
  audiencePolicy?: 'snapshot';
  audienceUserIds?: string[];
  attendeeIds?: string[];
  rsvpByUser?: Record<string, MeetingRsvp>;
  competency?: string;
  topic?: string;
  description?: string;
  status: 'scheduled' | 'completed' | 'cancelled';
  googleCalendarEventId?: string;
}

export type TaskStatus = 'open' | 'assigned' | 'completed' | 'waiting' | 'in_progress' | 'cancelled';

export interface TaskNoteComment {
  id: string;
  authorId: string;
  side: 'executor' | 'coordinator';
  text: string;
  createdAt: string;
}

export interface TaskAssigneeNote {
  executor?: string;
  coordinator?: string;
  updatedAt?: string;
  history?: TaskNoteComment[];
}

export interface WorkEvent {
  id: string;
  name: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  status: 'active' | 'archived';
  createdAt: string;
  createdBy?: string;
}

export interface TaskReminder {
  id: string;
  type: 'before_deadline' | 'repeat';
  value: number;
  unit: 'days' | 'hours';
  sentAt?: string;
  lastSentAt?: string;
}

export interface Task {
  id: string;
  version?: number;
  title: string;
  description: string;
  deadline: string;
  assignedTo: string[] | null;
  creatorId?: string;
  competency?: string;
  competencies?: string[];
  sow: string;
  tips: string[];
  status: TaskStatus;
  priority: 'normal' | 'important' | 'critical';
  createdAt?: string;
  completedAt?: string;
  assignmentMode?: 'shared';
  completedBy?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  timeSpentMinutes?: number;
  facultyId?: string;
  eventId?: string;
  reminders?: TaskReminder[];
  assigneeNotes?: Record<string, TaskAssigneeNote>;
  completionComments?: Record<string, string>;
}

export interface Faculty {
  id: string;
  name: string;
}

export interface BotMessage {
  id: string;
  userId: string;
  sender: 'user' | 'bot';
  text: string;
  timestamp: string;
  buttons?: { text: string; action: string }[];
}

export interface SimulationState {
  serverNow?: string;
  timeZone?: string;
  users: User[];
  faculties?: Faculty[];
  facultyCompetencies?: string[];
  competencies?: string[];
  availabilities: Record<string, Availability>;
  meetings: Meeting[];
  events?: WorkEvent[];
  tasks: Task[];
  messages: Record<string, BotMessage[]>;
  settings?: {
    teamChatId?: string;
    teamImportantThreadId?: number;
    availabilityWeekCount?: number;
    availabilityActiveDays?: number[];
    availabilityStartHour?: number;
    availabilityEndHour?: number;
    availabilityWeekNames?: string[];
    availabilityWeekDescriptions?: string[];
    availabilityWeekMetadata?: Record<string, { name?: string; description?: string }>;
    availabilityWeekStart?: string;
    pendingImportantNotifications?: Array<{
      id: string;
      text: string;
      silent: boolean;
      createdAt: string;
      attempts: number;
      lastAttemptAt?: string;
    }>;
    notificationDeliveries?: NotificationDelivery[];
    notificationDeliverySummary?: {
      total: number;
      byStatus: Record<string, number>;
      pending: number;
      attention: number;
      overloaded: boolean;
      oldestPendingAt?: string;
    };
    telegramInbox?: TelegramInboxEntry[];
    databaseRevision?: number;
    idempotencyRecords?: Array<{
      key: string;
      actorId: string;
      operation: string;
      bodyHash: string;
      status: 'processing' | 'completed';
      responseStatus?: number;
      responseBody?: unknown;
      createdAt: string;
      completedAt?: string;
    }>;
  };
}

export type NotificationDeliveryStatus = 'planned' | 'sending' | 'sent' | 'retry' | 'failed' | 'unknown' | 'cancelled' | 'expired';

export interface NotificationDelivery {
  id: string;
  dedupeKey: string;
  category: string;
  recipientId?: string;
  chatId: string;
  text: string;
  replyMarkup?: Record<string, unknown>;
  messageThreadId?: number;
  disableNotification?: boolean;
  disableWebPagePreview?: boolean;
  intendedAt: string;
  availableAt: string;
  expiresAt?: string;
  status: NotificationDeliveryStatus;
  attempts: number;
  leaseToken?: string;
  leasedUntil?: string;
  lastAttemptAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  telegramMessageId?: number;
  sentAt?: string;
  updatedAt: string;
}

export type TelegramInboxStatus = 'received' | 'processing' | 'retry' | 'completed' | 'failed';

export interface TelegramInboxEntry {
  updateId: number;
  chatKey: string;
  payload: Record<string, unknown>;
  status: TelegramInboxStatus;
  receivedAt: string;
  availableAt: string;
  attempts: number;
  leaseToken?: string;
  leasedUntil?: string;
  lastAttemptAt?: string;
  lastError?: string;
  processedAt?: string;
  updatedAt: string;
}
