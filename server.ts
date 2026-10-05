import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import { ProxyAgent } from 'undici';
import { SimulationState, User, Availability, Meeting, Task, BotMessage, Faculty, TaskReminder, WorkEvent, NotificationDelivery } from './src/types.js';
import { isAvailabilityReminderTime, millisecondsUntilNextWholeHour, moscowClock } from './src/reminderSchedule.js';
import {
  buildUserMappingReport,
  currentMoscowWeekStart,
  ensureTemplateSheet,
  ensurePrimaryWeekSheet,
  exportAvailabilitiesToSheet,
  exportAvailabilityToSheet,
  googleSheetsConfigFromEnv,
  importAvailabilitiesFromSheet,
  verifySheetsWebhook,
} from './src/googleSheetsSync.js';
import {
  exportStateToGoogleSheetsDatabase,
  googleSheetsDatabaseSheetUrl,
  googleSheetsDatabaseConfigFromEnv,
  importStateFromGoogleSheetsDatabase,
} from './src/googleSheetsDatabase.js';
import { mergePrimarySheetAvailability, sanitizeSimulationState } from './src/stateMaintenance.js';
import { alignAvailabilityToWeek, filterSlotsByAvailabilityConfig, normalizeAvailabilityConfig } from './src/availabilityConfig.js';
import { AvailabilityWeekConflictError, AvailabilityWeekRangeError, replaceAvailabilityWeek } from './src/availabilityWeekMutation.js';
import { birthdayParts, deliverBirthdayReminders } from './src/birthdayGift.js';
import { meetingKindText, normalizeMeetingKind } from './src/meetingKind.js';
import { meetingPhase, meetingStartTimestamp } from './src/meetingLifecycle.js';
import { meetingRsvpFor, normalizedMeetingRsvps, setMeetingRsvp } from './src/meetingRsvp.js';
import { completeTaskCommand, releaseTaskCommand, TaskCommandError } from './src/taskCommands.js';
import { meetingScheduleError } from './src/meetingScheduling.js';
import { chatNavigationTarget } from './src/chatNavigation.js';
import {
  applyTelegramDeliveryOutcome,
  claimNotificationDelivery,
  createNotificationDelivery,
  notificationDeliverySummary,
  retryNotificationDelivery,
  type TelegramDeliveryOutcome,
} from './src/notificationDelivery.js';
import {
  claimTelegramInboxEntry,
  completeTelegramInboxEntry,
  failTelegramInboxEntry,
  recordTelegramUpdates,
} from './src/telegramInbox.js';
import { deactivateUser, findOrphanUserReferences, isUserActive } from './src/userLifecycle.js';
import {
  activeCoreTeamUsers,
  resolveMeetingAudienceUsers,
  resolveTaskAudienceUsers,
  sanitizeTaskAssigneeIds,
  snapshotMeetingAudienceUserIds,
} from './src/audiencePolicy.js';
import { completeIdempotency, findIdempotencyRecord, idempotencyActor, idempotencyBodyHash, reserveIdempotency } from './src/idempotency.js';
import {
  googleCalendarConfigFromEnv,
  reconcileGoogleCalendar,
  syncMeetingToGoogleCalendar,
} from './src/googleCalendarSync.js';
import {
  databaseRecoveryDirectory,
  readLatestDatabaseRecoveryRecord,
  writeDatabaseRecoveryRecord,
} from './src/databaseRecoveryJournal.js';
import {
  PROJECT_TIME_ZONE,
  parseProjectLocalDate,
  projectClock,
  projectDateDeadlineInstant,
  projectDateTimeInstant,
} from './src/projectTime.js';

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const telegramProxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;

function telegramFetch(input: string, init: RequestInit = {}) {
  const url = String(input);
  const isLongPoll = url.includes('/getUpdates');
  const isSendMessage = url.includes('/sendMessage');
  const timeoutMs = isLongPoll ? 40000 : 10000;
  // A timed-out sendMessage may already have been accepted by Telegram. Retrying
  // it blindly can duplicate a user-visible notification, so the durable queue
  // records it as unknown and leaves the decision to an administrator.
  const attempts = isLongPoll || isSendMessage ? 1 : 2;

  const run = async (attempt = 1): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, telegramProxyAgent ? ({
        ...init,
        signal: init.signal || controller.signal,
        dispatcher: telegramProxyAgent,
      } as RequestInit) : {
        ...init,
        signal: init.signal || controller.signal,
      });
    } catch (err) {
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
        return run(attempt + 1);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  };

  return run();
}

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(process.cwd(), 'database.json');
const SESSION_FILE = process.env.SESSION_FILE
  ? path.resolve(process.env.SESSION_FILE)
  : path.join(path.dirname(DB_FILE), 'sessions.json');
const DATABASE_SHEETS_CONFIG = googleSheetsDatabaseConfigFromEnv();
const DATABASE_RECOVERY_DIRECTORY = databaseRecoveryDirectory(DB_FILE);
const DATABASE_RECOVERY_RETENTION = positiveIntegerEnvironment('DATABASE_RECOVERY_RETENTION', 20);
const CHAT_PANEL_FILE = process.env.CHAT_PANEL_FILE
  ? path.resolve(process.env.CHAT_PANEL_FILE)
  : DATABASE_SHEETS_CONFIG?.enabled
    ? path.join(process.cwd(), 'chat-panels.json')
    : `${DB_FILE}.chat-panels.json`;
let databaseStateCache: SimulationState | null = null;
let pendingDatabaseSheetsState: SimulationState | null = null;
let databaseSheetsFlushTimer: NodeJS.Timeout | null = null;
let databaseSheetsFlushPromise: Promise<void> | null = null;
let lastDatabaseSheetsSyncedRevision = 0;
let isShuttingDown = false;
const runtimeOperations = {
  lastPersistenceSuccessAt: undefined as string | undefined,
  lastPersistenceErrorAt: undefined as string | undefined,
  lastPersistenceError: undefined as string | undefined,
  lastReplicationSuccessAt: undefined as string | undefined,
  lastReplicationErrorAt: undefined as string | undefined,
  lastReplicationError: undefined as string | undefined,
  lastTelegramSuccessAt: undefined as string | undefined,
  lastTelegramErrorAt: undefined as string | undefined,
  lastTelegramError: undefined as string | undefined,
  lastCalendarSuccessAt: undefined as string | undefined,
  lastCalendarErrorAt: undefined as string | undefined,
  lastCalendarError: undefined as string | undefined,
  lastAvailabilitySheetsSuccessAt: undefined as string | undefined,
  lastAvailabilitySheetsErrorAt: undefined as string | undefined,
  lastAvailabilitySheetsError: undefined as string | undefined,
  workerHeartbeats: {} as Record<string, string>,
};
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type StoredSession = {
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
};

let sessionStoreCache: StoredSession[] | null = null;

const PRODUCTION_WEBAPP_URL = 'https://megaorgiabot.ru';
const TEMPORARY_TUNNEL_HOST = /(?:^|\.)(?:loca\.lt|localtunnel\.me|lhr\.life|ngrok(?:-free)?\.(?:app|io)|trycloudflare\.com)$/i;
const SELF_ACTOR_USER_ID_PATHS = new Set(['/availability', '/task/claim', '/task/release']);
const FACULTY_SESSION_PATHS = new Set(['/auth/logout', '/faculty/me', '/faculty/my-tasks']);
const IDEMPOTENT_CREATE_PATHS = new Set([
  '/user/add', '/faculty/user/add', '/faculty/task/create', '/meeting', '/task/create', '/team/broadcast',
]);
let resolvedWebAppUrl: string | undefined;

type TelegramUpdateMode = 'polling' | 'webhook' | 'disabled';

type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

function positiveIntegerEnvironment(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function safeOperationalError(error: unknown) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\/bot[^/\s]+\//gi, '/bot[redacted]/')
    .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}

function markWorkerHeartbeat(worker: string) {
  runtimeOperations.workerHeartbeats[worker] = new Date().toISOString();
}

function createFixedWindowRateLimiter(windowMs: number, limit: number) {
  const entries = new Map<string, { count: number; resetAt: number }>();
  return (key: string, cost = 1): RateLimitResult => {
    const now = Date.now();
    let entry = entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      entries.set(key, entry);
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    if (entry.count + cost > limit) return { allowed: false, retryAfterSeconds };
    entry.count += cost;
    if (entries.size > 10_000) {
      for (const [entryKey, candidate] of entries) {
        if (candidate.resetAt <= now) entries.delete(entryKey);
      }
    }
    return { allowed: true, retryAfterSeconds };
  };
}

function rateLimitResponse(res: express.Response, result: RateLimitResult, error: string) {
  res.setHeader('Retry-After', String(result.retryAfterSeconds));
  return res.status(429).json({ error, retryAfterSeconds: result.retryAfterSeconds });
}

function isAllowedMutationOrigin(req: express.Request) {
  const rawOrigin = req.get('Origin');
  if (!rawOrigin) return false;
  try {
    const origin = new URL(rawOrigin).origin;
    const allowedOrigins = new Set<string>();
    const host = req.get('host');
    if (host) {
      const forwardedProtocol = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
      allowedOrigins.add(`${forwardedProtocol || req.protocol}://${host}`);
    }
    const webAppUrl = configuredWebAppUrl();
    if (webAppUrl) allowedOrigins.add(new URL(webAppUrl).origin);
    return allowedOrigins.has(origin);
  } catch {
    return false;
  }
}

function configuredTelegramUpdateMode(): TelegramUpdateMode {
  const configured = String(process.env.TELEGRAM_UPDATE_MODE || '').trim().toLowerCase();
  if (!configured) return process.env.DISABLE_TELEGRAM_POLLING === 'true' ? 'disabled' : 'polling';
  if (configured === 'polling' || configured === 'webhook' || configured === 'disabled') return configured;
  throw new Error('TELEGRAM_UPDATE_MODE must be polling, webhook, or disabled');
}

function constantTimeSecretEquals(actual: string, expected: string) {
  const actualDigest = crypto.createHash('sha256').update(actual).digest();
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest) && actual.length === expected.length;
}

function isValidTelegramWebhookSecret(secret: string) {
  return /^[A-Za-z0-9_-]{1,256}$/.test(secret);
}

function revisionedWebAppUrl(value: string) {
  const revision = String(process.env.APP_REVISION || '').trim().slice(0, 12);
  if (!value || !revision || process.env.NODE_ENV !== 'production') return value;
  const url = new URL(value);
  url.searchParams.set('v', revision);
  return url.toString();
}

function configuredWebAppUrl() {
  if (resolvedWebAppUrl !== undefined) return resolvedWebAppUrl;
  const configured = String(process.env.WEBAPP_URL || '').trim().replace(/\/$/, '');
  if (!configured) {
    resolvedWebAppUrl = revisionedWebAppUrl(process.env.NODE_ENV === 'production' ? PRODUCTION_WEBAPP_URL : '');
    return resolvedWebAppUrl;
  }
  try {
    const url = new URL(configured);
    if (process.env.NODE_ENV === 'production' && TEMPORARY_TUNNEL_HOST.test(url.hostname)) {
      console.warn(`Temporary WEBAPP_URL ${url.hostname} is not allowed in production; using ${PRODUCTION_WEBAPP_URL}.`);
      resolvedWebAppUrl = revisionedWebAppUrl(PRODUCTION_WEBAPP_URL);
      return resolvedWebAppUrl;
    }
  } catch {
    console.warn('WEBAPP_URL is invalid; Mini App button was disabled.');
    resolvedWebAppUrl = '';
    return resolvedWebAppUrl;
  }
  resolvedWebAppUrl = revisionedWebAppUrl(configured);
  return resolvedWebAppUrl;
}

const DEFAULT_FACULTIES: Faculty[] = ['КТУ', 'НОЖ', 'ТИНТ', 'ФТМФ', 'ФТМИ'].map((name) => ({
  id: 'fac_' + name.toLowerCase(),
  name,
}));

function createEmptyState(): SimulationState {
  return {
    users: [],
    faculties: [...DEFAULT_FACULTIES],
    facultyCompetencies: [],
    competencies: [],
    availabilities: {},
    meetings: [],
    events: [],
    tasks: [],
    messages: {},
    settings: { availabilityWeekCount: 2 },
  };
}

function getAdminTelegramIds() {
  return (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isEnvAdmin(telegramId: string | number) {
  return getAdminTelegramIds().includes(String(telegramId));
}

function isFacultyUser(user?: User) {
  return user?.role === 'faculty_responsible' || user?.role === 'faculty_helper';
}

function birthdayDayMonth(value?: string) {
  const birthday = String(value || '').trim();
  const shortDate = birthday.match(/^(\d{2})\.(\d{2})(?:\.\d{4})?$/);
  if (shortDate) return `${shortDate[1]}.${shortDate[2]}`;
  const isoDate = birthday.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return isoDate ? `${isoDate[2]}.${isoDate[1]}` : '';
}

function clientUser(user: User, viewer: User): User {
  const isAdmin = viewer.role === 'admin';
  const isSelf = user.id === viewer.id;
  return {
    id: user.id,
    username: user.username,
    realName: user.realName,
    role: user.role,
    avatarSeed: user.avatarSeed,
    ...(user.avatarDataUrl ? { avatarDataUrl: user.avatarDataUrl } : {}),
    birthday: isAdmin || isSelf ? user.birthday || '' : birthdayDayMonth(user.birthday),
    registered: Boolean(user.registered),
    competencies: [...(user.competencies || [])],
    primaryCompetency: user.primaryCompetency || '',
    facultyId: user.facultyId || '',
    active: isUserActive(user),
    ...(isAdmin && user.deactivatedAt ? { deactivatedAt: user.deactivatedAt, deactivatedBy: user.deactivatedBy } : {}),
    ...(isAdmin && user.lastSeenAt ? { lastSeenAt: user.lastSeenAt } : {}),
  };
}

function coreMeetingClientView(meeting: Meeting): Meeting {
  return {
    id: meeting.id,
    title: meeting.title,
    kind: meeting.kind,
    eventId: meeting.eventId,
    type: meeting.type,
    date: meeting.date,
    time: meeting.time,
    duration: meeting.duration,
    hostId: meeting.hostId,
    participants: meeting.participants,
    audiencePolicy: meeting.audiencePolicy,
    audienceUserIds: meeting.audienceUserIds,
    attendeeIds: meeting.attendeeIds,
    rsvpByUser: meeting.rsvpByUser,
    competency: meeting.competency,
    topic: meeting.topic,
    description: meeting.description,
    status: meeting.status,
  };
}

function coreTaskClientView(task: Task): Task {
  return {
    id: task.id,
    version: task.version,
    title: task.title,
    description: task.description,
    deadline: task.deadline,
    assignedTo: task.assignedTo,
    creatorId: task.creatorId,
    competency: task.competency,
    competencies: task.competencies,
    sow: task.sow,
    tips: task.tips,
    status: task.status,
    priority: task.priority,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    assignmentMode: task.assignmentMode || 'shared',
    completedBy: task.completedBy,
    cancelledAt: task.cancelledAt,
    cancelledBy: task.cancelledBy,
    timeSpentMinutes: task.timeSpentMinutes,
    facultyId: task.facultyId,
    eventId: task.eventId,
    reminders: task.reminders?.map((reminder) => ({
      id: reminder.id,
      type: reminder.type,
      value: reminder.value,
      unit: reminder.unit,
    })),
    assigneeNotes: task.assigneeNotes,
    completionComments: task.completionComments,
  };
}

function coreClientState(state: SimulationState, viewer: User): SimulationState {
  const coreUserIds = new Set(state.users.filter((user) => !isFacultyUser(user) && isUserActive(user)).map((user) => user.id));
  const availabilities = Object.fromEntries(
    Object.entries(state.availabilities).filter(([userId]) => coreUserIds.has(userId)),
  );
  const settings = state.settings || {};
  return {
    users: state.users.map((user) => clientUser(user, viewer)),
    faculties: [...(state.faculties || [])],
    facultyCompetencies: [...(state.facultyCompetencies || [])],
    competencies: [...(state.competencies || [])],
    availabilities,
    meetings: state.meetings.map(coreMeetingClientView),
    events: (state.events || []).map((event) => ({
      id: event.id,
      name: event.name,
      description: event.description,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      status: event.status,
      createdAt: event.createdAt,
      createdBy: event.createdBy,
    })),
    tasks: state.tasks.map(coreTaskClientView),
    messages: { [viewer.id]: state.messages[viewer.id] || [] },
    settings: {
      availabilityWeekCount: settings.availabilityWeekCount,
      availabilityActiveDays: settings.availabilityActiveDays,
      availabilityStartHour: settings.availabilityStartHour,
      availabilityEndHour: settings.availabilityEndHour,
      availabilityWeekNames: settings.availabilityWeekNames,
      availabilityWeekDescriptions: settings.availabilityWeekDescriptions,
      availabilityWeekMetadata: settings.availabilityWeekMetadata,
      availabilityWeekStart: settings.availabilityWeekStart,
      notificationDeliverySummary: viewer.role === 'admin'
        ? notificationDeliverySummary(settings.notificationDeliveries || [])
        : undefined,
    },
  };
}

function facultyTaskClientView(task: Task, viewerId: string): Task {
  return {
    id: task.id,
    version: task.version,
    title: task.title,
    description: task.description,
    deadline: task.deadline,
    assignedTo: [viewerId],
    creatorId: task.creatorId,
    competency: task.competency,
    competencies: task.competencies,
    sow: task.sow,
    tips: task.tips,
    status: task.status,
    priority: task.priority,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    assignmentMode: task.assignmentMode || 'shared',
    completedBy: task.completedBy,
    cancelledAt: task.cancelledAt,
    timeSpentMinutes: task.timeSpentMinutes,
    facultyId: task.facultyId,
    eventId: task.eventId,
    assigneeNotes: task.assigneeNotes?.[viewerId] ? { [viewerId]: task.assigneeNotes[viewerId] } : {},
    completionComments: task.completionComments?.[viewerId] ? { [viewerId]: task.completionComments[viewerId] } : {},
  };
}

function findUserByTelegramIdentity(state: SimulationState, telegramId: string | number, username?: string) {
  const id = String(telegramId);
  const normalizedUsername = (username || '').replace(/^@/, '').toLowerCase();
  const usersByTelegramId = state.users.filter((user) => isUserActive(user) && user.telegramId === id);
  if (usersByTelegramId.length === 1) return usersByTelegramId[0];
  if (usersByTelegramId.length > 1) return undefined;
  if (!normalizedUsername) return undefined;
  const usersByUsername = state.users.filter((user) => (
    isUserActive(user)
    &&
    !user.telegramId
    && user.username.replace(/^@/, '').toLowerCase() === normalizedUsername
  ));
  return usersByUsername.length === 1 ? usersByUsername[0] : undefined;
}

function ensureEnvAdminUser(state: SimulationState, telegramId: string | number, username?: string, realName?: string) {
  if (!isEnvAdmin(telegramId)) return undefined;
  const id = String(telegramId);
  const normalizedUsername = username ? `@${username.replace(/^@/, '')}` : `@tg${id}`;
  let user = findUserByTelegramIdentity(state, id, username);

  if (!user) {
    if (state.users.some((candidate) => candidate.telegramId === id)) return undefined;
    user = {
      id: `u_${crypto.randomUUID()}`,
      username: normalizedUsername,
      realName: realName || username || `Telegram ${id}`,
      role: 'admin',
      avatarSeed: username || id,
      birthday: '',
      telegramId: id,
      registered: true,
      competencies: [],
      primaryCompetency: '',
      facultyId: '',
      joinedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    state.users.push(user);
    return user;
  }

  user.telegramId = id;
  user.username = normalizedUsername;
  user.role = 'admin';
  user.registered = true;
  if (!user.realName && realName) user.realName = realName;
  return user;
}

type VerifiedTelegramUser = {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
};

function optionalTelegramString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function verifyTelegramInitData(initData: string, botToken?: string): VerifiedTelegramUser | undefined {
  if (!botToken || !initData) return undefined;
  const params = new URLSearchParams(initData);
  const seenKeys = new Set<string>();
  for (const [key] of params.entries()) {
    if (seenKeys.has(key)) return undefined;
    seenKeys.add(key);
  }
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return undefined;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(calculated, 'hex'), Buffer.from(hash, 'hex'))) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const authDateText = params.get('auth_date');
  if (!authDateText || !/^\d+$/.test(authDateText)) return undefined;
  const authDate = Number(authDateText);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return undefined;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (authDate < nowSeconds - 5 * 60 || authDate > nowSeconds + 30) return undefined;

  const rawUser = params.get('user');
  if (!rawUser) return undefined;
  try {
    const parsed: unknown = JSON.parse(rawUser);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const telegramUser = parsed as Record<string, unknown>;
    if (typeof telegramUser.id !== 'number'
      || !Number.isSafeInteger(telegramUser.id)
      || telegramUser.id <= 0) {
      return undefined;
    }
    if (telegramUser.username !== undefined && typeof telegramUser.username !== 'string') return undefined;
    if (telegramUser.first_name !== undefined && typeof telegramUser.first_name !== 'string') return undefined;
    if (telegramUser.last_name !== undefined && typeof telegramUser.last_name !== 'string') return undefined;
    return {
      id: String(telegramUser.id),
      username: optionalTelegramString(telegramUser.username),
      firstName: optionalTelegramString(telegramUser.first_name),
      lastName: optionalTelegramString(telegramUser.last_name),
    };
  } catch {
    return undefined;
  }
}

function sessionTokenHash(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function loadSessionStore() {
  if (sessionStoreCache) return sessionStoreCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as { sessions?: unknown[] };
    sessionStoreCache = (Array.isArray(parsed.sessions) ? parsed.sessions : [])
      .filter((item): item is StoredSession => Boolean(
        item && typeof item === 'object'
        && typeof (item as StoredSession).tokenHash === 'string'
        && /^[a-f0-9]{64}$/.test((item as StoredSession).tokenHash)
        && typeof (item as StoredSession).userId === 'string'
        && Number.isSafeInteger((item as StoredSession).createdAt)
        && Number.isSafeInteger((item as StoredSession).expiresAt),
      ));
  } catch (error) {
    if (fs.existsSync(SESSION_FILE)) console.error('Failed to read session registry; existing sessions were invalidated:', error);
    sessionStoreCache = [];
  }
  return sessionStoreCache;
}

function saveSessionStore(sessions: StoredSession[]) {
  sessionStoreCache = sessions;
  const temporaryFile = `${SESSION_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify({ version: 1, sessions }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, SESSION_FILE);
  } catch (error) {
    try {
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    } catch {
      // The registry write error is the useful one.
    }
    throw error;
  }
}

function pruneExpiredSessions(now = Date.now()) {
  const sessions = loadSessionStore();
  const active = sessions.filter((session) => session.expiresAt > now);
  if (active.length !== sessions.length) saveSessionStore(active);
  return active;
}

function createSessionToken(userId: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return '';
  const sessionId = crypto.randomBytes(32).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
  const token = `${sessionId}.${signature}`;
  const now = Date.now();
  const sessions = pruneExpiredSessions(now).filter((session) => session.userId !== userId);
  sessions.push({ tokenHash: sessionTokenHash(token), userId, createdAt: now, expiresAt: now + SESSION_MAX_AGE_MS });
  saveSessionStore(sessions);
  return token;
}

function verifySessionToken(token?: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 2) return undefined;
  const [sessionId, signature] = parts;
  if (!sessionId || !signature) return undefined;
  const expected = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
  if (!constantTimeSecretEquals(signature, expected)) return undefined;
  const tokenHash = sessionTokenHash(token);
  const session = pruneExpiredSessions().find((candidate) => candidate.tokenHash === tokenHash);
  return session ? { userId: session.userId, tokenHash } : undefined;
}

function revokeSessionToken(token?: string) {
  if (!token) return;
  const tokenHash = sessionTokenHash(token);
  const sessions = loadSessionStore();
  const remaining = sessions.filter((session) => session.tokenHash !== tokenHash);
  if (remaining.length !== sessions.length) saveSessionStore(remaining);
}

function revokeUserSessions(userId: string) {
  const sessions = loadSessionStore();
  const remaining = sessions.filter((session) => session.userId !== userId);
  if (remaining.length !== sessions.length) saveSessionStore(remaining);
}

function cookieValue(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return '';
  const entry = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

function formatShortDate(value?: string) {
  if (!value) return '';
  if (/^\d{2}\.\d{2}(?:\.\d{2}|\.\d{4})?$/.test(value)) return value;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}.${match[2]}.${match[1].slice(2)}`;
  return value;
}

function formatMeetingDate(value?: string) {
  const formatted = formatShortDate(value);
  const match = formatted.match(/^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/);
  if (!match) return formatted;
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const date = new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[1])));
  const weekdays = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  return `${weekdays[date.getUTCDay()]}, ${formatted}`;
}

function ageOnBirthday(value: string | undefined, year = projectClock().year) {
  const parts = birthdayParts(value);
  return parts?.year ? year - parts.year : null;
}

function formatBirthday(value?: string) {
  const parts = birthdayParts(value);
  if (!parts) return 'не указана';
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}${parts.year ? `.${parts.year}` : ''}`;
}

function daysUntilBirthday(value?: string, from = new Date()) {
  const parts = birthdayParts(value);
  if (!parts) return null;
  const clock = projectClock(from);
  const today = new Date(Date.UTC(clock.year, clock.month - 1, clock.day));
  let target = new Date(Date.UTC(clock.year, parts.month - 1, parts.day));
  if (target < today) target = new Date(Date.UTC(clock.year + 1, parts.month - 1, parts.day));
  return Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

function parseShortDate(value?: string) {
  return projectDateDeadlineInstant(value);
}

function isRegistrationPrompt(text: string) {
  const normalized = text.trim().toLowerCase();
  return normalized.startsWith('/register') || normalized === 'регистрация' || normalized === 'профиль';
}

function isOpenAppText(text: string) {
  const normalized = text.trim().toLowerCase();
  return normalized === 'открыть приложение' || normalized === 'mini app' || normalized === 'мини-приложение';
}

function assignedIds(task: Task) {
  return task.assignedTo || [];
}

function parseMeetingChatDate(value?: string) {
  const input = String(value || '').trim().toLowerCase();
  const todayIso = moscowClock(new Date()).dateKey;
  const relativeDays = input === 'сегодня' ? 0 : input === 'завтра' ? 1 : input === 'послезавтра' ? 2 : null;
  if (relativeDays !== null) {
    const date = new Date(`${todayIso}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + relativeDays);
    return `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}.${String(date.getUTCFullYear()).slice(2)}`;
  }
  const match = input.match(/^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2}|\d{4}))?$/);
  if (!match) return null;
  const nowYear = Number(todayIso.slice(0, 4));
  const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : nowYear;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${String(year).slice(2)}`;
}

function parseMeetingChatTime(value?: string) {
  const match = String(value || '').trim().match(/^(\d{1,2})(?:[:.\s](\d{1,2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function taskCompetencyNames(task: Task) {
  return task.competencies?.length ? task.competencies : task.competency ? [task.competency] : [];
}

function userMention(user?: User) {
  if (!user) return 'не указан';
  return `${user.realName} (${user.username})`;
}

function taskPriorityLabel(priority?: Task['priority']) {
  if (priority === 'critical') return 'очень важная';
  if (priority === 'important') return 'важная';
  return 'обычная';
}

function taskDurationLabel(minutes?: number) {
  if (!minutes) return '';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} ч` : '', rest ? `${rest} мин` : ''].filter(Boolean).join(' ');
}

function taskDetailsText(task: Task, state: SimulationState) {
  const creator = state.users.find((user) => user.id === task.creatorId);
  const workEvent = state.events?.find((item) => item.id === task.eventId);
  const executors = assignedIds(task)
    .map((id) => state.users.find((user) => user.id === id))
    .filter(Boolean) as User[];
  const executorText = task.status === 'open'
    ? 'открытая задача'
    : executors.length
      ? executors.map(userMention).join(', ')
      : 'не указан';

  const progressNotes = assignedIds(task).flatMap((id) => {
    const note = task.assigneeNotes?.[id];
    if (note?.history?.length) return note.history.map((comment) => {
      const author = state.users.find((user) => user.id === comment.authorId);
      return `• ${author?.realName || 'Участник'}: ${comment.text}`;
    });
    const assignee = state.users.find((user) => user.id === id);
    if (!note?.executor && !note?.coordinator) return [];
    return [`• ${assignee?.realName || 'Исполнитель'}${note.executor ? `: ${note.executor}` : ''}${note.coordinator ? `\n  Координатор: ${note.coordinator}` : ''}`];
  });
  const completionNotes = Object.entries(task.completionComments || {})
    .filter(([, comment]) => String(comment || '').trim())
    .map(([id, comment]) => `• ${state.users.find((user) => user.id === id)?.realName || 'Исполнитель'}: ${comment}`);
  const completedBy = state.users.find((user) => user.id === task.completedBy);
  return `*${task.title}*\n\n${task.description}\n\n*Мероприятие:* ${workEvent?.name || 'без мероприятия'}\n*Блоки:* ${taskCompetencyNames(task).join(', ') || 'не указаны'}\n*Приоритет:* ${taskPriorityLabel(task.priority)}\n*Автор:* ${userMention(creator)}\n*Срок:* ${formatShortDate(task.deadline)}\n*Исполнитель:* ${executorText}${task.status === 'completed' && completedBy ? `\n*Завершил:* ${userMention(completedBy)}` : ''}${task.timeSpentMinutes ? `\n*Затрачено:* ${taskDurationLabel(task.timeSpentMinutes)}` : ''}${task.sow ? `\n\n*ТЗ:* ${task.sow}` : ''}${progressNotes.length ? `\n\n*Комментарии по работе:*\n${progressNotes.join('\n')}` : ''}${completionNotes.length ? `\n\n*Комментарий при завершении:*\n${completionNotes.join('\n')}` : ''}${task.tips?.length ? `\n\n*Подсказки:*\n${task.tips.map((tip) => `• ${tip}`).join('\n')}` : ''}`;
}

function meetingDetailsText(meeting: Meeting, state: SimulationState) {
  const host = state.users.find((user) => user.id === meeting.hostId);
  const workEvent = (state.events || []).find((item) => item.id === meeting.eventId);
  const isSetup = meeting.kind === 'setup';
  const durationMinutes = Math.round(Number(meeting.duration || 1) * 60);
  return `*${meeting.title}*\n\n*Тип:* ${meetingKindText(meeting.kind).label}\n${isSetup ? `*Мероприятие:* ${workEvent?.name || 'не указано'}\n` : ''}*Дата:* ${formatMeetingDate(meeting.date)}\n*Время:* ${meeting.time}\n*Длительность:* ${taskDurationLabel(durationMinutes)}\n*Организатор:* ${userMention(host)}${meeting.competency ? `\n*Блок:* ${meeting.competency}` : ''}${meeting.topic ? `\n*Тема:* ${meeting.topic}` : ''}${meeting.description ? `\n*Описание:* ${meeting.description}` : ''}`;
}

function meetingUpdateText(before: Meeting, after: Meeting, state: SimulationState) {
  const changes: string[] = [];
  const value = (input?: string) => String(input || '').trim() || 'не указано';
  const participantKey = (meeting: Meeting) => meeting.audiencePolicy === 'snapshot'
    ? [...(meeting.audienceUserIds || [])].sort().join('|')
    : meeting.participants === 'all'
      ? 'all'
      : [...meeting.participants].sort().join('|');
  if (before.title !== after.title) changes.push(`❗Название: ${value(before.title)} → ${value(after.title)}`);
  if ((before.kind || 'meeting') !== (after.kind || 'meeting')) changes.push(`❗Тип: ${meetingKindText(before.kind).label} → ${meetingKindText(after.kind).label}`);
  if (value(before.eventId) !== value(after.eventId)) {
    const beforeEvent = state.events?.find((item) => item.id === before.eventId)?.name;
    const afterEvent = state.events?.find((item) => item.id === after.eventId)?.name;
    changes.push(`❗Мероприятие: ${value(beforeEvent)} → ${value(afterEvent)}`);
  }
  if (before.date !== after.date) changes.push(`❗Дата: ${formatMeetingDate(before.date)} → ${formatMeetingDate(after.date)}`);
  if (before.time !== after.time) changes.push(`❗Время: ${value(before.time)} → ${value(after.time)}`);
  if (Number(before.duration || 1) !== Number(after.duration || 1)) {
    changes.push(`❗Длительность: ${taskDurationLabel(Math.round(Number(before.duration || 1) * 60))} → ${taskDurationLabel(Math.round(Number(after.duration || 1) * 60))}`);
  }
  if (before.type !== after.type) changes.push('❗Формат встречи изменён');
  if (participantKey(before) !== participantKey(after)) changes.push('❗Состав приглашённых изменён');
  if (value(before.competency) !== value(after.competency)) changes.push(`❗Блок: ${value(before.competency)} → ${value(after.competency)}`);
  if (value(before.topic) !== value(after.topic)) changes.push(`❗Тема: ${value(before.topic)} → ${value(after.topic)}`);
  if (value(before.description) !== value(after.description)) {
    changes.push(`❗Описание:\nБыло: ${value(before.description)}\nСтало: ${value(after.description)}`);
  }
  const details = meetingDetailsText(after, state).replace(/^\*[^\n]+\*\n\n/, '');
  return `${meetingKindText(after.kind).updated}: *${after.title}*\n${details}\n\n*Что изменилось:*\n${changes.join('\n')}`;
}

function meetingRsvpButtons(meeting: Meeting, userId: string) {
  const response = meetingRsvpFor(meeting, userId);
  return [
    { text: response === 'yes' ? '✅ Приду · выбрано' : '✅ Приду', action: `meeting_rsvp:${meeting.id}:yes` },
    { text: response === 'no' ? '❌ Не приду · выбрано' : '❌ Не приду', action: `meeting_rsvp:${meeting.id}:no` },
    ...(response === 'unanswered' ? [] : [{ text: 'Сбросить ответ', action: `meeting_rsvp:${meeting.id}:unanswered` }]),
    { text: 'Открыть встречи', action: 'open_meetings' },
  ];
}

function roleLabel(role: User['role']) {
  if (role === 'admin') return 'администратор';
  if (role === 'organizer') return 'организатор';
  if (role === 'faculty_responsible') return 'ответственный факультета';
  return 'помощник факультета';
}

function profileSummaryText(user: User, state: SimulationState) {
  const activeTasks = state.tasks.filter((task) => assignedIds(task).includes(user.id) && !['completed', 'cancelled'].includes(task.status));
  const completedTasks = state.tasks.filter((task) => assignedIds(task).includes(user.id) && task.status === 'completed');
  const upcomingMeetings = state.meetings
    .filter((meeting) => (
      meeting.status === 'scheduled'
      && resolveMeetingAudienceUsers(state.users, meeting).some((member) => member.id === user.id)
      && meetingPhase(meeting) !== 'past'
    ))
    .slice()
    .sort((a, b) => {
      const phaseOrder = Number(meetingPhase(a) !== 'ongoing') - Number(meetingPhase(b) !== 'ongoing');
      return phaseOrder || meetingStartTimestamp(a) - meetingStartTimestamp(b);
    });
  const availability = alignedAvailabilitySlots(state.availabilities[user.id]);
  const availableHours = Array.from({ length: 7 }, (_, dayIndex) => availability[dayIndex] || [])
    .reduce((sum, hours) => sum + hours.length, 0);
  const nextMeeting = upcomingMeetings[0];
  const birthdayCountdown = daysUntilBirthday(user.birthday);
  const birthdayAge = ageOnBirthday(user.birthday);

  return `*${user.realName}*\n${user.username} · ${roleLabel(user.role)}`
    + `\n\n*Главный блок:* ${user.primaryCompetency || 'не выбран'}`
    + `\n*Дата рождения:* ${formatBirthday(user.birthday)}${birthdayAge !== null ? ` · ${birthdayAge} лет` : ''}`
    + `${birthdayCountdown !== null ? `\n*До дня рождения:* ${birthdayCountdown === 0 ? 'сегодня' : `${birthdayCountdown} дн.`}` : ''}`
    + `\n\n*Сейчас:*`
    + `\n• активных задач — ${activeTasks.length}`
    + `\n• выполнено задач — ${completedTasks.length}`
    + `\n• ближайших встреч — ${upcomingMeetings.length}`
    + `\n• свободных часов отмечено — ${availableHours}`
    + `${nextMeeting ? `\n\n*Следующая встреча:* ${formatShortDate(nextMeeting.date)}, ${nextMeeting.time} — ${nextMeeting.title}` : ''}`;
}

function slotsSummaryText(user: User, state: SimulationState, overrideSlots?: Record<number, number[]>, weekIndex = 0) {
  const availability = overrideSlots || alignedAvailabilitySlots(state.availabilities[user.id]);
  const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const { activeDays } = normalizeAvailabilityConfig(state.settings);
  const rows = activeDays.map((dayOffset) => {
    const hours = availability[weekIndex * 7 + dayOffset] || [];
    return `${dayNames[dayOffset]}: ${hours.length ? hours.map((hour) => `${hour}:00`).join(', ') : '—'}`;
  });
  return `*Мои слоты на эту неделю*\n\n${rows.join('\n')}`;
}

function meetingsSummaryText(user: User, state: SimulationState) {
  const meetings = state.meetings
    .filter((meeting) => (
      meeting.status === 'scheduled'
      && meetingPhase(meeting) !== 'past'
    ))
    .slice()
    .sort((a, b) => {
      const phaseOrder = Number(meetingPhase(a) !== 'ongoing') - Number(meetingPhase(b) !== 'ongoing');
      return phaseOrder || meetingStartTimestamp(a) - meetingStartTimestamp(b);
    })
    .slice(0, 8);
  if (!meetings.length) return '*Встречи*\n\nБлижайших встреч нет.';
  return `*Ближайшие встречи*\n\n${meetings.map((meeting, index) => (
    `${index + 1}. *${meeting.title}*\n${formatShortDate(meeting.date)}, ${meeting.time}`
      + `${meeting.topic ? `\n${meeting.topic}` : ''}`
  )).join('\n\n')}`;
}

function tasksSummaryText(user: User, state: SimulationState) {
  const myTasks = state.tasks.filter((task) => assignedIds(task).includes(user.id) && !['completed', 'cancelled'].includes(task.status));
  const openTasks = state.tasks.filter((task) => task.status === 'open');
  const personal = myTasks.length
    ? myTasks.slice(0, 8).map((task, index) => (
        `${index + 1}. *${task.title}* · ${taskStatusLabel(task.status)}\nДедлайн: ${formatShortDate(task.deadline) || 'не указан'}`
      )).join('\n\n')
    : 'Активных задач нет.';
  return `*Мои задачи*\n\n${personal}\n\n*Свободных задач на доске:* ${openTasks.length}`;
}

function teamSummaryText(state: SimulationState) {
  const users = state.users.filter((user) => !isFacultyUser(user) && isUserActive(user));
  const registered = users.filter((user) => user.registered).length;
  return `*Команда · ${users.length}*\nВ боте: ${registered}/${users.length}\n\n`
    + users.slice(0, 12).map((user) => `• ${user.realName} · ${user.primaryCompetency || 'без блока'} · ${user.username}`).join('\n');
}

function facultiesSummaryText(state: SimulationState) {
  const faculties = state.faculties || [];
  const activeTasks = state.tasks.filter((task) => task.facultyId && !['completed', 'cancelled'].includes(task.status));
  return `*МФ · факультеты*\n\n${faculties.map((faculty) => {
    const people = state.users.filter((user) => user.facultyId === faculty.id).length;
    const tasks = activeTasks.filter((task) => task.facultyId === faculty.id).length;
    return `• ${faculty.name}: ${people} чел., ${tasks} активных задач`;
  }).join('\n') || 'Факультеты ещё не добавлены.'}`;
}

function nextShortDate(daysAhead = 1) {
  const target = new Date();
  target.setDate(target.getDate() + daysAhead);
  return `${String(target.getDate()).padStart(2, '0')}.${String(target.getMonth() + 1).padStart(2, '0')}.${String(target.getFullYear()).slice(2)}`;
}

function currentWeekStartIso() {
  return currentMoscowWeekStart();
}

function alignedAvailabilitySlots(availability?: Availability) {
  return alignAvailabilityToWeek(availability).slots;
}

function alignedHardUnavailableDays(availability?: Availability) {
  return alignAvailabilityToWeek(availability).hardUnavailableDays;
}

function slotWeekRange(weekIndex: number) {
  const start = new Date(`${currentWeekStartIso()}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() + weekIndex * 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const short = (date: Date) => `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${short(start)}–${short(end)}`;
}

function alignedOutWeekIndexes(availability?: Availability) {
  return alignAvailabilityToWeek(availability).outWeekIndexes;
}

function isOutForWeek(availability: Availability | undefined, weekIndex = 0) {
  return alignedOutWeekIndexes(availability).includes(weekIndex);
}

function hasSubmittedAvailabilityForWeek(availability: Availability | undefined, settings: SimulationState['settings'], weekIndex = 0) {
  if (!availability) return false;
  if (isOutForWeek(availability, weekIndex)) return true;
  const slots = alignedAvailabilitySlots(availability);
  const unavailableDays = new Set(alignedHardUnavailableDays(availability));
  const firstDay = weekIndex * 7;
  return normalizeAvailabilityConfig(settings).activeDays.map((dayOffset) => firstDay + dayOffset).every((dayIndex) => (
    (slots[dayIndex] || []).length > 0 || unavailableDays.has(dayIndex)
  ));
}

function formatDateTimeShort(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getFullYear()).slice(2)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderTelegramHtml(text: string) {
  return escapeHtml(text)
    .replace(/\[\[tg:(\d+)\|([^\]\n]+)\]\]/g, '<a href="tg://user?id=$1">$2</a>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
}

function telegramCommandSlug(value: string) {
  const normalized = value.trim().toLowerCase();
  const knownAliases: Array<[RegExp, string]> = [
    [/^(?:partners?|партн[её]ры|партн[её]рка|партн[её]рство)$/i, 'partners'],
    [/^(?:sound|audio|звук)$/i, 'sound'],
    [/^(?:design|дизайн)$/i, 'design'],
    [/^(?:production|продакшн)$/i, 'production'],
    [/^(?:smm|смм)$/i, 'smm'],
  ];
  const known = knownAliases.find(([pattern]) => pattern.test(normalized));
  if (known) return known[1];
  const transliteration: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  return [...normalized]
    .map((character) => transliteration[character] ?? character)
    .join('')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 27) || 'block';
}

function taskStatusLabel(status: Task['status']) {
  if (status === 'cancelled') return 'Отменена';
  if (status === 'completed') return 'Выполнена';
  if (status === 'in_progress') return 'В работе';
  if (status === 'waiting') return 'Ждет';
  if (status === 'assigned') return 'В работе';
  return 'Открытая';
}

function parseFacultyTaskStatus(text: string): Task['status'] | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === 'ждет' || normalized === 'ждёт') return 'waiting';
  if (normalized === 'в работе') return 'in_progress';
  if (normalized === 'выполнено' || normalized === 'выполнена') return 'completed';
  return null;
}

function loadDatabase(): SimulationState {
  if (databaseStateCache) {
    if (databaseStateCache.settings?.availabilityWeekStart !== currentWeekStartIso()) {
      saveDatabase(structuredClone(databaseStateCache));
    }
    return structuredClone(databaseStateCache);
  }
  if (DATABASE_SHEETS_CONFIG?.enabled) throw new Error('Google Sheets database has not finished loading');
  let state: SimulationState;
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf-8');
      state = JSON.parse(data);
    } else {
      state = createEmptyState();
    }
  } catch (error) {
    console.error('Error reading database file, using defaults:', error);
    state = createEmptyState();
  }

  const cleanState = sanitizeSimulationState(state);
  DEFAULT_FACULTIES.forEach((faculty) => {
    if (!cleanState.faculties!.some((item) => item.id === faculty.id || item.name === faculty.name)) {
      cleanState.faculties!.push(faculty);
    }
  });
  databaseStateCache = cleanState;
  runtimeOperations.lastPersistenceSuccessAt ||= new Date().toISOString();
  if (JSON.stringify(state) !== JSON.stringify(cleanState)) saveDatabase(cleanState);
  return structuredClone(databaseStateCache);
}

function saveDatabase(state: SimulationState, options: { changedMeetingIds?: Iterable<string> } = {}) {
  const previousCache = databaseStateCache ? structuredClone(databaseStateCache) : null;
  const cleanState = sanitizeSimulationState(state);
  const orphanReferences = findOrphanUserReferences(cleanState);
  if (orphanReferences.length) {
    console.error('Database contains orphan user references:', JSON.stringify(orphanReferences));
  }
  if (DATABASE_SHEETS_CONFIG?.enabled) {
    cleanState.settings ||= {};
    const incomingRevision = Math.max(0, Number(cleanState.settings.databaseRevision || 0));
    const currentRevision = Math.max(0, Number(databaseStateCache?.settings?.databaseRevision || 0));
    if (databaseStateCache && currentRevision > incomingRevision) {
      // Async requests may save stale clones after another request has committed.
      // Preserve every meeting except the records explicitly changed by this save.
      const changedMeetingIds = new Set(options.changedMeetingIds || []);
      const incomingMeetings = new Map(cleanState.meetings.map((meeting) => [meeting.id, meeting]));
      const mergedMeetings = databaseStateCache.meetings.map((currentMeeting) => (
        changedMeetingIds.has(currentMeeting.id)
          ? incomingMeetings.get(currentMeeting.id) || currentMeeting
          : currentMeeting
      ));
      const mergedMeetingIds = new Set(mergedMeetings.map((meeting) => meeting.id));
      cleanState.meetings.forEach((meeting) => {
        if (!mergedMeetingIds.has(meeting.id)) mergedMeetings.push(meeting);
      });
      cleanState.meetings = mergedMeetings;
    }
    cleanState.settings.databaseRevision = Math.max(incomingRevision, currentRevision) + 1;
    try {
      writeDatabaseRecoveryRecord(DATABASE_RECOVERY_DIRECTORY, cleanState, DATABASE_RECOVERY_RETENTION);
      runtimeOperations.lastPersistenceSuccessAt = new Date().toISOString();
      runtimeOperations.lastPersistenceError = undefined;
    } catch (error) {
      runtimeOperations.lastPersistenceErrorAt = new Date().toISOString();
      runtimeOperations.lastPersistenceError = safeOperationalError(error);
      console.error('Database recovery journal write failed; mutation was not acknowledged:', error);
      return false;
    }
  }
  Object.keys(state).forEach((key) => delete (state as unknown as Record<string, unknown>)[key]);
  Object.assign(state, cleanState);
  databaseStateCache = structuredClone(state);
  if (DATABASE_SHEETS_CONFIG?.enabled) {
    scheduleDatabaseSheetsSnapshot(state);
    return true;
  }
  const saved = writeDatabaseFile(state);
  if (saved) {
    runtimeOperations.lastPersistenceSuccessAt = new Date().toISOString();
    runtimeOperations.lastPersistenceError = undefined;
  } else {
    runtimeOperations.lastPersistenceErrorAt = new Date().toISOString();
    runtimeOperations.lastPersistenceError = 'Local database file write failed';
    databaseStateCache = previousCache;
  }
  return saved;
}

function writeDatabaseFile(state: SimulationState) {
  const temporaryFile = `${DB_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(temporaryFile, DB_FILE);
    return true;
  } catch (error) {
    console.error('Error writing database file:', error);
    try {
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    } catch {
      // The original write error is the useful one.
    }
    return false;
  }
}

class DatabaseMutationError extends Error {
  constructor(public status: number, message: string, public fieldErrors?: Record<string, string>) {
    super(message);
  }
}

function validationErrorResponse(res: express.Response, fieldErrors: Record<string, string>, message = 'Проверь поля формы') {
  return res.status(400).json({
    error: message,
    message,
    fieldErrors,
    serverNow: new Date().toISOString(),
  });
}

function textFieldError(value: unknown, maximum: number, required = false) {
  if (typeof value !== 'string') return required || value !== undefined ? 'Ожидается строка' : '';
  const length = value.trim().length;
  if (required && !length) return 'Поле обязательно';
  if (length > maximum) return `Не больше ${maximum} символов`;
  return '';
}

function meetingPayloadFieldErrors(payload: Record<string, unknown>, now = new Date()) {
  const errors: Record<string, string> = {};
  const titleError = textFieldError(payload.title, 160, true);
  if (titleError) errors.title = titleError;
  const kind = String(payload.kind || 'meeting');
  if (!['meeting', 'setup', 'vibe'].includes(kind)) errors.kind = 'Неизвестный вид события';
  const type = String(payload.type || 'general');
  if (!['general', 'custom'].includes(type)) errors.type = 'Неизвестный тип аудитории';
  const date = String(payload.date || '');
  if (!parseProjectLocalDate(date)) errors.date = 'Укажи существующую календарную дату';
  const time = String(payload.time || '');
  if (!/^\d{2}:\d{2}$/.test(time) || !projectDateTimeInstant(date, time, now)) errors.time = 'Укажи время в формате ЧЧ:ММ';
  const duration = Number(payload.duration);
  if (!Number.isFinite(duration) || duration < 0.5 || duration > 6 || duration * 2 !== Math.round(duration * 2)) {
    errors.duration = 'От 30 минут до 6 часов с шагом 30 минут';
  }
  if (!errors.date && !errors.time && (projectDateTimeInstant(date, time, now)?.getTime() || 0) <= now.getTime()) {
    errors.date = 'Нельзя создать событие в прошлом';
  }
  for (const [field, maximum] of [['topic', 500], ['description', 4_000], ['competency', 200], ['eventId', 200]] as const) {
    const error = textFieldError(payload[field], maximum);
    if (error) errors[field] = error;
  }
  if (payload.participants !== 'all') {
    const error = idArrayFieldError(payload.participants);
    if (error) errors.participants = error;
  }
  return errors;
}

function taskPayloadFieldErrors(payload: Record<string, unknown>, requireCoreFields: boolean, now = new Date()) {
  const errors: Record<string, string> = {};
  if (requireCoreFields || payload.title !== undefined) {
    const error = textFieldError(payload.title, 160, true);
    if (error) errors.title = error;
  }
  if (requireCoreFields || payload.deadline !== undefined) {
    const deadline = String(payload.deadline || '');
    if (!parseProjectLocalDate(deadline)) errors.deadline = 'Укажи существующую календарную дату';
    else if (requireCoreFields && (projectDateDeadlineInstant(deadline, now)?.getTime() || 0) < now.getTime()) errors.deadline = 'Дедлайн уже прошёл';
  }
  for (const [field, maximum] of [['description', 4_000], ['sow', 8_000], ['eventId', 200], ['competency', 200]] as const) {
    if (payload[field] === undefined) continue;
    const error = textFieldError(payload[field], maximum);
    if (error) errors[field] = error;
  }
  if (payload.priority !== undefined && !['normal', 'important', 'critical'].includes(String(payload.priority))) {
    errors.priority = 'Неизвестный приоритет';
  }
  if (payload.assignedTo !== undefined) {
    const error = idArrayFieldError(payload.assignedTo);
    if (error) errors.assignedTo = error;
  }
  if (payload.competencies !== undefined) {
    const error = idArrayFieldError(payload.competencies, 50);
    if (error) errors.competencies = error;
  }
  if (payload.tips !== undefined) {
    if (!Array.isArray(payload.tips) || payload.tips.length > 50 || payload.tips.some((tip) => typeof tip !== 'string' || tip.length > 500)) {
      errors.tips = 'Не больше 50 подсказок по 500 символов';
    }
  }
  if (payload.reminders !== undefined) {
    if (!Array.isArray(payload.reminders) || payload.reminders.length > 20 || payload.reminders.some((item) => (
      !item || typeof item !== 'object'
      || !['before_deadline', 'repeat'].includes(String((item as any).type))
      || !['days', 'hours'].includes(String((item as any).unit))
      || !Number.isFinite(Number((item as any).value))
      || Number((item as any).value) <= 0
      || Number((item as any).value) > 365
    ))) errors.reminders = 'Проверь тип, единицу и значение напоминаний';
  }
  return errors;
}

function idArrayFieldError(value: unknown, maximumItems = 100) {
  if (!Array.isArray(value)) return 'Ожидается список';
  if (value.length > maximumItems) return `Не больше ${maximumItems} элементов`;
  if (value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 200)) return 'Список содержит некорректный идентификатор';
  return '';
}

function mutateDatabaseAtomically<T>(mutation: (state: SimulationState) => T) {
  // The callback must stay synchronous. Node executes this load/mutate/save
  // section without interleaving another request; network work belongs after it.
  const state = loadDatabase();
  const value = mutation(state);
  if (!saveDatabase(state)) {
    throw new DatabaseMutationError(503, 'Не удалось надёжно сохранить изменение. Повторите позже.');
  }
  return { state, value };
}

function databaseMutationErrorResponse(res: express.Response, error: unknown) {
  if (error instanceof DatabaseMutationError) {
    return res.status(error.status).json({
      error: error.message,
      message: error.message,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      serverNow: new Date().toISOString(),
    });
  }
  throw error;
}

function scheduleDatabaseSheetsSnapshot(state: SimulationState, delayMs = 500) {
  if (!DATABASE_SHEETS_CONFIG?.enabled) return;
  pendingDatabaseSheetsState = structuredClone(state);
  if (databaseSheetsFlushTimer || databaseSheetsFlushPromise) return;
  databaseSheetsFlushTimer = setTimeout(() => {
    databaseSheetsFlushTimer = null;
    void flushDatabaseSheetsSnapshots();
  }, delayMs);
}

async function flushDatabaseSheetsSnapshots() {
  if (!DATABASE_SHEETS_CONFIG?.enabled) return;
  if (databaseSheetsFlushPromise) return databaseSheetsFlushPromise;
  databaseSheetsFlushPromise = (async () => {
    while (pendingDatabaseSheetsState) {
      const snapshot = pendingDatabaseSheetsState;
      pendingDatabaseSheetsState = null;
      try {
        await exportStateToGoogleSheetsDatabase(DATABASE_SHEETS_CONFIG, snapshot, 'runtime_snapshot');
        lastDatabaseSheetsSyncedRevision = Math.max(
          lastDatabaseSheetsSyncedRevision,
          Number(snapshot.settings?.databaseRevision || 0),
        );
        runtimeOperations.lastReplicationSuccessAt = new Date().toISOString();
        runtimeOperations.lastReplicationError = undefined;
      } catch (error) {
        runtimeOperations.lastReplicationErrorAt = new Date().toISOString();
        runtimeOperations.lastReplicationError = safeOperationalError(error);
        console.error(
          `Google Sheets database snapshot failed; durable recovery revision ${Number(snapshot.settings?.databaseRevision || 0)} retained until retry:`,
          error,
        );
        pendingDatabaseSheetsState ||= snapshot;
        if (!isShuttingDown && !databaseSheetsFlushTimer) {
          databaseSheetsFlushTimer = setTimeout(() => {
            databaseSheetsFlushTimer = null;
            void flushDatabaseSheetsSnapshots();
          }, 5_000);
        }
        break;
      }
    }
  })().finally(() => {
    databaseSheetsFlushPromise = null;
    if (!isShuttingDown && pendingDatabaseSheetsState && !databaseSheetsFlushTimer) {
      scheduleDatabaseSheetsSnapshot(pendingDatabaseSheetsState);
    }
  });
  return databaseSheetsFlushPromise;
}

async function hydrateDatabaseFromGoogleSheets() {
  if (!DATABASE_SHEETS_CONFIG?.enabled) return;
  const recoveryRecord = readLatestDatabaseRecoveryRecord(DATABASE_RECOVERY_DIRECTORY);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const remote = await importStateFromGoogleSheetsDatabase(DATABASE_SHEETS_CONFIG);
      if (!remote.initialized || !remote.state) throw new Error('Google Sheets database has no complete snapshot');
      const remoteState = sanitizeSimulationState(remote.state);
      const remoteRevision = Math.max(0, Number(remote.revision || remoteState.settings?.databaseRevision || 0));
      lastDatabaseSheetsSyncedRevision = remoteRevision;
      runtimeOperations.lastPersistenceSuccessAt = new Date().toISOString();
      runtimeOperations.lastReplicationSuccessAt = new Date().toISOString();
      if (recoveryRecord && recoveryRecord.revision > remoteRevision) {
        databaseStateCache = sanitizeSimulationState(recoveryRecord.state);
        scheduleDatabaseSheetsSnapshot(databaseStateCache, 0);
        console.warn(
          `Recovered durable database revision ${recoveryRecord.revision}; Google Sheets revision ${remoteRevision} will be updated.`,
        );
      } else {
        databaseStateCache = remoteState;
        if (!recoveryRecord || recoveryRecord.revision !== remoteRevision) {
          writeDatabaseRecoveryRecord(DATABASE_RECOVERY_DIRECTORY, remoteState, DATABASE_RECOVERY_RETENTION);
        }
        console.log(`Google Sheets database loaded at revision ${remoteRevision}.`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 6) break;
      const retryDelayMs = attempt * 1_000;
      console.warn(`Google Sheets database snapshot is temporarily unavailable; retrying in ${retryDelayMs}ms (${attempt}/6).`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  if (recoveryRecord) {
    databaseStateCache = sanitizeSimulationState(recoveryRecord.state);
    scheduleDatabaseSheetsSnapshot(databaseStateCache, 0);
    console.warn(
      `Google Sheets database is unavailable; started from durable recovery revision ${recoveryRecord.revision}.`,
    );
    return;
  }
  throw lastError instanceof Error ? lastError : new Error('Google Sheets database has no complete snapshot');
}

function normalizeTaskReminders(value: unknown): TaskReminder[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item: any) => Number(item?.value) > 0)
    .slice(0, 3)
    .map((item: any, index) => ({
      id: String(item.id || `rem_${crypto.randomUUID()}`),
      type: item.type === 'repeat' ? 'repeat' : 'before_deadline',
      value: Math.max(1, Number(item.value) || 1),
      unit: item.unit === 'hours' ? 'hours' : 'days',
      sentAt: item.sentAt,
      lastSentAt: item.lastSentAt,
    }));
}

function pruneExpiredAvailabilityWeeks() {
  const changed = databaseStateCache?.settings?.availabilityWeekStart !== currentWeekStartIso();
  loadDatabase();
  return changed;
}

async function startServer() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_LOCAL_PREVIEW === 'true') {
    throw new Error('ALLOW_LOCAL_PREVIEW=true is forbidden in production');
  }
  const telegramUpdateMode = configuredTelegramUpdateMode();
  const telegramWebhookSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '');
  if (telegramUpdateMode === 'webhook' && !isValidTelegramWebhookSecret(telegramWebhookSecret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must contain 1-256 characters: A-Z, a-z, 0-9, _ or -');
  }
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (telegramUpdateMode === 'webhook' && telegramBotToken && telegramWebhookSecret === telegramBotToken) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must be independent from the Telegram bot token');
  }
  const sessionSecret = String(process.env.SESSION_SECRET || '');
  if (process.env.NODE_ENV === 'production' && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET with at least 32 characters is required in production');
  }
  if (telegramBotToken && sessionSecret === telegramBotToken) {
    throw new Error('SESSION_SECRET must be independent from the Telegram bot token');
  }
  await hydrateDatabaseFromGoogleSheets();
  pruneExpiredAvailabilityWeeks();
  const app = express();
  app.set('trust proxy', 'loopback');
  const sheetsConfig = googleSheetsConfigFromEnv();
  const calendarConfig = googleCalendarConfigFromEnv();
  const authWindowMs = positiveIntegerEnvironment('AUTH_RATE_LIMIT_WINDOW_MS', 5 * 60 * 1000);
  const authIpRateLimit = createFixedWindowRateLimiter(
    authWindowMs,
    positiveIntegerEnvironment('AUTH_RATE_LIMIT_IP_MAX', 30),
  );
  const authUserRateLimit = createFixedWindowRateLimiter(
    authWindowMs,
    positiveIntegerEnvironment('AUTH_RATE_LIMIT_USER_MAX', 10),
  );
  const broadcastWindowMs = positiveIntegerEnvironment('BROADCAST_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000);
  const broadcastRateLimit = createFixedWindowRateLimiter(
    broadcastWindowMs,
    positiveIntegerEnvironment('BROADCAST_RATE_LIMIT_MAX', 10),
  );
  const broadcastVolumeRateLimit = createFixedWindowRateLimiter(
    positiveIntegerEnvironment('BROADCAST_VOLUME_WINDOW_MS', 60 * 60 * 1000),
    positiveIntegerEnvironment('BROADCAST_VOLUME_MAX_RECIPIENTS', 500),
  );
  const pendingCalendarMeetingIds = new Set<string>();
  const idempotencyInFlight = new Map<string, Promise<void>>();
  const idempotencyResolvers = new Map<string, () => void>();
  let calendarReconciliationRunning = false;
  const processedSheetsEvents = new Set<string>();
  app.use((req, res, next) => {
    const incomingRequestId = String(req.get('X-Request-ID') || '').trim();
    const requestId = /^[A-Za-z0-9._:-]{8,128}$/.test(incomingRequestId) ? incomingRequestId : crypto.randomUUID();
    const incomingOperationId = String(req.get('Idempotency-Key') || '').trim();
    const operationId = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
      ? (/^[A-Za-z0-9._:-]{8,128}$/.test(incomingOperationId) ? incomingOperationId : crypto.randomUUID())
      : undefined;
    (req as express.Request & { requestId?: string; operationId?: string }).requestId = requestId;
    (req as express.Request & { requestId?: string; operationId?: string }).operationId = operationId;
    res.setHeader('X-Request-ID', requestId);
    if (operationId) res.setHeader('X-Operation-ID', operationId);
    const startedAt = Date.now();
    res.once('finish', () => {
      if (res.statusCode < 500) return;
      console.error(JSON.stringify({
        event: 'http_request_failed', requestId, operationId, method: req.method,
        path: req.path, status: res.statusCode, durationMs: Date.now() - startedAt,
      }));
    });
    next();
  });
  app.use('/api/telegram-webhook', (req, res, next) => {
    if (req.method !== 'POST' || telegramUpdateMode !== 'webhook') {
      return res.status(404).json({ error: 'Telegram webhook transport is disabled' });
    }
    const providedSecret = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (!providedSecret) {
      return res.status(401).json({ error: 'Telegram webhook secret is required' });
    }
    if (!constantTimeSecretEquals(providedSecret, telegramWebhookSecret)) {
      return res.status(403).json({ error: 'Telegram webhook secret is invalid' });
    }
    return next();
  });
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buffer) => {
      if (req.url.startsWith('/api/integrations/google-sheets/webhook')) {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      }
    },
  }));
  app.use((_req, res, next) => {
    const developmentCsp = process.env.NODE_ENV !== 'production';
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      `script-src 'self' https://telegram.org${developmentCsp ? " 'unsafe-inline'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self'${developmentCsp ? ' ws: http: https:' : ''}`,
      "frame-ancestors https://web.telegram.org https://*.telegram.org",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '));
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.use('/api', (req, res, next) => {
    if (isShuttingDown && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      res.setHeader('Connection', 'close');
      return res.status(503).json({ error: 'Сервис завершает работу и временно не принимает изменения.' });
    }
    return next();
  });

  const readinessSnapshot = () => {
    const currentRevision = Number(databaseStateCache?.settings?.databaseRevision || 0);
    const persistenceReady = Boolean(databaseStateCache) && !runtimeOperations.lastPersistenceError;
    const replicationPending = Boolean(pendingDatabaseSheetsState || databaseSheetsFlushPromise);
    const degraded = persistenceReady && Boolean(DATABASE_SHEETS_CONFIG?.enabled && (replicationPending || runtimeOperations.lastReplicationError));
    return {
      ready: !isShuttingDown && persistenceReady,
      status: isShuttingDown || !persistenceReady ? 'unavailable' : degraded ? 'degraded' : 'ready',
      service: 'megabot',
      revision: process.env.APP_REVISION || 'unknown',
      uptimeSeconds: Math.floor(process.uptime()),
      telegramUpdateMode,
      serverNow: new Date().toISOString(),
      timeZone: PROJECT_TIME_ZONE,
      persistence: DATABASE_SHEETS_CONFIG?.enabled ? {
        mode: 'google_sheets_with_local_recovery',
        durableRevision: currentRevision,
        replicatedRevision: lastDatabaseSheetsSyncedRevision,
        pendingReplication: replicationPending,
      } : {
        mode: 'local_json',
        durableRevision: currentRevision,
        replicatedRevision: currentRevision,
        pendingReplication: false,
      },
    };
  };
  app.get('/api/health/live', (_req, res) => {
    res.json({ ok: true, service: 'megabot', serverNow: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()) });
  });
  app.get('/api/health/ready', (_req, res) => {
    const readiness = readinessSnapshot();
    return res.status(readiness.ready ? 200 : 503).json(readiness);
  });
  app.get('/api/health', (_req, res) => {
    const readiness = readinessSnapshot();
    res.status(readiness.ready ? 200 : 503).json({ ok: readiness.ready, ...readiness });
  });
  app.use('/api', (req, res, next) => {
    const publicPaths = new Set([
      '/user/get-or-create',
      '/telegram-webhook',
      '/integrations/google-sheets/webhook',
    ]);
    if (publicPaths.has(req.path)) return next();

    if (process.env.NODE_ENV !== 'production') {
      return next();
    }

    const state = loadDatabase();
    const verifiedSession = verifySessionToken(cookieValue(req.headers.cookie, 'megabot_session'));
    const authUser = state.users.find((user) => user.id === verifiedSession?.userId && user.registered && isUserActive(user));
    if (!authUser) {
      return res.status(401).json({ error: 'Открой Mini App кнопкой в Telegram, чтобы подтвердить доступ.' });
    }
    (req as express.Request & { authUserId?: string }).authUserId = authUser.id;
    if (isFacultyUser(authUser) && !FACULTY_SESSION_PATHS.has(req.path)) {
      return res.status(403).json({ error: 'Для этой роли Mini App недоступен. Используйте назначенные задачи в чате с ботом.' });
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isAllowedMutationOrigin(req)) {
      return res.status(403).json({ error: 'Неверный источник запроса. Обновите Mini App и повторите действие.' });
    }

    if (req.body && typeof req.body === 'object') {
      // Actor fields are always supplied by the verified session. Applying this
      // rule uniformly prevents new requesterId-based routes from silently
      // falling outside a path-by-path allowlist.
      req.body.requesterId = authUser.id;
      req.body.creatorId = authUser.id;
      req.body.hostId = authUser.id;

      // These endpoints use userId as the acting user rather than as a target.
      if (SELF_ACTOR_USER_ID_PATHS.has(req.path)) {
        req.body.userId = authUser.id;
      }
    }
    return next();
  });
  app.use('/api', async (req, res, next) => {
    if (req.method !== 'POST' || !IDEMPOTENT_CREATE_PATHS.has(req.path)) return next();
    const key = String(req.get('Idempotency-Key') || '').trim();
    // Compatibility window for already opened Mini App versions. Current clients
    // always send the header; a later Java cutover can make it mandatory.
    if (!key) return next();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      return res.status(400).json({ error: 'Idempotency-Key должен содержать 8–128 безопасных символов' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const actorId = idempotencyActor(body);
    if (!actorId) return res.status(400).json({ error: 'Не удалось определить автора идемпотентной операции' });
    const operation = `POST ${req.path}`;
    const bodyHash = idempotencyBodyHash(body);
    const scope = `${actorId}:${key}`;
    let reservation: ReturnType<typeof reserveIdempotency>;
    try {
      const committed = mutateDatabaseAtomically((state) => reserveIdempotency(state, { actorId, key, operation, bodyHash }));
      reservation = committed.value;
    } catch (error) {
      return databaseMutationErrorResponse(res, error);
    }
    if (reservation.kind === 'conflict') {
      return res.status(409).json({ error: 'Idempotency-Key уже использован для другой операции или другого тела запроса' });
    }
    if (reservation.kind === 'full') {
      return res.status(503).json({ error: 'Реестр идемпотентности переполнен; операция не выполнялась' });
    }
    if (reservation.kind === 'processing') {
      const pending = idempotencyInFlight.get(scope);
      if (!pending) {
        return res.status(409).json({ error: 'Операция с этим Idempotency-Key ещё обрабатывается. Повторите запрос позже.' });
      }
      await pending;
      const completed = findIdempotencyRecord(loadDatabase(), actorId, key);
      if (!completed || completed.status !== 'completed') {
        return res.status(503).json({ error: 'Не удалось подтвердить результат идемпотентной операции' });
      }
      res.setHeader('Idempotency-Replayed', 'true');
      return res.status(completed.responseStatus || 200).json(completed.responseBody);
    }
    if (reservation.kind === 'replay') {
      res.setHeader('Idempotency-Replayed', 'true');
      return res.status(reservation.record.responseStatus || 200).json(reservation.record.responseBody);
    }

    let resolveInFlight = () => {};
    const pending = new Promise<void>((resolve) => { resolveInFlight = resolve; });
    idempotencyInFlight.set(scope, pending);
    idempotencyResolvers.set(scope, resolveInFlight);
    const originalJson = res.json.bind(res);
    res.json = ((responseBody: unknown) => {
      try {
        const state = loadDatabase();
        if (!completeIdempotency(state, actorId, key, res.statusCode, responseBody) || !saveDatabase(state)) {
          res.status(503);
          responseBody = { error: 'Результат операции выполнен, но не удалось сохранить защиту от повтора' };
        }
      } finally {
        idempotencyResolvers.get(scope)?.();
        idempotencyResolvers.delete(scope);
        idempotencyInFlight.delete(scope);
      }
      return originalJson(responseBody);
    }) as express.Response['json'];
    return next();
  });
  app.post('/api/auth/logout', (req, res) => {
    revokeSessionToken(cookieValue(req.headers.cookie, 'megabot_session'));
    res.setHeader('Set-Cookie', 'megabot_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
    return res.json({ success: true });
  });
  app.get('/api/integrations/google-sheets/availability', (_req, res) => {
    if (!sheetsConfig) return res.status(503).json({ error: 'Google Sheets availability is not configured' });
    const gid = sheetsConfig.primarySheetId === undefined ? '' : `#gid=${sheetsConfig.primarySheetId}`;
    return res.redirect(`https://docs.google.com/spreadsheets/d/${sheetsConfig.spreadsheetId}/edit${gid}`);
  });
  app.get('/api/integrations/google-sheets/task-log', async (_req, res) => {
    if (!DATABASE_SHEETS_CONFIG) return res.status(503).json({ error: 'Google Sheets database is not configured' });
    try {
      return res.redirect(await googleSheetsDatabaseSheetUrl(DATABASE_SHEETS_CONFIG, 'task_log'));
    } catch (error: any) {
      return res.status(502).json({ error: error.message || 'Не удалось открыть лог задач' });
    }
  });
  const chatSessions = new Map<string, {
    flow: string;
    meetingKind?: 'general' | 'competency';
    competency?: string;
    participantIds?: string[];
    topic?: string;
    description?: string;
    meetingDate?: string;
    meetingTime?: string;
    taskIds?: string[];
    selectedTaskId?: string;
    selectedStatus?: Task['status'];
    slotDay?: number;
    pendingSlots?: Record<number, number[]>;
    draftName?: string;
    draftUsername?: string;
    draftBirthday?: string;
    draftRole?: User['role'];
    taskTitle?: string;
    taskDescription?: string;
    taskDeadline?: string;
    taskCompetency?: string;
    taskPriority?: Task['priority'];
    taskEventId?: string;
    taskAssignmentMode?: 'block' | 'person' | 'open' | 'team';
    taskAssigneeIds?: string[];
    completionTaskId?: string;
    completionTimeMinutes?: number;
  }>();
  type StoredSlotDraft = {
    userId: string;
    weekStart: string;
    slots: Record<number, number[]>;
    hardUnavailableDays?: number[];
    outWeekIndexes?: number[];
    weekVersions?: Record<string, number>;
    dayBaseline?: { dayIndex: number; hours: number[]; unavailable: boolean };
  };
  type StoredChatUiState = {
    version: 2;
    panels: Record<string, { current?: number; known: number[] }>;
    navigation?: Record<string, number>;
    pendingSheetExports: string[];
    groupMembers?: Record<string, Record<string, {
      telegramId: string;
      username?: string;
      displayName: string;
      active: boolean;
      updatedAt: string;
    }>>;
    slotDrafts: Record<string, StoredSlotDraft>;
  };
  const loadChatUiState = (): StoredChatUiState => {
    try {
      if (!fs.existsSync(CHAT_PANEL_FILE)) return { version: 2, panels: {}, pendingSheetExports: [], slotDrafts: {} };
      const saved = JSON.parse(fs.readFileSync(CHAT_PANEL_FILE, 'utf8')) as StoredChatUiState | Record<string, number>;
      if ((saved as StoredChatUiState).version === 2 && (saved as StoredChatUiState).panels) {
        return { ...(saved as StoredChatUiState), pendingSheetExports: (saved as StoredChatUiState).pendingSheetExports || [] };
      }
      const panels = Object.fromEntries(
        Object.entries(saved)
          .filter(([, value]) => Number.isInteger(value))
          .map(([chatId, value]) => [chatId, { current: value, known: [value as number] }]),
      );
      return { version: 2, panels, pendingSheetExports: [], slotDrafts: {} };
    } catch (error) {
      console.error('Error reading chat panel state:', error);
      return { version: 2, panels: {}, pendingSheetExports: [], slotDrafts: {} };
    }
  };
  const chatUiState = loadChatUiState();
  const chatPanelMessageIds = new Map(
    Object.entries(chatUiState.panels)
      .filter(([, panel]) => Number.isInteger(panel.current))
      .map(([chatId, panel]) => [chatId, panel.current!]),
  );
  const chatPanelKnownIds = new Map(
    Object.entries(chatUiState.panels)
      .map(([chatId, panel]) => [chatId, new Set(panel.known.filter(Number.isInteger))]),
  );
  const chatNavigationMessageIds = new Map<string, number>(
    Object.entries(chatUiState.navigation || {}).filter(([, messageId]) => Number.isInteger(messageId)),
  );
  const chatSlotDrafts = new Map<string, StoredSlotDraft>(Object.entries(chatUiState.slotDrafts || {}));
  const pendingSheetAvailabilityExports = new Set(chatUiState.pendingSheetExports || []);
  const groupMembers = new Map(Object.entries(chatUiState.groupMembers || {}).map(([chatId, members]) => [
    chatId,
    new Map(Object.entries(members)),
  ]));
  const pendingGroupMentions = new Map<string, { competency?: string; expiresAt: number; promptMessageId?: number; messageThreadId?: number }>();
  const pendingGroupCheckins = new Map<string, { expiresAt: number; promptMessageId?: number; messageThreadId?: number }>();
  const processedCallbackIds = new Set<string>();
  const telegramChatUpdateQueues = new Map<string, Promise<void>>();
  let telegramInboxFlushPromise: Promise<void> | null = null;
  const persistChatPanelMessageIds = () => {
    const temporaryFile = `${CHAT_PANEL_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const panels = Object.fromEntries([...chatPanelKnownIds.entries()].map(([chatId, known]) => [chatId, {
        current: chatPanelMessageIds.get(chatId),
        known: [...known],
      }]));
      fs.writeFileSync(temporaryFile, JSON.stringify({
        version: 2,
        panels,
        navigation: Object.fromEntries(chatNavigationMessageIds),
        pendingSheetExports: [...pendingSheetAvailabilityExports],
        groupMembers: Object.fromEntries([...groupMembers.entries()].map(([chatId, members]) => [
          chatId,
          Object.fromEntries(members),
        ])),
        slotDrafts: Object.fromEntries(chatSlotDrafts),
      }, null, 2), 'utf8');
      fs.renameSync(temporaryFile, CHAT_PANEL_FILE);
      return true;
    } catch (error) {
      console.error('Error writing chat panel state:', error);
      try {
        if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
      } catch {
        // The original write error is the useful one.
      }
      return false;
    }
  };
  const rememberGroupMember = (chatId: string | number, telegramUser: any, active = true) => {
    if (!telegramUser?.id || telegramUser.is_bot) return;
    const chatKey = String(chatId);
    const telegramId = String(telegramUser.id);
    const members = groupMembers.get(chatKey) || new Map();
    const previous = members.get(telegramId);
    const displayName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ').trim()
      || previous?.displayName
      || telegramUser.username
      || `Участник ${telegramId}`;
    members.set(telegramId, {
      telegramId,
      username: telegramUser.username ? `@${String(telegramUser.username).replace(/^@/, '')}` : previous?.username,
      displayName,
      active,
      updatedAt: new Date().toISOString(),
    });
    groupMembers.set(chatKey, members);
    persistChatPanelMessageIds();
  };
  const rememberChatPanelMessage = (chatId: string | number, messageId?: number) => {
    const chatKey = String(chatId);
    if (messageId) {
      chatPanelMessageIds.set(chatKey, messageId);
      const known = chatPanelKnownIds.get(chatKey) || new Set<number>();
      known.add(messageId);
      chatPanelKnownIds.set(chatKey, known);
    } else chatPanelMessageIds.delete(chatKey);
    persistChatPanelMessageIds();
  };
  const forgetChatPanelMessage = (chatId: string | number, messageId: number) => {
    const chatKey = String(chatId);
    const known = chatPanelKnownIds.get(chatKey);
    known?.delete(messageId);
    if (known && known.size === 0) chatPanelKnownIds.delete(chatKey);
    if (chatPanelMessageIds.get(chatKey) === messageId) chatPanelMessageIds.delete(chatKey);
  };
  const flushPendingSheetAvailabilityExports = async () => {
    if (!sheetsConfig || pendingSheetAvailabilityExports.size === 0) return;
    const state = loadDatabase();
    for (const userId of [...pendingSheetAvailabilityExports]) {
      const availability = state.availabilities[userId];
      if (!availability) {
        pendingSheetAvailabilityExports.delete(userId);
        continue;
      }
      try {
        await exportAvailabilityToSheet(sheetsConfig, state.users, availability);
        pendingSheetAvailabilityExports.delete(userId);
        runtimeOperations.lastAvailabilitySheetsSuccessAt = new Date().toISOString();
        runtimeOperations.lastAvailabilitySheetsError = undefined;
      } catch (error: any) {
        runtimeOperations.lastAvailabilitySheetsErrorAt = new Date().toISOString();
        runtimeOperations.lastAvailabilitySheetsError = safeOperationalError(error);
        console.error(`Google Sheets queued availability export failed for ${userId}:`, error.message || error);
      }
    }
    persistChatPanelMessageIds();
  };
  const groupCheckins = new Map<string, { title: string; userIds: Set<string> }>();
  let lastSheetAvailabilityPullAt = 0;
  let nextSheetAvailabilityPullAt = 0;
  let sheetAvailabilityPull: Promise<void> | null = null;
  const sheetAvailabilityPullMinIntervalMs = Math.max(5_000, Number(process.env.GOOGLE_SHEETS_AVAILABILITY_PULL_INTERVAL_MS) || 10_000);
  const sheetAvailabilityErrorBackoffMs = Math.max(15_000, Number(process.env.GOOGLE_SHEETS_AVAILABILITY_ERROR_BACKOFF_MS) || 60_000);
  const sameAvailability = (left: Availability | undefined, right: Availability) => JSON.stringify({
    weekStart: left?.weekStart,
    slots: left?.slots || {}, hardUnavailableDays: left?.hardUnavailableDays || [], outWeekIndexes: left?.outWeekIndexes || [],
  }) === JSON.stringify({
    weekStart: right.weekStart,
    slots: right.slots || {}, hardUnavailableDays: right.hardUnavailableDays || [], outWeekIndexes: right.outWeekIndexes || [],
  });
  const reconcileAvailabilityFromPrimarySheet = async (maxAgeMs = 0) => {
    const now = Date.now();
    if (!sheetsConfig || now < nextSheetAvailabilityPullAt || now - lastSheetAvailabilityPullAt < maxAgeMs) return;
    if (sheetAvailabilityPull) return sheetAvailabilityPull;
    nextSheetAvailabilityPullAt = now + Math.max(maxAgeMs, sheetAvailabilityPullMinIntervalMs);
    sheetAvailabilityPull = (async () => {
      const usersSnapshot = loadDatabase().users;
      const result = await importAvailabilitiesFromSheet(sheetsConfig, usersSnapshot);
      // The Sheets request may take seconds. Always merge its narrow availability
      // result into the newest state so it cannot overwrite meetings or tasks that
      // were created while the request was in flight.
      const state = loadDatabase();
      let changed = false;
      for (const availability of result.imported) {
        const previous = state.availabilities[availability.userId];
        const merged = mergePrimarySheetAvailability(previous, availability);
        if (sameAvailability(previous, merged)) continue;
        state.availabilities[availability.userId] = merged;
        changed = true;
      }
      if (changed && !saveDatabase(state)) throw new Error('Failed to persist imported Google Sheets availability');
      lastSheetAvailabilityPullAt = Date.now();
      runtimeOperations.lastAvailabilitySheetsSuccessAt = new Date().toISOString();
      runtimeOperations.lastAvailabilitySheetsError = undefined;
    })().catch((error) => {
      nextSheetAvailabilityPullAt = Date.now() + sheetAvailabilityErrorBackoffMs;
      runtimeOperations.lastAvailabilitySheetsErrorAt = new Date().toISOString();
      runtimeOperations.lastAvailabilitySheetsError = safeOperationalError(error);
      throw error;
    }).finally(() => { sheetAvailabilityPull = null; });
    return sheetAvailabilityPull;
  };

  // API Routes

  // Return only the client DTO allowed for the authenticated core-team member.
  app.get('/api/state', async (req, res) => {
    if (sheetsConfig) {
      try { await reconcileAvailabilityFromPrimarySheet(sheetAvailabilityPullMinIntervalMs); }
      catch (error: any) { console.error('Google Sheets on-read reconciliation failed:', error.message || error); }
    }
    const state = loadDatabase();
    const authUserId = (req as express.Request & { authUserId?: string }).authUserId;
    const viewer = state.users.find((user) => user.id === authUserId)
      || (process.env.NODE_ENV !== 'production'
        ? state.users.find((user) => user.role === 'admin' && isUserActive(user)) || state.users.find((user) => !isFacultyUser(user) && isUserActive(user))
        : undefined);
    if (!viewer || !isUserActive(viewer) || isFacultyUser(viewer)) {
      return res.status(403).json({ error: 'State access is restricted to the core team' });
    }
    return res.json({
      ...coreClientState(state, viewer),
      serverNow: new Date().toISOString(),
      timeZone: PROJECT_TIME_ZONE,
    });
  });

  app.get('/api/admin/diagnostics', (req, res) => {
    const state = loadDatabase();
    const authUserId = (req as express.Request & { authUserId?: string }).authUserId;
    const viewer = state.users.find((user) => user.id === authUserId)
      || (process.env.NODE_ENV !== 'production' ? state.users.find((user) => user.role === 'admin' && isUserActive(user)) : undefined);
    if (!viewer || viewer.role !== 'admin' || !isUserActive(viewer)) {
      return res.status(403).json({ error: 'Диагностика доступна только администратору' });
    }
    const nowMs = Date.now();
    const deliveries = state.settings?.notificationDeliveries || [];
    const inbox = state.settings?.telegramInbox || [];
    const deliveryPending = deliveries.filter((item) => ['planned', 'sending', 'retry'].includes(item.status));
    const deliveryAttention = deliveries.filter((item) => item.status === 'failed' || item.status === 'unknown');
    const inboxPending = inbox.filter((item) => ['received', 'processing', 'retry'].includes(item.status));
    const inboxFailed = inbox.filter((item) => item.status === 'failed');
    const oldestAgeSeconds = (values: Array<string | undefined>) => {
      const timestamps = values.map((value) => Date.parse(String(value || ''))).filter(Number.isFinite);
      return timestamps.length ? Math.max(0, Math.floor((nowMs - Math.min(...timestamps)) / 1000)) : 0;
    };
    const readiness = readinessSnapshot();
    const warnings = [
      ...(readiness.status === 'degraded' ? ['Репликация основной базы отстаёт от durable revision.'] : []),
      ...(deliveryAttention.length ? [`Доставки требуют решения: ${deliveryAttention.length}.`] : []),
      ...(inboxFailed.length ? [`Telegram updates завершились ошибкой: ${inboxFailed.length}.`] : []),
      ...(pendingCalendarMeetingIds.size ? [`Google Calendar ожидает повтор: ${pendingCalendarMeetingIds.size}.`] : []),
      ...(pendingSheetAvailabilityExports.size ? [`Экспорт слотов ожидает повтор: ${pendingSheetAvailabilityExports.size}.`] : []),
    ];
    return res.json({
      generatedAt: new Date(nowMs).toISOString(),
      requestId: (req as express.Request & { requestId?: string }).requestId,
      status: !readiness.ready ? 'unavailable' : warnings.length ? 'degraded' : 'healthy',
      warnings,
      service: {
        revision: process.env.APP_REVISION || 'unknown', uptimeSeconds: Math.floor(process.uptime()),
        updateMode: telegramUpdateMode, timeZone: PROJECT_TIME_ZONE,
      },
      persistence: {
        ...readiness.persistence,
        status: readiness.ready ? (readiness.status === 'degraded' ? 'degraded' : 'healthy') : 'unavailable',
        lastSuccessAt: runtimeOperations.lastPersistenceSuccessAt,
        lastErrorAt: runtimeOperations.lastPersistenceErrorAt,
        lastError: runtimeOperations.lastPersistenceError,
        lastReplicationSuccessAt: runtimeOperations.lastReplicationSuccessAt,
        lastReplicationErrorAt: runtimeOperations.lastReplicationErrorAt,
        lastReplicationError: runtimeOperations.lastReplicationError,
      },
      queues: {
        notificationDelivery: {
          total: deliveries.length, pending: deliveryPending.length, attention: deliveryAttention.length,
          oldestPendingAgeSeconds: oldestAgeSeconds(deliveryPending.map((item) => item.intendedAt)),
          byStatus: notificationDeliverySummary(deliveries).byStatus,
        },
        telegramInbox: {
          total: inbox.length, pending: inboxPending.length, failed: inboxFailed.length,
          oldestPendingAgeSeconds: oldestAgeSeconds(inboxPending.map((item) => item.receivedAt)),
          byStatus: inbox.reduce<Record<string, number>>((counts, item) => {
            counts[item.status] = (counts[item.status] || 0) + 1;
            return counts;
          }, {}),
        },
        calendar: { pending: pendingCalendarMeetingIds.size },
        availabilitySheets: { pending: pendingSheetAvailabilityExports.size },
      },
      integrations: {
        telegram: {
          configured: Boolean(telegramBotToken), updateMode: telegramUpdateMode,
          lastSuccessAt: runtimeOperations.lastTelegramSuccessAt,
          lastErrorAt: runtimeOperations.lastTelegramErrorAt,
          lastError: runtimeOperations.lastTelegramError,
        },
        googleCalendar: {
          configured: Boolean(calendarConfig?.enabled), lastSuccessAt: runtimeOperations.lastCalendarSuccessAt,
          lastErrorAt: runtimeOperations.lastCalendarErrorAt, lastError: runtimeOperations.lastCalendarError,
        },
        availabilitySheets: {
          configured: Boolean(sheetsConfig), lastSuccessAt: runtimeOperations.lastAvailabilitySheetsSuccessAt,
          lastErrorAt: runtimeOperations.lastAvailabilitySheetsErrorAt, lastError: runtimeOperations.lastAvailabilitySheetsError,
        },
      },
      workers: runtimeOperations.workerHeartbeats,
    });
  });

  app.get('/api/notification-deliveries', (req, res) => {
    const state = loadDatabase();
    const authUserId = (req as express.Request & { authUserId?: string }).authUserId;
    const viewer = state.users.find((user) => user.id === authUserId)
      || (process.env.NODE_ENV !== 'production' ? state.users.find((user) => user.role === 'admin' && isUserActive(user)) : undefined);
    if (!viewer || viewer.role !== 'admin' || !isUserActive(viewer)) return res.status(403).json({ error: 'Журнал доставки доступен только администратору' });
    const deliveries = state.settings?.notificationDeliveries || [];
    const status = String(req.query.status || '').trim();
    const filtered = (status ? deliveries.filter((item) => item.status === status) : deliveries)
      .slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 200);
    return res.json({
      summary: notificationDeliverySummary(deliveries),
      deliveries: filtered.map((delivery) => ({
        id: delivery.id, category: delivery.category, recipientId: delivery.recipientId,
        recipientName: state.users.find((user) => user.id === delivery.recipientId)?.realName,
        status: delivery.status, attempts: delivery.attempts, intendedAt: delivery.intendedAt,
        availableAt: delivery.availableAt, sentAt: delivery.sentAt, updatedAt: delivery.updatedAt,
        lastErrorCode: delivery.lastErrorCode, lastErrorMessage: delivery.lastErrorMessage,
        textPreview: delivery.text.slice(0, 160),
      })),
    });
  });

  app.post('/api/notification-deliveries/retry', async (req, res) => {
    const requesterId = String(req.body?.requesterId || '');
    const ids = [...new Set<string>((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))].slice(0, 100);
    if (!ids.length) return res.status(400).json({ error: 'Выберите хотя бы одну доставку' });
    let retried = 0;
    try {
      mutateDatabaseAtomically((state) => {
        if (!isAdminUser(state, requesterId)) throw new DatabaseMutationError(403, 'Повторять доставку может только администратор');
        for (const delivery of state.settings?.notificationDeliveries || []) {
          if (ids.includes(delivery.id) && retryNotificationDelivery(delivery)) retried += 1;
        }
      });
    } catch (error) {
      return databaseMutationErrorResponse(res, error);
    }
    await flushNotificationDeliveries();
    return res.json({ success: true, retried, summary: notificationDeliverySummary(loadDatabase().settings?.notificationDeliveries || []) });
  });

  app.get('/api/faculty/me', (req, res) => {
    const state = loadDatabase();
    const authUserId = (req as express.Request & { authUserId?: string }).authUserId;
    const viewer = state.users.find((user) => user.id === authUserId);
    if (!viewer || !isUserActive(viewer) || !isFacultyUser(viewer)) return res.status(403).json({ error: 'Faculty access required' });
    return res.json({ user: clientUser(viewer, viewer), serverNow: new Date().toISOString(), timeZone: PROJECT_TIME_ZONE });
  });

  app.get('/api/faculty/my-tasks', (req, res) => {
    const state = loadDatabase();
    const authUserId = (req as express.Request & { authUserId?: string }).authUserId;
    const viewer = state.users.find((user) => user.id === authUserId);
    if (!viewer || !isUserActive(viewer) || !isFacultyUser(viewer)) return res.status(403).json({ error: 'Faculty access required' });
    const tasks = state.tasks
      .filter((task) => (Array.isArray(task.assignedTo) ? task.assignedTo : []).includes(viewer.id))
      .filter((task) => task.facultyId === viewer.facultyId || task.facultyId === 'all')
      .map((task) => facultyTaskClientView(task, viewer.id));
    return res.json({ tasks, serverNow: new Date().toISOString(), timeZone: PROJECT_TIME_ZONE });
  });

  function isAdminUser(state: SimulationState, userId?: string) {
    return Boolean(userId && state.users.find((user) => user.id === userId && user.role === 'admin' && isUserActive(user)));
  }

  function isRegisteredUser(state: SimulationState, userId?: string) {
    return Boolean(userId && state.users.find((user) => user.id === userId && user.registered && isUserActive(user)));
  }

  app.post('/api/integrations/google-sheets/webhook', async (req, res) => {
    if (!sheetsConfig) return res.status(503).json({ error: 'Google Sheets integration is not configured' });
    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const timestamp = String(req.headers['x-megabot-timestamp'] || '');
    const signature = String(req.headers['x-megabot-signature'] || '');
    if (!verifySheetsWebhook(sheetsConfig.webhookSecret, timestamp, rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid Google Sheets webhook signature' });
    }
    const eventId = String(req.body?.eventId || '');
    if (!eventId) return res.status(400).json({ error: 'eventId is required' });
    if (processedSheetsEvents.has(eventId)) return res.json({ success: true, duplicate: true });
    processedSheetsEvents.add(eventId);
    if (processedSheetsEvents.size > 2_000) processedSheetsEvents.delete(processedSheetsEvents.values().next().value as string);
    if (String(req.body?.spreadsheetId || '') !== sheetsConfig.spreadsheetId) {
      return res.status(403).json({ error: 'Unexpected spreadsheet' });
    }
    const isPrimarySheet = sheetsConfig.primarySheetId !== undefined
      ? Number(req.body?.sheetId) === sheetsConfig.primarySheetId
      : String(req.body?.sheetTitle || '') === sheetsConfig.primarySheetTitle;
    if (!isPrimarySheet) {
      return res.json({ success: true, ignored: 'not_primary_sheet' });
    }
    try {
      const state = loadDatabase();
      const row = Number(req.body?.row);
      const rows = Number(req.body?.rows || 1);
      const changedUserRow = rows === 1 && Number.isInteger(row) && row >= 5 && row <= 200 ? row : undefined;
      const result = await importAvailabilitiesFromSheet(
        sheetsConfig,
        state.users,
        changedUserRow,
        String(req.body?.sheetTitle || ''),
      );
      const latestState = loadDatabase();
      let changed = false;
      result.imported.forEach((availability) => {
        const previous = latestState.availabilities[availability.userId];
        const merged = mergePrimarySheetAvailability(previous, availability);
        if (!sameAvailability(previous, merged)) {
          latestState.availabilities[availability.userId] = merged;
          changed = true;
        }
      });
      if (changed && !saveDatabase(latestState)) {
        return res.status(503).json({ error: 'Не удалось сохранить импортированные слоты' });
      }
      lastSheetAvailabilityPullAt = Date.now();
      return res.json({ success: true, importedUsers: result.imported.length });
    } catch (error: any) {
      console.error('Google Sheets webhook import failed:', error);
      return res.status(500).json({ error: error.message || 'Google Sheets import failed' });
    }
  });

  app.get('/api/integrations/google-sheets/mapping', async (req, res) => {
    const state = loadDatabase();
    const requesterId = (req as express.Request & { authUserId?: string }).authUserId || String(req.query.requesterId || '');
    if (!isAdminUser(state, requesterId)) return res.status(403).json({ error: 'Admin access required' });
    if (!sheetsConfig) return res.status(503).json({ error: 'Google Sheets integration is not configured' });
    try { return res.json(await buildUserMappingReport(sheetsConfig, state.users)); }
    catch (error: any) { return res.status(500).json({ error: error.message || 'Mapping failed' }); }
  });

  app.post('/api/integrations/google-sheets/template', async (req, res) => {
    const state = loadDatabase();
    const requesterId = (req as express.Request & { authUserId?: string }).authUserId || String(req.body?.requesterId || '');
    if (!isAdminUser(state, requesterId)) return res.status(403).json({ error: 'Admin access required' });
    if (!sheetsConfig) return res.status(503).json({ error: 'Google Sheets integration is not configured' });
    try { return res.json({ success: true, ...(await ensureTemplateSheet(sheetsConfig, state.users)) }); }
    catch (error: any) { return res.status(500).json({ error: error.message || 'Template creation failed' }); }
  });

  // Helper to send message to Telegram
  function buildChatKeyboard(_includeWebApp = false, user?: User) {
    if (isFacultyUser(user)) {
      return {
        keyboard: [[{ text: 'Профиль' }, { text: 'Мои задачи' }], [{ text: 'Помощь' }]],
        resize_keyboard: true,
        is_persistent: false,
        one_time_keyboard: false,
      };
    }
    const keyboard: any[] = [
      [{ text: 'Профиль' }, { text: 'Слоты' }, { text: 'Встречи' }],
      user?.role === 'admin'
        ? [{ text: 'Задачи' }, { text: 'МФ' }, { text: 'Помощь' }]
        : [{ text: 'Задачи' }, { text: 'Помощь' }],
    ];

    return {
      keyboard,
      resize_keyboard: true,
      is_persistent: false,
      one_time_keyboard: false,
    };
  }

  function buildKeyboard(rows: string[][], _includeWebApp = false, user?: User) {
    const keyboard: any[] = [];
    rows.forEach((row) => keyboard.push(row.map((text) => ({ text }))));
    return { keyboard, resize_keyboard: true, is_persistent: false, one_time_keyboard: false };
  }

  async function deleteTelegramMessage(chatId: string | number, messageId?: number) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken || !messageId) return false;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  function chunkReplyButtons(items: string[], columns = 3) {
    const rows: string[][] = [];
    for (let index = 0; index < items.length; index += columns) rows.push(items.slice(index, index + columns));
    return rows;
  }

  function flowKeyboardRows(items: string[] = [], columns = 3) {
    return [['Меню', 'Назад'], ...chunkReplyButtons(items, columns)];
  }

  function replyPickerRows(items: string[]) {
    return flowKeyboardRows(items, 3);
  }

  async function deleteOldChatPanels(chatId: string | number, currentMessageId: number) {
    const chatKey = String(chatId);
    const oldMessageIds = [...(chatPanelKnownIds.get(chatKey) || [])]
      .filter((messageId) => messageId !== currentMessageId);
    if (!oldMessageIds.length) return;
    await Promise.all(oldMessageIds.map(async (messageId) => {
      await deleteTelegramMessage(chatId, messageId);
      forgetChatPanelMessage(chatId, messageId);
    }));
    persistChatPanelMessageIds();
  }

  async function editTelegramReplyMarkup(chatId: string | number, messageId: number, inlineKeyboard: any[][]) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken || !messageId) return false;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: inlineKeyboard },
        }),
      });
      if (response.ok) return true;
      const errorBody = await response.text();
      if (response.status === 400 && errorBody.toLowerCase().includes('message is not modified')) return true;
      console.error('Telegram reply markup edit failed:', response.status, errorBody);
      return false;
    } catch (error) {
      console.error('Telegram reply markup edit failed:', error);
      return false;
    }
  }

  async function editTelegramPanel(
    chatId: string | number,
    messageId: number,
    text: string,
    inlineKeyboard?: { text: string; callback_data: string }[][],
  ) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return false;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: renderTelegramHtml(text),
          parse_mode: 'HTML',
          reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
        }),
      });
      if (response.ok) {
        rememberChatPanelMessage(chatId, messageId);
        return true;
      }
      const errorBody = await response.text();
      if (response.status === 400 && errorBody.toLowerCase().includes('message is not modified')) {
        rememberChatPanelMessage(chatId, messageId);
        return true;
      }
      console.error('Telegram panel edit failed:', response.status, errorBody);
      return false;
    } catch (error) {
      console.error('Telegram panel edit failed:', error);
      return false;
    }
  }

  async function sendTelegramKeyboard(chatId: string | number, text: string, rows: string[][], includeWebApp = false, user?: User, silent = false) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: renderTelegramHtml(text),
          parse_mode: 'HTML',
          reply_markup: buildKeyboard(rows, includeWebApp, user),
          disable_notification: (silent || /^tasks?(?:_|$)/.test(chatSessions.get(String(chatId))?.flow || '')) || undefined,
        }),
      });
      if (!response.ok) {
        console.error('Telegram keyboard send failed:', response.status, await response.text());
        return;
      }
      const data = await response.json() as { result?: { message_id?: number } };
      if (data.result?.message_id) {
        rememberChatPanelMessage(chatId, data.result.message_id);
        await deleteOldChatPanels(chatId, data.result.message_id);
        return data.result.message_id;
      }
    } catch (err) {
      console.error('Telegram keyboard send failed:', err);
    }
  }

  async function sendInlinePanel(
    chatId: string | number,
    text: string,
    inlineKeyboard: { text: string; callback_data: string }[][],
    silent = false,
    messageThreadId?: number,
    replaceExisting = true,
  ) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: renderTelegramHtml(text),
          parse_mode: 'HTML',
          reply_markup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined,
          disable_notification: silent || undefined,
          message_thread_id: messageThreadId,
        }),
      });
      if (!response.ok) return;
      const data = await response.json() as { result?: { message_id?: number } };
      if (data.result?.message_id) {
        rememberChatPanelMessage(chatId, data.result.message_id);
        if (replaceExisting) await deleteOldChatPanels(chatId, data.result.message_id);
        return data.result.message_id;
      }
    } catch (err) {
      console.error('Telegram panel send failed:', err);
    }
  }

  async function sendNavigationKeyboard(chatId: string | number, rows: string[][], user?: User) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const chatKey = String(chatId);
    const previousMessageId = chatNavigationMessageIds.get(chatKey);
    if (previousMessageId) {
      await deleteTelegramMessage(chatId, previousMessageId);
      chatNavigationMessageIds.delete(chatKey);
      persistChatPanelMessageIds();
    }
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '\u2063',
          reply_markup: { ...buildKeyboard(rows, false, user), is_persistent: true },
          disable_notification: true,
        }),
      });
      if (!response.ok) {
        console.error('Telegram navigation keyboard send failed:', response.status, await response.text());
        return;
      }
      const data = await response.json() as { result?: { message_id?: number } };
      if (data.result?.message_id) {
        const messageId = data.result.message_id;
        chatNavigationMessageIds.set(chatKey, messageId);
        persistChatPanelMessageIds();
      }
    } catch (error) {
      console.error('Telegram navigation keyboard send failed:', error);
    }
  }

  async function updateInlinePanel(
    chatId: string | number,
    messageId: number | undefined,
    text: string,
    inlineKeyboard: { text: string; callback_data: string }[][],
  ) {
    if (messageId && await editTelegramPanel(chatId, messageId, text, inlineKeyboard)) return true;
    await sendInlinePanel(chatId, text, inlineKeyboard);
    return false;
  }

  const lastTelegramDeliveryAtByChat = new Map<string, number>();
  let lastTelegramDeliveryAt = 0;
  let notificationDeliveryFlushPromise: Promise<void> | null = null;

  async function sendTelegramDeliveryRaw(delivery: NotificationDelivery): Promise<TelegramDeliveryOutcome> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return { kind: 'retryable', code: 'bot_not_configured', message: 'Telegram bot token is not configured' };
    const globalDelayMs = Math.max(0, Number(process.env.TELEGRAM_DELIVERY_INTERVAL_MS || 50));
    const privateDelayMs = Math.max(0, Number(process.env.TELEGRAM_PRIVATE_CHAT_INTERVAL_MS || 1000));
    const now = Date.now();
    const previousChatDelivery = lastTelegramDeliveryAtByChat.get(delivery.chatId) || 0;
    const requiredDelay = Math.max(
      0,
      lastTelegramDeliveryAt + globalDelayMs - now,
      delivery.chatId.startsWith('-') ? 0 : previousChatDelivery + privateDelayMs - now,
    );
    if (requiredDelay > 0) await new Promise((resolve) => setTimeout(resolve, requiredDelay));

    try {
      const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: delivery.chatId,
          text: renderTelegramHtml(delivery.text),
          parse_mode: 'HTML',
          reply_markup: delivery.replyMarkup,
          disable_web_page_preview: delivery.disableWebPagePreview || undefined,
          disable_notification: delivery.disableNotification || undefined,
          message_thread_id: delivery.messageThreadId,
        }),
      });
      lastTelegramDeliveryAt = Date.now();
      lastTelegramDeliveryAtByChat.set(delivery.chatId, lastTelegramDeliveryAt);
      const responseText = await response.text();
      let data: { ok?: boolean; description?: string; error_code?: number; parameters?: { retry_after?: number }; result?: { message_id?: number } } | null = null;
      try { data = responseText ? JSON.parse(responseText) : null; } catch { data = null; }
      if (response.ok && data?.ok !== false && Number.isInteger(data?.result?.message_id)) {
        return { kind: 'sent', messageId: Number(data?.result?.message_id) };
      }
      const code = String(data?.error_code || response.status || 'telegram_error');
      const message = data?.description || responseText || 'Unknown Telegram response';
      if (response.status === 429 || data?.error_code === 429) {
        return { kind: 'rate_limited', retryAfterSeconds: Math.max(1, Number(data?.parameters?.retry_after || 1)), code, message };
      }
      if (response.status === 403 || data?.error_code === 403) return { kind: 'forbidden', code, message };
      if (response.status >= 500) return { kind: 'retryable', code, message };
      return { kind: 'permanent', code, message };
    } catch (error: any) {
      return { kind: 'unknown', code: error?.name === 'AbortError' ? 'timeout' : 'network_error', message: String(error?.message || error) };
    }
  }

  function enqueueTelegramDelivery(input: Parameters<typeof createNotificationDelivery>[0]) {
    return mutateDatabaseAtomically((state) => {
      state.settings ||= {};
      const deliveries = state.settings.notificationDeliveries ||= [];
      const candidate = createNotificationDelivery(input);
      const existing = deliveries.find((item) => item.dedupeKey === candidate.dedupeKey);
      if (existing) return existing;
      deliveries.push(candidate);
      return candidate;
    }).value;
  }

  async function flushNotificationDeliveries() {
    markWorkerHeartbeat('notification_delivery');
    if (notificationDeliveryFlushPromise) return notificationDeliveryFlushPromise;
    notificationDeliveryFlushPromise = (async () => {
      while (true) {
        const snapshot = loadDatabase();
        const nowMs = Date.now();
        const candidate = (snapshot.settings?.notificationDeliveries || [])
          .filter((delivery) => delivery.chatId !== 'unbound:important')
          .sort((a, b) => a.availableAt.localeCompare(b.availableAt))
          .find((delivery) => (
            Boolean(delivery.expiresAt && Date.parse(delivery.expiresAt) <= nowMs)
            || ((delivery.status === 'planned' || delivery.status === 'retry') && Date.parse(delivery.availableAt) <= nowMs)
            || (delivery.status === 'sending' && (!delivery.leasedUntil || Date.parse(delivery.leasedUntil) <= nowMs))
          ));
        if (!candidate) break;
        const claimed = mutateDatabaseAtomically((state) => {
          const delivery = state.settings?.notificationDeliveries?.find((item) => item.id === candidate.id);
          if (!delivery) return undefined;
          const leaseToken = claimNotificationDelivery(delivery, new Date());
          return leaseToken ? { delivery: structuredClone(delivery), leaseToken } : undefined;
        }).value;
        if (!claimed) continue;
        const outcome = await sendTelegramDeliveryRaw(claimed.delivery);
        if (outcome.kind === 'sent') {
          runtimeOperations.lastTelegramSuccessAt = new Date().toISOString();
          runtimeOperations.lastTelegramError = undefined;
        } else {
          runtimeOperations.lastTelegramErrorAt = new Date().toISOString();
          runtimeOperations.lastTelegramError = `${outcome.code || outcome.kind}: ${outcome.message || outcome.kind}`.slice(0, 500);
          console.error(JSON.stringify({
            event: 'telegram_delivery_failed', deliveryId: claimed.delivery.id,
            category: claimed.delivery.category, outcome: outcome.kind, code: outcome.code,
          }));
        }
        mutateDatabaseAtomically((state) => {
          const delivery = state.settings?.notificationDeliveries?.find((item) => item.id === claimed.delivery.id);
          if (delivery) applyTelegramDeliveryOutcome(delivery, claimed.leaseToken, outcome);
        });
      }
    })().finally(() => { notificationDeliveryFlushPromise = null; });
    return notificationDeliveryFlushPromise;
  }

  async function queueAndDeliverTelegram(input: Parameters<typeof createNotificationDelivery>[0]) {
    const delivery = enqueueTelegramDelivery(input);
    await flushNotificationDeliveries();
    return loadDatabase().settings?.notificationDeliveries?.find((item) => item.id === delivery.id);
  }

  async function sendGroupMessage(chatId: string | number, text: string, silent = false, messageThreadId?: number): Promise<number | undefined> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: renderTelegramHtml(text),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          disable_notification: silent || undefined,
          message_thread_id: messageThreadId,
        }),
      });
      const data = await response.json().catch(() => null) as { ok?: boolean; description?: string; result?: { message_id?: number } } | null;
      if (!response.ok || data?.ok === false) {
        console.error('Telegram group message failed:', response.status, data?.description || 'Unknown Telegram response');
        return;
      }
      return data?.result?.message_id;
    } catch (err) {
      console.error('Telegram group message failed:', err);
    }
  }

  function importantNotificationId(prefix: string, text: string) {
    return `${prefix}_${crypto.createHash('sha256').update(text).digest('hex').slice(0, 20)}`;
  }

  async function deliverImportantNotification(
    state: SimulationState,
    text: string,
    prefix: string,
    silent = false,
    _immediateAttempts = 3,
    existingNotificationId?: string,
  ) {
    const notificationId = existingNotificationId || importantNotificationId(prefix, text);
    const teamChatId = state.settings?.teamChatId;
    const importantThreadId = state.settings?.teamImportantThreadId;
    const delivery = await queueAndDeliverTelegram({
      id: notificationId,
      dedupeKey: notificationId,
      category: 'important',
      chatId: teamChatId && importantThreadId ? teamChatId : 'unbound:important',
      text,
      messageThreadId: importantThreadId,
      disableNotification: silent,
    });
    if (delivery?.status === 'sent') {
      console.log(`[Important topic] delivered ${notificationId} to chat=${delivery.chatId} thread=${delivery.messageThreadId} message=${delivery.telegramMessageId}.`);
      return true;
    }
    console.error(`[Important topic] queued ${notificationId}: ${delivery?.lastErrorCode || 'waiting_for_binding'}.`);
    return false;
  }

  async function flushPendingImportantNotifications() {
    const snapshot = loadDatabase();
    const requiresMigration = Boolean(snapshot.settings?.pendingImportantNotifications?.length);
    const requiresBinding = Boolean(snapshot.settings?.teamChatId && snapshot.settings?.teamImportantThreadId
      && snapshot.settings?.notificationDeliveries?.some((delivery) => delivery.category === 'important' && delivery.chatId === 'unbound:important'));
    if (requiresMigration || requiresBinding) mutateDatabaseAtomically((state) => {
      state.settings ||= {};
      const deliveries = state.settings.notificationDeliveries ||= [];
      for (const item of state.settings.pendingImportantNotifications || []) {
        if (deliveries.some((delivery) => delivery.dedupeKey === item.id)) continue;
        deliveries.push(createNotificationDelivery({
          id: item.id, dedupeKey: item.id, category: 'important',
          chatId: state.settings?.teamChatId && state.settings?.teamImportantThreadId
            ? state.settings.teamChatId : 'unbound:important',
          messageThreadId: state.settings?.teamImportantThreadId,
          text: item.text, disableNotification: item.silent, intendedAt: item.createdAt,
        }));
      }
      state.settings.pendingImportantNotifications = [];
      if (state.settings.teamChatId && state.settings.teamImportantThreadId) {
        for (const delivery of deliveries) {
          if (delivery.category === 'important' && delivery.chatId === 'unbound:important') {
            delivery.chatId = state.settings.teamChatId;
            delivery.messageThreadId = state.settings.teamImportantThreadId;
            delivery.updatedAt = new Date().toISOString();
          }
        }
      }
    });
    await flushNotificationDeliveries();
  }

  let telegramBotIdPromise: Promise<string | null> | null = null;
  async function telegramBotId() {
    if (telegramBotIdPromise) return telegramBotIdPromise;
    telegramBotIdPromise = (async () => {
      const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
      if (!botToken) return null;
      const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/getMe`);
      const data = await response.json().catch(() => null) as { ok?: boolean; result?: { id?: string | number } } | null;
      return data?.ok && data.result?.id ? String(data.result.id) : null;
    })().catch((error) => {
      console.error('Telegram getMe failed:', error);
      telegramBotIdPromise = null;
      return null;
    });
    return telegramBotIdPromise;
  }

  async function botCanReceiveOrdinaryGroupMessages(chatId: string | number) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    const botId = await telegramBotId();
    if (!botToken || !botId) return null;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(botId)}`);
      const data = await response.json().catch(() => null) as { ok?: boolean; result?: { status?: string } } | null;
      if (!response.ok || !data?.ok) return null;
      return data.result?.status === 'administrator' || data.result?.status === 'creator';
    } catch (error) {
      console.error('Telegram getChatMember failed:', error);
      return null;
    }
  }

  async function clearPendingGroupMention(pendingKey: string, chatId: string | number) {
    const pending = pendingGroupMentions.get(pendingKey);
    pendingGroupMentions.delete(pendingKey);
    if (pending?.promptMessageId) await deleteTelegramMessage(chatId, pending.promptMessageId);
    return pending;
  }

  async function clearPendingGroupCheckin(pendingKey: string, chatId: string | number) {
    const pending = pendingGroupCheckins.get(pendingKey);
    pendingGroupCheckins.delete(pendingKey);
    if (pending?.promptMessageId) await deleteTelegramMessage(chatId, pending.promptMessageId);
    return pending;
  }

  async function startGroupCheckin(chatId: string | number, title: string, messageThreadId?: number) {
    const panelId = await sendInlinePanel(chatId, `*${title}*\n\nОтметились: 0\nПока никто`, [[
      { text: 'Я здесь · 0', callback_data: 'group_checkin' },
    ]], false, messageThreadId);
    if (panelId) groupCheckins.set(`${chatId}:${panelId}`, { title, userIds: new Set() });
    return Boolean(panelId);
  }

  function scheduleTemporaryGroupMessageDeletion(chatId: string | number, messageId: number | undefined, delayMs = 8_000) {
    if (!messageId) return;
    setTimeout(() => { void deleteTelegramMessage(chatId, messageId); }, delayMs);
  }

  function groupBotCommands(state = loadDatabase()) {
    const used = new Set<string>();
    const blockCommands = (state.competencies || []).slice(0, 92).map((competency) => {
      const base = `all_${telegramCommandSlug(competency)}`.slice(0, 32);
      let command = base;
      let suffix = 2;
      while (used.has(command)) {
        const addition = `_${suffix++}`;
        command = `${base.slice(0, 32 - addition.length)}${addition}`;
      }
      used.add(command);
      return { command, description: `Уведомить блок «${competency}»`, competency };
    });
    return [
    { command: 'all', description: 'Уведомить всех участников беседы' },
    ...blockCommands,
    { command: 'meeting', description: 'Показать ближайшую встречу' },
    { command: 'deadlines', description: 'Показать ближайшие дедлайны' },
    { command: 'slots', description: 'Показать, кто не отметил слоты' },
    { command: 'birthdays', description: 'Показать ближайшие дни рождения' },
    { command: 'checkin', description: 'Название — запустить перекличку' },
    { command: 'help', description: 'Показать команды MegaBot' },
    ];
  }

  function groupCommandCompetencies(state = loadDatabase()) {
    return new Map(groupBotCommands(state)
      .filter((item): item is { command: string; description: string; competency: string } => 'competency' in item)
      .map((item) => [item.command, item.competency]));
  }

  function refreshGroupCommandMenus() {
    const state = loadDatabase();
    const scopes: Record<string, string | number>[] = [
      { type: 'all_group_chats' },
      { type: 'all_chat_administrators' },
    ];
    if (state.settings?.teamChatId) scopes.push({ type: 'chat', chat_id: state.settings.teamChatId });
    void Promise.allSettled(scopes.map((scope) => configureGroupCommandMenu(scope)));
  }

  async function configureGroupCommandMenu(scope: Record<string, string | number> = { type: 'all_group_chats' }) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return false;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          commands: groupBotCommands().map(({ command, description }) => ({ command, description })),
        }),
      });
      if (!response.ok) {
        console.error('Telegram group command menu configuration failed:', response.status, await response.text());
        return false;
      }
      return true;
    } catch (err) {
      console.error('Telegram group command menu configuration failed:', err);
      return false;
    }
  }

  async function configureChatMenuButton(chatId: string | number, user?: User) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    const webAppUrl = configuredWebAppUrl();
    const menuButton = user && !isFacultyUser(user) && webAppUrl
      ? {
          type: 'web_app',
          text: 'Начать',
          web_app: { url: webAppUrl },
        }
      : { type: 'commands' };

    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/setChatMenuButton`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          menu_button: menuButton,
        }),
      });
      if (!response.ok) {
        console.error('Telegram setChatMenuButton failed:', response.status, await response.text());
      }
    } catch (err) {
      console.error('Telegram setChatMenuButton failed:', err);
    }
  }

  async function answerCallback(callbackQueryId: string, text?: string) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      });
      if (!response.ok) {
        console.error('Telegram answerCallback failed:', response.status, await response.text());
      }
    } catch (err) {
      console.error('Telegram answerCallback failed:', err);
    }
  }

  function meetingRecipientIds(state: SimulationState, meeting: Meeting) {
    return new Set(resolveMeetingAudienceUsers(state.users, meeting).map((user) => user.id));
  }

  async function notifyMeetingRecipients(
    state: SimulationState,
    recipientIds: Iterable<string>,
    text: string,
    notificationPrefix: string,
    buttons: { text: string; action: string }[] | ((userId: string) => { text: string; action: string }[]) = [{ text: 'Открыть встречи', action: 'open_tma' }],
  ) {
    // The IMPORTANT topic is the canonical team announcement channel. Deliver it
    // before fan-out to personal chats so a burst of direct messages cannot starve it.
    await deliverImportantNotification(state, text, notificationPrefix);
    const sendJobs: Promise<boolean>[] = [];
    const storedMessages: BotMessage[] = [];
    for (const userId of recipientIds) {
      const target = state.users.find((user) => user.id === userId);
      if (!target || !isUserActive(target)) continue;
      const targetButtons = typeof buttons === 'function' ? buttons(target.id) : buttons;
      if (!state.messages[target.id]) state.messages[target.id] = [];
      const storedMessage: BotMessage = {
        id: `${notificationPrefix}_${crypto.randomUUID()}`,
        userId: target.id,
        sender: 'bot',
        text,
        timestamp: new Date().toISOString(),
        buttons: targetButtons,
      };
      state.messages[target.id].push(storedMessage);
      storedMessages.push(storedMessage);
      if (target.telegramId) {
        sendJobs.push(sendTelegramMessage(target.telegramId, text, targetButtons, false, target));
      }
    }
    if (storedMessages.length) {
      const latestState = loadDatabase();
      for (const message of storedMessages) {
        if (!latestState.messages[message.userId]) latestState.messages[message.userId] = [];
        if (!latestState.messages[message.userId].some((item) => item.id === message.id)) {
          latestState.messages[message.userId].push(message);
        }
      }
      saveDatabase(latestState);
    }
    return Promise.allSettled(sendJobs);
  }

  async function syncMeetingCalendar(state: SimulationState, meeting: Meeting) {
    if (!calendarConfig?.enabled) return true;
    try {
      const result = await syncMeetingToGoogleCalendar(calendarConfig, meeting, state);
      if (!('skipped' in result)) meeting.googleCalendarEventId = result.eventId;
      pendingCalendarMeetingIds.delete(meeting.id);
      runtimeOperations.lastCalendarSuccessAt = new Date().toISOString();
      runtimeOperations.lastCalendarError = undefined;
      return true;
    } catch (error: any) {
      pendingCalendarMeetingIds.add(meeting.id);
      runtimeOperations.lastCalendarErrorAt = new Date().toISOString();
      runtimeOperations.lastCalendarError = safeOperationalError(error);
      console.error(`Google Calendar sync failed for meeting ${meeting.id}:`, error.message || error);
      return false;
    }
  }

  async function syncPersistedMeetingCalendar(meetingId: string) {
    const syncState = loadDatabase();
    const meeting = syncState.meetings.find((item) => item.id === meetingId);
    if (!meeting) return false;
    const previousEventId = meeting.googleCalendarEventId;
    const synced = await syncMeetingCalendar(syncState, meeting);
    if (!synced || meeting.googleCalendarEventId === previousEventId) return synced;
    const latestState = loadDatabase();
    const latestMeeting = latestState.meetings.find((item) => item.id === meetingId);
    if (!latestMeeting) return false;
    latestMeeting.googleCalendarEventId = meeting.googleCalendarEventId;
    saveDatabase(latestState, { changedMeetingIds: [meetingId] });
    return true;
  }

  function groupMentionToken(target: { telegramId?: string; username?: string; displayName: string }) {
    if (target.username) return `@${target.username.replace(/^@/, '')}`;
    if (!target.telegramId) return target.displayName;
    const safeName = target.displayName.replace(/[\]\n]/g, ' ').trim() || 'Участник';
    return `[[tg:${target.telegramId}|${safeName}]]`;
  }

  function resolveGroupMentionTargets(state: SimulationState, chatId: string | number, competency?: string) {
    const knownMembers = groupMembers.get(String(chatId)) || new Map();
    const targets = new Map<string, { telegramId?: string; username?: string; displayName: string }>();
    const addTarget = (target: { telegramId?: string; username?: string; displayName: string }) => {
      const key = target.telegramId || target.username?.toLowerCase();
      if (key && !targets.has(key)) targets.set(key, target);
    };

    state.users
      .filter((member) => !isFacultyUser(member) && isUserActive(member))
      .filter((member) => !competency || member.primaryCompetency === competency || member.competencies?.includes(competency))
      .forEach((member) => {
        const observed = member.telegramId ? knownMembers.get(String(member.telegramId)) : undefined;
        if (observed?.active === false) return;
        addTarget({
          telegramId: member.telegramId,
          username: member.username,
          displayName: member.realName || observed?.displayName || member.username || 'Участник',
        });
      });

    if (!competency) {
      knownMembers.forEach((member) => {
        if (!member.active) return;
        addTarget(member);
      });
    }

    return [...targets.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));
  }

  async function sendGroupMentionNotification(chatId: string | number, note: string, competency?: string, author?: User, messageThreadId?: number) {
    const state = loadDatabase();
    const targets = resolveGroupMentionTargets(state, chatId, competency);
    if (targets.length === 0) {
      const messageId = await sendGroupMessage(chatId, competency
        ? `В блоке «${competency}» пока нет участников с привязанным Telegram.`
        : 'Бот пока не знает ни одного участника этой беседы.', false, messageThreadId);
      return Boolean(messageId);
    }
    const heading = competency ? `*Уведомление для блока «${competency}»*` : '*Уведомление для всех*';
    const cleanNote = note.trim().slice(0, 3000);
    const authorLine = author ? `\n\n*Автор:* ${groupMentionToken({
      telegramId: author.telegramId,
      username: author.username,
      displayName: author.realName || author.username || 'Участник',
    })}` : '';
    const prefix = `${heading}${cleanNote ? `\n\n${cleanNote}` : ''}${authorLine}\n\n`;
    const chunks: string[] = [];
    let current = prefix;
    for (const target of targets) {
      const mention = groupMentionToken(target);
      if (current.length + mention.length + 1 > 3900) {
        chunks.push(current.trim());
        current = '*Продолжение списка*\n\n';
      }
      current += `${mention} `;
    }
    if (current.trim()) chunks.push(current.trim());
    for (const chunk of chunks) {
      if (!await sendGroupMessage(chatId, chunk, false, messageThreadId)) return false;
    }
    return true;
  }

  async function sendAllGroupMentions(chatId: string | number, messageThreadId?: number) {
    const targets = resolveGroupMentionTargets(loadDatabase(), chatId);
    if (targets.length === 0) return false;
    const mentions = targets.map(groupMentionToken).join(' ');
    if (mentions.length > 4000) {
      console.error(`Telegram /all mention list is too long for one message: chat=${chatId}, length=${mentions.length}.`);
      return false;
    }
    return Boolean(await sendGroupMessage(chatId, mentions, false, messageThreadId));
  }

  async function reconcileMeetingCalendar() {
    if (!calendarConfig?.enabled || calendarReconciliationRunning) return;
    calendarReconciliationRunning = true;
    try {
      const state = loadDatabase();
      const previousEventIds = state.meetings.map((meeting) => meeting.googleCalendarEventId || '').join('|');
      const result = await reconcileGoogleCalendar(calendarConfig, state);
      pendingCalendarMeetingIds.clear();
      result.failed.forEach((failure) => pendingCalendarMeetingIds.add(failure.meetingId));
      const nextEventIds = state.meetings.map((meeting) => meeting.googleCalendarEventId || '').join('|');
      if (nextEventIds !== previousEventIds) {
        const latestState = loadDatabase();
        const changedMeetingIds: string[] = [];
        for (const reconciledMeeting of state.meetings) {
          const latestMeeting = latestState.meetings.find((item) => item.id === reconciledMeeting.id);
          if (!latestMeeting || latestMeeting.googleCalendarEventId === reconciledMeeting.googleCalendarEventId) continue;
          latestMeeting.googleCalendarEventId = reconciledMeeting.googleCalendarEventId;
          changedMeetingIds.push(reconciledMeeting.id);
        }
        if (changedMeetingIds.length) saveDatabase(latestState, { changedMeetingIds });
      }
      if (!result.passed) console.error('Google Calendar reconciliation incomplete:', result.failed);
      else console.log(`Google Calendar synchronized: created=${result.created}, updated=${result.updated}, deleted=${result.deleted}.`);
    } finally {
      calendarReconciliationRunning = false;
    }
  }

  async function retryPendingMeetingCalendar() {
    if (!calendarConfig?.enabled || calendarReconciliationRunning || pendingCalendarMeetingIds.size === 0) return;
    calendarReconciliationRunning = true;
    try {
      for (const meetingId of [...pendingCalendarMeetingIds]) {
        const meeting = loadDatabase().meetings.find((item) => item.id === meetingId);
        if (!meeting) {
          pendingCalendarMeetingIds.delete(meetingId);
          continue;
        }
        await syncPersistedMeetingCalendar(meetingId);
      }
    } finally {
      calendarReconciliationRunning = false;
    }
  }

  async function createMeetingAndNotify(state: SimulationState, data: {
    title: string;
    kind?: Meeting['kind'];
    eventId?: string;
    type: Meeting['type'];
    date: string;
    time: string;
    duration?: number;
    hostId: string;
    participants: string[] | 'all';
    topic?: string;
    description?: string;
    competency?: string;
  }) {
    const meeting: Meeting = {
      id: `m_${crypto.randomUUID()}`,
      title: data.title,
      kind: normalizeMeetingKind(data.kind),
      eventId: data.eventId || undefined,
      type: data.type,
      date: data.date,
      time: data.time,
      duration: data.duration || 1,
      hostId: data.hostId,
      participants: data.participants,
      audiencePolicy: 'snapshot',
      audienceUserIds: snapshotMeetingAudienceUserIds(state.users, data.participants, data.hostId),
      attendeeIds: [data.hostId],
      rsvpByUser: { [data.hostId]: 'yes' },
      topic: data.topic || '',
      description: data.description || '',
      status: 'scheduled',
      competency: data.competency || '',
    };

    state.meetings.push(meeting);
    saveDatabase(state, { changedMeetingIds: [meeting.id] });
    const text = `${meetingKindText(meeting.kind).created}\n\n${meetingDetailsText(meeting, state)}\n\nПожалуйста, освободите это время.`;
    await notifyMeetingRecipients(
      state,
      meetingRecipientIds(state, meeting),
      text,
      'meeting_created',
      (userId) => meetingRsvpButtons(meeting, userId),
    );
    await syncPersistedMeetingCalendar(meeting.id);

    return loadDatabase().meetings.find((item) => item.id === meeting.id) || meeting;
  }

  async function configureBotProfile() {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    const description = 'Нажми синюю кнопку «Начать» внизу слева — откроется MegaBot. Если кнопки нет, отправь /start. Здесь можно отмечать свободные слоты, смотреть встречи и работать с задачами команды.';
    const shortDescription = 'Слоты, встречи и задачи команды ITMO MEGABATTLE.';
    const calls = [
      ['setMyDescription', { description }],
      ['setMyShortDescription', { short_description: shortDescription }],
    ] as const;
    const results = await Promise.allSettled(calls.map(([method, body]) => telegramFetch(
      `${tgApiBase}/bot${botToken}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )));
    results.forEach((result, index) => {
      if (result.status === 'rejected') console.error(`Telegram ${calls[index][0]} failed:`, result.reason);
    });
  }

  async function sendTelegramMessage(
    chatId: string | number,
    text: string,
    buttons?: { text: string; action: string }[],
    keyboardOnly = false,
    recipient?: User,
    silent = false,
    deliveryOptions: { dedupeKey?: string; category?: string; expiresAt?: string } = {},
  ): Promise<boolean> {
    const webAppUrl = configuredWebAppUrl();

    let replyMarkup: any = buildChatKeyboard(false, recipient);
    if (keyboardOnly) {
      replyMarkup = buildChatKeyboard(false, recipient);
    } else if (buttons && buttons.length > 0) {
      replyMarkup = {};
      replyMarkup.inline_keyboard = buttons.map(b => {
        if (b.action === 'open_tma' || b.action === 'open_tasks' || b.action === 'open_meetings') {
          if (!webAppUrl) {
            return [{
              text: b.text,
              callback_data: b.action,
            }];
          }
          const targetUrl = new URL(webAppUrl);
          if (b.action === 'open_tasks') targetUrl.searchParams.set('tab', 'tasks');
          if (b.action === 'open_meetings') targetUrl.searchParams.set('tab', 'meetings');
          return [{
            text: b.text,
            web_app: { url: targetUrl.toString() }
          }];
        }
        return [{
          text: b.text,
          callback_data: b.action
        }];
      });
    }

    const delivery = await queueAndDeliverTelegram({
      dedupeKey: deliveryOptions.dedupeKey,
      category: deliveryOptions.category || (silent ? 'task' : 'notification'),
      recipientId: recipient?.id,
      chatId,
      text,
      replyMarkup: Object.keys(replyMarkup).length > 0 ? replyMarkup : undefined,
      disableNotification: silent,
      expiresAt: deliveryOptions.expiresAt,
    });
    return delivery?.status === 'sent';
  }

  async function showProfilePanel(chatId: string | number, user: User, state: SimulationState) {
    const navigationMessageId = chatNavigationMessageIds.get(String(chatId));
    if (navigationMessageId) {
      await deleteTelegramMessage(chatId, navigationMessageId);
      chatNavigationMessageIds.delete(String(chatId));
      persistChatPanelMessageIds();
    }
    chatSessions.delete(String(chatId));
    const rows = isFacultyUser(user)
      ? [['Профиль', 'Мои задачи'], ['Помощь']]
      : [
          ['Профиль', 'Слоты', 'Встречи'],
          user.role === 'admin' ? ['Задачи', 'МФ', 'Помощь'] : ['Задачи', 'Помощь'],
        ];
    await sendTelegramKeyboard(chatId, profileSummaryText(user, state), rows, false, user);
  }

  function sendTaskTelegramMessage(
    chatId: string | number,
    text: string,
    buttons?: { text: string; action: string }[],
    keyboardOnly = false,
    recipient?: User,
    deliveryOptions: { dedupeKey?: string; category?: string; expiresAt?: string } = {},
  ) {
    return sendTelegramMessage(chatId, text, buttons, keyboardOnly, recipient, true, deliveryOptions);
  }

  function sendTaskTelegramKeyboard(chatId: string | number, text: string, rows: string[][], includeWebApp = false, user?: User) {
    return sendTelegramKeyboard(chatId, text, rows, includeWebApp, user, true);
  }

  function sendTaskInlinePanel(
    chatId: string | number,
    text: string,
    inlineKeyboard: { text: string; callback_data: string }[][],
    replaceExisting = true,
  ) {
    return sendInlinePanel(chatId, text, inlineKeyboard, true, undefined, replaceExisting);
  }

  function sendTaskGroupMessage(chatId: string | number, text: string, messageThreadId?: number) {
    return sendGroupMessage(chatId, text, true, messageThreadId);
  }

  async function showWelcomePanel(chatId: string | number, user: User) {
    const facultyText = isFacultyUser(user)
      ? 'Здесь можно посмотреть профиль и работать со своими задачами.'
      : 'Здесь можно отметить свободные слоты, посмотреть встречи и работать с задачами. Mini App открывается синей кнопкой «Начать» внизу слева.';
    await sendTelegramKeyboard(
      chatId,
      `*Привет, ${user.realName || 'участник'}!*\n\nЯ MegaBot команды ITMO MEGABATTLE. ${facultyText}\n\nВыбери нужный раздел кнопками под строкой ввода.`,
      buildChatKeyboard(false, user).keyboard.map((row: any[]) => row.map((item) => item.text)),
      false,
      user,
    );
  }

  function cloneValidSlotSelection(state: SimulationState, source?: Record<number, number[]>) {
    return filterSlotsByAvailabilityConfig(source, state.settings);
  }

  function cloneValidUnavailableDays(state: SimulationState, source: number[] = [], slots: Record<number, number[]> = {}) {
    const activeDays = new Set(normalizeAvailabilityConfig(state.settings).activeDays);
    return [...new Set(source.map(Number).filter((day) => (
      Number.isInteger(day)
      && day >= 0
      && day < 35
      && activeDays.has(day % 7)
      && (slots[day] || []).length === 0
    )))].sort((a, b) => a - b);
  }

  function currentSlotDraft(chatKey: string, user: User, state: SimulationState) {
    const savedDraft = chatSlotDrafts.get(chatKey);
    if (savedDraft?.userId === user.id && savedDraft.weekStart === currentWeekStartIso()) {
      return cloneValidSlotSelection(state, savedDraft.slots);
    }
    return cloneValidSlotSelection(state, alignedAvailabilitySlots(state.availabilities[user.id]));
  }

  function currentSlotUnavailableDays(chatKey: string, user: User, state: SimulationState, slots = currentSlotDraft(chatKey, user, state)) {
    const savedDraft = chatSlotDrafts.get(chatKey);
    const source = savedDraft?.userId === user.id && savedDraft.weekStart === currentWeekStartIso()
      ? savedDraft.hardUnavailableDays ?? alignedHardUnavailableDays(state.availabilities[user.id])
      : alignedHardUnavailableDays(state.availabilities[user.id]);
    return cloneValidUnavailableDays(state, source, slots);
  }

  function currentSlotOutWeekIndexes(chatKey: string, user: User, state: SimulationState) {
    const savedDraft = chatSlotDrafts.get(chatKey);
    const source = savedDraft?.userId === user.id && savedDraft.weekStart === currentWeekStartIso()
      ? savedDraft.outWeekIndexes ?? alignedOutWeekIndexes(state.availabilities[user.id])
      : alignedOutWeekIndexes(state.availabilities[user.id]);
    const weekCount = normalizeAvailabilityConfig(state.settings).weekCount;
    return [...new Set(source.map(Number).filter((weekIndex) => (
      Number.isInteger(weekIndex) && weekIndex >= 0 && weekIndex < weekCount
    )))].sort((a, b) => a - b);
  }

  function storeSlotDraft(
    chatKey: string,
    user: User,
    state: SimulationState,
    slots: Record<number, number[]>,
    slotDay?: number,
    hardUnavailableDays?: number[],
    outWeekIndexes?: number[],
  ) {
    const safeSlots = cloneValidSlotSelection(state, slots);
    const safeOutWeekIndexes = (outWeekIndexes ?? currentSlotOutWeekIndexes(chatKey, user, state))
      .filter((weekIndex) => slotDay === undefined || weekIndex !== Math.floor(slotDay / 7));
    for (const weekIndex of safeOutWeekIndexes) {
      for (let dayIndex = weekIndex * 7; dayIndex < weekIndex * 7 + 7; dayIndex += 1) delete safeSlots[dayIndex];
    }
    const safeUnavailableDays = cloneValidUnavailableDays(
      state,
      hardUnavailableDays ?? currentSlotUnavailableDays(chatKey, user, state, safeSlots),
      Object.fromEntries(Object.entries(safeSlots).filter(([day]) => !safeOutWeekIndexes.includes(Math.floor(Number(day) / 7)))),
    ).filter((day) => !safeOutWeekIndexes.includes(Math.floor(day / 7)));
    const previousDraft = chatSlotDrafts.get(chatKey);
    const weekVersions = previousDraft?.userId === user.id && previousDraft.weekStart === currentWeekStartIso()
      ? { ...(previousDraft.weekVersions || {}) }
      : Object.fromEntries(normalizeAvailabilityConfig(state.settings).weekStarts.map((weekStart) => [
          weekStart,
          Number(state.availabilities[user.id]?.weekVersions?.[weekStart] || 0),
        ]));
    const dayBaseline = slotDay === undefined
      ? undefined
      : previousDraft?.dayBaseline?.dayIndex === slotDay
        ? previousDraft.dayBaseline
        : {
            dayIndex: slotDay,
            hours: [...(safeSlots[slotDay] || [])],
            unavailable: safeUnavailableDays.includes(slotDay),
          };
    chatSessions.set(chatKey, { flow: 'slots_edit', slotDay, pendingSlots: safeSlots });
    chatSlotDrafts.set(chatKey, {
      userId: user.id,
      weekStart: currentWeekStartIso(),
      slots: safeSlots,
      hardUnavailableDays: safeUnavailableDays,
      outWeekIndexes: safeOutWeekIndexes,
      weekVersions,
      dayBaseline,
    });
    persistChatPanelMessageIds();
    return safeSlots;
  }

  function slotDayPanel(
    user: User,
    state: SimulationState,
    dayIndex: number,
    pendingSlots: Record<number, number[]>,
    hardUnavailableDays: number[],
  ) {
    const dayNames = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
    const { hours } = normalizeAvailabilityConfig(state.settings);
    const dayOffset = dayIndex % 7;
    const weekIndex = Math.floor(dayIndex / 7);
    const selected = pendingSlots[dayIndex] || [];
    const unavailable = hardUnavailableDays.includes(dayIndex);
    const keyboard = hours.reduce<{ text: string; callback_data: string }[][]>((rows, hour, index) => {
      if (index % 2 === 0) rows.push([]);
      rows[rows.length - 1].push({
        text: `${selected.includes(hour) ? '✅ ' : ''}${hour}:00`,
        callback_data: `slot_toggle:${dayIndex}:${hour}`,
      });
      return rows;
    }, []);
    keyboard.push([
      {
        text: selected.length === hours.length ? 'Снять весь день' : 'Выбрать весь день',
        callback_data: `slot_toggle_day:${dayIndex}`,
      },
      {
        text: unavailable ? '✅ Не смогу' : 'Не смогу',
        callback_data: `slot_unavailable:${dayIndex}`,
      },
    ]);
    keyboard.push([
      { text: 'Сохранить день', callback_data: `slot_save_day:${dayIndex}` },
      { text: 'Отменить', callback_data: `slot_cancel_day:${dayIndex}` },
    ]);
    keyboard.push([{ text: 'К дням', callback_data: `slot_week:${weekIndex}` }]);
    return {
      text: `*Неделя ${slotWeekRange(weekIndex)}*\n\n*${dayNames[dayOffset]}:* ${unavailable ? 'отмечено «Не смогу».' : 'выбери свободные часы или нажми «Не смогу».'}`,
      keyboard,
    };
  }

  async function showSlotsPanel(
    chatId: string | number,
    user: User,
    state: SimulationState,
    overrideSlots?: Record<number, number[]>,
    messageId?: number,
  ) {
    const chatKey = String(chatId);
    const availability = cloneValidSlotSelection(state, overrideSlots || alignedAvailabilitySlots(state.availabilities[user.id]));
    chatSessions.set(chatKey, { flow: 'slots_root' });
    const text = `✅ *Слоты сохранены*\n\n${slotsSummaryText(user, state, availability)}`;
    const keyboard = [[{ text: 'Изменить слоты', callback_data: 'slot_edit' }]];
    if (messageId) await updateInlinePanel(chatId, messageId, text, keyboard);
    else {
      await sendInlinePanel(chatId, text, keyboard);
      await sendNavigationKeyboard(chatId, [['Меню']], user);
    }
  }

  async function showSlotWeekPicker(chatId: string | number, user: User, state: SimulationState, messageId?: number) {
    const chatKey = String(chatId);
    const savedDraft = chatSlotDrafts.get(chatKey);
    const availability = cloneValidSlotSelection(state,
      savedDraft?.userId === user.id && savedDraft.weekStart === currentWeekStartIso()
        ? savedDraft.slots
        : alignedAvailabilitySlots(state.availabilities[user.id]));
    storeSlotDraft(chatKey, user, state, availability, undefined,
      currentSlotUnavailableDays(chatKey, user, state, availability), currentSlotOutWeekIndexes(chatKey, user, state));
    const { weekCount } = normalizeAvailabilityConfig(state.settings);
    const keyboard = Array.from({ length: weekCount }, (_, weekIndex) => ([{
      text: `Неделя ${slotWeekRange(weekIndex)}`,
      callback_data: `slot_week:${weekIndex}`,
    }]));
    keyboard.push([{ text: 'К сохранённым слотам', callback_data: 'nav_slots' }]);
    await updateInlinePanel(chatId, messageId, '*Изменение слотов*\n\nВыбери неделю.', keyboard);
  }

  async function showSlotWeekPanel(chatId: string | number, user: User, state: SimulationState, weekIndex: number, messageId?: number) {
    const chatKey = String(chatId);
    const availability = currentSlotDraft(chatKey, user, state);
    const unavailableDays = currentSlotUnavailableDays(chatKey, user, state, availability);
    const outWeekIndexes = currentSlotOutWeekIndexes(chatKey, user, state);
    const { activeDays, hours } = normalizeAvailabilityConfig(state.settings);
    const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const dayButtons = outWeekIndexes.includes(weekIndex) ? [] : activeDays.map((dayOffset) => {
      const dayIndex = weekIndex * 7 + dayOffset;
      return {
        text: unavailableDays.includes(dayIndex)
          ? `${dayNames[dayOffset]} · не смогу`
          : `${dayNames[dayOffset]} · ${(availability[dayIndex] || []).length}/${hours.length}`,
        callback_data: `slots_day:${dayIndex}`,
      };
    });
    const keyboard = [
      [{
        text: `${outWeekIndexes.includes(weekIndex) ? '✅ ' : ''}Я в ауте`,
        callback_data: `slot_out_week:${weekIndex}`,
      }],
      ...dayButtons.reduce<{ text: string; callback_data: string }[][]>((rows, button, index) => {
        if (index % 3 === 0) rows.push([]);
        rows[rows.length - 1].push(button);
        return rows;
      }, []),
      [{ text: 'Сохранить неделю', callback_data: `slot_save_week:${weekIndex}` }],
      [{ text: 'К выбору недели', callback_data: 'slot_edit' }],
    ];
    const text = outWeekIndexes.includes(weekIndex)
      ? `*Неделя ${slotWeekRange(weekIndex)}*\n\nТы отметил «Я в ауте».`
      : `${slotsSummaryText(user, state, availability, weekIndex)}\n\n*Неделя ${slotWeekRange(weekIndex)}* · выбери день.`;
    chatSessions.set(chatKey, { flow: 'slots_edit', pendingSlots: availability });
    await updateInlinePanel(chatId, messageId, text, keyboard);
  }

  async function showMeetingsPanel(chatId: string | number, user: User, state: SimulationState) {
    chatSessions.set(String(chatId), { flow: 'meetings_root' });
    await sendTelegramKeyboard(chatId, meetingsSummaryText(user, state), [
      ['Назначить собрание'],
      ['Меню', 'Назад'],
    ], false, user);
  }

  async function showTasksPanel(chatId: string | number, user: User, state: SimulationState) {
    chatSessions.set(String(chatId), { flow: 'tasks_root' });
    await sendTaskTelegramKeyboard(chatId, tasksSummaryText(user, state), [
      ['Управлять задачами', 'Создать задачу'],
      ['Свободные задачи', 'Выполненные задачи'],
      ['Назад'],
    ], false, user);
  }

  async function showTeamPanel(chatId: string | number, user: User, state: SimulationState) {
    if (user.role !== 'admin') {
      await sendTelegramKeyboard(chatId, 'Раздел команды доступен администратору.', [['Назад']], false, user);
      return;
    }
    chatSessions.set(String(chatId), { flow: 'team_root' });
    await sendTelegramKeyboard(chatId, teamSummaryText(state), [
      ['Найти участника', 'Добавить участника'],
      ['Назад'],
    ], false, user);
  }

  async function showFacultiesPanel(chatId: string | number, user: User, state: SimulationState) {
    if (user.role !== 'admin') {
      await sendTelegramKeyboard(chatId, 'Раздел факультетов доступен администратору.', [['Назад']], false, user);
      return;
    }
    chatSessions.set(String(chatId), { flow: 'faculties_root' });
    await sendTelegramKeyboard(chatId, facultiesSummaryText(state), [
      ['Задачи факультетов'],
      ['Назад'],
    ], false, user);
  }

  async function beginChatTaskDetails(chatId: string | number, user: User, state: SimulationState, session: any) {
    const activeEvents = (state.events || []).filter((item) => item.status === 'active');
    if (activeEvents.length) {
      chatSessions.set(String(chatId), { ...session, flow: 'task_create_event' });
      await sendTaskTelegramKeyboard(
        chatId,
        'Для какого мероприятия создаём задачу?',
        flowKeyboardRows([...activeEvents.map((item) => item.name), 'Без мероприятия'], 2),
        false,
        user,
      );
    } else {
      chatSessions.set(String(chatId), { ...session, flow: 'task_create_title', taskEventId: '' });
      await sendTaskTelegramKeyboard(chatId, 'Напиши название задачи.', flowKeyboardRows(), false, user);
    }
  }

  async function finishChatTask(chatId: string | number, user: User, state: SimulationState, session: any, priority: Task['priority']) {
    state = loadDatabase();
    user = state.users.find((member) => member.id === user.id) || user;
    const team = state.users.filter((member) => !isFacultyUser(member) && isUserActive(member));
    const assigneeIds: string[] = session.taskAssignmentMode === 'open'
      ? []
      : [...new Set<string>((session.taskAssigneeIds || []).map(String))];
    const task: Task = {
      id: `t_${crypto.randomUUID()}`,
      version: 1,
      title: session.taskTitle || 'Без названия',
      description: session.taskDescription || '',
      deadline: session.taskDeadline || '',
      assignedTo: assigneeIds.length ? assigneeIds : null,
      creatorId: user.id,
      competency: session.taskCompetency || '',
      eventId: session.taskEventId || '',
      sow: '',
      tips: [],
      status: assigneeIds.length ? 'assigned' : 'open',
      priority,
      createdAt: new Date().toISOString(),
      completedAt: '',
      assignmentMode: 'shared',
    };
    state.tasks.push(task);
    chatSessions.delete(String(chatId));
    const targets = assigneeIds.length
      ? team.filter((member) => assigneeIds.includes(member.id))
      : team;
    const notifications: Array<{ target: User; text: string }> = [];
    for (const target of targets) {
      if (!target.telegramId || target.id === user.id) continue;
      const notificationText = assigneeIds.length
        ? `Тебе назначена задача:\n\n${taskDetailsText(task, state)}`
        : `На доске появилась свободная задача.\n\n${taskDetailsText(task, state)}`;
      notifications.push({ target, text: notificationText });
    }
    if (!saveDatabase(state)) {
      await sendTaskGroupMessage(chatId, 'Не удалось сохранить задачу. Попробуй ещё раз.');
      return;
    }
    await Promise.allSettled(notifications.map(({ target, text }) => sendTaskTelegramMessage(
        target.telegramId!,
        text,
        [{ text: 'Открыть задачи', action: 'open_tasks' }],
        false,
        target,
      )));
    await sendTaskGroupMessage(chatId, `Задача создана:\n\n${taskDetailsText(task, state)}`);
    await showTasksPanel(chatId, user, state);
  }

  async function completeTaskFromChat(state: SimulationState, task: Task, user: User, timeSpentMinutes?: number, completionComment = '') {
    state = loadDatabase();
    const latestTask = state.tasks.find((item) => item.id === task.id);
    if (!latestTask) return { ok: false as const, error: 'Задача больше недоступна.' };
    try {
      task = completeTaskCommand(latestTask, user.id, { timeSpentMinutes, completionComment });
    } catch (error) {
      if (error instanceof TaskCommandError) return { ok: false as const, error: error.message };
      throw error;
    }
    const cleanComment = completionComment.trim();
    if (!saveDatabase(state)) return { ok: false as const, error: 'Не удалось сохранить выполнение. Попробуй ещё раз.' };
    const creator = state.users.find((member) => member.id === task.creatorId && isUserActive(member) && member.telegramId && member.id !== user.id);
    const sendJobs = creator ? [sendTaskTelegramMessage(
        creator.telegramId!,
        `Задача выполнена!\n\n${task.title}\nИсполнитель: ${userMention(user)}${timeSpentMinutes ? `\nЗатрачено: ${taskDurationLabel(timeSpentMinutes)}` : ''}${cleanComment ? `\nКомментарий: ${cleanComment}` : ''}`,
        undefined,
        false,
        creator,
      )] : [];
    await Promise.allSettled(sendJobs);
    return { ok: true as const, task };
  }

  let birthdayReminderCheckRunning = false;
  async function sendDueBirthdayReminders(now = new Date()) {
    markWorkerHeartbeat('birthday_reminders');
    if (birthdayReminderCheckRunning) return;
    const firstHour = Math.min(23, positiveIntegerEnvironment('BIRTHDAY_REMINDER_HOUR', 12));
    if (projectClock(now).hour < firstHour) return;
    birthdayReminderCheckRunning = true;
    try {
      await deliverBirthdayReminders({
        loadState: loadDatabase,
        saveState: saveDatabase,
        send: (telegramId, text, deliveryId) => sendTelegramMessage(
          telegramId, text, undefined, false, undefined, false,
          { dedupeKey: deliveryId, category: 'birthday_reminder' },
        ),
      }, now);
    } finally {
      birthdayReminderCheckRunning = false;
    }
  }

  async function sendSundayAvailabilityReminders(now = new Date()) {
    markWorkerHeartbeat('availability_reminders');
    if (!isAvailabilityReminderTime(now)) return;

    const state = loadDatabase();
    const dateKey = moscowClock(now).dateKey;
    let changed = false;
    const notifications: Array<{ user: User; text: string; dedupeKey: string }> = [];

    for (const user of state.users) {
      if (hasSubmittedAvailabilityForWeek(state.availabilities[user.id], state.settings, 1)) continue;
      const notificationId = `sunday_slots_${dateKey}_${user.id}`;
      if (!state.messages[user.id]) state.messages[user.id] = [];
      const existingMessage = state.messages[user.id].some((message) => message.id === notificationId);
      const existingDelivery = state.settings?.notificationDeliveries?.find((delivery) => delivery.dedupeKey === notificationId);
      if ((existingMessage && !existingDelivery) || existingDelivery?.status === 'sent') continue;

      const text = '🔔 Сегодня воскресенье. Отметь, пожалуйста, свободные слоты на следующую неделю в Mini App. Это займёт меньше минуты.';
      if (!existingMessage) {
        state.messages[user.id].push({
          id: notificationId,
          userId: user.id,
          sender: 'bot',
          text,
          timestamp: new Date().toISOString(),
          buttons: [{ text: 'Открыть Mini App', action: 'open_tma' }],
        });
        changed = true;
      }

      if (user.telegramId) {
        notifications.push({ user, text, dedupeKey: notificationId });
      }
    }

    if (changed) {
      if (!saveDatabase(state)) return;
    }
    await Promise.allSettled(notifications.map(({ user, text, dedupeKey }) => sendTelegramMessage(
      user.telegramId!, text, [{ text: 'Открыть Mini App', action: 'open_tma' }], false, user, false,
      { dedupeKey, category: 'availability_reminder' },
    )));
  }

  async function sendTaskReminders() {
    markWorkerHeartbeat('task_reminders');
    const state = loadDatabase();
    const now = new Date();
    let changed = false;
    const notifications: Array<{ taskId: string; reminderId: string; target: User; text: string; dedupeKey: string }> = [];
    for (const task of state.tasks) {
      if (task.status === 'completed' || task.status === 'cancelled' || !task.reminders?.length) continue;
      const deadline = parseShortDate(task.deadline);
      if (!deadline) continue;
      for (const reminder of task.reminders) {
        const intervalMs = reminder.value * (reminder.unit === 'hours' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
        let shouldSend = false;
        if (reminder.type === 'before_deadline') {
          const remindAt = new Date(deadline.getTime() - intervalMs);
          shouldSend = now >= remindAt && !reminder.sentAt;
        } else {
          const last = reminder.lastSentAt ? new Date(reminder.lastSentAt) : new Date(task.createdAt || now);
          shouldSend = now.getTime() - last.getTime() >= intervalMs;
        }
        if (!shouldSend) continue;
        const cycle = reminder.type === 'before_deadline' ? 'once' : (reminder.lastSentAt || task.createdAt || 'initial');
        for (const id of assignedIds(task)) {
          const target = state.users.find((user) => user.id === id);
          if (!target || !isUserActive(target)) continue;
          const text = `Напоминание по задаче:\n\n${taskDetailsText(task, state)}\n\nТекущий статус: ${taskStatusLabel(task.status)}`;
          const dedupeKey = `task_reminder:${task.id}:${reminder.id}:${cycle}:${target.id}`;
          if (!state.messages[target.id]) state.messages[target.id] = [];
          if (!state.messages[target.id].some((message) => message.id === dedupeKey)) {
            state.messages[target.id].push({ id: dedupeKey, userId: target.id, sender: 'bot', text, timestamp: now.toISOString() });
            changed = true;
          }
          notifications.push({ taskId: task.id, reminderId: reminder.id, target, text, dedupeKey });
        }
      }
    }
    if (changed && !saveDatabase(state)) return;
    const results = new Map<string, boolean[]>();
    for (const notification of notifications) {
      const delivered = !notification.target.telegramId || await sendTaskTelegramMessage(
        notification.target.telegramId,
        notification.text,
        undefined,
        false,
        notification.target,
        { dedupeKey: notification.dedupeKey, category: 'task_reminder' },
      );
      const key = `${notification.taskId}:${notification.reminderId}`;
      const values = results.get(key) || [];
      values.push(delivered);
      results.set(key, values);
    }
    if (!results.size) return;
    mutateDatabaseAtomically((latestState) => {
      for (const task of latestState.tasks) {
        for (const reminder of task.reminders || []) {
          const outcomes = results.get(`${task.id}:${reminder.id}`);
          if (!outcomes?.length || !outcomes.every(Boolean)) continue;
          if (reminder.type === 'before_deadline') reminder.sentAt = now.toISOString();
          else reminder.lastSentAt = now.toISOString();
          task.version = Number(task.version || 1) + 1;
        }
      }
    });
  }

  // Resolve an already allowed user inside Telegram WebApp.
  app.post('/api/user/get-or-create', (req, res) => {
    const ipLimit = authIpRateLimit(req.ip || req.socket.remoteAddress || 'unknown');
    if (!ipLimit.allowed) {
      return rateLimitResponse(res, ipLimit, 'Слишком много попыток входа. Повторите позже.');
    }
    const initData = req.body?.initData;
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    const telegramUser = verifyTelegramInitData(String(initData || ''), botToken);
    if (!telegramUser) {
      return res.status(403).json({ success: false, error: 'Не удалось подтвердить Telegram-аккаунт. Открой приложение кнопкой в боте.' });
    }
    const userLimit = authUserRateLimit(String(telegramUser.id));
    if (!userLimit.allowed) {
      return rateLimitResponse(res, userLimit, 'Слишком много входов для этого Telegram-аккаунта. Повторите позже.');
    }
    const telegramId = telegramUser.id;
    const username = telegramUser.username;
    const displayName = [telegramUser.firstName, telegramUser.lastName].filter(Boolean).join(' ').trim();

    const state = loadDatabase();
    const user = findUserByTelegramIdentity(state, telegramId, username)
      || ensureEnvAdminUser(state, telegramId, username, displayName || undefined);

    if (!user) {
      return res.status(403).json({ success: false, error: 'Вас нет в списке участников. Попросите админа добавить ваш Telegram в раздел «Команда».' });
    }

    let changed = false;
    if (!user.telegramId) {
      user.telegramId = String(telegramId);
      changed = true;
    }
    if (username && user.username !== `@${username}`) {
      user.username = `@${username}`;
      changed = true;
    }
    if (isEnvAdmin(telegramId) && user.role !== 'admin') {
      user.role = 'admin';
      changed = true;
    }
    if (!user.registered) {
      user.registered = true;
      changed = true;
    }
    if (!user.joinedAt) {
      user.joinedAt = new Date().toISOString();
      changed = true;
    }
    user.lastSeenAt = new Date().toISOString();
    changed = true;
    if (changed && !saveDatabase(state)) {
      return res.status(503).json({ success: false, error: 'Не удалось надёжно сохранить вход. Повторите позже.' });
    }
    const sessionToken = createSessionToken(user.id);
    if (sessionToken) {
      res.setHeader(
        'Set-Cookie',
        `megabot_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Secure`,
      );
    }

    if (isFacultyUser(user)) {
      user.registered = true;
      saveDatabase(state);
      return res.json({ success: false, externalOnly: true, user, error: 'Для вашей роли Mini App закрыт. Пользуйтесь задачами в чате с ботом.' });
    }

    res.json({ success: true, user });
  });

  async function handleTelegramUpdate(update: any) {
    const res = { json: <T>(body: T) => body };

    const membershipUpdate = update.chat_member || update.my_chat_member;
    if (membershipUpdate?.chat && membershipUpdate?.new_chat_member?.user) {
      const status = String(membershipUpdate.new_chat_member.status || '');
      rememberGroupMember(
        membershipUpdate.chat.id,
        membershipUpdate.new_chat_member.user,
        status !== 'left' && status !== 'kicked',
      );
      return res.json({ ok: true });
    }

    if (update.message?.chat) {
      const messageChatType = String(update.message.chat.type || 'private');
      if (messageChatType === 'group' || messageChatType === 'supergroup') {
        rememberGroupMember(update.message.chat.id, update.message.from, true);
        (update.message.new_chat_members || []).forEach((member: any) => rememberGroupMember(update.message.chat.id, member, true));
        if (update.message.left_chat_member) rememberGroupMember(update.message.chat.id, update.message.left_chat_member, false);
        if (!update.message.text) return res.json({ ok: true });
      }
    }

    if (update.callback_query?.message?.chat && update.callback_query?.from) {
      const callbackChatType = String(update.callback_query.message.chat.type || 'private');
      if (callbackChatType === 'group' || callbackChatType === 'supergroup') {
        rememberGroupMember(update.callback_query.message.chat.id, update.callback_query.from, true);
      }
    }

    if (update.callback_query) {
      const callback = update.callback_query;
      const action = String(callback.data || '');
      const fromUser = callback.from;
      const chatId = callback.message?.chat?.id || fromUser.id;
      const state = loadDatabase();
      const user = state.users.find(u => isUserActive(u) && u.telegramId === String(fromUser.id));

      if (!user) {
        await answerCallback(callback.id, 'Сначала напиши /start');
        return res.json({ ok: true });
      }

      if (processedCallbackIds.has(callback.id)) {
        await answerCallback(callback.id, 'Это нажатие уже обработано');
        return res.json({ ok: true });
      }
      processedCallbackIds.add(callback.id);
      if (processedCallbackIds.size > 2_000) {
        processedCallbackIds.delete(processedCallbackIds.values().next().value as string);
      }

      const callbackMessageId = Number(callback.message?.message_id);
      const currentPanelId = chatPanelMessageIds.get(String(chatId));
      const isSlotPanelAction = action === 'nav_slots'
        || action === 'slot_edit'
        || action.startsWith('slot_week:')
        || action.startsWith('slot_save_day:')
        || action.startsWith('slot_save_week:')
        || action.startsWith('slots_day:')
        || action.startsWith('slot_toggle:')
        || action.startsWith('slot_toggle_day:')
        || action.startsWith('slot_unavailable:')
        || action.startsWith('slot_out_week:')
        || action.startsWith('slot_cancel_day:');
      if (isSlotPanelAction && currentPanelId && callbackMessageId !== currentPanelId) {
        await deleteTelegramMessage(chatId, callbackMessageId);
        await answerCallback(callback.id, 'Эта панель устарела. Открой «Слоты» ещё раз.');
        return res.json({ ok: true });
      }
      const slotDraft = chatSlotDrafts.get(String(chatId));
      if (isSlotPanelAction && slotDraft && slotDraft.weekStart !== currentWeekStartIso()) {
        await answerCallback(callback.id, 'Началась новая неделя. Выбери актуальную неделю.');
        await showSlotWeekPicker(chatId, user, state, callbackMessageId);
        return res.json({ ok: true });
      }

      if (action === 'nav_profile') {
        await answerCallback(callback.id);
        await showProfilePanel(chatId, user, state);
        return res.json({ ok: true });
      }

      if (action === 'nav_slots') {
        await answerCallback(callback.id);
        const pendingSlots = currentSlotDraft(String(chatId), user, state);
        await showSlotsPanel(chatId, user, state, pendingSlots, callbackMessageId);
        return res.json({ ok: true });
      }

      if (action === 'slot_edit') {
        await answerCallback(callback.id);
        await showSlotWeekPicker(chatId, user, state, callbackMessageId);
        return res.json({ ok: true });
      }

      if (action.startsWith('slot_week:')) {
        const weekIndex = Number(action.split(':')[1]);
        const { weekCount } = normalizeAvailabilityConfig(state.settings);
        if (!Number.isInteger(weekIndex) || weekIndex < 0 || weekIndex >= weekCount) {
          await answerCallback(callback.id, 'Неизвестная неделя');
          return res.json({ ok: true });
        }
        await answerCallback(callback.id);
        await showSlotWeekPanel(chatId, user, state, weekIndex, callbackMessageId);
        return res.json({ ok: true });
      }

      if (action === 'nav_tasks') {
        await answerCallback(callback.id);
        await showTasksPanel(chatId, user, state);
        return res.json({ ok: true });
      }

      if (action.startsWith('slots_day:')) {
        const dayIndex = Number(action.split(':')[1]);
        const { activeDays } = normalizeAvailabilityConfig(state.settings);
        if (!Number.isInteger(dayIndex) || !activeDays.includes(dayIndex % 7)) {
          await answerCallback(callback.id, 'Неизвестный день');
          return res.json({ ok: true });
        }
        const chatKey = String(chatId);
        const pendingSlots = storeSlotDraft(chatKey, user, state, currentSlotDraft(chatKey, user, state), dayIndex);
        const panel = slotDayPanel(user, state, dayIndex, pendingSlots, currentSlotUnavailableDays(chatKey, user, state, pendingSlots));
        await answerCallback(callback.id);
        await updateInlinePanel(chatId, callbackMessageId, panel.text, panel.keyboard);
        return res.json({ ok: true });
      }

      if (action.startsWith('slot_toggle:')) {
        const [, dayValue, hourValue] = action.split(':');
        const dayIndex = Number(dayValue);
        const hour = Number(hourValue);
        const { activeDays, hours } = normalizeAvailabilityConfig(state.settings);
        if (!Number.isInteger(dayIndex) || !activeDays.includes(dayIndex % 7) || !hours.includes(hour)) {
          await answerCallback(callback.id, 'Неизвестный слот');
          return res.json({ ok: true });
        }
        const chatKey = String(chatId);
        const pendingSlots = currentSlotDraft(chatKey, user, state);
        const hardUnavailableDays = currentSlotUnavailableDays(chatKey, user, state, pendingSlots).filter((day) => day !== dayIndex);
        const selected = new Set(pendingSlots[dayIndex] || []);
        if (selected.has(hour)) selected.delete(hour);
        else selected.add(hour);
        pendingSlots[dayIndex] = [...selected].sort((a, b) => a - b);
        storeSlotDraft(chatKey, user, state, pendingSlots, dayIndex, hardUnavailableDays);
        const panel = slotDayPanel(user, state, dayIndex, pendingSlots, hardUnavailableDays);
        await answerCallback(callback.id, selected.has(hour) ? `${hour}:00 добавлено` : `${hour}:00 снято`);
        await updateInlinePanel(chatId, callbackMessageId, panel.text, panel.keyboard);
        return res.json({ ok: true });
      }

      if (action.startsWith('slot_toggle_day:')) {
        const dayIndex = Number(action.split(':')[1]);
        const { activeDays, hours } = normalizeAvailabilityConfig(state.settings);
        if (!Number.isInteger(dayIndex) || !activeDays.includes(dayIndex % 7)) {
          await answerCallback(callback.id, 'Неизвестный день');
          return res.json({ ok: true });
        }
        const chatKey = String(chatId);
        const pendingSlots = currentSlotDraft(chatKey, user, state);
        const hardUnavailableDays = currentSlotUnavailableDays(chatKey, user, state, pendingSlots).filter((day) => day !== dayIndex);
        const fullDay = [...hours];
        const wasFull = (pendingSlots[dayIndex] || []).length === fullDay.length;
        pendingSlots[dayIndex] = wasFull ? [] : fullDay;
        storeSlotDraft(chatKey, user, state, pendingSlots, dayIndex, hardUnavailableDays);
        const panel = slotDayPanel(user, state, dayIndex, pendingSlots, hardUnavailableDays);
        await answerCallback(callback.id, wasFull ? 'День очищен' : 'Выбран весь день');
        await updateInlinePanel(chatId, callbackMessageId, panel.text, panel.keyboard);
        return res.json({ ok: true });
      }

      if (action.startsWith('slot_unavailable:')) {
        const dayIndex = Number(action.split(':')[1]);
        const { activeDays } = normalizeAvailabilityConfig(state.settings);
        if (!Number.isInteger(dayIndex) || !activeDays.includes(dayIndex % 7)) {
          await answerCallback(callback.id, 'Неизвестный день');
          return res.json({ ok: true });
        }
        const chatKey = String(chatId);
        const pendingSlots = currentSlotDraft(chatKey, user, state);
        const hardUnavailableDays = currentSlotUnavailableDays(chatKey, user, state, pendingSlots);
        const wasUnavailable = hardUnavailableDays.includes(dayIndex);
        const nextUnavailableDays = wasUnavailable
          ? hardUnavailableDays.filter((day) => day !== dayIndex)
          : [...hardUnavailableDays.filter((day) => day !== dayIndex), dayIndex].sort((a, b) => a - b);
        if (!wasUnavailable) delete pendingSlots[dayIndex];
        storeSlotDraft(chatKey, user, state, pendingSlots, dayIndex, nextUnavailableDays);
        const panel = slotDayPanel(user, state, dayIndex, pendingSlots, nextUnavailableDays);
        await answerCallback(callback.id, wasUnavailable ? 'Отметка снята' : 'Отмечено: не смогу');
        await updateInlinePanel(chatId, callbackMessageId, panel.text, panel.keyboard);
        return res.json({ ok: true });
      }

      if (action.startsWith('slot_cancel_day:')) {
        const dayIndex = Number(action.split(':')[1]);
        const chatKey = String(chatId);
        const draft = chatSlotDrafts.get(chatKey);
        if (!Number.isInteger(dayIndex) || draft?.userId !== user.id || draft.dayBaseline?.dayIndex !== dayIndex) {
          await answerCallback(callback.id, 'Не удалось восстановить начало редактирования');
          return res.json({ ok: true });
        }
        const pendingSlots = currentSlotDraft(chatKey, user, state);
        const hardUnavailableDays = currentSlotUnavailableDays(chatKey, user, state, pendingSlots)
          .filter((day) => day !== dayIndex);
        pendingSlots[dayIndex] = [...draft.dayBaseline.hours];
        if (pendingSlots[dayIndex].length === 0) delete pendingSlots[dayIndex];
        if (draft.dayBaseline.unavailable) hardUnavailableDays.push(dayIndex);
        storeSlotDraft(chatKey, user, state, pendingSlots, undefined, hardUnavailableDays);
        await answerCallback(callback.id, 'Изменения за день отменены');
        await showSlotWeekPanel(chatId, user, state, Math.floor(dayIndex / 7), callbackMessageId);
        return res.json({ ok: true });
      }

      if (action.startsWith('slot_out_week:')) {
        const weekIndex = Number(action.split(':')[1]);
        const weekCount = normalizeAvailabilityConfig(state.settings).weekCount;
        if (!Number.isInteger(weekIndex) || weekIndex < 0 || weekIndex >= weekCount) {
          await answerCallback(callback.id, 'Неизвестная неделя');
          return res.json({ ok: true });
        }
        const chatKey = String(chatId);
        const pendingSlots = currentSlotDraft(chatKey, user, state);
        const hardUnavailableDays = currentSlotUnavailableDays(chatKey, user, state, pendingSlots);
        const outWeekIndexes = currentSlotOutWeekIndexes(chatKey, user, state);
        const wasOut = outWeekIndexes.includes(weekIndex);
        const nextOutWeekIndexes = wasOut
          ? outWeekIndexes.filter((item) => item !== weekIndex)
          : [...outWeekIndexes, weekIndex].sort((a, b) => a - b);
        if (!wasOut) {
          for (let dayIndex = weekIndex * 7; dayIndex < weekIndex * 7 + 7; dayIndex += 1) delete pendingSlots[dayIndex];
        }
        storeSlotDraft(
          chatKey,
          user,
          state,
          pendingSlots,
          undefined,
          hardUnavailableDays.filter((day) => Math.floor(day / 7) !== weekIndex),
          nextOutWeekIndexes,
        );
        await answerCallback(callback.id, wasOut ? 'Ты снова в строю' : 'Отмечено: я в ауте');
        await showSlotWeekPanel(chatId, user, state, weekIndex, callbackMessageId);
        return res.json({ ok: true });
      }

      if (action.startsWith('slot_save_day:') || action.startsWith('slot_save_week:')) {
        const chatKey = String(chatId);
        const savingDay = action.startsWith('slot_save_day:');
        const targetIndex = Number(action.split(':')[1]);
        const weekIndex = savingDay ? Math.floor(targetIndex / 7) : targetIndex;
        const { weekCount } = normalizeAvailabilityConfig(state.settings);
        if (!Number.isInteger(targetIndex) || weekIndex < 0 || weekIndex >= weekCount) {
          await answerCallback(callback.id, 'Неизвестный период');
          return res.json({ ok: true });
        }
        const pendingSlots = currentSlotDraft(chatKey, user, state);
        const hardUnavailableDays = currentSlotUnavailableDays(chatKey, user, state, pendingSlots);
        const outWeekIndexes = currentSlotOutWeekIndexes(chatKey, user, state);
        const dayIndexes = savingDay ? [targetIndex] : Array.from({ length: 7 }, (_, offset) => weekIndex * 7 + offset);
        let savedState: SimulationState;
        let savedVersion: number;
        try {
          const mutation = mutateDatabaseAtomically((latestState) => {
            const config = normalizeAvailabilityConfig(latestState.settings);
            const targetWeekStart = config.weekStarts[weekIndex];
            const currentAligned = alignAvailabilityToWeek(latestState.availabilities[user.id], currentWeekStartIso(), config.weekCount);
            const days = Object.fromEntries(Array.from({ length: 7 }, (_, relativeDay) => {
              const absoluteDay = weekIndex * 7 + relativeDay;
              const source = dayIndexes.includes(absoluteDay) ? pendingSlots : currentAligned.slots;
              return [relativeDay, [...(source[absoluteDay] || [])]];
            }));
            const unavailableSource = new Set(currentAligned.hardUnavailableDays);
            dayIndexes.forEach((dayIndex) => {
              if (hardUnavailableDays.includes(dayIndex)) unavailableSource.add(dayIndex);
              else unavailableSource.delete(dayIndex);
            });
            const expected = chatSlotDrafts.get(chatKey)?.weekVersions?.[targetWeekStart]
              ?? Number(latestState.availabilities[user.id]?.weekVersions?.[targetWeekStart] || 0);
            const replaced = replaceAvailabilityWeek(latestState.availabilities[user.id], user.id, currentWeekStartIso(), latestState.settings, {
              weekStart: targetWeekStart,
              days,
              hardUnavailableDays: [...unavailableSource].filter((day) => Math.floor(day / 7) === weekIndex).map((day) => day - weekIndex * 7),
              out: !savingDay && outWeekIndexes.includes(weekIndex),
              expectedVersion: expected,
            });
            latestState.availabilities[user.id] = replaced.availability;
            return replaced;
          });
          savedState = mutation.state;
          savedVersion = mutation.value.version;
        } catch (error) {
          await answerCallback(callback.id, 'Не удалось сохранить. Попробуй ещё раз.');
          const conflicted = error instanceof AvailabilityWeekConflictError;
          await updateInlinePanel(
            chatId,
            callbackMessageId,
            conflicted
              ? '⚠️ *Неделя уже изменилась*\n\nЧерновик не потерян. Открой слоты заново, проверь изменения и повтори сохранение.'
              : '⚠️ *Слоты пока не сохранены*\n\nЧерновик не потерян. Повтори сохранение.',
            [[{ text: conflicted ? 'Открыть слоты' : 'Повторить', callback_data: conflicted ? 'slot_edit' : action }]],
          );
          return res.json({ ok: true });
        }
        if (sheetsConfig) pendingSheetAvailabilityExports.add(user.id);
        persistChatPanelMessageIds();
        await answerCallback(callback.id, savingDay ? 'День сохранён' : 'Неделя сохранена');
        if (savingDay) {
          const draft = chatSlotDrafts.get(chatKey);
          const targetWeekStart = normalizeAvailabilityConfig(savedState.settings).weekStarts[weekIndex];
          if (draft) {
            draft.dayBaseline = undefined;
            draft.weekVersions = { ...(draft.weekVersions || {}), [targetWeekStart]: savedVersion };
          }
          persistChatPanelMessageIds();
          await showSlotWeekPanel(chatId, user, savedState, weekIndex, callbackMessageId);
        } else {
          chatSessions.delete(chatKey);
          chatSlotDrafts.delete(chatKey);
          await showSlotsPanel(chatId, user, state, undefined, callbackMessageId);
        }
        void flushPendingSheetAvailabilityExports();
        return res.json({ ok: true });
      }

      if (action === 'group_checkin') {
        const messageId = callback.message?.message_id;
        const pollKey = `${chatId}:${messageId}`;
        const poll = groupCheckins.get(pollKey);
        if (!poll) {
          await answerCallback(callback.id, 'Перекличка уже завершена');
          return res.json({ ok: true });
        }
        poll.userIds.add(user.id);
        const participants = [...poll.userIds]
          .map((id) => state.users.find((member) => member.id === id)?.realName)
          .filter(Boolean);
        await answerCallback(callback.id, 'Отметил');
        await editTelegramPanel(
          chatId,
          messageId,
          `*${poll.title}*\n\nОтметились: ${participants.length}\n${participants.map((name) => `• ${name}`).join('\n') || 'Пока никто'}`,
          [[{ text: `Я здесь · ${participants.length}`, callback_data: 'group_checkin' }]],
        );
        return res.json({ ok: true });
      }

      if (action.startsWith('meeting_rsvp:')) {
        try {
        const [, meetingId, requestedResponse] = action.split(':');
        const meeting = state.meetings.find((item) => item.id === meetingId && item.status === 'scheduled');
        if (!meeting) {
          await answerCallback(callback.id, 'Собрание больше неактуально');
          return res.json({ ok: true });
        }
        if (!meetingRecipientIds(state, meeting).has(user.id)) {
          await answerCallback(callback.id, 'Вы не приглашены на эту встречу');
          return res.json({ ok: true });
        }
        if (meetingPhase(meeting) === 'past') {
          await answerCallback(callback.id, 'Встреча уже завершилась');
          return res.json({ ok: true });
        }
        const currentResponse = meetingRsvpFor(meeting, user.id);
        const response = requestedResponse === 'yes' || requestedResponse === 'no' || requestedResponse === 'unanswered'
          ? requestedResponse
          : currentResponse === 'yes' ? 'no' : 'yes';
        const result = setMeetingRsvp(meeting, user.id, response);
        saveDatabase(state, { changedMeetingIds: [meeting.id] });
        if (result.changed) await syncPersistedMeetingCalendar(meeting.id);
        const answerText = response === 'yes' ? 'Отметил: вы придёте' : response === 'no' ? 'Отметил: вы не придёте' : 'Ответ сброшен';
        await answerCallback(callback.id, answerText);
        if (callbackMessageId) {
          const confirmedKeyboard = meetingRsvpButtons(meeting, user.id).map((button) => [{ text: button.text, callback_data: button.action }]);
          await editTelegramReplyMarkup(chatId, callbackMessageId, confirmedKeyboard);
        }
        return res.json({ ok: true });
        } catch (error) {
          console.error('Meeting RSVP callback failed:', error);
          await answerCallback(callback.id, 'Не удалось сохранить ответ');
          return res.json({ ok: false });
        }
      }

      if (action.startsWith('task_view:')) {
        const taskId = action.split(':')[1];
        const task = state.tasks.find(t => t.id === taskId);
        if (!task) {
          await answerCallback(callback.id, 'Задача не найдена');
          return res.json({ ok: true });
        }
        const webAppUrl = configuredWebAppUrl();
        if (webAppUrl && callbackMessageId) {
          const targetUrl = new URL(webAppUrl);
          targetUrl.searchParams.set('tab', 'tasks');
          await editTelegramReplyMarkup(chatId, callbackMessageId, [[{
            text: 'Посмотреть задачу',
            web_app: { url: targetUrl.toString() },
          }]]);
          await answerCallback(callback.id, 'Кнопка обновлена — нажми ещё раз');
          await sendNavigationKeyboard(chatId, [['Меню']], user);
          return res.json({ ok: true });
        }
        await answerCallback(callback.id);
        const buttons = task.status === 'open'
          ? [[{ text: 'Взять задачу', callback_data: `task_claim:${task.id}` }]]
          : [];
        await sendTaskInlinePanel(chatId, taskDetailsText(task, state), buttons);
        await sendNavigationKeyboard(chatId, [['Меню']], user);
        return res.json({ ok: true });
      }

      if (action.startsWith('task_claim:')) {
        const taskId = action.split(':')[1];
        const task = state.tasks.find(t => t.id === taskId);
        if (!task) {
          await answerCallback(callback.id, 'Задача не найдена');
          return res.json({ ok: true });
        }
        if (task.status !== 'open') {
          await answerCallback(callback.id, 'Задача уже занята');
          await sendTaskTelegramMessage(chatId, 'Эту задачу уже взяли. Открой приложение, чтобы увидеть актуальный список.', [{ text: 'Открыть задачи', action: 'open_tasks' }]);
          return res.json({ ok: true });
        }
        task.assignedTo = [user.id];
        task.status = 'assigned';
        task.version = Number(task.version || 1) + 1;
        saveDatabase(state);
        await answerCallback(callback.id, 'Задача закреплена за тобой');
        await sendTaskGroupMessage(chatId, `Ты взял задачу:\n\n${taskDetailsText(task, state)}`);
        await showTasksPanel(chatId, user, state);
        const creator = state.users.find(u => u.id === task.creatorId);
        const notifyClaimText = `Задачу "${task.title}" подхватил ${userMention(user)}.\n\nСвязаться: ${user.username}`;
    if (creator?.telegramId && isUserActive(creator) && creator.id !== user.id) {
          await sendTaskTelegramMessage(creator.telegramId, notifyClaimText);
        }
        for (const admin of state.users.filter(u => u.role === 'admin' && isUserActive(u) && u.telegramId && u.id !== user.id && u.id !== creator?.id)) {
          await sendTaskTelegramMessage(admin.telegramId!, notifyClaimText);
        }
        return res.json({ ok: true });
      }

      if (action.startsWith('task_release:')) {
        const taskId = action.split(':')[1];
        const task = state.tasks.find(t => t.id === taskId);
        if (!task) {
          await answerCallback(callback.id, 'Задача не найдена');
          return res.json({ ok: true });
        }
        if (task.status === 'cancelled' || task.status === 'completed') {
          await answerCallback(callback.id, task.status === 'cancelled' ? 'Задача отменена' : 'Задача уже завершена');
          return res.json({ ok: true });
        }
        let released;
        try {
          released = releaseTaskCommand(task, user.id);
        } catch (error) {
          await answerCallback(callback.id, error instanceof TaskCommandError ? error.message : 'Не удалось изменить задачу');
          await showTasksPanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (!released.changed) {
          await answerCallback(callback.id, 'Ты уже не назначен на эту задачу');
          return res.json({ ok: true });
        }
        saveDatabase(state);
        await answerCallback(callback.id, released.becameOpen ? 'Задача снова открыта' : 'Ты снят с задачи');
        await sendTaskGroupMessage(chatId, released.becameOpen
          ? `Ты отказался от задачи *"${task.title}"*. Она снова открыта.`
          : `Ты отказался от задачи *"${task.title}"*. Остальные исполнители сохранены.`);
        await showTasksPanel(chatId, user, state);
        const creator = state.users.find(u => u.id === task.creatorId);
        if (creator?.telegramId && isUserActive(creator) && creator.id !== user.id) {
          const remainingNames = released.remainingAssigneeIds.map((id) => state.users.find((item) => item.id === id)?.realName || id).join(', ');
          await sendTaskTelegramMessage(creator.telegramId, released.becameOpen
            ? `${userMention(user)} отказался от задачи *"${task.title}"*. Она снова на бирже.`
            : `${userMention(user)} отказался от задачи *"${task.title}"*. Остались: ${remainingNames}.`);
        }
        for (const target of released.becameOpen ? state.users.filter(u => isUserActive(u) && u.telegramId && u.id !== user.id && u.id !== creator?.id) : []) {
          await sendTaskTelegramMessage(target.telegramId!, `Задача снова свободна:\n\n${taskDetailsText(task, state)}`, [{ text: 'Посмотреть задачу', action: 'open_tasks' }], false, target);
        }
        return res.json({ ok: true });
      }

      if (action.startsWith('task_complete:')) {
        const taskId = action.split(':')[1];
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task || ['cancelled', 'completed'].includes(task.status) || !assignedIds(task).includes(user.id)) {
          await answerCallback(callback.id, 'Задача не найдена');
          return res.json({ ok: true });
        }
        chatSessions.set(String(chatId), { flow: 'task_complete_time', completionTaskId: task.id });
        await answerCallback(callback.id);
        const sharedCompletionNotice = assignedIds(task).length > 1
          ? `\n\nОбщая задача для ${assignedIds(task).length} исполнителей: завершение закроет её для всех.`
          : '';
        await sendTaskTelegramKeyboard(
          chatId,
          `Задача *"${task.title}"* готова.${sharedCompletionNotice}\n\nСколько времени ушло на выполнение? Это необязательно, но поможет планировать нагрузку.`,
          [['15 минут', '30 минут'], ['1 час', '2 часа'], ['Указать вручную'], ['Не указывать', 'Назад']],
          false,
          user,
        );
        return res.json({ ok: true });
      }

      if (action === 'task_skip') {
        await answerCallback(callback.id, 'Ок');
        await showProfilePanel(chatId, user, state);
        return res.json({ ok: true });
      }

      await answerCallback(callback.id);
      return res.json({ ok: true });
    }

    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const fromUser = update.message.from;
      const text = update.message.text.trim();

      const state = loadDatabase();

      const displayName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ').trim();
      let user = findUserByTelegramIdentity(state, fromUser.id, fromUser.username)
        || ensureEnvAdminUser(state, fromUser.id, fromUser.username, displayName);
      const chatType = String(update.message.chat.type || 'private');
      const isGroupChat = chatType === 'group' || chatType === 'supergroup';

      if (isGroupChat) {
        const rawMessageThreadId = Number(update.message.message_thread_id);
        const messageThreadId = Number.isInteger(rawMessageThreadId) && rawMessageThreadId > 0 ? rawMessageThreadId : undefined;
        const commandMatch = text.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
        const commandName = commandMatch?.[1]?.toLowerCase() || '';
        const commandText = commandMatch?.[2]?.trim() || '';
        const blockCommands = groupCommandCompetencies(state);
        const pendingKey = `${chatId}:${messageThreadId || 0}:${fromUser.id}`;
        const pendingMention = pendingGroupMentions.get(pendingKey);
        const pendingCheckin = pendingGroupCheckins.get(pendingKey);

        if (pendingMention && pendingMention.expiresAt <= Date.now()) await clearPendingGroupMention(pendingKey, chatId);
        if (pendingCheckin && pendingCheckin.expiresAt <= Date.now()) await clearPendingGroupCheckin(pendingKey, chatId);
        if (pendingMention && pendingMention.expiresAt > Date.now() && !commandMatch) {
          if (!user?.registered) {
            await clearPendingGroupMention(pendingKey, chatId);
            const warningId = await sendGroupMessage(chatId, 'Эта команда доступна участникам, привязанным к MegaBot.', false, messageThreadId);
            scheduleTemporaryGroupMessageDeletion(chatId, warningId);
            return res.json({ ok: true });
          }
          console.log(`[Group Mention] Received notification text in chat=${chatId} from=${fromUser.id}.`);
          const sent = await sendGroupMentionNotification(chatId, text, pendingMention.competency, user, messageThreadId);
          if (sent) {
            await clearPendingGroupMention(pendingKey, chatId);
          } else {
            const warningId = await sendGroupMessage(chatId, 'Не удалось отправить уведомление. Твой текст сохранён в чате — повтори отправку или используй /cancel.', false, messageThreadId);
            scheduleTemporaryGroupMessageDeletion(chatId, warningId);
          }
          return res.json({ ok: true });
        }
        if (pendingCheckin && pendingCheckin.expiresAt > Date.now() && !commandMatch) {
          if (!user?.registered) {
            await clearPendingGroupCheckin(pendingKey, chatId);
            const warningId = await sendGroupMessage(chatId, 'Эта команда доступна участникам, привязанным к MegaBot.', false, messageThreadId);
            scheduleTemporaryGroupMessageDeletion(chatId, warningId);
            return res.json({ ok: true });
          }
          const title = text.slice(0, 200).trim();
          const started = title ? await startGroupCheckin(chatId, title, messageThreadId) : false;
          if (started) {
            await clearPendingGroupCheckin(pendingKey, chatId);
          } else {
            const warningId = await sendGroupMessage(chatId, 'Не удалось начать перекличку. Название сохранено в чате — попробуй ещё раз или используй /cancel.', false, messageThreadId);
            scheduleTemporaryGroupMessageDeletion(chatId, warningId);
          }
          return res.json({ ok: true });
        }

        const supportedGroupCommand = new Set([
          'all', 'meeting', 'deadlines', 'slots', 'birthdays', 'checkin', 'bindteamchat', 'bindimportant', 'help', 'cancel',
          ...blockCommands.keys(),
        ]).has(commandName);
        if (!supportedGroupCommand) return res.json({ ok: true });
        if (!user?.registered) {
          await sendGroupMessage(chatId, 'Эта команда доступна участникам, привязанным к MegaBot.', false, messageThreadId);
          return res.json({ ok: true });
        }
        user.lastSeenAt = new Date().toISOString();
        saveDatabase(state);

        if (commandName === 'bindteamchat') {
          if (user.role !== 'admin') {
            await sendGroupMessage(chatId, 'Привязать командный чат может только администратор.', false, messageThreadId);
          } else {
            state.settings = { ...(state.settings || {}), teamChatId: String(chatId) };
            saveDatabase(state);
            await configureGroupCommandMenu({ type: 'chat', chat_id: chatId });
            const canReceiveMessages = await botCanReceiveOrdinaryGroupMessages(chatId);
            await sendGroupMessage(chatId, canReceiveMessages === false
              ? 'Чат привязан к MegaBot, но двухшаговые команды пока не заработают. Назначь бота администратором с правом удаления сообщений.'
              : 'Чат привязан к MegaBot. Командные функции активны.', false, messageThreadId);
          }
          return res.json({ ok: true });
        }

        if (commandName === 'bindimportant') {
          if (user.role !== 'admin') {
            await sendGroupMessage(chatId, 'Привязать топик «ВАЖНОЕ» может только администратор.', false, messageThreadId);
          } else if (state.settings?.teamChatId && state.settings.teamChatId !== String(chatId)) {
            await sendGroupMessage(chatId, 'Сначала привяжи этот командный чат командой /bindteamchat.', false, messageThreadId);
          } else if (!messageThreadId) {
            await sendGroupMessage(chatId, 'Эту команду нужно отправить внутри топика «ВАЖНОЕ».');
          } else {
            state.settings = { ...(state.settings || {}), teamChatId: String(chatId), teamImportantThreadId: messageThreadId };
            saveDatabase(state);
            await sendGroupMessage(chatId, 'Топик «ВАЖНОЕ» привязан. Уведомления о встречах будут дублироваться сюда.', false, messageThreadId);
          }
          return res.json({ ok: true });
        }

        const configuredChatId = state.settings?.teamChatId;
        if (configuredChatId && configuredChatId !== String(chatId)) {
          await sendGroupMessage(chatId, 'Командные команды доступны только в привязанном чате.', false, messageThreadId);
          return res.json({ ok: true });
        }

        const selectedCompetency = blockCommands.get(commandName);
        if (commandName !== 'cancel' && commandName !== 'all' && !selectedCompetency && pendingGroupMentions.has(pendingKey)) {
          await clearPendingGroupMention(pendingKey, chatId);
        }
        if (commandName !== 'cancel' && commandName !== 'checkin' && pendingGroupCheckins.has(pendingKey)) {
          await clearPendingGroupCheckin(pendingKey, chatId);
        }

        if (commandName === 'cancel') {
          const [hadMention, hadCheckin] = await Promise.all([
            clearPendingGroupMention(pendingKey, chatId),
            clearPendingGroupCheckin(pendingKey, chatId),
          ]);
          const confirmationId = await sendGroupMessage(chatId, hadMention || hadCheckin ? 'Действие отменено.' : 'Нет ожидающего действия.', false, messageThreadId);
          scheduleTemporaryGroupMessageDeletion(chatId, confirmationId);
          return res.json({ ok: true });
        }

        if (commandName === 'all') {
          if (pendingGroupMentions.has(pendingKey)) await clearPendingGroupMention(pendingKey, chatId);
          await sendAllGroupMentions(chatId, messageThreadId);
          return res.json({ ok: true });
        }

        if (selectedCompetency) {
          if (pendingGroupMentions.has(pendingKey)) await clearPendingGroupMention(pendingKey, chatId);
          if (!commandText) {
            const canReceiveMessages = await botCanReceiveOrdinaryGroupMessages(chatId);
            if (canReceiveMessages === false) {
              const warningId = await sendGroupMessage(
                chatId,
                'Бот видит команды, но Telegram не передаёт ему обычные сообщения. Назначь @megaorgi_bot администратором беседы с правом удаления сообщений и повтори /all.',
                false,
                messageThreadId,
              );
              scheduleTemporaryGroupMessageDeletion(chatId, warningId, 15_000);
              return res.json({ ok: true });
            }
            const expiresAt = Date.now() + 10 * 60 * 1000;
            const promptMessageId = await sendGroupMessage(
              chatId,
              `${selectedCompetency ? `Выбран блок «${selectedCompetency}». ` : ''}Напиши текст уведомления следующим сообщением. Бот добавит актуальные упоминания автоматически.\n\nДля отмены: /cancel`,
              false,
              messageThreadId,
            );
            pendingGroupMentions.set(pendingKey, {
              competency: selectedCompetency,
              expiresAt,
              promptMessageId,
              messageThreadId,
            });
            console.log(`[Group Mention] Waiting for notification text in chat=${chatId} from=${fromUser.id}.`);
            setTimeout(() => {
              const current = pendingGroupMentions.get(pendingKey);
              if (current?.expiresAt !== expiresAt) return;
              void clearPendingGroupMention(pendingKey, chatId);
            }, 10 * 60 * 1000);
            return res.json({ ok: true });
          }
          await sendGroupMentionNotification(chatId, commandText, selectedCompetency, user, messageThreadId);
          return res.json({ ok: true });
        }

        if (commandName === 'meeting') {
          const nextMeeting = state.meetings
            .filter((meeting) => meeting.status === 'scheduled' && meetingPhase(meeting) !== 'past')
            .slice()
            .sort((a, b) => {
              const phaseOrder = Number(meetingPhase(a) !== 'ongoing') - Number(meetingPhase(b) !== 'ongoing');
              return phaseOrder || meetingStartTimestamp(a) - meetingStartTimestamp(b);
            })[0];
          await sendGroupMessage(chatId, nextMeeting
            ? `*Ближайшая встреча*\n\n${meetingDetailsText(nextMeeting, state)}`
            : 'Ближайших встреч нет.', false, messageThreadId);
          return res.json({ ok: true });
        }

        if (commandName === 'deadlines') {
          const tasks = state.tasks
            .filter((task) => !['completed', 'cancelled'].includes(task.status))
            .slice()
            .sort((a, b) => (
              (parseShortDate(a.deadline)?.getTime() ?? Number.POSITIVE_INFINITY)
              - (parseShortDate(b.deadline)?.getTime() ?? Number.POSITIVE_INFINITY)
            ))
            .slice(0, 10);
          await sendTaskGroupMessage(chatId, tasks.length
            ? `*Ближайшие дедлайны*\n\n${tasks.map((task) => `• ${formatShortDate(task.deadline) || 'без даты'} — ${task.title}`).join('\n')}`
            : 'Активных задач нет.', messageThreadId);
          return res.json({ ok: true });
        }

        if (commandName === 'slots') {
          const team = state.users.filter((member) => !isFacultyUser(member) && isUserActive(member));
          const missing = team.filter((member) => !hasSubmittedAvailabilityForWeek(state.availabilities[member.id], state.settings));
          await sendGroupMessage(chatId, missing.length
            ? `*Ещё не отметили слоты (${missing.length}):*\n${missing.map((member) => member.username).join(' ')}`
            : 'Все участники отметили слоты на неделю.', false, messageThreadId);
          return res.json({ ok: true });
        }

        if (commandName === 'birthdays') {
          const upcoming = state.users
            .map((member) => ({ member, days: daysUntilBirthday(member.birthday) }))
            .filter((item): item is { member: User; days: number } => item.days !== null)
            .sort((a, b) => a.days - b.days)
            .slice(0, 5);
          await sendGroupMessage(chatId, upcoming.length
            ? `*Ближайшие дни рождения*\n\n${upcoming.map(({ member, days }) => (
                `• ${formatBirthday(member.birthday)} — ${member.realName}${days === 0 ? ' · сегодня' : ` · через ${days} дн.`}`
              )).join('\n')}`
            : 'Даты рождения пока не заполнены.', false, messageThreadId);
          return res.json({ ok: true });
        }

        if (commandName === 'checkin') {
          if (commandText) {
            await startGroupCheckin(chatId, commandText.slice(0, 200), messageThreadId);
            return res.json({ ok: true });
          }
          if (pendingGroupCheckins.has(pendingKey)) await clearPendingGroupCheckin(pendingKey, chatId);
          const canReceiveMessages = await botCanReceiveOrdinaryGroupMessages(chatId);
          if (canReceiveMessages === false) {
            const warningId = await sendGroupMessage(chatId, 'Бот видит команду, но Telegram не передаёт ему обычные сообщения. Назначь @megaorgi_bot администратором беседы и повтори /checkin.', false, messageThreadId);
            scheduleTemporaryGroupMessageDeletion(chatId, warningId, 15_000);
            return res.json({ ok: true });
          }
          const expiresAt = Date.now() + 10 * 60 * 1000;
          const promptMessageId = await sendGroupMessage(chatId, 'Напиши название переклички следующим сообщением.\n\nДля отмены: /cancel', false, messageThreadId);
          pendingGroupCheckins.set(pendingKey, { expiresAt, promptMessageId, messageThreadId });
          setTimeout(() => {
            const current = pendingGroupCheckins.get(pendingKey);
            if (current?.expiresAt !== expiresAt) return;
            void clearPendingGroupCheckin(pendingKey, chatId);
          }, 10 * 60 * 1000);
          return res.json({ ok: true });
        }

        await sendGroupMessage(
          chatId,
          '*Команды MegaBot*\n\n'
            + '/all — уведомить всех участников беседы\n'
            + `${[...blockCommands.entries()].map(([command, competency]) => `/${command} — уведомить блок «${competency}»`).join('\n')}\n`
            + '/meeting — ближайшая встреча\n'
            + '/deadlines — ближайшие дедлайны\n'
            + '/slots — кто не отметил слоты\n'
            + '/birthdays — ближайшие дни рождения\n'
            + '/checkin название — живая перекличка\n'
            + '/bindteamchat — привязать этот чат (админ)\n'
            + '/bindimportant — привязать текущий топик как «ВАЖНОЕ» (админ)',
          false,
          messageThreadId,
        );
        return res.json({ ok: true });
      }

      if (!user) {
        await deleteTelegramMessage(chatId, update.message.message_id);
        await configureChatMenuButton(chatId, undefined);
        await sendTelegramKeyboard(
          chatId,
          'Вас нет в списке участников. Попросите админа добавить ваш Telegram в раздел «Команда», а потом нажмите /start ещё раз.',
          [['Помощь']],
          false,
        );
        return res.json({ ok: true });
      } else {
        if (!user.telegramId) user.telegramId = String(fromUser.id);
        if (fromUser.username) user.username = `@${fromUser.username}`;
        user.registered = true;
        if (!user.joinedAt) user.joinedAt = new Date().toISOString();
        user.lastSeenAt = new Date().toISOString();
      }
      await deleteTelegramMessage(chatId, update.message.message_id);
      if (isEnvAdmin(fromUser.id) && user.role !== 'admin') {
        user.role = 'admin';
      }
      if (text.toLowerCase().startsWith('/start') || isRegistrationPrompt(text)) {
        await configureChatMenuButton(chatId, user);
      }

      if (!state.messages[user.id]) state.messages[user.id] = [];
      state.messages[user.id].push({
        id: `usr_${crypto.randomUUID()}`,
        userId: user.id,
        sender: 'user',
        text,
        timestamp: new Date().toISOString()
      });
      saveDatabase(state);

      let replyText = '';
      let buttons: { text: string; action: string }[] | undefined = undefined;
      const cmd = text.toLowerCase();
      const chatKey = String(chatId);
      const normalizedText = text.trim().toLowerCase();
      const session = chatSessions.get(chatKey);

      if (isFacultyUser(user)) {
        user.registered = true;
        if (isRegistrationPrompt(text)) {
          await showProfilePanel(chatId, user, state);
          saveDatabase(state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' || normalizedText === 'меню') {
          chatSessions.delete(chatKey);
          await sendTaskTelegramKeyboard(chatId, 'Меню задач.', [['Мои задачи', 'Помощь']], false, user);
          return res.json({ ok: true });
        }

        const myTasks = state.tasks.filter((task) => assignedIds(task).includes(user.id) && !['completed', 'cancelled'].includes(task.status));
        if (cmd.startsWith('/start')) {
          await sendTaskTelegramKeyboard(chatId, `Привет, ${user.realName}! Здесь будут только задачи от команды MEGABATTLE.`, [['Мои задачи', 'Помощь']], false, user);
          saveDatabase(state);
          return res.json({ ok: true });
        }

        if (normalizedText === 'мои задачи' || cmd.startsWith('/tasks')) {
          if (myTasks.length === 0) {
            await sendTelegramKeyboard(chatId, 'Активных задач пока нет.', [['Мои задачи', 'Помощь']], false, user);
            return res.json({ ok: true });
          }
          chatSessions.set(chatKey, { flow: 'faculty_task_pick', taskIds: myTasks.map((task) => task.id) });
          const list = myTasks.map((task, index) => {
            const creator = state.users.find((item) => item.id === task.creatorId);
            return `${index + 1}. ${task.title}\nСтатус: ${taskStatusLabel(task.status)}\nДедлайн: ${formatShortDate(task.deadline)}\nАвтор: ${userMention(creator)}\n${task.description}`;
          }).join('\n\n');
          await sendTelegramKeyboard(chatId, `Твои задачи:\n\n${list}`, [['Установить статус задачи'], ['Мои задачи', 'Помощь']], false, user);
          return res.json({ ok: true });
        }

        if (normalizedText === 'установить статус задачи') {
          if (myTasks.length === 0) {
            await sendTelegramKeyboard(chatId, 'Активных задач пока нет.', [['Мои задачи', 'Помощь']], false, user);
            return res.json({ ok: true });
          }
          chatSessions.set(chatKey, { flow: 'faculty_task_pick', taskIds: myTasks.map((task) => task.id) });
          await sendTelegramKeyboard(chatId, 'Введи порядковый номер задачи из списка.', [['Назад']], false, user);
          return res.json({ ok: true });
        }

        if (session?.flow === 'faculty_task_pick') {
          const index = Number(normalizedText) - 1;
          const selectedTaskId = session.taskIds?.[index];
          const task = state.tasks.find((item) => item.id === selectedTaskId);
          if (!task) {
            await sendTelegramKeyboard(chatId, 'Не нашёл задачу с таким номером. Введи номер ещё раз.', [['Назад']], false, user);
            return res.json({ ok: true });
          }
          chatSessions.set(chatKey, { flow: 'faculty_task_status', selectedTaskId: task.id });
          await sendTelegramKeyboard(chatId, `Задача: ${task.title}\nВыбери новый статус.`, [['Ждет', 'В работе'], ['Выполнено', 'Назад']], false, user);
          return res.json({ ok: true });
        }

        if (session?.flow === 'faculty_task_status') {
          const selectedStatus = parseFacultyTaskStatus(text);
          if (!selectedStatus) {
            await sendTelegramKeyboard(chatId, 'Выбери статус кнопкой: Ждет, В работе или Выполнено.', [['Ждет', 'В работе'], ['Выполнено', 'Назад']], false, user);
            return res.json({ ok: true });
          }
          const task = state.tasks.find((item) => item.id === session.selectedTaskId);
          if (!task) {
            chatSessions.delete(chatKey);
            await sendTelegramKeyboard(chatId, 'Задача не найдена. Открой список заново.', [['Мои задачи', 'Помощь']], false, user);
            return res.json({ ok: true });
          }
          chatSessions.set(chatKey, { flow: 'faculty_task_confirm', selectedTaskId: task.id, selectedStatus });
          const sharedCompletionNotice = selectedStatus === 'completed' && assignedIds(task).length > 1
            ? `\n\nОбщая задача для ${assignedIds(task).length} исполнителей: завершение закроет её для всех.`
            : '';
          await sendTelegramKeyboard(chatId, `Подтвердить смену статуса?\n\n${task.title}\nНовый статус: ${taskStatusLabel(selectedStatus)}${sharedCompletionNotice}`, [['Подтвердить'], ['Назад']], false, user);
          return res.json({ ok: true });
        }

        if (session?.flow === 'faculty_task_confirm' && normalizedText === 'подтвердить') {
          const latestState = loadDatabase();
          const task = latestState.tasks.find((item) => item.id === session.selectedTaskId);
          if (!task || !session.selectedStatus) {
            chatSessions.delete(chatKey);
            await sendTelegramKeyboard(chatId, 'Задача не найдена. Открой список заново.', [['Мои задачи', 'Помощь']], false, user);
            return res.json({ ok: true });
          }
          if (!assignedIds(task).includes(user.id) || task.status === 'cancelled' || task.status === 'completed') {
            chatSessions.delete(chatKey);
            await sendTelegramKeyboard(chatId, 'Задача уже изменилась и этот переход больше недоступен. Открой список заново.', [['Мои задачи', 'Помощь']], false, user);
            return res.json({ ok: true });
          }
          if (session.selectedStatus === 'completed') {
            completeTaskCommand(task, user.id);
          } else {
            task.status = session.selectedStatus;
            task.version = Number(task.version || 1) + 1;
            task.assignmentMode = 'shared';
            task.completedAt = '';
            task.completedBy = undefined;
          }
          const creator = latestState.users.find((item) => item.id === task.creatorId);
          chatSessions.delete(chatKey);
          if (!saveDatabase(latestState)) {
            await sendTelegramKeyboard(chatId, 'Не удалось сохранить статус. Попробуй ещё раз.', [['Мои задачи', 'Помощь']], false, user);
            return res.json({ ok: true });
          }
          if (creator?.telegramId) {
            await sendTaskTelegramMessage(creator.telegramId, `Статус задачи изменён.\n\nЗадача: ${task.title}\nИсполнитель: ${userMention(user)}\nСтатус: ${taskStatusLabel(task.status)}`);
          }
          await sendTelegramKeyboard(chatId, `Готово. Статус задачи "${task.title}" теперь: ${taskStatusLabel(task.status)}.`, [['Мои задачи', 'Помощь']], false, user);
          return res.json({ ok: true });
        }

        if (normalizedText === 'помощь' || cmd.startsWith('/help')) {
          await sendTelegramKeyboard(chatId, 'Здесь ты получаешь задачи от организаторов. В «Мои задачи» можно посмотреть дедлайны и поменять статус задачи. Если нужна помощь, напиши автору задачи из карточки.', [['Мои задачи', 'Помощь']], false, user);
          return res.json({ ok: true });
        }

        await sendTelegramKeyboard(chatId, 'Пользуйся кнопками: Мои задачи и Помощь.', [['Мои задачи', 'Помощь']], false, user);
        saveDatabase(state);
        return res.json({ ok: true });
      }

      if (cmd.startsWith('/start')) {
        chatSessions.delete(chatKey);
        await showWelcomePanel(chatId, user);
        saveDatabase(state);
        return res.json({ ok: true });
      }
      const navigationTarget = chatNavigationTarget(text);
      if (navigationTarget) {
        chatSessions.delete(chatKey);
        if (navigationTarget === 'profile') await showProfilePanel(chatId, user, state);
        if (navigationTarget === 'slots') await showSlotsPanel(chatId, user, state);
        if (navigationTarget === 'meetings') await showMeetingsPanel(chatId, user, state);
        if (navigationTarget === 'tasks') await showTasksPanel(chatId, user, state);
        if (navigationTarget === 'team') await showTeamPanel(chatId, user, state);
        if (navigationTarget === 'faculties') await showFacultiesPanel(chatId, user, state);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_complete_time' && normalizedText !== 'назад') {
        if (normalizedText === 'указать вручную') {
          chatSessions.set(chatKey, { ...session, flow: 'task_complete_custom' });
          await sendTelegramKeyboard(chatId, 'Введи количество минут числом, например 75.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        const presetMinutes: Record<string, number | undefined> = {
          '15 минут': 15,
          '30 минут': 30,
          '1 час': 60,
          '2 часа': 120,
          'не указывать': undefined,
        };
        if (!(normalizedText in presetMinutes)) {
          await sendTelegramKeyboard(chatId, 'Выбери вариант кнопкой или укажи время вручную.', [['15 минут', '30 минут'], ['1 час', '2 часа'], ['Указать вручную'], ['Не указывать', 'Назад']], false, user);
          return res.json({ ok: true });
        }
        const task = state.tasks.find((item) => item.id === session.completionTaskId && assignedIds(item).includes(user.id));
        if (!task) {
          await sendTelegramKeyboard(chatId, 'Задача больше недоступна.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'task_complete_comment', completionTimeMinutes: presetMinutes[normalizedText] });
        await sendTelegramKeyboard(
          chatId,
          `Оставь короткий комментарий по задаче *«${task.title}»*: что получилось, что тормозило или что важно знать автору.`,
          [['Без комментария'], ['Назад']],
          false,
          user,
        );
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_complete_custom' && normalizedText !== 'назад') {
        const minutes = Number(normalizedText);
        if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 60000) {
          await sendTelegramKeyboard(chatId, 'Введи количество минут целым числом больше нуля.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        const task = state.tasks.find((item) => item.id === session.completionTaskId && assignedIds(item).includes(user.id));
        if (!task) {
          await sendTelegramKeyboard(chatId, 'Задача больше недоступна.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'task_complete_comment', completionTimeMinutes: minutes });
        await sendTelegramKeyboard(
          chatId,
          `Оставь короткий комментарий по задаче *«${task.title}»*: что получилось, что тормозило или что важно знать автору.`,
          [['Без комментария'], ['Назад']],
          false,
          user,
        );
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_complete_comment' && normalizedText !== 'назад') {
        const task = state.tasks.find((item) => item.id === session.completionTaskId && assignedIds(item).includes(user.id));
        if (!task) {
          await sendTelegramKeyboard(chatId, 'Задача больше недоступна.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        const completionComment = normalizedText === 'без комментария' ? '' : text.trim();
        const completed = await completeTaskFromChat(state, task, user, session.completionTimeMinutes, completionComment);
        if (!completed.ok) {
          chatSessions.delete(chatKey);
          await sendTaskTelegramKeyboard(chatId, `${completed.error} Открой список задач заново.`, [['Управлять задачами'], ['Меню']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.delete(chatKey);
        await showTasksPanel(chatId, user, loadDatabase());
        return res.json({ ok: true });
      }

      if (normalizedText === 'назад' || normalizedText === 'меню') {
        const currentSession = chatSessions.get(chatKey);
        if (normalizedText === 'назад' && currentSession?.flow === 'tasks_root') {
          chatSessions.delete(chatKey);
          await showProfilePanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && (currentSession?.flow === 'tasks_submenu' || currentSession?.flow.startsWith('task_create_') || currentSession?.flow.startsWith('task_complete_'))) {
          await showTasksPanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meetings_root') {
          await showProfilePanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'faculties_submenu') {
          await showFacultiesPanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'faculties_root') {
          await showProfilePanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'team_submenu') {
          await showTeamPanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'team_root') {
          await showProfilePanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow.startsWith('team_')) {
          await showTeamPanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meeting_enter_time') {
          chatSessions.set(chatKey, { ...currentSession, flow: 'meeting_enter_date', meetingTime: undefined });
          await sendTelegramKeyboard(chatId, 'Введи дату собрания: например, 14.08.2026, 14.08 или «завтра».', flowKeyboardRows());
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meeting_enter_date') {
          chatSessions.set(chatKey, { ...currentSession, flow: 'meeting_enter_description', meetingDate: undefined });
          await sendTelegramKeyboard(chatId, 'Напиши описание собрания или нажми «Пропустить».', flowKeyboardRows(['Пропустить'], 1));
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meeting_enter_description') {
          chatSessions.set(chatKey, { ...currentSession, flow: 'meeting_enter_topic', topic: '' });
          await sendTelegramKeyboard(chatId, 'Напиши тему собрания одним сообщением.', flowKeyboardRows());
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meeting_enter_topic') {
          if (currentSession.meetingKind === 'competency') {
            chatSessions.set(chatKey, { flow: 'meeting_confirm_competency', meetingKind: 'competency', competency: currentSession.competency, participantIds: currentSession.participantIds });
            await sendTelegramKeyboard(chatId, 'Проверь выбранный блок.', flowKeyboardRows(['Подтвердить'], 1));
            return res.json({ ok: true });
          }
          chatSessions.set(chatKey, { flow: 'meeting_choose_type' });
          await sendTelegramKeyboard(chatId, 'Кого приглашаем?', flowKeyboardRows(['Собрать всю команду', 'Выбрать блок'], 2));
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meeting_confirm_competency') {
          const freshState = loadDatabase();
          const competencies = freshState.competencies || [];
          chatSessions.set(chatKey, { flow: 'meeting_pick_competency' });
          await sendTelegramKeyboard(chatId, 'Выбери блок.', replyPickerRows(competencies));
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meeting_pick_competency') {
          chatSessions.set(chatKey, { flow: 'meeting_choose_type' });
          await sendTelegramKeyboard(chatId, 'Кого приглашаем?', flowKeyboardRows(['Собрать всю команду', 'Выбрать блок'], 2));
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meeting_choose_type') {
          await showMeetingsPanel(chatId, user, state);
          chatSessions.delete(chatKey);
          return res.json({ ok: true });
        }
        chatSessions.delete(chatKey);
        await showProfilePanel(chatId, user, state);
        return res.json({ ok: true });
      }

      if (normalizedText === 'назначить собрание') {
        chatSessions.set(chatKey, { flow: 'meeting_choose_type' });
        await sendTelegramKeyboard(chatId, 'Кого приглашаем?', flowKeyboardRows(['Собрать всю команду', 'Выбрать блок'], 2));
        return res.json({ ok: true });
      }

      if (normalizedText === 'собрать всю команду') {
        if (!user.registered) {
          await sendTelegramKeyboard(chatId, 'Доступ не активирован. Попроси администратора проверить Telegram username в твоём профиле.', [['Профиль'], ['Назад']]);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { flow: 'meeting_enter_topic', meetingKind: 'general', participantIds: [] });
        await sendTelegramKeyboard(chatId, 'Напиши тему собрания одним сообщением.', flowKeyboardRows());
        return res.json({ ok: true });
      }

      if (normalizedText === 'выбрать блок') {
        const freshState = loadDatabase();
        const competencies = freshState.competencies || [];
        if (competencies.length === 0) {
          await sendTelegramKeyboard(chatId, 'Пока нет ни одного блока. Админ может добавить блоки в разделе «Команда».', flowKeyboardRows());
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { flow: 'meeting_pick_competency' });
        await sendTelegramKeyboard(chatId, 'Выбери блок.', replyPickerRows(competencies));
        return res.json({ ok: true });
      }

      
      if (session?.flow === 'meeting_pick_competency') {
        const freshState = loadDatabase();
        const competency = (freshState.competencies || []).find((item) => item.toLowerCase() === normalizedText);
        if (competency) {
          const members = freshState.users.filter((member) => member.competencies?.includes(competency));
          const memberText = members.length
            ? members.map((member) => `• ${userMention(member)}`).join('\n')
            : 'В этом блоке пока никого нет.';
          chatSessions.set(chatKey, { flow: 'meeting_confirm_competency', meetingKind: 'competency', competency, participantIds: members.map((member) => member.id) });
          await sendTelegramKeyboard(chatId, `Выбран блок *${competency}*.\n\nУчастники:\n${memberText}`, flowKeyboardRows(['Подтвердить'], 1));
          return res.json({ ok: true });
        }
      }

      if (session?.flow === 'meeting_confirm_competency' && normalizedText === 'подтвердить') {
        const participantIds = session.participantIds || [];
        if (participantIds.length === 0) {
          await sendTelegramKeyboard(chatId, 'В этом блоке нет участников. Выбери другой блок.', flowKeyboardRows(['Выбрать блок'], 1));
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'meeting_enter_topic' });
        await sendTelegramKeyboard(chatId, 'Напиши тему собрания блока одним сообщением.', flowKeyboardRows());
        return res.json({ ok: true });
      }

      if (session?.flow === 'meeting_enter_topic') {
        if (!text.trim()) {
          await sendTelegramKeyboard(chatId, 'Тема не должна быть пустой. Напиши тему собрания.', flowKeyboardRows());
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'meeting_enter_description', topic: text.trim() });
        await sendTelegramKeyboard(chatId, 'Теперь напиши описание собрания или нажми «Пропустить».', flowKeyboardRows(['Пропустить'], 1));
        return res.json({ ok: true });
      }

      if (session?.flow === 'meeting_enter_description') {
        const description = normalizedText === 'пропустить' ? '' : text.trim();
        chatSessions.set(chatKey, { ...session, flow: 'meeting_enter_date', description });
        await sendTelegramKeyboard(chatId, 'Введи дату собрания: например, 14.08.2026, 14.08 или «завтра».', flowKeyboardRows());
        return res.json({ ok: true });
      }

      if (session?.flow === 'meeting_enter_date') {
        const meetingDate = parseMeetingChatDate(text);
        if (!meetingDate) {
          await sendTelegramKeyboard(chatId, 'Не понял дату. Напиши, например, 14.08.2026, 14.08 или «завтра».', flowKeyboardRows());
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'meeting_enter_time', meetingDate });
        await sendTelegramKeyboard(chatId, 'Введи время: например, 18:00, 18.30 или просто 18.', flowKeyboardRows());
        return res.json({ ok: true });
      }

      if (session?.flow === 'meeting_enter_time') {
        const meetingTime = parseMeetingChatTime(text);
        if (!meetingTime) {
          await sendTelegramKeyboard(chatId, 'Не понял время. Напиши, например, 18:00, 18.30 или просто 18.', flowKeyboardRows());
          return res.json({ ok: true });
        }
        const freshState = loadDatabase();
        const topic = session.topic || 'Собрание';
        const isBlockMeeting = session.meetingKind === 'competency';
        const participantIds = session.participantIds || [];
        if (isBlockMeeting && participantIds.length === 0) {
          await sendTelegramKeyboard(chatId, 'В этом блоке нет участников. Выбери другой блок.', flowKeyboardRows(['Выбрать блок'], 1));
          return res.json({ ok: true });
        }
        const meetingDate = session.meetingDate || nextShortDate(1);
        const scheduleError = meetingScheduleError(meetingDate, meetingTime, 1, freshState.settings, 'meeting');
        if (scheduleError) {
          await sendTelegramKeyboard(chatId, `${scheduleError}. Введи другое время или нажми «Назад», чтобы изменить дату.`, flowKeyboardRows(['Назад'], 1));
          return res.json({ ok: true });
        }
        const meeting = await createMeetingAndNotify(freshState, {
          title: isBlockMeeting ? `Собрание блока ${session.competency}` : 'Общее собрание',
          type: isBlockMeeting ? 'custom' : 'general',
          date: meetingDate,
          time: meetingTime,
          hostId: user.id,
          participants: isBlockMeeting ? participantIds : 'all',
          topic,
          description: session.description || '',
          competency: isBlockMeeting ? session.competency : '',
        });
        chatSessions.delete(chatKey);
        await sendTelegramKeyboard(chatId, `Готово, назначил собрание:\n\n${meetingDetailsText(meeting, loadDatabase())}`, [['Меню', 'Назад'], ['Назначить собрание']], true);
        return res.json({ ok: true });
      }

      if (session?.flow === 'team_search') {
        const query = normalizedText.replace(/^@/, '');
        const matches = state.users.filter((member) => (
          !isFacultyUser(member) && isUserActive(member)
          && `${member.realName} ${member.username}`.toLowerCase().includes(query)
        )).slice(0, 10);
        chatSessions.set(chatKey, { flow: 'team_submenu' });
        await sendTelegramKeyboard(
          chatId,
          matches.length
            ? `*Результаты поиска*\n\n${matches.map((member) => `• ${member.realName} · ${member.username} · ${member.primaryCompetency || 'без блока'}`).join('\n')}`
            : 'Никого не нашёл.',
          [['Назад']],
          false,
          user,
        );
        return res.json({ ok: true });
      }

      if (session?.flow === 'team_add_name') {
        chatSessions.set(chatKey, { ...session, flow: 'team_add_username', draftName: text.trim() });
        await sendTelegramKeyboard(chatId, 'Отправь Telegram username участника в формате @username.', [['Назад']], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'team_add_username') {
        const username = text.trim().startsWith('@') ? text.trim() : `@${text.trim()}`;
        if (!/^@[a-zA-Z0-9_]{5,}$/.test(username)) {
          await sendTelegramKeyboard(chatId, 'Проверь username. Нужен формат @username.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        if (state.users.some((member) => member.username.toLowerCase() === username.toLowerCase())) {
          await sendTelegramKeyboard(chatId, 'Такой Telegram username уже есть в команде.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'team_add_birthday', draftUsername: username });
        await sendTelegramKeyboard(chatId, 'Введи дату рождения полностью: ДД.ММ.ГГГГ.', [['Назад']], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'team_add_birthday') {
        const parts = birthdayParts(text.trim());
        if (!parts?.year || parts.year < 1940 || parts.year > new Date().getFullYear()) {
          await sendTelegramKeyboard(chatId, 'Нужна полная дата в формате ДД.ММ.ГГГГ.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'team_add_role', draftBirthday: formatBirthday(text.trim()) });
        await sendTelegramKeyboard(chatId, 'Выбери роль участника.', [['Организатор', 'Администратор'], ['Назад']], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'team_add_role') {
        const role = normalizedText === 'администратор' ? 'admin' : normalizedText === 'организатор' ? 'organizer' : null;
        if (!role) {
          await sendTelegramKeyboard(chatId, 'Выбери роль кнопкой.', [['Организатор', 'Администратор'], ['Назад']], false, user);
          return res.json({ ok: true });
        }
        const newUser: User = {
          id: `u_${crypto.randomUUID()}`,
          username: session.draftUsername || '',
          realName: session.draftName || session.draftUsername || 'Участник',
          role,
          avatarSeed: session.draftUsername || crypto.randomUUID(),
          birthday: session.draftBirthday,
          registered: false,
          competencies: [],
          primaryCompetency: '',
          facultyId: '',
          joinedAt: new Date().toISOString(),
          lastSeenAt: '',
        };
        state.users.push(newUser);
        state.messages[newUser.id] = [];
        chatSessions.set(chatKey, { flow: 'team_submenu' });
        saveDatabase(state);
        await sendTelegramKeyboard(chatId, `Участник добавлен:\n\n*${newUser.realName}*\n${newUser.username}\n${formatBirthday(newUser.birthday)}\n${roleLabel(newUser.role)}`, [['Назад']], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_scope') {
        const team = state.users.filter((member) => !isFacultyUser(member) && isUserActive(member));
        if (normalizedText === 'блоку') {
          chatSessions.set(chatKey, { ...session, flow: 'task_create_block', taskAssignmentMode: 'block' });
          await sendTaskTelegramKeyboard(chatId, 'Выбери блок.', flowKeyboardRows(state.competencies || [], 3), false, user);
          return res.json({ ok: true });
        }
        if (normalizedText === 'конкретному человеку') {
          chatSessions.set(chatKey, { ...session, flow: 'task_create_person', taskAssignmentMode: 'person' });
          await sendTaskTelegramKeyboard(chatId, 'Выбери исполнителя.', flowKeyboardRows(team.map((member) => member.realName), 3), false, user);
          return res.json({ ok: true });
        }
        if (normalizedText === 'открытая задача') {
          await beginChatTaskDetails(chatId, user, state, { ...session, taskAssignmentMode: 'open', taskAssigneeIds: [] });
          return res.json({ ok: true });
        }
        if (normalizedText === 'вся команда') {
          await beginChatTaskDetails(chatId, user, state, { ...session, taskAssignmentMode: 'team', taskAssigneeIds: team.map((member) => member.id) });
          return res.json({ ok: true });
        }
        await sendTaskTelegramKeyboard(chatId, 'Выбери способ назначения кнопкой.', flowKeyboardRows(['Блоку', 'Конкретному человеку', 'Открытая задача', 'Вся команда'], 2), false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_block') {
        const competency = (state.competencies || []).find((item) => item.toLowerCase() === normalizedText);
        if (!competency) {
          await sendTaskTelegramKeyboard(chatId, 'Выбери блок кнопкой.', flowKeyboardRows(state.competencies || [], 3), false, user);
          return res.json({ ok: true });
        }
        const assigneeIds = state.users
          .filter((member) => !isFacultyUser(member) && isUserActive(member) && member.competencies?.includes(competency))
          .map((member) => member.id);
        if (!assigneeIds.length) {
          await sendTaskTelegramKeyboard(chatId, 'В этом блоке нет участников. Выбери другой блок.', flowKeyboardRows(state.competencies || [], 3), false, user);
          return res.json({ ok: true });
        }
        await beginChatTaskDetails(chatId, user, state, { ...session, taskCompetency: competency, taskAssigneeIds: assigneeIds });
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_person') {
        const member = state.users.find((candidate) => !isFacultyUser(candidate) && isUserActive(candidate) && candidate.realName.toLowerCase() === normalizedText);
        if (!member) {
          await sendTaskTelegramKeyboard(chatId, 'Выбери человека кнопкой.', flowKeyboardRows(state.users.filter((candidate) => !isFacultyUser(candidate) && isUserActive(candidate)).map((candidate) => candidate.realName), 3), false, user);
          return res.json({ ok: true });
        }
        await beginChatTaskDetails(chatId, user, state, { ...session, taskAssigneeIds: [member.id] });
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_event') {
        const activeEvents = (state.events || []).filter((item) => item.status === 'active');
        const workEvent = activeEvents.find((item) => item.name.toLowerCase() === normalizedText);
        if (!workEvent && normalizedText !== 'без мероприятия') {
          await sendTaskTelegramKeyboard(chatId, 'Выбери мероприятие кнопкой.', flowKeyboardRows([...activeEvents.map((item) => item.name), 'Без мероприятия'], 2), false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'task_create_title', taskEventId: workEvent?.id || '' });
        await sendTaskTelegramKeyboard(chatId, 'Напиши название задачи.', flowKeyboardRows(), false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_title') {
        chatSessions.set(chatKey, { ...session, flow: 'task_create_description', taskTitle: text.trim() });
        await sendTaskTelegramKeyboard(chatId, 'Напиши короткое описание задачи.', flowKeyboardRows(), false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_description') {
        chatSessions.set(chatKey, { ...session, flow: 'task_create_deadline', taskDescription: text.trim() });
        await sendTaskTelegramKeyboard(chatId, 'Введи дедлайн в формате ДД.ММ.ГГ.', flowKeyboardRows(), false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_deadline') {
        if (!parseShortDate(text.trim())) {
          await sendTaskTelegramKeyboard(chatId, 'Не понял дату. Используй формат ДД.ММ.ГГ.', flowKeyboardRows(), false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'task_create_priority', taskDeadline: formatShortDate(text.trim()) });
        await sendTaskTelegramKeyboard(chatId, 'Выбери приоритет задачи.', flowKeyboardRows(['Обычная', 'Важная', 'Очень важная'], 3), false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_priority') {
        const priority = normalizedText === 'обычная'
          ? 'normal'
          : normalizedText === 'важная'
            ? 'important'
            : normalizedText === 'очень важная'
              ? 'critical'
              : null;
        if (!priority) {
          await sendTaskTelegramKeyboard(chatId, 'Выбери приоритет кнопкой.', flowKeyboardRows(['Обычная', 'Важная', 'Очень важная'], 3), false, user);
          return res.json({ ok: true });
        }
        await finishChatTask(chatId, user, state, session, priority);
        return res.json({ ok: true });
      }

      if (cmd.startsWith('/start')) {
        await showWelcomePanel(chatId, user);
        saveDatabase(state);
        return res.json({ ok: true });
      } else if (isRegistrationPrompt(text)) {
        await showProfilePanel(chatId, user, state);
        saveDatabase(state);
        return res.json({ ok: true });
      } else if (cmd.startsWith('/slots') || cmd === 'слоты') {
        await showSlotsPanel(chatId, user, state);
        saveDatabase(state);
        return res.json({ ok: true });
      } else if (isOpenAppText(text)) {
        replyText = 'Открывай приложение кнопкой снизу. Если Telegram не открыл его автоматически, нажми кнопку ещё раз.';
      } else if (cmd.startsWith('/meetings') || cmd === 'встречи') {
        if (!user.registered) {
          await sendTelegramKeyboard(chatId, 'Доступ не активирован. Попроси администратора проверить Telegram username в твоём профиле.', [['Профиль'], ['Назад']]);
          return res.json({ ok: true });
        } else {
          await showMeetingsPanel(chatId, user, state);
          return res.json({ ok: true });
        }
      } else if (cmd.startsWith('/tasks') || cmd === 'задачи') {
        if (!user.registered) {
          replyText = 'Доступ не активирован. Попроси администратора проверить Telegram username в твоём профиле.';
        } else {
          await showTasksPanel(chatId, user, state);
          return res.json({ ok: true });
        }
      } else if (normalizedText === 'свободные задачи') {
        const openTasks = state.tasks.filter((task) => task.status === 'open').slice(0, 10);
        chatSessions.set(chatKey, { flow: 'tasks_submenu' });
        await sendTaskInlinePanel(
          chatId,
          openTasks.length
            ? `*Свободные задачи*\n\n${openTasks.map((task, index) => `${index + 1}. ${task.title} · ${formatShortDate(task.deadline) || 'без даты'}`).join('\n')}`
            : 'Свободных задач сейчас нет.',
          [
            ...openTasks.map((task) => [{ text: 'Взять', callback_data: `task_claim:${task.id}` }]),
          ],
        );
        await sendNavigationKeyboard(chatId, [['Меню']], user);
        return res.json({ ok: true });
      } else if (normalizedText === 'выполненные задачи') {
        const completed = state.tasks
          .filter((task) => assignedIds(task).includes(user.id) && task.status === 'completed')
          .slice(-10)
          .reverse();
        chatSessions.set(chatKey, { flow: 'tasks_submenu' });
        await sendTaskTelegramKeyboard(
          chatId,
          completed.length
            ? `*Последние выполненные задачи*\n\n${completed.map((task) => `• ${task.title}`).join('\n')}`
            : 'Выполненных задач пока нет.',
          [['Назад']],
          false,
          user,
        );
        return res.json({ ok: true });
      } else if (normalizedText === 'управлять задачами') {
        const myTasks = state.tasks.filter((task) => assignedIds(task).includes(user.id) && !['completed', 'cancelled'].includes(task.status)).slice(0, 10);
        chatSessions.set(chatKey, { flow: 'tasks_submenu' });
        if (myTasks.length) {
          for (const [index, task] of myTasks.entries()) {
            await sendTaskInlinePanel(
              chatId,
              `*${task.title}*\nСтатус: ${taskStatusLabel(task.status)}`,
              [[
                { text: 'Выполнено', callback_data: `task_complete:${task.id}` },
                { text: 'Отказаться', callback_data: `task_release:${task.id}` },
              ]],
              index === 0,
            );
          }
        } else {
          await sendTaskInlinePanel(chatId, 'Активных задач нет.', []);
        }
        await sendNavigationKeyboard(chatId, [['Меню']], user);
        return res.json({ ok: true });
      } else if (normalizedText === 'создать задачу') {
        chatSessions.set(chatKey, { flow: 'task_create_scope' });
        await sendTaskTelegramKeyboard(
          chatId,
          'Как назначить задачу?',
          flowKeyboardRows(['Блоку', 'Конкретному человеку', 'Открытая задача', 'Вся команда'], 2),
          false,
          user,
        );
        return res.json({ ok: true });
      } else if (cmd === 'команда') {
        await showTeamPanel(chatId, user, state);
        return res.json({ ok: true });
      } else if (normalizedText === 'найти участника') {
        chatSessions.set(chatKey, { flow: 'team_search' });
        await sendTelegramKeyboard(chatId, 'Введи имя, фамилию или Telegram username.', [['Назад']], false, user);
        return res.json({ ok: true });
      } else if (normalizedText === 'добавить участника') {
        if (user.role !== 'admin') {
          await sendTelegramKeyboard(chatId, 'Добавлять участников может только администратор.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { flow: 'team_add_name' });
        await sendTelegramKeyboard(chatId, 'Введи имя и фамилию участника.', [['Назад']], false, user);
        return res.json({ ok: true });
      } else if (cmd === 'мф') {
        await showFacultiesPanel(chatId, user, state);
        return res.json({ ok: true });
      } else if (normalizedText === 'задачи факультетов') {
        const facultyTasks = state.tasks.filter((task) => task.facultyId && !['completed', 'cancelled'].includes(task.status)).slice(0, 12);
        chatSessions.set(chatKey, { flow: 'faculties_submenu' });
        await sendTelegramKeyboard(
          chatId,
          facultyTasks.length
            ? `*Активные задачи факультетов*\n\n${facultyTasks.map((task) => `• ${task.title} · ${formatShortDate(task.deadline)}`).join('\n')}`
            : 'Активных задач факультетов нет.',
          [['Назад']],
          false,
          user,
        );
        return res.json({ ok: true });
      } else if (cmd.startsWith('/help') || cmd === 'помощь') {
        replyText = '*Что умеет бот*\n\n'
          + '*Профиль* — личная сводка и статистика.\n'
          + '*Слоты* — отметить свободные часы кнопками.\n'
          + '*Встречи* — посмотреть и назначить собрание.\n'
          + '*Задачи* — личные, свободные и выполненные задачи.\n'
          + `${user.role === 'admin' ? '*МФ* — факультеты и их задачи.\n' : ''}`
          + '\nВ командном чате доступны /all, /meeting, /deadlines, /slots, /birthdays и /checkin.';
      } else {
        replyText = 'Выбери раздел кнопкой внизу.';
      }
      state.messages[user.id].push({
        id: `bot_${crypto.randomUUID()}`,
        userId: user.id,
        sender: 'bot',
        text: replyText,
        timestamp: new Date().toISOString(),
        buttons
      });

      saveDatabase(state);

      await sendTelegramKeyboard(chatId, replyText, buildChatKeyboard(false, user).keyboard.map((row: any[]) => row.map((item) => item.text)), false, user);
    }

    return res.json({ ok: true });
  }

  async function queueTelegramUpdate(update: any) {
    const chatKey = String(
      update.callback_query?.message?.chat?.id
      || update.callback_query?.from?.id
      || update.message?.chat?.id
      || update.chat_member?.chat?.id
      || update.my_chat_member?.chat?.id
      || 'unknown',
    );
    const previous = telegramChatUpdateQueues.get(chatKey) || Promise.resolve();
    let releaseQueue!: () => void;
    const gate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    telegramChatUpdateQueues.set(chatKey, tail);
    await previous.catch(() => undefined);
    try {
      return await handleTelegramUpdate(update);
    } finally {
      releaseQueue();
      void tail.finally(() => {
        if (telegramChatUpdateQueues.get(chatKey) === tail) telegramChatUpdateQueues.delete(chatKey);
      });
    }
  }

  function persistTelegramUpdates(updates: unknown[]) {
    return mutateDatabaseAtomically((state) => recordTelegramUpdates(state, updates)).value;
  }

  async function flushTelegramInbox() {
    markWorkerHeartbeat('telegram_inbox');
    if (telegramInboxFlushPromise) return telegramInboxFlushPromise;
    telegramInboxFlushPromise = (async () => {
      while (true) {
        const snapshot = loadDatabase();
        const inbox = snapshot.settings?.telegramInbox || [];
        const nowMs = Date.now();
        const candidate = inbox.slice().sort((a, b) => a.updateId - b.updateId).find((entry) => {
          const due = ((entry.status === 'received' || entry.status === 'retry') && Date.parse(entry.availableAt) <= nowMs)
            || (entry.status === 'processing' && (!entry.leasedUntil || Date.parse(entry.leasedUntil) <= nowMs));
          if (!due) return false;
          return !inbox.some((earlier) => earlier.chatKey === entry.chatKey && earlier.updateId < entry.updateId
            && earlier.status !== 'completed' && earlier.status !== 'failed');
        });
        if (!candidate) break;
        const claimed = mutateDatabaseAtomically((state) => {
          const entry = state.settings?.telegramInbox?.find((item) => item.updateId === candidate.updateId);
          if (!entry) return undefined;
          const leaseToken = claimTelegramInboxEntry(entry, new Date());
          return leaseToken ? { entry: structuredClone(entry), leaseToken } : undefined;
        }).value;
        if (!claimed) continue;
        try {
          const failOnceId = Number(process.env.TELEGRAM_INBOX_FAIL_UPDATE_ONCE || -1);
          if (claimed.entry.updateId === failOnceId && claimed.entry.attempts === 1) {
            throw new Error('Injected Telegram inbox processing failure');
          }
          await queueTelegramUpdate(claimed.entry.payload);
          mutateDatabaseAtomically((state) => {
            const entry = state.settings?.telegramInbox?.find((item) => item.updateId === claimed.entry.updateId);
            if (entry) completeTelegramInboxEntry(entry, claimed.leaseToken);
          });
        } catch (error) {
          console.error(`Telegram inbox update ${claimed.entry.updateId} failed:`, error);
          mutateDatabaseAtomically((state) => {
            const entry = state.settings?.telegramInbox?.find((item) => item.updateId === claimed.entry.updateId);
            if (entry) failTelegramInboxEntry(entry, claimed.leaseToken, error);
          });
        }
      }
    })().finally(() => { telegramInboxFlushPromise = null; });
    return telegramInboxFlushPromise;
  }

  app.post('/api/telegram-webhook', async (req, res, next) => {
    try {
      const update = req.body || {};
      if (!Number.isSafeInteger(Number(update.update_id)) || Number(update.update_id) < 0) {
        return res.status(400).json({ error: 'Telegram update_id is required' });
      }
      const persisted = persistTelegramUpdates([update]);
      const processing = flushTelegramInbox();
      if (process.env.TELEGRAM_INBOX_AWAIT_PROCESSING === 'true') await processing;
      return res.json({ ok: true, updateId: Number(update.update_id), duplicate: persisted.inserted.length === 0 });
    } catch (error) {
      return next(error);
    }
  });

  // Add a new user (Team member)
  app.post('/api/user/add', (req, res) => {
    const { requesterId, realName, username, role, birthday } = req.body;
    const state = loadDatabase();

    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Добавлять участников может только админ' });
    }

    if (!realName || !username) {
      return res.status(400).json({ error: 'Имя и Telegram username обязательны' });
    }
    if (birthday && !birthdayParts(birthday)?.year) {
      return res.status(400).json({ error: 'Укажи дату рождения полностью: ДД.ММ.ГГГГ' });
    }

    const sanitizedUsername = username.startsWith('@') ? username : '@' + username;

    // Check if username already exists
    const exists = state.users.some(u => u.username.toLowerCase() === sanitizedUsername.toLowerCase());
    if (exists) {
      return res.status(400).json({ error: 'Пользователь с таким Telegram username уже есть в команде' });
    }

    const newUserId = `u_${crypto.randomUUID()}`;
    const newUser: User = {
      id: newUserId,
      username: sanitizedUsername,
      realName,
      role: role || 'organizer',
      avatarSeed: realName.toLowerCase().replace(/[^a-z]/g, '') || 'user',
      birthday: birthday || '',
      registered: false,
      joinedAt: new Date().toISOString(),
      lastSeenAt: '',
    };

    state.users.push(newUser);

    // Initialize empty message history with a welcome message
    state.messages[newUserId] = [
      {
        id: `msg_welcome_${crypto.randomUUID()}`,
        userId: newUserId,
        sender: 'bot',
        text: `Привет, ${realName}! Тебя добавили в команду как ${role === 'admin' ? 'админа' : 'организатора'}. Открой Mini App, чтобы отметить свободные слоты.`,
        timestamp: new Date().toISOString()
      }
    ];

    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить изменение. Повторите позже.' });
    res.json({ success: true, user: newUser });
  });

  // Delete a user (Team member)
  app.post('/api/user/delete', (req, res) => {
    const { requesterId, userId, confirmTaskRelease } = req.body;
    const state = loadDatabase();

    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Удалять участников может только админ' });
    }

    const result = deactivateUser(state, String(userId || ''), requesterId, confirmTaskRelease === true);
    if (!result.ok) return res.status(result.status).json(result);
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить изменение. Повторите позже.' });
    revokeUserSessions(userId);
    res.json({ success: true, user: result.user, impact: result.impact });
  });

  // Update user birthday or details
  app.post('/api/user/update', (req, res) => {
    const { requesterId, userId, realName, username, role, birthday, competencies, primaryCompetency, avatarDataUrl } = req.body;
    const state = loadDatabase();

    const selfEditOnly = requesterId === userId && role === undefined
      && (realName !== undefined || username !== undefined || birthday !== undefined || Array.isArray(competencies) || primaryCompetency !== undefined || avatarDataUrl !== undefined);
    if (!isAdminUser(state, requesterId) && !selfEditOnly) {
      return res.status(403).json({ error: 'Редактировать участников может только админ' });
    }

    const user = state.users.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const cleanRealName = String(realName || '').trim();
    if (realName !== undefined && !cleanRealName) {
      return res.status(400).json({ error: 'Имя не должно быть пустым' });
    }
    if (cleanRealName) user.realName = cleanRealName;
    if (username !== undefined) {
      const cleanUsername = String(username || '').trim();
      const sanitizedUsername = cleanUsername.startsWith('@') ? cleanUsername : `@${cleanUsername}`;
      if (!/^@[a-zA-Z0-9_]{5,}$/.test(sanitizedUsername) && sanitizedUsername.toLowerCase() !== user.username.toLowerCase()) {
        return res.status(400).json({ error: 'Проверь Telegram username: нужен формат @username' });
      }
      const usernameTaken = state.users.some((member) => member.id !== user.id && member.username.toLowerCase() === sanitizedUsername.toLowerCase());
      if (usernameTaken) return res.status(400).json({ error: 'Такой Telegram username уже используется' });
      user.username = sanitizedUsername;
    }
    if (role !== undefined) {
      if (role !== 'admin' && role !== 'organizer') return res.status(400).json({ error: 'Неизвестная роль участника' });
      if (user.role === 'admin' && role !== 'admin') {
        const activeAdmins = state.users.filter((member) => member.role === 'admin' && isUserActive(member));
        if (activeAdmins.length <= 1) return res.status(409).json({ error: 'Нельзя изменить роль последнего активного администратора' });
      }
      user.role = role;
    }
    if (birthday !== undefined) {
      const parsedBirthday = birthdayParts(birthday);
      if (birthday && !parsedBirthday) {
        return res.status(400).json({ error: 'Проверь дату рождения' });
      }
      user.birthday = birthday;
    }
    if (Array.isArray(competencies)) {
      user.competencies = competencies.filter((item: string) => state.competencies?.includes(item));
    }
    if (primaryCompetency !== undefined) {
      const cleanPrimary = String(primaryCompetency || '').trim();
      user.primaryCompetency = state.competencies?.includes(cleanPrimary) ? cleanPrimary : '';
      if (user.primaryCompetency && !user.competencies?.includes(user.primaryCompetency)) {
        user.competencies = [user.primaryCompetency, ...(user.competencies || [])];
      }
    }
    if (avatarDataUrl !== undefined) {
      const cleanAvatar = String(avatarDataUrl || '');
      if (cleanAvatar && (!/^data:image\/(?:jpeg|png|webp);base64,/i.test(cleanAvatar) || cleanAvatar.length > 300_000)) {
        return res.status(400).json({ error: 'Не удалось сохранить аватар: проверь формат изображения' });
      }
      user.avatarDataUrl = cleanAvatar || undefined;
    }

    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить изменение. Повторите позже.' });
    res.json({ success: true, user });
  });

  app.post('/api/competency/add', (req, res) => {
    const { requesterId, name } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Компетенции может менять только админ' });
    }
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'Название блока обязательно' });
    if (!state.competencies) state.competencies = [];
    if (!state.competencies.some((item) => item.toLowerCase() === cleanName.toLowerCase())) {
      state.competencies.push(cleanName);
    }
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить изменение. Повторите позже.' });
    refreshGroupCommandMenus();
    res.json({ success: true, competencies: state.competencies });
  });

  app.post('/api/competency/delete', (req, res) => {
    const { requesterId, name } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Компетенции может менять только админ' });
    }
    const cleanName = String(name || '').trim();
    state.competencies = (state.competencies || []).filter((item) => item !== cleanName);
    state.users.forEach((user) => {
      user.competencies = (user.competencies || []).filter((item) => item !== cleanName);
      if (user.primaryCompetency === cleanName) user.primaryCompetency = '';
    });
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить изменение. Повторите позже.' });
    refreshGroupCommandMenus();
    res.json({ success: true, competencies: state.competencies });
  });

  app.post('/api/faculty/competency/add', (req, res) => {
    const { requesterId, name } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Компетенции факультетов может менять только админ' });
    }
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'Название компетенции обязательно' });
    if (!state.facultyCompetencies) state.facultyCompetencies = [];
    if (!state.facultyCompetencies.some((item) => item.toLowerCase() === cleanName.toLowerCase())) {
      state.facultyCompetencies.push(cleanName);
    }
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить изменение. Повторите позже.' });
    res.json({ success: true, facultyCompetencies: state.facultyCompetencies });
  });

  app.post('/api/faculty/competency/delete', (req, res) => {
    const { requesterId, name } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Компетенции факультетов может менять только админ' });
    }
    const cleanName = String(name || '').trim();
    state.facultyCompetencies = (state.facultyCompetencies || []).filter((item) => item !== cleanName);
    state.users.forEach((user) => {
      if (!isFacultyUser(user)) return;
      user.competencies = (user.competencies || []).filter((item) => item !== cleanName);
      if (user.primaryCompetency === cleanName) user.primaryCompetency = '';
    });
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить изменение. Повторите позже.' });
    res.json({ success: true, facultyCompetencies: state.facultyCompetencies });
  });

  app.post('/api/faculty/user/add', (req, res) => {
    const { requesterId, realName, username, role, facultyId, competencies } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Добавлять ответственных может только админ' });
    }
    if (!realName || !username || !facultyId || !['faculty_responsible', 'faculty_helper'].includes(role)) {
      return res.status(400).json({ error: 'Заполни имя, Telegram, факультет и роль' });
    }
    const cleanCompetencies = Array.isArray(competencies)
      ? competencies.filter((item: string) => state.facultyCompetencies?.includes(item))
      : [];
    const sanitizedUsername = username.startsWith('@') ? username : '@' + username;
    let user = state.users.find((u) => u.username.toLowerCase() === sanitizedUsername.toLowerCase());
    if (user) {
      user.realName = realName;
      user.role = role;
      user.facultyId = facultyId;
      user.registered = Boolean(user.telegramId);
      user.competencies = cleanCompetencies;
      user.primaryCompetency = user.competencies[0] || '';
    } else {
      user = {
        id: `u_${crypto.randomUUID()}`,
        username: sanitizedUsername,
        realName,
        role,
        facultyId,
        avatarSeed: sanitizedUsername.toLowerCase(),
        birthday: '',
        registered: false,
        competencies: cleanCompetencies,
        primaryCompetency: cleanCompetencies[0] || '',
        joinedAt: new Date().toISOString(),
        lastSeenAt: '',
      };
      state.users.push(user);
      state.messages[user.id] = [];
    }
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить изменение. Повторите позже.' });
    res.json({ success: true, user });
  });

  app.post('/api/faculty/user/update', (req, res) => {
    const { requesterId, userId, realName, username, role, facultyId, competencies } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Редактировать ответственных может только админ' });
    }
    const user = state.users.find((u) => u.id === userId);
    if (!user || !isFacultyUser(user)) return res.status(404).json({ error: 'Ответственный не найден' });
    if (!realName || !username || !facultyId || !['faculty_responsible', 'faculty_helper'].includes(role)) {
      return res.status(400).json({ error: 'Заполни имя, Telegram, факультет и роль' });
    }
    const sanitizedUsername = username.startsWith('@') ? username : '@' + username;
    const duplicate = state.users.find((u) => u.id !== userId && u.username.toLowerCase() === sanitizedUsername.toLowerCase());
    if (duplicate) {
      return res.status(400).json({ error: 'Пользователь с таким Telegram username уже есть' });
    }
    const cleanCompetencies = Array.isArray(competencies)
      ? competencies.filter((item: string) => state.facultyCompetencies?.includes(item))
      : [];
    user.realName = realName;
    user.username = sanitizedUsername;
    user.role = role;
    user.facultyId = facultyId;
    user.competencies = cleanCompetencies;
    user.primaryCompetency = user.competencies[0] || '';
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить изменение. Повторите позже.' });
    res.json({ success: true, user });
  });

  app.post('/api/faculty/user/delete', (req, res) => {
    const { requesterId, userId, confirmTaskRelease } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Удалять ответственных может только админ' });
    }
    const user = state.users.find((u) => u.id === userId);
    if (!user || !isFacultyUser(user)) return res.status(404).json({ error: 'Ответственный не найден' });
    const result = deactivateUser(state, String(userId || ''), requesterId, confirmTaskRelease === true);
    if (!result.ok) return res.status(result.status).json(result);
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить изменение. Повторите позже.' });
    revokeUserSessions(userId);
    res.json({ success: true, user: result.user, impact: result.impact });
  });

  app.post('/api/faculty/task/create', async (req, res) => {
    const { requesterId, facultyId, title, description, deadline, assignedTo, reminders, competency, eventId } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId) && !state.users.some((u) => u.id === requesterId && u.role === 'organizer')) {
      return res.status(403).json({ error: 'Создавать задачи факультетам могут только мегаорги' });
    }
    const validationErrors = taskPayloadFieldErrors({ title, description, deadline, assignedTo, reminders, competency, eventId }, true);
    const facultyIdError = textFieldError(facultyId, 200, true);
    if (facultyIdError) validationErrors.facultyId = facultyIdError;
    if (Object.keys(validationErrors).length) return validationErrorResponse(res, validationErrors);
    const assigneeIds = sanitizeTaskAssigneeIds(
      state.users,
      Array.isArray(assignedTo) ? assignedTo.filter(Boolean) : [],
      String(facultyId || ''),
    );
    if (!facultyId || !title || !deadline || assigneeIds.length === 0) {
      return res.status(400).json({ error: 'Заполни факультет, название, дедлайн и исполнителей' });
    }
    if (!parseProjectLocalDate(String(deadline))) {
      return res.status(400).json({ error: 'Укажи существующую календарную дату дедлайна' });
    }
    const cleanEventId = String(eventId || '').trim();
    if (cleanEventId && !state.events?.some((item) => item.id === cleanEventId && item.status === 'active')) {
      return res.status(400).json({ error: 'Выбранное мероприятие не найдено или уже завершено' });
    }
    const cleanReminders: TaskReminder[] = Array.isArray(reminders)
      ? reminders.filter((item: any) => Number(item.value) > 0).slice(0, 3).map((item: any, index: number) => ({
          id: `rem_${crypto.randomUUID()}`,
          type: item.type === 'repeat' ? 'repeat' : 'before_deadline',
          value: Math.max(1, Number(item.value) || 1),
          unit: item.unit === 'hours' ? 'hours' : 'days',
        }))
      : [];
    const task: Task = {
      id: `t_${crypto.randomUUID()}`,
      version: 1,
      title,
      description: String(description || '').trim(),
      deadline,
      assignedTo: assigneeIds,
      creatorId: requesterId,
      facultyId,
      eventId: cleanEventId,
      competency: String(competency || '').trim() || 'Факультет',
      sow: '',
      tips: [],
      status: 'waiting',
      priority: 'normal',
      createdAt: new Date().toISOString(),
      completedAt: '',
      assignmentMode: 'shared',
      reminders: cleanReminders,
    };
    state.tasks.push(task);
    const notifications: Array<{ target: User; text: string }> = [];
    for (const target of resolveTaskAudienceUsers(state.users, task)) {
      const text = `Новая задача от MEGABATTLE:\n\n${taskDetailsText(task, state)}\n\nЧтобы поменять статус, нажми «Мои задачи».`;
      if (!state.messages[target.id]) state.messages[target.id] = [];
      state.messages[target.id].push({
        id: `faculty_task_created_${crypto.randomUUID()}`,
        userId: target.id,
        sender: 'bot',
        text,
        timestamp: new Date().toISOString(),
      });
      if (target?.telegramId) {
        notifications.push({ target, text });
      }
    }
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось сохранить задачу. Повторите позже.' });
    await Promise.allSettled(notifications.map(({ target, text }) => sendTaskTelegramMessage(
      target.telegramId!, text, undefined, false, target,
    )));
    res.json({ success: true, task });
  });

  app.post('/api/faculty/task/update', async (req, res) => {
    const { requesterId, taskId, version, title, description, deadline, assignedTo, reminders, facultyId, competency, eventId } = req.body;
    const state = loadDatabase();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });
    if (task.status === 'cancelled') return res.status(409).json({ error: 'Отменённую задачу нельзя редактировать' });
    if (task.creatorId !== requesterId && !isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Редактировать задачу может автор или админ' });
    }
    if (version !== undefined && Number(version) !== Number(task.version || 1)) {
      return res.status(409).json({ error: 'Задача уже изменилась. Обновите данные и повторите правку.' });
    }
    const validationErrors = taskPayloadFieldErrors({ title, description, deadline, assignedTo, reminders, competency, eventId }, false);
    if (facultyId !== undefined) {
      const facultyIdError = textFieldError(facultyId, 200, true);
      if (facultyIdError) validationErrors.facultyId = facultyIdError;
    }
    if (Object.keys(validationErrors).length) return validationErrorResponse(res, validationErrors);
    const previousAssigneeIds = new Set(assignedIds(task));
    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (deadline !== undefined) {
      if (!parseProjectLocalDate(String(deadline))) return res.status(400).json({ error: 'Укажи существующую календарную дату дедлайна' });
      task.deadline = deadline;
    }
    if (facultyId !== undefined) task.facultyId = facultyId;
    if (competency !== undefined) task.competency = String(competency || '').trim() || 'Факультет';
    if (eventId !== undefined) {
      const cleanEventId = String(eventId || '').trim();
      if (cleanEventId && !state.events?.some((item) => item.id === cleanEventId)) return res.status(400).json({ error: 'Мероприятие не найдено' });
      task.eventId = cleanEventId;
    }
    if (Array.isArray(assignedTo)) {
      const assigneeIds = sanitizeTaskAssigneeIds(state.users, assignedTo.filter(Boolean), task.facultyId);
      task.assignedTo = assigneeIds.length ? assigneeIds : null;
    } else if (facultyId !== undefined) {
      const assigneeIds = sanitizeTaskAssigneeIds(state.users, assignedIds(task), task.facultyId);
      task.assignedTo = assigneeIds.length ? assigneeIds : null;
    }
    if (Array.isArray(reminders)) {
      task.reminders = reminders.filter((item: any) => Number(item.value) > 0).slice(0, 3).map((item: any, index: number) => ({
        id: item.id || `rem_${crypto.randomUUID()}`,
        type: item.type === 'repeat' ? 'repeat' : 'before_deadline',
        value: Math.max(1, Number(item.value) || 1),
        unit: item.unit === 'hours' ? 'hours' : 'days',
        sentAt: item.sentAt,
        lastSentAt: item.lastSentAt,
      }));
    }
    task.version = Number(task.version || 1) + 1;
    const currentAssigneeIds = new Set(assignedIds(task));
    const notificationIds = new Set([...previousAssigneeIds, ...currentAssigneeIds]);
    const notifications: Array<{ target: User; text: string }> = [];
    for (const id of notificationIds) {
      const target = state.users.find((user) => user.id === id);
      if (!target || !isUserActive(target)) continue;
      const text = currentAssigneeIds.has(id)
        ? `Задача обновлена.\n\n${taskDetailsText(task, state)}`
        : `Назначение снято.\n\nВы больше не исполнитель задачи «${task.title}».`;
      if (!state.messages[target.id]) state.messages[target.id] = [];
      state.messages[target.id].push({
        id: `faculty_task_updated_${crypto.randomUUID()}`,
        userId: target.id,
        sender: 'bot',
        text,
        timestamp: new Date().toISOString(),
      });
      if (target.telegramId) {
        notifications.push({ target, text });
      }
    }
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось сохранить задачу. Повторите позже.' });
    await Promise.allSettled(notifications.map(({ target, text }) => sendTaskTelegramMessage(
      target.telegramId!, text, undefined, false, target,
    )));
    res.json({ success: true, task });
  });

  app.post('/api/availability/weeks', async (req, res) => {
    const { requesterId, weeks, activeDays, startHour, endHour, notifyTeam = false } = req.body || {};
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) return res.status(403).json({ error: 'Admin access required' });
    const weekCount = Number(weeks);
    if (!Number.isInteger(weekCount) || weekCount < 2 || weekCount > 5) {
      return res.status(400).json({ error: 'Количество недель должно быть от 2 до 5' });
    }
    const requestedActiveDays = Array.isArray(activeDays)
      ? [...new Set(activeDays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b)
      : normalizeAvailabilityConfig(state.settings).activeDays;
    const requestedStartHour = Number(startHour ?? normalizeAvailabilityConfig(state.settings).startHour);
    const requestedEndHour = Number(endHour ?? normalizeAvailabilityConfig(state.settings).endHour);
    if (!requestedActiveDays.length) return res.status(400).json({ error: 'Выбери хотя бы один день недели' });
    if (!Number.isInteger(requestedStartHour) || !Number.isInteger(requestedEndHour)
      || requestedStartHour < 0 || requestedEndHour > 23 || requestedEndHour < requestedStartHour) {
      return res.status(400).json({ error: 'Проверь диапазон времени: начало и конец должны быть от 00:00 до 23:00' });
    }
    state.settings = {
      ...(state.settings || {}),
      availabilityWeekCount: weekCount,
      availabilityActiveDays: requestedActiveDays,
      availabilityStartHour: requestedStartHour,
      availabilityEndHour: requestedEndHour,
    };
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить настройки доступности. Повторите позже.' });
    chatSlotDrafts.clear();
    persistChatPanelMessageIds();
    let googleSheetsWeeks: unknown = null;
    if (sheetsConfig) {
      try {
        googleSheetsWeeks = await ensurePrimaryWeekSheet(sheetsConfig, state.users, state.settings);
        await exportAvailabilitiesToSheet(sheetsConfig, state.users, state.availabilities);
      }
      catch (error: any) {
        console.error('Google Sheets primary week update failed:', error);
        return res.status(502).json({ error: error.message || 'Не удалось обновить текущую неделю на листе ОСНОВА' });
      }
    }
    let notified = 0;
    if (notifyTeam) {
      const weekWord = weekCount >= 5 ? 'недель' : 'недели';
      const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
      const text = `Пожалуйста, заполните свободные слоты на ${weekCount} ${weekWord} вперёд в Mini App.`
        + `\nДни: ${requestedActiveDays.map((day) => dayNames[day]).join(', ')}.`
        + `\nВремя: ${String(requestedStartHour).padStart(2, '0')}:00–${String(requestedEndHour).padStart(2, '0')}:00.`;
      const recipients = state.users.filter((user) => !isFacultyUser(user) && isUserActive(user) && user.registered && user.telegramId);
      recipients.forEach((user) => {
        if (!state.messages[user.id]) state.messages[user.id] = [];
        state.messages[user.id].push({
          id: `availability_horizon_${crypto.randomUUID()}`,
          userId: user.id,
          sender: 'bot',
          text,
          timestamp: new Date().toISOString(),
          buttons: [{ text: 'Заполнить слоты', action: 'open_tma' }],
        });
      });
      if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить уведомления. Повторите позже.' });
      const results = await Promise.allSettled(recipients.map((user) => sendTelegramMessage(user.telegramId!, text, [{ text: 'Заполнить слоты', action: 'open_tma' }], false, user)));
      notified = results.filter((result) => result.status === 'fulfilled' && result.value).length;
    }
    return res.json({ success: true, weeks: weekCount, activeDays: requestedActiveDays, startHour: requestedStartHour, endHour: requestedEndHour, notified, googleSheets: googleSheetsWeeks });
  });

  app.post('/api/availability/week-name', (req, res) => {
    const { requesterId, weekIndex, weekStart, name, description } = req.body || {};
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) return res.status(403).json({ error: 'Редактировать неделю может только администратор' });
    const { weekCount, weekStarts, weekNames, weekDescriptions, weekMetadata } = normalizeAvailabilityConfig(state.settings);
    const index = Number(weekIndex);
    const cleanName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const cleanDescription = String(description || '').replace(/\r\n?/g, '\n').trim().slice(0, 600);
    if (!Number.isInteger(index) || index < 0 || index >= weekCount) return res.status(400).json({ error: 'Неизвестная неделя' });
    const targetWeekStart = weekStarts[index];
    if (weekStart !== targetWeekStart) {
      return res.status(409).json({ error: 'Список недель уже обновился. Перезагрузи страницу и повтори изменение.' });
    }
    if (!cleanName) return res.status(400).json({ error: 'Название недели не может быть пустым' });
    const nextNames = [...weekNames];
    const nextDescriptions = [...weekDescriptions];
    nextNames[index] = cleanName;
    nextDescriptions[index] = cleanDescription;
    state.settings = {
      ...(state.settings || {}),
      availabilityWeekNames: nextNames,
      availabilityWeekDescriptions: nextDescriptions,
      availabilityWeekMetadata: {
        ...weekMetadata,
        [targetWeekStart]: { name: cleanName, description: cleanDescription },
      },
    };
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить неделю. Повторите позже.' });
    return res.json({ success: true, weekIndex: index, weekStart: targetWeekStart, name: cleanName, description: cleanDescription });
  });

  app.post('/api/event/create', (req, res) => {
    const { requesterId, name, description, startsAt, endsAt } = req.body || {};
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) return res.status(403).json({ error: 'Добавлять мероприятия может только администратор' });
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'Укажи название мероприятия' });
    if (state.events?.some((item) => item.status === 'active' && item.name.toLowerCase() === cleanName.toLowerCase())) {
      return res.status(409).json({ error: 'Активное мероприятие с таким названием уже существует' });
    }
    const workEvent: WorkEvent = {
      id: `event_${crypto.randomUUID()}`,
      name: cleanName,
      description: String(description || '').trim(),
      startsAt: String(startsAt || '').trim(),
      endsAt: String(endsAt || '').trim(),
      status: 'active',
      createdAt: new Date().toISOString(),
      createdBy: requesterId,
    };
    state.events = [...(state.events || []), workEvent];
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить мероприятие. Повторите позже.' });
    return res.json({ success: true, event: workEvent });
  });

  app.post('/api/event/update', (req, res) => {
    const { requesterId, eventId, name, description, startsAt, endsAt, status } = req.body || {};
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) return res.status(403).json({ error: 'Изменять мероприятия может только администратор' });
    const workEvent = state.events?.find((item) => item.id === eventId);
    if (!workEvent) return res.status(404).json({ error: 'Мероприятие не найдено' });
    const nextName = name === undefined ? workEvent.name : String(name || '').trim();
    const nextStatus = status === undefined ? workEvent.status : status;
    if (nextStatus === 'active' && state.events?.some((item) => item.id !== eventId && item.status === 'active' && item.name.toLowerCase() === nextName.toLowerCase())) {
      return res.status(409).json({ error: 'Активное мероприятие с таким названием уже существует' });
    }
    if (name !== undefined) {
      if (!nextName) return res.status(400).json({ error: 'Название мероприятия не может быть пустым' });
      workEvent.name = nextName;
    }
    if (description !== undefined) workEvent.description = String(description || '').trim();
    if (startsAt !== undefined) workEvent.startsAt = String(startsAt || '').trim();
    if (endsAt !== undefined) workEvent.endsAt = String(endsAt || '').trim();
    if (status !== undefined) {
      if (status !== 'active' && status !== 'archived') return res.status(400).json({ error: 'Неизвестный статус мероприятия' });
      workEvent.status = status;
    }
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить мероприятие. Повторите позже.' });
    return res.json({ success: true, event: workEvent });
  });

  // Save/Update User Availability
  app.post('/api/availability', async (req, res) => {
    const { userId, weekStart, hardUnavailableDays, days, out, expectedVersion } = req.body;
    const isWeekMutation = days && typeof days === 'object' && expectedVersion !== undefined;

    if (isWeekMutation) {
      let state: SimulationState;
      let availability: Availability;
      let version: number;
      try {
        const result = mutateDatabaseAtomically((latestState) => {
          if (!isRegisteredUser(latestState, userId)) {
            throw new DatabaseMutationError(403, 'Сначала нужно зарегистрироваться в чате с ботом');
          }
          const baseWeekStart = currentWeekStartIso();
          try {
            const replaced = replaceAvailabilityWeek(
              latestState.availabilities[userId],
              userId,
              baseWeekStart,
              latestState.settings,
              { weekStart: String(weekStart || ''), days, hardUnavailableDays, out: Boolean(out), expectedVersion: Number(expectedVersion) },
            );
            latestState.availabilities[userId] = replaced.availability;
            return replaced;
          } catch (error) {
            if (error instanceof AvailabilityWeekConflictError || error instanceof AvailabilityWeekRangeError) {
              throw new DatabaseMutationError(409, error.message);
            }
            throw error;
          }
        });
        state = result.state;
        availability = result.value.availability;
        version = result.value.version;
      } catch (error) {
        return databaseMutationErrorResponse(res, error);
      }

      let googleSheets: { synced: boolean; error?: string; updatedCells?: number } = { synced: false };
      if (sheetsConfig) {
        try {
          const result = await exportAvailabilityToSheet(sheetsConfig, state.users, availability);
          pendingSheetAvailabilityExports.delete(userId);
          persistChatPanelMessageIds();
          runtimeOperations.lastAvailabilitySheetsSuccessAt = new Date().toISOString();
          runtimeOperations.lastAvailabilitySheetsError = undefined;
          googleSheets = { synced: true, updatedCells: result.updatedCells };
        } catch (error: any) {
          runtimeOperations.lastAvailabilitySheetsErrorAt = new Date().toISOString();
          runtimeOperations.lastAvailabilitySheetsError = safeOperationalError(error);
          console.error('Google Sheets availability export failed:', error);
          pendingSheetAvailabilityExports.add(userId);
          persistChatPanelMessageIds();
          googleSheets = { synced: false, error: error.message || 'Google Sheets export failed' };
        }
      }
      return res.json({ success: true, availability, version, googleSheets });
    }

    return res.status(409).json({ error: 'Формат сохранения слотов устарел. Обнови Mini App и сохрани неделю ещё раз.' });
  });

  // Schedule a new meeting
  app.post('/api/meeting', async (req, res) => {
    const { title, kind, eventId, type, date, time, duration, hostId, participants, topic, description, competency } = req.body;
    const state = loadDatabase();
    const requestedKind = kind === undefined ? 'meeting' : kind;
    const validationErrors = meetingPayloadFieldErrors({
      title, kind: requestedKind, eventId, type: requestedKind === 'setup' ? 'general' : type,
      date, time, duration: requestedKind === 'setup' ? 1 : duration ?? 1,
      participants: requestedKind === 'setup' ? 'all' : participants,
      topic, description, competency,
    });
    if (Object.keys(validationErrors).length) return validationErrorResponse(res, validationErrors);
    const cleanKind: Meeting['kind'] = normalizeMeetingKind(kind);
    const isSetup = cleanKind === 'setup';

    if (!isRegisteredUser(state, hostId)) {
      return res.status(403).json({ error: 'Сначала нужно зарегистрироваться в чате с ботом' });
    }
    if (!String(title || '').trim()) return res.status(400).json({ error: `Укажи название ${meetingKindText(cleanKind).genitive}` });
    if (!parseShortDate(String(date || ''))) return res.status(400).json({ error: `Укажи корректную дату ${meetingKindText(cleanKind).genitive}` });
    if (!/^\d{1,2}:\d{2}$/.test(String(time || ''))) return res.status(400).json({ error: `Укажи время ${meetingKindText(cleanKind).genitive}` });
    const cleanEventId = isSetup ? String(eventId || '').trim() : '';
    if (isSetup && !state.events?.some((item) => item.id === cleanEventId)) {
      return res.status(400).json({ error: 'Выбери мероприятие для монтажа' });
    }
    const cleanDuration = isSetup ? 1 : Number(duration || 1);
    if (!Number.isFinite(cleanDuration) || cleanDuration < 0.5 || cleanDuration > 6) {
      return res.status(400).json({ error: 'Длительность собрания должна быть от 30 минут до 6 часов' });
    }
    const scheduleError = meetingScheduleError(String(date), String(time), cleanDuration, state.settings, cleanKind);
    if (scheduleError) return res.status(400).json({ error: scheduleError });

    const cleanParticipants = isSetup || participants === 'all'
      ? 'all'
      : [...new Set(Array.isArray(participants) ? participants : [])]
          .filter((id) => state.users.some((user) => user.id === id && !isFacultyUser(user) && isUserActive(user)));
    if (!isSetup && type !== 'general' && cleanParticipants !== 'all' && cleanParticipants.length === 0) {
      return res.status(400).json({ error: 'Выбери хотя бы одного участника собрания' });
    }
    const newMeeting = await createMeetingAndNotify(state, {
      title: String(title).trim(),
      kind: cleanKind,
      eventId: cleanEventId || undefined,
      type: isSetup ? 'general' : type,
      date,
      time,
      duration: cleanDuration,
      hostId,
      participants: cleanParticipants,
      topic: isSetup ? '' : topic,
      description: isSetup ? '' : description,
      competency: isSetup ? '' : competency,
    });

    res.json({ success: true, meeting: newMeeting });
  });

  app.post('/api/meeting/update', async (req, res) => {
    const { requesterId, meetingId, title, kind, eventId, type, date, time, duration, participants, topic, description, competency } = req.body;
    const state = loadDatabase();
    const meeting = state.meetings.find(m => m.id === meetingId);

    if (!meeting) return res.status(404).json({ error: 'Встреча не найдена' });
    if (meeting.hostId !== requesterId && !isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Редактировать встречу может автор или админ' });
    }

    const previousRecipientIds = meetingRecipientIds(state, meeting);
    const previousMeeting: Meeting = {
      ...meeting,
      participants: meeting.participants === 'all' ? 'all' : [...meeting.participants],
      audienceUserIds: [...(meeting.audienceUserIds || [])],
      attendeeIds: [...(meeting.attendeeIds || [])],
      rsvpByUser: { ...(meeting.rsvpByUser || {}) },
    };
    const nextKind = normalizeMeetingKind(kind === undefined ? meeting.kind : kind);
    const isSetup = nextKind === 'setup';
    const nextEventId = isSetup ? String(eventId === undefined ? meeting.eventId || '' : eventId || '').trim() : '';
    if (isSetup && !state.events?.some((item) => item.id === nextEventId)) {
      return res.status(400).json({ error: 'Выбери мероприятие для монтажа' });
    }
    const nextDuration = isSetup ? 1 : duration === undefined ? meeting.duration : Number(duration);
    const nextDate = String(date || meeting.date);
    const nextTime = String(time || meeting.time);
    const nextTitle = title === undefined ? meeting.title : title;
    const nextType = isSetup ? 'general' : type === undefined ? meeting.type : type;
    const nextParticipants = isSetup ? 'all' : participants === undefined ? meeting.participants : participants;
    const validationErrors = meetingPayloadFieldErrors({
      title: nextTitle, kind: nextKind, eventId: nextEventId, type: nextType,
      date: nextDate, time: nextTime, duration: nextDuration, participants: nextParticipants,
      topic: isSetup ? '' : topic === undefined ? meeting.topic : topic,
      description: isSetup ? '' : description === undefined ? meeting.description : description,
      competency: isSetup ? '' : competency === undefined ? meeting.competency : competency,
    });
    if (Object.keys(validationErrors).length) return validationErrorResponse(res, validationErrors);
    if (!Number.isFinite(nextDuration) || nextDuration < 0.5 || nextDuration > 6) {
      return res.status(400).json({ error: 'Длительность собрания должна быть от 30 минут до 6 часов' });
    }
    const scheduleError = meetingScheduleError(nextDate, nextTime, nextDuration, state.settings, nextKind);
    if (scheduleError) return res.status(400).json({ error: scheduleError });
    if (title) meeting.title = String(title).trim();
    meeting.kind = nextKind;
    meeting.eventId = nextEventId || undefined;
    if (isSetup) meeting.type = 'general';
    else if (type) meeting.type = type;
    if (date) meeting.date = date;
    if (time) meeting.time = time;
    meeting.duration = nextDuration;
    if (isSetup) {
      meeting.participants = 'all';
    } else if (participants !== undefined) {
      meeting.participants = participants === 'all'
        ? 'all'
        : [...new Set(Array.isArray(participants) ? participants : [])]
            .filter((id) => state.users.some((user) => user.id === id && !isFacultyUser(user) && isUserActive(user)));
    }
    if (isSetup || participants !== undefined || meeting.audiencePolicy !== 'snapshot') {
      meeting.audiencePolicy = 'snapshot';
      meeting.audienceUserIds = snapshotMeetingAudienceUserIds(state.users, meeting.participants, meeting.hostId);
    }
    const nextRecipientIds = meetingRecipientIds(state, meeting);
    meeting.rsvpByUser = Object.fromEntries(Object.entries(normalizedMeetingRsvps(meeting)).filter(([userId]) => nextRecipientIds.has(userId)));
    meeting.rsvpByUser[meeting.hostId] = 'yes';
    meeting.attendeeIds = Object.entries(meeting.rsvpByUser).filter(([, response]) => response === 'yes').map(([userId]) => userId);
    if (isSetup) {
      meeting.topic = '';
      meeting.description = '';
      meeting.competency = '';
    } else {
      if (topic !== undefined) meeting.topic = topic || '';
      if (description !== undefined) meeting.description = description || '';
      if (competency !== undefined) meeting.competency = competency || '';
    }

    const recipients = meetingRecipientIds(state, meeting);
    previousRecipientIds.forEach((id) => recipients.add(id));
    const updateText = meetingUpdateText(previousMeeting, meeting, state);
    if (!saveDatabase(state, { changedMeetingIds: [meeting.id] })) return res.status(503).json({ error: 'Не удалось надёжно сохранить встречу. Повторите позже.' });
    if (!updateText.endsWith('*Что изменилось:*\n')) {
      await notifyMeetingRecipients(
        state,
        recipients,
        updateText,
        'meeting_updated',
        (userId) => meetingRsvpButtons(meeting, userId),
      );
    }
    await syncPersistedMeetingCalendar(meeting.id);
    res.json({ success: true, meeting: loadDatabase().meetings.find((item) => item.id === meeting.id) || meeting });
  });

  app.post('/api/meeting/delete', async (req, res) => {
    const { requesterId, meetingId } = req.body;
    const state = loadDatabase();
    const meeting = state.meetings.find(m => m.id === meetingId);

    if (!meeting) return res.status(404).json({ error: 'Встреча не найдена' });
    if (meeting.hostId !== requesterId && !isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Удалить встречу может автор или админ' });
    }

    const recipients = meetingRecipientIds(state, meeting);
    meeting.status = 'cancelled';
    if (!saveDatabase(state, { changedMeetingIds: [meeting.id] })) return res.status(503).json({ error: 'Не удалось надёжно сохранить встречу. Повторите позже.' });
    await notifyMeetingRecipients(
      state,
      recipients,
      `${meetingKindText(meeting.kind).cancelled}\n\n${meeting.title}\nДата: ${formatMeetingDate(meeting.date)}\nВремя: ${meeting.time}`,
      'meeting_cancelled',
    );
    await syncPersistedMeetingCalendar(meeting.id);
    res.json({ success: true, meeting: loadDatabase().meetings.find((item) => item.id === meeting.id) || meeting });
  });

  app.post('/api/meeting/rsvp', async (req, res) => {
    const { requesterId, meetingId, response, attending } = req.body || {};
    const requestedResponse = response === 'yes' || response === 'no' || response === 'unanswered'
      ? response
      : Boolean(attending) ? 'yes' : 'no';
    let committed: ReturnType<typeof mutateDatabaseAtomically<{ meeting: Meeting; changed: boolean }>>;
    try {
      committed = mutateDatabaseAtomically((state) => {
        const requester = state.users.find((user) => user.id === requesterId && user.registered && !isFacultyUser(user) && isUserActive(user));
        if (!requester) throw new DatabaseMutationError(403, 'Нет доступа к собранию');
        const meeting = state.meetings.find((item) => item.id === meetingId && item.status === 'scheduled');
        if (!meeting) throw new DatabaseMutationError(404, 'Собрание не найдено');
        if (!meetingRecipientIds(state, meeting).has(requester.id)) {
          throw new DatabaseMutationError(403, 'Вы не приглашены на эту встречу');
        }
        if (meetingPhase(meeting) === 'past') throw new DatabaseMutationError(409, 'Встреча уже завершилась');
        const result = setMeetingRsvp(meeting, requester.id, requestedResponse);
        return { meeting, changed: result.changed };
      });
    } catch (error) {
      return databaseMutationErrorResponse(res, error);
    }
    if (committed.value.changed) await syncPersistedMeetingCalendar(meetingId);
    return res.json({ success: true, meeting: committed.value.meeting, response: requestedResponse });
  });

  // Create a new task
  app.post('/api/task/create', async (req, res) => {
    const { title, description, deadline, assignedTo, sow, tips, priority, creatorId, competency, competencies, reminders, eventId } = req.body;
    const validationErrors = taskPayloadFieldErrors({ title, description, deadline, assignedTo, sow, tips, priority, competency, competencies, reminders, eventId }, true);
    if (Object.keys(validationErrors).length) return validationErrorResponse(res, validationErrors);
    let committed: ReturnType<typeof mutateDatabaseAtomically<{
      task: Task;
      notifications: Array<{ target: User; text: string }>;
    }>>;
    try {
      committed = mutateDatabaseAtomically((state) => {
        if (!isRegisteredUser(state, creatorId)) {
          throw new DatabaseMutationError(403, 'Сначала нужно зарегистрироваться в чате с ботом');
        }
        const cleanPriority: Task['priority'] = ['normal', 'important', 'critical'].includes(priority) ? priority : 'normal';
        if (!parseProjectLocalDate(String(deadline || ''))) {
          throw new DatabaseMutationError(400, 'Укажи существующую календарную дату дедлайна');
        }
        const cleanEventId = String(eventId || '').trim();
        if (cleanEventId && !state.events?.some((item) => item.id === cleanEventId && item.status === 'active')) {
          throw new DatabaseMutationError(400, 'Выбранное мероприятие не найдено или уже завершено');
        }
        const requestedAssigneeIds = Array.isArray(assignedTo) ? assignedTo.filter(Boolean) : assignedTo ? [assignedTo] : [];
        const assigneeIds = sanitizeTaskAssigneeIds(state.users, requestedAssigneeIds);
        const cleanCompetencies = [...new Set((Array.isArray(competencies) ? competencies : competency ? [competency] : [])
          .map(String).filter((name) => state.competencies?.includes(name)))];
        const now = new Date().toISOString();
        const task: Task = {
          id: `t_${crypto.randomUUID()}`,
          version: 1,
          title: String(title || '').trim() || 'Без названия',
          description: String(description || '').trim(),
          deadline: String(deadline || '').trim(),
          assignedTo: assigneeIds.length === 0 ? null : assigneeIds,
          creatorId,
          competency: cleanCompetencies[0] || '',
          competencies: cleanCompetencies,
          eventId: cleanEventId,
          sow: sow || '',
          tips: tips || [],
          status: assigneeIds.length ? 'assigned' : 'open',
          priority: cleanPriority,
          createdAt: now,
          completedAt: '',
          assignmentMode: 'shared',
          reminders: normalizeTaskReminders(reminders),
          assigneeNotes: {},
          completionComments: {},
        };
        state.tasks.push(task);
        const targets = resolveTaskAudienceUsers(state.users, task);
        const notifications = targets.map((target) => ({
          target,
          text: assigneeIds.length
            ? `Тебе назначена новая задача!\n\n${taskDetailsText(task, state)}`
            : `На доске появилась свободная задача.\n\n${taskDetailsText(task, state)}`,
        }));
        for (const { target, text } of notifications) {
          if (!state.messages[target.id]) state.messages[target.id] = [];
          state.messages[target.id].push({
            id: `task_created_${crypto.randomUUID()}`,
            userId: target.id,
            sender: 'bot',
            text,
            timestamp: now,
            buttons: [{ text: 'Открыть задачи', action: 'open_tasks' }],
          });
        }
        return { task, notifications };
      });
    } catch (error) {
      return databaseMutationErrorResponse(res, error);
    }
    await Promise.allSettled(committed.value.notifications
      .filter(({ target }) => target.telegramId)
      .map(({ target, text }) => sendTaskTelegramMessage(
        target.telegramId!, text, [{ text: 'Открыть задачи', action: 'open_tasks' }], false, target,
      )));
    return res.json({ success: true, task: committed.value.task });
  });

  app.post('/api/task/update', async (req, res) => {
    const { requesterId, taskId, version, title, description, deadline, assignedTo, sow, priority, competency, competencies, reminders, eventId } = req.body || {};
    const validationErrors = taskPayloadFieldErrors({ title, description, deadline, assignedTo, sow, priority, competency, competencies, reminders, eventId }, false);
    if (Object.keys(validationErrors).length) return validationErrorResponse(res, validationErrors);
    let committed: { state: SimulationState; value: { task: Task; notifications: Array<{ target: User; text: string; assigned: boolean }> } };
    try {
      committed = mutateDatabaseAtomically((state) => {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) throw new DatabaseMutationError(404, 'Задача не найдена');
        if (task.status === 'cancelled') throw new DatabaseMutationError(409, 'Отменённую задачу нельзя редактировать');
        if (task.creatorId !== requesterId && !isAdminUser(state, requesterId)) {
          throw new DatabaseMutationError(403, 'Редактировать задачу может автор или администратор');
        }
        if (version !== undefined && Number(version) !== Number(task.version || 1)) {
          throw new DatabaseMutationError(409, 'Задача уже изменилась. Обновите данные и повторите действие.');
        }

        const previousAssignees = new Set(assignedIds(task));
        if (title !== undefined) task.title = String(title || '').trim() || 'Без названия';
        if (description !== undefined) task.description = String(description || '').trim();
        if (deadline !== undefined) {
          if (!parseProjectLocalDate(String(deadline || ''))) {
            throw new DatabaseMutationError(400, 'Укажи существующую календарную дату дедлайна');
          }
          task.deadline = String(deadline).trim();
        }
        if (competency !== undefined) task.competency = String(competency || '').trim();
        if (competencies !== undefined) {
          task.competencies = [...new Set((Array.isArray(competencies) ? competencies : []).map(String).filter((name) => state.competencies?.includes(name)))];
          task.competency = task.competencies[0] || '';
        }
        if (eventId !== undefined) {
          const cleanEventId = String(eventId || '').trim();
          if (cleanEventId && !state.events?.some((item) => item.id === cleanEventId)) {
            throw new DatabaseMutationError(400, 'Мероприятие не найдено');
          }
          task.eventId = cleanEventId;
        }
        if (sow !== undefined) task.sow = String(sow || '').trim();
        if (priority !== undefined && ['normal', 'important', 'critical'].includes(priority)) task.priority = priority;
        if (reminders !== undefined) task.reminders = normalizeTaskReminders(reminders);
        if (assignedTo !== undefined) {
          const cleanAssignees = sanitizeTaskAssigneeIds(
            state.users,
            Array.isArray(assignedTo) ? assignedTo : assignedTo ? [assignedTo] : [],
          );
          task.assignedTo = cleanAssignees.length ? cleanAssignees : null;
          if (task.status !== 'completed') task.status = cleanAssignees.length ? 'assigned' : 'open';
        }
        task.version = Number(task.version || 1) + 1;

        const currentAssignees = new Set(assignedIds(task));
        const notificationTargets = new Set([...previousAssignees, ...currentAssignees]);
        const notifications: Array<{ target: User; text: string; assigned: boolean }> = [];
        for (const id of notificationTargets) {
          const target = state.users.find((user) => user.id === id);
          if (!target || !isUserActive(target)) continue;
          const assigned = currentAssignees.has(id);
          const text = assigned
            ? `Задача обновлена.\n\n${taskDetailsText(task, state)}`
            : `Назначение снято.\n\nВы больше не исполнитель задачи «${task.title}».`;
          if (!state.messages[target.id]) state.messages[target.id] = [];
          state.messages[target.id].push({
            id: `task_updated_${crypto.randomUUID()}`,
            userId: target.id,
            sender: 'bot',
            text,
            timestamp: new Date().toISOString(),
            buttons: assigned ? [{ text: 'Открыть задачи', action: 'open_tasks' }] : undefined,
          });
          notifications.push({ target, text, assigned });
        }
        return { task, notifications };
      });
    } catch (error) {
      return databaseMutationErrorResponse(res, error);
    }
    await Promise.allSettled(committed.value.notifications
      .filter(({ target }) => target.telegramId)
      .map(({ target, text, assigned }) => sendTaskTelegramMessage(
        target.telegramId!, text, assigned ? [{ text: 'Открыть задачи', action: 'open_tasks' }] : undefined, false, target,
      )));
    return res.json({ success: true, task: committed.value.task });
  });

  app.post('/api/task/comment', (req, res) => {
    const { requesterId, taskId, assigneeId, side, text } = req.body || {};
    const state = loadDatabase();
    const task = state.tasks.find((item) => item.id === taskId);
    const requester = state.users.find((user) => user.id === requesterId && user.registered && isUserActive(user));
    if (!task) return res.status(404).json({ error: 'Задача не найдена. Обнови страницу и попробуй снова.' });
    if (!requester) return res.status(403).json({ error: 'Пользователь не найден или доступ ещё не активирован' });
    if (task.status === 'completed') return res.status(409).json({ error: 'Выполненная задача доступна только для просмотра. Сначала верни её в работу.' });
    if (task.status === 'cancelled') return res.status(409).json({ error: 'Отменённая задача доступна только для просмотра.' });
    if (side !== 'coordinator' && side !== 'executor') return res.status(400).json({ error: 'Неизвестный тип комментария' });
    const targetAssigneeId = side === 'executor' ? requester.id : String(assigneeId || '');
    if (!assignedIds(task).includes(targetAssigneeId)) return res.status(400).json({ error: 'Исполнитель больше не назначен на эту задачу. Обнови страницу.' });
    const isCoordinator = task.creatorId === requester.id || requester.role === 'admin';
    const isExecutor = targetAssigneeId === requester.id;
    if ((side === 'coordinator' && !isCoordinator) || (side === 'executor' && !isExecutor)) {
      return res.status(403).json({ error: 'Нет доступа к этому комментарию' });
    }
    const cleanText = String(text || '').trim().slice(0, 2_000);
    if (!cleanText) return res.status(400).json({ error: 'Напиши комментарий перед сохранением' });
    const createdAt = new Date().toISOString();
    task.assigneeNotes = task.assigneeNotes || {};
    const previousNote = task.assigneeNotes[targetAssigneeId] || {};
    const previousHistory = previousNote.history?.length ? previousNote.history : [
      ...(previousNote.executor ? [{
        id: `task_comment_legacy_executor_${task.id}_${targetAssigneeId}`,
        authorId: targetAssigneeId,
        side: 'executor' as const,
        text: previousNote.executor,
        createdAt: previousNote.updatedAt || task.createdAt || createdAt,
      }] : []),
      ...(previousNote.coordinator ? [{
        id: `task_comment_legacy_coordinator_${task.id}_${targetAssigneeId}`,
        authorId: task.creatorId || requester.id,
        side: 'coordinator' as const,
        text: previousNote.coordinator,
        createdAt: previousNote.updatedAt || task.createdAt || createdAt,
      }] : []),
    ];
    task.assigneeNotes[targetAssigneeId] = {
      ...previousNote,
      [side]: cleanText,
      updatedAt: createdAt,
      history: [...previousHistory, {
        id: `task_comment_${crypto.randomUUID()}`,
        authorId: requester.id,
        side,
        text: cleanText,
        createdAt,
      }],
    };
    task.version = Number(task.version || 1) + 1;
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось сохранить комментарий. Повторите позже.' });
    return res.json({ success: true, task });
  });

  app.post('/api/task/delete', async (req, res) => {
    const { requesterId, taskId } = req.body || {};
    const state = loadDatabase();
    const task = state.tasks.find((item) => item.id === taskId);
    const requester = state.users.find((user) => user.id === requesterId && user.registered && isUserActive(user));
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });
    if (!requester) return res.status(403).json({ error: 'Нет доступа к задаче' });
    if (task.creatorId !== requester.id && requester.role !== 'admin') {
      return res.status(403).json({ error: 'Удалить задачу может только её автор или администратор' });
    }
    if (task.status === 'cancelled') return res.json({ success: true, task });

    const recipientIds = assignedIds(task).filter((id) => id !== requester.id);
    task.status = 'cancelled';
    task.version = Number(task.version || 1) + 1;
    task.cancelledAt = new Date().toISOString();
    task.cancelledBy = requester.id;
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось отменить задачу. Повторите позже.' });

    const notificationText = `Задача отменена автором.\n\n*${task.title}*`;
    const sendPlans: Array<{ target: User; messageId: string }> = [];
    for (const id of recipientIds) {
      const target = state.users.find((user) => user.id === id);
      if (!target || !isUserActive(target)) continue;
      if (!state.messages[target.id]) state.messages[target.id] = [];
      const messageId = `task_cancelled_${crypto.randomUUID()}`;
      state.messages[target.id].push({
        id: messageId,
        userId: target.id,
        sender: 'bot',
        text: notificationText,
        timestamp: task.cancelledAt,
      });
      if (target.telegramId) sendPlans.push({ target, messageId });
    }
    if (recipientIds.length && !saveDatabase(state)) return res.status(503).json({ error: 'Задача отменена, но уведомления не удалось надёжно сохранить. Обновите состояние.' });
    await Promise.allSettled(sendPlans.map(({ target, messageId }) => sendTaskTelegramMessage(
      target.telegramId!, notificationText, undefined, false, target,
      { dedupeKey: messageId, category: 'task' },
    )));
    return res.json({ success: true, task });
  });

  app.post('/api/team/broadcast', async (req, res) => {
    const { requesterId, recipientMode, availabilityWeekIndex, competencies, recipientIds, title, body } = req.body || {};
    const state = loadDatabase();
    const author = state.users.find((user) => user.id === requesterId && user.registered && !isFacultyUser(user) && isUserActive(user));
    if (!author) return res.status(403).json({ error: 'Рассылки доступны участникам основной команды' });
    const cleanBody = String(body || '').trim().slice(0, 4_000);
    const cleanTitle = String(title || '').trim().slice(0, 120);
    if (!cleanBody) return res.status(400).json({ error: 'Текст рассылки обязателен' });
    if (!['all', 'blocks', 'people', 'missing_slots'].includes(recipientMode)) return res.status(400).json({ error: 'Выбери получателей рассылки' });

    const teamUsers = activeCoreTeamUsers(state.users);
    const availabilityConfig = normalizeAvailabilityConfig(state.settings);
    const requestedWeekIndex = Number(availabilityWeekIndex);
    const cleanWeekIndex = Number.isInteger(requestedWeekIndex) && requestedWeekIndex >= 0 && requestedWeekIndex < availabilityConfig.weekCount
      ? requestedWeekIndex
      : 0;
    const cleanCompetencies = [...new Set((Array.isArray(competencies) ? competencies : []).map(String).filter((name) => state.competencies?.includes(name)))];
    const requestedIds = new Set((Array.isArray(recipientIds) ? recipientIds : []).map(String));
    let recipients: User[] = [];
    if (recipientMode === 'all') recipients = teamUsers;
    if (recipientMode === 'blocks') {
      if (!cleanCompetencies.length) return res.status(400).json({ error: 'Выбери хотя бы один блок получателей' });
      recipients = teamUsers.filter((user) => cleanCompetencies.some((name) => user.primaryCompetency === name || user.competencies?.includes(name)) || requestedIds.has(user.id));
    }
    if (recipientMode === 'people') recipients = teamUsers.filter((user) => requestedIds.has(user.id));
    if (recipientMode === 'missing_slots') {
      recipients = teamUsers.filter((user) => !hasSubmittedAvailabilityForWeek(state.availabilities[user.id], state.settings, cleanWeekIndex));
      if (!recipients.length) return res.status(400).json({ error: 'Все участники уже отметили слоты на выбранную неделю' });
    }
    recipients = [...new Map(recipients.map((user) => [user.id, user])).values()];
    if (!recipients.length) return res.status(400).json({ error: 'Не найдено ни одного доступного получателя' });

    const sendableRecipients = recipients.filter((recipient) => recipient.telegramId);
    const unavailable = recipients.length - sendableRecipients.length;
    if (!sendableRecipients.length) {
      return res.status(409).json({
        error: 'Никому не удалось отправить сообщение: выбранные участники ещё не открывали MegaBot через /start.',
        recipients: recipients.length,
        delivered: 0,
        unavailable,
        failed: 0,
      });
    }
    const requestLimit = broadcastRateLimit(author.id);
    if (!requestLimit.allowed) {
      return rateLimitResponse(res, requestLimit, 'Лимит рассылок исчерпан. Повторите позже.');
    }
    const volumeLimit = broadcastVolumeRateLimit(author.id, sendableRecipients.length);
    if (!volumeLimit.allowed) {
      return rateLimitResponse(res, volumeLimit, 'Лимит получателей рассылок исчерпан. Уменьшите аудиторию или повторите позже.');
    }

    const authorName = author.realName || author.username || 'Участник команды';
    const authorUsername = author.username ? ` (${author.username.startsWith('@') ? author.username : `@${author.username}`})` : '';
    const messageText = `${cleanTitle ? `*${cleanTitle}*\n\n` : ''}${cleanBody}\n\n*Автор:* ${authorName}${authorUsername}`;
    const timestamp = new Date().toISOString();
    const sendPlans: Array<{ recipient: User; messageId: string }> = [];
    for (const recipient of recipients) {
      if (!state.messages[recipient.id]) state.messages[recipient.id] = [];
      const messageId = `team_broadcast_${crypto.randomUUID()}`;
      state.messages[recipient.id].push({
        id: messageId,
        userId: recipient.id,
        sender: 'bot',
        text: messageText,
        timestamp,
        buttons: [{ text: 'Открыть Mini App', action: 'open_tma' }],
      });
      if (recipient.telegramId) sendPlans.push({ recipient, messageId });
    }
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить рассылку. Повторите позже.' });
    const delivery = await Promise.allSettled(sendPlans.map(({ recipient, messageId }) => sendTelegramMessage(
      recipient.telegramId!, messageText, [{ text: 'Открыть Mini App', action: 'open_tma' }], false, recipient, false,
      { dedupeKey: messageId, category: 'broadcast' },
    )));
    const delivered = delivery.filter((result) => result.status === 'fulfilled' && result.value).length;
    const deliveryRecords = loadDatabase().settings?.notificationDeliveries || [];
    const statuses = sendPlans.map(({ messageId }) => deliveryRecords.find((item) => item.dedupeKey === messageId)?.status);
    const pending = statuses.filter((status) => status === 'planned' || status === 'sending' || status === 'retry').length;
    const attention = statuses.filter((status) => status === 'failed' || status === 'unknown').length;
    const failed = sendPlans.length - delivered - pending;
    console.log(`[Team Broadcast] author=${author.id} recipients=${recipients.length} queued=${sendPlans.length} delivered=${delivered} unavailable=${unavailable} pending=${pending} attention=${attention}`);
    if (!delivered && pending) {
      return res.status(202).json({ success: true, recipients: recipients.length, queued: sendPlans.length, delivered, unavailable, failed, pending, attention, availabilityWeekIndex: cleanWeekIndex });
    }
    if (!delivered) {
      return res.status(502).json({
        error: 'Telegram не доставил рассылку. Участникам нужно открыть MegaBot и нажать /start, затем повторить отправку.',
        recipients: recipients.length,
        queued: sendPlans.length,
        delivered,
        unavailable,
        failed,
        pending,
        attention,
      });
    }
    return res.json({ success: true, recipients: recipients.length, queued: sendPlans.length, delivered, unavailable, failed, pending, attention, availabilityWeekIndex: cleanWeekIndex });
  });

  app.post('/api/task/notify', async (req, res) => {
    const { requesterId, taskId } = req.body || {};
    const state = loadDatabase();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });
    if (task.status === 'cancelled') return res.status(409).json({ error: 'Задача отменена' });
    if (task.creatorId !== requesterId && !isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Отправить напоминание может автор или администратор' });
    }
    const recipientIds = assignedIds(task);
    if (!recipientIds.length) return res.status(400).json({ error: 'Сначала назначь исполнителей' });
    const text = `Напоминание по задаче:\n\n${taskDetailsText(task, state)}`;
    const sendPlans: Array<{ target: User; messageId: string }> = [];
    for (const id of recipientIds) {
      const target = state.users.find((user) => user.id === id);
      if (!target || !isUserActive(target)) continue;
      if (!state.messages[target.id]) state.messages[target.id] = [];
      const messageId = `task_manual_reminder_${crypto.randomUUID()}`;
      state.messages[target.id].push({
        id: messageId,
        userId: target.id,
        sender: 'bot',
        text,
        timestamp: new Date().toISOString(),
        buttons: [{ text: 'Открыть задачи', action: 'open_tasks' }],
      });
      if (target.telegramId) sendPlans.push({ target, messageId });
    }
    if (!saveDatabase(state)) return res.status(503).json({ error: 'Не удалось надёжно сохранить уведомления. Повторите позже.' });
    const delivery = await Promise.allSettled(sendPlans.map(({ target, messageId }) => sendTaskTelegramMessage(
      target.telegramId!, text, [{ text: 'Открыть задачи', action: 'open_tasks' }], false, target,
      { dedupeKey: messageId, category: 'task_reminder' },
    )));
    const delivered = delivery.filter((result) => result.status === 'fulfilled' && result.value).length;
    res.json({ success: true, queued: sendPlans.length, delivered });
  });

  // Claim a public task
  app.post('/api/task/claim', async (req, res) => {
    const { taskId, userId } = req.body;
    let committed: { state: SimulationState; value: { task: Task; user: User; recipients: User[]; notificationText: string } };
    try {
      committed = mutateDatabaseAtomically((state) => {
        if (!isRegisteredUser(state, userId)) throw new DatabaseMutationError(403, 'Сначала нужно зарегистрироваться в чате с ботом');
        const task = state.tasks.find((item) => item.id === taskId);
        const user = state.users.find((item) => item.id === userId);
        if (!task) throw new DatabaseMutationError(404, 'Задача не найдена');
        if (!user) throw new DatabaseMutationError(404, 'Пользователь не найден');
        if (task.status !== 'open') throw new DatabaseMutationError(409, 'Задача уже занята');
        task.assignedTo = [userId];
        task.status = 'assigned';
        task.version = Number(task.version || 1) + 1;
        if (!state.messages[userId]) state.messages[userId] = [];
        state.messages[userId].push({
          id: `task_claim_bot_${crypto.randomUUID()}`, userId, sender: 'bot',
          text: `Ты закрепил за собой задачу: *"${task.title}"*\nБлоки: ${taskCompetencyNames(task).join(', ') || 'не указаны'}\nДедлайн: ${formatShortDate(task.deadline)}.\nТЗ можно проверить в Mini App.`,
          timestamp: new Date().toISOString(),
        });
        const creator = state.users.find((item) => item.id === task.creatorId);
        const notificationText = `${user.realName} взял задачу с доски:\n"${task.title}"\n\nСвязаться: ${user.username}`;
        const recipients = [
          ...(creator && creator.id !== userId ? [creator] : []),
          ...state.users.filter((item) => item.role === 'admin' && item.id !== userId && item.id !== creator?.id),
        ];
        recipients.forEach((recipient) => {
          if (!state.messages[recipient.id]) state.messages[recipient.id] = [];
          state.messages[recipient.id].push({ id: `task_claim_notice_${crypto.randomUUID()}`, userId: recipient.id, sender: 'bot', text: notificationText, timestamp: new Date().toISOString() });
        });
        return { task, user, recipients, notificationText };
      });
    } catch (error) {
      return databaseMutationErrorResponse(res, error);
    }
    const { state } = committed;
    const { task, user, recipients, notificationText } = committed.value;
    const claimSendJobs: Promise<boolean>[] = [];
    if (user.telegramId) claimSendJobs.push(sendTaskTelegramMessage(user.telegramId, `Ты взял задачу в работу:\n\n${taskDetailsText(task, state)}`, [{ text: 'Открыть задачи', action: 'open_tasks' }], false, user));
    recipients.filter((recipient) => recipient.telegramId).forEach((recipient) => claimSendJobs.push(sendTaskTelegramMessage(recipient.telegramId!, notificationText, undefined, false, recipient)));
    await Promise.allSettled(claimSendJobs);
    res.json({ success: true, task });
  });

  app.post('/api/task/release', async (req, res) => {
    const { taskId, userId } = req.body;
    let committed: { state: SimulationState; value: { task: Task; user: User; changed: boolean; becameOpen: boolean; remainingAssigneeIds: string[] } };
    try {
      committed = mutateDatabaseAtomically((state) => {
        const task = state.tasks.find((item) => item.id === taskId);
        const user = state.users.find((item) => item.id === userId && item.registered);
        if (!task) throw new DatabaseMutationError(404, 'Задача не найдена');
        if (!user) throw new DatabaseMutationError(404, 'Пользователь не найден');
        if (task.status === 'cancelled') throw new DatabaseMutationError(409, 'Задача отменена');
        if (task.status === 'completed') throw new DatabaseMutationError(409, 'Задача уже завершена');
        try {
          return { task, user, ...releaseTaskCommand(task, user.id) };
        } catch (error) {
          if (error instanceof TaskCommandError) throw new DatabaseMutationError(409, error.message);
          throw error;
        }
      });
    } catch (error) {
      return databaseMutationErrorResponse(res, error);
    }
    const { state } = committed;
    const { task, user, changed, becameOpen, remainingAssigneeIds } = committed.value;
    if (!changed) return res.json({ success: true, task, alreadyReleased: true, becameOpen: task.status === 'open' });

    const sendJobs: Promise<boolean>[] = [];
    const creator = state.users.find(u => u.id === task.creatorId);
        if (creator?.telegramId && isUserActive(creator) && creator.id !== user.id) {
      const remainingNames = remainingAssigneeIds.map((id) => state.users.find((item) => item.id === id)?.realName || id).join(', ');
      sendJobs.push(sendTaskTelegramMessage(creator.telegramId, becameOpen
        ? `${userMention(user)} отказался от задачи *"${task.title}"*. Она снова на бирже.`
        : `${userMention(user)} отказался от задачи *"${task.title}"*. Остались: ${remainingNames}.`));
    }

    for (const target of becameOpen ? state.users.filter(u => isUserActive(u) && u.telegramId && u.id !== user.id && u.id !== creator?.id) : []) {
      sendJobs.push(sendTaskTelegramMessage(target.telegramId!, `Задача снова свободна:\n\n${taskDetailsText(task, state)}`, [{ text: 'Посмотреть задачу', action: 'open_tasks' }], false, target));
    }
    await Promise.allSettled(sendJobs);

    res.json({ success: true, task, becameOpen, remainingAssigneeIds });
  });

  // Update task status (complete)
  app.post('/api/task/status', async (req, res) => {
    const { taskId, version, status, requesterId, timeSpentMinutes, completionComment } = req.body;
    let committed: { state: SimulationState; value: { task: Task; notification?: { target: User; text: string }; alreadyApplied?: boolean } };
    try {
      committed = mutateDatabaseAtomically((state) => {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) throw new DatabaseMutationError(404, 'Задача не найдена');
        if (task.status === 'cancelled') throw new DatabaseMutationError(409, 'Отменённую задачу нельзя возобновить');
        if (!['open', 'assigned', 'completed', 'waiting', 'in_progress'].includes(status)) {
          throw new DatabaseMutationError(400, 'Неизвестный статус задачи');
        }
        const requester = state.users.find((user) => user.id === requesterId && user.registered && isUserActive(user));
        if (!requester) throw new DatabaseMutationError(403, 'Нет доступа к задаче');
        if (requester.role !== 'admin' && !assignedIds(task).includes(requester.id)) {
          throw new DatabaseMutationError(403, 'Изменить статус может исполнитель или администратор');
        }
        const parsedTimeSpent = Number(timeSpentMinutes);
        if (timeSpentMinutes !== undefined && (!Number.isFinite(parsedTimeSpent) || parsedTimeSpent <= 0 || parsedTimeSpent > 60000)) {
          throw new DatabaseMutationError(400, 'Время выполнения должно быть больше нуля');
        }
        const cleanComment = String(completionComment || '').trim();
        const unchangedCompletion = status === 'completed'
          && task.status === 'completed'
          && task.timeSpentMinutes === (timeSpentMinutes === undefined ? undefined : Math.round(parsedTimeSpent))
          && String(task.completionComments?.[requester.id] || '') === cleanComment;
        if ((status !== 'completed' && task.status === status) || unchangedCompletion) {
          return { task, alreadyApplied: true };
        }
        if (version !== undefined && Number(version) !== Number(task.version || 1)) {
          throw new DatabaseMutationError(409, 'Задача уже изменилась. Обновите данные и повторите действие.');
        }
        const wasCompleted = task.status === 'completed';
        task.status = status;
        task.assignmentMode = 'shared';
        if (status === 'completed') {
          task.completedAt = new Date().toISOString();
          if (!wasCompleted) task.completedBy = requester.id;
          task.timeSpentMinutes = timeSpentMinutes === undefined ? undefined : Math.round(parsedTimeSpent);
          task.completionComments = task.completionComments || {};
          if (cleanComment) task.completionComments[requester.id] = cleanComment;
          else delete task.completionComments[requester.id];
        } else {
          task.completedAt = '';
          task.completedBy = undefined;
          task.timeSpentMinutes = undefined;
        }
        task.version = Number(task.version || 1) + 1;

        let notification: { target: User; text: string } | undefined;
        if (status === 'completed' && task.assignedTo) {
          const target = state.users.find((user) => user.id === task.creatorId && user.id !== requester.id);
          if (target) {
            const completionActor = state.users.find((user) => user.id === task.completedBy);
            const text = `Задача выполнена!\nБлоки: ${taskCompetencyNames(task).join(', ') || 'не указаны'}\nЗавершил: ${completionActor?.realName || 'не указан'}\nЗадача: "${task.title}"${task.timeSpentMinutes ? `\nЗатрачено: ${taskDurationLabel(task.timeSpentMinutes)}` : ''}${String(completionComment || '').trim() ? `\nКомментарий: ${String(completionComment).trim()}` : ''}`;
            if (!state.messages[target.id]) state.messages[target.id] = [];
            state.messages[target.id].push({
              id: `task_completed_${crypto.randomUUID()}`,
              userId: target.id,
              sender: 'bot',
              text,
              timestamp: new Date().toISOString(),
            });
            notification = { target, text };
          }
        }
        return { task, notification };
      });
    } catch (error) {
      return databaseMutationErrorResponse(res, error);
    }
    const notification = committed.value.notification;
    if (notification?.target.telegramId) {
      await Promise.allSettled([sendTaskTelegramMessage(
        notification.target.telegramId, notification.text, undefined, false, notification.target,
      )]);
    }
    return res.json({ success: true, task: committed.value.task, alreadyApplied: Boolean(committed.value.alreadyApplied) });
  });

  app.post('/api/task/log/clear', (req, res) => {
    const { requesterId } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Только админ может управлять архивом задач' });
    }
    return res.status(410).json({ error: 'Полная очистка журнала отключена. Используйте очистку архива или сезонный сброс с предварительным просмотром.' });
  });

  app.post('/api/task/archive/preview', (req, res) => {
    const state = loadDatabase();
    if (!isAdminUser(state, req.body.requesterId)) return res.status(403).json({ error: 'Только админ может управлять архивом задач' });
    const archived = state.tasks.filter((task) => task.status === 'completed' || task.status === 'cancelled');
    return res.json({
      success: true,
      taskIds: archived.map((task) => task.id).sort(),
      count: archived.length,
      completedCount: archived.filter((task) => task.status === 'completed').length,
      cancelledCount: archived.filter((task) => task.status === 'cancelled').length,
    });
  });

  app.post('/api/task/archive/clear', (req, res) => {
    const expectedIds = Array.isArray(req.body.taskIds) ? req.body.taskIds.map(String).sort() : [];
    try {
      const committed = mutateDatabaseAtomically((state) => {
        if (!isAdminUser(state, req.body.requesterId)) throw new DatabaseMutationError(403, 'Только админ может управлять архивом задач');
        const currentIds = state.tasks.filter((task) => task.status === 'completed' || task.status === 'cancelled').map((task) => task.id).sort();
        if (JSON.stringify(currentIds) !== JSON.stringify(expectedIds)) {
          throw new DatabaseMutationError(409, 'Состав архива изменился. Обновите предварительный просмотр и повторите действие.');
        }
        const backupPath = writeDatabaseRecoveryRecord(DATABASE_RECOVERY_DIRECTORY, state, DATABASE_RECOVERY_RETENTION);
        const archivedIds = new Set(currentIds);
        state.tasks = state.tasks.filter((task) => !archivedIds.has(task.id));
        return { removedCount: currentIds.length, backupId: path.basename(backupPath), remainingCount: state.tasks.length };
      });
      return res.json({ success: true, ...committed.value, revision: committed.state.settings?.databaseRevision || 0 });
    } catch (error) {
      return databaseMutationErrorResponse(res, error);
    }
  });

  app.post('/api/task/season-reset/preview', (req, res) => {
    const state = loadDatabase();
    if (!isAdminUser(state, req.body.requesterId)) return res.status(403).json({ error: 'Только админ может выполнять сезонный сброс' });
    const statusCounts = state.tasks.reduce<Record<string, number>>((counts, task) => {
      counts[task.status] = (counts[task.status] || 0) + 1;
      return counts;
    }, {});
    return res.json({ success: true, taskIds: state.tasks.map((task) => task.id).sort(), count: state.tasks.length, statusCounts });
  });

  app.post('/api/task/season-reset', (req, res) => {
    const expectedIds = Array.isArray(req.body.taskIds) ? req.body.taskIds.map(String).sort() : [];
    try {
      const committed = mutateDatabaseAtomically((state) => {
        if (!isAdminUser(state, req.body.requesterId)) throw new DatabaseMutationError(403, 'Только админ может выполнять сезонный сброс');
        if (req.body.confirmation !== 'СБРОСИТЬ СЕЗОН') throw new DatabaseMutationError(400, 'Введите точную фразу подтверждения: СБРОСИТЬ СЕЗОН');
        const currentIds = state.tasks.map((task) => task.id).sort();
        if (JSON.stringify(currentIds) !== JSON.stringify(expectedIds)) {
          throw new DatabaseMutationError(409, 'Состав задач изменился. Обновите предварительный просмотр и повторите действие.');
        }
        const backupPath = writeDatabaseRecoveryRecord(DATABASE_RECOVERY_DIRECTORY, state, DATABASE_RECOVERY_RETENTION);
        state.tasks = [];
        return { operationId: crypto.randomUUID(), removedCount: currentIds.length, backupId: path.basename(backupPath) };
      });
      console.warn(`[task-season-reset] operation=${committed.value.operationId} removed=${committed.value.removedCount} backup=${committed.value.backupId}`);
      return res.json({ success: true, ...committed.value, revision: committed.state.settings?.databaseRevision || 0 });
    } catch (error) {
      return databaseMutationErrorResponse(res, error);
    }
  });

  app.get('/api/task/export', (req, res) => {
    const state = loadDatabase();

    const rows = state.tasks
      .slice()
      .sort((a, b) => String(a.competency || '').localeCompare(String(b.competency || ''), 'ru') || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      .map((task) => {
        const creator = state.users.find((u) => u.id === task.creatorId);
        const workEvent = state.events?.find((item) => item.id === task.eventId);
        const executors = assignedIds(task)
          .map((id) => state.users.find((u) => u.id === id)?.realName)
          .filter(Boolean)
          .join(', ');
        return `
          <tr>
            <td>${escapeHtml(workEvent?.name || 'Без мероприятия')}</td>
            <td>${escapeHtml(taskCompetencyNames(task).join(', ') || 'Без блока')}</td>
            <td>${escapeHtml(taskStatusLabel(task.status))}</td>
            <td>${escapeHtml(task.title)}</td>
            <td>${escapeHtml(task.description)}</td>
            <td>${escapeHtml(task.sow)}</td>
            <td>${escapeHtml(task.deadline)}</td>
            <td>${escapeHtml(formatDateTimeShort(task.createdAt))}</td>
            <td>${escapeHtml(formatDateTimeShort(task.completedAt))}</td>
            <td>${escapeHtml(creator?.realName || 'Не указан')}</td>
            <td>${escapeHtml(executors || 'Не назначен')}</td>
            <td>${escapeHtml(taskPriorityLabel(task.priority))}</td>
            <td>${escapeHtml(taskDurationLabel(task.timeSpentMinutes) || 'Не указано')}</td>
            <td>${escapeHtml((task.tips || []).join('\\n'))}</td>
          </tr>`;
      })
      .join('');

    const html = `<!doctype html>
      <html>
        <head><meta charset="utf-8" /></head>
        <body>
          <table border="1">
            <thead>
              <tr>
                <th>Мероприятие</th>
                <th>Блок</th>
                <th>Статус</th>
                <th>Название</th>
                <th>Описание</th>
                <th>ТЗ</th>
                <th>Дедлайн</th>
                <th>Дата назначения</th>
                <th>Дата выполнения</th>
                <th>Автор</th>
                <th>Исполнитель</th>
                <th>Приоритет</th>
                <th>Затрачено времени</th>
                <th>Подсказки</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </body>
      </html>`;

    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=\"megabot-task-log.xls\"');
    res.send(html);
  });
  // Suggest meeting windows with a pure algorithm.
  app.post('/api/meeting/suggest', async (req, res) => {
    const state = loadDatabase();
    const teamUsers = activeCoreTeamUsers(state.users);
    const availabilityConfig = normalizeAvailabilityConfig(state.settings);
    const requestedWeekIndex = Number(req.body?.weekIndex ?? 0);
    if (!Number.isInteger(requestedWeekIndex) || requestedWeekIndex < 0 || requestedWeekIndex >= availabilityConfig.weekCount) {
      return res.status(400).json({ error: 'Выбери корректную неделю' });
    }
    const requestedDays: number[] = Array.isArray(req.body?.days) ? req.body.days.map(Number) : availabilityConfig.activeDays;
    const selectedDays: number[] = [...new Set<number>(requestedDays.filter((day) => (
      Number.isInteger(day) && availabilityConfig.activeDays.includes(day)
    )))].sort((a, b) => a - b);
    const requestedDuration = Number(req.body?.duration ?? 1);
    const allowedDurations = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6];
    if (!selectedDays.length) return res.status(400).json({ error: 'Выбери хотя бы один день для поиска' });
    if (!allowedDurations.includes(requestedDuration)) return res.status(400).json({ error: 'Выбери корректную продолжительность собрания' });

    const windowScores: {
      day: number;
      hour: number;
      endHour: number;
      duration: number;
      count: number;
      total: number;
      canUsers: Pick<User, 'id' | 'realName' | 'username'>[];
      cannotUsers: (Pick<User, 'id' | 'realName' | 'username'> & { reason: 'out' | 'not_marked' | 'inconvenient' })[];
    }[] = [];

    for (const day of selectedDays) {
      const absoluteDay = requestedWeekIndex * 7 + day;
      for (let hour = availabilityConfig.startHour; hour + requestedDuration <= availabilityConfig.endHour + 1; hour += 1) {
        const hoursWindow = Array.from({ length: Math.ceil(requestedDuration) }, (_, index) => hour + index);
        const canUsers = teamUsers.filter((user) => {
          if (isOutForWeek(state.availabilities[user.id], requestedWeekIndex)) return false;
          const daySlots = alignedAvailabilitySlots(state.availabilities[user.id])?.[absoluteDay] || [];
          return hoursWindow.every((slotHour) => daySlots.includes(slotHour));
        }).map(({ id, realName, username }) => ({ id, realName, username }));
        if (canUsers.length > 0) {
          const canUserIds = new Set(canUsers.map((user) => user.id));
          const cannotUsers = teamUsers
            .filter((user) => !canUserIds.has(user.id))
            .map(({ id, realName, username }) => {
              const availability = state.availabilities[id];
              const daySlots = alignedAvailabilitySlots(availability)?.[absoluteDay] || [];
              const markedDay = daySlots.length > 0 || alignedHardUnavailableDays(availability).includes(absoluteDay);
              const reason = isOutForWeek(availability, requestedWeekIndex)
                ? 'out' as const
                : !markedDay
                  ? 'not_marked' as const
                  : 'inconvenient' as const;
              return { id, realName, username, reason };
            });
          windowScores.push({
            day,
            hour,
            endHour: hour + requestedDuration,
            duration: requestedDuration,
            count: canUsers.length,
            total: teamUsers.length,
            canUsers,
            cannotUsers,
          });
        }
      }
    }

    windowScores.sort((a, b) => {
      return b.count - a.count
        || (b.total ? b.count / b.total : 0) - (a.total ? a.count / a.total : 0)
        || a.day - b.day
        || a.hour - b.hour;
    });

    const picked = windowScores.slice(0, 5);

    const russianDays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

    const suggestions = picked.map((slot) => {
      const date = new Date(`${currentWeekStartIso()}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + requestedWeekIndex * 7 + slot.day);
      return {
        weekIndex: requestedWeekIndex,
        date: `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}.${String(date.getUTCFullYear()).slice(2)}`,
        dayName: russianDays[slot.day],
        dayIndex: slot.day,
        hour: slot.hour,
        endHour: slot.endHour,
        duration: slot.duration,
        count: slot.count,
        total: slot.total,
        canUsers: slot.canUsers,
        cannotUsers: slot.cannotUsers,
      };
    });

    res.json({
      success: true,
      type: 'algorithmic',
      topSuggestions: suggestions
    });
  });
  app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(error);
    const context = req as express.Request & { requestId?: string; operationId?: string };
    console.error(JSON.stringify({
      event: 'unhandled_request_error', requestId: context.requestId, operationId: context.operationId,
      method: req.method, path: req.path, error: safeOperationalError(error),
    }));
    return res.status(500).json({
      error: 'Внутренняя ошибка сервиса. Повторите запрос позже.',
      requestId: context.requestId,
    });
  });
  // Serve static UI assets or let Vite do it in dev mode
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store, max-age=0');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }));
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  async function configureTelegramBotUi() {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    const webAppUrl = configuredWebAppUrl();
    try {
      await telegramFetch(`${tgApiBase}/bot${botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { type: 'all_private_chats' },
          commands: [
            { command: 'start', description: 'Открыть Mini App' },
            { command: 'register', description: 'Показать профиль' },
            { command: 'slots', description: 'Отметить свободные слоты' },
            { command: 'meetings', description: 'Показать встречи' },
            { command: 'tasks', description: 'Показать мои задачи' },
            { command: 'help', description: 'Справка по боту' }
          ]
        })
      });
      await configureGroupCommandMenu();
      await configureGroupCommandMenu({ type: 'all_chat_administrators' });

      await telegramFetch(`${tgApiBase}/bot${botToken}/setChatMenuButton`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          menu_button: webAppUrl
            ? { type: 'web_app', text: 'Начать', web_app: { url: webAppUrl } }
            : { type: 'commands' },
        })
      });
      await configureBotProfile();
      const menuState = loadDatabase();
      const menuUsers = menuState.users.filter((user) => isUserActive(user) && user.registered && user.telegramId);
      await Promise.allSettled(menuUsers.map((user) => configureChatMenuButton(user.telegramId!, user)));
      console.log('Telegram commands configured. Mini App menu button configured.');
    } catch (err: any) {
      console.error('Failed to configure Telegram commands/menu:', err.message);
    }
  }

  async function startTelegramLongPolling() {
    if (telegramUpdateMode !== 'polling') {
      console.log(`Telegram long polling disabled: TELEGRAM_UPDATE_MODE=${telegramUpdateMode}.`);
      return;
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) {
      console.warn('BOT_TOKEN / TELEGRAM_BOT_TOKEN is not set in .env. Telegram long polling was not started.');
      return;
    }

    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

    console.log('Starting Telegram long polling...');

    // Reset the old webhook before long polling so Telegram sends updates here.
    try {
      console.log('Deleting old Telegram webhook...');
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/deleteWebhook`);
      const data = await response.json();
      console.log('Telegram webhook deletion result:', data);
    } catch (err: any) {
      console.error('Failed to delete Telegram webhook:', err.message);
    }

    console.log('Telegram long polling started.');
    let offset = 0;

    const poll = async () => {
      try {
        const allowedUpdates = encodeURIComponent(JSON.stringify(['message', 'callback_query', 'chat_member', 'my_chat_member']));
        const response = await telegramFetch(`${tgApiBase}/bot${botToken}/getUpdates?offset=${offset}&timeout=30&allowed_updates=${allowedUpdates}`);
        if (!response.ok) {
          throw new Error(`HTTP status ${response.status}`);
        }
        const data = (await response.json()) as { ok: boolean; result: any[] };
        if (data.ok && data.result.length > 0) {
          data.result.forEach((update) => console.log(`[Long Polling] Received update: ${update.update_id}`));
          persistTelegramUpdates(data.result);
          offset = Math.max(...data.result.map((update) => Number(update.update_id))) + 1;
          void flushTelegramInbox().catch((error) => console.error('Telegram inbox flush failed:', error));
        }
      } catch (err: any) {
        console.error('Telegram getUpdates request failed:', err.message);
        console.log(`Telegram getUpdates failed at offset=${offset}; token omitted from logs.`)
        // Small delay on network errors to avoid spamming requests.
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      // Schedule the next polling cycle.
      setTimeout(poll, 200);
    };

    poll();
  }

  function startBackgroundSchedulers() {
    if (process.env.BACKGROUND_SCHEDULERS_ENABLED?.trim().toLowerCase() === 'false') {
      console.log('Telegram background schedulers disabled by BACKGROUND_SCHEDULERS_ENABLED=false.');
      return;
    }
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) {
      console.warn('Telegram background schedulers were not started because no bot token is configured.');
      return;
    }
    sendDueBirthdayReminders().catch((error) => console.error('Birthday reminder check failed:', error));
    sendTaskReminders().catch((error) => console.error('Task reminder check failed:', error));
    flushPendingImportantNotifications().catch((error) => console.error('Notification delivery flush failed:', error));
    setInterval(() => {
      sendDueBirthdayReminders().catch((error) => console.error('Birthday reminder check failed:', error));
    }, 15 * 60 * 1000);
    const scheduleNextAvailabilityReminderCheck = () => {
      if (isShuttingDown) return;
      const delayMs = millisecondsUntilNextWholeHour();
      setTimeout(() => {
        sendSundayAvailabilityReminders().catch((error) => {
          console.error('Sunday availability reminder check failed:', error);
        }).finally(scheduleNextAvailabilityReminderCheck);
      }, delayMs);
    };
    if (isAvailabilityReminderTime()) {
      sendSundayAvailabilityReminders().catch((error) => console.error('Sunday availability reminder check failed:', error));
    }
    scheduleNextAvailabilityReminderCheck();
    setInterval(() => {
      sendTaskReminders().catch((error) => console.error('Task reminder check failed:', error));
    }, 15 * 60 * 1000);
    setInterval(() => {
      flushPendingImportantNotifications().catch((error) => console.error('Notification delivery flush failed:', error));
    }, 10 * 1000);
    console.log(`Telegram background schedulers started independently of update transport (${PROJECT_TIME_ZONE}).`);
  }

  function startTelegramInboxWorker() {
    flushTelegramInbox().catch((error) => console.error('Telegram inbox startup flush failed:', error));
    setInterval(() => {
      if (isShuttingDown) return;
      flushTelegramInbox().catch((error) => console.error('Telegram inbox flush failed:', error));
    }, Math.max(250, Number(process.env.TELEGRAM_INBOX_POLL_INTERVAL_MS || 1000)));
  }

  setInterval(() => {
    try { pruneExpiredAvailabilityWeeks(); }
    catch (error) { console.error('Availability week rotation failed:', error); }
  }, 60 * 1000);

  if (sheetsConfig) {
    const maintainPrimarySheetWeek = async () => {
      const state = loadDatabase();
      const result = await ensurePrimaryWeekSheet(sheetsConfig, state.users, state.settings);
      if (result.rotated || result.layoutChanged) {
        await exportAvailabilitiesToSheet(sheetsConfig, state.users, state.availabilities);
      }
    };
    maintainPrimarySheetWeek().catch((error: any) => console.error('Google Sheets primary week maintenance failed:', error.message || error));
    setInterval(() => {
      maintainPrimarySheetWeek().catch((error: any) => console.error('Google Sheets primary week maintenance failed:', error.message || error));
    }, 60 * 60 * 1000);
    setInterval(async () => {
      try {
        await flushPendingSheetAvailabilityExports();
        await reconcileAvailabilityFromPrimarySheet();
      } catch (error: any) {
        console.error('Google Sheets fallback reconciliation failed:', error.message || error);
      }
    }, Math.max(30_000, sheetAvailabilityPullMinIntervalMs));
  }

  if (calendarConfig?.enabled) {
    reconcileMeetingCalendar().catch((error: any) => console.error('Google Calendar startup reconciliation failed:', error.message || error));
    setInterval(() => {
      retryPendingMeetingCalendar().catch((error: any) => console.error('Google Calendar retry failed:', error.message || error));
    }, 60 * 1000);
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    configureTelegramBotUi().catch((error: any) => {
      console.error('Telegram UI configuration failed:', error.message || error);
    });
    startTelegramInboxWorker();
    startBackgroundSchedulers();
    startTelegramLongPolling();
  });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownPromise) return;
    isShuttingDown = true;
    console.log(`${signal} received: stopping new requests and draining database persistence.`);
    let serverCloseError: Error | undefined;
    const serverClosed = new Promise<void>((resolve) => {
      httpServer.close((error) => {
        serverCloseError = error;
        resolve();
      });
      httpServer.closeIdleConnections?.();
    });

    shutdownPromise = (async () => {
      if (databaseSheetsFlushTimer) {
        clearTimeout(databaseSheetsFlushTimer);
        databaseSheetsFlushTimer = null;
      }
      const persistenceDrain = (async () => {
        await flushDatabaseSheetsSnapshots();
        return !pendingDatabaseSheetsState;
      })();
      const persistenceDrained = await Promise.race([
        persistenceDrain,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      if (persistenceDrained) {
        console.log('Database persistence drained successfully.');
      } else {
        console.warn('Google Sheets replication did not drain before shutdown; the durable recovery journal will resume it on restart.');
      }
      await Promise.race([
        serverClosed,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (serverCloseError) console.error('HTTP server close failed:', serverCloseError);
      process.exit(serverCloseError ? 1 : 0);
    })();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

startServer().catch((error) => {
  console.error('Server startup failed:', error);
  process.exitCode = 1;
});





