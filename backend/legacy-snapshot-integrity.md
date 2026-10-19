# B-09: офлайн-проверка целостности legacy snapshot

09.10.2026. Это первый входной gate, **не полный importer/staging writer**.
Не использует dotenv, Google/Telegram, JDBC, рабочую БД или сетевые вызовы.
Все текущие проверки выполнялись только на синтетических данных.

## Существующий формат вместо новой обёртки

Поддержаны точные форматы существующих writers:

- `scripts/google-sheets-database-admin.ts backup`: raw state,
  `JSON.stringify(state,null,2)`. Команда backup получает initialized/ready
  состояние через существующий Sheets reader; сама offline-проверка этого
  факта не доказывает и команду backup не вызывает.
- `src/databaseRecoveryJournal.ts`: компактный format1 record с revision,
  writtenAt, checksum и state. Recovery record подтверждает локальную
  долговечность, но **не ready/status Google Sheets** и не разрешение импортировать.

SHA-256 state считается штатным Node JSON.stringify, без несовместимой Java
пересериализации. Обязательные ожидаемые checksum и revision передаются
отдельно из согласованного source manifest/вывода export; брать их из того же
непроверенного файла не является независимой проверкой. SHA-256 не подпись
и не подтверждает автора/доверенность источника. Для recovery дополнительно
сверяются metadata revision/checksum с state и format=1.

Файл должен соответствовать **точному формату writer**, без ручного перевода
строк/переформатирования. Сравнение parse→stringify обнаруживает дубли JSON keys
и представления чисел с потерей точности; иной whitespace также отклоняется.
Оригинал не переписывается ради прохождения проверки. Это сознательное
ограничение входа; произвольный JSON parser/importer здесь не реализуется.

## Команда только для чтения

Из корня проекта с установленными штатными зависимостями:

```powershell
node --import tsx scripts/legacy-snapshot-dry-run.ts --dry-run PATH --checksum EXPECTED_SHA256 --revision EXPECTED_REVISION
```

Без `--dry-run`, с неизвестными/лишними аргументами или `--apply` — отказ.
Файл ограничен64MiB, UTF-8 проверяется строго. Вывод содержит только
sourceKind/revision/state checksum/file checksum/counts и integrityOnly=true;
state, IDs, тексты, токены и абсолютный путь не печатаются. Ошибки — безопасный
code, exit1. Успех — exit0. Команда не пишет ни staging, ни исходный файл.

Проверяются обязательные users/meetings/tasks и optional events/faculties,
непустые IDs и дубликаты внутри сущности; Telegram IDs при наличии должны
быть уникальными каноническими положительными decimal strings в пределах
PostgreSQL bigint, как в `SimulationState.User` и Sheets reader. Числовой JSON
тип отклоняется: IDs не приводятся через потенциально неточный Number. Legacy competencies —
массивы уникальных непустых строк, не SQL objects. availabilities/messages
должны быть словарями. Это structural gate, **не полная валидация полей/FK**.

Дополнительно проверяются ссылки встреч: hostId, participants (либо `all`),
audienceUserIds, attendeeIds и ключи rsvpByUser должны существовать в source users;
списки не содержат дублей, RSVP только yes/no; eventId при наличии существует
в source events. Исторические/неактивные users не отфильтровываются. Противоречие
attendeeIds=yes и явного RSVP=no сохраняется для существующей Java-проекции,
где явный ответ приоритетен; host не становится автоматически attending.
Это не разрешение audience: проверка принадлежности RSVP окончательно resolved
audience остаётся в `LegacyMeetingRsvps`, не дублируется догадкой для `all`.

Повторная приёмка этого блока: synthetic meeting references, duplicate/missing
users/events, неверный RSVP, Telegram string bounds и отсутствие округления.
При сверке настоящего source-типа исправлено прежнее ошибочное требование
числового Telegram ID; regression использует строку в обоих writer formats.
Повторно успешны `verify-legacy-snapshot`, `verify-database-recovery-journal`,
`npm run lint` (exit0) и `git diff --check`. Maven/Docker не запускались.

## Проверки и остаток

### Byte archive admission review —18.10.2026

Перед DB staging обнаружено: TextDecoder по умолчанию снимал UTF-8 BOM, поэтому
fileChecksum мог соответствовать decoded text, но не оригинальным байтам файла.
Теперь ignoreBOM=true сохраняет marker символом, JSON gate отклоняет нештатный
BOM input, а не меняет его ради приёмки. Fatal UTF-8 остаётся. Synthetic BOM
fixture отвергается без изменения байтов; валидные Cyrillic/emoji/combining-mark
данные проходят с fileChecksum=SHA256 реального Buffer. Suite/lint exit0.

