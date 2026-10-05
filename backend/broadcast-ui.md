# D-11 / TIME-02/04/05: создание, история и безопасные действия

## Что включено

Java `/api/state` возвращает `capabilities.durableBroadcasts=true`; только при этом Mini App показывает расписание и историю. Обычный Node-ответ не содержит этого признака и сохраняет прежний immediate-only flow. Признак интерфейса не заменяет серверные permissions: Java create/list/journal требуют действующую core-сессию и author/admin access.

Safe `users[].telegramConnected` — boolean, не raw ID; preview не путает регистрацию с привязкой. В Java аудитории исключены незарегистрированные и inactive/faculty; зарегистрированный человек без Telegram виден отдельно как unavailable. Истинный snapshot и current gates всё равно определяются сервером при создании/отправке.

Форма сохраняет порядок audience → title/body → time → summary → submit. Нативные now/scheduled radios и date/time всегда подписаны МСК; `projectDateTimeInstant` преобразует 12:00 МСК в 09:00 UTC независимо от OS zone. Сервер проверяет +30 секунд…365 дней; браузер не назначает собственный таймер отправки. Native misfire явно выбирает 15-minute grace или skip после 5 секунд; ограничения transport quota и отсутствие одновременного результата объяснены рядом.

Java legacy create adapter переводит прежние competency names/week index в общий BroadcastService, поэтому форма не дублирует этот выбор и не требует раскрывать внутренние IDs. Combined title/body до 40000, существующая durable part queue V029. Ответ 202 означает сохранение команды, не Telegram sent; результат доступен в истории.

## Повтор и ошибки

Прежний `formDrafts` хранит отдельно user-scoped draft расписания и fingerprint/key команды. Неопределённый ответ, HTTP 500 или reload не стирают их. Повтор **идентичного тела** использует прежний key; изменённое unresolved тело требует отдельного подтверждения новой команды и предупреждения о предыдущей возможной записи. Ключ удаляется только после валидного подтверждённого broadcastId; logout cleanup удаляет оба user-scoped draft. При недоступном browser storage безопасный key не сохраняется, запрос не выполняется.

HTTP создания/истории/журнала ограничен 12 секундами, abort/offline/401/403/non-JSON имеют постоянную inline ошибку. Весь submission fieldset disabled, чтобы ответ не стёр новые правки во время запроса. Pending снимается в finally. Refresh состояния после подтверждённого creation независим и не превращает успех в ошибку создания.

История раскрывается и обновляется явно; limit20 и cursor догружают рассылки. Журнал limit30 отдельно раскрывает адресата/часть/status/attemptCount/sentAt/errorCode. Recipient-level targetCount/deliveryCounts не множатся частями. Unknown имеет предупреждение о возможном дубле, sent — лишь provider confirmation. Loading/error/empty/retry различаются; owner/request generation guards не допускают подмешивание позднего ответа старого пользователя или superseded списка.

## Приёмка 05.10.2026

- `npm run lint`, `npm run build`, `npm run verify:broadcast-client`, `npm run verify:form-drafts` — успешно. Build всё ещё предупреждает об общем chunk >500 kB; это не скрыто и не исправлялось массовым refactor в рамках рассылки.
- Полный backend `mvnw.cmd --batch-mode verify`: **362 tests, 0 failures/errors/skipped, BUILD SUCCESS**, log `target/broadcast-ui-final-verify.log`. B04 HTTP подтверждает capability и safe boolean, без Telegram ID; прежняя очередь/права/конкурентность остаются зелёными.
- Повторяемый браузерный сценарий `scripts/verify-broadcast-ui.js`: lost response, pending release, draft/time reload, identical key, 12:00→09:00Z, truthful queue response, history500/retry/journal, widths320/1024, legacy capability off. Все `/api/**` перехвачены synthetic fixture; реальные БД и бот не используются. В fixture только для unattended reload подавлен beforeunload prompt, не сам код приложения.
- Скриншоты `output/playwright/broadcast-ui/mobile-final.png`, `desktop-final.png`; finish reviewer: все пять замечаний resolved. Async guards проверены reviewer по исходнику, не отдельным browser role-switch race. Native iOS/Android Telegram WebView ещё требует ручной приёмки D-12.

