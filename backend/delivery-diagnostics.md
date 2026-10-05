# Диагностика отправок: B-07 / TIME-06

`GET /api/v1/admin/delivery-diagnostics` — read-only снимок для действующей admin-сессии. Organizer/faculty получают 403, запрос без сессии — 401. Ответ не кэшируется. Здесь только агрегаты: никаких chat/recipient/operation IDs, payload, Telegram token, lease token и сырых ошибок.

## Значения

- `databaseNow`: UTC-время PostgreSQL, общее для SQL-снимка. `windowHours`: 24.
- `queue`: количества сохранённых delivery rows по состояниям, включая retry/failed/unknown. Это текущие состояния всех сохранённых строк, не накопительные counters за сутки.
- `due`: planned/retry, без cancel_requested, меньше восьми попыток, intended_at и available_at уже наступили, expiry не истёк. Не означает, что domain gate или quota разрешат сеть. Считаются все категории, даже ещё не подключённые к sender, чтобы незавершённая очередь не скрывалась.
- `oldestDueAgeSeconds`: максимальный возраст от текущего available_at среди таких due строк. Backoff не выдаётся за простой готового задания; при отсутствии due — null. Intended-at задержка измеряется отдельно.
- `staleLeases`: claimed/sending с истёкшей арендой. Диагностика сама не восстанавливает их и не меняет статусы.
- `timings`: попытки с started_at в последние 24 часа по часам БД. First-start lateness p50/p95/p99/max = started_at − intended_at только для attempt_number=1, в миллисекундах. Повторы не смешиваются с первой отправкой. Ранние попытки учитываются отдельно; отрицательные значения не скрываются обнулением.
- `attemptDurationP95Ms`: finished_at − started_at завершённых попыток из того же окна. Это длительность обработки попытки до фиксации результата, не чистое сетевое время Telegram и не время push. В частности, unknown после recovery может включать ожидание аренды.
- `databasePool`: текущие active/idle/total/awaiting/max Hikari; включает соединение запроса диагностики. Если доступного Hikari pool нет — null, не фиктивное отсутствие нагрузки.
- `worker`: прогресс отправителя только в текущем процессе приложения, по application UTC Clock. LastCycleStartedAt/lastCycleCompletedAt — реальные границы прохода recovery → planners → claim → попытка/idle; lastOutcome — idle/processed/error, consecutiveFailures — число последовательных незавершённых успешно проходов, сбрасывается при успехе. Никакие тексты исключений сюда не попадают. `processed` не означает успешную доставку: cancelled/deferred/unknown тоже могут завершить проход нормально.

### Статус worker

`disabled` — bean отсутствует, sender не включён; timestamps null, отсутствие не выдаётся за зависание. `starting` — lifecycle начался, проход ещё не завершён. `healthy` — недавно завершился нормальный проход, включая пустую очередь. `error` — последний проход выбросил runtime exception; scheduler продолжает следующие попытки. `stalled` — с последнего завершения (или запуска lifecycle до первого завершения) прошло больше 30 секунд. Новый start прохода сам по себе не продлевает успешный heartbeat: зависший SQL не выглядит здоровым. `stopping`/`stopped` отражают lifecycle и оставшуюся работу. `clock_uncertain` — application clock оказался раньше контрольной отметки; его нельзя трактовать как подтверждение здоровья.

`workInProgress` — занятость bounded lifecycle worker, не размер очереди. Чтение диагностики не обновляет heartbeat. Состояние хранится в памяти и сбрасывается при запуске lifecycle, не является историей рестартов. Остановка процесса целиком делает API недоступным: нужен внешний health probe/monitoring, не локальное поле. Queue DB-clock и application worker clock не смешиваются; NTP offset этим не измеряется.

Если образцов нет, процентили — null. Percentiles включают backlog, quota и ошибки: ими нельзя доказывать целевой SLO для здоровой сети без rate limit. Начало attempt фиксируется до HTTP, поэтому это измерение границы очереди, а не независимый датчик момента вызова Telegram.

## Ограничения и безопасность

### Сигналы для мониторинга (05.10.2026)

`signals` — вычисленные из того же снимка пары `code`/`severity`, без второго SQL, фоновой задачи, новых зависимостей или реальных уведомлений. Пустой массив **не означает подтверждённое здоровье**: NTP, сеть Telegram и push по-прежнему не измерены. Поле не меняет readiness и не включает sender.

| Code | Условие | Severity |
| --- | --- | --- |
| worker_stalled | worker state = stalled (>30 s без завершения) | critical |
| worker_clock_uncertain | application clock раньше контрольной отметки | warning |
| worker_error | последний проход завершился runtime error | warning |
| due_backlog_quota_unverified | due >0 и oldestDueAgeSeconds >10, строго | warning |
| stale_leases | staleLeases >0 | warning |
| unknown_outcomes | сохранённые unknown >0 | warning |
| early_attempts | ранние starts в окне 24 часа >0 | critical |
| database_pool_waiters | Hikari awaiting >0 | warning |