DB foundation scope согласован: reuse V005 migration_runs/migration_rejects,
V041 зарезервирована за B-09 для raw immutable source/quarantine staging, без
дублирования ledger/HTTP/apply/notification jobs. Пока B-08 проверяет свои Java
изменения, V041/Java/SQL/inventory не создаются. Foundation ещё НЕ реализована
и не принята. Порядок: B-08 release окна → B-09 implementation+exclusive PostgreSQL
tests (hash/revision/idempotent/conflict/rollback/no outgoing effects).
Admission state checksum нельзя вычислять Java пересериализацией вместо Node
JSON.stringify; raw file hash проверять по оригинальным bytes. Future staging
не должно повышать run до validated/imported только по archive integrity.
B-09 остаётся оценочно55%, общий44/67; исправление boundary не закрывает этап.

### TIME-01 owner gate снят; task due projection —18.10.2026

Прямой ответ человека «да, давай в это время» проверен read_thread с точным
предыдущим вопросом. Подтверждено: старые date-only deadlines→23:59:59.999МСК,
original date сохраняется. Решение отмечено в TIME-01/B-09; прежняя запись об
остановке ниже — история. Владелец не разрешал менять production.

TaskProjection reuse projectDateDeadlineInstant и strict full-year validation;
сохраняет legacyDeadline/status/created/completed/cancelled timestamps. Нет
current-year/current-admin/current-time default. Полнота lifecycle сверена с
V003 CHECK: completed/cancelled timestamps должны соответствовать статусу,
createdAt обязателен target. Missing history только incompleteHistoryRows,
не дата импорта. Historical fixedUTC+3/IANA mismatch остаётся clockReviewRows:
approval обычного deadline rule не разрешает молча менять такие случаи.
CLI raw projection исключён, только counts/hash/owner-decision marker; DB apply нет.

Synthetic year boundary/leap/end-of-day/legacy dotted date, complete/incomplete
completed/cancelled history, clock2010 flag, repeat/CLIprivacy tests и final
verify-legacy-snapshot/lint успешны(exit0). Source неизменен, Maven/Docker нет.

### Остановка перед owner gate TIME-01 — 18.10.2026

При переходе к task target due_at сверены todo.md TIME-01 и B-09: правило новых
date-only задач — конец дня МСК; перенос прежних18:00 требует отдельного решения
владельца. Это не разрешение подставить23:59:59.999 всем legacy rows автоматически.
Для одной date при условном прежнем18:00МСК сдвиг до конца дня составляет
5ч59м59.999с; реальная прежняя зона ОС/исторические исключения этим не доказаны.
Текущее due_at mapping не реализовано. Оба heartbeat megabot/megabot-b-09
приостановлены, второй чат уведомлён, владельцу задан вопрос о policy. Source
snapshot/production не читались/не менялись, данные и previous acceptance сохранены.
B-09 остаётся оценочно52%, общий44/67; это остановка для решения, не закрытие этапа.

### Pure meeting temporal/audience evidence — 18.10.2026

Прослежены projectTime, meetingKind, audiencePolicy/stateMaintenance, V033 и Java
LegacyMeetingRsvps. In-memory meetingProjection сохраняет startsAt по действующему
Node projectDateTimeInstant, sourceOffsetMinutes180, duration hours→minutes,
status/host/source Calendar ID; missing kind использует штатный normalizer.
Не вызываются create/Calendar sync/уведомления. Исходные поля вне подмодели всё
ещё хранятся в original state/checksum; это не полный Meeting INSERT DTO.

Важно: Node source использует fixed UTC+3, IANA Europe/Moscow исторически имел
другие offsets. Reuse projectClock сравнивает target wall clock с исходными date/time;
расхождение даёт targetClockCompatible=false/incompatibleTemporalRows, не silent
пересчёт. Исторический setup13h также сохраняется780min с incompatibility marker,
а не обрезается до720. Actual target staging обязан остановиться на таких rows;
этот CLI пока только read-only отчёт и не разрешает apply.

Audience берётся **только** из явно сохранённого audiencePolicy=snapshot;
IDs сохраняются даже для inactive users, без current-active filtering/добавления
host. Missing snapshot list, неизвестная policy и RSVP/attendee outside snapshot
отклоняются. Неснапшотные all/selected не интерпретируются заново: audienceUserIds
projection=null, unresolvedAudiences++. Это доказательство неполноты, не выдача
приглашений/прав. RSVP projection остаётся в существующем Java helper: yes/no
override attendee fallback, host не становится автоматически yes; дубль Node
алгоритма не добавлен.

