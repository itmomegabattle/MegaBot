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

## Технологии

- React 19, TypeScript, Vite и Tailwind CSS;
- Node.js и Express;
- Telegram Bot API через long polling;
- Google Sheets API и Google Calendar API;
- esbuild, PM2 и Caddy.

## Локальный запуск

```bash
npm install
npm run dev
```

Локальная `.env` не хранится в Git. При работе с production-токеном обязательно отключить получение Telegram updates, чтобы не получить конфликт двух polling-процессов:

```env
DISABLE_TELEGRAM_POLLING=true
```

Основные проверки:

```bash
npm run lint
npm run verify:core
npm run verify:avatar
npm run verify:sheets
npm run verify:database-sheets
npm run verify:calendar
```

## Документация

- [Продукт и пользовательские сценарии](docs/PRODUCT.md)
- [Архитектура, данные и интеграции](docs/ARCHITECTURE.md)
- [Деплой и эксплуатация](docs/OPERATIONS.md)
- [Дизайн-система и UX](docs/DESIGN.md)
- [Планы и открытые решения](docs/ROADMAP.md)

Документы описывают состояние репозитория на 13 сентября 2026 года. История прежних решений доступна в Git; датированные дописки не должны накапливаться в актуальной документации.
