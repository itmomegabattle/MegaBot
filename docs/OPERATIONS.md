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

Конфигурация reverse proxy находится в `/etc/caddy/Caddyfile`; публично открыты `22`, `80` и `443`, а порт `3000` предназначен только для Caddy на сервере.

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

## Проверка после выпуска

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS https://megaorgiabot.ru/api/health
pm2 status megabot
pm2 logs megabot --lines 50 --nostream
npm run db:sheets:status
npm run calendar:check
```

Обе health-точки должны вернуть текущий commit SHA и включённые интеграции. В логах учитывать timestamp: старые ошибки PM2 не означают ошибку нового выпуска.

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

## Переменные окружения

Файл: `/opt/megabot/.env`, права доступа должны быть ограничены. Основные группы:

```env
PORT=3000
TELEGRAM_BOT_TOKEN=...
TELEGRAM_API_BASE=https://api.telegram.org
WEBAPP_URL=https://megaorgiabot.ru
ADMIN_USERNAMES=...
ADMIN_TELEGRAM_IDS=...

GOOGLE_SERVICE_ACCOUNT_FILE=/opt/megabot/secrets/google-service-account.json
GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID=...
GOOGLE_SHEETS_DATABASE_ENABLED=true

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
```

`DISABLE_TELEGRAM_POLLING=true` применяется только для локальной разработки или специального режима. Один токен нельзя одновременно получать двумя polling-процессами: Telegram вернёт `409 Conflict`.

Токен, webhook secret и JSON-ключ нельзя печатать в логах, коммитить или передавать в чат. Ключ сервисного аккаунта хранится в `/opt/megabot/secrets/google-service-account.json` с правами `600`.

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