CLI raw meetingProjection исключён; только versioned counts/hash. Synthetic
midnight/Moscow/minutes, inactive explicit snapshot, unresolved old audience,
historical clock2010, setup ceiling, Calendar ID privacy и source immutability
прошли с final `verify-legacy-snapshot`/`npm run lint` (exit0). Maven/Docker нет.

### Availability settings и idempotency source contract — 18.10.2026

Проверены normalizeAvailabilityConfig и src/idempotency.ts. Настройки при наличии
валидируются без Number/coercion/default/clamp: weekCount2–5, hours0–23,
start<=end, уникальные непустые activeDays0–6, saved ISO Monday anchor.
Metadata keys уже датированы и сохраняются вне текущего horizon; name/description
строковые. Старые positional names/descriptions сохраняются без перенумерации;
если непустые labels не имеют ни source anchor, ни dated metadata — explicit
ambiguous_legacy_week_labels, а не привязка к сегодняшней неделе.

Idempotency inventory дополнен в существующем runtime report: actor+key уникальны
**без operation в ключе**, как в findIdempotencyRecord. Одинаковый key разных
actor допустим. Body hash64hex, processing/completed, created timestamp и completed
timestamp/response status проверяются. Cached responseBody сохраняется как source
JSON, но CLI не печатает key/actor/response; только counts/status/checksum,
replayAllowed=false. Старые записи не подмешиваются к Java HTTP idempotency store
и не дают права повторно выполнить операцию/восстановить session.

Synthetic suite использует настоящие reserveIdempotency/completeIdempotency;
проверяет two actors/same key, completed cached response и processing, corrupt
statuses/hashes/timestamps/scope duplicates, CLI privacy. Schedule boundaries,
archive metadata/labels и malformed/reversed/ambiguous config проверены.
`verify-legacy-snapshot`, `npm run lint` успешны (exit0). Нет DB/network/runtime
writes и новых dependencies; safe source validation не заменяет migration policy.

### Legacy runtime queue inventory — 18.10.2026

Source types и stateMaintenance для pendingImportantNotifications,
notificationDeliveries и telegramInbox прослежены. Gate проверяет shape/IDs,
дубли, delivery dedupe keys, nonnegative safe attempts, точные Node statuses,
обязательные timestamps, inbox object payload/chatKey и pending boolean silent.
Нет clean/filter/default-planned/default-received/default-now, которые могли бы
оживить неизвестную старую запись. Missing optional queues остаются missing;
null и malformed rows отклоняются, не стираются.

CLI отдаёт только runtimeInventory: version, replayAllowed=false и per-collection
counts/byStatus/checksum без IDs/text/payload/chatKey. Sending/unknown остаются
исходными sending/unknown, не planned/retry. `legacy_pending` — только отчётная
группа старой important queue без статуса, не новая delivery state.
Это **read-only classification, не durable quarantine/import/reconcile**;
никакой scheduler/consumer этим результатом не питается. Original settings целиком
под source checksum; payload/unknown extra fields сохранены. Counters не доказывают
реальный Telegram outcome. Перед staging/apply требуется отдельная policy/ledger
для unknown/in-flight и проверка runtime-файлов вне snapshot; этого gate не решает.

Synthetic suite покрывает все8 Node delivery statuses, processing inbox, pending,
malformed/double IDs/dedupe/status/types/dates и CLI privacy на непустых queues.
Новых dependencies, env/network/DB/job writes нет; Java/Docker не запускались.
Финальные `verify-legacy-snapshot`, `npm run lint` и diff whitespace check
успешны (exit0). Внешний source snapshot/production не читались и не менялись.

### Pure birthday/author attribution projection — 18.10.2026

V001/V003 target constraints просмотрены. In-memory identityProjection содержит
для каждого source user day/month/year (отсутствие — null, yearless год остаётся
null), а не придуманный2000/current year. Target birthday_year ограничен1900–2100:
прочий известный год теперь explicit unsupported_target_birthday_year, не потеря
года и не silent truncate. Source birthday строка остаётся под original checksum.

Для task creator/completedBy/cancelledBy, task-comment author и event createdBy
строятся отдельные historicalAuthors: nullable resolved userId плюс неизменный
sourceAuthorId и legacySource=true. Missing/null/empty/unknown не превращаются
в текущего admin; существующий inactive user сохраняет корректную FK. Комментарий
идентифицируется taskId и JSON tuple(owner,commentId,field), без неоднозначного
склеивания legacy IDs. Snapshot users refs — единственный источник разрешения.

