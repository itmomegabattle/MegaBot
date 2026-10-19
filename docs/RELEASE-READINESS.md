# Ближайший релиз действующего приложения

Решение владельца19.10.2026: один чат меняет код и запускает проверки; второй выполняет только read-only ревью законченных блоков по запросу. Цель двухнедельного обновления — действующее Node-приложение, без ожидания Java/PostgreSQL. Регистрацию и развитие МФ обсудим после готовности ближайшего безопасного пакета: требования ещё не утверждены, реализации новых функций в этот пакет нет. Никакого обновления production без отдельной команды владельца.

## Текущий короткий план

1. Завершить уже запущенную Java проверку, сохранить код/логи/точку остановки и не подключать незавершённый faculty dialog.
2. Зафиксировать границы Node build/runtime/package/CI, проверить недоступность отложенных API и интерфейса планирования рассылок.
3. Проверить Node core, права четырёх ролей, интеграционные mocks и интерфейс; собрать локальный пакет, сверить состав и суммы, передать законченный блок второму чату на ревью.
4. Сообщить владельцу, когда пакет готов к решению о выпуске, с оставшимися ручными gates. Затем обсудить новые функции. Не считать старый общий план44/67 процентом готовности этого релиза.

## Что остаётся вне выпуска

- Весь `backend/`, Java/PostgreSQL, V042 и внутренний черновик смены статуса факультетских задач. Его Telegram handler/source binding/current-panel guards и actual process recovery не реализованы; действующий Node-поток остаётся прежним.
- Миграционные staging/preflight/projection/seal/apply, их CLI, SQL и экспериментальные скрипты. Никакой смены источника данных, env, очередей, транспорта или единственного production-писателя.
- Java durable broadcast scheduling/retry/history. Node DTO явно возвращает `durableBroadcasts:false`, независимо от входного снимка; `/api/v1` возвращает404, а не успешную HTML-страницу. Действующая немедленная Node-рассылка сохраняется.
- Нереализованные B-12, CHAT-02/CHAT-01, новая регистрация/новый МФ и неподтверждённые критерии из трёх планов. Уже работающие факультетские задачи и права не удаляются.

Неполный пункт в плане сам по себе не означает, что уже работающий участок надо отключать. Для этого выпуска не добавляются кнопки или обещания незавершённых функций, а известные ограничения DATA-04/нативной приёмки остаются явно указанными в своих планах.

## Проверяемые границы

- `npm run build` собирает Vite UI и `server.ts`; TypeScript исключает `backend`, `dist`, output и временные каталоги.
- Автоматический CI проверяет Node; сохранённый Java job запускается только вручную через `workflow_dispatch` с `verify_java:true`. Java failure не является автоматическим условием Node релиза; это не отмена Java проверок при будущем возобновлении переноса.
- Упаковка и проверка архива используют одну положительную политику файлов: только Node entrypoint/map, HTML, JS/CSS assets, бренд SVG, WOFF2, package/lock/ecosystem и release/checksums. JAR/SQL/env/runtime JSON/миграционные scripts и неизвестные файлы внутри dist отклоняются. Карта исходников server bundle разрешает только server.ts и src TypeScript; backend и scripts запрещены.
- Негативные fixtures и текущая сборка проверяются `npm run verify:release-boundary`; фактический архив отдельно проверяет `scripts/verify-node-release.mjs`.

## Локальный кандидат — 19.10.2026

Пакет `3216e127482e-rc-6e0918f74395`:

- [Архив](../output/releases/megabot-3216e127482e-rc-6e0918f74395.tar.gz), SHA256 `b58e74c7d95a5f93fe1a1e3dfe8fe3ca2612b4023de73d816065907a79a40866`;19 записей, состав/все payload checksums/обязательные файлы проверены. Лог `output/node-release-isolation-archive.log`.
- `lint` и полный Node `verify:core`: exit0, `output/node-release-isolation-lint-final.log`, `output/node-release-isolation-core.log`. Включены реальные локальные HTTP проверки четырёх ролей, explicit false capability даже при true в synthetic database, JSON404 deferred API, auth/security/конкурентные mutation/recovery.
- Calendar, primary Sheets, database Sheets, broadcast client, avatar mocks: exit0, `output/node-release-isolation-mocks.log`. Реальные Google/Telegram операции не выполнялись.
- Playwright browser smoke: exit0,24 duration +210 responsive-layout +12 hotfix checks, `output/node-release-isolation-ui.log`, подробности `output/playwright/*-ci.log`. Synthetic APIs, локальный preview.
- Чистая установка только production зависимостей в отдельной копии:86 packages, exit0; запуск readiness/drift/write-failure проверки:exit0. `output/node-release-isolation-prod-install-final.log`, `output/node-release-isolation-prod-smoke.log`. Первый offline install получил ENOTCACHED, после обычной установки по lock gate пройден; исходная неудача сохранена отдельно.
- `verify:release-boundary`, docs9 и diff-check прошли. Шесть actual CLI negative archives с пересчитанными внешними SHA отклонены: missing/duplicate checksum, extra allowed file, forbidden JAR, hardlink до extraction, missing package с удалённой checksum строкой. `output/node-release-isolation-archive-negative.log`.
- Второй чат выполнил read-only review: два замечания к archive type/полноте checksums исправлены; новых concrete blockers после повторного просмотра не найдено. Ревью не заменяет перечисленные тесты.

Кандидат готов локально к решению владельца о выпуске. Production не обновлялся. Нативный Telegram/телефон и smoke после реального развёртывания не выполнялись: прежний D-12 manual gate остаётся открытым, окончательная production-приёмка не заявляется. Для ручного выпуска и отката использовать [процедуру Node релиза](NODE-UI-RELEASE.md), а не старый source-checkout deploy script.

Все уже сделанные Java/Node изменения сохраняются в общем dirty checkout; никакого массового reset/очистки. Последняя уже запущенная Java проверка завершена:679/0/0/0, BUILD SUCCESS12:07,68 XML suites/JAR60 509 486 байт сверены. [Точка остановки](../backend/telegram-task-read.md); незавершённый faculty dialog не подключён, будущие Java работы отложены. Общий старый план остаётся44/67 (65.7%; todo30/42, design10/12, backend4/13), он не был искусственно закрыт ради готовности Node пакета.
