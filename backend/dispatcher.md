# Отправитель рассылок: B-07

## Граница включения

task_comment/task_cancel с audited intent link используют тот же worker: [task-comment-cancel-delivery.md](task-comment-cancel-delivery.md). Приватная аудитория комментария и отдельное разрешение cancelled-задачи проверяются перед HTTP; текст комментария не отправляется.

task_assignment с audited intent link поддерживает уведомления координатору о claim/release, frozen admins при claim и competency open-board аудиторию при последнем release: [task-status-delivery.md](task-status-delivery.md). Kind и текущие права адресата перепроверяются; Telegram callbacks относятся к B-08.

task_updated и task_unassigned также используют общий audited intent link: [task-update-delivery.md](task-update-delivery.md). Второе уведомление содержит только факт снятия и прежнее название; sender остаётся выключен по умолчанию.

`task_status` с обязательным task intent link тоже входит в production whitelist: [task-status-delivery.md](task-status-delivery.md). Включение sender по-прежнему отдельное согласованное действие.

`task_created` с обязательным audited task intent link также поддержан общим production worker: [task-creation-delivery.md](task-creation-delivery.md). Используются тот же `TaskManualPlanner` и `TaskDeliveryGate`, без отдельного sender.

Отправитель **выключен по умолчанию**. Наличие `TELEGRAM_BOT_TOKEN` само по себе ничего не отправляет. Для будущего согласованного включения нужны одновременно `megabot.delivery.enabled=true` и integration mode `live`, валидный token и рабочая PostgreSQL. Fake/disabled mode с включённым sender отклоняется на старте, а не превращает fake-успех в persisted sent. Production и текущий Node этим изменением не переключены.

Production worker отправляет `category=broadcast` с сохранённым broadcast_target_id, scheduled `task_reminder` со связанной durable occurrence, `task_manual` и `meeting_event` с audited outbox intent. Контракты: [task-reminder-delivery.md](task-reminder-delivery.md), [manual-task-delivery.md](manual-task-delivery.md), [meeting-notifications.md](meeting-notifications.md). Group meeting targets дополнительно фильтруются по numeric bot ID отправителя. Остальные notification rows/outbox не захватываются: их domain gates/materialization ещё требуются. Нельзя включать два разных sender контура на один bot, не использующих общую quota.

## Выполнение

Spring `@Scheduled(fixedDelay=500)` пробуждает worker независимо от polling/webhook. SmartLifecycle управляет запуском/остановкой HTTP executor и heartbeat. Один bounded HTTP worker захватывает только одно задание с lease 30 секунд: не арендует пачку, которая ждала бы сеть. Порядок: recovery/expiry → claim/COMMIT → decode immutable payload → shared quota → start с domain gate/COMMIT → heartbeat/token check → HTTP → finish.

С 04.10.2026 одно пробуждение продолжает обработку due очереди последовательно: максимум 100 проходов или 1 секунда по монотонным часам, проверка running/interrupted перед каждым, пауза 5 ms между проходами. Empty queue завершает drain; runtime failure прерывает проход и сохраняется в диагностике. Уже начатая bounded HTTP-попытка может закончиться после границы секунды, но следующая не стартует; остановка использует прежний лимит 8 секунд. Busy gate не допускает второго drain/executor backlog. Сохраняются один lease/HTTP за раз и общий PostgreSQL limiter; 500 ms теперь интервал поиска новой работы, не обязательная пауза между каждым сообщением.

Due selection сначала сортируется по исходному intended_at, затем по важному топику, available_at и id. available_at остаётся обязательным фильтром допуска: сообщение не обходит retry_after/квоту. После quota deferral старое due намерение не вытесняется более новыми due сообщениями только из-за увеличившегося available_at. Это не обещание строгого FIFO между конкурентными workers (SKIP LOCKED) или отправки всех 1000 адресатов одновременно.

HTTP всегда вне DB-транзакции. Payload plain text до 4000 UTF-16 единиц; thread ID и disable_notification передаются отдельно. Произвольные поля persisted payload не становятся Telegram options. Нет parse_mode, вложений, платной рассылки или автоматической переадресации. CHAT-01 остаётся последним отдельным пунктом.

Heartbeat каждые 5 секунд продлевает действительный token; expired owner не может продлить/записать результат. Started work без подтверждённого результата восстанавливается как unknown. Shutdown останавливает новые пробуждения, даёт до 8 секунд текущей попытке, затем прерывает; heartbeat останавливается после этого. Незавершённый sending не освобождается для blind resend. Полный DB-outage/readiness/graceful shutdown drill остаётся в TIME-07/B-11.

## Квоты