Projection стабильно сортируется на копиях. CLI исключает raw identityProjection,
выдаёт только versioned counts/hash/unresolved count. LegacyMissingTaskAuthors
по-прежнему считает только task/comment mentions, не новые event mentions.
Это подготовленная attribution подмодель, **не DB schema extension/INSERT**:
tasks/events ещё требуют durable legacy-attribution storage contract до apply;
legacy_source comments уже существует. Не утверждается, что nullable FK одна
сохраняет original authorship. No DB writes/jobs/notifications/credentials.

Synthetic yearless/leap/year bounds, unknown/null/known inactive authors,
deterministic repeat/hash sensitivity и CLI с непустыми private attribution
прошли вместе с TypeScript lint (exit0). Source остаётся неизменным; Maven/Docker
не запускались. Stage/apply/реальные snapshot provenance ещё открыты.

### Pure dated availability projection — 18.10.2026

После полного existing source gate строится in-memory availabilityProjection:
userId/anchor, slots(date,hours), hardUnavailableDates, outWeekStarts и уже
датированные weekVersions. DayIndex прибавляется к saved anchor в UTC один раз;
outWeekIndex умножается на7, version keys копируются без сдвига. Нет today,
timezone ОС, clipping/history filter и default version. Пустые day entries также
сохраняются; порядок user/day/hour стабилизируется на копиях, original не меняется.
Overflow за four-digit date range отклоняется явно.

CLI исключает raw projection вместе со state: печатает только versioned
availabilityProjectionSummary (users/days/slots/hardUnavailableDays/outWeeks/hash).
Это lossless date-based подмодель availability, не INSERT SQL и не окончательные
availability_weeks/days target rows: target IDs/version/default/state semantics
и staging writer ещё требуют отдельного DB acceptance. Отсутствующие optional
source arrays/version map представлены пустыми в projection, но source остаётся
под исходным checksum. Никакой новой отправки/job/DB write.

Synthetic cases: old2020→2021 anchor, day34/hour23, out week и dated versions,
input permutation stability, immutable source, overflow и CLI privacy with
nonempty availability. Проверка использует обычный Node Date/crypto, без dependency.
Финальные `verify-legacy-snapshot`, `npm run lint` и `git diff --check -- backend.md`
успешны (exit0). Java/Docker проверки не запускались; это не полный importer gate.

### Birthday source gate — 17.10.2026

Переиспользован чистый `birthdayParts` из действующего Node потока (модуль при
импорте не делает env/network/отправок). Принимаются DD.MM без года, DD.MM.YYYY
и YYYY-MM-DD; empty/undefined означают отсутствие. Двухзначный год запрещён
до parser, чтобы не угадывать столетие. Yearless29.02 остаётся без года:
внутренний leap reference2000 валидирует только месяц/день, в source не записывается.
Неверные календарные даты/типы/лишний whitespace отклоняются, не исправляются.
CLI добавляет только aggregate birthdaysWithYear/birthdaysWithoutYear.
Synthetic leap/century/yearless/invalid inputs и immutable original tests включены
в существующую suite. Target birthday-day/month/year projection ещё не реализована.

### Identity source roles и catalog refs

User types, Sheets reader, stateMaintenance и server user mutation прослежены.
Offline gate требует одну из четырёх известных ролей, string username/realName/
avatarSeed, optional boolean registered/active/telegramConnected без coercion.
Unknown role не подменяется organizer (в отличие от UI normalization).
Faculty ref проверяется по source faculties; competencies/primary — по
facultyCompetencies для faculty_* и competencies для core, как в server mutations.
Дубли/unknown catalog values отклоняются без тихой фильтрации; optional empty
faculty/primary сохраняются. Неактивные/незарегистрированные historical users
остаются в source, не исчезают из refs. Username не используется как identity.

Synthetic suite покрывает все четыре роли/разные каталоги, inactive history,
wrong role/array/string flags/unknown refs/duplicates. Старые negative Telegram
fixtures дополнены валидными identity fields, чтобы проверять именно Telegram
boundary, а не останавливаться на роли. Финальный suite/lint проверены отдельно.

### Полные календарные даты задач и мероприятий (последний gate)

Этот gate уточняет предыдущие записи ниже о raw starts/ends preservation:
старые поля всё ещё не преобразуются, но непустая дата теперь обязана содержать
четырёхзначный год и существовать в календаре. Общий fullDate переиспользован
для meeting.date/task.deadline/event.startsAt/endsAt, без второго date parser.
Source task API использует parseProjectLocalDate, DatePickerField — date, Sheets
сохраняет deadline строкой. Offline gate намеренно строже интерактивного API:
yearless/двухзначный год нельзя выводить из момента импорта.

