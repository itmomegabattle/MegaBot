# B-07 / TIME-02: разрешённые группы и топики

V028 / `broadcast_group_targets` — явное разрешение **ручных рассылок**, не автоматическое доверие всем `chat_bindings` встреч. Отдельный список нужен потому, что привязка «ВАЖНОЕ» для уведомлений о встречах не разрешает произвольный текст команды. Никакие существующие или production группы автоматически не добавляются.

## Управление разрешениями

- `GET /api/v1/broadcast-group-targets`: активная core-сессия получает только active id/label; без bot/chat/thread IDs. `limit=1..100` (50 default), cursor, items/nextCursor.
- `GET /api/v1/admin/broadcast-group-targets`: только admin, включает active/revoked, botId/chatId/messageThreadId/version для управления.
- `POST /api/v1/admin/broadcast-group-targets`: admin, same-origin Origin и Idempotency-Key. Body: label (1…120), числовая строка botId, отрицательный chatId, положительный messageThreadId либо null для всей группы, обязательный active. Ответ id/version, 201.
- `PATCH /api/v1/admin/broadcast-group-targets/{id}`: полная замена тех же полей и обязательная expectedVersion. active=false отзывает разрешение; любая правка повышает version. Старая версия / duplicate transport address → 409. DELETE отсутствует, история/FK сохраняются.

Audit и idempotency в той же транзакции. SQL UNIQUE NULLS NOT DISTINCT исключает дубль whole-group (null topic), как и topic. Organizer/faculty не управляют разрешениями; скрытие UI не является контролем доступа. Администратор самостоятельно проверяет корректность числовых адресов и доступ бота: сохранение разрешения не вызывает Telegram и не обещает наличие бота/топика. Ответ Telegram 400/403 остаётся честным failed.

## Рассылка

`POST/PATCH /api/v1/broadcasts` принимают `recipientMode="groups"` и непустой `groupTargetIds` (до 100, повторяющиеся IDs дедуплицируются). Только active approvals; unknown/inactive ID → 400 и rollback всей команды. Нельзя смешивать с personal recipientIds/competencyIds/weekStart; groupTargetIds в personal режиме также отвергаются. Legacy `/api/team/broadcast` сохраняет четыре прежних личных режима. Arbitrary bot/chat/thread в запросе не заменяют разрешённый target.

Основная команда может выбирать уже разрешённые IDs; только admin меняет сам список. При создании сохраняются group approval ID/version, bot/chat/topic и null recipientId в существующих broadcast_targets. Права и quota, schedule/misfire/grace, idempotency, revision/cancel, immutable payload и transactional DeliveryQueue те же. Личные dedupe keys и старые Mutation constructors сохранены. Группа и её отдельный topic — два различных разрешения: при выборе обоих создаются две явные доставки.

Snapshot не расширяется новыми разрешениями. Before start проверяются current approval active/version и точное bot/chat/topic соответствие frozen target/delivery; после отзыва и повторного разрешения старый version **не оживает**. Любая правка (даже label) требует новой рассылки для прежнего snapshot. Parent broadcast lock → approval share lock → delivery, одинаковая проверка разрешения для start и explicit unknown retry. Admin update берёт только approval lock, не создаёт обратный цикл блокировок.

Claim ограничен frozen botId текущего sender; worker другого бота и botless claim не захватывают group delivery. Domain gate проверяет author/revision/cancel и точное recipient/chat/thread соответствие также для личных targets. Общая PostgreSQL quota считает группу по chat, не обходит лимит при разных topics. Silent и topic сохраняются. Отзыв до start блокирует отправку, уже начатый HTTP не обещаем отозвать.

Ручной unknown retry по-прежнему требует version и подтверждения риска дубля; сохраняет target/topic и original expiry, заново проверяет разрешение. Отозванный/изменённый approval не допускает retry. Success не повторяется. Detail и journal имеют groupTargetId вместо выдуманного user ID, без raw bot/chat/thread; targetCount и leaf retry counts остаются честными. Авторское expiry-уведомление также работает для групповой аудитории.

## Проверки и границы

05.10.2026 полный `mvnw.cmd --batch-mode verify`: **349 tests, 0 failures/errors/skipped, BUILD SUCCESS**, 3:08 min; log `target/broadcast-group-final-verify.log`. 10 новых групповых сценариев и все прежние 339; чистая PostgreSQL 17.11 / V001…V028, OpenAPI local references и diff check. Начальный целевой прогон выявил только неверное сравнение порядка JSON-полей replay; assertion заменён на равенство parsed JSON, не ослаблен до одного ID. Финальный полный прогон зелёный.

`BroadcastGroupIntegrationTests` использует настоящие HTTP security/session/Origin/idempotency и PostgreSQL Testcontainers, fake transport. Проверяет admin/core/faculty доступ и safe list, approval validation/version/unique null address, frozen whole-group/topic, совпадение sender bot, inactive/arbitrary/mixed audience, revoke/reapprove/retarget/tamper после claim, linked unknown retry, concurrent same-key create, cancel, no-early schedule/перенос revision и rollback списка/квоты/idempotency. Старые scheduler mocks обновлены на bot-scoped claim без ослабления assertions.

Ponytail full: существующие BroadcastService/targets/queue/sender/quota/journal вместо отдельной групповой рассылки, один approval gate для start/retry, стандартные SQL constraints/locks. Новых зависимостей и фоновых workers нет.

Production, live-test runtime/БД и Telegram-группы не использовались. UI управления approvals/планирования, long-text splitting, полная TIME-07/эксплуатационная приёмка остаются впереди. Live-test transport продолжает запрещать любые группы независимо от новых approvals; две разрешённые личные тестовые учётки не расширены.
