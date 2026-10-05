# Комментарии и отмена задач: B-07

V1/legacy команды сохраняют task.comment/task.cancel, actor ID/name, version/status и frozen Telegram snapshot в той же транзакции, что задача, история и аудит. Повтор с тем же HTTP ключом не создаёт нового события. V022 расширяет существующий task_manual_intents action/status CHECK и due index; категории task_comment/task_cancel подключены к общему TaskManualPlanner/TaskDeliveryGate/queue/sender. Отдельной очереди, transport или зависимости нет.

## Адресаты

Комментарий исполнителя уведомляет только координатора. Приватный комментарий координатора — только выбранного назначенного исполнителя; общий v1-комментарий координатора — текущих назначенных исполнителей. Legacy coordinator comment требует выбранного assigneeId по прежнему контракту. Инициатор исключён. Последующие назначения аудиторию не расширяют. Completion comment не является discussion и не порождает отдельного уведомления этой категории.

Отмена уведомляет текущих исполнителей и координатора, кроме инициатора; для обычного автора это исполнители, для отменившего администратора также координатор. Нет рассылки открытой задачи всей команде. Повтор cancel уже отменённой задачи не создаёт новых событий. Назначения и история остаются, будущие reminders выключаются существующим доменным lifecycle.

## Защита и доставка

До materialization/HTTP проверяются текущие версия/status, активность/регистрация и права actor, неизменная Telegram-привязка получателя и его текущие права. Comment связывается с сохранённым discussion той же версии и автора: executor остаётся назначенным и имеет core/faculty доступ; coordinator сохраняет права автора/admin. Side/target из записи комментария ограничивает адресатов, приватный comment нельзя перенаправить соседнему исполнителю. Completed/cancelled/removed блокируют comment; completion kind не принимается. Faculty/all membership перепроверяется у исполнителей.

Cancel — явное исключение из общего запрета отправок cancelled-задач: только task_cancel текущей версии со status=cancelled и cancelled_by=actor. Actor остаётся активным зарегистрированным автором/admin; target остаётся назначенным исполнителем с текущим scope либо координатором. Старые ручные/создание/правка/comment/reminder доставки не получают этого исключения. Cancelled task не возобновляется.

Каждый source проходит matching audit; malformed/legacy без полного snapshot отвергается без восстановления адресатов из текущих данных. Source completed означает materialization, не sent. Доставка атомарна, dedupe/SKIP LOCKED защищают от двух worker; DB-clock due, 15-minute expiry, lease/quota/rollback и unknown без автоматического replay остаются общими. Уже начавшийся HTTP отозвать нельзя, последующая версия консервативно отменяет устаревшие уведомления.

Сообщение тихое, plain text: факт нового комментария/отмены, название и имя автора. Текст комментария, описание и ТЗ не отправляются; комментарий читается в приложении после проверки доступа. Это намеренный минимальный формат, не перенос полного Node-текста. Форматирование/кнопки и ручная проверка вариантов оставлены CHAT-01/B-08. Production sender выключен, реальный Telegram не использовался.

Ponytail: переиспользованы frozen snapshot, аудит, actor/recipient gates и единый sender. Расширены существующие PostgreSQL integration tests; negative unsupported-event сценарии теперь используют task.unsupported, поскольку task.comment стал поддержанным. B-07 остаётся открытым для других occurrences, adapters/UI и эксплуатационной приёмки.

## Приёмка

04.10.2026 полный mvnw.cmd --batch-mode verify: **266 tests, 0 failures/errors/skipped, BUILD SUCCESS**, PostgreSQL 17.11; log `target/task-comment-cancel-final-verify.log`. V022 применена на чистой БД. Восемь новых интеграционных сценариев и прежние 258 проверяют private/general/executor comment, обычную/admin отмену, HTTP replay/fake silent send вне транзакции, frozen аудиторию без поздних назначений, подмену private target, version/status/actor/binding/assignment/faculty/source/intent/discussion/cancelled_by gates, malformed/unaudited/future/expiry/unavailable, atomic rollback/two planners/unknown без replay и legacy adapters. Старый task.status не принимает cancelled. Отдельно профильные 29 тестов прошли; diff check чистый, включая затронутые untracked файлы.

Блок 100%; B-07 оценочно 80%, не закрыт. Формальный общий счёт трёх планов 38/65 (58.5%). Реальный Telegram, VDS, outage/SLO и production cutover не проверялись этим блоком; покупка БД или изменение Docker для этой приёмки не нужны.
