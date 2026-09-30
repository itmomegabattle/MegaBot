# MegaBot: пошаговый переход на Java и PostgreSQL

Дата плана: 16.09.2026; уточнение по повторному аудиту: 21.09.2026. Исходная ревизия: `3f91a42`. **Java-бэкенд пока не реализован.** Этот файл задаёт целевую архитектуру, порядок реализации и приёмку для следующего исполнителя.

## 1. Цель и границы

Перенести текущую серверную логику MegaBot с Node/Express и Google Sheets database на Java + транзакционную PostgreSQL. Сохранить React Mini App, Telegram-сценарии, слоты, три типа встреч, задачи, роли, факультеты и интеграции. Добавить долговечную очередь для точных отложенных сообщений по TIME-01…TIME-07 в `todo.md`.

Соответствие предоставленному заданию: **React** — один из разрешённых frontend; **Spring MVC** — разрешённый backend, Spring Boot используется для конфигурации и запуска; **PostgreSQL** — требуемая БД. Список на скриншоте содержит альтернативы, а не требование внедрить одновременно Angular/Vue/JSF. React/Vite сохраняется; WebFlux, серверные JS API Next.js и proxy всех операций в Node не заменяют требуемую реализацию на Spring MVC. Ограничения учебной защиты, которых нет на скриншоте, уточняются в B-00.

Это **модульный монолит**, один Spring Boot сервис и одна PostgreSQL. Не вводить микросервисы, Kafka, Kubernetes, Redis или отдельную БД на модуль. Для текущей команды они не нужны. Очередь хранится в PostgreSQL. Google Sheets после переключения остаётся пользовательской таблицей/экспортом, но перестаёт быть основной БД.

Разделить две контрольные точки:

- **Учебный результат:** Java API, PostgreSQL, миграции схемы, авторизация, транзакции, CRUD, очередь, тесты и воспроизводимый запуск на синтетических данных. Можно показывать преподавателю до production-перехода.
- **Production-паритет:** все действующие сценарии и данные перенесены, интеграции проверены, проведён контролируемый cutover и предусмотрен откат. Учебный MVP не объявлять полноценной заменой работающего бота.

## 2. Правила исполнителю

1. Прочитать `README.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `todo.md`. Приоритет доступа/надёжности — SEC/DATA из `todo.md`.
2. Выполнять B-00…B-09 последовательно. Общую запись outbox в транзакции подготовить B-02, её worker — B-07. CI начинается B-01, обязательная эксплуатационная часть B-11 выполняется **до B-10**; материалы защиты и итоговый отчёт B-11 можно завершить после переключения. B-12 — отдельное расширение после паритета.
3. Не переписывать frontend заново. Не переносить известные ошибки «ради совместимости». Менять контракт через адаптер и контрактные тесты.
4. До B-10 Java работает только с тестовой БД, fake Telegram/Google или отдельным тестовым ботом. Production-секреты не копировать в тесты и вывод команд.
5. Не запускать два writer приложения над одними реальными данными и два polling-процесса с одним токеном. Не вводить dual-write Node→Sheets и Java→PostgreSQL.
6. Отмечать `[x]` только после тестов; под этапом записывать дату, команды, краткий результат и оставшиеся ограничения. Не считать mock интеграции живой проверкой Google/Telegram.
7. Развёртывание production и изменение его данных выполняются только отдельной явно запрошенной операцией. Документ задаёт план; его наличие само по себе не является командой менять код или переносить живую базу.

## 3. Зафиксированный стек

| Часть | Решение |
|---|---|
| Язык | Java 21 LTS, без preview-функций |
| Framework | Spring Boot 4.1.1 как проверенная стартовая версия; перед установкой проверить доступные security patch этой линии и записать выбранную точную версию |
| Сборка | Maven Wrapper 3.9.x; точный patch фиксируется в wrapper, не системный Maven |
| HTTP | Spring MVC, Bean Validation, DTO-records, единый exception handler |
| Безопасность | Spring Security, проверка Telegram initData, серверные отзываемые сессии |
| Данные | PostgreSQL 17, актуальный patch; production image фиксировать по версии/digest, не `latest` |
| ORM | Spring Data JPA/Hibernate; JDBC/native SQL для захвата очереди и служебных блокировок |
| Схема | Flyway versioned SQL; `ddl-auto=validate`, никогда update/create в production |
| Тесты | JUnit, Spring Boot Test, Testcontainers PostgreSQL, mock HTTP server для интеграций |
| API contract | `backend/openapi.yaml`, проверяемый контракт; Swagger UI только local/dev при совместимой библиотеке |
| Эксплуатация | Docker Compose для app+db, существующий Caddy для TLS; Actuator health/metrics |
| Frontend | Существующий React/Vite; после миграции Node нужен для сборки, не для бизнес-логики |

Spring Boot поддерживает выбранную Java 21; не копировать названия starter/dependency из старых Boot 2/3 шаблонов без проверки совместимости с Boot 4. [System Requirements](https://docs.spring.io/spring-boot/system-requirements.html). PostgreSQL 17 — намеренный выбор поддерживаемой стабильной линии, не утверждение, что это последняя major-версия.

На 21.09 официальная документация подтверждает Boot 4.1.1 и поддержку Java 21; [PostgreSQL versioning](https://www.postgresql.org/support/versioning/) подтверждает поддержку линии 17. Перед созданием wrapper/image повторить проверку patch-версий; скриншот не задаёт этих версий.

## 4. Структура кода

Создать `backend/`, не перемещая существующий `src/` до переключения:

```text
backend/
  pom.xml, mvnw, mvnw.cmd, .mvn/wrapper/
  openapi.yaml, Dockerfile, README.md
  src/main/java/ru/itmomegabattle/megabot/
    MegaBotApplication.java
    auth/            # Telegram authentication, sessions, permissions
    team/            # users, competencies, faculties
    availability/    # dated weeks/days/slots, horizon
    meetings/        # meeting/setup/vibe, invitations, RSVP
    tasks/           # tasks, assignments, comments, history
    events/          # work events and archive
    notifications/   # broadcasts, deliveries, attempts, scheduler
    telegram/        # Bot API client, inbox, commands, chat flows
    integrations/    # calendar, sheets, reconciliation
    audit/           # actor/action/entity history
    common/          # Clock, errors, IDs, pagination; no business god-service
  src/main/resources/
    application.yml, application-local.yml, application-test.yml
    db/migration/V001__core_schema.sql
  src/test/...
