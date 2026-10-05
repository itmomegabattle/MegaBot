# Изолированные Telegram-тесты B-07

Разрешение владельца: только `@test_megaorgi_bot` (bot ID `8832831571`),
личные чаты `@wonkersone` (`658274366`) и `@Earth_dr` (`703359098`).
Идентичность бота и ID участников проверены через Telegram API. Другие люди,
группы, топики, рабочий бот, рабочая БД и Google запрещены.

## Защита

- Отдельный профиль `live-test`, несовместимый с другими активными профилями.
- Ранний startup initializer проверяет DB URL/пользователя, loopback/порт,
  отключённый Google и префикс токена согласованного бота **до создания beans,
  подключения Hikari и миграций Flyway**, даже когда отправка выключена.
- `Start-LiveTest.ps1` дополнительно проверяет настоящий `getMe` до запуска.
- Единственный HTTP-транспорт в этом профиле получает неизменный список двух ID.
  Посторонний пользователь, любой group/chat ID и topic блокируются **до HTTP**:
  результат `failed / test_recipient_not_allowed`, без автоматического retry.
- Список и bot ID зафиксированы в `LiveTestSafetyConfiguration`, не расширяются
  переменной окружения. Не переносить этот код/токен на рабочий сервер.
- Sender требует двух явных переключателей; запуск без параметра не отправляет.
  Ограничение транспорта не заменяет прежние domain/lease/quota/dedupe gates.

## Локальный запуск

Из корня проекта: `./backend/Start-LiveTest.ps1` после успешного Maven verify.
Токен берётся только из игнорируемого `backend/.env.test.local`, в аргументы
процесса и Git не попадает. Скрипт не импортирует остальные значения этого файла.

БД поднимается **только** из отдельного `compose.live-test.yaml` с project name
`megabot-live-test`: PostgreSQL 17.11, база `megabot_live_test`, отдельный том
`megabot-live-test_test-postgres-data`, порт `127.0.0.1:55432`.
Тестовые фиксированные пароли годятся только для локальной loopback-песочницы,
не для VDS. Приложение слушает `127.0.0.1:18081`, работает с `-Xmx384m`.
Launcher копирует собранный JAR в игнорируемый `target/live-test-runtime/`
и запускает эту копию: Windows не блокирует Maven repackage исходной сборки.
Рабочий `compose.yaml` не используется, прежние контейнеры не перезапускаются.

`GET http://127.0.0.1:18081/actuator/health/readiness` проверяет готовность БД.
На чистой базе нет участников/рассылок: UI-паритет и Telegram webhook ещё не готовы.
Для реального сценария нужны отдельные тестовые fixtures и проверка пустой очереди;
не импортировать production-данные. `-EnableDelivery` предназначен только для
контролируемого теста после подготовки fixtures, не для автоматического запуска.

Песочница не подтверждает production SLO, серверный NTP, надёжность webhook,
инфраструктурный crash/restart и остальные незавершённые требования B-07.
Сервер и платная managed DB для этого локального шага не нужны.

## Проверено 04.10.2026

- Полный Maven verify после финального early initializer: **286 tests,
  0 failures/errors/skipped, BUILD SUCCESS**; log `target/live-test-final-verify-2.log`.
- Негативный настоящий Spring Boot старт с подменой URL останавливается в
  initializer, до любых beans/Flyway/Hikari. В тестах используются только fake
  credentials и локальный HTTP-сервер; живых отправок в verify нет.
- Compose config и синтаксис PowerShell проверены. Скрипт действительно запущен
  без `-EnableDelivery`, `getMe` подтвердил согласованного бота.
- На новой БД применены V001…V023; readiness **UP**, соединения приложения
  принадлежат `megabot_live_test_app` в `megabot_live_test`.
- После запуска: users/broadcasts/deliveries/attempts/integration_jobs = **0**.
  Sender выключен, токена в аргументах Java нет. Production не использовался.
- Локальное приложение оставлено на `127.0.0.1:18081`, отдельная БД на `55432`.
  Следующий блок — тестовые fixtures и контролируемые отправки через общую очередь.

Блок безопасной подготовки готов на 100%; B-07 оценочно 85%, не закрыт.
Общий счёт по именованным заголовкам — 40/65 (61.5%), не по вложенным checks.

