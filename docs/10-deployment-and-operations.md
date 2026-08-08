# Деплой и эксплуатация

Дата снимка: **5 августа 2026 года**.

Документ описывает фактический запуск MegaBot в интернете: где он хостится, как домен попадает на сервер, как Telegram открывает Mini App и что нужно делать при обновлении.

## Коротко

Продакшен сейчас работает так:

`Telegram → https://megaorgiabot.ru → Caddy → Node/Express на 127.0.0.1 ↔ Google Sheets database`.

Telegram-бот: `@megaorgi_bot`.

Mini App URL: `https://megaorgiabot.ru`.

GitHub-репозиторий: `itmomegabattle/MegaBot`.

## Сервер

Хостинг: Selectel VDS.

Параметры текущего сервера:

- имя: `MegaBot`;
- регион: Санкт-Петербург, `ru-3b`;
- ОС: Ubuntu 24.04 LTS;
- конфигурация: `1 vCPU`, `2 GB RAM`, `25 GB NVMe`;
- публичный IP: `139.100.235.189`;
- путь проекта: `/opt/megabot`.

Этого достаточно для небольшого бота и Mini App примерно на 100 пользователей, если нет тяжёлой аналитики, больших файлов и частых массовых рассылок.

## Домен и DNS

Домен: `megaorgiabot.ru`.

Домен делегирован на DNS Selectel:

```text
a.ns.selectel.ru
b.ns.selectel.ru
c.ns.selectel.ru
d.ns.selectel.ru
```

В DNS-зоне настроены записи:

```text
megaorgiabot.ru      A   139.100.235.189
www.megaorgiabot.ru  A   139.100.235.189
```

Проверка DNS:

```bash
dig megaorgiabot.ru +short
dig NS megaorgiabot.ru +short
```

Ожидаемо:

```text
139.100.235.189
a.ns.selectel.ru.
b.ns.selectel.ru.
c.ns.selectel.ru.
d.ns.selectel.ru.
```

Если `dig` ничего не возвращает, проблема обычно не в приложении, а в делегировании домена или ожидании обновления DNS-кэша. Обновление может занимать от нескольких минут до 72 часов.

## HTTPS и Caddy

На сервере установлен Caddy. Он принимает публичные запросы на `80` и `443`, автоматически получает TLS-сертификат и проксирует приложение на локальный порт `3000`.

Конфигурация находится в `/etc/caddy/Caddyfile`.

Ожидаемая схема:

```caddy
megaorgiabot.ru {
  reverse_proxy 127.0.0.1:3000
}

www.megaorgiabot.ru {
  redir https://megaorgiabot.ru{uri}
}
```

Проверка:

```bash
systemctl status caddy
curl -I https://megaorgiabot.ru
```

Ответ `HTTP/2 200`, `403` или другой ответ от Express означает, что DNS и Caddy дошли до приложения. Ошибка `Could not resolve host` означает, что DNS ещё не работает. Ошибка подключения к `443` означает проблему с Caddy, firewall или сервером.

## Node-приложение

Приложение запускается одним Node-процессом:

- Express API;
- раздача Mini App;
- Telegram long polling;
- фоновые проверки напоминаний;
- работа с Google Sheets базой и очередью согласованных снимков.

Порт приложения по умолчанию: `3000`.

Текущий процесс управляется PM2:

```bash
pm2 status
pm2 logs megabot --lines 50
```

Процесс `megabot` запускает собранный `dist/server.cjs` через `ecosystem.config.cjs`. Штатное обновление:

```bash
bash scripts/deploy-selectel.sh
```

Скрипт сам выполняет сборку, резервное копирование базы, PM2 reload и health-check.
Health-check также сравнивает поле `revision` с текущим `git rev-parse HEAD`, поэтому старый `dist` больше не может быть принят за успешный деплой. HTML Mini App отдаётся с `Cache-Control: no-store`, а версионированные файлы из `dist/assets` — как immutable.

## Telegram-интеграция

Telegram Bot API используется в режиме long polling. При старте сервер:

1. читает токен из `.env`;
2. удаляет старый webhook через `deleteWebhook`;
3. настраивает команды и кнопку Mini App через Bot API;
4. запускает цикл `getUpdates`;
5. каждый update отправляет во внутренний обработчик `/api/telegram-webhook`.

Важное ограничение: один Telegram-бот не может одновременно обрабатываться двумя long polling процессами. Если локальный компьютер и сервер запущены с одним токеном без отключения polling, появится ошибка `409 Conflict`.

Для локальной проверки Mini App без конфликта с продом:

```env
DISABLE_TELEGRAM_POLLING=true
```

## Переменные окружения

На сервере файл окружения лежит здесь:

```bash
/opt/megabot/.env
```

В нём должны быть:

```env
TELEGRAM_BOT_TOKEN=секретный_токен_бота
WEBAPP_URL=https://megaorgiabot.ru
TELEGRAM_API_BASE=https://api.telegram.org
ADMIN_USERNAMES=@wonkersone
ADMIN_TELEGRAM_IDS=658274366
```

Дополнительно могут использоваться:

