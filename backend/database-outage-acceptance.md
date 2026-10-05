# B-07 / TIME-07: потеря связи с PostgreSQL

`DeliveryDatabaseOutageIntegrationTests` приостанавливает **собственный disposable PostgreSQL 17.11 Testcontainer** через Docker pause. Запросы к настоящей БД перестают получать ответы и завершаются сетевым timeout; исключение JDBC не подменяется mock. После unpause используются обычные DeliveryQueue/DeliveryQuota/BroadcastDispatcher и сохранённые строки той же БД.

Production, локальная live-test БД и другие Docker-контейнеры не участвуют. Telegram заменён транспортом, считающим подтверждённые вызовы; никаких реальных сообщений или токенов. Контекст отделён от остальных suites уникальными test properties и закрывается после класса. Контейнер обязательно размораживается в finally / AfterEach, в том числе после неуспешной проверки.

## Сценарии

- Outage до claim: bounded ошибка, ноль HTTP и attempts; исходное planned намерение остаётся. После восстановления следующая обычная итерация отправляет его один раз, сбрасывает worker error/failure count; повторный проход пуст.
- Outage после claim, до start: ошибка не фиксирует sending/attempt. После истечения lease задание возвращается planned; старый token не может начать HTTP, новый worker отправляет один раз.
- Outage после принятия fake провайдером, до записи sent: delivery и attempt остаются sending, не выдаются за доставленные. Recovery после lease переводит оба в unknown с `lease_expired_after_start`, без автоматического повтора. Другая уже подтверждённая доставка и её message ID сохраняются и не отправляются снова.
- Истёкшая за время сбоя grace: восстановление переводит исходное planned в expired; ноль HTTP/attempts, позднего replay нет.

Для скорости **только в этой тестовой БД** сдвигаются lease/expiry timestamps: не ждём 30 секунд/15 минут. Сам обрыв связи настоящий; системные часы и DB clock не заменяются. PostgreSQL остаётся тем же процессом после pause: это проверка недоступности сети/БД, а не crash/restart PostgreSQL или отключение диска.

## Воспроизведение и границы

05.10.2026 полный `mvnw.cmd --batch-mode verify`: **326 tests, 0 failures/errors/skipped, BUILD SUCCESS** (4 outage-сценария + прежние 322), 2:08 min. Лог `target/database-outage-final-verify.log`. Новая suite — 4 tests без ошибок, 9.041 s. До этого целевой прогон первых трёх сценариев также зелёный; это не замена финального полного verify.

Из `backend/`: `mvnw.cmd --batch-mode -Dtest=DeliveryDatabaseOutageIntegrationTests test` либо полный `mvnw.cmd --batch-mode verify` при работающем Docker.

JDBC socket/connect timeout=1 s, pool connection timeout=1 s и maximum pool=2 заданы **только в тестовом контексте**, чтобы контролируемый outage ограниченно завершался (проверка <10 s). Это не обещание production recovery time и не изменение production timeout. После unpause пул заново получает рабочие соединения.

Ponytail full: переиспользованы установленный Testcontainers/Docker client, существующий Spring-контекст и штатные queue/worker gates. Новых зависимостей, миграций, очередей и production-кода не потребовалось.

Process/crash worker JVM теперь отдельно проверен: [process-crash-acceptance.md](process-crash-acceptance.md). Остаток TIME-07/B-07: полная приёмочная матрица, VDS/NTP/SLO и внешние alarms, прочие открытые критерии плана; отдельные локальные блоки не закрывают весь этап.
