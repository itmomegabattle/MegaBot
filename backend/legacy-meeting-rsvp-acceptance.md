# Legacy RSVP: локальная projection и staging fixture

09.10.2026. Часть остатка B-05/B-09, не полный importer и не production import.

`migration/LegacyMeetingRsvps` — чистый преобразователь без Spring bean,
DB/HTTP/таймера. Он получает JSON одной встречи, уже разрешённую аудиторию
и множество IDs пользователей исходного снимка. Не подставляет текущую
команду, автора/admin или сегодняшнюю дату. Исходный JSON не изменяется.

Как в Node `normalizedMeetingRsvps`: явный rsvpByUser=yes/no приоритетнее
attendeeIds; attendee без явного ответа получает yes; остальные unanswered.
Все строки получают legacySource=true. Время старого ответа неизвестно:
responded_at остаётся NULL, не временем импорта. Организатор не получает
автоматический yes. Ответ no не придумывается по отсутствию attendee.

В отличие от runtime-нормализации importer должен не терять плохие данные:
неизвестные/дублирующиеся IDs, ответы вне разрешённой аудитории, неправильные
типы/null и значения кроме yes/no отклоняются безопасным кодом ошибки.
Будущий importer обязан записывать эти коды в migration_rejects и сохранять
неизменённый оригинал; этот преобразователь сам ничего не пишет.
Проверка ready/checksum/revision, дубликатов исходных users и JSON keys,
разрешение participants=all из исходного snapshot, исторические refs и
решения по конфликтам — обязанности полного B-09, не возможности этого класса.

## Исполняемые доказательства

Обезличенный fixture: `src/test/resources/parity/legacy-meeting-rsvp.json`.
Unit suite проверяет приоритет явного no над старым attendee, yes fallback,
unanswered, отсутствие мутации, immutable result и отрицательные случаи.

PostgreSQL fixture создаёт историческую completed встречу и применяет только
полученный план приглашений внутри транзакции. Проверяются реальные CHECK/FK,
legacy_source=true, NULL responded_at, одинаковые строки после повторного
применения и rollback всего набора при ошибке FK с успешной последующей попыткой.
Счётчики notification_deliveries/outbox/integration_jobs/audit остаются нулевыми.
SQL applyFixture — **только тестовый staging writer**, не production importer;
ON CONFLICT DO NOTHING не является политикой разрешения конфликтов импорта.

Из backend/ в согласованном свободном Maven/Docker окне:

```powershell
./mvnw.cmd --batch-mode '-DargLine=-Xmx512m' '-Dtest=LegacyMeetingRsvpsTests,LegacyMeetingRsvpsIntegrationTests,B05HttpIntegrationTests,MeetingRulesTests' test
```

Предварительный прогон: 20 tests, 0 failures/errors/skipped, BUILD SUCCESS,
exit0; лог `target/legacy-meeting-rsvp-test.log` (новых RSVP tests6, B05HTTP8,
Rules6). Выявлено пересечение testCompile с параллельным чатом. Поэтому этот
лог **не является окончательной приёмкой**; требуется чистая согласованная
компиляция/повтор. Исходники стабилизированы, следующий Maven принадлежит B-08.

Окончательная целевая приёмка: чистая сборка в отдельный
`target/navigation-verify-20261009`, лог
`target/telegram-slot-navigation-focused-final.log`: **101 tests, 0
failures/errors/skipped, BUILD SUCCESS**. Из них наши RSVP integration2+unit4;
остальные95 — параллельный B-08, не новые RSVP tests. Чистая компиляция без
пересечения подтверждена отдельным output; XML сохранены в его surefire-reports.
Последующий полный verify завершён: **541 tests, 0 failures/errors/skipped,
BUILD SUCCESS**, `target/telegram-slot-navigation-verify.log`, тот же отдельный
output. Включает актуальные B05/MeetingRules и шесть RSVP tests; не заменяет
ещё не реализованный полный importer или production-приёмку.
Production, Telegram/Google, реальный snapshot/токен не используются.

## Остаток

B-05/B-09 не закрыты: нужен настоящий ready snapshot→staging importer с
checksum/revision, ledger/rejects, всеми сущностями, атомарным применением,
проверкой counts/canonical hashes, конфликтов и повторного импорта.
Тестовый writer не подключать к HTTP и не запускать над рабочей БД.

Ponytail full: одна чистая projection, прежние Jackson/Testcontainers/JDBC,
без новых зависимостей, схемы/миграции, экспортной сети и второго доменного API.
