# B-07 / TIME-07: приёмочная сверка

Дата: 08.10.2026. Это статический аудит существующих исходников и сохранённых
результатов; дополнения ниже содержат новые целевые прогоны, но **не подтверждение production SLO**.
B-07/TIME-06/TIME-07 этим документом не закрываются.

## Границы параллельной работы

С чатом «Прочитать планы MegaBot» согласованы этот отчёт, отдельный paced-отчёт
и классы DeliveryQueueIntegrationTests, BroadcastDispatcherIntegrationTests,
DeliveryLoadIT. B-08, Telegram/Google-интеграции, общие планы и production
здесь не меняются. Maven/Docker/load запускаются только в отдельном окне,
без параллельного тяжёлого прогона другого чата.
Ponytail full: используются существующие тесты/отчёты, без второго harness.

## Что подтверждено, а что ещё нет

Пути тестов ниже относительны `src/test/java/ru/itmomegabattle/megabot/`.
«Есть тест» означает наличие проверок в исходнике, не свежую зелёную проверку.
Исторический полный прогон 05.10.2026 проверен по локальному логу
`target/process-crash-birthday-final-verify.log`: 370 tests, 0 failures/errors/
skipped, BUILD SUCCESS. Он не покрывает автоматически последующие изменения.

| Критерий TIME-07 | Существующее доказательство | Граница / остаток |
| --- | --- | --- |
| До due не отправлять | `DeliveryQueueIntegrationTests.exactDueAndAvailableBoundariesAndClockRollbackAreIndependentOfJvmZone`; `BroadcastDispatcherIntegrationTests.transportStartsExactlyAtDueWithoutEarlyCallsOrDuplicatesInDifferentJvmZones` | T−1s/T−1µs/ровно T и rollback проверены в PostgreSQL, три JVM TZ; новые прогоны описаны ниже |
| T…T+5s при штатной нагрузке | `DeliveryLoadIT.lifecyclePacedThousandMeasuresLatenessWithoutQuotaDeferral`, [scheduler report](b07-scheduler-paced-report.md) | Локально 1000, quota_deferred=0, p95=538.951ms/p99=562.248ms/max=641.633ms; VDS/сеть Telegram не измерены |
| Restart до due | `DeliveryProcessCrashIntegrationTests.restartBeforeDuePreservesFutureIntentWithoutEarlySend` | Настоящие дочерние JVM, неизменный intended_at, ноль attempts; не reboot сервера |
| Crash после claim | `DeliveryProcessCrashIntegrationTests.killAfterClaimRecoversUnstartedWorkAndRejectsDeadWorkerToken` | Реальный kill; lease deadline ускорен только в тестовой БД |
| Crash после возможной передачи | `DeliveryProcessCrashIntegrationTests.killAfterFakeAcceptanceLeavesUnknownAndDoesNotRepeatOtherSuccessfulTarget` | Проверены unknown и отсутствие автоматического дубля; провайдер fake, не потеря реального Telegram response |
| Два workers | `DeliveryQueueIntegrationTests.twoWorkersClaimDisjointRowsAndNeverClaimFutureOrExpired`; `BroadcastDispatcherIntegrationTests.twoWorkersOnlyOneNetworkAttemptAndTransactionsAreForbidden` | Есть конкурентные DB/dispatcher проверки; не два сервера под production-нагрузкой |
| DB outage | `DeliveryDatabaseOutageIntegrationTests`, [outage acceptance](database-outage-acceptance.md) | Реальный pause/unpause своей Testcontainers БД; reboot PostgreSQL/host и disk-failure этим не подтверждены |
| 429 / Retry-After | `BroadcastDispatcherIntegrationTests.retryAfterPausesBotAndChatAndSurvivesSubsequentWorkerCall` | Проверена общая квота и срок повторения на fake transport |
| Blocked user / permanent failure | `BroadcastDispatcherIntegrationTests.permanentFailureAndInvalidPayloadAreTerminalWithoutRetry`; `DeliveryQueueIntegrationTests.permanentFailureAndAmbiguousTransportNeverRetry` | Локальная terminal policy; настоящий HTTP 403 проверять отдельно в transport suite / согласованном тестовом боте |
| Отмена | `DeliveryQueueIntegrationTests.cancellationBeforeStartPreventsSendWhileInFlightSuccessRemainsSent`; `BroadcastHttpIntegrationTests.cancellationDoesNotPretendToRecallInFlightAndStartedBroadcastCannotEdit` | Есть до/после start, отмена не обещает отозвать принятый запрос |
| Перенос | `BroadcastHttpIntegrationTests.timeOnlyTransferInvalidatesClaimAndRejectsStaleForeignStartedExpiredAndInvalidTime`; `timeOnlyTransferRollsBackOldCancellationOnNewDeliveryFailure` | Контракт и rollback есть; UI приёмка остаётся отдельным доказательством |
| Повтор POST | `BroadcastHttpIntegrationTests.createPersistsSnapshotAndQueueAtomicallyReplaysAndSurvivesNewSession`; `concurrentLegacyReplaysCreateOneBroadcast` | Есть HTTP replay/idempotency и конкуренция |
| 100 адресатов | `DeliveryLoadIT`: три сценария по 1000, [load report](delivery-load-report.md) | Более крупная synthetic нагрузка есть; burst не означает одновременно доставленные сообщения |
| Пользователь/задача удалены перед due | `B06HttpIntegrationTests.legacyResetBackupFailureRollsBackTasksQueueAuditAndReplayRecord`, `legacyResetCancelsQueuedManualReminderAndRemovedTaskCannotNotify`; birthday recipient gates | Покрытие распределено по доменам; перед закрытием проверить именно отсутствие HTTP для всех нужных категорий, не только наличие guard/статуса |
| Смена суток/года | `BirthdayReminderIntegrationTests.nextDayMidnightExpiresOldDeliveriesWithoutNighttimeCatchup`, `yearBoundaryAndLeapBirthdayUseCalendarDatesWithoutFebruary28Substitution`; `AvailabilityReminderIntegrationTests.yearBoundaryKeepsAbsoluteMondayAndDoesNotReplayMissedWeeks` | Есть календарные доменные проверки; не измерение реальных часов сервера |
| Разные TZ ОС | Календарь/БД плюс новые queue/dispatcher tests под UTC/Honolulu/Tokyo | Очередь и sender проверены с контролируемыми DB часами; scheduler latency измерена только в локальной конфигурации, не под тремя host TZ |
| Birthday hour | `BirthdayReminderIntegrationTests.defaultStartsAt12MoscowAndSnapshotExcludesBirthdayPersonFacultyAndPrivateBirthYear`, `threeDailyOccurrencesStayIndependentAndNeverReplayEarlierDays` | Старый текст TIME-07 «birthday 19:00» устарел: старт трёх occurrences — 12:00 МСК; закрытие сбора в 19:00 — другое правило |
| Polling выключен, scheduler включён | `BroadcastDispatcherIntegrationTests.wakeupRunsWithoutTelegramPollingAndStopsClaimsOnShutdown` | Есть lifecycle fake-worker проверка, без реальных отправок |

