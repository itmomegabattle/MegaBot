# Уведомления о новых задачах: B-07

Создание задачи через v1 либо legacy core/faculty API сохраняет `task.created` с actor, version и неизменным снимком Telegram-адресатов в той же транзакции, что задача/audit. Повтор HTTP с тем же ключом не создаёт новый source. Реальные Telegram-отправки по умолчанию выключены.

## Адресаты и очередь

Назначенная задача уведомляет указанных исполнителей, кроме автора. По явному уточнению владельца 04.10.2026 открытая core-задача уведомляет только активных зарегистрированных core-участников с подходящей компетенцией, кроме автора. Для нескольких компетенций достаточно хотя бы одного совпадения, как при claim; без требований — вся core-команда. Это согласованное изменение прежнего Node resolver. Снимок фиксируется при создании: новые участники/компетенции/назначения после этого не расширяют аудиторию. Faculty и `facultyId=all` требуют текущее активное подходящее membership.

`TaskManualPlanner` теперь принимает также due `task.created`: переиспользуются maintenance/task/source locks, audited intent, атомарная materialization, queue/quota и sender. V018 добавляет `action=created` к существующей `task_manual_intents`; историческое имя таблицы/связи сохраняется, чтобы не переписывать действующий manual lifecycle. Category новой доставки — `task_created`, ручного напоминания по-прежнему `task_manual`. Нет второй очереди/worker или новых зависимостей.

Creation source требует actor, status, recipientSnapshot и согласованный audienceUserIds. Actor подтверждается audit создания с той же version; перед materialization проверяется текущий активный автор/admin. Legacy source без снимка не восстанавливается из изменяемых данных: safe failed. Срок — 15 минут от исходного available_at; future source раньше due не обрабатывается, stale/closed/removed не отправляется. Недоступные адресаты учитываются; нулевая аудитория имеет unavailable, а не sent.

Перед HTTP снова проверяются action/category/source/intent, version, активность автора и адресата, положительная неизменная Telegram-привязка, текущее назначение либо доступ к открытой core-задаче с совпадающей компетенцией. Утрата требуемой компетенции блокирует старую доставку. Completed/cancelled задачи запрещают **creation** delivery; прежнее явное manual напоминание на completed сохраняет существующую семантику. Current eligibility не заменяет frozen snapshot.

Текст тихий: «Вам назначена задача» либо «Новая открытая задача» и сохранённое название. Описание, ТЗ и приватные комментарии не передаются. Форматирование/кнопки остаются финальным CHAT-01/B-08. HTTP вне DB-транзакции; completed source означает только materialization. Unknown не повторяется автоматически, source не переиздаётся после network failure. Общие [queue](notifications.md) и [sender](dispatcher.md) правила действуют без изменений.

## Проверки и границы

04.10.2026 полный PostgreSQL verify: **223 tests, 0 failures/errors/skipped, BUILD SUCCESS** (8 новых + прежние 215), log `target/task-creation-final-verify.log`. V018 применена на чистой тестовой БД и повторно проверена Flyway. Diff check без ошибок; реальные сообщения/production миграции не запускались.

`TaskCreationDeliveryIntegrationTests` проверяет v1 HTTP replay → snapshot → materialization → fake send, open competency/core selection, отсутствие автора/новых участников, отзыв компетенции, privacy/silent, current version/assignment/role/binding/status/intent gates, faculty/all membership, malformed/unaudited/legacy source, expiry/future/unavailable, atomic rollback/two planners, unknown без replay и сохранение других events pending. PostgreSQL настоящая, изолированная; Telegram transport fake.

Этот блок — новые задачи, не все task events. Статусы/завершение и claim/release подключены отдельно: [task-status-delivery.md](task-status-delivery.md). Правка/новое назначение/снятие подключены: [task-update-delivery.md](task-update-delivery.md). Комментарии/отмена подключены с приватными адресатами и gate: [task-comment-cancel-delivery.md](task-comment-cancel-delivery.md); предвстречные/birthday/slots occurrences, legacy broadcast/UI, outage/restart/VDS/SLO тоже остаются. B-07 открыт; sender не включается наличием token.
