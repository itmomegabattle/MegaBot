# Production-хранилище MegaBot

Основная база MegaBot находится в отдельной закрытой Google-таблице. Таблица доступности с листом `ОСНОВА` остаётся отдельным пользовательским интерфейсом расписания.

## Доступ и секреты

Сервисный аккаунт MegaBot должен оставаться редактором базы. Публичный доступ не требуется. JSON-ключ сервисного аккаунта хранится только на Selectel с правами `600` и не добавляется в Git.

```env
GOOGLE_SERVICE_ACCOUNT_FILE=/opt/megabot/secrets/google-service-account.json
GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID=1R1MtYJfEuGNw0JI_laNmRk_Un7wIQwxt0xRYTp3mih4
GOOGLE_SHEETS_DATABASE_ENABLED=true
```

## Структура

База использует 16 листов:

- `meta` — версия схемы, ревизия и состояние снимка;
- `snapshot` — полный снимок для точного восстановления;
- `events`, `users`, `faculties`;
- `availability_weeks`, `availability_slots`;
- `meetings`, `meeting_participants`;
- `tasks`, `task_assignees`, `task_comments`, `task_reminders`;
- `bot_messages`, `settings`;
- `audit_log` — журнал выгрузок.

Production-процесс загружает только полный согласованный снимок со статусом `ready`, очищает его по актуальной модели и держит рабочую копию в памяти. Изменения объединяются в очередь записи Google Sheets. `database.json` не является production-хранилищем.

## Проверка и резервная копия

```bash
npm run db:sheets:check
npm run db:sheets:status
npm run db:sheets:backup
```

Резервные снимки создаются в `/opt/megabot/backups` с правами `600`. Deployment-скрипт автоматически выполняет `db:sheets:backup` до перезапуска приложения.

## Чистый запуск сезона

Команда сброса сохраняет пользователей, Telegram-привязки, роли, факультеты, компетенции и настройки. Она удаляет мероприятия, задачи, исполнителей, комментарии, напоминания, встречи, RSVP, слоты доступности, историю внутренних сообщений и старый audit log. Перед изменением создаётся полный резервный снимок.

Сброс разрешён только при остановленном боте и с явным подтверждением:

```bash
pm2 stop megabot
npm run db:sheets:reset -- --confirm
bash scripts/deploy-selectel.sh
```

После сброса команда архивирует старые `database.json` и transient-файлы из корня проекта, если они существуют. Удалять резервные копии сразу после запуска сезона не следует.