## Реальные отправки и восстановление, 04.10.2026

По дополнительному разрешению владельца выполнен `Test-LiveDelivery.ps1`:
обычная отправка, replay после успеха, конфликт того же ключа, отложенная
рассылка двум людям, отмена до срока и перенос времени одной рассылки.
HTTP/API, роли/Origin, idempotency, snapshot, PostgreSQL queue, scheduler,
quota и Telegram transport штатные; прямые `sendMessage` из скрипта не используются.
Временная **синтетическая** сессия записана только хешем в тестовую БД и отозвана
в finally. Это не доказательство работы Telegram Mini App login/webhook.

Первый запуск выявил сеть: Java без системного Windows proxy получила только
`connection_not_established`, после timeout проверки deliveries отменены,
подтверждённых сообщений **0** (`target/live-delivery-acceptance.log`).
Public-only `tools/TelegramNetworkProbe.java` показал: direct → connect timeout,
system proxy → HTTP 302, принудительный IPv4 проблему не решает. В тестовый
launcher добавлен штатный `-Djava.net.useSystemProxies=true`; production Java
transport/endpoint/TLS и рабочие настройки не менялись. Свойство описано в
[Java 21 Networking Properties](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/net/doc-files/net-properties.html).

Повторный основной прогон **PASS**, log `target/live-delivery-acceptance-2.log`:

| Сценарий | Подтверждено Telegram | Максимальная задержка начала запроса |
| --- | ---: | ---: |
| Сейчас, по одному обоим | 2 | 751.5 ms |
| Расписание, по одному обоим | 2 | 678.6 ms |
| Перенос на новый срок, Earth_dr | 1 | 146.9 ms |
| Replay / конфликт ключа / отмена / старая revision | 0 дополнительных | — |

`-RecoveryOnly` **PASS**, log `target/live-recovery-acceptance.log`: две
future deliveries сохранены в БД, только verified local test Java abruptly
остановлена **до** срока и **без** claimed/sending HTTP. PostgreSQL не
останавливалась. Процесс запущен после due + 8 s; send_late отправился один
раз с provider proof, skip истёк с attempts=0. Задержка send_late **18028 ms**
преднамеренная (остановка + startup), не включается в обычные измерения.

Итого **6** подтверждённых сообщений (по 3 каждому), по одной попытке на
успешную delivery, ранних starts=0, outside allowed audience=0, неотозванных
тестовых сессий=0. Это подтверждение приёма Telegram, **не** времени появления
на телефоне. Маленький локальный прогон не является p95/p99 SLO или релизной
приёмкой. Не проверены live in-flight response loss, PostgreSQL outage,
clock shift/NTP, конкурирующие процессы, массовая нагрузка на VDS и остальные
occurrences/UI/групповые требования B-07/TIME-07.

После проверки тестовый sender снова выключен, контур остаётся локальным.
Harness требует уже запущенный restricted live-test worker; включается вручную
`Start-LiveTest.ps1 -EnableDelivery`. Повтор не запускается автоматически:
unknown запрещает новую проверку, сохраняются прежние creation quotas,
pending собственные broadcasts отменяются при выходе. Никогда не расширять
два согласованных ID ради нагрузки или проверки групп.

Дополнительно исправлено отображение безопасного `test_recipient_not_allowed`
в delivery/attempt journal без raw provider details; добавлена DB/HTTP регрессия.
Финальный полный verify — **287 tests, 0 failures/errors/skipped, BUILD SUCCESS**,
log `target/live-acceptance-final-verify-2.log`. Первый verify прошёл все 287
тестов, но Windows lock запущенного JAR сорвал repackage; launcher теперь
использует отдельную runtime-копию, полный verify после остановки старого
тестового процесса успешно повторён. Токен и runtime artifacts игнорируются Git.

Runtime-копия совпала по SHA с проверенной сборкой, readiness UP, sender disabled.
Дополнительный `package -DskipTests` при работающем приложении также BUILD SUCCESS
(`target/live-runtime-repackage-check.log`): Windows lock больше не мешает упаковке.
Это отдельная проверка repackage; 287 регрессий выполнены полным verify выше.

Live блок принят на 100% в описанных границах. B-07 оценочно 87%, не закрыт;
40/65 пунктов (61.5%). Для дальнейших локальных шагов покупок не требуется.
