# B-07 / TIME-05: уведомление автору об истечении срока

V027 / `BroadcastExpiryPlanner` создают одно immutable уведомление автору на `(broadcast_id, content_revision)`. Планировщик вызывается существующим worker после recovery/expire, до claim; отдельного таймера, отправителя или зависимости нет. Sender по умолчанию выключен.

V029 считает результат по адресатам через общий `broadcast_target_delivery_summary`, а не по физическим частям. Если подтверждена лишь часть длинного текста, notice сообщает «Подтверждена только часть текста» и считает адресата один раз; unknown сохраняет приоритет. Контракт: [broadcast-parts.md](broadcast-parts.md).

## Когда создаётся

DB-clock достиг исходного `broadcast.expires_at`; текущая revision содержит хотя бы один **конечный expired delivery**, все её отправки завершены (нет planned/retry/claimed/sending). Если HTTP ещё идёт, сначала ждём результат либо recovery в unknown, не объявляем его просроченной неотправкой. Отменённые рассылки, старые revisions, полностью успешные и только unavailable/failed/unknown без expired не порождают ложное уведомление об expiry.

Snapshot — название и сводка текущей revision: подтверждённые Telegram, expired, unknown с предупреждением «сообщение могло прийти», failed/cancelled/unavailable. Body и список адресатов в уведомление не копируются. Linked manual retry считается по конечному child: один получатель не превращается в двух, исходный unknown остаётся в recipient journal. Формулировка expired относится к оставшимся отправкам; отдельно предупреждаем, что expiry новой попытки не доказывает недоставку предыдущей с неизвестным результатом. Уведомление отдельно от broadcast_targets, не увеличивает targetCount/deliveryCounts и не меняет исходные sent/unknown/expired.

Срок доставки **самого уведомления** — 24 часа после исходного expiry, не после restart. Это ограничение предотвращает пачку устаревших предупреждений после длительного простоя: более старый source сохраняется expired без нового Telegram задания. Исходная grace рассылки (15 минут / skip) не продлевается. Название из потенциально длинных импортированных legacy rows ограничено 120 Unicode code points; payload остаётся в пределах общего transport limit.

## Очередь и безопасность

Source, frozen author/chat binding и DeliveryQueue.enqueue сохраняются одной транзакцией; parent lock / SKIP LOCKED, UNIQUE source/revision и unique delivery/source исключают два уведомления при двух workers. Ошибка постановки откатывает source тоже. На повторном проходе существующие sent/unknown/expired не перевыпускаются.

Только личный чат активного registered core-автора, не администратор вместо автора, не группа/топик/новая привязка. Если автор недоступен или без Telegram, source остаётся unavailable, не фиктивным sent; последующее подключение не переотправляет его. Перед start повторно проверяются author role/active/registered/chat, broadcast author/revision/expiry/cancel и target/timestamp соответствие. Parent-before-delivery lock такой же, как у patch/cancel. Штатные cancel/перенос отменяют ещё не начатый notice; уже начатый HTTP не обещаем отозвать.

`broadcast_expired` проходит общие claim/lease/quota/retry/attempts и conservative unknown правила. 429 откладывает, unknown автоматически не повторяется; expiry самого notice не создаёт новое expiry-уведомление. Silent=false для авторского предупреждения; silent исходной аудитории не меняется.

Author/admin GET/list broadcast detail содержит nullable `expiryNotice`: только id/status/createdAt/expiresAt текущей revision. Это статус отдельного уведомления, а не подтверждение прочтения. Без chat ID, payload, lease/token/provider description; права те же, что у исходной рассылки. Чужой organizer не читает notice. Полный UI журнала и подтверждений остаётся отдельным остатком B-07/D-11.

Ponytail full: общий worker, queue, quota, transactional JDBC и прежние API; один source вместо обходов в каждом expiry/defer/retry/recovery пути. Без новых зависимостей и изменения production timeout/credentials. Старые constructors dispatcher сохранены для прежних fixtures.

## Проверки

05.10.2026 финальный полный `mvnw.cmd --batch-mode verify`: **339 tests, 0 failures/errors/skipped, BUILD SUCCESS**, 2:15 min; log `target/broadcast-expiry-final-verify-2.log`. 13 новых expiry-сценариев вместе с прежними 326; V001…V027 применены на чистой PostgreSQL, прежние HTTP/queue/worker/outage/role/idempotency/race tests сохранены. Первый полный прогон также зелёный (339 tests), после уточнения предупреждения о предыдущем unknown выполнен повторный полный verify. OpenAPI contract и diff check проходят.

`BroadcastExpiryIntegrationTests` использует настоящую PostgreSQL 17.11 / Flyway V001…V027 и fake transport. Clock подменяется только внутри собственного Testcontainers-контекста, без изменения ОС/live-test БД. Проверяет due boundary, partial/unknown честную сводку, idempotence, in-flight ожидание, unavailable без rearm, смену author/binding/revision, cancel/перенос claimed notice, scoped safe detail, atomic rollback, два planners, 429/unknown, 24-hour expiry/no backlog replay, backward clock, legacy Unicode title и linked retry counts.

Production/реальный Telegram не использовались. Последующие group allowlist, long-text splitting и UI описаны в отдельных контрактах; полная эксплуатационная приёмка TIME-07 остаётся открытой. Birthday hour подтверждён владельцем 05.10.2026: 12:00 МСК.
