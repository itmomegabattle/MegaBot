import assert from 'node:assert/strict';
import { birthdayGiftCollectionText, birthdayParts, birthdayReminder, deliverBirthdayReminders } from '../src/birthdayGift.js';
import type { SimulationState } from '../src/types.js';

const person = { birthday: '05.09.2000', realName: 'Участник' };
for (const [date, offset, text] of [
  ['2030-09-03T09:00:00Z', 2, 'Через 2 дня'],
  ['2030-09-04T09:00:00Z', 1, 'Завтра'],
  ['2030-09-05T09:00:00Z', 0, 'Сегодня'],
] as const) {
  const reminder = birthdayReminder(person, new Date(date), {});
  assert.equal(reminder?.daysBefore, offset);
  assert.ok(reminder?.text.includes(text));
  assert.match(reminder!.text, /Исполняется 30 лет/);
  assert.match(reminder!.text, /Сбер по номеру 89105408050/);
  assert.match(reminder!.text, /До 400 ₽ с человека/);
  assert.match(reminder!.text, /05\.09\.2030 в 19:00 \(МСК\)/);
  assert.match(reminder!.text, /После 19:00 сбор закрывается и покупаем подарок/);
}
assert.equal(birthdayReminder(person, new Date('2030-09-02T20:59:59Z'), {}), null);
assert.equal(birthdayReminder(person, new Date('2030-09-02T21:00:00Z'), {})?.daysBefore, 2, 'calendar day is Moscow, not UTC');
assert.match(birthdayReminder(person, new Date('2030-09-05T15:59:59Z'), {})!.text, /Сбер/);
const closed = birthdayReminder(person, new Date('2030-09-05T16:00:00Z'), {})!.text;
assert.match(closed, /Сбор на подарок завершён/);
assert.doesNotMatch(closed, /переводите на/);
assert.equal(birthdayReminder({ ...person, birthday: '01.01.2000' }, new Date('2030-12-30T09:00:00Z'), {})?.birthdayDate, '2031-01-01');
assert.equal(birthdayReminder({ ...person, birthday: '29.02.2000' }, new Date('2032-02-27T09:00:00Z'), {})?.daysBefore, 2);
assert.equal(birthdayReminder({ ...person, birthday: '29.02.2000' }, new Date('2031-03-01T09:00:00Z'), {}), null);
assert.deepEqual(birthdayParts('2000-09-05'), { day: 5, month: 9, year: 2000 });
assert.equal(birthdayParts('31.02.2000'), null);
assert.doesNotMatch(birthdayReminder({ ...person, birthday: '05.09' }, new Date('2030-09-03T09:00:00Z'), {})!.text, /лет/);
assert.match(birthdayGiftCollectionText('2030-09-05', { BIRTHDAY_PAYMENT_PHONE: '123', BIRTHDAY_PAYMENT_BANK: 'Другой банк', BIRTHDAY_GIFT_MAX_AMOUNT: '250' }), /Другой банк по номеру 123/);
assert.match(birthdayGiftCollectionText('2030-09-05', { BIRTHDAY_GIFT_MAX_AMOUNT: '250' }), /До 250 ₽ с человека/);

const fixture: SimulationState = {
  users: [
    { id: 'birthday', username: '@birthday', realName: person.realName, birthday: person.birthday, telegramId: '1', role: 'organizer', avatarSeed: '1' },
    { id: 'recipient', username: '@recipient', realName: 'Получатель', telegramId: '2', role: 'organizer', avatarSeed: '2' },
  ],
  competencies: [], tasks: [], meetings: [], availabilities: {}, messages: {}, settings: {},
};
let state = structuredClone(fixture);
const sent: { id: string; text: string }[] = [];
let fail = false;
const dependencies = {
  loadState: () => structuredClone(state),
  saveState: (next: SimulationState) => { state = next; },
  send: async (id: string, text: string) => {
    if (fail) return false;
    sent.push({ id, text });
    state.settings = { ...state.settings, availabilityWeekCount: 3 };
    return true;
  },
};
for (const day of [3, 4, 5]) {
  const now = new Date(`2030-09-0${day}T09:00:00Z`);
  assert.equal(await deliverBirthdayReminders(dependencies, now, {}), 1);
  state = JSON.parse(JSON.stringify(state));
  assert.equal(await deliverBirthdayReminders(dependencies, now, {}), 0, 'restart and periodic checks must not duplicate a notice');
}
assert.equal(sent.length, 3);
assert.ok(sent.every((item) => item.id === '2'), 'gift reminders must exclude the birthday person');
assert.equal(new Set(state.messages.recipient.map((message) => message.id)).size, 3);
assert.equal(state.settings?.availabilityWeekCount, 3, 'concurrent state updates must survive notification delivery');
state = structuredClone(fixture);
fail = true;
assert.equal(await deliverBirthdayReminders(dependencies, new Date('2030-09-03T09:00:00Z'), {}), 0);
assert.equal(state.messages.recipient, undefined, 'failed sends must remain eligible for retry');
fail = false;
assert.equal(await deliverBirthdayReminders(dependencies, new Date('2030-09-03T09:15:00Z'), {}), 1);
state.messages.recipient.push({ id: 'bday_notify_2030_birthday_recipient', userId: 'recipient', sender: 'bot', text: 'Старое уведомление за день', timestamp: '2030-09-04T09:00:00Z' });
assert.equal(await deliverBirthdayReminders(dependencies, new Date('2030-09-04T09:15:00Z'), {}), 0);
assert.equal(await deliverBirthdayReminders(dependencies, new Date('2030-09-05T09:15:00Z'), {}), 1, 'legacy notice must not suppress the birthday-day reminder');
console.log('Birthday reminders passed: three dates, Moscow midnight, 19:00 deadline, Sber, unchanged phone, deduplication, retries and legacy history.');
