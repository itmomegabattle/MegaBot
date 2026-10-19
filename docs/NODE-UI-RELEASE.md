# Ближайший Node/UI-релиз — 06.10.2026

**Новый локальный кандидат19.10.2026:** `3216e127482e-rc-6e0918f74395`, [состав, проверки и ограничения](RELEASE-READINESS.md). Он ещё не устанавливался в production; все фактические серверные результаты ниже относятся к прежним выпускам. Java/PostgreSQL отложены по новому решению владельца, не являются gate этого Node выпуска. Production — только отдельной командой владельца.

## Свободное расписание встреч — 07.10.2026

По команде владельца установлен `3216e127482e-rc-6665a14112d5`.
Собрания, монтажи и вайбики создаются и редактируются в любой день недели,
в любое время 00:00–23:59. Общая Node-проверка больше не связывает назначение
с настройками слотов; обе формы освобождены от min/max времени. Сохранены
валидация даты/времени, будущее начало, длительность, аудитория и права.
Ponytail full: удалены общие ограничения вместо отдельных исключений по видам;
новых зависимостей, схем или второго consumer нет. Java не входит в этот выпуск.

Lint, полный `verify:core`, Calendar и browser smoke прошли. Проверены все семь
дней и границы времени для трёх видов, API create/update в выходные в00:00/23:59,
обе формы и сохранение длительности, негативные даты/время/прошлое.
Первоначальные core logs сохраняют два прежних ожидания запрета ночи/выходного;
они заменены проверками некорректного24:00, повторный полный прогон успешен:
`output/free-schedule-core-verified.log`, `output/free-schedule-ui.log`,
`output/free-schedule-calendar.log`. Сверка production server sourcemap до
выпуска показала изменение только `src/meetingScheduling.ts`.

Архив `output/releases/megabot-3216e127482e-rc-6665a14112d5.tar.gz`, SHA256
`c149f61bdd6aa7443d59306b23be4296934ec794d42b4cae17263f5c2f73f1dc`.
Allowlist, внешние/внутренние суммы и staging production-only install проверены
до остановки единственного писателя. Backup
`/opt/megabot/backups/free-schedule-20261007-01` (700) содержит согласованную
пару Sheets/recovery167672, финальный runtime, sessions/panels, .env/PM2 и
previous-code. Runtime/.env/Sheets не заменялись; сохранены все поля34 встреч
и ID32 задач/30 пользователей/5 мероприятий. Local/public health200/ready,
точная revision, durable=replicated167672, pending=false, публичные JS/CSS
совпали по SHA256, PM2 save выполнен. Доказательство:
`output/free-schedule-production-final.log`.
В stderr остались существовавшие до выпуска ошибки setChatMenuButton400 и
очереди availability-export (mapping/429); новых типов ошибок не обнаружено.
Реальные тестовые встречи/рассылки ради smoke не создавались; нативная проверка
Telegram на телефоне остаётся ручной приёмкой.

Релиз не переключает приложение на Java/PostgreSQL. Рабочие бот, Sheets,
Calendar, `.env`, `database.json`, sessions и recovery остаются прежними.
Сервер обновляется **только после команды владельца**. Выпуск по этой команде
выполнен 06.10.2026; фактические результаты приведены в конце документа.
Не использовать прежний deploy-selectel.sh для
этого пакета: он пересобирает dist на месте и не возвращает старый bundle.

## Состав и локальные проверки

- Новый интерфейс из текущего Node checkout, адаптивные формы и общие токены.
- Длительность монтажа в создании и редактировании; выбранное значение
  сохраняется в уведомлении и Calendar, ограничения расписания сохранены.
- Читаемый синий текст в тёмной теме; бренд, шрифты, фон и порядок блоков сохранены.
- Java, новые Java-очереди и незавершённые функции B-08 не входят в пакет.

Сначала `npm run lint`, `npm run verify:core`, `npm run verify:calendar`.
Для UI: Vite preview на 127.0.0.1:15173 и Playwright CLI run-code с
`scripts/verify-setup-duration-ui.js`, затем `scripts/verify-release-ui.js`.
Все API браузерной проверки подменены синтетическими данными.
Эмуляция **не доказывает** работу клавиатуры и нативных date/time в Telegram.
Обязателен smoke на реальном телефоне до объявления выпуска окончательно принятым.

