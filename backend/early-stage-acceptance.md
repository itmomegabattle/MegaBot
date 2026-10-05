# Ревью приёмки B-00…B-05, 04.10.2026

Проверены критерии backend.md, существующая реализация и текущие тесты; наличие кода не заменяет требуемый drill или импорт. Исторические записи 30.09 сохранены как история, актуальные статусы добавлены сразу под заголовками.

| Пункт | Текущий результат | Остаток |
|---|---|---|
| B-00 | Открыт: README/baseline/parity matrix/обезличенные fixtures есть | Требования преподавателя и executable Telegram/parity suite с explicit Java base URL |
| B-01 | Открыт: каркас, profiles/fake guard/CI/Compose/config и PostgreSQL verify есть | Изолированный Compose+Java launch, readiness DB up/down, named-volume persistence после restart |
| B-02 | Закрыт | Production migration/import не входит в эту приёмку, остаётся B-09/B-10 |
| B-03 | Открыт: auth/session/origin/частные permissions tests зелёные | Полная four-role/action SEC matrix, включая B-08 и неизвестный webhook/callback |
| B-04 | Закрыт | Legacy client adoption и production switch остаются B-09/B-10 |
| B-05 | Открыт: доменное ядро/RSVP/rules/notifications и новые негативные тесты зелёные | Legacy attendeeIds→yes с legacy attribution и executable import/parity fixture; B-09 не объявлен готовым |

## Доказательства

Полный итоговый mvnw.cmd --batch-mode verify — **278 tests, 0 failures/errors/skipped, BUILD SUCCESS**, PostgreSQL 17.11, V001…V023 на чистой БД; log `target/early-backend-acceptance-final-verify.log`. PersistenceIntegrationTests: 10 (repeat Flyway, UNIQUE/CHECK/FK, optimistic conflict/pagination, exact Instant, outbox rollback, hashed/revoked session). B04 HTTP: 4; AvailabilityCalendar: 4; SlotSuggestionEngine: 2; B05 HTTP: 4; MeetingRules: 4; MeetingNotification: 10. Остальная suite тоже зелёная.

Три новых теста: запрещённые FK, concurrent meeting update/replay с полным текстом и ночным окончанием, атомарный rollback доменного создания при ошибке integration job. Первый прогон содержал ошибку имени столбца в новом тестовом CHECK; исправлено на реальный provider, выполнен новый полный прогон, не только повтор одного теста. Production код не изменён; сеть Telegram/Google не использовалась.

Read-only ревью подтверждает CI Maven + frontend lint/build, безопасные local/test fake modes, management liveness/readiness и Compose loopback/named volume. Это не утверждение выполненного Compose restart/drill или успешного удалённого CI-run. Непроверенные пункты сохранены открытыми.

Ponytail full: существующие Testcontainers/PostgreSQL инструменты вместо второго test harness и новых зависимостей; уточнены доказательства без массового изменения кода. Diff check чистый. После двух отметок общий счёт именованных пунктов: todo.md 27/40, todo_design.md 10/12, backend.md 3/13, всего **40/65 (61.5%)**, осталось 25. B-07 оценочно 84%, остаётся открытым. Проценты старых записей — исторические срезы, не актуальный глобальный счёт.
