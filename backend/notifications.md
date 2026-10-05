# Очередь доставки: B-07

## Реализованное ядро

V029 расширяет существующую очередь частями длинных рассылок, а не создаёт новую. Общие claim/start проверяют подтверждение всех предыдущих частей target; API и expiry notice считают адресатов через один view. Контракт и границы plain-text: [broadcast-parts.md](broadcast-parts.md).

`DeliveryQueue` и V011 используют существующую `notification_deliveries`, не создавая несовместимую вторую очередь. Начальное состояние — `planned` (так называется pending в V004). Захват — `claimed`; внешний запрос — `sending`. Только начало реальной попытки повышает attempts и записывает delivery_attempts. Все методы — короткие транзакции; HTTP внутри них запрещён.

Enqueue требует уже открытую доменную транзакцию (MANDATORY): domain+delivery либо commit вместе, либо rollback вместе. Dedupe key сравнивает immutable target/payload/times/category/silent; совпадающий запрос возвращает прежний ID без сброса sent/retry/lease, другой payload получает 409. `initial_available_at` отдельно сохраняет исходное значение: изменение available_at при retry не ломает дедупликацию.

Claim выбирает максимум 100 due rows через PostgreSQL SKIP LOCKED. И intended_at, и available_at должны наступить по часам БД. Просроченные, отменённые, terminal и исчерпавшие восемь попыток задания не захватываются. Clock JVM/браузера не решает, что уже due. Lease 1–120 целых секунд, ownership — случайный token и ID строки; claimed_at и leased_until сохраняются.

Start — атомарный token/status/lease/due/expiry/cancel gate с записью попытки. Один token не может начать две попытки. Heartbeat продлевает только ещё действительную аренду; истёкший владелец не может вернуть себе право отправки или записать результат. Dispatcher проверяет shared quota и domain gate, затем выполняет start, commit, HTTP и finish для broadcast, task_reminder, task_manual и meeting_event. Сетевой sender реализован, но выключен по умолчанию: [dispatcher.md](dispatcher.md).

Finish сохраняет sent с положительным provider message_id; definitive retry с доступностью не раньше Retry-After; permanent failed или ambiguous unknown. Retry не выходит за expiry, не переживает восемь попыток и не возобновляется после cancel_requested. Start/response/sent timestamps сохранены отдельно, UTC. Повтор finish/stale token ничего не меняет.

Recovery до start возвращает задачу в planned, после start переводит в unknown и завершает незакрытую попытку соответствующим кодом. Unknown никогда не выбирается автоматически. Cancel до start завершает задачу и отнимает token; cancel во время HTTP только ставит cancel_requested — успешный provider response всё равно остаётся sent. Отзыв Telegram-сообщения не обещается. Expiry также не подменяет неизвестный результат отправки.

V011 при обновлении старых sending rows без подтверждения границы HTTP переводит их в unknown, а не автоматически повторяет. Это защитная миграция; V001–V010 не переписываются.

## Исполняемые проверки

Task status/completion подключены с отдельной category `task_status` и тем же audited task intent link: [task-status-delivery.md](task-status-delivery.md). V019 сохраняет current actor/coordinator/status/version проверки. Комментарии/отмена подключены отдельно через V022: [task-comment-cancel-delivery.md](task-comment-cancel-delivery.md).

Полный verify после V019 — **230 tests, 0 failures/errors/skipped, BUILD SUCCESS**, log `target/task-status-final-verify.log`. Блок статусов завершён; B-07 и live/VDS/SLO приёмка ещё открыты.

Создание задач теперь материализуется как `task_created` через существующие audited task intents: [task-creation-delivery.md](task-creation-delivery.md). Доменный sender whitelist дополнен этой category с обязательным task intent link. V018 сохраняет предыдущие миграции и manual semantics; остальные task mutation events пока не материализуются.

Полный verify после task creation/V018 — **223 tests, 0 failures/errors/skipped, BUILD SUCCESS** (8 новых + прежние 215), log `target/task-creation-final-verify.log`. B-07 остаётся открыт, live sender выключен.

После bounded drain/fairness полный verify — **215 tests, 0 failures/errors/skipped, BUILD SUCCESS**, log `target/drain-final-verify.log`. Wakeup ограничен 100 проходами/1 секундой, новые DB/unit сценарии сохраняют cancellation/unknown, shutdown между отправками и исходный intended-order после quota deferral. Отдельный load: 3 tests/3000 отправок, без дублей/потерь/ранних starts. [delivery-load-report.md](delivery-load-report.md) сравнивает прежний и новый scheduler; это не live/VDS приёмка.

