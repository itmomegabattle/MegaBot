# HTTP parity baseline

Снимок на 30.09.2026: в текущем `server.ts` зарегистрировано 54 маршрута `/api/*`. Старое число 43 из первоначального аудита устарело после исправлений безопасности, доставки и эксплуатации. Колонка «Результат» означает состояние Java-переноса, а не работоспособность Node.

Обозначения ролей: `public` — без пользовательской сессии, но с указанной transport-проверкой; `self` — вошедший пользователь только над своими данными; `core` — активный участник основной команды; `faculty` — участник своего факультета; `admin` — администратор. Точные отрицательные проверки уточняются при соответствующем B-этапе.

| Legacy route | Java use case / этап | Роли | Проверки | Результат |
|---|---|---|---|---|
| GET `/api/health/live` | Actuator liveness / B-01 | public | live без БД | scaffold |
| GET `/api/health/ready` | Actuator readiness / B-01 | public | DB up/down | scaffold |
| GET `/api/health` | compatibility health DTO / B-09 | public | без секретов | not started |
| POST `/api/auth/logout` | revoke session / B-03 | self | repeat, expired | not started |
| POST `/api/user/get-or-create` | Telegram auth/session / B-03 | signed public | forged, stale, replay | not started |
| GET `/api/state` | scoped bootstrap DTO / B-03/09 | self | 4 roles, field leaks | B-04 fields, B-05 meetings and B-06 tasks/tips/reminders/comments implemented; PostgreSQL suite executed; production adoption B-09/B-10 |
| GET `/api/admin/diagnostics` | operational diagnostics / B-11 | admin | queue age, no secrets | not started |
| GET `/api/notification-deliveries` | delivery journal / B-07 | admin | pagination, filters | not started |
| POST `/api/notification-deliveries/retry` | retry selected delivery / B-07 | admin | idempotent, sent forbidden | not started |
| GET `/api/faculty/me` | faculty bootstrap / B-04 | faculty | cross-faculty denied | Java endpoint implemented; PostgreSQL run pending |
| GET `/api/faculty/my-tasks` | faculty tasks / B-06 | faculty | scope and history | Java v1/legacy DTO tested on PostgreSQL, own/all scope, assignment and note privacy; production switch B-09/B-10 |
| GET `/api/integrations/google-sheets/availability` | availability export / B-08 | admin | 2–5 weeks, versions | not started |
| GET `/api/integrations/google-sheets/task-log` | task-log export / B-08 | admin | archived history | not started |
| GET `/api/integrations/google-sheets/mapping` | mapping diagnostics / B-08 | admin | no credentials | not started |
| POST `/api/integrations/google-sheets/webhook` | signed narrow import / B-08 | signed public | signature, stale, echo | not started |
| POST `/api/integrations/google-sheets/template` | template update / B-08 | admin | dry-run, conflict | not started |
| POST `/api/telegram-webhook` | durable Telegram inbox / B-08 | secret public | duplicate, failure, order | Java v1 intake/secret/commit-before-ack, claim/lease/recovery + manual private /start, help, own profile and role-specific menu DB/outbox; command replies/keyboard use shared sender with source-command/current-role/binding/profile-version/expiry gates; dialog Back pending; no automatic incoming consumer; reception FIFO only, reordered policy/callback dedupe/legacy route pending; disabled default; see telegram-inbox.md |
| POST `/api/user/add` | create/invite member / B-04 | admin | duplicate Telegram ID | Java v1 implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/user/update` | update member/profile / B-04 | admin/self scoped | role escalation, version | Java v1 implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/user/delete` | deactivate member / B-04 | admin | last admin, references | Java v1 implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/competency/add` | add competency / B-04 | admin | duplicate name/id | Java v1 implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/competency/delete` | retire competency / B-04 | admin | referenced competency | Java v1 implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/faculty/competency/add` | add faculty competency / B-04 | faculty admin | cross-faculty | not started |
| POST `/api/faculty/competency/delete` | retire faculty competency / B-04 | faculty admin | referenced competency | not started |
| POST `/api/faculty/user/add` | add faculty member / B-04 | faculty admin | one-faculty rule | not started |
| POST `/api/faculty/user/update` | update faculty member / B-04 | faculty admin | cross-faculty, version | not started |
| POST `/api/faculty/user/delete` | deactivate faculty member / B-04 | faculty admin | history preserved | not started |
| POST `/api/availability/weeks` | save dated week / B-04 | self/admin scoped | stale version, independent weeks | Java v1 implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/availability/week-name` | week metadata / B-04 | admin | Monday/date binding | Java v1 implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/availability` | compatibility availability save / B-04/09 | self/admin scoped | strict date, partial update | v1 dated endpoint implemented; compatibility adapter pending |
| POST `/api/event/create` | create work event / B-04 | admin | invalid interval, idempotency | Java v1 implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/event/update` | update/archive event / B-04 | admin | version, history | Java v1 implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/meeting` | create meeting / B-05 | core/admin | type rules, transaction | Java v1 implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/meeting/update` | update meeting / B-05 | host/admin | stale version, resend | Java v1 implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/meeting/delete` | cancel meeting / B-05 | host/admin | repeat, old callbacks | Java v1 implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/meeting/rsvp` | explicit RSVP / B-05 | invited self | repeat, not invited | Java v1 implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/meeting/suggest` | deterministic slot suggestions / B-05 | core | TZ, unavailable reasons | Java availability suggestions implemented; legacy adapter and PostgreSQL run pending |
| POST `/api/faculty/task/create` | create faculty task / B-06 | core coordinator | scope, idempotency | Java legacy/v1 scoped create implemented, including all-faculty shared scope; production switch pending |
| POST `/api/faculty/task/update` | update faculty task / B-06 | author/admin | version, transition | Java legacy/v1 partial update implemented; production switch pending |
| POST `/api/task/create` | create task / B-06 | admin/coordinator | idempotency, assignment | Java legacy/v1 with tips/reminders implemented; session actor only, production switch pending |
| POST `/api/task/update` | update task / B-06 | admin/coordinator | version, transition | Java legacy/v1 partial update implemented; production switch pending |
| POST `/api/task/comment` | add task comment / B-06 | assignee/coordinator | cancelled task, duplicate | Java legacy/v1 append-only implemented; session actor, version and key required; production switch pending |
| POST `/api/task/delete` | cancel task / B-06 | admin/coordinator | repeat, history | Java legacy/v1 cancel implemented; session actor, history retained, replay; production switch pending |
| POST `/api/task/notify` | enqueue reminder / B-06/07 | admin/coordinator | silent, dedupe | B-06 durable intent/audit/replay tested on PostgreSQL; delivered=0; actual worker belongs to B-07 |
| POST `/api/task/claim` | claim shared task / B-06 | eligible core | concurrent claim | Java legacy/v1 atomic claim implemented; session actor, version and key required; production switch pending |
| POST `/api/task/release` | release own assignment / B-06 | assignee | multi-assignee safety | Java legacy/v1 own release implemented; colleagues preserved, compatible result flags; production switch pending |
| POST `/api/task/status` | task transition / B-06 | scoped actor | transition matrix, repeat | Java legacy/v1 transitions implemented; closed-result edit needs reopen; production switch pending |
| POST `/api/task/log/clear` | disabled destructive command / B-06 | admin | no deletion | Java legacy 410 and permission-negative tested on PostgreSQL |
| POST `/api/task/archive/preview` | archive preview / B-06 | admin | exact selection | Java legacy POST/v1 GET implemented and PostgreSQL tested; fingerprint mandatory on subsequent clear |
| POST `/api/task/archive/clear` | archive selected tasks / B-06 | admin | confirmation/version | Java legacy/v1 recovery clear tested; active tasks/history preserved, replay/restore; client fingerprint adoption B-09/B-10 |
| POST `/api/task/season-reset/preview` | reset preview / B-06 | admin | exact impact | Java legacy POST/v1 GET implemented and PostgreSQL tested |
| POST `/api/task/season-reset` | controlled season reset / B-06 | admin | confirmation/rollback | Java legacy/v1 reset tested; version fingerprint, confirmation, rollback, queue cancellation and race; production switch B-09/B-10 |
| GET `/api/task/export` | paged current-task export / B-06 | admin | pagination, escaping | Java legacy current CSV and separate v1 history CSV tested; no-store/nosniff/formula protection; CSV pagination adoption B-09/B-10 |
| POST `/api/team/broadcast` | shared create immediate/scheduled broadcast / B-07 | active registered core session | frozen audience, atomic idempotency; 202/delivered=0 | Java legacy adapter tested separately; frontend cutover, Node request/volume anti-spam, formatter/history still pending; see legacy-broadcast.md |

## Не-HTTP parity gates

Task-domain acceptance B-06 закрыт 01.10.2026: [b06-acceptance.md](b06-acceptance.md), полный PostgreSQL verify — 118 tests, 0 failures/errors/skipped. Task строки выше означают проверенный Java backend, не переключённый production. Реальные delivery/callback/integration gates ниже относятся к B-07/B-08, не заменяются доменными тестами B-06. Production frontend switch остаётся B-09/B-10.

- Telegram: `/start`, личные меню, слоты, встречи, задачи, faculty flows, group commands, callbacks, старые кнопки, restart и два топика.
- Уведомления: встреча, RSVP, задача, рассылка, слоты и birthday — для каждого фиксируются audience snapshot, dedupe key, target/thread, retry/unknown и текст.
- Интеграции: Calendar и Sheets выполняются jobs после commit; fake-режим не считается живой проверкой.
- Конкурентность: positive, permission-negative и race/replay тесты обязательны до смены статуса строки на `passed`.
