# B-09: isolated source archive / staging foundation

18.10.2026. Ponytail full: reused V005 `migration_runs` / `migration_rejects`,
installed Jackson/JDBC and standard Java UTF-8/SHA-256. No second migration ledger,
dependency, HTTP endpoint, CLI runner, domain command or outgoing job was added.

## Boundary

V041 adds `legacy_snapshot_sources` and `legacy_staging_records`. The service
`LegacySnapshotStaging` is absent unless `megabot.legacy-staging.enabled=true`.
Only disposable integration tests enable it in this acceptance; no environment,
production schema, database, consumer or sender was switched.

The original input is cloned before hashing/parsing. File SHA-256 is checked on
exact bytes in Java and independently by a PostgreSQL CHECK. UTF-8 is strict;
BOM, duplicate JSON keys and trailing JSON values are rejected. Required state
collections/IDs, duplicate entity IDs, safe revision and optional recovery-v1
envelope are checked. Entity records are staged separately; dictionaries,
catalogs, settings/runtime queues and unknown top-level fields remain opaque
source fragments. The original bytes remain the authoritative lossless source;
JSONB fragments are not an original-file substitute.

The existing `(source_revision, source_checksum)` ledger identity is inserted
once, then locked in the same transaction. Repetition of identical bytes returns
the same run. Different bytes/kind for that identity fail, including another
writer format for the same state. A pre-existing unrelated ledger run without
an archive cannot be silently adopted. Status/statistics are not reset on repeat.

Ordinary UPDATE/DELETE of archived source/records and UPDATE of archived ledger
revision/checksum are blocked by PostgreSQL triggers; foreign keys prevent ledger
deletion. This is application-level immutability, not protection against a DB
owner's TRUNCATE/schema changes or a replacement for backups. Test cleanup uses
TRUNCATE only on its own disposable database.

Existing fragments cannot be updated/deleted, but the schema does not seal the
record set against an additional INSERT with a new key by another DB writer.
The service never appends on repetition. Downstream validation must reconstruct
and compare against authoritative original bytes (or an approved sealed manifest),
not treat row count/statistics or a supplied state checksum as proof of approval.
The other chat's bounded read-only review found no blocker for archive-only scope
and explicitly identified this remaining seal/validation boundary; it is not a
replacement for execution of the final full suite.

## Deliberately not approved/imported

State checksum is externally supplied Node evidence: Java does **not** claim its
own JSON serialization is Node `JSON.stringify`. The archive statistics explicitly
record `nodeStateChecksumVerified=false`, `archiveOnly=true`; new runs remain
`started`, never `validated`/`imported`. Tests deliberately use unverified external
state evidence to prove this distinction. File hash is integrity, not provenance
or authentication. This foundation does not prove Sheets `ready`, perform full
Node semantic validation, implement durable rejection assessment or apply domain
rows. `migration_rejects` is reused later, not filled with invented outcomes now.

Before any target apply: bind independent approved source manifest, the existing
Node preflight and exact archived file hash; validate all semantic/target limits,
write/reconcile rejects and normalized staging, preserve author attribution,
implement atomic/idempotent apply and frontend parity. Queues/idempotency records
are only opaque archived source, not executable work. No migration is closed here.

## Tests and evidence

Final focused run: **10 tests, 0 failures/errors/skipped, BUILD SUCCESS**:
9 new PostgreSQL/configuration methods plus the existing migration inventory.
Log: `backend/target/legacy-staging-focused-gates.log`.

- Default-off/explicit opt-in Spring configuration.
- Exact Unicode original bytes, opaque extension preservation, `started` and
  unverified state flag; zero domain rows, deliveries, outbox, jobs, audit/rejects.
- Same source twice, immutable source/records/ledger identity, retained subsequent
  ledger status (no accidental downgrade).
- Conflicting original and unrelated existing ledger are not overwritten/adopted.
- Malformed UTF-8/BOM/JSON, duplicate keys/IDs and metadata/hash/revision rejection.
- Recovery envelope matches supplied metadata; incompatible format/revision/hash fails.
- Genuine batch CHECK failure and caller transaction failure roll everything back;
  the identical source can subsequently be retried.
- Concurrent independent transactions stage once and return the same run.
- PostgreSQL itself rejects an incorrect original-byte SHA-256.