Воспроизведение: запустить только Vite на loopback `127.0.0.1:15173` (`npm exec -- vite --host 127.0.0.1 --port 15173 --strictPort`), затем в отдельной изолированной сессии Playwright CLI выполнить `run-code --filename scripts/verify-broadcast-ui.js`. Проверка не требует Node runtime с bot token или подключения PostgreSQL. Последний результат и скриншоты игнорируемые: `output/playwright/broadcast-ui/acceptance.log`.

## Отмена и ручной повтор 05.10.2026

История использует существующий POST cancel с expectedVersion и подтверждением: уже доставленное не удаляется, начатую отправку нельзя гарантированно остановить. Журнал предлагает acknowledged retry только unknown части текущей revision без replacedBy, с доступной версией и неистёкшим сроком; последнее слово всегда за серверными owner/current gates. Успешные части не повторяются. После подтверждения отмены/повтора история обновляется, журнал закрывается; accepted retry не объявляется delivered.

Общий маленький `broadcastAction` использует прежний formDrafts, отдельный user/path-scoped intent с **исходным телом, версией и ключом**. При потере ответа даже обновившаяся версия не превращает повтор в новую команду. Non-JSON/неполный success сохраняет intent; подтверждённый результат очищает его. HTTP409 очищает отвергнутое намерение и предлагает явно обновить историю/журнал и подтвердить действие заново. Ключи cancel/retry разных частей независимы; logout очищает их. Busy ref блокирует повторное нажатие, pending отключает конкурирующие кнопки; owner/generation/unmount guards отвергают поздний ответ чужого контекста.

`lint`, `build`, client/draft checks успешны; backend focused `BroadcastHttpIntegrationTests,BroadcastPartsIntegrationTests`: **39 tests, 0 failures/errors/skipped, BUILD SUCCESS**, log `target/broadcast-actions-test.log`. Изолированный браузерный сценарий дополнительно проверяет dismiss без POST, потерянный ответ retry с одинаковыми key/body, acknowledgeDuplicateRisk, запрет повтора replaced leaf, cancel409→refresh→новая version/key, cancel success и отсутствие действий после отмены. Log `output/playwright/broadcast-ui/actions-acceptance.log`; снимки `output/playwright/broadcast-actions/320-history.png`, `1024-history.png`. API перехвачены, реальных отправок нет. Смена пользователя защищена в коде; отдельный browser role-switch race пока не добавлен. Native WebView остаётся в D-12.

## Что не закрыто

Финальное Impeccable review этого блока: **3/3 resolved**, remaining clear — блокировка после409 до успешного refresh, mounted guards пагинации/журнала, актуальные PRODUCT/DESIGN. Документация обновлена узко, без смены токенов/бренда; это не закрывает ещё отсутствующие действия ниже.

Перенос только времени и group target selector реализованы ниже; полное редактирование содержимого/аудитории истории и окончательная приёмка остаются открытыми. TIME-02/04/05 и D-11 не закрыты до оставшихся требований и приёмки; B-07 оценочно98%, D-11 оценочно90%, named план40/65, осталось25. Production/live-test runtime/БД/Telegram не переключались, реальных сообщений нет. CHAT-01 по-прежнему последний; birthday hour подтверждён владельцем 05.10.2026: 12:00 МСК, закрытие сбора остаётся 19:00.

## Выбор разрешённых групп и топиков 05.10.2026

Java-форма по capability показывает отдельный режим «Группы и топики». Компонент читает только safe `id/label` из GET `/api/v1/broadcast-group-targets?limit=50`, догружает страницы по cursor, фильтрует названия локально. Название задаёт администратор; из raw Telegram ID тип адресата не угадывается. Группа и её топик — две отдельные отправки. Разрешение не подтверждает доступность бота. Управление разрешениями остаётся API-only, автоматического подключения рабочих групп нет.

Выбор сохраняется в прежнем user draft. Отсутствующие/отозванные/ещё не загруженные IDs не исчезают молча: submit заблокирован до догрузки либо явного снятия. Ошибка списка блокирует отправку, доступно обновление; search не меняет выбранную аудиторию. Смена пользователя/unmount/новая загрузка защищены owner/generation guards. POST `/api/v1/broadcasts` использует исключительно `recipientMode=groups`, `groupTargetIds`, содержимое и прежние поля расписания; личные ID/компетенции/raw bot/chat/thread не передаются. Подтверждение id+targetCount означает очередь; доступность бота проверяется при отправке. Неопределённый ответ сохраняет draft и прежний key/body; после reload выбранные адресаты нужно снова сверить со списком.