```env
PORT=3000
DISABLE_TELEGRAM_POLLING=true
BIRTHDAY_PAYMENT_PHONE=89105408050
BIRTHDAY_PAYMENT_BANK=Т-Банк
BIRTHDAY_GIFT_MAX_AMOUNT=400
HTTP_PROXY=
HTTPS_PROXY=
GOOGLE_SHEETS_SPREADSHEET_ID=
GOOGLE_SERVICE_ACCOUNT_FILE=/opt/megabot/secrets/google-service-account.json
GOOGLE_SHEETS_WEBHOOK_SECRET=
GOOGLE_SHEETS_PRIMARY_SHEET_TITLE=ОСНОВА
GOOGLE_SHEETS_PRIMARY_SHEET_ID=432131861
GOOGLE_SHEETS_TEMPLATE_SHEET_TITLE=ШАБЛОН НЕДЕЛИ
GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID=1R1MtYJfEuGNw0JI_laNmRk_Un7wIQwxt0xRYTp3mih4
GOOGLE_SHEETS_DATABASE_ENABLED=true
GOOGLE_CALENDAR_ID=b8ce7f1ecee245cd75d151392661008b9bd79fe498ee412692ad7ac9848b91e0@group.calendar.google.com
GOOGLE_CALENDAR_ENABLED=true
GOOGLE_CALENDAR_TIME_ZONE=Europe/Moscow
```

Токен бота нельзя коммитить, отправлять в публичные чаты и вставлять в документацию.
JSON-ключ Google также нельзя коммитить. Он хранится в `/opt/megabot/secrets/` с правами `600`; порядок установки описан в [документе интеграции Google Sheets](./11-google-sheets-integration.md).

## Данные

Текущая база данных — отдельная закрытая Google-таблица. Проверка:

```bash
npm run db:sheets:status
npm run calendar:check
```

В нём хранится операционное состояние:

- пользователи и Telegram ID;
- роли и регистрация;
- факультеты и компетенции;
- слоты доступности;
- встречи;
- задачи и бэклог;
- сообщения и служебные записи уведомлений;
- настройки.

Перед любым рискованным обновлением нужно сделать проверенную копию:

```bash
npm run db:sheets:backup
```

Резервные снимки создаются в `/opt/megabot/backups` с правами `600`. Production-процесс не читает и не записывает `database.json`.

## Обновление проекта на сервере

Стандартная последовательность:

```bash
cd /opt/megabot
git pull --ff-only origin master
bash scripts/deploy-selectel.sh
pm2 logs megabot --lines 50 --nostream
```

Проверить сайт:

```bash
curl -I https://megaorgiabot.ru
curl http://127.0.0.1:3000/api/state
```

Проверить Telegram:

1. написать `/start` боту;
2. открыть Mini App кнопкой `Открыть`;
3. проверить, что профиль узнаётся;
4. создать тестовую задачу или встречу;
5. убедиться, что пришло уведомление.

Если менялась команда PM2 или окружение:

```bash
pm2 save
systemctl status pm2-root
```

## Локальная разработка

Локально проект запускается из корня репозитория:

```bash
npm install
npm run dev
```

Чтобы локальный запуск не конфликтовал с серверным ботом, в локальном `.env` нужно поставить:

```env
DISABLE_TELEGRAM_POLLING=true
```

Если нужно проверить именно Telegram polling локально, продакшен-процесс на сервере на это время надо остановить, иначе Telegram вернёт `409 Conflict`.

## Firewall

На сервере открыт минимум:

- `22/tcp` для SSH;
- `80/tcp` для HTTP и выпуска сертификатов;
- `443/tcp` для HTTPS.

Проверка:

```bash
ufw status
```

Порт `3000` не должен быть публичной точкой входа. Он нужен Caddy только внутри сервера.

## Минимальный чек-лист здоровья

Раз в несколько дней или перед важным мероприятием:

```bash
systemctl status caddy
pm2 status
pm2 logs megabot --lines 50
df -h
free -h
curl -I https://megaorgiabot.ru
```

В Telegram проверить:

- бот отвечает на `/start`;
- кнопка `Открыть` открывает Mini App;
- пользователь видит свой профиль;
- уведомления о задачах и встречах доходят хотя бы на тестовом сценарии.

## Что ещё не доведено до промышленного уровня

- нет отдельной транзакционной БД;
- нет автоматического расписания резервных копий;
- нет очереди уведомлений с журналом доставки;
- нет централизованных логов и алертов;
- серверный код всё ещё монолитный;
- production-запуск через собранный `dist/server.cjs` нужно проверить и включить отдельно;
- администрирование сервера пока завязано на root-доступ, лучше перейти на SSH-ключи и отдельного пользователя.

Эти пункты не блокируют маленький пилот, но их нужно закрывать до активного сезона, когда бот станет ежедневным инструментом команды.

## Изменения эксплуатации — 2026-08-03

`DISABLE_TELEGRAM_POLLING=true` отключает только получение обновлений через polling. Настройка команд, описания бота, общей кнопки `Начать` и персональных menu buttons выполняется независимо при каждом старте процесса. Это важно для webhook-конфигурации production.

Production URL фиксирован как `https://megaorgiabot.ru`. Если в `WEBAPP_URL` случайно остался `lhr.life`, `loca.lt`, ngrok, localtunnel или trycloudflare, сервер игнорирует его и использует постоянный домен.

Рекомендуемый выпуск:

```bash
cd /opt/megabot
git pull origin master
bash scripts/deploy-selectel.sh
npm run sheets:roundtrip-test
pm2 logs megabot --lines 50 --nostream
```

После старта проверить `/api/health`, кнопку `Начать`, один полный сценарий слотов и отсутствие растущей `pendingSheetExports`. Следующее улучшение эксплуатации — health-поля с длиной очереди и временем последней успешной Google-сверки, плюс алерт при ненулевой очереди дольше заданного SLA.

## Отдельная Google-таблица как база данных

Настройка, резервное копирование и production-reset описаны в `docs/12-google-sheets-database-migration.md`. В production флаг `GOOGLE_SHEETS_DATABASE_ENABLED` должен быть `true`.

После включения `/api/health` должен показывать:

```json
{
  "googleSheetsDatabaseConfigured": true,
  "googleSheetsDatabaseEnabled": true
}
```