## Следующие изолированные шаги

### Дополнение: граница вызова transport и JVM TZ, 08.10.2026

В согласованном `BroadcastDispatcherIntegrationTests` добавлен
`transportStartsExactlyAtDueWithoutEarlyCallsOrDuplicatesInDifferentJvmZones`.
Он вошёл в текущую компиляцию общего B-08 прогона (метод проверен через javap),
поэтому отдельный конкурирующий Maven не запускался. Результат класса в
`target/telegram-slot-day-callback-verify.log`: **14 tests, 0 failures/errors/
skipped**; новый testcase также проверен в XML surefire. Общий verify на момент
фиксации ещё продолжается: BUILD SUCCESS всему прогону здесь не приписывается.

В реальной Testcontainers PostgreSQL и штатном dispatcher/quota/domain gate
проверены T−1s и T−1µs (ноль transport calls и attempts), ровно T (одна sent
отправка, точный request_started_at, правильный адресат/silent, вне транзакции)
и T+5s (повтора нет). Сценарий повторён в UTC/Honolulu/Tokyo на московской
границе Нового года; timezone и локальная SQL clock-функция очищаются в finally.
Transport fake: ни реальный Telegram, ни production не затронуты.

Подблок100%. Это расширяет подтверждение TZ от очереди до dispatcher/send,
но не доказывает точность scheduler wakeup, SLO, NTP или push на устройстве.
Ponytail: один тест в существующем классе, без зависимостей и main-code правок.
B-07 открыт; общий счёт44/67 (65.7%).

### Дополнение: границы очереди и JVM TZ, 08.10.2026

После освобождения Maven/Docker в B-08 добавлен один тест
`DeliveryQueueIntegrationTests.exactDueAndAvailableBoundariesAndClockRollbackAreIndependentOfJvmZone`.
Отдельный прогон всего класса: **14 tests, 0 failures/errors/skipped,
BUILD SUCCESS**, `target/b07-time-boundaries-20261008-final.log`.
Проверены T−1s, T−1µs, ровно T, отдельная граница available_at, откат DB clock
после claim перед start без попытки и успешный start при возврате к T.
Весь сценарий повторён с JVM default TZ UTC/Pacific-Honolulu/Asia-Tokyo
на московской границе Нового года; intended_at/request_started_at сохраняют
точный Instant. TimeZone восстанавливается и тестовая SQL clock-функция
удаляется в finally. Host clock и production не меняются.

Первый прогон (`target/b07-time-boundaries-20261008.log`) неуспешен:
в тестовом контексте отсутствовал search_path public,pg_catalog и использовалась
настоящая clock_timestamp. Исправлена только настройка теста по существующему
образцу BirthdayReminderIntegrationTests; production-код не менялся.
Новый отдельный файл/harness не понадобился (Ponytail).

