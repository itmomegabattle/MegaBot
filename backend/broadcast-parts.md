# Части длинных рассылок: B-07 / TIME-04

Оба Java API и PATCH используют общий BroadcastText до постановки в очередь. Title до 120, body до 40000; после strip заголовок + два переноса + body в сумме до 40000 UTF-16 единиц. Часть до 4000 единиц, максимум 20 частей. Конкатенация частей точно равна подготовленному тексту: нет скрытого усечения, нумерации или повторения заголовка.

Стандартный Java regex `\X` сохраняет grapheme clusters: surrogate pair, combining marks, emoji ZWJ, flags и CRLF. Распознанные literal entity tokens (`&amp;`, decimal/hex numeric forms) тоже не делятся. Повреждённый Unicode, неделимый cluster больше лимита и отдельная полностью пустая/пробельная часть дают 400 до записи. Transport остаётся **plain text без parse_mode**: HTML/Markdown не интерпретируются, Telegram entity offsets не принимаются. Сохранение корректной активной разметки потребует formatter в последнем CHAT-01; этот блок не объявляет rich-text поддержку.

## Долговечность и порядок

V029 хранит part_count на target, part_number/part_count на delivery. Один target остаётся одним человеком или разрешённой группой/топиком. Исходный dedupe первой части сохранён, последующие имеют суффикс `:part:N`; UNIQUE запрещает две исходные части одной позиции. Source, targets, все части, quota и audit фиксируются одной транзакцией; ошибка середины откатывает всё.

Общие claim и final start допускают следующую часть только после sent всех предыдущих конечных retry leaves этого target. Claimed/sending/retry/unknown/failed/cancelled/expired не позволяют перескочить вперёд. Другие адресаты независимы. Shared bot/chat quota применяется к каждой физической отправке; creation volume считает sendable targets × parts. Все части сохраняют исходные intended_at/expiry, silent и group/topic snapshot; часы и grace не продлеваются числом частей.

Unknown не повторяется автоматически. Explicit acknowledged retry копирует только выбранную часть и её позицию, сохраняет старый unknown/attempts и исходный expiry. После подтверждения linked retry можно продолжить следующие части; успешные предыдущие не повторяются. Cancel/перенос/current role/binding/group approval gates действуют для каждой части через прежний общий поток.

## Честные результаты

Обычный SQL view `broadcast_target_delivery_summary` используется API и авторским expiry notice. Target sent только при подтверждении всех частей. Unknown имеет приоритет над partial; после хотя бы одной sent и без unknown target partial. API `targets[].partCount/partCounts` показывает состояния частей; `targetCount/deliveryCounts` по-прежнему считают адресатов. Journal имеет `partNumber/partCount`, отдельно от attemptCount. Author expiry notice считает partial recipient один раз и не называет весь текст доставленным.

При blocked/unknown предыдущей части оставшиеся planned части ждут исходного expiry или явного разрешённого действия. Общий expiry maintenance завершает их, а не создаёт бесконечное ожидание. Sent означает подтверждение Telegram, не чтение или push на устройстве. Длинная рассылка и несколько адресатов не могут получить обещание одновременного завершения при transport quota.

## Проверки

05.10.2026 полный `mvnw.cmd --batch-mode verify`: **362 tests, 0 failures/errors/skipped, BUILD SUCCESS**, 13 новых и прежние 349. PostgreSQL 17.11, V001…V029 на чистой тестовой БД и повторный Flyway; OpenAPI parse/local references проверены. Log: `target/broadcast-parts-final-verify.log`.

Три unit tests проверяют границы 4000/40000, точную конкатенацию, emoji/ZWJ/flags/combining/CRLF/entity tokens и отказ неделимого/повреждённого/пустого текста. Десять integration tests: порядок и recipient-level sent, конкурентные workers, unknown/explicit retry, 429 без повтора sent, cancel, частичный expiry notice, оба HTTP routes и oversize, rollback середины с quota/audit, независимость адресатов/unavailable, topic/silent и отзыв group approval. Все transports fake, данные только disposable Testcontainers.

## Граница

Frontend ещё не переключён на этот Java контракт и не показывает части. TIME-04 остаётся открыт для UI подтверждения/журнала; B-07 — для остальных критериев и эксплуатационной приёмки. CHAT-01 остаётся последним с ручной проверкой владельцем. Никакие рабочие или live-test данные и настоящие Telegram-сообщения для этой проверки не используются.

Ponytail full: штатные Java regex, existing queue/sender/journal и один SQL aggregate для обоих потребителей; без dependencies, нового scheduler или параллельной реализации доставки.
