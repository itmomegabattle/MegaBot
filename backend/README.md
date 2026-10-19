# MegaBot backend

**Последний B-08 gate 18.10.2026:** native force_reply preparation принят focused94/full629 без failures/errors/skipped, JAR собран (`target/telegram-meeting-force-reply-verify.log`). Open meeting prompts запрашивают native reply UI через прежний strict parser/sender; это ещё не проверка causal binding входящих сообщений. B-08 оценочно85%,44/67; см. [checkpoint](telegram-text-causality.md). Ближайшее exclusive Java/SQL/Maven/Docker окно передано B-09 для V041 staging; B-08 source edits/build — после его release. Оба таймера ACTIVE20min, production выключен. Старые baseline numbers ниже исторические.

**Возобновление 18.10.2026:** владелец согласовал legacy date-only дедлайны TIME-01/B-09 как23:59:59.999 МСК с сохранением исходной даты; второй чат реализует решение. Оба таймера ACTIVE20min. B-08 продолжает [causal-policy research](telegram-text-causality.md); последний принятый full627, оценочно85%. Предыдущие записи PAUSED в журналах исторические; новые вопросы владельцу требуют остановки обоих таймеров.

**Актуально 18.10.2026:** confirmed private meeting dialog поддерживает аудиторию, выбор/подтверждение блока, тему/описание, дату, время/final create и Back. Domain effects/completed draft/final reply атомарны; completed panel привязана к current meeting/version/owner/source и инвалидируется navigation/new dialog. Actual all-audience final-create JVM recovery проверен до/после commit (2 kills+2 cold resumes), без второго create/SEND. Последний focused2/full627 без failures/errors/skipped, JAR собран (`target/telegram-meeting-restart-verify.log`). Reordered input policy, remaining Telegram/details и Google parity остаются открыты. B-08 оценочно85%, production выключен. Оба таймера ACTIVE/20min; при необходимости решения/действия владельца остановить оба и задать вопрос. Ранние описания unsupported уже принятых шагов ниже исторические.

Подробности, ограничения и предыдущие доказательства: [telegram-inbox.md](telegram-inbox.md).

Изолированные тесты Telegram: [границы, защита и запуск](live-test.md). Только отдельный согласованный бот и два личных тестовых чата; отдельные БД/порт/том, отправка по умолчанию выключена.

Новый backend создаётся как модульный монолит на Java 21, Spring MVC и PostgreSQL 17. До этапа B-10 он не является production-писателем и не использует боевые Telegram/Google credentials.

Актуальная приёмка ранних этапов (06.10.2026): B-01/B-02/B-04 закрыты; Compose-db + host-Java outage/recovery/restart drill прошёл, полный текущий PostgreSQL verify —466 tests без ошибок/пропусков. B-00/B-03/B-05 имеют конкретный остаток. [Матрица приёмки](early-stage-acceptance.md) различает проверенные локальные этапы и ещё не подтверждённые production/полный legacy-паритет.

## Учебный scope

- Spring Boot 4.1.1, Java 21, Maven Wrapper 3.3.4 с Maven 3.9.16.
- PostgreSQL 17.11, Flyway и `ddl-auto=validate`.
- Авторизация Telegram Mini App, серверные сессии и проверки ролей.
- CRUD команды, событий, доступности, встреч и задач.
- Транзакционные inbox/outbox, точные отложенные рассылки и интеграционные jobs.
- Контрактные, repository и конкурентные тесты на настоящей PostgreSQL через Testcontainers.

Production-паритет дополнительно требует миграции реальных данных, проверки Telegram/Google, backup/restore drill и управляемого cutover. Эти действия не входят в локальный запуск.

## Требования, которые ещё нужно подтвердить по заданию

- разрешён ли Spring Boot как способ запуска Spring MVC;
- обязательная версия Java и допустимость Java 21;
- обязательны ли JPA/Hibernate или требуется чистый JDBC;
- минимальное число сущностей и CRUD-сценариев;
- обязательность Docker, автотестов, отчёта и очной защиты.

Пока ответы не получены, реализация следует зафиксированному стеку из `backend.md`, но не выдаёт его за подтверждённые преподавателем требования.

## Локальный запуск