Backlog — повод разобраться, **не доказательство аварии при нормальной квоте**: снимок не проверяет квоту, поддержку категории и доменную допустимость. Нельзя автоматически объявлять worker stalled по одному возрасту очереди. Disabled/starting/stopping/stopped сами по себе не авария; backlog при disabled всё равно виден. Awaiting — моментный показатель, не доказательство продолжительной saturation. Unknown хранится до ручного разрешения; ранние starts остаются в окне 24 часа. Они не должны порождать повторное сообщение при каждом опросе. Сигналы не повторяют unknown и не восстанавливают lease.

На согласованном тестовом VDS внешний монитор должен отдельно контролировать доступность процесса/БД и NTP offset >500 ms; хранить состояние сигналов, уведомлять при появлении/изменении и снятии, применять debounce для моментных warnings. Опрос admin endpoint — только с действующей защищённой сессией, без записи cookie в журнал, не чаще одного раза в 30 s для этого scan. 401/403 означает ошибку доступа монитора, 503/timeout — недоступную диагностику, не пустые/здоровые сигналы. Истёкшая сессия требует обновления; долгоживущий monitoring credential пока не реализован. Внешний канал уведомлений и реальные alarm-drills ещё не подключены; это локальные сигналы, не завершённая эксплуатационная приёмка TIME-06.

Ponytail: один существующий SQL-снимок и доступ к уже установленному Hikari, без новых зависимостей, миграций, очереди метрик и фонового сборщика. Агрегатный scan запускается только по запросу; PostgreSQL statement timeout — 3 секунды, действует локально в read-only транзакции. При ошибке БД/таймауте — безопасный 503 `delivery_diagnostics_unavailable`, а не нулевые «здоровые» показатели. Ожидание получения соединения ограничивается существующей конфигурацией пула, не этим SQL timeout. Не опрашивать часто; при измеренном росте таблиц потребуются индексы/rollups и retention из B-11.

`notMeasured` перечисляет ntpClockOffset и devicePushLatency. Локальный worker progress/heartbeat и advisory signals реализованы. Отдельный [delivery-load-report.md](delivery-load-report.md) измеряет engine/DB/quota на 1000 paced + 1000 burst заданиях с fake transport и scheduler burst на 1000 адресатах; это не live Telegram/VDS/SLO. Настоящие локальные crash/restart проверки описаны в [process-crash-acceptance.md](process-crash-acceptance.md). Внешние monitoring/alarms, NTP и VDS/SLO ещё нужны. Диагностический тест с 1000 сохранёнными образцами проверяет формулы, а не пропускную способность отправителя. TIME-06 и B-07 остаются открытыми. Production-сеть не включается этим endpoint.

## Проверено 04.10.2026

Дополнение 05.10.2026: **18 targeted tests, 0 failures/errors/skipped, BUILD SUCCESS**, log `target/diagnostic-signals-test.log`: четыре новых проверки signals (границы, независимость, recovery, отсутствие побочных изменений/null pool), шесть HTTP/PostgreSQL диагностических сценариев с проверкой сериализации signals и безопасного admin-only ответа, семь worker regressions и OpenAPI parsing/references. Команда: `mvnw.cmd --batch-mode -DargLine=-Xmx512m -Dtest=DeliveryDiagnosticSignalsTests,DeliveryDiagnosticsIntegrationTests,WorkerProgressTests,OpenApiContractTests test`. Это целевой прогон read-only изменения, не повторение полного verify. Только disposable PostgreSQL, без Telegram.

После worker progress полный verify — **200 tests, 0 failures/errors/skipped, BUILD SUCCESS** (5 новых + прежние 195). Проверены граница 30s/clock rollback, blocked cycle/bounded wakeup, runtime failure/recovery, idle/stopped, secret-free status и disabled HTTP response. Log `target/worker-progress-verify.log`. Тесты использовали injectable Clock, latch и подставной transport, без production Telegram.

Полный `mvnw.cmd --batch-mode verify` на PostgreSQL 17.11: **195 tests, 0 failures/errors/skipped, BUILD SUCCESS**. Шесть новых диагностических сценариев, автоматический parsing/local-reference test OpenAPI и прежние 188 прошли вместе. Проверены текущая admin-роль, безопасные агрегаты/no-store, empty/null, due/lease exclusions, percentiles на 1000 записанных образцах, retry/24-hour/early-attempt разделение и safe 503. OpenAPI: 65 paths. Log `target/diagnostics-verify.log`; production не использовался.
