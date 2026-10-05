# B-07 / TIME-07: аварийное завершение worker JVM

`DeliveryProcessCrashIntegrationTests` запускает дочерние JVM с настоящим Spring-приложением, штатными DeliveryQueue/DeliveryQuota/BroadcastDispatcher и одной disposable PostgreSQL Testcontainers. `Process.destroyForcibly()` завершает только процесс, созданный этим тестом, после наблюдаемого барьера. Shutdown hooks не заменяют crash recovery. Процессы пользователя, production и live-test БД/бот не участвуют.

## Сценарии и критерии

- После COMMIT claim, до start: после kill остаётся `claimed`, попыток нет. Recovery истёкшего lease возвращает задание в очередь; старый token не может начать или завершить отправку. Новый процесс отправляет один раз; ещё один процесс не повторяет `sent`.
- После принятия запроса подставным провайдером, до возврата ответа/фиксации результата: дочерний dispatcher блокируется внутри fake transport и затем уничтожается. Сохранённые delivery/attempt остаются `sending`; recovery делает `unknown`. Новый процесс не отправляет unknown автоматически. Другой, ранее подтверждённый адресат и его provider message ID сохраняются.
- Перезапуск до due: первый процесс делает пустой проход и уничтожается, новый процесс также не отправляет будущую запись. `intended_at`, состояние `planned` и отсутствие attempts сохраняются. Это проверка сохранности и запрета раннего старта, не измерение доставки через час.

Сокращение lease deadline выполняется SQL **только над строкой тестовой БД**, чтобы не ждать реальные 30 секунд. Kill JVM настоящий; системные/DB часы не переводятся. PostgreSQL не перезапускается и диск не отключается. Приёмку аварии сервера/VDS, NTP и реального Telegram response loss этот тест не заменяет.

## Безопасность и воспроизведение

Дочернему процессу передаются URL/credentials исключительно контейнера текущего теста. Окружение очищено от токенов, production-конфигурации и JVM option injection; CLI явно задаёт profile=test, delivery disabled, Telegram/Google fake, пустой bot token, loopback и случайный HTTP port. Отправка выполняется вручную существующим dispatcher с подставным транспортом; никакого Telegram HTTP-клиента нет. Fake transport разрешает единственный синтетический chat ID 5101.

Барьер/выход ограничены timeout; `finally` завершает только ещё живой дочерний процесс и ждёт его выхода. Java argfile обходит ограничение длины Windows command line без shell и дополнительных зависимостей. Временные argfiles/логи принадлежат JUnit TempDir; диагностический вывод при отказе включён в assertion.

Из `backend/` при работающем Docker: `mvnw.cmd --batch-mode -Dtest=DeliveryProcessCrashIntegrationTests test`. Общий regression: `mvnw.cmd --batch-mode verify`. Docker-skipped suite не является приёмкой.

05.10.2026 focused прогон: **3 tests, 0 failures/errors/skipped, BUILD SUCCESS**, log `target/process-crash-test.log`. После добавления проверки ненулевого crash exit code, отказа stale finish и согласованного нового birthday hour полный verify: **370 tests, 0 failures/errors/skipped, BUILD SUCCESS**, log `target/process-crash-birthday-final-verify.log`. В нём crash suite — 3 tests/348.7 s; весь build — 18:30 min на загруженном Windows-стенде. Это длительность тестового запуска приложений, не latency доставки, RTO или SLO. Maven heap ограничен 256 MB (`MAVEN_OPTS=-Xmx256m`), test fork 512 MB (`-DargLine=-Xmx512m`), каждый child 256 MB; настройки production JVM не менялись. Предыдущий общий прогон `target/process-crash-final-verify.log` прерван после решения владельца изменить birthday hour и не считается успешным verify.

Ponytail full: использованы установленный Testcontainers, стандартные ProcessBuilder/argfile и существующие доменные сервисы. Production-код, зависимости, миграции и очередь не менялись. B-07/TIME-07 остаются открытыми до полной матрицы и эксплуатационных проверок.