Task deadline обязателен, historical past deadline допустим независимо от status.
Optional event dates могут отсутствовать/быть пустыми. ISO datetime вместо date,
неполные/неверные даты/null отклоняются для разбора, не обрезаются до дня.
Это **не решение TIME-01**: due_at/конец дня/notification cutoffs не назначаются.
Original строки и checksum не меняются; старые completed/cancelled не исчезают.
Synthetic deadline/event format boundaries и final suite/lint прошли (exit0).

### Canonical source entity fingerprints

Существующий read-only CLI теперь выдаёт entityHashes и
fingerprintFormat=`legacy-source-entities-v1`. SHA-256 для каждой известной
source collection включает все её поля, включая неизвестные текущему validator,
чтобы не скрывать утрату исторических данных. Object keys сортируются ordinal;
top-level users/meetings/tasks/events/faculties копируются и сортируются по ID.
Вложенные массивы, catalog order, history/message order сохраняются как значимые.
Неизвестные top-level поля остаются под original state checksum; отдельный
entity hash для них не выдаётся. Optional missing collection не заменяется []:
набор hash keys также надо сравнивать при будущем reconcile.

Это source fingerprints, **не хеши PostgreSQL target rows** и не cross-language
canonical standard/JCS. Будущий target reverse projection обязан согласовать
тот же source contract до сравнения. Original state checksum/file checksum
остаются побайтовыми и не заменены canonical hashes. Hash не подпись и не
анонимизация: отчёт, особенно hash settings, хранить как внутренний артефакт.
CLI не печатает содержимое/IDs/аватары/секреты и не записывает manifest сам.

Synthetic suite доказывает стабильность при row/object-key reorder, изменение
hash при изменении private field без изменения count, независимость collections,
значимость порядка nested/catalog arrays, отсутствие source mutation и передачу
hashes через CLI без payload. Новых зависимостей нет. Первоначальный lint выявил
недоступный в текущем TS target toReversed; заменён обычным copy+reverse без
изменения tsconfig/runtime требований.
Финальные `verify-legacy-snapshot`, `npm run lint` и diff whitespace check
успешны (exit0). Maven/Docker/DB/network не использовались.

### Events и avatars

WorkEvent/Sheets reader и API создания events прослежены: name непустой,
status active/archived; optional description/startsAt/endsAt/createdBy строки.
startsAt/endsAt API сохраняет напрямую, поэтому validation сохраняет их без
interpretation/угадывания года. Unknown historical createdBy сохраняется,
не заменяется админом; nullable attribution mapping ещё обязан сделать staging.

Avatar source проверяется по существующему `stateMaintenance` контракту:
data:image/jpeg|png|webp;base64 prefix (case-insensitive), до300000 символов.
Undefined/empty — отсутствие, null/remote URL/SVG/oversize отклоняются, не удаляются
молча. Добавлен aggregate avatars count. Это проверка source string/prefix/size,
не декодирование и не доказательство валидного изображения. Original bytes/строка
сохраняются без перекодирования; fixture больше Sheets cell limit (60000+ chars)
проверяет неизменность уже реконструированного chunked-reader значения.

Synthetic archived/raw-date/missing-historical-author event, wrong fields/status,
avatar prefix/type/size и сохранение большого значения проверены.
`verify-legacy-snapshot` и `npm run lint` успешны (exit0).

### Source timestamps (без guessing)

Writer sites `server.ts` используют `new Date().toISOString()` для сообщений
и audit/history times, Sheets сохраняет строки без преобразования timezone.
Gate принимает точный четырёхзначный YYYY-MM-DDTHH:mm:ss.sssZ; parse→toISOString
дополнительно запрещает нормализацию невозможных дат/24:00. Неуказанные optional
поля и legacy empty string остаются неизменными; null/локальные даты/offset
timestamps/нештатный формат отклоняются для отдельного разбора, не округляются.
Message.timestamp обязателен. Проверены users joined/lastSeen/deactivated,
availability.updatedAt, event.createdAt, task created/completed/cancelled,
note updatedAt/history createdAt и reminder sent/lastSentAt.

Event startsAt/endsAt — **не audit timestamps**: API хранит пользовательские
строки напрямую, поэтому их этот gate не интерпретирует. Birthday и task deadline
также не угадываются, TIME-01 не решается этим изменением. Full event/settings/
avatar contract пока открыт. Synthetic impossible-date/local/offset/empty/null
message и malformed task/note/reminder timestamp tests успешны вместе с lint.

