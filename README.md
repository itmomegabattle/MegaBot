# MegaBot

MegaBot — Telegram-бот и Mini App для операционной работы команды ITMO MegaBattle. Он объединяет доступность команды, встречи, задачи, участников, факультетский контур и уведомления.

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

Production пока использует стек ниже. Отдельный каркас **Java 21 + Spring MVC + PostgreSQL 17** уже создан в [`backend/`](backend/README.md), но бизнес-функции, миграции данных и production-переключение ещё не выполнены. Этапы и критерии находятся в [backend.md](backend.md).

- React 19, TypeScript, Vite и Tailwind CSS;
- Node.js и Express;
- Telegram Bot API через один выбранный transport: polling или защищённый webhook;
- Google Sheets API и Google Calendar API;
- esbuild, PM2 и Caddy.

## Локальный запуск

```bash
npm install
npm run dev
```

Локальная `.env` не хранится в Git. Разработку запускать с отдельными тестовыми данными и credentials, не с production-токеном/таблицами. Telegram-транспорт выбирается явно:

```env
TELEGRAM_UPDATE_MODE=disabled
```

Допустимы `polling`, `webhook` и `disabled`; старый `DISABLE_TELEGRAM_POLLING=true` поддерживается как совместимый вариант `disabled`. Отключение update-транспорта **не отключает** Google-синхронизации и `configureTelegramBotUi`, поэтому само по себе не делает запуск безопасным. Для webhook нужен отдельный `TELEGRAM_WEBHOOK_SECRET`; настройка выполняется CLI-командами из [инструкции эксплуатации](docs/OPERATIONS.md), а не публичным HTTP-маршрутом. Готовые `verify:*` используют fake API; для собственного стенда явно изолировать все интеграции. Lint и build пока выполнять последовательно: текущий TypeScript config захватывает dist (DEBT-02).

Основные проверки:

```bash
npm run lint
npm run verify:core
npm run verify:avatar
npm run verify:sheets
npm run verify:database-sheets
npm run verify:calendar
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

Повторный аудит кода `3f91a42` выполнен 21 сентября 2026 года. Справки `docs/` описывают действующее поведение с известными ограничениями; три рабочих плана — будущие изменения, а не выполненные функции. `docs/ROADMAP.md` связывает их без дублирования. Production и реальные мобильные клиенты в этом проходе не проверялись. История решений — в Git; аудит не доказывает отсутствие всех возможных ошибок.