После проверок: `node scripts/package-node-release.mjs`.
Проверка распаковки/allowlist/всех сумм:
`node scripts/verify-node-release.mjs <путь-к-архиву.tar.gz>`.
Архив содержит только dist, package/lock, ecosystem, release.json и SHA256SUMS.
Внешняя `.sha256` проверяет архив; внутренние суммы проверяют каждый файл.
`revision` обозначает конкретный RC, а не чистый Git-коммит: локальные изменения
сейчас не закоммичены. Не пересобирать пакет на сервере.

## Подготовка на сервере после разрешения

1. Проверить свободное место (нужны новая и предыдущая копии dist/dependencies),
   версию Node не ниже используемой проектом, `pm2 describe megabot`, cwd
   `/opt/megabot` и единственный процесс. Не запускать второй polling consumer.
2. Загрузить архив и его `.sha256` в отдельный каталог `/opt/megabot/releases/`.
   Выполнить `sha256sum -c <имя-архива>.sha256` из этого каталога.
3. Распаковать в новый каталог staging. В staging выполнить
   `sha256sum -c SHA256SUMS`, затем `npm ci --omit=dev`. Это не затрагивает
   зависимости работающего приложения. Ошибка любого шага останавливает выпуск.
4. Сохранить `pm2 describe`, текущий `/api/health` и старый `APP_REVISION`.
   Проверить ready и очередь репликации: `pendingReplication=false`,
   durableRevision=replicatedRevision. Если очередь не сходится — не продолжать
   обычный выпуск. Исключение для исправления самой репликации: сначала отдельная
   диагностика, checksum-valid local journal и read-only Sheets snapshot/meta ready
   одной ревизии, полная сверка встреч и резервные копии. Несовпадение останавливает
   переключение; после исправления обязательны ready и отсутствие lag.
5. Выполнить проверенный `npm run db:sheets:backup` из /opt/megabot.
   Убедиться, что команда завершилась успешно и файл действительно создан.
6. Создать уникальный `/opt/megabot/backups/<release>-previous/` с правами 700.
   Скопировать `.env` с правами 600. Остановить `pm2 stop megabot` и убедиться,
   что процесса-писателя больше нет. Скопировать runtime JSON, sessions,
   chat-panels и весь recovery по **реальным путям из текущей конфигурации**.
   Не ограничиваться Google snapshot: локальный journal может быть новее.
7. Переместить старые `dist`, `node_modules`, `package.json`, `package-lock.json`
   и `ecosystem.config.cjs` в каталог previous. Переместить соответствующие
   новые файлы из staging в /opt/megabot. `.env` и runtime не заменять.
   При любой ошибке после остановки перейти к откату ниже.
8. Взять revision из release.json. С этим `APP_REVISION` выполнить
   `pm2 startOrReload ecosystem.config.cjs --update-env`. Проверить localhost
   `/api/health/ready`, `/api/health` и публичный health: HTTP 200 и точное
   совпадение revision. Проверить свежие PM2 logs. Затем `pm2 save`.
9. Открыть Mini App из Telegram: темы, пять разделов, профиль/admin, дата/время,
   длинные названия, клавиатура и доступность кнопки сохранения. Тестовую
   отправку разрешено делать только тестовым ботом согласованным аккаунтам;
   не создавать production-рассылки ради smoke.

При сбое не повторять перезапуск бесконечно и не запускать прежний deploy script.
Переключение недолгое, но выполняется с остановкой единственного писателя;
нулевого downtime этот выпуск не обещает.

## Текущий проверенный кандидат

- revision: `3216e127482e-rc-d991e56c051a`;
- архив: `output/releases/megabot-3216e127482e-rc-d991e56c051a.tar.gz`;
- SHA256: `4e21898d72fba65543e283a4e61d9932e9ad807c8f982b990bc291dabdb900ab`;
- полный единый Node `verify:core`: exit 0, `output/release-core-final.log`;
- lint, Calendar mock, detector и проверка архива: успешно;
- 24 сценария duration create/edit и 210 layout cases: успешно;
- на этапе подготовки сервер не затрагивался; фактический выпуск описан ниже.

## Откат кода, не данных

