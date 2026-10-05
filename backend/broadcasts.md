# Отложенные рассылки: Java API B-07

Реализованы `POST/GET /api/v1/broadcasts`, `GET/PATCH /api/v1/broadcasts/{id}`, `POST /api/v1/broadcasts/{id}/cancel`. Только core session; автор/admin видит детали и меняет/отменяет, admin видит общий список. Actor из session, body authorId/requesterId не дают прав. Mutations требуют Origin и Idempotency-Key; patch/cancel — expectedVersion (0 валидна). Create отвечает 201 после общей транзакции, не ждёт HTTP.

## Запрос

Title до 120, body до 40000 символов. Stripped plain-text заголовок + два переноса + body в сумме максимум 40000 UTF-16 единиц. V029 разбивает текст на сохраняемые части до 4000 единиц без потери символов, с порядком и отдельными результатами; [broadcast-parts.md](broadcast-parts.md). Target sent означает подтверждение всех частей, target partCount/partCounts не увеличивают recipient-level targetCount/deliveryCounts. Formatter/HTML/Markdown остаются CHAT-01 и выполняются последними, как просил владелец.

RecipientMode:

- people: recipientIds активных зарегистрированных core-участников;
- all: снимок всей активной зарегистрированной core-команды;
- blocks: участники хотя бы одной выбранной competencyIds плюс явно выбранные recipientIds;
- missing_slots: не заполнившие конкретную видимую неделю weekStart (московский понедельник).
- groups: явно выбранные active groupTargetIds из admin allowlist; не смешиваются с личными полями аудитории. Whole-group и topic — разные разрешения.

Неделя заполнена, когда out_of_week=true либо каждый настроенный activeDay имеет слот/явный unavailable. Отсутствие строк и unanswered не считаются ответом. Общий AvailabilitySubmissionService использует те же настройки горизонта/activeDays, что availability API. V028 добавляет groups по frozen admin approval/version/bot/chat/topic; произвольный chatId не принимается как адресат. Контракт: [broadcast-group-allowlist.md](broadcast-group-allowlist.md). UI allowlist/preview остаётся в B-07.

DispatchMode=scheduled (default) требует scheduledAt RFC3339 в диапазоне от DB now+30 секунд до +365 дней. ZoneId только Europe/Moscow. DispatchMode=now — отдельная явная команда, scheduledAt запрещён. DB clock задаёт intended_at; браузер/OS timezone не меняет instant.

MisfirePolicy=send_late (default) хранится как send_within_grace: expiry через 15 минут. Skip — окно 5 секунд после intended_at. Это политика просрочки, не доказанный SLO и не обещание отправки с точностью до секунды. Текст/UI явного подтверждения политики ещё нужен в D-11/TIME-02.

## Транзакция и версии

V012 добавляет title/recipientMode/weekStart и возможность сохранить unavailable target без Telegram ID. Create сохраняет broadcast, полный snapshot аудитории, каждую ready delivery и audit/idempotency атомарно. Unavailable адресат виден в targets/counts и не получает фиктивное sent. Новые люди после подтверждения автоматически не добавляются.

Patch — полная замена полей, не partial merge. Только до первой попытки: parent broadcast FOR UPDATE сериализует patch/cancel со start. Старые доставки planned/retry/claimed отменяются, старые targets/payload остаются; contentRevision и version повышаются, новая аудитория и deliveries создаются целиком. Stale version/начатая отправка — 409. Отказ сохранения откатывает также отмену старой ревизии.

DeliveryQueue.start для broadcast также берёт parent lock, проверяет текущую revision/status, активную core-роль автора/адресата, неизменную Telegram-привязку. Missing-slots повторно проверяется по выбранной неделе. Недоступный/ответивший адресат исключается через cancelled delivery, новых не добавляем. Shared quota выполняется dispatcher до этого gate, сеть — после COMMIT: [dispatcher.md](dispatcher.md).

Cancel отменяет ещё не начатые deliveries; in-flight остаются sending с cancel_requested. Поздний подтверждённый успех сохраняется sent; неопределённость остаётся unknown. Нельзя обещать отзыв уже отправленного сообщения. Exact replay возвращает прежний ответ без нового broadcast/ревизии/отправки.

`POST /api/v1/broadcasts/{id}/reschedule` — отдельный перенос **только времени**: `{expectedVersion, scheduledAt}` с прежними core/author/admin, Origin и Idempotency-Key. В отличие от полного PATCH он не пересобирает аудиторию. Копируются frozen targets (включая unavailable, bot/topic/approval version), исходные title/body, silent, recipientMode/weekStart и misfire. Общие plan/materialize/quota используются повторно, без новой схемы/очереди. Parent и старые deliveries блокируются в том же порядке, что start; старые claims отменяются, revision/version повышаются, новые deliveries и audit записываются атомарно. Любая начатая попытка, истёкшее окно, отменённая/конечная доставка текущей revision либо существующий expiry notice запрещают перенос. Reapproval группы и новая Telegram-привязка не обновляют frozen snapshot. Неуспешная запись откатывает также отмену и quota. View сообщает серверный `reschedulable` boolean; при старом сервере UI не показывает неподдерживаемую кнопку.

## Чтение

List возвращает items/nextCursor, limit 1..100, cursor — последний ID. Author видит только свои, admin — все. Get/list используют repeatable-read snapshot. Targets относятся к текущей contentRevision; старые строки сохраняются в БД. Агрегат вычисляется из deliveries: scheduled/sending/partial/sent/failed/unknown/cancelled/expired, отдельные counts sent/planned/retry/unknown/unavailable и т.д. Первый успешный адресат не завершает всю рассылку. Sent означает provider confirmation, не прочтение или push на устройстве.

## Проверки и граница готовности

Java legacy POST /api/team/broadcast использует этот же домен и очередь: [legacy-broadcast.md](legacy-broadcast.md). Ответ Accepted/delivered=0, имена competencies и dated week index адаптированы, requesterId игнорируется. Общие request/volume лимиты теперь реализованы отдельно: [broadcast-creation-quota.md](broadcast-creation-quota.md). Production/frontend cutover остаются впереди.

Проверено 01.10.2026: полный `mvnw.cmd --batch-mode verify` с PostgreSQL 17.11 — **142 tests, 0 failures/errors/skipped, BUILD SUCCESS**. 12 broadcast HTTP/DB-сценариев прошли вместе с прежними 130 проверками. V012 применена на чистой тестовой БД. OpenAPI parsed: 62 paths, local references resolved; `git diff --check` без ошибок. Локальный generated log: `target/broadcast-verify.log`.

BroadcastHttpIntegrationTests покрывает replay/snapshot, строгие время/zone/audience/text, unavailable, перенос claimed версии, cancel in-flight, author/admin access, atomic rollback, start/transfer race, изменение привязки/роли/slots и partial/sent aggregate. Настоящий Telegram не вызывается.

Broadcast dispatcher/rate limits/transport/500ms wakeup реализованы 03.10.2026, но sender выключен по умолчанию: [dispatcher.md](dispatcher.md). Ещё нужны остальные occurrences/metrics и полный TIME-07, UI/preview и live-проверки. B-07 и TIME-02 остаются открытыми; production frontend не переключён.