1. Использовать JDK21. Local defaults в Compose и `application-local.yml` совпадают; для переопределений передать значения окружением по `.env.example`. Spring не загружает `.env` автоматически; Compose-файл окружения задаётся отдельно через `--env-file`. Не использовать production credentials.
2. Из корня выполнить `docker compose up -d db`.
3. На Windows выполнить `mvnw.cmd spring-boot:run -Dspring-boot.run.profiles=local`, на Unix — `sh ./mvnw spring-boot:run -Dspring-boot.run.profiles=local` (wrapper в Git не требует executable-bit).
4. Проверить `/actuator/health/liveness` и `/actuator/health/readiness`.

Для сборки app-контейнера: `docker compose --profile app up --build`. PostgreSQL и HTTP опубликованы только на `127.0.0.1`. Named volume `megabot-postgres-data` сохраняет локальную БД между перезапусками. Изменение init credentials не применяется к уже созданному volume.

Изолированная приёмка B-01 после `mvnw verify`: из корня `npm run verify:java-compose` с `JAVA_HOME`, указывающим на JDK21. Скрипт использует существующий `compose.yaml` с временным override, новый Compose project/named volume и свободные loopback-порты. Он запускает готовый JAR в local/fake режиме без входящего consumer, sender и токенов; проверяет readiness при остановке/восстановлении своей БД и сохранность synthetic participant/Flyway history после пересоздания контейнеров и рестарта Java. Проверяются probes и со старой cookie. Host environment очищен, `.env` не читается; существующие БД/тома/процессы не затрагиваются. В конце удаляется только созданный этим запуском Compose project/volume; logs/result JSON остаются в `output/megabot-b01-*/`. Docker daemon должен быть локальным, Docker Compose — поддерживать `!override` для ports.

## Проверки

V032 добавляет durable self-slot drafts: отдельное состояние недели в PostgreSQL, TTL15 минут, current owner/profile gate, revision и atomic save/day save/cancel через общий AvailabilityService. Локальные «Слоты»/`/slots` создают summary/inline root panel; V034 хранит канонические text/markup текущей панели. Нажатие «Изменить слоты» атомарно ставит ack и edit с выбором недели в общую очередь; confirmed-panel gate принимает provider ID только из committed sent delivery. Переходы к неделям/дням/часам и остальная навигация ещё не подключены; incoming consumer выключен. Контракт и ограничения — [telegram-inbox.md](telegram-inbox.md).

Mini App: создание по времени МСК и read-only история/журнал включаются только по Java capability. Контракт и безопасная воспроизводимая проверка: [broadcast-ui.md](broadcast-ui.md). Node остаётся immediate-only; production cutover не выполнялся.

Длинные рассылки: [broadcast-parts.md](broadcast-parts.md). Ordered durable parts, recipient-level результат только после всех подтверждений; unknown блокирует продолжение, ручной повтор касается одной части.

Ручные рассылки в явно разрешённые группы/топики: [broadcast-group-allowlist.md](broadcast-group-allowlist.md). Отдельный admin allowlist, frozen approval version и bot-scoped claim; старые group bindings автоматически не разрешаются.

Уведомление автору об expiry рассылки: [broadcast-expiry-notice.md](broadcast-expiry-notice.md). Отдельное намерение в общей queue, frozen author binding, честная partial/unknown сводка; не повторяет просроченную рассылку.

Реальный обрыв ответов PostgreSQL и восстановление delivery queue: [database-outage-acceptance.md](database-outage-acceptance.md). Docker pause только собственного disposable Testcontainer; fake Telegram, четыре сценария, полный verify 326 tests без ошибок. Production и live-test БД не затрагиваются.

Admin-only диагностика очереди и задержек: `GET /api/v1/admin/delivery-diagnostics`, контракт [delivery-diagnostics.md](delivery-diagnostics.md). Это агрегаты сохранённых попыток, не подтверждение SLO или production-ready отправителя.

Локальные подблоки B-08: durable Telegram inbox, выключенный по умолчанию secret-authenticated webhook, claim/lease/recovery и ручной/local worker с private `/start`, «Помощь»/`/help`, «Профиль», «Меню» и «Слоты»/`/slots`; контракт [telegram-inbox.md](telegram-inbox.md). Identity resolver общий с Mini App, команды не создают сессий. Command replies с reply/inline keyboard используют общую очередь/sender с bot/source/current-role/binding/15-minute expiry gates; command сверяется с исходным inbox text. Core «Меню» открывает собственный профиль с реальными счётчиками из PostgreSQL; faculty «Меню» остаётся меню задач. Версия профиля повторно проверяется перед HTTP. V031/queue apply обеспечивают atomic callback-effect dedupe между update IDs; slot root callback открывает выбор недели через atomic ack/edit в общей очереди; V034 хранит canonical panel, binding использует committed sent delivery. Датированные week/day callbacks, cancel-day, hour/full-day/unavailable/out и save day/week используют тот же черновик и ack/edit; hour/save блок принят локальным полным verify529. «Назад» требует dialog state и пока unsupported. Автоматический incoming consumer и polling ещё впереди; reception order не заменяет политику reordered updates. Реальный webhook не регистрировался, sender не включался, настройки ботов не меняются.

