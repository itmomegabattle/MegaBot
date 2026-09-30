import assert from 'node:assert/strict';
import { meetingPhase } from '../src/meetingLifecycle.js';
import { meetingRsvpFor, setMeetingRsvp } from '../src/meetingRsvp.js';
import type { Meeting } from '../src/types.js';

const meeting = (date: string, time: string, duration: number): Meeting => ({
  id: 'meeting-test', title: 'Тест', kind: 'meeting', type: 'general', date, time, duration,
  hostId: 'host', participants: 'all', attendeeIds: ['legacy'], status: 'scheduled',
});

assert.equal(meetingPhase(meeting('24.09.2026', '12:00', 1), new Date('2026-09-24T08:59:59Z')), 'upcoming');
assert.equal(meetingPhase(meeting('24.09.2026', '12:00', 1), new Date('2026-09-24T09:00:00Z')), 'ongoing');
assert.equal(meetingPhase(meeting('24.09.2026', '12:00', 1), new Date('2026-09-24T10:00:00Z')), 'past');
assert.equal(meetingPhase(meeting('24.09.2026', '23:30', 2), new Date('2026-09-24T21:15:00Z')), 'ongoing', 'late meeting must remain active after midnight Moscow time');

const rsvpMeeting = meeting('25.09.2026', '12:00', 1);
assert.equal(meetingRsvpFor(rsvpMeeting, 'legacy'), 'yes');
assert.equal(meetingRsvpFor(rsvpMeeting, 'new-user'), 'unanswered');
setMeetingRsvp(rsvpMeeting, 'new-user', 'no');
assert.equal(meetingRsvpFor(rsvpMeeting, 'new-user'), 'no');
assert.equal(rsvpMeeting.attendeeIds?.includes('new-user'), false, 'declined user is not an attendee');
setMeetingRsvp(rsvpMeeting, 'new-user', 'yes');
assert.equal(rsvpMeeting.attendeeIds?.includes('new-user'), true);
setMeetingRsvp(rsvpMeeting, 'new-user', 'unanswered');
assert.equal(meetingRsvpFor(rsvpMeeting, 'new-user'), 'unanswered');

console.log('Meeting lifecycle and RSVP checks passed.');