Final full verification: **638 tests, 0 failures/errors/skipped, BUILD SUCCESS**,
9:21 min. Surefire XML totals independently match638/0/0/0; the repackaged JAR
exists. This verifies final source, not only the initial focused subset. Earlier
focused runs (9 tests before the opt-in method) remain preliminary evidence.
No compile overlap or skipped Docker tests count as proof. Documentation checks
passed8 guides; final whitespace check is recorded separately.

Isolated output: `backend/target/legacy-staging-verify-20261018`.
Full log: `backend/target/legacy-staging-verify.log`. A temporary Windows
PowerCreateRequest system-required handle lasts only through this verification
and was cleared/closed in `finally`; permanent power settings are unchanged.
The temporary root verification POM was copied to that output directory as
`verification-pom.xml` and removed from the working tree; original `pom.xml`
was not changed. The script/logs/output remain local ignored proof artifacts.

Archive/staging foundation subblock is accepted100%; B-09 remains open,
estimated60%, total plan44/67(65.7%). Full source validation/approved manifest,
normalized target staging/rejects/atomic apply/frontend parity are still required.

## Archive reconciliation — 18.10.2026

The same opt-in service now compares staged records with PostgreSQL JSONB parsed
directly from the immutable original bytes (raw state and recovery envelope).
A full join detects missing, extra and changed fragments independently of saved
counts. Parent/run locks serialize this assessment and block concurrent child FK
inserts until its transaction ends. This is not a permanent seal: later inserts
remain possible, so future approval/apply must seal or recheck under its own lock.

Matching records leave status `started`; no checksum approval, semantic validation,
domain rows or outgoing work is produced. Differences commit a payload-free
`legacy_archive_mismatch` reject and terminal `rejected` status atomically.
Non-started runs cannot be downgraded/reapproved or receive duplicate rejects.
Caller rollback undoes both status and reject. Native BigDecimal tree parsing
preserves decimal precision; previously archived lossy fragments fail this check.

Final focused verification: **15 tests, 0 failures/errors/skipped, BUILD SUCCESS**,
35.147s, `backend/target/legacy-reconcile-final-focused.log` (14 staging + inventory).
Covers both envelopes, repeated success, extra/missing/changed records, precision,
durable refusal, terminal protection, rollback and the prior archive regressions.
The earlier 13-test run was preliminary and is not final-source evidence.
The prior full638 result applies to the foundation revision only; a fresh full
suite and explicit concurrent-insert reconciliation test remain acceptance work.
No B-09 stage closure is claimed. B-09 estimated62%; overall44/67(65.7%).

### Concurrency acceptance protocol — executed

Use the existing Testcontainers database and independent TransactionTemplate
transactions, not a shared test transaction. Hold a successful `reconcile` caller
transaction open behind a latch. A second connection uses transaction-local
`lock_timeout` and attempts an extra child INSERT: it must fail with PostgreSQL
SQLSTATE55P03 while the source parent is locked, leaving no extra record/reject.
Release the caller and join both workers with bounded waits and finally cleanup.
Then demonstrate that a post-commit INSERT is possible and the next reconciliation
detects it: this proves the documented lock boundary rather than a permanent seal.
Also race two mismatch assessments: only one may commit a durable reject, the
second must observe terminal status. Latches establish order; sleep/elapsed-time
assertions and overlapping Maven runs are not acceptance evidence. These cases
were executed after the B-08 exclusive verification window was released.

Final concurrency-focused run: **17 tests, 0 failures/errors/skipped,
BUILD SUCCESS**,40.712s; log `backend/target/legacy-reconcile-concurrency.log`.
16 staging methods plus migration inventory; source/service/schema unchanged.
The two new tests prove actual SQLSTATE55P03 child-insert blocking, post-commit
insertion detection and exactly one reject across two independent assessors.
No sleep or elapsed-time assertions were used. The parent lock is held by the
caller's transaction; this is not a permanent seal or apply authorization.

The other chat's completed full run was independently checked from65 XML suites:
**648/0/0/0**, `backend/target/meeting-causal-verify-20261018/surefire-reports`.
It covers the current reconciliation service and prior14 staging methods, not
the two subsequent concurrency tests; those are covered by the17-test run.
Archive-reconciliation subblock accepted100%; B-09 remains open, estimated63%,
overall44/67(65.7%). Trusted preflight evidence, normalized staging/validation,
permanent seal/atomic apply and frontend parity are still required.