V013 `delivery_rate_limits` хранит консервативный leaky bucket: один global и один chat bucket на numeric bot ID, **не token**. Порядок locks global → chat, NOW по часам PostgreSQL. Другой worker/restart читает те же next_at/blocked_until; темы одной группы не обходят общий chat limit.

Стартовые интервалы: бот 50 ms (20/сек), личный chat 1 сек, группа 3 сек (20/мин). Значения конфигурируются через `megabot.delivery.bot-per-second/private-per-second/group-per-minute`. Это осторожные project limits, не гарантия Telegram. Reserve при запрете не тратит attempt: claimed task возвращается в planned с новым available_at и без lease; intended_at/payload/dedupe остаются прежними. Если ожидание выходит за expiry — expired. Stale/cancelled/sending token не может использовать этот defer.

При явном 429 blocked_until повышается для бота и chat на всю задержку: scope flood-control не угадывается из описания. Более короткий следующий отказ не сокращает блокировку. Reservation уже расходует слот, даже если последующий start запретил отправку: безопаснее недоиспользовать квоту. Лимит относится к reservation перед сетью; точную фактическую частоту/паузу процесса нужно измерять в нагрузочном испытании.

## Сеть и результаты

Один sendMessage attempt, без application retry loop. Production endpoint фиксирован `https://api.telegram.org`; URI нельзя задать через body/environment. Redirect запрещён, request/body completion bounded 8 сек, response максимум 64 KiB. URI с token, provider description, response text и exception message не попадают в сохраняемый результат/наши logs.

- SENT: только HTTP 200 + ok=true + положительный message_id + ожидаемый chat.id. Provider подтверждение не означает прочтение/push.
- RETRY: connection явно не установлено; либо валидный Bot API ok=false с 429/5xx. Backoff 2/4/8/16/32/60 секунд + положительный jitter до 25%; реальный retry_after имеет приоритет, если больше. Queue ограничивает 8 попытками и expiry.
- FAILED: валидный явный 400/401/403/404; invalid persisted text payload не отправляется и завершается безопасным кодом.
- UNKNOWN: потеря/таймаут/обрыв ответа после возможной передачи, malformed/неполный/слишком большой ответ, inconsistent status, redirect, unexpected exception после start. Никакого автоматического повтора. Bare HTTP 5xx от gateway без явного Bot API отказа также unknown.

Поля/ответы соответствуют [Telegram Bot API sendMessage](https://core.telegram.org/bots/api#sendmessage) и [ResponseParameters/retry_after](https://core.telegram.org/bots/api#responseparameters). Тексты Telegram errors не используются как команды/доказательства возможности повтора.

## Проверки и остаток

Прогресс lifecycle worker включён в admin-only [delivery-diagnostics.md](delivery-diagnostics.md): завершённые проходы, idle/processed/error, последовательные сбои, silence >30s и явные disabled/stopped. Сведения локальные, без исключений/секретов, не подменяют delivery lease heartbeat или provider-confirmed sent. Scheduler после runtime failure остаётся активным. Внешние alarms, NTP и process/outage/load drills ещё требуются.

Проверено 03.10.2026: полный `mvnw.cmd --batch-mode verify` на PostgreSQL 17.11 — **163 tests, 0 failures/errors/skipped, BUILD SUCCESS**. 21 новый сценарий (10 dispatcher DB, 7 HTTP, 2 retry, 2 safety configuration) выполнен с прежними 142. V013 применяется на пустой тестовой БД. `git diff --check` без ошибок; log `target/dispatcher-verify.log`. TIME-03 закрыт, остальные TIME-пункты/B-07 остаются открытыми.

Тесты используют настоящий изолированный PostgreSQL и локальный HTTP server, не production Telegram. Проверяются matching provider ID, silent/topic, отказ соединения, accepted request с потерянным/медленным body, redirect, oversized response, bounded backoff, shared quota race, 429 cooldown, defer без attempt, unknown/failed, два workers, future/cancelled/другие categories и lifecycle без polling.

B-07 остаётся открытым. Это последовательный sender, не гарантия 20 отправок/сек или точности 12:00: пропускная способность зависит от одной HTTP-попытки за раз, SQL, общей quota и bounded drain. Локальные измерения до/после: [delivery-load-report.md](delivery-load-report.md). Журнал/manual unknown retry API реализованы: [delivery-journal.md](delivery-journal.md). Следующие блоки — остальные outbox/reminder occurrences, legacy adapter/group allowlist, UI, метрики, TIME-07 и согласованный live тест. SLO p95≤2 s/p99≤5 s пока только цель; время push на устройстве не контролируется приложением.
