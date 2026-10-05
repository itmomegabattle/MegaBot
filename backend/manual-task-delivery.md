# Ручные напоминания исполнителям: B-07

`POST /api/task/notify` теперь связан с общей постоянной очередью и отправителем. HTTP-команда сохраняет намерение, аудит и ключ идемпотентности; сеть внутри её транзакции не вызывается. Ответ `delivered:0,deliveryStatus:pending` не является подтверждением Telegram. Повтор с тем же ключом возвращает первоначальный ответ, даже если worker уже завершил обработку.

## Материализация

task.comment/task.cancel подключены к этому же planner, gate и sender: [task-comment-cancel-delivery.md](task-comment-cancel-delivery.md). V022 расширяет action/status CHECK; отдельная очередь не вводится.

task.claim/task.release также используют этот planner и audited intent для координатора, frozen admins при claim и competency open-board адресатов при последнем release: [task-status-delivery.md](task-status-delivery.md). Ручные напоминания не меняют аудиторию или контракт.

Дополнение 04.10.2026: этот же planner теперь обрабатывает task.updated, включая отдельную безопасную доставку снятия назначения; snapshot/gate/категории описаны в [task-update-delivery.md](task-update-delivery.md). Ручной контракт не меняется.

`TaskManualPlanner` обрабатывает due `task.manual_reminder`, `task.created`, `task.status`, `task.updated`, `task.claim`, `task.release`, `task.comment` и `task.cancel` в pending/retry. Другие actions/categories сохраняют ручной контракт: [task-creation-delivery.md](task-creation-delivery.md), [task-status-delivery.md](task-status-delivery.md). Shared maintenance gate → task row lock / SKIP LOCKED → source row lock → intent/delivery/source в одной транзакции. Максимум 100 задач на вызов, 20 событий на задачу; production вызывает batch 20. Сбой записи полностью откатывает событие, intent и доставки. Два worker не создают второй набор доставок.

V016 связывает `task_manual_intents` с исходным outbox и `notification_deliveries.task_manual_id`. Ключ `manual-task:<outboxId>:<userId>` постоянный. `completed` у outbox означает только создание delivery rows, не отправку. Фактическое подтверждение хранится в delivery/attempt; исходный source после сетевой ошибки не запускается заново.

Actor берётся из транзакционного аудита этой команды, не из присланного requesterId или payload. Проверяется текущий активный зарегистрированный admin либо organizer — автор задачи. Снимок task version должен совпадать, задача не removed/cancelled. Completed допускается для явного ручного действия, как и в существующем API; scheduled reminders на completed не отправляются.

Используется только сохранённый recipientSnapshot: новые назначения не добавляются задним числом. Перед созданием delivery проверяются текущее назначение, активность, регистрация, положительный Telegram ID и неизменность привязки. Core задача требует core роль, faculty задача — faculty роль и активное подходящее членство. Недоступные адресаты учитываются отдельно; если никто не доступен, intent имеет state unavailable.

Срок намерения — 15 минут от исходного available_at, не от перезапуска worker. Старое намерение фиксируется expired без отправок; future source не обрабатывается раньше срока. Removed/отсутствующая задача отменяет pending source. Невалидный payload или отсутствие подтверждающего actor audit завершают source безопасным failed-кодом.

## Перед сетью и результаты

Общий sender захватывает только task_manual с domain link. Перед первым и каждым повторным HTTP снова проверяются задача/version, координатор, назначение/роль/Telegram-привязка исполнителя и состояние source/intent. Потеря доступа отменяет delivery без сетевой попытки. После начала HTTP результат может быть unknown; отзыв доступа не доказывает, что сообщение не успело уйти.

Сообщение тихое, plain text: «Напоминание от координатора» и сохранённый заголовок задачи. Описание, ТЗ и приватные комментарии не передаются. Оформление текста и ссылки на Mini App — отдельный финальный шаг с ручной проверкой пользователя.

Общие quota/lease/heartbeat/expiry/retry действуют как у broadcast. Потерянный ответ не приводит к автоматической повторной отправке. Изменение задачи не переиздаёт ручное намерение: нужен новый явный запрос с новым ключом. Ручной retry неизвестного результата через журнал пока поддержан только для broadcast.

Sender выключен по умолчанию, token не включает его автоматически. В тестах используются изолированная PostgreSQL и подставной транспорт, без настоящих сообщений. Это не доказательство точности 12:00, SLO или production throughput.

## Границы

Создание/правка/отмена встреч, включая важный group/topic target, подключены отдельно: [meeting-notifications.md](meeting-notifications.md). Остальные task events, предвстречные/birthday/slots occurrences, прочие group правила, UI журнала, наблюдаемость, load/outage/clock drills и live приёмка остаются в B-07/B-08/TIME. B-07 не закрыт.

## Проверка

04.10.2026 полный `mvnw.cmd --batch-mode verify` на PostgreSQL 17.11: **188 tests, 0 failures/errors/skipped, BUILD SUCCESS**. Восемь новых интеграционных сценариев проверяют HTTP replay, frozen audience, provider-only confirmation, actor/recipient/task/source gate, unavailable/stale/completed, expiry/removed/future, unknown без replay, rollback/two workers, invalid/unaudited source и faculty membership. V016 применена на пустой тестовой БД; log `target/manual-task-verify.log`.