### Task refs и история сообщений

Task eventId/facultyId проверяются по source catalogs. Undefined и пустая строка
сохраняются как legacy отсутствие ссылки (так пишет/читает Sheets); null,
нестроковые и неизвестные refs отклоняются. Никаких догадок по названиям.
Messages dictionary требует существующего owner, совпадения message.userId,
непустого глобально уникального ID, sender user/bot, string text/timestamp.
Optional buttons — массив string text/action. Исторические action сохраняются
как данные, не выполняются/не превращаются в новые live callbacks.
Добавлен aggregate botMessages count без текста/IDs в CLI. Source не меняется.
Timestamp пока проверяется только по типу, не объявлен валидированным instant.

Synthetic приёмка: сохранение old message/button и связанных/несвязанных tasks,
missing refs/owners, duplicate IDs, malformed content/buttons/timestamp type.
`verify-legacy-snapshot` и `npm run lint` успешны (exit0); Maven/Docker отсутствуют.

### Задачи: назначения, комментарии, напоминания

Прослежены Task/TaskAssigneeNote/TaskReminder и обе стороны Sheets serializer.
Проверяются известные статусы включая waiting/in_progress/completed/cancelled;
assignedTo — null либо уникальный список существующих source users. Владельцы
assigneeNotes/completionComments должны существовать; комментарии текстовые,
history имеет непустые уникальные IDs в пределах note и сторону executor/coordinator.
Reminder IDs уникальны в задаче, type before_deadline/repeat, unit days/hours,
value — положительный safe integer. Sent metadata сохраняется без replay.

Исторические creator/completedBy/cancelledBy/comment.authorId допускают
отсутствие или неизвестного автора: original ID не стирается и не заменяется
текущим admin. Вывод содержит только aggregate legacyMissingTaskAuthors
(число упоминаний, не уникальных людей). Это staging attribution worklist,
не готовая nullable FK conversion: будущий writer обязан сохранить attribution
отдельно от nullable target author FK. Активные назначения и comment owner
с неизвестными пользователями по-прежнему отклоняются.

Никакие timestamps/deadlines не угадываются и не нормализуются этим блоком.
Полная проверка этих полей, task event/faculty/catalog refs и разрешение TIME-01
остаются открыты. Test fixture сохраняет completed/cancelled историю, неизвестного
автора, null historical author и уже sent reminder неизменными. Негативные cases:
missing/duplicate assignees, malformed comments/history, duplicate reminders,
неизвестные units/status и неправильный value. После final edits synthetic
`verify-legacy-snapshot` и `npm run lint` успешны (exit0).

### Слоты и сохранённые недели

Проверены `availabilityConfig`, `availabilityWeekMutation`, Sheets reader/writer:
slots — absolute day index от сохранённого weekStart; outWeekIndexes — индексы
недель от того же anchor; weekVersions уже содержит ISO dates. Offline gate
требует существующего user, совпадения dictionary key/userId и явного ISO Monday
weekStart. Missing anchor не выводится из updatedAt или сегодняшнего дня.
`alignAvailabilityToWeek` не вызывается: его fallback/clipping годится UI,
но может сдвинуть или потерять историю импорта.

Разрешён полный известный legacy horizon до пяти недель (day0–34, week0–4),
не текущий сокращённый horizon настроек. Hours — целые0–23; дубли, строковые
индексы часов, неоднозначные day keys, missing refs, out-of-horizon и конфликт
непустых slots с hardUnavailable/out отклоняются, ничего не отбрасывается тихо.
weekVersions проверяются как датированные Monday keys с nonnegative safe integer,
не смещаются и не обрезаются относительно сегодняшней недели. Исторические
hours не фильтруются сегодняшними activeDays/startHour/endHour.

Это validation gate, **не готовая конверсия/запись date-based rows**. Исходные
индексы и anchor сохраняются неизменно; будущий staging writer должен один раз
перевести dayIndex в weekStart+dayIndex дней, outWeekIndex в weekStart+7*index,
а weekVersions оставить уже датированными. Synthetic suite проверяет старый
anchor на границе года, day34/hour23, immutable original, duplicates/conflicts,
invalid/null fields, missing user/anchor и запрет fallback по updatedAt.
После финального null-field review `verify-legacy-snapshot` и `npm run lint`
успешны (exit0), whitespace check чистый; Maven/Docker не запускались.

### Даты и исторические встречи

