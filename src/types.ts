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
}

export interface Availability {
  userId: string;
  slots: Record<number, number[]>;
  hardUnavailableDays?: number[];
  outWeekIndexes?: number[];
  updatedAt: string;
  weekStart?: string;
}

export type MeetingType = 'general' | 'custom';

export interface Meeting {
  id: string;
  title: string;
  type: MeetingType;
  date: string;
  time: string;
  duration: number;
  hostId: string;
  participants: string[] | 'all';
  attendeeIds?: string[];
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
    databaseRevision?: number;
  };
}
