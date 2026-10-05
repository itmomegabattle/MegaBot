# B-06: приёмка домена задач

Закрыт 01.10.2026. Полный `mvnw.cmd --batch-mode verify` с PostgreSQL 17.11: **118 tests, 0 failures/errors/skipped, BUILD SUCCESS**. OpenAPI parsed: 59 paths, все 17 legacy task/faculty routes описаны, локальные references разрешены. `git diff --check` без ошибок. Лог последнего локального прогона — `target/b06-final-verify.log` (generated, не коммитится).

Источник требований: раздел B-06 в `backend.md`, PRODUCT-05/API-03, task routes в `parity-matrix.md`. Проверки выполняются через HTTP/MockMvc на настоящем PostgreSQL Testcontainers. Java worker и Telegram transport не считаются частью этой приёмки.

## Покрытие

| Требование | Исполняемое доказательство |
|---|---|
| Shared status/completedBy, completion только автору | B06HttpIntegrationTests: partialReleaseKeepsColleagueAndSharedCompletionNamesActor, all-faculty completion; SQL/outbox asserts |
| Два claim — один победитель, session actor и eligibility | twoConcurrentClaimsHaveOneWinner, legacyConcurrentClaimUsesSessionActorAndReplayHasNoSideEffects; legacyClaimRequiresMatchingCompetencyBeforeAssignment |
| 20 параллельных create не теряются | twentyConcurrentCreatesKeepEveryTask |
| Полная таблица переходов, cancelled не возобновляется | TaskRulesTests.everyStatusPairMatchesExplicitTransitionTable; completionClosesCommentsAndCancellationCannotBeReopened; legacyFinalCommandRereadsCancelledStatusAndCurrentSessionRole |
| Role/access/version перечитываются на финальной команде | legacyFinalCommandRereadsCancelledStatusAndCurrentSessionRole, stale update/release/cancel, spoofed actor tests |
| Частичный release не снимает коллег | legacyReleaseKeepsOtherAssigneeThenReturnsTaskToBoard; legacyFacultyReleaseCannotRemoveColleagueOrClaimFacultyBoard; v1 partial release |
| Append-only comments и закрытые результаты | legacyCommentsAndCompletionUseSessionActorAppendOnlyAndDoNotDuplicate; history/completion snapshot tests |
| Faculty/core/own/all scopes и приватность адресных заметок | facultyCannotReadOrMutateCoreTasks, all-faculty/membership tests, legacyFacultyUpdateKeepsAllScopeAndUsesScopedExecutorCommands |
| Invalid deadline и строгая версия, null/list partial semantics | legacyMalformedPatchRollsBackAndEmptyListsExplicitlyClear; LegacyTaskMutationRulesTests; legacyPartialUpdatePreservesAssignmentsTipsMarkersAndChecksReplayVersionAndActor |
| Nullable/archived event не теряет незавершённую задачу | archivedEventDoesNotHideUnfinishedTaskAndNullableEventIsPreserved |
| Tips/reminders, anchor/sent/version и reopen lifecycle | existing reminder configuration/lifecycle DB tests; TaskReminderRulesTests; TaskFrontendMapperTests |
| Все task сообщения тихие, ручной notify durable, без дублей/приватных заметок | manualReminderIsSilentDurableSnapshotAndConcurrentReplayDoesNotDuplicate; completion outbox assertions |
| Notify role/version/recipients, отсутствие физической отправки | manualReminderChecksActorVersionRecipientsAndCancellation; manualReminderWithoutAssignmentAndFailedOutboxLeaveNoPartialRecords |
| Очистка только completed/cancelled, история и recovery сохраняются | legacyArchivePreviewClearPreservesActiveTasksHistoryAndSupportsRecovery; v1 archive/restore scenarios |
| Reset preview защищён по ID и версиям, подтверждение обязательно | legacyResetRejectsStaleVersionsIdsMissingFingerprintAndWrongConfirmation; stale v1 preview; create/reset race |
| Ошибка backup/outbox не оставляет частичную запись | legacyResetBackupFailureRollsBackTasksQueueAuditAndReplayRecord; manual outbox failure; v1 backup failure |
| Maintenance не оставляет живой outbox для скрытой задачи | legacyResetCancelsQueuedManualReminderAndRemovedTaskCannotNotify; legacyReminderRacingResetCannotLeaveLiveQueueForRemovedTask; v1 restore lifecycle |
| Полная очистка журнала запрещена | legacyMaintenancePermissionsGoneEndpointAndEmptyArchiveAreExplicit |
| Current export не подменяется историей, CSV безопасен и пагинирован | legacyCurrentExportIsAdminOnlyPagedEscapedAndSeparateFromHistory; TaskCurrentCsvTests; TaskLogCsvTests; existing log pagination/access tests |

Основной файл: `src/test/java/ru/itmomegabattle/megabot/B06HttpIntegrationTests.java`; unit rules/DTO/CSV — `src/test/java/ru/itmomegabattle/megabot/tasks/`.

## Намеренные отличия безопасного Java-контракта

- Actor только из session, не requesterId/userId/creatorId. Mutations требуют Origin и Idempotency-Key, task commands — version (0 валидна).
- Clear/reset требуют fingerprint из пользовательского preview. Одни taskIds не защищают от изменений при том же составе; сервер не подбирает свежую версию автоматически.
- Legacy current export — paged UTF-8 CSV, не HTML под расширением XLS. Historical export — отдельный v1 route. Клиент должен читать X-Next-Cursor и все страницы.
- Notify возвращает persisted intent и delivered=0, а не выдуманный успех Telegram. Снимок адресатов не освобождает worker от проверки отмены/версии/актуального доступа перед отправкой.
- Полная очистка журнала — 410; soft removal восстанавливается через v1 recovery. Recovery внутри той же БД не заменяет внешний backup.

Эти отличия записаны в OpenAPI/tasks.md и обязательны при адаптации frontend B-09/B-10. Они не скрываются под формулировкой «полное production-переключение».

## Следующие независимые этапы

B-07 реализует occurrence/delivery/worker и TIME-01…07. B-08 — Telegram callbacks, live Telegram/Google, Sheets/Calendar. B-09/B-10 — импорт и переключение клиента. Тестовая приёмка B-06 не означает, что эти этапы или релиз уже завершены.
