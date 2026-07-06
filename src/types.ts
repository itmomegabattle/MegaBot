export type UserRole = 'admin' | 'organizer';

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
}

export interface Availability {
  userId: string;
  slots: Record<number, number[]>;
  updatedAt: string;
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
  status: 'scheduled' | 'completed' | 'cancelled';
}

export type TaskStatus = 'open' | 'assigned' | 'completed';

export interface Task {
  id: string;
  title: string;
  description: string;
  deadline: string;
  assignedTo: string | string[] | null;
  creatorId?: string;
  sow: string;
  tips: string[];
  status: TaskStatus;
  workload: 'low' | 'medium' | 'high';
  weightValue: number;
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
  competencies?: string[];
  availabilities: Record<string, Availability>;
  meetings: Meeting[];
  tasks: Task[];
  messages: Record<string, BotMessage[]>;
}