Остановить новый megabot. Сохранить неудачные dist/dependencies/config/package
в отдельный каталог диагностики, не удалять их. Вернуть все пять старых путей
из previous; запустить с сохранённым старым APP_REVISION, проверить localhost
и public health/revision, затем `pm2 save`.

**Не восстанавливать автоматически старую БД/Sheets/recovery:** после запуска
новой версии могли быть подтверждённые изменения. При фактическом выпуске
обнаружено, что старый Node поддерживает Sheets schema 8, а новый — 11.
Простой запуск старого bundle после новой репликации не является безопасным
откатом: сначала нужен совместимый импорт полного snapshot schema 11 и
отдельная проверка на копии свежих данных. Нельзя понижать meta/schema либо
подставлять старый snapshot только ради запуска старого кода. Если требуется восстановление
данных — остановка и отдельное решение владельца по OPS-02. Снимки previous
оставить до подтверждения работы. Эти серверные шаги и откат ещё не проверены
на настоящем VDS; окончательная эксплуатационная приёмка OPS-02 остаётся открытой.

## Фактический выпуск — 06.10.2026, 14:44 МСК

По команде владельца RC установлен и перезапущен на Selectel. Node 22.23.1,
единственный PM2-процесс `megabot`. Staging install и SHA256 прошли до остановки.
Перед остановкой сделаны raw Sheets backup, полный authenticated read-only
snapshot работающего процесса и штатные Sheets backups. После остановки
содержимое всех встреч в live/Sheets сравнено: полностью совпало. Live revision
167054 была на одну новее Sheets 167053; для сохранения последнего состояния
создан проверенный recovery record из живого snapshot, без восстановления
старых данных. После запуска durable/replicated revision=167054,
pendingReplication=false. Local/public health подтверждают RC.

После запуска отдельно проверены ID и все исходные поля 33 встреч, а также
ID 32 задач, 30 участников и 5 мероприятий. Удалений/сброса не выполнялось.
Бэкапы и старые dist/dependencies/config находятся в
`/opt/megabot/backups/release-20261006-rc/` (каталог 700).
`.env` сохранён; добавлен обязательный независимый SESSION_SECRET, права 600.
Старые session cookie не совместимы с новым реестром: открыть Mini App заново
из Telegram. Токен бота и идентификаторы интеграций не менялись.

При запуске один `setChatMenuButton` получил Telegram `user not found` для
старой привязки; polling и общий menu button работают. Это не потеря данных.
Ручная нативная приёмка владельцем остаётся открытой; OPS-02 целиком не закрыт.

## Мобильные исправления — 06.10.2026, 18:20 МСК

Установлен RC `3216e127482e-rc-1ff1bcc6e449`, архив
`output/releases/megabot-3216e127482e-rc-1ff1bcc6e449.tar.gz`, SHA256
`c44a5175b746d822cc72e310be674dbf891c0bf6b3405a59e5265dc1a9d68e94`.
Staging production-only npm ci и все внутренние суммы проверены до остановки.
Резервные копии raw Sheets, decoded snapshot, checksum-valid recovery,
PM2/.env, runtime после остановки и предыдущий schema-11 код находятся в
`/opt/megabot/backups/ui-hotfix-20261006/` (700; секреты 600).
Runtime и .env не заменялись, новые production-тестовые сообщения не отправлялись.
Сохранены все исходные поля 33 встреч и ID 32 задач, 30 участников, 5 мероприятий.
Проверка повторена после штатной Calendar синхронизации. Local/public health ready,
durable=replicated=167089, pendingReplication=false; PM2 save выполнен.
Публичные JS/CSS совпадают с установленными файлами по SHA256.

До переключения старый процесс повторял timeout окончательной snapshot batchUpdate
за 15 секунд, хотя read-only Sheets meta ready и полный snapshot уже совпадали с
local revision 167089. Для единственного большого запроса установлен ограниченный
45-секундный deadline; остальные запросы и обработка ошибок не ослаблены.
На остановке незавершённая репликация осталась в проверенном journal; новый процесс
прочитал ту же актуальную Sheets ревизию. Отдельная production-тестовая запись ради
проверки таймаута не выполнялась. Regression проверяет deadline и все четыре
шага ошибки экспорта (`output/ui-hotfix-core-final.log`).