Это закрывает точную due/available/start границу **очереди** и её работу при
трёх JVM TZ, но не полный sender/scheduler under-TZ или реальный SLO.
Подблок100%; B-07 остаётся открытым. Полный B-08 verify512 запускался до
компиляции нового теста и не является его доказательством.

### Дополнение: отзыв доступа до due, 08.10.2026

`accessRevokedBeforeDueCancelsDeliveryWithoutTransportOrAttempt` проверяет
шесть независимых изменений после планирования: отключение автора/получателя,
снятие регистрации получателя, смену его Telegram-привязки и отзыв роли
автора/получателя. До due запись planned; в due отменяется без transport,
без delivery_attempts и без следующей попытки. Это проверка broadcast domain
gate; она не подменяет отдельные проверки удаления задачи/встречи/birthday.
В завершённом целевом прогоне класс отправителя: 15 tests, 0 failures/errors/skipped.
Итог всего прогона и paced-замер зафиксированы в
[отчёте scheduler](b07-scheduler-paced-report.md).

### Итог связанного локального блока, 08.10.2026

`target/b07-acceptance-paced-20261008.log`: **30 tests, 0 failures/errors/skipped,
BUILD SUCCESS**, exit 0. 1000 заданий штатного scheduler, p95=538.951ms,
p99=562.248ms, max=641.633ms; quota_deferred=0, без ранних/повторных отправок.

`target/b07-domain-acceptance-20261008.log`: **53 tests, 0 failures/errors/skipped,
BUILD SUCCESS**, exit 0. Проверены целые классы AvailabilityReminder (11),
BirthdayReminder (14), MeetingReminder (10), TaskManualDelivery (8),
TaskReminderPlanner (10), а не только отобранные счастливые методы.
Это свежие targeted результаты, не новый полный Maven verify всего проекта.

Доменные границы подтверждены существующими тестами:

- Встречи: cancellationBlocksPendingAndAlreadyClaimedReminders и
  startedMeetingAndMissedGraceDoNotSendStaleReminder — отмена/начало встречи
  блокируют start, delivery_attempts отсутствуют.
- Задачи: completionChangedVersionBindingAndAssignmentCancelBeforeAttempt —
  completed, новая версия, изменённая привязка/исполнитель или отключённое
  напоминание отменяют claim до попытки; expiredRemovedAndFutureSourcesDoNotProduceDelivery
  не материализует удалённый/просроченный источник.
- Birthday: birthdayChangeDeactivationRoleAndRegistrationBlockOldSnapshotBeforeHttp
  и recipientPermissionsBindingAndSelfDeliveryAreCheckedAtStart — старые/лишённые
  прав snapshot не начинают попытку.
- Слоты: весь AvailabilityReminderIntegrationTests повторно прошёл; проверяются
  текущие права/привязки, границы недели, отсутствие повторной occurrence.

Локальный связанный блок100%; B-07 целиком остаётся открытым. Оценочная
готовность этапа95% — консервативная оценка с учётом ещё не пройденных
операционных gates, не число успешных tests и не обещание production SLO.
Владелец выбрал пока только локальные проверки; VDS/NTP/внешние alarms
отложены. Общий счёт44/67 (65.7%), ни один незавершённый этап не закрыт.
Ponytail: три дополнения в существующих test classes, повторное использование
measurement harness; без новых зависимостей, production или второго sender.

1. Целевые результаты сохранены с уникальными логами; общий regression
   привязать к согласованному состоянию кода, поскольку B-08 меняется.
   Docker-skipped tests не считать успешной приёмкой, текущие перезаписываемые
   surefire reports не использовать как единственное историческое доказательство.
2. Точные due/available/start границы очереди и sender под тремя JVM TZ
   теперь проверены. Перед закрытием сверить оставшиеся доменные категории
   удаления объектов с существующими assertions, не размножать одинаковые tests.
3. Итог 1000 paced jobs без quota deferral — в отдельном scheduler-отчёте;
   backlog/burst не смешивать с ним. Локальный результат не подтверждает
   p95≤2s/p99≤5s для VDS/реального Telegram.
4. С владельцем согласовать изолированный VDS/контур, контроль NTP и внешний
   монитор/канал админу. Проверить реальные alarms и autostart/restart.
   Production-бот/БД/группы не использовать; реальные отправки только через
   разрешённого тестового бота согласованным участникам.

Покупка сервера/переключение production не выполняются автоматически.
Нельзя обещать точность push на устройстве по внутреннему времени старта HTTP.
Оценка B-07 «98%» историческая, не пересчитанная готовность этой полной матрицы.
Общий план на момент сверки: 44/67 закрытых именованных пунктов (65.7%);
аудит является подблоком, а не новым закрытым пунктом.
