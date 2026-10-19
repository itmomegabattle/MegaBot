# B-07: штатный scheduler без quota deferral

Дата: 08.10.2026. Локальный стенд Windows / Java21 / Testcontainers PostgreSQL;
transport fake, production и реальный Telegram не используются.

## Воспроизведение

Из `backend/` при свободном согласованном Maven/Docker окне:

```powershell
./mvnw.cmd --batch-mode '-DargLine=-Xmx512m' '-Dtest=BroadcastDispatcherIntegrationTests,DeliveryQueueIntegrationTests,DeliveryLoadIT#lifecyclePacedThousandMeasuresLatenessWithoutQuotaDeferral' test
```

Используется существующий `DeliveryLoadIT`, штатные dispatcher/DB/quota и
Spring `@Scheduled(fixedDelay=500)` с bounded drain. 1000 разных адресатов,
интервал intended_at600ms; срок задаётся после seed, чтобы подготовка не
попала в dispatch lateness. Обычные квоты не увеличиваются/не выключаются.
Метод имеет timeout780s; ожидание ограничено горизонтом расписания +150s.
Все задания учитываются, медленные/неудачные не удаляются из статистики.

Обязательные проверки: 1000 уникальных вызовов и sent с одним attempt,
нет ранних starts/остатка claimable, quota_deferred=0, p95≤2000ms/p99≤5000ms.
Процентили считаются по первому `delivery_attempts.started_at−intended_at`,
completion latency печатается отдельно. Переносы квот, ошибки или нарушение
порогов делают проверку неуспешной, а не исключаются из отчёта.

## Статус результата

Завершён: **30 tests, 0 failures/errors/skipped, BUILD SUCCESS**, exit 0.
Лог: `target/b07-acceptance-paced-20261008.log` (уникальное имя этого запуска).
Dispatcher — 15 tests, queue — 14, paced measurement — 1.

| Метрика первого старта | Результат |
| --- | ---: |
| samples / calls | 1000 / 1000 |
| elapsed | 600519 ms |
| p50 | 291.482 ms |
| p95 | 538.951 ms |
| p99 | 562.248 ms |
| max | 641.633 ms |
| quota_deferred | 0 |

Completion lateness min/max: 41.723 / 723.154 ms; это другие метрики, не
замена first-start percentiles. Проверки уникальности, одного attempt,
отсутствия ранних стартов и оставшихся claimable заданий прошли.
Локальные пороги p95≤2s/p99≤5s выполнены. Telegram transport имитируется:
результат не включает реальную сеть Telegram, push, NTP или VDS.
Стенд запускался без конкурирующего Maven/load B-08; рабочее дерево грязное,
этот запуск не является проверкой опубликованного Git revision или общим verify.
SHA256 DeliveryLoadIT.java на момент запуска:
`19EF1F304E7592209B1DA71F985C0EBF52EF72B7B5E4F630C0ACE13B59C37E4C`.

## Оставшаяся серверная приёмка

Даже успешный локальный замер не закрывает TIME-06/B-07. Нужен отдельно
согласованный изолированный серверный контур, не работающий production.
Владелец 08.10.2026 выбрал **пока только локальные проверки**.
Серверная приёмка отложена, не считается выполненной.
Покупка/подключение отдельного сервера автоматически не выполняются.
PostgreSQL можно поднять в своём контейнере; покупка отдельной услуги БД
не является техническим условием этих проверок.

На серверном стенде повторить paced/burst отдельно, записать версии/ресурсы,
NTP offset и нагрузку, подтвердить autostart и сохранность очереди при restart.
Проверить внешний монитор недоступности приложения/БД и часы >500ms;
worker silence>30s и due backlog>10s рассматривать с учётом квоты.
Проверять появление/снятие и дедупликацию alarm, доставку только админу.
Истёкшая сессия монитора не должна выглядеть как здоровый сервис;
не хранить cookie/token в отчётах. Долгоживущий monitoring credential ещё
не реализован; его решение требует согласованного security-контракта.

Реальные тестовые отправки — только разрешённый тестовый бот и согласованные
участники; local fake1000 нельзя механически превращать в live1000 одному
человеку: личные квоты делают такой сценарий другим измерением.
Начало HTTP не равно моменту доставки push на телефон.

Ponytail: расширен прежний measurement harness, без новых зависимостей,
брокера, таймера или production-изменений.