UI: `output/ui-hotfix-browser-final.log` (210 layout, 24 duration, 12 hotfix cases),
`output/ui-hotfix-chrome-confirm.log` и `output/ui-hotfix-webkit-confirm.log`
(каждый 12 сочетаний ширины/темы). Проверены overflow нативных полей, отсутствие
галочек, порядок/default tabs, disclosure под списками, admin-only диагностика,
одна панель под строкой и DOM keyboard order. Все API синтетические; WebKit на
Windows не заменяет Telegram iOS с настоящей клавиатурой. D-12 остаётся открытым.
Ponytail/Impeccable использовали общие компоненты/CSS, без новых зависимостей.

Откат этого hotfix допускает возврат непосредственно предыдущего RC
`3216e127482e-rc-d991e56c051a`: оба используют schema 11. Это не разрешает откат
на более старый schema-8 bundle и не разрешает восстановление устаревших данных.
Свежие logs также содержат `user not found` старой menu-привязки и три ошибки
availability export «не найден пользователь в строках Sheets»; readiness и
snapshot не нарушены. Эти интеграционные предупреждения не выдаются за устранённые
этим мобильным исправлением и требуют отдельной проверки соответствий пользователей.

## Уточнения интерфейса и монтажа — 06.10.2026, 18:47 МСК

По повторному разрешению владельца установлен RC `3216e127482e-rc-ddda269a5f97`.
SHA256 архива `output/releases/megabot-3216e127482e-rc-ddda269a5f97.tar.gz`:
`60a619cb65b69848ef26daa294678ab95ae93b3ee255c9d8463d021893f05f96`.
Новый protected backup `/opt/megabot/backups/ui-refinement-20261006` содержит
paired ready Sheets/local recovery revision167093, runtime после остановки,
.env/PM2 и непосредственно предыдущий schema-11 bundle. Старые backups оставлены.
Node production-only staging install и внутренние/внешние SHA проверены до stop.
Все исходные поля33 встреч и ID32 задач/30 участников/5 мероприятий сохранены;
.env не изменён. Local/public ready, durable=replicated=167093, pending=false;
публичные JS/CSS совпали по SHA256, PM2 save выполнен. Новые production тестовые
сообщения не отправлялись. Java/V033 на сервер не устанавливались.

Изменения: аудитория слева в карточке; раскрытие shared списков без scroll jump;
монтаж1–12 целых часов вне часов слотов, с переходом через полночь; более явные
surface/control/text роли обеих тем и admin tabs. Бренд/шрифты/порядок блоков
сохранены. Node core и Calendar fake зелёные, Java focused13 без пропусков
(`backend/target/ui-refinement-java.log`), не полный verify. V033 сохраняет старые
строки, строгие ограничения действуют на новые/изменённые записи.
Browser evidence: `output/ui-refinement-duration-final.log`24 cases,
`output/ui-refinement-layout-final.log`210 cases, Chrome/WebKit
`output/ui-refinement-chrome-final.log` / `output/ui-refinement-webkit-final.log`
по12 сочетаний ширины/темы, включая mouse/Enter scroll stability и tab contrast.

## Метки встреч и удаление лишних действий — 06.10.2026

По новой команде владельца установлен `3216e127482e-rc-741e6702e63a`.
Архив `output/releases/megabot-3216e127482e-rc-741e6702e63a.tar.gz`, SHA256
`890235781bee01de359d2cde3ab23f4ac34bcf6bf90822acaa6db5091ca25003`.
Backup `/opt/megabot/backups/ui-badges-20261006`: paired ready Sheets/local
revision167102, все33 встречи, runtime после остановки, .env/PM2 и предыдущий
код. Runtime/.env не заменялись. Node/UI-only allowlist, все суммы и staging
production-only install проверены до остановки единственного писателя.
Удалены постоянное пояснение «Я в ауте» и «Сбросить ответ»; вид встречи слева,
аудитория по правому краю. Выбранный week-out статус и yes/no RSVP сохранены.
Ponytail/Impeccable: только общий JSX и regression, без новых зависимостей.
Lint/build, docs, detector и browser24 duration +210 layout +12 hotfix cases
зелёные (`output/ui-badges-browser.log`); API синтетические, native Telegram
по-прежнему требует проверки владельца. Java/БД-схема не изменялись.

