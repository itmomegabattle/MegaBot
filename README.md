# MegaBot

## Учебный снимок: «Информационные системы», этап 1

Ветка `wonker/is-stage-1-java-postgresql` сохраняет весь текущий код, включая
Java-бэкенд (`backend/`), PostgreSQL-миграции V001…V042 и тесты.
[Предметная область, требования, прецеденты и будущая архитектура с учётом helios](docs/IS-STAGE-1-ARCHITECTURE.md).
Это учебный snapshot, не переключение production на Java; секретов и рабочих данных в нём нет.

MegaBot — Telegram-бот и Mini App для операционной работы команды ITMO MegaBattle. Он объединяет доступность команды, встречи, задачи, участников, факультетский контур и уведомления.

Приоритет владельца от 19.10.2026: ближайший выпуск готовится на действующем Node-приложении; Java/PostgreSQL отложены и не являются условием релиза. Только основной чат меняет код и запускает сборки, второй — read-only ревьюер по запросу. Production обновляется отдельной командой владельца. [Текущий релизный план и границы](docs/RELEASE-READINESS.md).

Production:

- бот: `@megaorgi_bot`;
- Mini App: <https://megaorgiabot.ru>;
- сервер: Selectel, `/opt/megabot`;
- ветка выпуска: `master`.

## Что есть в продукте

- слоты на 2–5 недель, состояния «Не смогу» и «Я в ауте», подбор лучшего времени;
- собрания, монтажи и вайбики с RSVP, уведомлениями и Google Calendar;
- назначенные, открытые и факультетские задачи, комментарии, напоминания и журнал;
- профили, аватары, роли, блоки, факультеты и командные рассылки;
- личный Telegram-интерфейс и команды в топиках группового чата;
- закрытая Google Sheets database и отдельная двусторонняя таблица доступности.

В текущем Node-выпуске подтверждённые изменения сначала попадают в локальный неизменяемый recovery journal, а затем реплицируются в Google Sheets. Production-каталог журнала должен находиться на постоянном диске; настройка и проверка ревизий описаны в [инструкции эксплуатации](docs/OPERATIONS.md).

## Технологии

Production использует стек ниже. В [`backend/`](backend/README.md) отдельно реализуется **Java 21 + Spring MVC + PostgreSQL 17**: доменные API и части очередей/интеграций уже проверяются локально, но полный паритет, импорт production-данных и переключение ещё не завершены. Этапы и доказательства находятся в [backend.md](backend.md).

- React 19, TypeScript, Vite и Tailwind CSS;
- Node.js и Express;
- Telegram Bot API через один выбранный transport: polling или защищённый webhook;
- Google Sheets API и Google Calendar API;
- esbuild, PM2 и Caddy.

## Локальный запуск

```bash
npm ci
npm run dev
```

Node закреплён в `.nvmrc` (22.23.1), npm — в `packageManager` (10.9.8); поддерживается также Node 24.18+. Локальная `.env` не хранится в Git. Разработку запускать с отдельными тестовыми данными и credentials, не с production-токеном/таблицами. Telegram-транспорт выбирается явно:

```env
TELEGRAM_UPDATE_MODE=disabled
```

Допустимы `polling`, `webhook` и `disabled`; старый `DISABLE_TELEGRAM_POLLING=true` поддерживается как совместимый вариант `disabled`. Отключение update-транспорта **не отключает** Google-синхронизации и `configureTelegramBotUi`, поэтому само по себе не делает запуск безопасным. Для webhook нужен отдельный `TELEGRAM_WEBHOOK_SECRET`; настройка выполняется CLI-командами из [инструкции эксплуатации](docs/OPERATIONS.md), а не публичным HTTP-маршрутом. Готовые `verify:*` используют fake API; для собственного стенда явно изолировать все интеграции. TypeScript проверяет явный список исходников и не захватывает dist/runtime/локальные инструменты.

Основные проверки:

```bash
npm run lint
npm run verify:core
npm run verify:avatar
npm run verify:sheets
npm run verify:database-sheets
npm run verify:calendar
npm run verify:docs
npm run verify:dependency-controls
npm run verify:ui
```

Локальный Java-контур запускается отдельно и не обращается к боевым Telegram/Google интеграциям. Инструкции, Compose PostgreSQL и ограничения находятся в [backend/README.md](backend/README.md).

## Документация

- [Продукт и пользовательские сценарии](docs/PRODUCT.md)
- [Архитектура, данные и интеграции](docs/ARCHITECTURE.md)
- [Деплой и эксплуатация](docs/OPERATIONS.md)
- [Дизайн-система и UX](docs/DESIGN.md)
- [Планы и открытые решения](docs/ROADMAP.md)
- [Подтверждённые проблемы и приёмка исправлений](todo.md)
- [План UI/UX без смены бренда](todo_design.md)
- [Перенос на Spring MVC и PostgreSQL](backend.md)

Аудит `3f91a42` от 21.09.2026 — исторический baseline, не описание сегодняшних дефектов. Справки обновлены 06.10.2026; планы различают закрытые пункты и незавершённые критерии. Node/UI RC выпущен на Selectel: [результаты и сохранность данных](docs/NODE-UI-RELEASE.md). Новые изменения зависимостей/CI этого прохода пока локальные, без повторного обновления production. Нативная мобильная приёмка остаётся отдельным gate D-12.