Отдельный нагрузочный блок: [delivery-load-report.md](delivery-load-report.md), `DeliveryLoadIT` (не входит в обычный verify). Baseline выявил ограничение одного target за 500 ms wakeup; bounded drain/fairness устраняют этот лимит. Повторные engine и штатный Spring scheduler прогоны используют по 1000 адресатов. Это не live Telegram/VDS/SLO приёмка.

После meeting notifications/V017 полный verify 04.10.2026 — **210 tests, 0 failures/errors/skipped, BUILD SUCCESS** (10 новых + прежние 200); log `target/meeting-notification-verify.log`. Законченный блок личных/group-topic уведомлений создания/правки/отмены: [meeting-notifications.md](meeting-notifications.md). B-07 открыт, live отправки не включены.

После worker progress полный verify 04.10.2026 — 200 tests, 0 failures/errors/skipped, BUILD SUCCESS (5 новых + прежние 195); log `target/worker-progress-verify.log`. Локальный heartbeat/status подключён к admin diagnostics, без новых зависимостей или миграций; TIME-06/B-07 остаются открытыми.

После delivery diagnostics полный verify 04.10.2026 — 195 tests, 0 failures/errors/skipped, BUILD SUCCESS (6 диагностических + 1 OpenAPI reference test + прежние 188). OpenAPI 65 paths; log `target/diagnostics-verify.log`. [delivery-diagnostics.md](delivery-diagnostics.md) описывает значения и ограничения; B-07/TIME-06 не закрыты.

После manual task delivery/V016 полный verify 04.10.2026 — 188 tests, 0 failures/errors/skipped, BUILD SUCCESS (8 новых + прежние 180). Log `target/manual-task-verify.log`; контракт: [manual-task-delivery.md](manual-task-delivery.md). B-07 остаётся открытым.

После scheduled task reminders/V015 полный verify 04.10.2026 — 180 tests, 0 failures/errors/skipped, BUILD SUCCESS (10 новых + прежние 170). Log `target/reminder-verify.log`; контракт: [task-reminder-delivery.md](task-reminder-delivery.md). B-07 остаётся открытым.

После добавления журнала/manual retry/V014 полный verify — 170 tests, 0 failures/errors/skipped, BUILD SUCCESS (7 новых + прежние 163), OpenAPI 64 paths. Log `target/journal-verify.log`; контракт и границы: [delivery-journal.md](delivery-journal.md).

После добавления broadcast sender/quota/transport и V013 полный verify 03.10.2026 — 163 tests, 0 failures/errors/skipped, BUILD SUCCESS (21 новый + прежние 142). Log `target/dispatcher-verify.log`; TIME-03 закрыт как durable queue, не весь B-07. Границы и тесты: [dispatcher.md](dispatcher.md).

После добавления broadcast API и V012 полный `mvnw.cmd --batch-mode verify` 01.10.2026 на PostgreSQL 17.11 — 142 tests, 0 failures/errors/skipped, BUILD SUCCESS. 12 broadcast сценариев проверяют также совместимость с прежними 130 тестами; log `target/broadcast-verify.log`. Контракт: [broadcasts.md](broadcasts.md).

Проверено 01.10.2026: полный `mvnw.cmd --batch-mode verify` на PostgreSQL 17.11 — 130 tests, 0 failures/errors/skipped, BUILD SUCCESS. 12 новых queue DB-тестов и все прежние 118 проверок выполнены вместе. Локальный generated log: `target/b07-queue-verify.log`.

`DeliveryQueueIntegrationTests` использует настоящий PostgreSQL: transactional enqueue/rollback, dedupe после retry, два конкурентных claims, future intended/available и expiry, двойной start, неправильный/stale token, heartbeat, crash до/после start, cancellation до/после HTTP, Retry-After, предел восьми попыток, 403 и lost response, terminal states и валидация.

Тесты сдвигают due/lease timestamps в изолированной БД, не ждут реальных дней. Они не являются тестами настоящего Telegram HTTP, измерением точности на VDS или доказательством выполнения всех TIME-07.

## Остаток B-07

Group/topic allowlist V028 подключён к существующему BroadcastService/queue/journal: [broadcast-group-allowlist.md](broadcast-group-allowlist.md). Только admin approvals, frozen version/bot/chat/topic, shared start/retry gate и scoped claim; UI и реальные группы не включены.

