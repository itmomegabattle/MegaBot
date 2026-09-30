# MegaBot backend

Новый backend создаётся как модульный монолит на Java 21, Spring MVC и PostgreSQL 17. До этапа B-10 он не является production-писателем и не использует боевые Telegram/Google credentials.

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

1. Скопировать `.env.example` в `.env` внутри `backend/` или передать значения окружением. Не коммитить `.env`.
2. Из корня выполнить `docker compose up -d db`.
3. На Windows выполнить `mvnw.cmd spring-boot:run -Dspring-boot.run.profiles=local`, на Unix — `./mvnw spring-boot:run -Dspring-boot.run.profiles=local`.
4. Проверить `/actuator/health/liveness` и `/actuator/health/readiness`.

Для сборки app-контейнера: `docker compose --profile app up --build`. PostgreSQL и HTTP опубликованы только на `127.0.0.1`. Named volume `megabot-postgres-data` сохраняет локальную БД между перезапусками. Изменение init credentials не применяется к уже созданному volume.

## Проверки

- `mvnw.cmd verify` — Java tests и Testcontainers PostgreSQL;
- `npm run lint && npm run build` из корня — существующий frontend/Node;
- CI выполняет обе группы независимо.

Локальный и test-профили принудительно требуют `fake` для Telegram и Google. Реализованные бизнес-endpoints сохраняют доменные данные и задания интеграций; внешняя сеть в HTTP-транзакции не вызывается.

## Схема данных

Flyway-миграции `V001`–`V005` разделены на identity/settings, availability/meetings, tasks, messaging/integrations и migration tracking. Hibernate не создаёт и не обновляет схему: в каждом профиле действует `ddl-auto=validate`.

`OutboxWriter` требует уже открытую доменную транзакцию (`Propagation.MANDATORY`). Поэтому событие невозможно случайно зафиксировать отдельно от изменения агрегата; worker и внешняя отправка добавляются только на B-07.

## Авторизация

`POST /api/v1/auth/telegram` принимает только исходную строку Telegram `initData`. Identity из дополнительных JSON-полей игнорируется: ID, username и имя извлекаются после HMAC-проверки, TTL 5 минут и допуска будущего времени 30 секунд. Неизвестный Telegram ID получает отказ; первичная привязка возможна только к одному заранее добавленному активному профилю с совпавшим username. Bootstrap admin задаётся только числовыми ID в `ADMIN_TELEGRAM_IDS`.

## Team, events and dated availability

`/api/v1/profile`, `/team`, `/users` и `/events` используют серверную роль из сессии и optimistic `version`. Деактивация сохраняет историю, запрещает удаление последнего администратора, блокируется при будущих встречах или незавершённых назначениях и отзывает активные сессии.

`GET /api/v1/availability` строит горизонт от календарного понедельника в `Europe/Moscow`. `PUT /api/v1/availability/weeks/{weekStart}` заменяет только одну неделю и проверяет её собственную версию; отсутствующая новая неделя возвращается пустой. Метаданные недели привязаны к дате понедельника, а `outOfWeek`, `unavailable` и `unanswered` остаются разными состояниями.

Компетенции разделены на `core` и `faculty`; участнику нельзя назначить компетенцию чужого контура. Один факультетский пользователь состоит максимум в одном факультете. Справочники выводятся из использования через `active=false`, поэтому старые ссылки не удаляются. `/api/v1/availability/suggestions` возвращает до пяти лучших окон и причины отсутствия каждого человека.

Создающие endpoints требуют `Idempotency-Key` из 8–128 безопасных символов. Ключ scoped по подтверждённому actor и операции: точный повтор возвращает сохранённый ответ с `Idempotency-Replayed: true`, а другое тело получает `409`. Изменения B-04 записываются в `audit_events` внутри доменной транзакции.

Временный `GET /api/state` сохраняет форму текущего `SimulationState`, но собирается из PostgreSQL и не раскрывает Telegram ID, год рождения коллеги, внутренние настройки и чужие сообщения. Он доступен только основной команде. Встречи уже читаются из PostgreSQL; `tasks` останется пустым до B-06. Факультет получает только собственный профиль через `/api/faculty/me`.

## Встречи и RSVP

`/api/v1/meetings` хранит начало как точный `Instant` и фиксирует `Europe/Moscow` как проектную зону. Обычная встреча и монтаж должны попадать в активные дни и часы доступности; монтаж всегда длится 60 минут, требует активное мероприятие и приглашает всю основную команду. `vibe` допускает любой день, время и переход через полночь. Фаза `ongoing/upcoming/past/cancelled` вычисляется по фактическому окончанию.

Аудитория фиксируется snapshot-списком при создании и пересчитывается только при явном изменении встречи. Каждый приглашённый начинает с `unanswered`; повтор того же RSVP является no-op. Создание, изменение и отмена атомарно записывают встречу, audit, outbox-событие с текущими `chat_id/message_thread_id` важных топиков и версионированное задание Google Calendar. Фактическая отправка и Calendar API относятся к B-07/B-08 и никогда не вызываются внутри HTTP-транзакции.

Сессия — случайный 256-bit opaque token. В PostgreSQL хранится только SHA-256 hash; повторный вход отзывает прежние сессии пользователя. Cookie имеет `HttpOnly`, `Secure`, `SameSite=Lax`. Защищённые mutations требуют точный same-origin `Origin` либо origin из `MEGABOT_ALLOWED_ORIGINS`. Local/test интеграции остаются fake.

## Baseline паритета

Ядро задач доступно через `/api/v1/tasks`: CRUD деталей, shared claim/release, статусы, отмена, append-only комментарии и история. `/api/v1/faculty/my-tasks` проверяет одновременно faculty membership и собственное назначение. Правила переходов, пагинация и оставшаяся часть B-06: [tasks.md](tasks.md). До реализации compatibility DTO задачи в старом `/api/state` остаются пустыми.

- Полная матрица текущих HTTP-маршрутов: [parity-matrix.md](parity-matrix.md).
- Обезличенные transport-independent fixtures: `src/test/resources/parity/`.
- Telegram-команды/callbacks и матрица уведомлений остаются обязательной частью B-08 из `backend.md`; HTTP CRUD не считается их заменой.
