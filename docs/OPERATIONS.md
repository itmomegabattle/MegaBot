# Деплой и эксплуатация

## Production

```text
Telegram / browser → https://megaorgiabot.ru → Caddy → 127.0.0.1:3000 → PM2 `megabot`
```

- хостинг: Selectel VDS, Ubuntu 24.04 LTS;
- сервер: `139.100.235.189`, 1 vCPU, 2 GB RAM, 25 GB NVMe;
- проект: `/opt/megabot`;
- процесс: PM2, один экземпляр, `dist/server.cjs`;
- домен и `www`: DNS Selectel, TLS выдаёт Caddy;
- репозиторий: `itmomegabattle/MegaBot`, ветка `master`.

Конфигурация reverse proxy находится в `/etc/caddy/Caddyfile`; целевой внешний доступ — `22`, `80`, `443`, а порт `3000` предназначен только для Caddy. Код слушает `0.0.0.0`, поэтому изоляция зависит от firewall. Параметры сервера приведены из прежней настройки; в повторном аудите 21.09.2026 firewall, доступность production и реальные бэкапы не проверялись.

## Штатный выпуск

Перед push локально:

```bash
npm run lint
npm run verify:core
```

Добавить профильные проверки для затронутой области: `verify:avatar`, `verify:sheets`, `verify:database-sheets` или `verify:calendar`.

На сервере:

```bash
cd /opt/megabot
git pull --ff-only origin master
bash scripts/deploy-selectel.sh
```

Скрипт:

1. сохраняет `.env` в `/opt/megabot/backups`;
2. выполняет `npm ci`, lint и production build, пока старая версия работает;
3. получает проверенный снимок Google Sheets database;
4. останавливает единственного писателя;
5. повторно проверяет снимок и при необходимости восстанавливает pre-stop backup;
6. запускает PM2 с `APP_REVISION` текущего коммита;
7. проверяет `/api/health` и совпадение ревизии.

Не заменять этот процесс простым `pm2 restart`: остановка во время полноснимочной записи может оставить незавершённый снимок.

**Ограничения текущего выпуска:** build заменяет dist на месте; аварийный trap запускает новый bundle, а не предыдущий, поэтому это не гарантированный rollback (OPS-02). Приложение обрабатывает SIGTERM/SIGINT: перестаёт принимать mutations и до 10 секунд ждёт репликацию Sheets; подтверждённая локальная ревизия уже находится в recovery journal. Health и диагностика показывают состояние очередей и интеграций, но подтверждённая отправка Telegram всё равно не означает прочтение сообщения пользователем.

Для переноса Java применять только [B-10](../backend.md), после release gates и эксплуатационной части B-11. Штатный Node deploy не умеет мигрировать PostgreSQL, менять транспорт Telegram или возвращать данные из Java обратно в Sheets. Автоматически запускать его для Java-релиза нельзя.

