# Уведомления о правках задач: B-07

Правка через v1/legacy API сохраняет task.updated, аудит и frozen Telegram snapshot в одной транзакции. HTTP replay не создаёт повторных уведомлений. Получатели новых деталей — текущие/новые исполнители, кроме инициатора. Исключённые исполнители получают только факт снятия назначения и прежнее название задачи.

Для открытой core-задачи аудитория — активные зарегистрированные core-участники с хотя бы одной требуемой компетенцией, кроме инициатора; без требований — вся core-команда. Последующие назначения/компетенции не расширяют snapshot. Faculty/all требует текущее активное членство и назначение.

V020 расширяет существующий audited intent: action=updated, category=task_updated. Ponytail: переиспользованы TaskManualPlanner, TaskDeliveryGate, очередь и sender; нет второй очереди, transport или новых зависимостей. Материализация атомарна, SKIP LOCKED/dedupe защищают от двух worker; завершение source означает материализацию, не доставку.

До начала отправки повторно проверяются версия, права координатора, активность/регистрация и Telegram-привязка получателя, назначение либо open competency eligibility, faculty scope и intent/source/category. In_progress поддерживается; completed/cancelled/removed не отправляются. Срок — 15 минут от исходного available_at; future source не обрабатывается раньше, malformed/legacy без snapshot либо без аудита отвергается. Unknown не повторяется автоматически. Проверка до HTTP не может отозвать уже начавшийся запрос.

Сообщение тихое: «Задача изменена» либо «Открытая задача изменена» и название. Описание, ТЗ и приватные комментарии не передаются. Форматирование оставлено финальному CHAT-01; sender по умолчанию выключен, production не переключён.

## Приёмка 04.10.2026

Полный mvnw.cmd --batch-mode verify: 236 tests, 0 failures/errors/skipped, BUILD SUCCESS. Log: target/task-update-final-verify.log. V020 применена в изолированной PostgreSQL 17.11. Шесть новых тестов покрывают HTTP replay → snapshot → fake send вне транзакции, новые/исключённые назначения, open competency freeze/revocation, in_progress/faculty/all, версию/права/binding/закрытие, malformed/unaudited/expiry/future source, rollback/two planners и unknown без повторения. Это не live Telegram/SLO.

Блок правок завершён (100%); оценка B-07 на момент этой приёмки — 68%, пункт остаётся открытым. Формальный общий счёт: 38/65 (58.5%), не доля трудозатрат или готовность релиза. Остаток: claim/release/comment/cancel, оставшиеся occurrences, legacy broadcast/UI и эксплуатационная приёмка.

## Снятие назначения

Это второй тип доставки из того же task.updated, category=task_unassigned с общим task_manual_id. Перед заменой назначений сохраняется прежнее название; аудит фиксирует его и список removedAssigneeIds. Planner сверяет эти поля с аудитом и проверяет полноту/уникальность removedRecipientSnapshot. Новые название/описание/ТЗ/комментарии в уведомление о снятии не попадают. Автор не уведомляется о собственном снятии. Снимок и обе категории доставки материализуются атомарно; dedupe различает обычную правку и снятие, даже если бывший исполнитель также входит в аудиторию открытой задачи по компетенции.

Приёмка итогового кода 04.10.2026: полный mvnw.cmd --batch-mode verify — **244 tests, 0 failures/errors/skipped, BUILD SUCCESS**, PostgreSQL 17.11; log target/task-unassigned-final-verify.log. Восемь новых интеграционных сценариев плюс прежние 236: private old title и HTTP replay, пересечение open/removal-аудиторий без collision, повторное назначение/version/binding/actor/closed gates, self-removal/no removal, подмена снимка/прежнего названия/аудита, faculty/all без новых прав доступа, two planners/unknown, atomic rollback/expiry/future и legacy update replay. Diff check, включая затронутые untracked файлы, без ошибок. Блок снятия 100%; B-07 оценочно 70%, общий план 38/65 (58.5%). Telegram fake, production не включён; load/outage/VDS/SLO это не подтверждает.

До HTTP обязательны текущая версия/активность задачи, права координатора, intent/source/category и принадлежность frozen списку снятых, активность/регистрация получателя и прежняя Telegram-привязка. Повторное назначение блокирует уведомление. Доступ к новой задаче и сохранение факультетского членства не требуются: передаётся только прежнее известное название, без кнопок/новых деталей. Недоступный Telegram учитывается как unavailable; due/15-minute expiry, unknown без replay и общий lease/quota не меняются. Следующая правка версии консервативно отменяет устаревшее снятие; уже начавшийся HTTP отозвать нельзя. Старые task.updated без нового audited snapshot отвергаются, а не дополняются текущими данными. Production пока не включён, миграция/новая зависимость не нужна.
