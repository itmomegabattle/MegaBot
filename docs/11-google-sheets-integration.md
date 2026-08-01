# Интеграция Google Sheets

## Принятые правила

- основной лист на этапе подключения: `Основа с 30 до 5`;
- пользователь связывается со строкой через Telegram ID, первичное сопоставление выполняется по нормализованному ФИО;
- номер строки не сохраняется: строки перечитываются, поэтому сортировка, добавление и удаление людей не сдвигают чужие данные;
- при конфликте побеждает последнее подтверждённое изменение;
- граница недели: понедельник, 00:00, `Europe/Moscow`;
- истёкшие недели удаляются из оперативной доступности без архива;
- приложение показывает минимум две недели, администратор может настроить от двух до пяти и отправить уведомление команде;
- Apps Script отправляет изменения таблицы сразу, сервер дополнительно сверяется с таблицей каждую минуту.

## Секреты на Selectel

Ключ service account не хранится в Git и не должен лежать в рабочем дереве `/opt/megabot` под отслеживаемым именем.

С локального компьютера:

```bash
scp /local/path/google-key.json root@139.100.235.189:/tmp/megabot-google-key.json
```

На сервере:

```bash
cd /opt/megabot
sudo bash scripts/install-google-sheets-secret.sh /tmp/megabot-google-key.json
rm /tmp/megabot-google-key.json
openssl rand -hex 32
```

Последняя команда создаёт секрет для подписи webhook. Его нужно сохранить и в `.env`, и в свойствах Apps Script.

Добавить в `/opt/megabot/.env`:

```env
GOOGLE_SHEETS_SPREADSHEET_ID=16sbBKwmrUm2b6n7nZG2UYyjBk-8IkUaGJqEd-nQwtWo
GOOGLE_SERVICE_ACCOUNT_FILE=/opt/megabot/secrets/google-service-account.json
GOOGLE_SHEETS_WEBHOOK_SECRET=длинная_случайная_строка_из_openssl
GOOGLE_SHEETS_PRIMARY_SHEET_TITLE=Основа с 30 до 5
GOOGLE_SHEETS_PRIMARY_SHEET_ID=432131861
GOOGLE_SHEETS_TEMPLATE_SHEET_TITLE=ШАБЛОН НЕДЕЛИ
GOOGLE_SHEETS_SCAN_RANGE=A1:BZ200
```

`GOOGLE_SHEETS_PRIMARY_SHEET_ID` является основной привязкой. Поэтому лист можно переименовать без поломки синхронизации.

Проверить права:

```bash
stat -c '%a %U:%G %n' /opt/megabot/secrets/google-service-account.json
```

Ожидаемые права: `600`. После `git pull` файл останется на сервере, потому что Git его не отслеживает.

## Установка Apps Script

1. Открыть таблицу.
2. Выбрать `Расширения` → `Apps Script`.
3. Скопировать содержимое `scripts/google-sheets-apps-script.gs` в `Code.gs`.
4. Сохранить проект.
5. Запустить функцию `setMegaBotWebhookSecret` и вставить значение `GOOGLE_SHEETS_WEBHOOK_SECRET`.
6. Запустить `installMegaBotTrigger`.
7. Подтвердить разрешения Google.
8. В разделе `Триггеры` должен появиться устанавливаемый триггер `sendMegaBotEdit` с событием `При изменении`.

Простой `onEdit` намеренно не используется: устанавливаемому триггеру разрешён `UrlFetchApp`, необходимый для HTTPS-запроса к серверу.

## Пустой шаблон

Административный endpoint `POST /api/integrations/google-sheets/template` копирует основной лист целиком и создаёт лист `ШАБЛОН НЕДЕЛИ`. Затем очищаются только ячейки временных слотов сопоставленных участников; размеры, цвета, границы, объединения, формулы и остальное оформление сохраняются.

Endpoint идемпотентен: если шаблон уже существует, второй лист не создаётся.

## Сопоставление людей

Администратор может получить отчёт:

```text
GET /api/integrations/google-sheets/mapping
```

Отчёт содержит строку таблицы, имя в таблице, имя в приложении и Telegram ID. В автоматическое сопоставление попадают только точные совпадения после безопасной нормализации: регистр, `ё/е`, порядок имени и фамилии, лишние пробелы и знаки препинания не влияют.

Неоднозначные и отсутствующие совпадения не записываются автоматически.

## Проверка после деплоя

```bash
cd /opt/megabot
npm install
npm run build
pm2 restart megabot --update-env
pm2 logs megabot --lines 100
curl http://127.0.0.1:3000/api/health
```

В `/api/health` должно быть:

```json
"googleSheetsConfigured": true
```

После этого изменить один слот тестового администратора в таблице, открыть Mini App и проверить изменение. Затем изменить слот в Mini App и убедиться, что чекбокс таблицы обновился.
