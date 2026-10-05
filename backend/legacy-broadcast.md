# Совместимость формы рассылки: B-07

Java POST /api/team/broadcast принимает старые title/body/recipientMode/recipientIds/competencies/availabilityWeekIndex. Только активная зарегистрированная core-сессия, Origin и Idempotency-Key. requesterId не источник авторства. Контроллер переводит имена действующих core-компетенций в IDs, далее вызывает существующий BroadcastService; отдельного выбора адресатов, очереди или sender нет.

## Контракт

people/all/blocks/missing_slots используют общие frozen snapshots и current delivery gates. Blocks — ANY выбранной компетенции плюс явно выбранные люди; новые участники после создания не добавляются. Invalid/inactive/faculty адресаты и неизвестные имена компетенций отвергаются, а не молча отбрасываются. Недоступный Telegram сохраняется как unavailable.

missing_slots переводит индекс (по умолчанию 0) в конкретный московский понедельник внутри idempotent transaction по DB-clock. Общий сервис проверяет настроенный видимый горизонт и заполнение недели; до HTTP заполнение перепроверяется. Повтор не переводится заново в другую неделю: возвращается сохранённый результат. Индекс вне допустимого диапазона не заменяется молча на 0.

По умолчанию dispatchMode=now. Для расписания явно передать dispatchMode=scheduled и scheduledAt; общие UTC Instant/Europe-Moscow/DB due, +30 секунд…365 дней, misfire/expiry и отсутствие ранней отправки действуют без изменений. scheduledAt при now отвергается, не игнорируется. Текст не обрезается: совокупные stripped title/body до 40000 UTF-16 единиц разбиваются общим сервисом на сохраняемые части до 4000 единиц. Счётчики ответа остаются по адресатам, не частям; [broadcast-parts.md](broadcast-parts.md).

Ответ **202 Accepted**, не подтверждение отправки: success, broadcastId/version, recipients, queued, unavailable, pending, delivered=0, failed=0, attention=0, deliveryStatus, availabilityWeekIndex. Даже повтор после sent возвращает прежний ответ; текущий результат читается через GET /api/v1/broadcasts/{id} и журнал. Все unavailable также сохраняются без фиктивного sent. Создание, snapshot, deliveries, audit и idempotency атомарны; конкурентный повтор создаёт одну рассылку. HTTP Telegram внутри команды не вызывается.

## Границы

Production Node и frontend не переключены. Старый UI ещё требует адаптации сообщения об Accepted и просмотра состояния в B-10/D-11; его Delivered=0 не следует трактовать как ошибку или успех Telegram. Plain text из общего v1 sender не переносит Node Markdown/author footer/кнопки и старую message history; CHAT-01/B-08/B-09 остаются отдельными этапами. Автор доступен в domain authorId. Нет произвольных group/thread адресатов.

Общие request/recipient-volume лимиты обоих Java routes и PATCH подключены через V023: [broadcast-creation-quota.md](broadcast-creation-quota.md). Defaults — 10 запросов за 10 минут и 500 sendable recipients за час на действующего автора команды, с прежними настройками окружения. Telegram bot/chat transport quota уже общая, но не заменяет эти лимиты. Adapter не объявляет полный production-паритет legacy endpoint. B-07 остаётся открытым для других occurrences, group allowlist, UI и эксплуатационной приёмки. Sender выключен по умолчанию; реальные отправки не выполнялись.

Ponytail: переиспользованы BroadcastService/AvailabilitySubmissionService, existing transactional idempotency, audience snapshot, current gates и sender; новая миграция или зависимость не нужна.

## Приёмка

04.10.2026 полный mvnw.cmd --batch-mode verify: **271 tests, 0 failures/errors/skipped, BUILD SUCCESS**, PostgreSQL 17.11; log `target/legacy-broadcast-final-verify-2.log`. Пять новых integration tests плюс прежние 266: session identity/spoof, replay после подтверждённой доставки без нового задания, named ANY blocks + explicit recipients/unavailable/frozen late join, dated week completeness + scheduled no early start, access/Origin/validation/atomic rollback и concurrent same-key replay. Existing shared sender/domain/quota/unknown проверки сохранены. OpenAPI legacy path/reference проверен. Diff check, включая новые файлы, без ошибок.

Первый полный прогон обнаружил нестабильность старого TelegramHttpTransportTests: cold local request не успевал быть принят за 300 ms. Fixture теперь удерживает body через latch до client timeout (2 s), сохраняя strict UNKNOWN и count=1; production timeout и transport не изменены. Повторный полный прогон зелёный, не просто отдельный rerun упавшего теста.

Серверный adapter блок 100%; B-07 оценочно 82%, не закрыт. Общий счёт 38/65 (58.5%). Реальный Telegram не использовался; live SLO/точность 12:00/production cutover не подтверждены.