Lint/build/client/draft checks успешны. Synthetic Playwright проверяет error→refresh, pagination/search, revoke без молчаливого удаления, явное снятие, empty, групповой POST lost response→reload→идентичные body/key, 12:00 МСК→09:00Z, ширины320/1024, Node gate и прежние создание/history/cancel/retry/reschedule. Log `output/playwright/broadcast-ui/group-acceptance.log`, screenshots `output/playwright/broadcast-groups/320-picker.png`, `1024-picker.png`. Все `/api/**` перехвачены, реальных отправок нет. Focused backend `BroadcastGroupIntegrationTests,BroadcastHttpIntegrationTests`: **44 tests, 0 failures/errors/skipped, BUILD SUCCESS**, log `target/broadcast-group-ui-test.log`; первый запуск без Docker пропустил тесты, после локального запуска Docker выполнен настоящий повтор. Native Telegram WebView, общий bundle >500kB и отдельный browser race смены пользователя остаются ограничениями.

Ponytail full: существующие allowlist/domain/client/draft/UI, без новых runtime dependencies и миграций. Impeccable: узкое расширение существующего мира, brand/layout сохранены, mobile/desktop проверены; finish review **2/2 resolved, remaining clear** после видимого primary+галочка состояния выбранного режима и узкого обновления PRODUCT/DESIGN. После исправлений browser acceptance и build/lint повторно успешны.

## Перенос только времени 05.10.2026

Новая команда POST `/{id}/reschedule` использует общие plan/materialize/queue/quota/audit, не PATCH с пересборкой аудитории. Frozen target snapshot копируется без обновления Telegram binding, состава команды, approval version/bot/topic; исходные title/body/silent/recipientMode/weekStart/misfire сохранены. Транзакционно отменяются прежние claims/deliveries, повышаются revision/version, сохраняются новые части. Parent-before-delivery lock сериализует start; начатая/конечная/отменённая доставка, просрочка или expiry notice запрещают перенос. Atomic rollback не теряет прежнее расписание.

История показывает кнопку по серверному `reschedulable=true`, inline native date/time МСК и итоговый native confirm. Форматирование времени — прежний projectClock/projectDateTimeInstant. Незавершённый редактор хранится в user/entity draft; pending intent хранит исходные тело/версию/ключ и восстанавливает исходное время после reload. Изменённый срок при неопределённом результате отвергается до сети вместо скрытого повторения другого срока. Однозначные400/409/422/429 освобождают отвергнутый intent, чтобы исправить ввод;500/timeout/non-JSON сохраняют его.409 блокирует мутации до успешного refresh; весь fieldset disabled на запрос/конфликт/недоступность переноса. Старый сервер без reschedulable не рекламирует кнопку.

Client/draft checks, lint/build и isolated browser acceptance прошли: Moscow14:30→11:30Z, dismiss без POST, потерянный ответ→reload→исходные body/version/key, server eligibility off; прежние создание/cancel/retry/history/gates320/1024 сохранены. Log `output/playwright/broadcast-ui/reschedule-acceptance.log`, screenshots `output/playwright/broadcast-reschedule/320-form.png`, `1024-form.png`. Все API синтетические; production/live-test/Telegram не использовались. Общий bundle >500kB и native WebView D-12 остаются открытыми.

Полный backend verify: **367 tests, 0 failures/errors/skipped, BUILD SUCCESS**, 5 новых + прежние362; log `target/broadcast-reschedule-verify.log`. Новые проверки: all snapshot без новых людей/обновлённой Telegram-привязки, unavailable/parts/silent/skip/replay; invalid/stale/foreign/expired; перенос vs start; atomic rollback отмены старого; frozen group whole/topic/bot/approval сохраняется после revoke/reapproval, новый topic не получает сообщения. Disposable PostgreSQL с fake transport; реальные БД и бот не использованы.

Impeccable finish review переноса: единственное замечание об устаревшей PRODUCT/DESIGN исправлено; финальный verdict **resolved, remaining clear**. Узкий documenter pass не менял бренд/токены/компоновку. Смена пользователя/закрытие компонента защищены исходником, отдельный browser race пока не добавлен.

Ponytail full: standard time/native controls, прежние UI/formDrafts/legacy adapter, один маленький client flow без новых runtime dependencies. Impeccable сохранил фирменный мир/компоновку, проверил mobile/desktop и закрепил только фактический UX, не переписывая дизайн-систему.
