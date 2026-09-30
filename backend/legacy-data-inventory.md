# Legacy data inventory

Инвентаризация полей `src/types.ts` на 30.09.2026. Это карта миграции, а не целевая SQL-схема: массивы, словари и вложенные settings должны быть нормализованы по разделу 5 `backend.md`.

| Тип | Поля legacy |
|---|---|
| `User` | id, username, realName, role, avatarSeed, avatarDataUrl?, birthday?, telegramId?, registered?, competencies?, primaryCompetency?, facultyId?, joinedAt?, lastSeenAt?, active?, deactivatedAt?, deactivatedBy? |
| `Availability` | userId, slots, hardUnavailableDays?, outWeekIndexes?, weekVersions?, updatedAt, weekStart? |
| `Meeting` | id, title, kind?, eventId?, type, date, time, duration, hostId, participants, audiencePolicy?, audienceUserIds?, attendeeIds?, rsvpByUser?, competency?, topic?, description?, status, googleCalendarEventId? |
| `TaskNoteComment` | id, authorId, side, text, createdAt |
| `TaskAssigneeNote` | executor?, coordinator?, updatedAt?, history? |
| `WorkEvent` | id, name, description?, startsAt?, endsAt?, status, createdAt, createdBy? |
| `TaskReminder` | id, type, value, unit, sentAt?, lastSentAt? |
| `Task` | id, version?, title, description, deadline, assignedTo, creatorId?, competency?, competencies?, sow, tips, status, priority, createdAt?, completedAt?, assignmentMode?, completedBy?, cancelledAt?, cancelledBy?, timeSpentMinutes?, facultyId?, eventId?, reminders?, assigneeNotes?, completionComments? |
| `Faculty` | id, name |
| `BotMessage` | id, userId, sender, text, timestamp, buttons? |
| `SimulationState` | serverNow?, timeZone?, users, faculties?, facultyCompetencies?, competencies?, availabilities, meetings, events?, tasks, messages, settings? |
| `settings` | teamChatId?, teamImportantThreadId?, availabilityWeekCount?, availabilityActiveDays?, availabilityStartHour?, availabilityEndHour?, availabilityWeekNames?, availabilityWeekDescriptions?, availabilityWeekMetadata?, availabilityWeekStart?, pendingImportantNotifications?, notificationDeliveries?, notificationDeliverySummary?, telegramInbox?, databaseRevision?, idempotencyRecords? |
| `NotificationDelivery` | id, dedupeKey, category, recipientId?, chatId, text, replyMarkup?, messageThreadId?, disableNotification?, disableWebPagePreview?, intendedAt, availableAt, expiresAt?, status, attempts, leaseToken?, leasedUntil?, lastAttemptAt?, lastErrorCode?, lastErrorMessage?, telegramMessageId?, sentAt?, updatedAt |
| `TelegramInboxEntry` | updateId, chatKey, payload, status, receivedAt, availableAt, attempts, leaseToken?, leasedUntil?, lastAttemptAt?, lastError?, processedAt?, updatedAt |

## Legacy chat panels

`chat-panels.json` содержит version и временные структуры `panels`, `pendingSheetExports`, `slotDrafts`. Содержимое локального файла не копируется в fixtures. В Java:

- `panels` и незавершённые chat flows получают ограниченный TTL и не смешиваются с историей сообщений;
- `pendingSheetExports` переносится в `integration_jobs`;
- `slotDrafts` остаётся временным draft/FSM state, а не источником истины доступности;
- `notificationDeliveries` и `telegramInbox` являются durable очередями PostgreSQL и не хранятся внутри `app_settings`.