- `mvnw.cmd verify` — Java tests и Testcontainers PostgreSQL;
- `npm run lint && npm run build` из корня — существующий frontend/Node;
- CI выполняет обе группы независимо.

Предпосылка Telegram-редактора слотов: общий transport/queue поддерживает private callback-only inline keyboard со строгими UTF-8/markup/target/source проверками. Root callback открывает выбор недели через durable ack/edit; привязка к confirmed provider message использует прежнюю delivery. V034 добавляет одну колонку canonical panel в существующий draft. Parser и panel predicate общие для planner/sender, без новых dependencies/очереди/scheduler. V035 и внутренний selectWeek сохраняют правки/версии других недель в прежнем draft; сохранение выбранной недели оставляет редактор open. V036 и внутренние beginDay/cancelDay хранят и восстанавливают снимок дня без потери соседних правок. Week/day/cancel и hour/status/save callbacks подключены локально к общим DB operations; hour/save принят локальным full verify529. Меню/Профиль/Помощь/start закрывают свой slot editor атомарно (verify541); контекстный Назад принят focused83/full546: день→неделя→выбор→сводка→профиль с сохранением pending внутри редактора; полный verify без failures/errors/skipped. Удаление подтверждённых старых slot panels принято full verify554 через прежнюю queue/quota/transport (V037); actual editor JVM crash/failover принят focused2/full556 (4 child JVMs); остальные private flows и дальнейший recovery ещё открыты. Контракт и ограничения в [telegram-inbox.md](telegram-inbox.md).

Локальный и test-профили принудительно требуют `fake` для Telegram и Google. Реализованные бизнес-endpoints сохраняют доменные данные и задания интеграций; внешняя сеть в HTTP-транзакции не вызывается.

## Схема данных

Flyway-миграции `V001`–`V010` разделены на identity/settings, availability/meetings, tasks, messaging/integrations, migration tracking, версионирование справочников/напоминаний, индекс журнала, восстановимые операции очистки и общий faculty scope. Hibernate не создаёт и не обновляет схему: в каждом профиле действует `ddl-auto=validate`.

`OutboxWriter` требует уже открытую доменную транзакцию (`Propagation.MANDATORY`). Поэтому событие невозможно случайно зафиксировать отдельно от изменения агрегата; worker и внешняя отправка добавляются только на B-07.

## Авторизация

`POST /api/v1/auth/telegram` принимает только исходную строку Telegram `initData`. Identity из дополнительных JSON-полей игнорируется: ID, username и имя извлекаются после HMAC-проверки, TTL 5 минут и допуска будущего времени 30 секунд. Неизвестный Telegram ID получает отказ; первичная привязка возможна только к одному заранее добавленному активному профилю с совпавшим username. Bootstrap admin задаётся только числовыми ID в `ADMIN_TELEGRAM_IDS`.

## Team, events and dated availability

`/api/v1/profile`, `/team`, `/users` и `/events` используют серверную роль из сессии и optimistic `version`. Деактивация сохраняет историю, запрещает удаление последнего администратора, блокируется при будущих встречах или незавершённых назначениях и отзывает активные сессии.

`GET /api/v1/availability` строит горизонт от календарного понедельника в `Europe/Moscow`. `PUT /api/v1/availability/weeks/{weekStart}` заменяет только одну неделю и проверяет её собственную версию; отсутствующая новая неделя возвращается пустой. Метаданные недели привязаны к дате понедельника, а `outOfWeek`, `unavailable` и `unanswered` остаются разными состояниями.

Компетенции разделены на `core` и `faculty`; участнику нельзя назначить компетенцию чужого контура. Один факультетский пользователь состоит максимум в одном факультете. Справочники выводятся из использования через `active=false`, поэтому старые ссылки не удаляются. `/api/v1/availability/suggestions` возвращает до пяти лучших окон и причины отсутствия каждого человека.