Offline gate переиспользует `parseProjectLocalDate`, но перед ним требует явно
четырёхзначный год: YYYY-MM-DD или D.M.YYYY. Yearless и двухзначный год
отклоняются, а не дополняются текущим годом/столетием. Календарная проверка
включает високосные годы; время H:mm/HH:mm — 00:00–23:59 без секунд.
Source duration хранится в часах (`duration_hours` Sheets reader), проверяется
положительное число с целым безопасным количеством минут. Ни прошедшие даты,
ни исторические duration не ограничиваются правилами создания новой встречи:
completed/cancelled сохраняются, старые setup не округляются до целых часов.
Kinds при наличии только meeting/setup/vibe, statuses scheduled/completed/cancelled.
Никакого пересчёта по timezone машины или применения состояния «сейчас» нет.

Synthetic regression покрывает leap/century dates, отсутствующий/двухзначный
год, неверные дни/месяцы, midnight/23:59, malformed time, hour→minute units,
completed/cancelled историю и неправильные kind/status. Новые ограничения
не являются готовой staging-моделью: original/checksum не меняются, временные
значения пока не записываются в PostgreSQL.
Приёмка после финального review: `verify-legacy-snapshot`,
`verify-project-time`, `npm run lint` успешны (exit0); diff whitespace check
успешен. Негативные tests также запрещают type coercion массивов в kind/status.

Пройдено:

```powershell
node --import tsx scripts/verify-legacy-snapshot.ts
node --import tsx scripts/verify-database-recovery-journal.ts
npm run lint
```

Новая suite использует настоящий recovery writer, проверяет оба формата,
повторяемость, неизменность оригинала, mismatch/checksum/revision, malformed
JSON/UTF-8, дубли/типы коллекций, ошибочные CLI arguments и отсутствие private
fixture text в выводе. Первая TypeScript-проверка выявила narrowing; исправлена
обычным never-returning function, повтор успешен. Catalog shape сверена с
SimulationState, добавлены негативные тесты. Maven/Docker не запускались.

Далее нужны проверенный ready source manifest и неизменяемая копия оригинала,
полная row/FK/date/slot/history validation, staging/rejects/ledger, атомарный
apply/replay/conflict policy, counts/canonical hashes и Java/frontend parity.
Не считать integrityOnly=true разрешением импорта. B-09 остаётся открытым.

## Versioned private-safe preflight report —18.10.2026

CLI теперь выдаёт `format=legacy-preflight-v1` через явный allowlist
`legacyPreflightReport`, а не rest/spread после исключения известных raw полей.
Добавление внутренней projection в inspector больше не публикует её автоматически.
Сохранены прежние source/file checksums, revision, counts, versioned entity hashes,
четыре summary и runtime inventory; raw state/IDs/text/projections не выводятся.
Новых команд, зависимостей, файлов вывода, HTTP/БД обращений нет.

Это воспроизводимый отчёт о проверке, НЕ trusted manifest, подпись, доказательство
ready Sheets export или разрешение apply. Ожидаемые checksum/revision по-прежнему
нужны из независимого согласованного источника. Будущий importer обязан связать
отчёт с точными archived bytes и проверенным инструментом/запуском; произвольный
JSON с passed=true доверия не создаёт. Normalized target validation остаётся отдельно.

Synthetic suite проверяет точный набор output keys, deterministic report, отсутствие
нового private canary field и полное соответствие CLI/recovery report, сохраняя все
старые negative/Unicode/immutable/privacy cases. `verify-legacy-snapshot` и
`npm run lint` успешны. Это privacy/contract hardening, B-09 остаётся оценочно63%,
общий44/67(65.7%); accepted trusted provenance этим не заявляется.

## Identity target review —18.10.2026

Сверены V001 users/user_competencies constraints и реальный Node cleanUser:
Java требует deactivated_at для inactive; Node может сохранить active=false
без даты и нормализует active=true+deactivatedAt в inactive. Primary competency
Node добавляет в membership автоматически, тогда как импорт не должен молча
менять исходный набор. Поэтому identity summary теперь содержит отдельные
`inactiveWithoutTimestamp`, `contradictoryActiveRows`, `primaryOutsideMembershipRows`.
Это review counters, не automatic repair/reject approval; исходные flags/list/date
остаются неизменными под source checksum. Identity projection checksum по-прежнему
описывает только birthdays/authors, не эти compatibility counters.