## Проверка после выпуска

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/api/health/live
curl -fsS http://127.0.0.1:3000/api/health/ready
curl -fsS https://megaorgiabot.ru/api/health
pm2 status megabot
pm2 logs megabot --lines 50 --nostream
npm run db:sheets:status
npm run calendar:check
```

Обе health-точки должны вернуть текущий commit SHA и состояние persistence. Для Sheets дождаться `pendingReplication=false` и равенства `durableRevision`/`replicatedRevision`; при недоступной Sheets сервис может работать из durable journal, но это должно быть явно видно. В логах учитывать timestamp: старые ошибки PM2 не означают ошибку нового выпуска.

После изменения Sheets выполнить:

```bash
npm run sheets:mapping
npm run sheets:roundtrip-test
```

После изменения Calendar:

```bash
npm run calendar:sync
```

Ручной smoke test выполняется на тестовой сущности и включает открытие Mini App из Telegram, сохранение целевого действия и проверку побочного уведомления. Не создавать тестовую массовую рассылку в production без необходимости.

`/api/health/live` используется для liveness и отвечает, пока жив процесс. `/api/health/ready` и совместимый `/api/health` возвращают `503`, если сервис завершает работу или durable-запись не гарантирована. `degraded` при `200` означает, что подтверждённые ревизии сохраняются локально, но Sheets replication отстаёт. Подробности доступны только администратору в «Команда → Состояние сервиса»; там видны очереди, возраст ожидания, последние успехи и очищенные ошибки. При обращении в логи передавать `X-Request-ID`; mutation дополнительно получает `X-Operation-ID`, а доставка связывается по `deliveryId`.

Проблемы Telegram-доставки проверяются администратором в разделе «Команда → Доставка сообщений». `retry` выполняется автоматически не раньше `availableAt`; `failed` и `unknown` требуют осознанного выбора и ручного повтора. Для `unknown` сначала проверить чат получателя: запрос мог быть принят Telegram до сетевого таймаута. Не повторять всю рассылку ради одного адресата. Перегрузка очереди показывается в Mini App; журнал не обрезает старые незавершённые записи.

Входящие updates сохраняются в `settings.telegramInbox` до webhook-ответа или повышения polling offset. После аварийного перезапуска worker автоматически продолжает `received/retry` и записи с истёкшим lease; завершённый `update_id` повторно не исполняется. При диагностике проверить рост inbox, `status`, `attempts`, `availableAt`, `leasedUntil` и `lastError`. Не удалять незавершённые записи вручную: восстановление и многопроцессная транзакционная реализация окончательно закрепляются в B-08.

## Переменные окружения

Файл: `/opt/megabot/.env`, права доступа должны быть ограничены. Основные группы:

```env
PORT=3000
TELEGRAM_BOT_TOKEN=...
TELEGRAM_API_BASE=https://api.telegram.org
TELEGRAM_UPDATE_MODE=polling
# TELEGRAM_WEBHOOK_SECRET=... # только для mode=webhook, отдельный случайный секрет
SESSION_SECRET=... # отдельный случайный секрет не короче 32 символов
SESSION_FILE=/opt/megabot/sessions.json
WEBAPP_URL=https://megaorgiabot.ru
ADMIN_TELEGRAM_IDS=...
ALLOW_LOCAL_PREVIEW=false

# Необязательно: значения ниже показаны как production defaults
AUTH_RATE_LIMIT_WINDOW_MS=300000
AUTH_RATE_LIMIT_IP_MAX=30
AUTH_RATE_LIMIT_USER_MAX=10
BROADCAST_RATE_LIMIT_WINDOW_MS=600000
BROADCAST_RATE_LIMIT_MAX=10
BROADCAST_VOLUME_WINDOW_MS=3600000
BROADCAST_VOLUME_MAX_RECIPIENTS=500

GOOGLE_SERVICE_ACCOUNT_FILE=/opt/megabot/secrets/google-service-account.json
GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID=...
GOOGLE_SHEETS_DATABASE_ENABLED=true
DATABASE_RECOVERY_DIR=/opt/megabot/recovery
DATABASE_RECOVERY_RETENTION=20

GOOGLE_SHEETS_SPREADSHEET_ID=...
GOOGLE_SHEETS_WEBHOOK_SECRET=...
GOOGLE_SHEETS_PRIMARY_SHEET_ID=1910422522
GOOGLE_SHEETS_PRIMARY_SHEET_TITLE=ОСНОВА
GOOGLE_SHEETS_TEMPLATE_SHEET_TITLE=ШАБЛОН НЕДЕЛИ

GOOGLE_CALENDAR_ID=...
GOOGLE_CALENDAR_ENABLED=true
GOOGLE_CALENDAR_TIME_ZONE=Europe/Moscow

