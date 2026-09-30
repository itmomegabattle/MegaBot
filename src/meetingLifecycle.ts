import type { Meeting } from './types.js';
import { projectDateTimeInstant } from './projectTime.js';

export type MeetingPhase = 'upcoming' | 'ongoing' | 'past';

export function meetingInterval(meeting: Pick<Meeting, 'date' | 'time' | 'duration'>, now = new Date()) {
  const start = projectDateTimeInstant(meeting.date, meeting.time, now);
  if (!start) return null;
  const durationHours = Number(meeting.duration);
  if (!Number.isFinite(durationHours) || durationHours <= 0) return null;
  return {
    start,
    end: new Date(start.getTime() + durationHours * 60 * 60 * 1000),
  };
}

export function meetingPhase(meeting: Pick<Meeting, 'date' | 'time' | 'duration'>, now = new Date()): MeetingPhase {
  const interval = meetingInterval(meeting, now);
  if (!interval) return 'past';
  if (now.getTime() < interval.start.getTime()) return 'upcoming';
  if (now.getTime() < interval.end.getTime()) return 'ongoing';
  return 'past';
}

export function meetingStartTimestamp(meeting: Pick<Meeting, 'date' | 'time' | 'duration'>, now = new Date()) {
  return meetingInterval(meeting, now)?.start.getTime() ?? Number.POSITIVE_INFINITY;
}

export function meetingEndTimestamp(meeting: Pick<Meeting, 'date' | 'time' | 'duration'>, now = new Date()) {
  return meetingInterval(meeting, now)?.end.getTime() ?? Number.NEGATIVE_INFINITY;
}
