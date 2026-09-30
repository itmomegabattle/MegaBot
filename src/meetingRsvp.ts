import type { Meeting, MeetingRsvp } from './types.js';

export function normalizedMeetingRsvps(meeting: Pick<Meeting, 'attendeeIds' | 'rsvpByUser'>) {
  const result: Record<string, MeetingRsvp> = {};
  Object.entries(meeting.rsvpByUser || {}).forEach(([userId, response]) => {
    if (userId && (response === 'yes' || response === 'no')) result[userId] = response;
  });
  (meeting.attendeeIds || []).forEach((userId) => {
    if (userId && !result[userId]) result[userId] = 'yes';
  });
  return result;
}

export function meetingRsvpFor(meeting: Pick<Meeting, 'attendeeIds' | 'rsvpByUser'>, userId: string): MeetingRsvp | 'unanswered' {
  return normalizedMeetingRsvps(meeting)[userId] || 'unanswered';
}

export function setMeetingRsvp(meeting: Meeting, userId: string, response: MeetingRsvp | 'unanswered') {
  const rsvps = normalizedMeetingRsvps(meeting);
  const previous = rsvps[userId] || 'unanswered';
  if (response === 'unanswered') delete rsvps[userId];
  else rsvps[userId] = response;
  meeting.rsvpByUser = rsvps;
  meeting.attendeeIds = Object.entries(rsvps).filter(([, value]) => value === 'yes').map(([id]) => id);
  if (response === 'yes' && meeting.participants !== 'all' && !meeting.participants.includes(userId)) {
    meeting.participants = [...meeting.participants, userId];
  }
  return { changed: previous !== response, response };
}
