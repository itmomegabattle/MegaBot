# Локальная нагрузочная проверка доставки

## Воспроизведение

Из `backend` с JDK 21 и запущенным Docker:

```powershell
.\mvnw.cmd --batch-mode '-Dtest=DeliveryLoadIT' test
```

`DeliveryLoadIT` намеренно запускается отдельно: два сценария по 1000 заданий требуют реального ожидания квот. Обычный `verify` не включает этот медленный класс. Никаких production credentials, нового брокера или дополнительных зависимостей не требуется. Testcontainers создаёт отдельную PostgreSQL 17.11; sender сети заменён мгновенным fake transport. Таблицы очищаются только в этой тестовой БД.

## Что измеряется

- `paced-engine`: 1000 разных личных адресатов, intended_at с шагом 60 ms. Настоящие claim/domain gate/quota/start/finish вызываются в тестовом цикле; **не** штатный scheduler.
- `burst-engine`: те же 1000 адресатов с единым intended_at, default quota 20/сек. Это backlog/rate-limited case, не SLO одиночной отправки.
- `scheduled-burst`: настоящий Spring `@Scheduled` и lifecycle отправителя, интервал пробуждения 500 ms. До исправления — 20 адресатов; повтор после bounded drain — 1000 адресатов.

Расписание начинается после загрузки fixture по часам PostgreSQL. Время не ускоряется, available_at/квоты во время измерения не переписываются. Задержка = persisted started_at первой попытки − intended_at. Это граница очереди перед сетью, не push на устройстве. Отдельно выводятся min/max задержки fake-confirmed completion, длительность прогона и число доставок с quota deferral.

Каждый сценарий проверяет все ожидаемые sent/attempts, одну попытку и один вызов на адресата, отсутствие ранних starts, HTTP вне транзакции и отсутствие повторного claim успешных строк. Ошибка/таймаут обрывают тест, а не дают частичный «успешный» отчёт. Процентили измеряются, но не имеют flaky assertions на скорость конкретного ноутбука.

## Вывод и ограничения

Baseline до bounded drain, 04.10.2026: Windows, Intel i5-1240P (16 logical processors), JDK 21, PostgreSQL 17.11 в Docker. Параллельный Maven/regression прогон во время этого замера не запускался. Сам ноутбук не является изолированным production/VDS стендом.

| Сценарий | Заданий | p50, ms | p95, ms | p99, ms | max, ms | Доставки с quota deferral |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Равномерный engine, шаг 60 ms | 1000 | 702.946 | 3086.498 | 5439.407 | 8087.241 | 617 |
| Engine burst, default quota | 1000 | 30753.669 | 58131.093 | 60528.155 | 61126.250 | 610 |
| Штатный Spring scheduler, burst | 20 | 4883.862 | 9227.888 | 9617.577 | 9714.999 | 0 |

Для равномерного engine p95 превышает цель 2 s, p99 — цель 5 s, но этот сценарий уже содержит quota deferrals и не соответствует условию «без rate limit». Это **не** подтверждение SLO и не основание исключать медленные строки из статистики. Длительность engine-прогона — 62.872 s; min/max completion lateness — 17.767/8092.037 ms. Для штатного scheduler — 10.744 s, completion lateness 144.159/9721.131 ms.

Engine burst занял 62.104 s; min/max completion lateness 24.043/61129.900 ms. Все 2020 заданий получили ровно одну подтверждённую fake-отправку: потерь, дублей и ранних starts не обнаружено. Отдельный нагрузочный запуск: **3 tests, 0 failures/errors/skipped, BUILD SUCCESS**, log `target/delivery-load-final.log`. Обычный регрессионный verify: **210 tests, 0 failures/errors/skipped, BUILD SUCCESS**, log `target/load-regression-verify.log`. Первый прогон `target/delivery-load.log` частично пересекался с regression и использовал прежний ручной wakeup sample; таблица выше содержит только финальный прогон с настоящим Spring scheduler.

До исправления штатный worker брал одно задание за wakeup. При 500 ms его потолок был примерно 2 задания/сек **до учёта сети**, хотя quota разрешает 20/сек. Поэтому burst из 1000 адресатов тем scheduler растянулся бы примерно на 500 секунд или дольше; это оценка прежней конструкции, не замер 1000 заданий через неё. Нельзя показывать пользователю единый момент 12:00 как обещание одновременной доставки всей пачки.

Bounded draining уже due заданий между пробуждениями теперь реализован в существующем worker: максимум 100 проходов/1 секунда, один HTTP/lease за раз, общая quota, cancellation/lease gates и ограниченное завершение. Старые intended_at получают приоритет после quota deferral. Перед объявлением SLO нужны реальная сеть/нагрузка/VDS/NTP и outage/restart drills. B-07/TIME-06/TIME-07 остаются открытыми. Ponytail: использованы существующие Testcontainers, очередь, sender и PostgreSQL percentiles, без новых зависимостей/миграций/второй очереди.

## Повтор после bounded drain и intended-order

Тот же локальный стенд, отдельный запуск без параллельного regression. Реальные часы/штатные квоты сохранены; Spring scheduler sample расширен до 1000 адресатов. Результаты подтверждают устранение искусственной паузы между сообщениями, но не одновременную отправку пачки и не production SLO.

| Сценарий | Заданий | p50, ms | p95, ms | p99, ms | max, ms | Доставки с quota deferral |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Равномерный engine, шаг 60 ms | 1000 | 1103.481 | 1778.275 | 1880.340 | 1957.348 | 719 |
| Engine burst, default quota | 1000 | 31276.812 | 58962.898 | 61439.921 | 62090.646 | 593 |
| Штатный Spring scheduler, burst | 1000 | 34701.061 | 67771.338 | 70767.905 | 71659.744 | 563 |

Равномерный engine: elapsed 62.743 s, completion lateness min/max 15.492/1961.274 ms. Штатный scheduler: elapsed 72.651 s, completion lateness min/max 207.883/71663.923 ms. Engine p99 уменьшился с 5439.407 до 1880.340 ms; max с 8087.241 до 1957.348 ms. p50 вырос (702.946 → 1103.481 ms): новая дисциплина intended-order уменьшает длинный хвост, а не гарантирует улучшение каждого процентиля.

Средняя скорость штатного scheduler в этом burst — около 14 адресатов/сек, не гарантированные 20/сек. Квоты, последовательная сеть и границы drain по-прежнему ограничивают пачку. До исправления оценка для такого burst была около 500 секунд; измеренные 72.651 секунды после изменения нельзя подписывать как прямой A/B замер 1000 scheduler targets, поскольку baseline scheduler содержал лишь 20.

Повторный engine burst: elapsed 63.060 s, completion lateness min/max 22.593/62095.593 ms. Его показатели не улучшились относительно baseline (elapsed 62.104 s): потолок квот остаётся, изменение направлено на scheduler и fairness. Все **3000** заданий завершились sent, ровно один fake transport вызов/attempt на адресата, без ранних starts и повторного claim. **3 load tests, 0 failures/errors/skipped, BUILD SUCCESS**, log `target/drain-load.log`.

Финальный полный regression verify: **215 tests, 0 failures/errors/skipped, BUILD SUCCESS**, log `target/drain-final-verify.log`. Пять новых DB/unit сценариев проверяют несколько заданий за wakeup, остановку drain на empty/bound, порядок старого намерения после deferral, cancel/unknown между отправками и shutdown во время текущей отправки без старта следующей. Production/live Telegram этим прогоном не включались.