Авторское expiry-уведомление V027 реализовано в общем worker: [broadcast-expiry-notice.md](broadcast-expiry-notice.md). UNIQUE source/revision, atomic queue, frozen author/chat и current gates; новое поле expiryNotice не увеличивает аудиторию исходной рассылки.

DB outage acceptance выполнена в своём PostgreSQL Testcontainer: [database-outage-acceptance.md](database-outage-acceptance.md). Реальный pause/unpause проверяет восстановление до HTTP и unknown после принятия fake провайдером без повторов; process/DB restart/disk/VDS drills и вся TIME-07 этим не закрыты.

Claim/release → task_assignment координатору, admins при claim и frozen competency open-board аудитории после последнего release реализованы: [task-status-delivery.md](task-status-delivery.md). Kind адресата и его текущие права проверяются до HTTP; прежняя широкая рассылка всем участникам не восстанавливается. Общая queue/lease/quota и выключенный sender сохраняются.

Дополнение 04.10.2026: task_status, task_updated и task_unassigned также подключены к общему sender через audited task_manual_id. Правки адресуются текущим/новым исполнителям либо frozen open competency-аудитории; снятые исполнители получают только прежнее название и факт снятия: [task-update-delivery.md](task-update-delivery.md). Comment/cancel также подключены: [task-comment-cancel-delivery.md](task-comment-cancel-delivery.md).

- Scheduled task reminders/occurrences, legacy manual notify, task created и meeting created/updated/cancelled подключены к общей queue/sender: [task-reminder-delivery.md](task-reminder-delivery.md), [manual-task-delivery.md](manual-task-delivery.md), [task-creation-delivery.md](task-creation-delivery.md), [meeting-notifications.md](meeting-notifications.md). Предвстречные и прочие оставшиеся occurrences ещё требуют materialization.
- Dispatcher, shared PostgreSQL quota и bounded Telegram HTTP transport реализованы, выключены по умолчанию: [dispatcher.md](dispatcher.md). Он захватывает broadcast, scheduled task_reminder, task_manual, task_created и meeting_event с domain link; полноценные outage/drill/VDS проверки впереди.
- Broadcast v1 create/list/get/patch/cancel и materialization личной core-аудитории реализованы: [broadcasts.md](broadcasts.md). V012 сохраняет настройки отбора и недоступные targets; start повторно проверяет revision, активность автора/адресата, Telegram-привязку и заполненность слотов. Legacy `/api/team/broadcast` подключён к общему домену: [legacy-broadcast.md](legacy-broadcast.md). Общие request/volume лимиты также подключены: [broadcast-creation-quota.md](broadcast-creation-quota.md). Frontend cutover, group/topic allowlist и UI ещё впереди.
- Materialization остальных outbox-событий и reminder occurrences.
- Domain gates/dispatcher для остальных категорий, полный graceful shutdown/readiness/DB outage drill и наблюдаемость.
- Admin-only агрегатная диагностика уже реализована: [delivery-diagnostics.md](delivery-diagnostics.md). Она показывает queue age/status, first-start lateness, pool и локальный worker progress/heartbeat, но не заменяет NTP/внешние alarms, настоящий load/restart/drill и измерение SLO.
- Durable dedupe/misfire/grace и повторные/birthday/slots occurrences; 500 ms wakeup для broadcast уже реализован независимо от polling.
- Журнал и explicit unknown retry API реализованы: [delivery-journal.md](delivery-journal.md). UI журнала/подтверждения, остальные retry actions, метрики, 1000-job latency report и вся TIME-07 с outage/переносом/partial cancellation впереди.
- UI планирования относится также к D-11/TIME-02; live credentials/production включение не происходят автоматически.

B-07 остаётся открытым. Lease lifecycle и sender без измерений не обещают отправку ровно в 12:00; сетевую доставку нельзя включать автоматически при наличии token.

Sunday slots/V025 подключены к той же очереди: weekly occurrence, frozen personal targets, DB-clock 18:00–21:00 МСК и общий completeness gate. Контракт: [availability-reminder-delivery.md](availability-reminder-delivery.md). Sender по умолчанию выключен; эксплуатационная приёмка и UI системных уведомлений остаются впереди.

Birthday/V026: три calendar occurrences, immutable core audience без именинника, source/recipient/date/binding gate, day-end expiry и проверка 19:00 в последнем шаге перед HTTP. Контракт: [birthday-reminder-delivery.md](birthday-reminder-delivery.md). Владелец 05.10.2026 выбрал 12:00 МСК для всех трёх напоминаний; реальных отправок и смены production-конфигурации нет.
