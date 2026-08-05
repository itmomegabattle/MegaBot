# Деплой и эксплуатация

Дата снимка: **1 августа 2026 года**.

Документ описывает фактический запуск MegaBot в интернете: где он хостится, как домен попадает на сервер, как Telegram открывает Mini App и что нужно делать при обновлении.

## Коротко

Продакшен сейчас работает так:

`Telegram → https://megaorgiabot.ru → Caddy → Node/Express на 127.0.0.1:3000 → database.json`.

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
- работа с JSON-БД.

Порт приложения по умолчанию: `3000`.

Текущий процесс управляется PM2:

```bash
pm2 status
pm2 logs megabot --lines 50
```

Сейчас процесс `megabot` запускается командой `npm run dev`, то есть `tsx server.ts`. Это рабочий вариант для быстрого раннего запуска. Для более строгого production-режима лучше перейти на:

```bash
npm run build
pm2 start npm --name megabot -- run start
pm2 save
```

Перед переходом нужно проверить, что `npm run start` корректно обслуживает Mini App и Telegram polling.

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
DB_FILE=/opt/megabot/database.json
DISABLE_TELEGRAM_POLLING=true
BIRTHDAY_PAYMENT_PHONE=
BIRTHDAY_PAYMENT_BANK=
HTTP_PROXY=
HTTPS_PROXY=
GOOGLE_SHEETS_SPREADSHEET_ID=
GOOGLE_SERVICE_ACCOUNT_FILE=/opt/megabot/secrets/google-service-account.json
GOOGLE_SHEETS_WEBHOOK_SECRET=
GOOGLE_SHEETS_PRIMARY_SHEET_TITLE=ОСНОВА
GOOGLE_SHEETS_PRIMARY_SHEET_ID=432131861
GOOGLE_SHEETS_TEMPLATE_SHEET_TITLE=ШАБЛОН НЕДЕЛИ
```

Токен бота нельзя коммитить, отправлять в публичные чаты и вставлять в документацию.
JSON-ключ Google также нельзя коммитить. Он хранится в `/opt/megabot/secrets/` с правами `600`; порядок установки описан в [документе интеграции Google Sheets](./11-google-sheets-integration.md).

## Данные

Текущая база данных — файл:

```bash
/opt/megabot/database.json
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

Перед любым рискованным обновлением нужно сделать копию:

```bash
cd /opt/megabot
cp database.json "database.backup.$(date +%F-%H%M%S).json"
```

Минимальная регулярная резервная копия:

```bash
mkdir -p /opt/megabot/backups
cp /opt/megabot/database.json "/opt/megabot/backups/database.$(date +%F-%H%M%S).json"
```

Долгосрочно лучше перейти на PostgreSQL или хотя бы SQLite с миграциями. JSON-файл проще, но хуже переживает конкурентные записи, ручные правки и рост истории.

## Обновление проекта на сервере

Стандартная последовательность:

```bash
cd /opt/megabot
cp database.json "database.backup.$(date +%F-%H%M%S).json"
git pull
npm install
npm run build
pm2 restart megabot
pm2 logs megabot --lines 50
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

Настройка и безопасная миграция описаны в `docs/12-google-sheets-database-migration.md`. До первого успешного `db:sheets:migrate` флаг `GOOGLE_SHEETS_DATABASE_ENABLED` должен оставаться `false`. Команда миграции сама создаёт резервную копию JSON и выполняет обратное чтение со сверкой связанных сущностей.

После включения `/api/health` должен показывать:

```json
{
  "googleSheetsDatabaseConfigured": true,
  "googleSheetsDatabaseEnabled": true
}
```
