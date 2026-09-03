import { moscowClock } from './reminderSchedule.js';
import type { SimulationState, User } from './types.js';

export function birthdayParts(value?: string) {
  const raw = String(value || '').trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const match = (iso ? `${iso[3]}.${iso[2]}.${iso[1]}` : raw).match(/^(\d{2})\.(\d{2})(?:\.(\d{2}|\d{4}))?$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : undefined;
  const date = new Date(Date.UTC(year || 2000, month - 1, day));
  if (date.getUTCFullYear() !== (year || 2000) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { day, month, year };
}

export function birthdayGiftCollectionText(birthdayDate: string, environment: NodeJS.ProcessEnv = process.env, closed = false) {
  const phone = environment.BIRTHDAY_PAYMENT_PHONE || '89105408050';
  const bank = environment.BIRTHDAY_PAYMENT_BANK || 'Сбер';
  const requestedAmount = Number(environment.BIRTHDAY_GIFT_MAX_AMOUNT);
  const maxAmount = Number.isFinite(requestedAmount) && requestedAmount > 0 ? requestedAmount : 400;
  const deadline = `${birthdayDate.split('-').reverse().join('.')} в 19:00 (МСК)`;
  if (closed) return `🎁 Сбор на подарок завершён. Дедлайн был ${deadline}. После этого времени покупаем подарок, деньги больше не переводите.`;
  return `🎁 Сбор на подарок: переводите на ${bank} по номеру ${phone}.`
    + `\nДо ${maxAmount} ₽ с человека — это максимальная сумма, можно отправить меньше.`
    + `\n⏰ Дедлайн: ${deadline}, в день рождения. После 19:00 сбор закрывается и покупаем подарок.`;
}

export function birthdayReminder(user: Pick<User, 'birthday' | 'realName'>, now = new Date(), environment: NodeJS.ProcessEnv = process.env) {
  const birthday = birthdayParts(user.birthday);
  if (!birthday) return null;
  const clock = moscowClock(now);
  for (const daysBefore of [2, 1, 0] as const) {
    const date = new Date(`${clock.dateKey}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + daysBefore);
    if (date.getUTCDate() !== birthday.day || date.getUTCMonth() + 1 !== birthday.month) continue;
    const birthdayDate = date.toISOString().slice(0, 10);
    const age = birthday.year ? date.getUTCFullYear() - birthday.year : null;
    const when = daysBefore === 2 ? 'Через 2 дня' : daysBefore === 1 ? 'Завтра' : 'Сегодня';
    return {
      daysBefore, birthdayDate, year: date.getUTCFullYear(),
      text: `🎂 ${when} день рождения у ${user.realName}!`
        + (age !== null ? ` Исполняется ${age} лет.` : '')
        + `\n\nНе забудьте поздравить 🎉\n\n${birthdayGiftCollectionText(birthdayDate, environment, daysBefore === 0 && clock.hour >= 19)}`,
    };
  }
  return null;
}

export async function deliverBirthdayReminders(dependencies: {
  loadState: () => SimulationState;
  saveState: (state: SimulationState) => unknown;
  send: (telegramId: string, text: string) => Promise<unknown>;
}, now = new Date(), environment: NodeJS.ProcessEnv = process.env) {
  const snapshot = dependencies.loadState();
  let delivered = 0;
  for (const birthdayUser of snapshot.users) {
    const reminder = birthdayReminder(birthdayUser, now, environment);
    if (!reminder) continue;
    for (const recipient of snapshot.users) {
      if (recipient.id === birthdayUser.id) continue;
      const legacyId = `bday_notify_${reminder.year}_${birthdayUser.id}_${recipient.id}`;
      const id = `${legacyId}_${reminder.daysBefore}`;
      const alreadySent = (state: SimulationState) => (state.messages[recipient.id] || []).some((message) => (
        message.id === id || (reminder.daysBefore === 1 && message.id === legacyId)
      ));
      if (alreadySent(dependencies.loadState())) continue;
      if (recipient.telegramId) {
        try {
          if (!await dependencies.send(recipient.telegramId, reminder.text)) continue;
        } catch {
          // Leave the reminder pending for the next check.
          continue;
        }
      }
      // Sending can take time: preserve all state changes made during delivery.
      const state = dependencies.loadState();
      if (alreadySent(state) || !state.users.some((user) => user.id === recipient.id)) continue;
      state.messages[recipient.id] ||= [];
      state.messages[recipient.id].push({ id, userId: recipient.id, sender: 'bot', text: reminder.text, timestamp: now.toISOString() });
      dependencies.saveState(state);
      delivered += 1;
    }
  }
  return delivered;
}