## Компактный RSVP — 06.10.2026

### Устранение лимита Settings и выпуск компактных карточек

По отдельному разрешению владельца установлен `3216e127482e-rc-d4736e0e4143`.
SHA256 архива `431148c16904ff8173e008d3a887024a6f184e4bafdf50602a3cccac6ea2aa04`.
Settings JSON разбит на Unicode-safe части ≤30000 символов; проверка всех
ячеек выполняется до remote initialize/meta/clear. Legacy/domain fallback
читается, schema11 snapshot сохраняется. Lint, профильные boundary/Unicode/
roundtrip/no-mutation, полный core и browser smoke24+210+12 зелёные.
Логи: `output/sheets-repair-core.log`, `output/sheets-repair-ui-final.log`.
Node/UI allowlist/checksums и production-only staging install проверены до stop.
Backup `/opt/megabot/backups/sheets-repair-ui-20261006` содержит recovery,
raw незавершённых Sheets, .env/PM2, финальный runtime и previous-code.
При остановленном единственном писателе repaired export восстановил Sheets
из финальной durable167233, повторный import подтвердил полное равенство
всех данных. После старта health ready, durable=replicated=167233, pending=false;
все исходные поля33 встреч и ID32 задач/30 пользователей/5 мероприятий
сохранены, .env/runtime не заменены. Предыдущий candidate ea796 был только
подготовлен; этот выпуск включает его четыре UI-правки и persistence repair.
Ограничение: сетевой clear/write не атомарен; journal/retry остаются обязательны.
Откат к прежнему oversized writer не использовать как исправление причины:
он может вновь нарушить синхронизацию при обновлении состояния.

Следующий UI candidate `3216e127482e-rc-ea796e0fd181` подготовлен, но не установлен.
Архив SHA256 `efe37b6e5d11abba383fa27660e8982323e568f7f6a983ad524a7e403bf946bf`;
allowlist/checksums, lint/build/docs/detector и browser smoke прошли
(`output/ui-cleanup-browser-final.log`). Убраны «МСК» в карточках встреч,
selected-slot summary и положительный Telegram badge команды; три метки
монтажа размещены в общем ряду. Deploy gate заблокирован: текущий production
Sheets export отвечает400 (ячейка >50000 символов), local revision167233,
replicated167173. Read-only backup `/opt/megabot/backups/ui-cleanup-20261006`
содержит checksum-valid recovery и raw Sheets со sync_state=writing, не готовую
согласованную пару. Приложение не останавливалось, код/runtime/.env не менялись.
До выпуска нужно отдельно исправить сохранение oversized cells без потери
данных, получить ready paired backup и повторить безопасный release gate.

По команде владельца установлен `3216e127482e-rc-8a4a8a3f6cc0`: удалена только
строка «Ваш ответ» и отступ; кнопки, pressed и текущие ответы сохранены.
SHA256 архива `output/releases/megabot-3216e127482e-rc-8a4a8a3f6cc0.tar.gz`:
`7551a46ca00acf4280ea4fea334aa212d12434c9d558654a274b466f15096344`.
Staging в `/opt/megabot/backups/ui-rsvp-compact-20261006/staging` проверен по
суммам, production-only install завершён до stop. Первая активация отклонена
до остановки: во время браузерных тестов появились новые пользовательские
данные (167115→167118). Новая paired read-only копия Sheets/recovery167118 и
финальный runtime/previous code сохранены в
`/opt/megabot/backups/ui-rsvp-compact-20261006-refresh` (700). .env/runtime
не заменялись, устаревшие данные не восстанавливались.
Lint/build/docs/detector и browser24 duration +210 layout +12 hotfix cases
зелёные: `output/ui-rsvp-compact-browser-final.log`; отсутствие строки и yes/no
pressed проверены. Профильный scroll test ждёт загрузки шрифта и центрирует
кнопку, чтобы не мерить подготовительную автопрокрутку Playwright.
Native Telegram остаётся ручной приёмкой D-12; Java/API/БД-схема не менялись.
Ponytail: один validation/options/disclosure flow; Impeccable: семантические
цветовые роли вместо локальных палитр. Нативные Telegram/keyboard остаются D-12.
