# B-05: свободное назначение встреч

08.10.2026. Java parity с согласованным 07.10.2026 Node production-контрактом:
собрания, монтажи и вайбики назначаются/переносятся на любой день и время.
Production в этом блоке не обновляется; старые данные не переписываются.

## Изменение

Общая нормализация MeetingRules больше не принимает SlotPolicy. Оба её
потребителя — MeetingService.create/update — используют один контракт.
Удалено неиспользуемое чтение/декодирование availability из сервиса встреч.
Настройки слотов, рекомендации и сохранение доступности не меняются.

Сохранены: будущая дата, валидные kind/title/date/time/audience, обязательное
активное мероприятие монтажа, права host/admin, optimistic version,
идемпотентность, snapshot-приглашения и RSVP, audit/outbox/Calendar jobs
в общей транзакции. Монтаж — 1…12 целых часов; meeting/vibe — 30…360 минут
с шагом 30. Окончание считается по фактической длительности, включая завтра.

## Проверки

MeetingRulesTests: три вида × семь дней × 00:00/08:15/23:59, точный Instant
Europe/Moscow и граница ongoing/past; прежние setup 1…12 часов и обязательный
event сохранены. Отдельно проверены прошлое и недопустимые длительности.

B05HttpIntegrationTests: settings разрешают только понедельник17–18, но
каждый вид создаётся в воскресенье00:00 и переносится на субботу23:59.
Проверяются точное сохранённое время, ночное окончание, RSVP yes после переноса,
однократные Calendar jobs/audit при replay, запрет переноса в прошлое с
сохранением версии, отказ в недопустимой длительности без новой версии/job,
неизменность availability settings.

Команда из backend/ после освобождения общего Maven/Docker окна:

```powershell
./mvnw.cmd --batch-mode '-DargLine=-Xmx512m' '-Dtest=MeetingRulesTests,B05HttpIntegrationTests,MeetingNotificationIntegrationTests,MeetingReminderIntegrationTests,B04HttpIntegrationTests,AvailabilityCalendarTests,SlotSuggestionEngineTests' test
```

Результат: **44 tests, 0 failures/errors/skipped, BUILD SUCCESS**, exit0,
`target/b05-unrestricted-scheduling-test.log`. Rules6, B05 HTTP8,
MeetingNotification10, MeetingReminder10, B04 HTTP4, calendar4, suggestions2.
Это целевой regression затронутого потока, не новый полный verify.
Компиляция/тесты параллельного B-08 verify начались до этих изменений
и не считаются их доказательством.
Все проверки используют disposable PostgreSQL, без Telegram/Google network.
В пакет включены прежние B04/availability calendar/slot suggestions, чтобы
проверить соседний поток слотов, который продолжает соблюдать свои settings.

## Остаток B-05

Свободное расписание не закрывает весь этап: legacy attendeeIds→yes,
legacy attribution и executable import/parity fixture остаются в связке B-09.
Не запускать импорт/переключение production по одному успешному тесту правил.

Ponytail full: удалена ставшая ненужной зависимость от availability и её SQL
чтение вместо исключений по отдельным видам/endpoint. Новых зависимостей,
миграций или второго scheduling service нет.
