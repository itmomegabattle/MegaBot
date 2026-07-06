export type UserRole = 'admin' | 'organizer' | 'faculty_responsible' | 'faculty_helper';

export interface User {
  id: string;
  username: string;
  realName: string;
  role: UserRole;
  avatarSeed: string;
  birthday?: string;
  telegramId?: string;
  registered?: boolean;
  competencies?: string[];
  primaryCompetency?: string;
  facultyId?: string;
}

export interface Availability {
  userId: string;
  slots: Record<number, number[]>;
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
  competency?: string;
  topic?: string;
  description?: string;
  status: 'scheduled' | 'completed' | 'cancelled';
}

export type TaskStatus = 'open' | 'assigned' | 'completed' | 'waiting' | 'in_progress';

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
  assignedTo: string | string[] | null;
  creatorId?: string;
  competency?: string;
  sow: string;
  tips: string[];
  status: TaskStatus;
  workload: 'low' | 'medium' | 'high';
  weightValue: number;
  createdAt?: string;
  completedAt?: string;
  facultyId?: string;
  reminders?: TaskReminder[];
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
  tasks: Task[];
  messages: Record<string, BotMessage[]>;
}
