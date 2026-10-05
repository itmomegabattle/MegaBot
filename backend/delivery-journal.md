# Журнал рассылок и ручной повтор: B-07

## Чтение

`GET /api/v1/broadcasts/{broadcastId}/deliveries` доступен автору/admin основной команды. `limit=1..100` (default 50), cursor — последний delivery ID **этой** рассылки. Ответ `items/nextCursor/version` имеет repeatable-read snapshot; журнал включает все content revisions, а не только текущую.

Каждая строка: id, recipientId, contentRevision, status, attemptCount, retryOf/replacedBy, intendedAt/availableAt/claimedAt/requestStartedAt/responseAt/sentAt/expiresAt, providerMessageId, безопасный errorCode, пояснение action. В `attempts` — до восьми номеров, startedAt/finishedAt/status/code/providerMessageId. Timestamps UTC; будущий экран показывает МСК. Полный raw payload, chat ID/thread ID, token/lease, provider description/error_summary не возвращаются. Коды провайдера допускаются только из известного списка, неизвестные заменяются на provider_error.

Unavailable targets без delivery видны в существующем broadcast detail, а не выдумываются как попытки в журнале. Sent — подтверждение провайдера, не прочтение/push.

V029 добавляет `partNumber/partCount` каждой строке. Это позиция в тексте, не номер попытки; linked retry сохраняет позицию и копирует только одну неизвестную часть. Остальные части не перевыпускаются; recipient-level статус и partCounts описаны в [broadcast-parts.md](broadcast-parts.md).

## Подтверждённый ручной повтор

`POST /api/v1/broadcasts/{broadcastId}/deliveries/{deliveryId}/retry` принимает:

```json
{"expectedVersion": 0, "acknowledgeDuplicateRisk": true}
```

Обязательны session actor, same-origin Origin, Idempotency-Key. Версия относится к **broadcast**, не delivery. Успех 201: id нового planned задания, retryOf, увеличенная version и duplicateRiskWarning. Предупреждение: «Первое сообщение могло быть доставлено. Повтор может создать дубль.» Будущий UI должен показать его до подтверждения; этот проход добавляет API, не кнопку.

Повтор возможен только для unknown текущей content revision, без cancel_requested, до исходного expires_at, при активном авторе и доступном core-адресате с прежней Telegram-привязкой. Missing-slots уже ответившему участнику повтор не ставится. После проверки перед HTTP dispatcher заново выполняет обычные domain/lease/quota gates.

Sent/failed/expired/cancelled/planned/retry/claimed/sending этим endpoint не повторяются. Отменённая/сменившая revision рассылка запрещена. Поздний ручной retry не продлевает исходную grace-политику: после expiry нужно явно создать новую актуальную рассылку. Возобновление failed после исправления причины — отдельная будущая команда, не скрытое поведение unknown retry.

Parent broadcast lock → delivery lock, одна транзакция child + link + version + audit + idempotency. V014 retry_of UNIQUE допускает одного непосредственного child у delivery; разные ключи/два автора не создают две копии. Replay возвращает прежний ID, но актуальные права проверяются и до replay. Смена admin→organizer не разрешает читать сохранённый ответ для чужой рассылки.

Исходный unknown/attempts не изменяются. Новый delivery копирует immutable payload, target, silent и исходный expiry; intendedAt/availableAt задаются DB now, attempts начинают новую явно одобренную пользователем доставку. Если новый результат опять unknown, следующий ручной retry должен ссылаться на этот child и требовать новое подтверждение. Связь/история сохраняют всю цепочку; это не exactly-once.

Broadcast targets/counts используют конечный delivery в каждой цепочке: один получатель не превращается в двух, успешные другие адресаты не трогаются. Исходная неопределённость остаётся в журнале с предупреждением; подтверждённый sent нового child не доказывает отсутствие дубля первого сообщения. Cancel отменяет pending child, не стирая старые unknown/sent.

## Проверки и граница

Полный `mvnw.cmd --batch-mode verify` с PostgreSQL 17.11 — **170 tests, 0 failures/errors/skipped, BUILD SUCCESS**. Семь новых журнал/retry HTTP/DB-сценариев выполнены с прежними 163. V014 применяется на чистой БД. OpenAPI YAML parsed: 64 paths, local references resolved; `git diff --check` без ошибок. Локальный generated log: `target/journal-verify.log`.

PostgreSQL/HTTP tests покрывают idempotency, duplicate acknowledgement, scoped journal/pagination, safe output, parent version, stale/repeated retry, unchanged success, expired/cancelled/changed binding, rollback, конкурентные manual retries и cancel/retry, цепочку unknown и отзыв admin-доступа. Реальные Telegram сообщения не отправляются.

B-07/TIME-04 остаются открытыми: остальные occurrences/materialization, legacy/group adapter, разбиение длинного текста, UI, метрики/1000-job report и остальные TIME-07/drills ещё нужны. CHAT-01 не выполняется этим блоком и остаётся последним для проверки вариантов владельцем.