Создающие endpoints требуют `Idempotency-Key` из 8–128 безопасных символов. Ключ scoped по подтверждённому actor и операции: точный повтор возвращает сохранённый ответ с `Idempotency-Replayed: true`, а другое тело получает `409`. Изменения B-04 записываются в `audit_events` внутри доменной транзакции.

Временный `GET /api/state` сохраняет форму текущего `SimulationState`, но собирается из PostgreSQL и не раскрывает Telegram ID, год рождения коллеги, внутренние настройки и чужие сообщения. Он доступен только основной команде. Встречи и задачи читаются из PostgreSQL. Факультет получает собственный профиль через `/api/faculty/me` и назначенные задачи своего scope через `/api/faculty/my-tasks`.

## Встречи и RSVP

`/api/v1/meetings` хранит начало как точный `Instant` и фиксирует `Europe/Moscow` как проектную зону. Обычная встреча и монтаж должны попадать в активные дни и часы доступности; длительность монтажа выбирается от 30 минут до 6 часов с шагом 30 минут (PRODUCT-06), весь интервал должен помещаться в рабочие часы, требуется активное мероприятие и приглашает всю основную команду. `vibe` допускает любой день, время и переход через полночь. Фаза `ongoing/upcoming/past/cancelled` вычисляется по фактическому окончанию.

Аудитория фиксируется snapshot-списком при создании и пересчитывается только при явном изменении встречи. Каждый приглашённый начинает с `unanswered`; повтор того же RSVP является no-op. Создание, изменение и отмена атомарно записывают встречу, audit, outbox-событие с текущими `chat_id/message_thread_id` важных топиков и версионированное задание Google Calendar. Фактическая отправка и Calendar API относятся к B-07/B-08 и никогда не вызываются внутри HTTP-транзакции.

Сессия — случайный 256-bit opaque token. В PostgreSQL хранится только SHA-256 hash; повторный вход отзывает прежние сессии пользователя. Cookie имеет `HttpOnly`, `Secure`, `SameSite=Lax`. Защищённые mutations требуют точный same-origin `Origin` либо origin из `MEGABOT_ALLOWED_ORIGINS`. Local/test интеграции остаются fake.

## Baseline паритета

Scheduled task reminders теперь материализуются как durable occurrences и отправляются тем же отключённым по умолчанию sender с shared quota. Поддержаны repeat без drift, before-deadline, skip старых тиков, eligibility перед сетью и provider-only markers. Manual notify outbox тоже подключён через audited intent/frozen recipients/current eligibility. Создание/правка/назначение/отказ/комментарии/статус/отмена также подключены к общей очереди; конкретная приёмка — в B-07. Контракты: [task-reminder-delivery.md](task-reminder-delivery.md), [manual-task-delivery.md](manual-task-delivery.md).

Журнал рассылки и explicit unknown retry доступны через `/api/v1/broadcasts/{broadcastId}/deliveries` и `/{deliveryId}/retry`: автор/admin, подтверждение возможного дубля, новая связанная доставка без сброса исходной истории и без повторов успешных адресатов. Java capability-gated UI подключён; production Node не включает этих Java-действий. Контракт: [delivery-journal.md](delivery-journal.md).

Sender/Telegram transport и shared PostgreSQL quota добавлены, но по умолчанию выключены даже при наличии token. Включение требует отдельного согласованного шага; подготовлены broadcast, scheduled и ручные task reminders, создание/правка/отмена встреч для личных чатов и важного топика группы. Task events, slots и birthday occurrences также подключены локально; полная эксплуатационная приёмка ещё впереди. Контракт встреч: [meeting-notifications.md](meeting-notifications.md). Коды ошибок, recovery, безопасность и границы точности: [dispatcher.md](dispatcher.md).

Java legacy create/update/comment/status/claim/release/delete/notify используют actor из сессии и общий TaskService. Частичный update сохраняет отсутствующие поля и неизменные расписания напоминаний; version и Idempotency-Key обязательны. Delete отменяет задачу без физического удаления, release сохраняет назначения коллег. Notify сохраняет тихое задание в outbox без ложного delivered: общий worker обрабатывает его отдельно после COMMIT. Поддержан shared `facultyId=all` для выбранных участников разных факультетов, без доступа неназначенных пользователей. Legacy admin preview/clear/reset готовы, fingerprint обязателен; `/api/task/log/clear` запрещён с 410. `/api/task/export` отдаёт текущие задачи как paged CSV, v1 export — отдельно историю. Старый frontend/Node ещё не переключён на Java (B-09/B-10).

