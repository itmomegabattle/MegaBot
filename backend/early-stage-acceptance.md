# Ревью приёмки B-00…B-05, актуализировано 06.10.2026

Проверены критерии backend.md, существующая реализация и текущие тесты; наличие кода не заменяет требуемый drill или импорт. Исторические записи 30.09 сохранены как история, актуальные статусы добавлены сразу под заголовками.

| Пункт | Текущий результат | Остаток |
|---|---|---|
| B-00 | Открыт: README/baseline/parity matrix/обезличенные fixtures есть | Требования преподавателя и executable Telegram/parity suite с explicit Java base URL |
| B-01 | Закрыт 06.10: isolated host-Java JAR + Compose-db drill, outage/recovery, named-volume recreation/restart | Production/VDS/backup и app-container image build не входят в подтверждённый локальный drill |
| B-02 | Закрыт | Production migration/import не входит в эту приёмку, остаётся B-09/B-10 |
| B-03 | Открыт: auth/session/origin/частные permissions tests зелёные | Полная four-role/action SEC matrix, включая B-08 и неизвестный webhook/callback |
| B-04 | Закрыт | Legacy client adoption и production switch остаются B-09/B-10 |
| B-05 | Открыт: доменное ядро/RSVP/rules/notifications и новые негативные тесты зелёные | Legacy attendeeIds→yes с legacy attribution и executable import/parity fixture; B-09 не объявлен готовым |

## Доказательства

B-01, 06.10: `npm run verify:java-compose`, proof `output/megabot-b01-8ebaa9e7/result.json` (passed=true). Новый Compose project/volume, V001…V032, readiness503/DOWN при остановке своей БД и liveness200 с/без stale cookie; recovery без restart Java, сохранность synthetic participant/Flyway history после пересоздания контейнеров и restart JAR. Реальный дефект общей session filter исправлен: probes больше не пытаются открыть session DB transaction; отсутствие token также не обращается к DB. Четыре новых unit tests, focused11 и полный **466 tests, 0 failures/errors/skipped, BUILD SUCCESS**, `target/b01-final-verify.log`; lint/docs/diff зелёные. Старые неуспешные drill artifacts сохранены, успешный сценарий включён в прежний CI без новой зависимости. Production/test-bot/чужие containers и volumes не затронуты. Следующие записи — историческая приёмка 04.10, не остаток уже закрытого B-01.

Полный итоговый mvnw.cmd --batch-mode verify — **278 tests, 0 failures/errors/skipped, BUILD SUCCESS**, PostgreSQL 17.11, V001…V023 на чистой БД; log `target/early-backend-acceptance-final-verify.log`. PersistenceIntegrationTests: 10 (repeat Flyway, UNIQUE/CHECK/FK, optimistic conflict/pagination, exact Instant, outbox rollback, hashed/revoked session). B04 HTTP: 4; AvailabilityCalendar: 4; SlotSuggestionEngine: 2; B05 HTTP: 4; MeetingRules: 4; MeetingNotification: 10. Остальная suite тоже зелёная.

Три новых теста: запрещённые FK, concurrent meeting update/replay с полным текстом и ночным окончанием, атомарный rollback доменного создания при ошибке integration job. Первый прогон содержал ошибку имени столбца в новом тестовом CHECK; исправлено на реальный provider, выполнен новый полный прогон, не только повтор одного теста. Production код не изменён; сеть Telegram/Google не использовалась.

Read-only ревью подтверждает CI Maven + frontend lint/build, безопасные local/test fake modes, management liveness/readiness и Compose loopback/named volume. Это не утверждение выполненного Compose restart/drill или успешного удалённого CI-run. Непроверенные пункты сохранены открытыми.

Ponytail full: существующие Testcontainers/PostgreSQL инструменты вместо второго test harness и новых зависимостей; уточнены доказательства без массового изменения кода. Diff check чистый. После двух отметок общий счёт именованных пунктов: todo.md 27/40, todo_design.md 10/12, backend.md 3/13, всего **40/65 (61.5%)**, осталось 25. B-07 оценочно 84%, остаётся открытым. Проценты старых записей — исторические срезы, не актуальный глобальный счёт.