BIRTHDAY_PAYMENT_PHONE=89105408050
BIRTHDAY_PAYMENT_BANK=Сбер
BIRTHDAY_GIFT_MAX_AMOUNT=400
BIRTHDAY_REMINDER_HOUR=10
# BACKGROUND_SCHEDULERS_ENABLED=true # default; false только для изолированного maintenance/test
```

`TELEGRAM_UPDATE_MODE` принимает ровно `polling`, `webhook` или `disabled`; одновременно работает только один транспорт. По умолчанию используется `polling`. Старый `DISABLE_TELEGRAM_POLLING=true` без нового параметра совместим с режимом `disabled`. Один токен нельзя одновременно получать двумя polling-процессами: Telegram вернёт `409 Conflict`.

`TELEGRAM_INBOX_POLL_INTERVAL_MS` задаёт период фоновой проверки durable inbox, по умолчанию 1000 мс и не менее 250 мс. Этот worker запускается независимо от `BACKGROUND_SCHEDULERS_ENABLED`, потому что отвечает за уже принятые Telegram updates.

`SESSION_SECRET` обязателен в production, не может совпадать с Telegram bot token и используется только для подписи непрозрачной session cookie. Реестр с правами `600` хранит только SHA-256 hash токена в `SESSION_FILE`; повторный вход отзывает прежнюю сессию пользователя, logout и деактивация пользователя удаляют её из реестра. Переход со старой cookie-схемы намеренно аннулирует все ранее выданные сессии: после выпуска пользователи должны заново открыть Mini App из Telegram.

`ALLOW_LOCAL_PREVIEW=true` разрешён только для локальной разработки: production-процесс с таким значением не запускается. Вход ограничен одновременно по IP и Telegram ID, рассылки — по actor, числу команд и суммарному числу получателей. При превышении API отвечает `429`, передаёт `Retry-After` и `retryAfterSeconds`; лимиты текущего Node-процесса намеренно являются временной защитой до переноса в общее хранилище.

`DATABASE_RECOVERY_DIR` обязателен для предсказуемой production-эксплуатации: это каталог на постоянном диске, доступный только пользователю процесса. По умолчанию используется `<DB_FILE>.recovery`, но production не должен размещать его во временной файловой системе. `DATABASE_RECOVERY_RETENTION` задаёт число неизменяемых ревизий, минимум фактически равен 2. Каталог нужно включить во внешнее резервное копирование вместе с `.env` и runtime-файлами.

Реестр `settings.idempotencyRecords` является частью основной БД и recovery snapshot. Он не очищается молча: при достижении 5000 уникальных ключей новые защищённые операции получают `503`, чтобы не потерять дедупликацию. До релиза необходимо мониторить размер реестра; перенос в PostgreSQL заменит этот временный предел политикой retention и уникальным индексом `(actor_id, key)`.

Часовой пояс продукта фиксирован как `Europe/Moscow`; TZ операционной системы не меняет смысл пользовательских дат. При этом точность instant зависит от системных часов. На VDS должен быть включён NTP/chrony: перед выпуском проверить `timedatectl status` и `chronyc tracking` (либо состояние используемого NTP-клиента). Значительное рассогласование часов является причиной остановить выпуск отложенных рассылок.

Все cookie-auth mutations в production требуют `Origin`, совпадающий с текущим host или origin из `WEBAPP_URL`. Запросы без Origin и с чужого origin получают 403. Ответы UI содержат CSP с локальными ресурсами и официальным `https://telegram.org` SDK; `frame-ancestors` разрешает Telegram Web. После production-выпуска проверить открытие Mini App в Telegram Desktop, Web, Android и iOS до расширения CSP.

Изменения задач используют optimistic version: клиент передаёт полученную `task.version`, stale-правка получает `409` и должна повторяться только после обновления состояния. Создание, редактирование, смена статуса и фоновые task reminders сохраняются до обращения к Telegram. `npm run verify:core` включает конкурентный сценарий с 20 созданиями, конфликтом версии и одновременной рассылкой.

В режиме `webhook` обязателен независимый `TELEGRAM_WEBHOOK_SECRET`; входящие запросы без заголовка `X-Telegram-Bot-Api-Secret-Token` не обрабатываются. Публичного HTTP-маршрута настройки webhook нет. Управление выполняется вручную из доверенного окружения:

```bash
npm run telegram:webhook:info
npm run telegram:webhook:set
npm run telegram:webhook:delete
```

Перед `telegram:webhook:set` установить `WEBAPP_URL` и `TELEGRAM_WEBHOOK_SECRET`, затем переключить приложение на `TELEGRAM_UPDATE_MODE=webhook`. Для возврата к polling сначала удалить webhook и убедиться, что запущен единственный consumer.

Токен, `initData`, оба webhook secret и JSON-ключ нельзя печатать в логах, коммитить или передавать в чат. Ключ сервисного аккаунта хранится в `/opt/megabot/secrets/google-service-account.json` с правами `600`.