B-06 закрыт: PostgreSQL verify — 118 tests без failures/errors/skipped. Матрица приёмки и границы последующих этапов: [b06-acceptance.md](b06-acceptance.md).

Смена статуса/завершение уведомляет координатора задачи тихим сообщением с фактическим инициатором через ту же очередь: [task-status-delivery.md](task-status-delivery.md). Реальные Telegram-отправки по-прежнему выключены.

Создание новой задачи подключено к постоянной очереди: тихие личные уведомления исполнителям; открытая core-задача — по указанным компетенциям либо всей core-команде без требований. Snapshot и текущие scope/binding/version проверки: [task-creation-delivery.md](task-creation-delivery.md). Реальные отправки выключены.

B-07: добавлен PostgreSQL lifecycle `planned → claimed → sending → sent/retry/failed/unknown`, lease/token recovery и V011. Независимый bounded sender/scheduler реализован, автоматическая отправка по умолчанию выключена; NTP/alarms/VDS/SLO gates ещё открыты; контракты и остаток этапа: [notifications.md](notifications.md).

Воскресное напоминание о незаполненных слотах: 18:00 МСК, grace до 21:00, immutable weekly snapshot и повторная проверка заполненности перед отправкой. Использует общий выключенный по умолчанию sender. Контракт: [availability-reminder-delivery.md](availability-reminder-delivery.md).

Дни рождения: три самостоятельных daily occurrences в подтверждённые владельцем 12:00 МСК, исключение именинника, frozen personal audience и проверка закрытия сбора в 19:00 прямо перед HTTP. Без публикации возраста. Контракт: [birthday-reminder-delivery.md](birthday-reminder-delivery.md).

Медленные нагрузочные проверки запускаются отдельно: `mvnw.cmd --batch-mode -Dtest=DeliveryLoadIT test`. Они используют изолированную PostgreSQL и fake Telegram, не production; отчёт и границы измерений: [delivery-load-report.md](delivery-load-report.md).

Аварийное завершение worker JVM проверяет `DeliveryProcessCrashIntegrationTests` (входит в обычный `verify`): отдельные дочерние Spring-процессы, disposable PostgreSQL и только fake transport. Поиск/завершение чужих Java-процессов не используется. Изолированный запуск: `mvnw.cmd --batch-mode -Dtest=DeliveryProcessCrashIntegrationTests test`; сценарии и границы: [process-crash-acceptance.md](process-crash-acceptance.md).

`/api/v1/broadcasts` сохраняет рассылку и snapshot адресатов вместе с очередью в одной транзакции. Поддержаны отложенная/немедленная отправка, перенос до начала попытки, отмена, optimistic version, idempotency и честные per-target статусы. Режимы: люди, вся core-команда, компетенции, не заполнившие слоты и отдельно разрешённые группы/топики. Контракт и ограничения: [broadcasts.md](broadcasts.md). Legacy adapter и capability-gated UI реализованы локально; sender по умолчанию выключен. Малый согласованный private live smoke не заменяет TIME-07 и production cutover.

Ядро задач доступно через `/api/v1/tasks`: CRUD деталей и подсказок, настройки напоминаний, shared claim/release, статусы, отмена, append-only комментарии и история. `/api/v1/faculty/my-tasks` проверяет одновременно faculty membership и собственное назначение. Совместимый `/api/state` уже отдаёт задачи; это подготовленный Java-контур, переключение production/frontend ещё впереди. Расписание напоминаний хранится с исходным anchor и версией; подготовленный B-07 worker описан в [task-reminder-delivery.md](task-reminder-delivery.md) и выключен по умолчанию. Правила переходов, пагинация и границы B-06: [tasks.md](tasks.md).

- Полная матрица текущих HTTP-маршрутов: [parity-matrix.md](parity-matrix.md).
- `/api/v1/tasks/log` читает сохранённые версии истории (core only); `/api/v1/tasks/export` отдаёт admin-only постраничный UTF-8 CSV с защитой от формул. Admin v1 archive/reset требуют точный preview fingerprint, сохраняют recovery-копию и поддерживают restore. Это подготовленный Java-контур, legacy кнопки ещё не переключены. Контракт: [tasks.md](tasks.md).
- Обезличенные transport-independent fixtures: `src/test/resources/parity/`.
- Telegram-команды/callbacks и матрица уведомлений остаются обязательной частью B-08 из `backend.md`; HTTP CRUD не считается их заменой.
