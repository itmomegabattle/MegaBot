# Напоминания задач в постоянной очереди: B-07

## Реализованный контур

V015 хранит `task_reminder_occurrences`: reminder/version, task/version, intended_at, expiry и состояние queued/expired/unavailable. Уникальность reminder/version/intended_at сохраняет occurrence после restart и не зависит от lastSentAt. Связанные notification_deliveries используют ту же lease/quota/HTTP/retry очередь, а не второй scheduler.

`TaskReminderPlanner.materialize` выполняет короткую транзакцию: maintenance shared lock → task FOR UPDATE SKIP LOCKED → reminder lock → occurrence/snapshot/deliveries → next_due_at. Batch ограничен 100 задачами (sender берёт 20). Ошибка доставки/записи occurrence откатывает также продвижение расписания и отмену старых pending rows. Два planners не материализуют один тик дважды.

Повтор: из исходного anchor/interval вычисляется последний due тик и следующий строго после DB now. После простоя максимум один актуальный occurrence, не все пропущенные часы. Grace — 15 минут; старый тик отмечается expired без отправки. Новое intended_at не вычисляется как lastSentAt + interval, поэтому задержки сети не накапливают дрейф. Повторные reminders могут продолжаться после task deadline до completed/cancelled; одноразовый before_deadline не выходит за deadline.

Before-deadline материализуется однократно: next_due_at становится NULL, но active сохраняется для проверки ещё ожидающих доставок. Sent_at/last_sent_at **не** означают enqueue: они записываются только после provider-confirmed sent и только для той же reminder version. Эти markers показывают подтверждённую отправку хотя бы одному адресату; полный результат — в notification_deliveries, не гарантия доставки всем.

## Адресаты и последний gate

Snapshot — активные зарегистрированные назначенные исполнители при materialization. Нет Telegram binding — unavailable_count, без фиктивного sent. Новые исполнители не добавляются в уже существующий snapshot. Текст сейчас короткий plain text: «Напоминание о задаче» и title; silent=true. Description, SOW, закрытые заметки и чужие комментарии не отправляются. CHAT-01 остаётся отдельным последним пунктом для выбора оформления.

Перед start блокируется task/reminder и проверяется persisted task/reminder version, removed_at, completed/cancelled, enabled/active, актуальное назначение, активность/регистрация и неизменность Telegram binding. Core task доступен core-исполнителю; faculty task — faculty-role исполнителю с membership активного факультета того же scope (или shared all). Stale/чужой/отключённый target становится cancelled до попытки.

Task commands и planner/start/result соблюдают maintenance → task → reminder → delivery lock order. Finish не держит delivery lock перед task lock. Перенос/правка конфигурации не делает старую очередь допустимой; поздний confirmed результат старой версии остаётся в delivery, но не перезаписывает markers новой версии.

Легитимная правка задачи/назначений может перевыпустить **точно не начавшийся** актуальный snapshot: reminder version повышается, due возвращается к intended_at, следующий planner отменяет старые pending/claimed deliveries и создаёт новую конфигурационную occurrence. Anchor не сдвигается. Если старая occurrence имела attempt или unknown, такой автоматический перевыпуск запрещён — не превращаем возможный success в hidden resend. Следующие регулярные тики серии остаются отдельными ожидаемыми напоминаниями.

## Подключение и границы

Production-config sender перед claim вызывает planners, затем `claimSupported`: broadcast с broadcast target, task_reminder со связанной occurrence или task_manual с audited intent. Ручные напоминания подключены отдельно: [manual-task-delivery.md](manual-task-delivery.md). Meeting updates, прочие task events, birthdays/slots и другие категории не захватываются. Их отдельная materialization/domain gates ещё не готовы. Старое имя BroadcastDispatcher сохранено для совместимости.

Sender по умолчанию выключен. Наличие token не включает отправки; никакие production сообщения/миграции в этом проходе не запускались. Task reminder unknown не повторяется автоматически; журнал/manual retry API пока относится только к broadcast. Task reminder status UI/ручной retry и полноценные TIME-07/live/outage/1000-job/SLO остаются будущей работой. B-07 не закрыт.

## Проверки

Проверено 04.10.2026: полный `mvnw.cmd --batch-mode verify` с PostgreSQL 17.11 — **180 tests, 0 failures/errors/skipped, BUILD SUCCESS**. 10 новых task-reminder DB-сценариев и прежние 170 прошли вместе; V015 применена на чистой тестовой БД. `git diff --check` без ошибок. Локальный generated log: `target/reminder-verify.log`.

Настоящий изолированный PostgreSQL: два planners, rollback после отказа materialization, outage catch-up без drift, expired/future, once-before-deadline, actual sent markers, silent HTTP вне транзакции, completion/version/assignment/binding/config gate, отсутствие Telegram, core/faculty privacy, unknown без replay и rearm только до первой попытки. Даты не ожидаются реально: исходные anchor/next_due меняются в тестовой БД.