Публичные идентификаторы текущих интеграций:

- пользовательская таблица доступности: `16sbBKwmrUm2b6n7nZG2UYyjBk-8IkUaGJqEd-nQwtWo`;
- закрытая таблица основной базы: `1R1MtYJfEuGNw0JI_laNmRk_Un7wIQwxt0xRYTp3mih4`;
- календарь: `b8ce7f1ecee245cd75d151392661008b9bd79fe498ee412692ad7ac9848b91e0@group.calendar.google.com`;
- сервисный аккаунт: `tg-megabot-sheets@tg-megabot.iam.gserviceaccount.com`.

Сервисному аккаунту нужны права редактора обеих таблиц и право Google Calendar `Make changes to events`. Публичный доступ к базе и календарю не требуется.

## Google Sheets: обслуживание

```bash
npm run sheets:list
npm run sheets:mapping
npm run sheets:backup
npm run sheets:prepare
npm run sheets:roundtrip-test
```

- `sheets:backup` заменяет единственную резервную вкладку `РЕЗЕРВ ОСНОВА`;
- `sheets:prepare` перестраивает даты, активные дни и часы только при изменении layout и восстанавливает checkbox validation;
- `sheets:migrate` нужен для первого перехода со старых недельных вкладок;
- `sheets:template` идемпотентно создаёт `ШАБЛОН НЕДЕЛИ` без использования его как рабочего источника.

Apps Script устанавливается в пользовательской таблице:

1. `Расширения` → `Apps Script`;
2. перенести `scripts/google-sheets-apps-script.gs` в `Code.gs`;
3. выполнить `setMegaBotWebhookSecret`;
4. выполнить `installMegaBotTrigger` и подтвердить разрешения;
5. убедиться, что установлен триггер `sendMegaBotEdit` «При изменении».

## Основная база и восстановление

Успешный mutation означает, что его ревизия уже записана и синхронизирована на диск в `DATABASE_RECOVERY_DIR`; это не обещание, что Google Sheets успела обновиться. В `/api/health`:

- `durableRevision` — последняя подтверждённая приложением ревизия;
- `replicatedRevision` — последняя успешно записанная в Sheets ревизия;
- `pendingReplication` — есть ожидающая или выполняющаяся выгрузка.

После перезапуска приложение сравнивает проверенный локальный journal с согласованным Sheets snapshot и выбирает более новую ревизию. Повреждённая последняя запись журнала пропускается в пользу предыдущей с корректной checksum. Не удалять каталог recovery до проверки, что Sheets имеет ту же или более новую ревизию.

Проверка и ручная копия:

```bash
npm run db:sheets:check
npm run db:sheets:status
npm run db:sheets:backup
```

Аварийное восстановление выполняется только при остановленном боте:

```bash
pm2 stop megabot
npm run db:sheets:restore -- /opt/megabot/backups/google-sheets-database-TIMESTAMP.json --confirm
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
```

Чистый запуск сезона сохраняет команду, Telegram-привязки, роли, факультеты, компетенции и настройки, но удаляет операционные мероприятия, встречи, задачи, слоты, сообщения и audit log. Это разрушительная операция, допустимая только после отдельной подтверждённой резервной копии:

```bash
pm2 stop megabot
npm run db:sheets:reset -- --confirm
bash scripts/deploy-selectel.sh
```

## Диагностика

```bash
systemctl status caddy
systemctl status pm2-root
pm2 status
df -h
free -h
ufw status
curl -I https://megaorgiabot.ru
```

Типовые случаи:

- `409` от Telegram — второй процесс использует тот же polling-токен;
- временный `500/503` Google — не сбрасывать данные, дождаться очереди повтора и проверить согласованный snapshot;
- health сообщает старую ревизию — production bundle не обновлён или PM2 запущен без `--update-env`;
- новая Mini App не видна — проверить hash файла в `dist/assets`, HTML с `no-store` и параметр версии в Telegram Web App URL;
- `user not found` / `user is deactivated` при настройке menu button относится к старой Telegram-привязке конкретного пользователя, а не к остановке всего бота.