`deactivatedBy`, если задан, проверяется как historical author и сохраняется
в raw identity projection: original ID + resolved nullable userId + legacySource.
Неизвестный/deleted author не подменяется администратором. CLI публикует лишь
summary; missing user-author не увеличивает legacyMissingTaskAuthors. Это ещё
не durable attribution table/nullable target mapping и не полный user INSERT DTO.
Synthetic inactive/contradictory/membership/known+unknown author/type/privacy tests,
вся offline suite и TypeScript lint успешны. B-09 оценочно64%, общий44/67(65.7%).
Ponytail full: Node crypto/JSON/fs и установленный tsx, reuse recovery writer,
без новой зависимости, JSON-парсера, env/сети/миграции/production-писателя.

## Faculty/event admission —18.10.2026

V001 faculty.name NOT NULL UNIQUE и work_events ends_at>=starts_at проверяются
до staging: отсутствующее/нестроковое/пустое имя факультета, точно повторяющиеся
имена разных IDs и обратный диапазон дат мероприятия отклоняются безопасными
reason codes. ID/FK проверки сохранены. Нет casefold/trim: Same/same/ Same
остаются разными исходными именами. Компетенции core/faculty имеют разные scope.
Сравнение дат reuse fullDate/parseProjectLocalDate и календарный ordinal,
без today/timezone/default-hour. Равные даты, разные допустимые date formats,
граница года и одна пустая граница поддержаны без изменения raw source.

Synthetic suite покрывает invalid/exact duplicate names, distinct casing/whitespace,
valid/reversed mixed-date ranges. Старые FK fixtures теперь имеют id+name по
реальному Faculty contract; проверки не ослаблены. Offline suite/lint успешны.
Timestamp mapping work_events/missing created_at остаются target gates.
Подблок100%; B-09 оценочно64%, общий44/67(65.7%), importer/apply ещё открыты.

## PostgreSQL text admission —18.10.2026

Preflight проверяет весь parsed original, включая object keys, unknown extensions,
массивы и recovery envelope: NUL/U+0000 и unpaired UTF-16 surrogates отклоняются
`unsupported_postgres_text` до отчёта passed. Это необходимо для JSONB casts
staging/reconciliation; корректная UTF-8 byte decoding сама по себе недостаточна,
потому что escaped JSON может содержать такие значения. Unicode code-point iteration
сохраняет валидные пары/эмодзи, combining marks и соседние допустимые code points.
Литерал из символов backslash-u0000 не путается с NUL; замены/нормализации нет.

Synthetic tests: keys/values/user names/unknown arrays/envelope, valid Cyrillic,
emoji/combining/boundary points/escapes, CLI safe exact reason и immutable bytes.
Node suite/lint успешны. Независимый PostgreSQL parity test подтверждает JSONB
отказы и допустимые строки на настоящем Testcontainers PostgreSQL; focused
**18 tests,0 failures/errors/skipped,BUILD SUCCESS41.997s**, log
`backend/target/legacy-postgres-text-admission.log` (17 staging + inventory).
Service/schema не менялись. Прямой обход preflight по-прежнему не является
одобренным импортом; Java archive не объявлен полным валидатором. Runtime/prod
не затронуты, этот gate не закрывает provenance/seal/normalized apply.
Подблок100%; B-09 оценочно64%, общий44/67(65.7%).

## Task source fields and integer admission —19.10.2026

Сверены Task source type, cleanTask и V003. Preflight теперь требует строковые
title/description/sow, строковый массив tips с сохранением порядка/пустых элементов,
priority normal/important/critical; optional version — nonnegative safe integer,
assignmentMode — shared. Старые поля не дополняются defaults, не trim/round/coerce.
Optional competency/competencies проверяются по типу/непустым именам/дубликатам;
разрешение scope/catalog и scalar/list conflict ещё не объявлены завершёнными.

timeSpentMinutes, если задан, должен помещаться в nonnegative PostgreSQL integer;
reminder.value — positive PostgreSQL integer. Reminder IDs проверяются глобально
по всем задачам, поскольку V003 PK task_reminders(id), не только внутри одной
задачи. Source IDs не переименовываются, конфликт не скрывается namespaces.
Ограничения обнаруживаются до DB writes; прошлые completed/cancelled records
с missing timestamps всё ещё отмечаются review-флагом, не получают invented now.

Synthetic tests: malformed/absent text, priority/tips/version/assignment types,
fractional/negative/overflow effort, reminder integer overflow и cross-task ID
collision; positive zero/max integer, max safe source version, preserved tip order.
Основная task fixture приведена к действительному typed source contract вместо
ослабления проверки. Вся offline suite и npm lint успешны; новых зависимостей,
Java/schema/runtime edits или Maven/Docker запусков в этом блоке нет.
Подблок100%; B-09 оценочно65%, общий44/67(65.7%). Trusted manifest, normalized
target staging, durable attribution, atomic apply и frontend parity ещё открыты.