compose.yaml         # app + PostgreSQL, local profile
```

Внутри доменного пакета разделить controller/service/repository/entity/dto. Controller разбирает запрос и actor, service проверяет правила и транзакцию, repository работает с БД. JPA entities наружу не сериализовать. Другой модуль вызывает публичный service, а не меняет чужие entities напрямую. Не создавать интерфейс и фабрику на каждый класс без реальной второй реализации.

## 5. Схема данных — обязательное покрытие

Правила: доменные ID — `text` с сохранением существующих `u_*`, `t_*`, `event_*`, meeting ID; новые генерировать UUID и сериализовать строкой. Telegram IDs — SQL bigint, в JSON строки. Для времени события/доставки — timestamptz, для календарного дня — date. Изменяемые агрегаты имеют `version bigint` для optimistic locking, created_at/updated_at. FK и индексы обязательны. Для enum использовать varchar + CHECK, чтобы Flyway явно управлял изменениями.

| Таблицы | Основные поля, ограничения и миграция |
|---|---|
| `users` | id, telegram_id UNIQUE nullable, username, real_name, role, registered, active, birthday_day/month/year nullable, joined_at, last_seen_at, version. Username не идентификатор безопасности. Год рождения опционален |
| `user_avatars` | user_id PK/FK, mime, content bytea, checksum, updated_at. На первом этапе хранить небольшое сжатое изображение в БД, отдельный GET endpoint; лимит размера и реальный decoder, не только MIME prefix |
| `competencies`, `user_competencies` | competency id/name/scope(core/faculty); связь PK(user_id,competency_id), is_primary; partial UNIQUE(user_id) WHERE is_primary |
| `faculties`, `faculty_memberships` | faculty name, user_id UNIQUE для текущей модели одного факультета; роль ответственного/помощника. Не расширять до нескольких факультетов без задачи |
| `work_events` | name, description, starts_at/ends_at nullable, status active/archived, created_by; CHECK ends_at>=starts_at при наличии обоих |
| `availability_week_metadata` | week_start date PK, title, description; CHECK понедельник; метаданные привязаны к дате, не позиции |
| `availability_weeks` | user_id + week_start UNIQUE, out_of_week, version; наличие строки не равно полностью заполненной неделе |
| `availability_days` | week_id + day_date UNIQUE, status unanswered/available/unavailable; day_date в диапазоне недели |
| `availability_slots` | day_id + start_minute UNIQUE; пока шаг 60 минут, 0…1380. Отсутствие слотов отличается от unavailable |
| `meetings` | kind meeting/setup/vibe, title, event_id nullable, starts_at, duration_minutes CHECK 30…360, zone_id, host_id, audience_mode all/selected/block, competency_id nullable, topic, description, status, version; setup требует event и 60 минут |
| `meeting_invitations` | meeting_id/user_id UNIQUE, rsvp unanswered/yes/no, responded_at; организатор учитывается явно; all разворачивается в snapshot активной core team |
| `calendar_links` | meeting_id UNIQUE, calendar_id, external_event_id, synced_version, last_success_at, last_error_code. Сохранить уже имеющийся googleCalendarEventId |
| `tasks` | title, description, sow, priority, status, event_id/faculty_id/creator_id nullable, due_at nullable, legacy_deadline, assignment_mode=shared, completed_by nullable, time_spent_minutes, completed_at/cancelled_at/cancelled_by, version |
| `task_assignees`, `task_competencies`, `task_tips` | нормализованные связи, UNIQUE пары; tips с position. Не хранить исполнителей в JSON-массиве |
| `task_comments` | id, task_id, author_id nullable, target_assignee_id nullable, side, text, created_at, legacy_source. Сохранить историю executor/coordinator и completionComments без выдуманных авторов |
| `task_reminders` | task_id, type, value/unit, anchor_at, next_due_at, sent_at/last_sent_at legacy, active; отмена task выключает будущие occurrence |
| `task_status_history`, `audit_events` | actor_id nullable, entity type/id, action, before/after или минимальный diff jsonb, occurred_at, request_id. Не писать токены, initData, полные приватные payload без необходимости |
| `sessions` | hash opaque token PK, user_id, expires_at, revoked_at; plaintext token только в HttpOnly Secure cookie; срок 30 дней, revoke при отключении пользователя |
| `app_settings` | явные конфиги горизонта, часов, active days и timezone. Секреты вне БД. Служебные очереди не вкладывать в settings |
| `chat_bindings` | bot/chat_id, type, important_thread_id; group membership отдельно с telegram_id и observed_at; разрешённые отправителю targets |
| `telegram_inbox` | bot_id/update_id UNIQUE, payload jsonb, received_at, status, attempts, lease; срок хранения payload ограничен |
| `bot_messages` | legacy история сообщений user_id/sender/text/buttons/timestamp; не использовать эту таблицу как доказательство доставки |
| `broadcasts`, `broadcast_targets` | author, immutable content revision, scheduled_at, zone_id, misfire_policy, expires_at, status/version; snapshot получателей, UNIQUE(broadcast_id,revision,target_key) |
| `notification_deliveries`, `delivery_attempts` | очередь TIME-03; dedupe_key UNIQUE; immutable payload, target, intended_at/available_at, lease, status, provider result; попытки отдельными строками |
| `integration_jobs` | entity_id/version/provider UNIQUE, due/lease/status для Calendar/Sheets; выполнять свежую версию, не перетирать новым worker старым payload |
| `idempotency_requests` | actor/operation/key UNIQUE, request_hash, result_code/result_body, expires_at; сохранять результат атомарно с действием |
| `migration_runs`, `migration_rejects` | исходная revision/checksum, статистика, ошибки строк, итог; повтор того же снимка безопасен |

Удаление пользователя: deactivate по умолчанию; исторические авторы/исполнители не исчезают. Hard delete — отдельная эксплуатационная операция с политикой анонимизации. JSONB допустим для внешних payload, аудита и локальных вариантов кнопок, но не вместо всех доменных таблиц.

Дополнительные ограничения схемы:

- `telegram_group_members` сохраняет наблюдаемый состав (chat_id, telegram_id, status, observed_at); Telegram Bot API не даёт достоверный полный список всех участников. Не называть импорт этого кэша полной переписью беседы.
- Привязки группы, пользователей и топиков — разные ID; важный топик не подставляется вместо исходного топика команды. Если поддерживается одна основная беседа, закрепить это настройкой/ограничением, не обещать multi-tenant.
- Многошаговые Telegram flows — отдельные записи с user/chat/thread, version, payload, expires_at либо явное безопасное завершение после рестарта. Перекличка и её ответы — отдельные таблицы, если должна переживать рестарт. `bot_messages` не хранит ни FSM, ни сведения об успешной внешней отправке.
- Межтабличные правила (день входит в неделю; связь primary competency; setup требует event; допустимый faculty scope) проверяются в service и, где возможно, FK/ограничениями/триггером. Обычный CHECK одной строки не проверяет произвольную связанную таблицу.
- Индексы UNIQUE/version сами по себе не решают конкурентные изменения коллекций: обновление assignments, invitations и availability_days должно блокировать или повышать версию родительского агрегата. Отдельно тестировать write skew и транзакционность изменения связей.

## 6. Права и API

Actor берётся только из серверной сессии/проверенного Telegram update. Поля requesterId/creatorId/hostId в старом API не дают прав.

| Действие | Разрешение |
|---|---|
| Изменение состава, ролей, блоков, недели, событий, настроек | admin |
| Свой профиль, аватар | сам пользователь; admin — управляемые поля другого; telegram_id/role не self-edit |
| Слоты | core team изменяет только свои конкретные даты |
| Встреча создать | active registered core team |
| Встреча изменить/отменить | host либо admin |
| RSVP | приглашённый/host изменяет только собственный ответ |
| Task создать | core team; scope факультета проверяется отдельно |
| Task изменить/отменить | creator либо admin |
| Task claim/release/status | исполнитель либо допустимый claimant; admin по правилам перехода |
| Faculty | только свои назначения/допустимый faculty scope; закрытие Mini App не заменяет проверку API |
| Broadcast | core team; редактировать/отменить автор либо admin; групповой target из allowlist |
| Диагностика/журнал доставки/экспорт всех данных | admin; автор видит результаты собственной рассылки |
| Временный `/api/state` | только core team; DTO без telegram_id, служебных settings и чужих messages; год рождения коллеги без года |
| `/api/faculty/me`, `/api/faculty/my-tasks` | только текущая faculty-сессия; задачи одновременно по assignee и faculty scope, без чужих заметок |

Целевые `/api/v1`: `/auth/telegram`, `/auth/logout`, `/me`, `/users`, `/competencies`, `/faculties`, `/events`, `/availability`, `/availability/weeks/{date}`, `/availability/suggestions`, `/meetings`, `/meetings/{id}/rsvp`, `/tasks`, `/tasks/{id}/comments`, `/tasks/{id}/status`, `/tasks/{id}/claim`, `/tasks/{id}/release`, `/broadcasts`, `/admin/integrations`, `/admin/deliveries`, `/time`. Read endpoints с limit/cursor, верхний limit=100. Общий `/api/state` допускается только временным адаптером с безопасной фильтрацией; не возвращать все таблицы.

Ошибки: `{code,message,fieldErrors,requestId,serverNow}`; 400 validation, 401 session, 403 permission, 404 absent, 409 version/idempotency conflict, 429 throttling, 503 storage unavailable. Mutation с version; create/broadcast с Idempotency-Key. Не возвращать stacktrace, SQL или секреты. Отключить Open Session In View; сборка DTO внутри service, не случайные lazy queries во время JSON serialization.

### 6.1. Реестр охвата и паритет каналов

В `server.ts` на исходной ревизии было **43 регистрации `/api/*` GET/POST**. После Node-исправлений к baseline 30.09.2026 их стало **54**; проверяемая построчная матрица находится в `backend/parity-matrix.md`. Таблица ниже остаётся групповой навигацией. Legacy URL можно заменить через frontend-адаптер; поведение/права не должны исчезнуть вместе с URL.

| Область | Текущие маршруты (префикс `/api`) | Этап |
|---|---|---|
| Вход/transport | POST `/user/get-or-create`, `/auth/logout`, `/telegram-webhook`; прежний публичный GET `/setup-webhook` уже удалён | B-03/08 |
| Состояние | GET `/health/live`, `/health/ready`, `/health`, `/state`, `/admin/diagnostics` (state заменить безопасными DTO) | B-01/03/09/11 |
| Доставка | GET `/notification-deliveries`; POST `/notification-deliveries/retry` | B-07 |
| Google Sheets | GET `/integrations/google-sheets/availability`, `/task-log`, `/mapping`; POST `/integrations/google-sheets/webhook`, `/template` (сокращённые GET также под этим префиксом) | B-08/09 |
| Команда | POST `/user/add`, `/user/update`, `/user/delete`; `/competency/add`, `/competency/delete` | B-04 |
| Факультеты | GET `/faculty/me`, `/faculty/my-tasks`; POST `/faculty/competency/add`, `/faculty/competency/delete`, `/faculty/user/add`, `/faculty/user/update`, `/faculty/user/delete`, `/faculty/task/create`, `/faculty/task/update` | B-04/06 |
| Недели | POST `/availability`, `/availability/weeks`, `/availability/week-name` | B-04 |
| Мероприятия | POST `/event/create`, `/event/update` | B-04 |
| Встречи | POST `/meeting`, `/meeting/update`, `/meeting/delete`, `/meeting/rsvp`, `/meeting/suggest` | B-05 |
| Задачи | POST `/task/create`, `/task/update`, `/task/comment`, `/task/delete`, `/task/notify`, `/task/claim`, `/task/release`, `/task/status`, `/task/log/clear`, `/task/archive/preview`, `/task/archive/clear`, `/task/season-reset/preview`, `/task/season-reset`; GET `/task/export` | B-06 |
| Рассылка | POST `/team/broadcast` | B-07 |

Telegram нельзя считать покрытым одним REST CRUD. Обязательная отдельная матрица B-08:

- `/start`, профиль, поиск/добавление участника, все доступные роли и меню; навигация имеет приоритет над вводом формы.
- Слоты: `nav_slots`, `slot_edit`, `slot_week`, `slots_day`, toggle час/день, unavailable, out, cancel day, save day/week; stale week и две независимые недели.
- Задачи: `nav_tasks`, `task_view`, claim/release/complete/skip; все шаги назначения и завершения (время/комментарий); факультетские pick/status/confirm.
- Создание встречи в чате: аудитория/блок/подтверждение/тема/описание/дата/время/назад/меню; `meeting_rsvp` и старые кнопки после изменения/отмены.
- Группы: `/all`, `/all_<block>`, `/meeting`, `/deadlines`, `/slots`, `/birthdays`, `/checkin`, `/bindteamchat`, `/bindimportant`, `/help`, `/cancel`; обновления `chat_member`/`my_chat_member` и callback `group_checkin`.
- Для каждого mutable flow: повтор update; два участника; два топика; изменение прав во время диалога; рестарт; удалённая/недоступная панель; API изменил сущность между двумя шагами чата. Reply «Меню» остаётся доступным, уведомления не удаляются вместе с временными панелями.
- Старые production `callback_data`, Mini App `?tab=tasks|meetings` и deep links продолжают открываться либо дают понятное обновление кнопки; старые Telegram сообщения нельзя массово переписать как React bundle. Общая групповая кнопка RSVP не может иметь персональную подпись для каждого: в группе оставить нейтральное действие с персональным callback-ответом, toggle-подпись — в личке.

Матрица уведомлений: создание/правка/отмена встречи → личные адресаты + «ВАЖНОЕ» + Calendar; RSVP → персональное подтверждение без рассылки; задачи (создание/open/назначение/claim/release/комментарий/завершение/отмена/напоминание) → только допустимые адресаты, всегда silent; рассылки → выбранные личные адресаты; слоты и birthday → свои occurrence. Задать для каждого канала dedupe key, snapshot аудитории, retry/unknown, идентификатор топика, текст и последствия изменения адресатов. Это включает редкие фоновые действия, а не только кнопку создания.

### 6.2. Решения до реализации, а не скрытые изменения поведения

Следующее **предложено**, но не следует автоматически из требования сменить стек: RSVP только приглашённым (сейчас API допускает любого core участника), snapshot аудитории вместо динамического `all`, показ встречи до endsAt вместо конца дня, отказ только самого исполнителя, новый дедлайн 23:59 МСК, время birthday, новые сроки retention и scheduled broadcast. Согласовать эти решения до соответствующего этапа; пока сохранять безопасную существующую семантику, не выдавать желаемое за паритет. Индивидуальные задачи и процессы/аналитика остаются за пределами обязательного переноса. Исправление обходов доступа и потери данных не является требованием сохранить старое поведение.

## 7. План реализации

### [ ] B-00 · Зафиксировать учебные требования и baseline

**Вход:** текущие docs и `todo.md`. Уточнить у владельца/из задания дисциплины: допустим ли Spring Boot, требуемая Java, число сущностей, обязательность ORM/JDBC, авторизации, тестов, Docker, отчёта и защиты. Пока ответа нет, B-01 можно делать с выбранным стеком; не обещать, что преподаватель зачтёт неподтверждённый набор.

**Действия:** составить матрицу всех маршрутов из `server.ts`, Telegram команд/callbacks, ролей и уведомлений. Сохранить обезличенные request/response fixtures. Зафиксировать все поля `src/types.ts` и legacy `chat-panels.json`: durable очереди отделить от временных панелей. Не копировать реальные персональные данные в репозиторий.

**Готово:** `backend/README.md` содержит scope учебной демонстрации и список parity-сценариев; текущие проверки проходят; известные дефекты не записаны как эталон правильного поведения. Старый `verify:core` сам запускает Node bundle: его зелёный результат **не доказывает Java-паритет**. Выделить транспорт-независимые fixtures/проверки с явно выбранным base URL и выполнять их отдельно против Java, без скрытого fallback на Node.

**Промежуточно 30.09.2026:** создан `backend/README.md`, актуализирован baseline до 54 HTTP-маршрутов, добавлены построчная `backend/parity-matrix.md`, инвентаризация legacy-модели и обезличенные fixtures. Учебный scope отделён от production-паритета. B-00 остаётся открытым до подтверждения требований преподавателя и извлечения исполняемых Telegram/parity fixtures с явным base URL; реальные данные в fixtures не копировались.

### [ ] B-01 · Каркас и воспроизводимый запуск

Создать Spring project, Maven Wrapper, profiles local/test/prod, Compose PostgreSQL с named volume, `.env.example` без значений секретов, отдельного DB-пользователя. В production PostgreSQL не публиковать в Интернет; локальный порт только 127.0.0.1. Добавить `/actuator/health/liveness` и `/readiness` без открытых management endpoints. JVM memory limit задать явно; сборку делать вне маленького production VDS.

**Проверка:** `cd backend; ./mvnw verify` (Windows `mvnw.cmd verify`), `docker compose up -d db`, запуск Java; restart сохраняет БД; dev fake config не позволяет обратиться к реальному Telegram. CI Maven verify и frontend lint/build появляется здесь, а не после production-переключения. Результат — работающий пустой backend, без фиктивных бизнес-endpoints, всегда отвечающих success.

**Промежуточно 30.09.2026:** создан отдельный Spring Boot 4.1.1/Java 21 Maven-проект, профили local/test/prod, Actuator liveness/readiness, fake-only guard для local/test, Dockerfile, root `compose.yaml` с PostgreSQL 17.11, отдельными admin/app ролями, loopback ports и named volume, `.env.example`, пустой OpenAPI и CI для Java + frontend. Maven Wrapper 3.3.4 использует Maven 3.9.16. `mvnw.cmd verify` прошёл на JBR 21.0.11: unit-тест выполнен, DB context-тест явно пропущен из-за отсутствия Docker; существующий `npm run verify:core` и `npm run lint` прошли полностью. B-01 остаётся открытым: Testcontainers, реальный compose startup, readiness DB up/down и сохранность volume после restart здесь не подтверждены.

### [ ] B-02 · Миграции схемы и repository-тесты

Реализовать таблицы из раздела 5 по доменам несколькими Flyway migrations. Добавить NOT NULL/CHECK/FK/UNIQUE и индексы для user/date, task assignee/status/due_at, meeting starts_at, due jobs. Use `@Version` для агрегатов. Для jobs индекс `(available_at,id) WHERE status IN ('pending','retry')`; условия с now() не помещать в partial index.

Подготовить минимальный `OutboxWriter` с записью задания в текущую доменную транзакцию и rollback-тестом. B-05/B-06 используют его без внешней отправки; B-07 добавляет обработчик очереди. Не ставить B-05 в зависимость от ещё не реализованного worker B-07.

**Проверка:** чистая PostgreSQL → миграции → повторный запуск без изменений; Testcontainers проверяет unique/FK/check, optimistic conflict, query pagination. H2 не заменяет PostgreSQL в тестах очереди и миграции.

**Промежуточно 30.09.2026:** добавлены пять Flyway migrations для identity/settings, availability/meetings, tasks, Telegram/broadcast/delivery/integration queues и migration tracking. Схема содержит FK/UNIQUE/CHECK, `version`, доменные индексы и claim-индексы без `now()` в predicate. Реализованы минимальные `UserRepository`, `@Version`-агрегат и `OutboxWriter` с обязательной внешней транзакцией. Подготовлены Testcontainers-проверки повторного Flyway migrate, unique/check, пагинации, optimistic conflict и rollback outbox; отдельный unit-тест контролирует полноту migration resources. Java `verify` компилирует весь слой и выполняет проверки без БД, но 7 PostgreSQL-тестов пропущены из-за отсутствия Docker, поэтому B-02 остаётся открытым и миграции пока не объявлены проверенными на реальной PostgreSQL.

### [ ] B-03 · Telegram auth, сессии и permissions

Реализовать SEC-01…06: HMAC, auth_date, только подписанный user, bootstrap admin по ID; token session хранится в БД только hash. Сгенерировать случайный токен достаточной энтропии, HttpOnly/Secure/SameSite=Lax cookie, revoke/logout. Для cookie mutations CSRF/Origin-защита с тестом same-origin Mini App. Auth endpoint валидирует свой подписанный payload и ограничен по частоте. Faculty получает только нужный доступ, не full-state.

**Проверка:** 4 роли × все защищённые действия; подмена body ID, просроченный auth, удалённый user, cross-faculty, CSRF и неизвестный webhook. Все локальные security-воспроизведения из todo должны стать отрицательными тестами.

**Промежуточно 30.09.2026:** добавлены Spring Security и method security, HMAC-проверка Telegram `initData` без дублирующихся параметров, TTL 5 минут/будущее 30 секунд, identity только из подписанного `user`, числовой bootstrap `ADMIN_TELEGRAM_IDS` и лимиты по IP/Telegram ID. Реализованы привязка ровно одного заранее добавленного профиля, opaque 256-bit сессии с хранением только SHA-256 hash, ротация/отзыв, `HttpOnly; Secure; SameSite=Lax`, session filter, `/api/v1/auth/telegram`, `/auth/logout`, `/me` и exact-Origin защита cookie mutations. OpenAPI и backend README обновлены. Восемь unit-тестов HMAC/TTL/tampering/duplicates/rate limit/origin/hash проходят; Testcontainers-тесты хранения сессии и HTTP login/logout подготовлены, но 10 DB-зависимых тестов пропущены без Docker. B-03 остаётся открытым до реального PostgreSQL-прогона и полной матрицы разрешений четырёх ролей на B-04…B-08 endpoints.

### [ ] B-04 · Команда, события, профиль и слоты

Реализовать CRUD справочников/профилей и dated availability. Week metadata хранить по date, GET возвращает 2–5 недель от московского понедельника; новую неделю представлять пустой, не копировать строки прошлой. Сохранять одну неделю за mutation. Out-week и unavailable-day имеют отдельные состояния. Исторические недели архивируются вне видимого горизонта, а не сдвигаются индексами в БД. Подбор лучших слотов перенести со всеми причинами недоступности и ограничениями длительности.

**Проверка:** DATA-03, ротация Москва 23:59→00:00, skipped weeks, stale version, только своя доступность, разные TZ, отсутствие активных событий. Контрактный адаптер возвращает frontend ожидаемый формат до его переключения.

**Промежуточно 30.09.2026:** реализованы safe DTO команды/профиля, self-edit без смены роли, admin create/update/deactivate, optimistic version, защита последнего активного администратора, проверка незавершённых назначений и будущих встреч, отзыв сессий деактивированного пользователя. Добавлен CRUD рабочих событий с архивированием. Dated availability отдаёт 2–5 недель от московского понедельника, создаёт отсутствующие недели пустыми, сохраняет только одну неделю, различает `outOfWeek`/`unavailable`/`unanswered`, валидирует активные дни и часы, хранит metadata по Monday date и не удаляет историю вне горизонта. Настройки горизонта версионируются. Добавлены версионированные справочники core/faculty competencies и факультетов, one-faculty membership и scope-проверка компетенций. Подбор возвращает пять лучших окон и причины `out`/`not_marked`/`inconvenient`. Create-команды используют actor-scoped PostgreSQL idempotency с replay сохранённого ответа, а mutations пишут audit в общей транзакции. Временный `/api/state` собирает frontend DTO из PostgreSQL без Telegram ID, чужого года рождения и служебных полей; faculty получает отдельный `/api/faculty/me`. Unit-тесты покрывают московскую ротацию, независимость системной TZ, skipped weeks, роли, даты, интервалы, каталоги, idempotency key, privacy mapping и алгоритм слотов. Полная HTTP-матрица четырёх ролей подготовлена в Testcontainers. B-04 остаётся открытым только до живого PostgreSQL-прогона этих DB/HTTP проверок; встречи и задачи в state заполнят B-05/B-06.

### [ ] B-05 · Встречи, RSVP и правила времени

Перенести meeting/setup/vibe, поля и permissions. Запись встречи + audit + задания уведомления/Calendar создаются в одной транзакции. Сеть — после commit через очередь. Setup: event обязателен, 60 min, core team. Vibe: любой день/время. Normal/setup: соблюдение slot settings. Хранить duration в минутах, принимать даты строго. RSVP явный, initial unanswered; старые attendeeIds→yes, остальные→unanswered с пометкой legacy (не придумывать отказ).

**Проверка:** create/update/cancel сохраняют kind, полный текст изменений, приглашения и thread; повтор запроса идемпотентен; конкурентные update дают 409; ночная встреча корректно заканчивается завтра. Внешние сервисы отключены — доменная запись и очередь всё равно сохранены.

**Промежуточно 30.09.2026:** реализованы v1 list/create/update/cancel/RSVP, строгая нормализация `meeting/setup/vibe` в `Europe/Moscow`, ограничения активных дней/часов, setup 60 минут + обязательное активное event + вся core-команда и ночной `vibe` по фактическому времени окончания. Аудитория сохраняется snapshot-приглашениями с initial `unanswered`; при update RSVP оставшихся участников не теряется. Host/admin permissions, optimistic version и actor-scoped idempotency действуют для mutations. В одной транзакции пишутся meeting, audit, notification outbox со snapshot важных chat/thread targets и versioned Google Calendar job; сеть не вызывается. `/api/state` уже получает встречи из PostgreSQL. Unit-тесты проходят; HTTP/DB/rollback/permission сценарии подготовлены в Testcontainers, но живой PostgreSQL-прогон остаётся обязательным, поскольку Docker на текущей машине недоступен. B-05 до него не закрыт.

### [ ] B-06 · Задачи, комментарии, faculty и история

Сначала сохранить shared-модель. Открытая задача — нет assignments; claim атомарно проверяет доступность. Смена статуса проверяет разрешённые переходы, cancelled не переоткрывается, повтор текущего статуса no-op. Comments append-only с author/side; завершение закрывает комментарии до переоткрытия. Все task сообщения тихие. Архивирование event не скрывает активные задания, nullable eventId поддержан. `task_log` строится из истории, не отдельная непроверяемая копия.

**Проверка:** два claim — один победитель; 20 параллельных create не теряются; completion уведомляет автора, а не всех admin; shared completedBy корректен; invalid deadline отклонён; faculty не получает core task и не меняет чужое назначение.

Добавить PRODUCT-05/API-03: частичный отказ не снимает коллег; отменённая задача не оживает через старый callback; финальный шаг диалога перечитывает статус и роль. Таблица переходов статусов обязательна, перечисления допустимых enum недостаточно.

**Промежуточно, ядро B-06:** добавлены v1 create/update/list/get/claim/release/status/cancel/comments/history и scoped `/api/v1/faculty/my-tasks`. Shared-модель сохраняет `completedBy`; release снимает только текущего пользователя. Строка задачи блокируется до проверки версии и изменения; задача, история, audit и тихий outbox фиксируются вместе. Завершение уведомляет автора. Comments append-only с actor/side/target, после завершения закрыты до переоткрытия. Faculty scope проверяется по membership и назначению; чужие адресные заметки скрыты. Дедлайн — конец московского дня. Таблица переходов и остаток этапа записаны в `backend/tasks.md`. Подготовлены Testcontainers-сценарии двух claim, 20 create, idempotency, scoped faculty, закрытых комментариев и старых команд отменённой задачи; без Docker они ещё не исполнены. B-06 остаётся открытым: tips/reminders, compatibility DTO, task_log/export и preview/recovery архивирования/сезонного сброса ещё впереди.

### [ ] B-07 · Долговечная очередь, планировщик, отложенные рассылки

Реализовать **ровно контракт TIME-01…TIME-07** из `todo.md`; не проектировать ещё один несовместимый scheduler. В MVP generic notification_deliveries одновременно выполняет роль transactional outbox и очереди, отдельный брокер не нужен. Таймер Spring `@Scheduled(fixedDelay=500)` только будит worker, а не хранит расписание. Clock injectable; DB clock — источник due selection.

Пример атомарного захвата (параметры связать через JDBC, не конкатенацией):

```sql
WITH picked AS (
  SELECT id FROM notification_deliveries
  WHERE status IN ('pending', 'retry')
    AND available_at <= clock_timestamp()
    AND (expires_at IS NULL OR expires_at > clock_timestamp())
  ORDER BY available_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT :batch_size
)
UPDATE notification_deliveries d
SET status = 'claimed', lease_token = :token,
    leased_until = clock_timestamp() + interval '30 seconds'
FROM picked WHERE d.id = picked.id
RETURNING d.*;
```

После COMMIT: quota → повторная проверка отмены/version → фиксация `request_started_at` и attempt → HTTP → короткая транзакция результата `WHERE id=? AND lease_token=?`. Не захватывать больше заданий, чем worker может отправить в аренду. Lease продлевается token-guarded heartbeat; просроченный lease без начавшегося HTTP можно вернуть в pending, после начала — unknown. Возможна остановка старого worker после истечения lease: перед HTTP он проверяет token; после неопределённой отправки новый worker её автоматически не повторяет.

Для `sent`: записать provider message_id и response time. Агрегат broadcast status вычислять из targets, не считать завершённым при первом успехе. Долговременные дедуп-ключи occurrence сохранять дольше retry/grace/retention событий. Rate limiter сначала один sender process на bot; горизонтальное увеличение требует общего PostgreSQL limiter, не независимых in-memory лимитов.

**Проверка:** весь TIME-07, включая два workers, реальную PostgreSQL, таймаут после acceptance, crash и partial cancellation. Нельзя закрыть этап одним unit-тестом метода schedule().

### [ ] B-08 · Telegram и Google интеграции

**Telegram:** доменная обработка не зависит от HTTP транспорта. Inbox перед ack; webhook secret или polling, один режим. Сначала реализовать `/start`, профиль/слоты/встречи/задачи, затем group commands и остальные callbacks по B-00. Перенести reply/inline правила и временные панели, дедуп callback/update; ограничить TTL черновиков. Thread ID обязательный атрибут группового target.

**Calendar:** стабильный external ID по существующему правилу `googleCalendarEventId` либо сохранённый ID; upsert/cancel через integration_jobs. Job читает последнюю persisted version, старый результат не перезаписывает новую версию; последовательная синхронизация по meeting. Состав приглашённых из того же resolver, что уведомления.

**Sheets availability:** сохранить developer metadata Telegram ID, диапазоны нескольких недель, signed webhook. External event_id хранить durable. Редактирование Sheets переводить в узкую команду с date/scope/version, проверять stale-import. Не писать полный snapshot поверх PostgreSQL. Закрытая Sheets database после B-10 только frozen archive; экспорт отчётов — отдельная задача.

Перед реализацией зафиксировать формат всех трёх состояний дней и out для **каждой** недели. Нынешний checkbox сам по себе не отличает «не отметил» от «не смогу». API/webhook без версии не даёт надёжного last-write-wins: нужен baseline последнего экспорта и сравнение изменений по ячейке/дате либо явный конфликт для администратора. Собственные экспорты не должны запускать бесконечное эхо; удалённая/отсутствующая колонка не очищает день в PostgreSQL. Полный round-trip проверяет и importer, и доменное применение, не только Google payload.

**Проверка:** mock API outage/429/retry, calendar idempotency, сохранение thread ID, Sheets 2–5 weeks round-trip, сортировка строк, конфликт двух источников. Живую проверку выполнять позже на отдельном тестовом боте/таблице, без команды production.

### [ ] B-09 · Импорт legacy и адаптация frontend

1. Написать importer read-only snapshot→staging, сначала `--dry-run`. Вход — проверенный ready snapshot из существующей экспортной команды, не произвольные листы по отдельности. Сохранить checksum/revision и неизменяемый оригинал.
2. Разобрать всех users/events/tasks/meetings/slots/messages/settings, legacy comments/reminders/avatars. Сохранить IDs, Telegram ID, Calendar ID, completed/cancelled историю. Даты без года, invalid dates, отсутствующие refs, дубликаты telegramId — `migration_rejects`, не автоматическое «угадывание».
3. Для слотов `absolute day index + weekStart` перевести в date; outWeekIndexes — в week_start. Не сдвигать уже датированные недели второй раз. Pending important/sheets export очереди импортировать отдельно из settings/runtime-файла; chat drafts с истёкшим TTL не восстанавливать.
4. Birthday/yearless сохранить корректно; due_at старых задач требует решения TIME-01. Missing historical author — nullable + legacy attribution, не текущий admin.
5. Сделать importer идемпотентным по checksum/source-id; одна транзакция на согласованный набор либо атомарный переход staging→target. После ошибки активная БД не наполовину импортирована. Исторические записи **не порождают новые Telegram-уведомления**; импорт старой доставки не означает новую отправку.
6. Сопоставить counts и canonical hashes по сущностям, FK, slots по датам и активные назначения. Все rejects исправить или письменно принять до production.
7. В `src/api/` добавить адаптер Java endpoints. Переключатель backend только build/config, без случайного fallback записи в старый API. Сначала сохранить UI, потом рефакторить дизайн. DTO auth/state заменить безопасными ответами; поддержать 409 и fieldErrors.

**Готово:** два импорта дают одинаковый результат без дублей; frontend выполняет core сценарии на Java; отчёт содержит исходные/итоговые counts, rejects и ноль неожиданных исходящих сообщений.

### [ ] B-10 · Релиз и переключение единственного писателя

Предусловия: B-00…09, проверенная резервная копия и восстановление, явный запрос владельца на production-переход. До этого этапа не отключать работающего Node.

**Release gate до B-10:** эксплуатационная часть B-11 уже выполнена (CI, restore drill, readiness, метрики, graceful shutdown, согласованный RPO/RTO); отрицательные SEC-тесты зелёные; пройдена матрица 6.1 и утверждены изменения 6.2; нет необъяснённых migration rejects. На fixture минимум 180 участников и 20 параллельных клиентов измерены память JVM+PostgreSQL+ОС, p95 API, connection pool, queue lag и восстановление после outage. Эти числа — размер проверочной нагрузки пользователя, не гарантия, что 2 GB хватит.

1. Подготовить release/image и конфиги; Java в dry-run без отправок, закрытая PostgreSQL. На VDS 1 CPU/2 GB из OPERATIONS измерить память: стартовый JVM heap 384–512 MB, небольшой DB pool (5), без сборки на сервере; если не помещается под нагрузкой — увеличить ресурсы до cutover, не надеяться на swap.
2. Включить maintenance для mutations, остановить старый polling/background scheduler, дождаться завершения принятых операций и durable snapshot. Зафиксировать последнюю revision и временную границу. Сделать финальную копию БД, runtime-очередей и конфигурации.
3. Импортировать финальный snapshot, сверить B-09. Пока не включены записи/отправки, отказ означает безопасный возврат к Node и старому состоянию.
4. Переключить Caddy API на Java и раздачу согласованного React bundle (выбрать Caddy static или Spring static заранее); сохранить same-origin cookie, SPA fallback и deep links. Выдать новые сессии (старые HMAC-cookie не переносить); включить один Telegram consumer и один sender. Не применять `drop_pending_updates=true`: ожидающие updates принять в inbox, старым mutations задать правила срока/идемпотентности. Перепривязать Apps Script endpoint/секрет только когда Java готова принимать изменения. Проверить smoke на своей тестовой сущности без массовой рассылки. Затем снять maintenance.
5. Контролировать ошибки/queue age/clock/DB в согласованное окно, например 24 часа. Старый процесс оставить остановленным, Sheets archive read-only.
6. **Откат после новых записей:** нельзя просто включить Node с прежним snapshot. Снова maintenance, остановить sender, сохранить PostgreSQL/результаты отправок, выполнить заранее проверенный reverse-export совместимой модели с reconcile delivered IDs либо чинить Java вперёд. Без готового reverse-export разрешён только fix-forward; это решение фиксируется до cutover.

**Готово:** реальные новые данные сохраняются после restart, один writer/consumer, health нужной revision, проверены роли и точность очереди; журнал миграции и отката не содержит секретов.

### [ ] B-11 · CI, backup, эксплуатация и учебная защита

**CI:** Maven verify/Testcontainers + frontend lint/build/core contract tests; dependency scan, безопасные logs; версия Docker image привязана к commit. Примерные проверки не запускать против production credentials.

**Backup:** pg_dump custom format ежедневно, отдельное зашифрованное хранилище, 14 daily + 8 weekly, регулярный restore drill. Для цели RPO≤15 минут нужен WAL/PITR/managed backup: daily dump сам по себе даёт до суток потери. На первом выпуске честно согласовать RPO и RTO; целевой RTO≤60 минут подтвердить восстановлением.

**Наблюдаемость:** TIME-06, readiness БД, размеры пула/очереди, последние sync, структурированные logs с requestId и без token. Graceful shutdown: readiness=false, stop claims, завершить bounded attempts, освободить lease без отправки или unknown для in-flight. Retention attempt logs 90 дней, inbox payload 7 дней, idempotency create keys минимум 7 дней; occurrence dedupe хранить весь срок жизни соответствующей повторной серии плюс год. Доменные задачи/аудит не удалять этим cleanup.

**Материалы защиты:** постановка задачи; роли/use cases; ER-диаграмма; архитектура модулей; OpenAPI; примеры транзакций и race tests; обоснование timestamptz/очереди; Flyway migrations; демонстрационный dataset; инструкция запуска на Windows/Linux; отчёт тестов; сценарий 10–15 минут. Показывать: авторизация → task CRUD → два конкурентных claim → встреча → отложенное сообщение → restart до due → журнал попыток. Mock Telegram явно подписать как mock.

**Готово:** другой человек с JDK/Docker запускает проект по README без ручной правки кода; тесты проходят; backup восстановлен на пустую БД; требования дисциплины сопоставлены с конкретными доказательствами, а не только screenshots CRUD.

### [ ] B-12 · После паритета: индивидуальные назначения задач

Отдельная продуктовая задача из ROADMAP, не обязательное условие первичного Java-переноса. Добавить individual assignment status/time/completedAt/comments, прогресс N/M; shared сохраняет текущую семантику. После первого ответа исполнителя assignmentMode неизменяем. Переоткрыть individual может его исполнитель или admin; coordinator задаёт новый срок отдельным изменением. Старые задачи всегда shared. Приёмка: один выполненный individual не завершает чужое назначение; агрегат task завершён только при выполнении всех обязательных активных назначений.

## 8. Условия завершения проекта

- [ ] Java реализует доменную логику, а не проксирует все операции в старый Node.
- [ ] PostgreSQL — единственный источник истины, миграции и реальные транзакции проверены.
- [ ] Все четыре роли и отрицательные сценарии SEC-01…05 защищены на сервере.
- [ ] Слоты/встречи/задачи/факультеты/профиль/уведомления покрыты parity-матрицей.
- [ ] Отложенные сообщения выполняют TIME-07, неопределённая доставка не маскируется как успех.
- [ ] Нет потери при конкурентных запросах и подтверждённом сохранении перед restart.
- [ ] Google/Telegram outages не откатывают доменную запись и не блокируют весь API.
- [ ] Учебный запуск, эксплуатация, миграция и откат описаны и воспроизведены отдельно.

Технические основания: [PostgreSQL SKIP LOCKED](https://www.postgresql.org/docs/17/sql-select.html), [типы date/time](https://www.postgresql.org/docs/17/datatype-datetime.html), [Telegram authentication](https://core.telegram.org/bots/webapps), [Bot API](https://core.telegram.org/bots/api). Архитектура, этапы, лимиты и политика хранения — проектные решения, которые проверяются тестами и эксплуатационными измерениями.
