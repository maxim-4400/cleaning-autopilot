# Cleaning Autopilot MVP1 — staged implementation plan

## Назначение

Этот документ задаёт рабочую последовательность для реализации MVP1 более дешёвой моделью и контрольные границы review. Продуктовый контракт находится в `MVP1_REQUIREMENTS.md`, а фактическое состояние проекта — в корневом `PROJECT_CONTEXT.md`.

## Протокол передачи между моделями

- Более дешёвая модель выполняет только явно назначенный этап или подэтап и не начинает следующий.
- После законченного блока она обновляет `PROJECT_CONTEXT.md`, перечисляет изменения, проверки, external side effects и ограничения, затем останавливается.
- Большая модель проверяет diff, локальные checks и релевантный preview/real E2E. Следующий этап начинается только после принятия review.
- Commit, push, изменение draft PR, merge, deploy, cloud migrations, реальные integration writes и платные OpenAI calls выполняются только после отдельного явного разрешения.
- Fake/stub adapters используются по умолчанию; реальные credentials не выводятся и не попадают в Git.

## Текущий немедленный блок — независимый post-merge audit Этапа 3

Этап 3 принят и merged в `main` через PR #4, merge commit `b5087c8`. Перед началом Этапа 4 новый чат выполняет только независимый audit завершённого Telegram → Agents SDK → Quote → Calendar reservation flow по документу `SHERLOCK_CLEANING_HANDOFF_2026-08-21_B5087C8_STAGE3_TO_STAGE4.md`.

1. Полностью прочитать обязательные проектные документы и фактический код.
2. Проверить `main`, clean working tree, merge PR #4 и текущий GitHub CI.
3. Повторить локальный Node 26 gate: lint, source/test typecheck, 71+ unit tests, build, Playwright smoke и `git diff --check`.
4. Провести targeted review Telegram delivery/reclaim/lease, order boundary, Agents SDK limits, quote/lifecycle separation, slot supersede/ownership/expiry, Calendar recheck/create recovery и safe Telegram rendering.
5. Read-only перепроверить актуальность cloud Supabase migration/RPC privileges и Railway production/preview deployments/health.
6. Не выполнять paid calls, cloud writes, migrations, deploy, commit, push, PR или merge без нового явного разрешения.
7. Остановиться с findings и скорректированным планом Этапа 4. Этап 4 не начинать в том же блоке.

## История реализации и review Этапа 3 — завершено

Следующие требования сохранены как история принятых review gates. Они реализованы и merged через PR #4; формулировки о незавершённом PR ниже не являются текущим статусом.

Языковая формулировка этого исторического плана заменена решением владельца 2026-08-22: runtime-ответ выбирает `en` / `ru` / `sr-Latn` / `sr-Cyrl` только из текущего customer text; `New address` не переносит язык и показывает English divider. Актуальный контракт находится в `MVP1_REQUIREMENTS.md` и `PROJECT_CONTEXT.md`.

Подэтап 3A и Calendar correctness приняты. Controlled production E2E подтвердил `New address → Quote → slots → numbered choice → one Calendar event`, persisted reservation и duplicate delivery без второго event. Независимый review клиентского Telegram-диалога выявил блокирующие UX/transport gaps: visible slot UUID, отсутствие Telegram parse mode, технические deterministic templates и нестабильная связь numbered choice с повторной выдачей. PR #4 не merge до выполнения следующего блока:

1. Исправить scheduling boundaries. Availability window рассчитывается от валидного `preferred_date` до конца 14-дневного горизонта, а не от `now`; текущий день никогда не предлагает прошедшее время, same-day остаётся не раньше `now + 2h`. Проверять, что `end` и `buffer_end` находятся в том же рабочем дне и не позже 20:00. Если duration + buffer физически не помещается в 08:00–20:00, вернуть deterministic escalation вместо пустого списка.
2. Сделать Calendar recovery идемпотентным. Повторное предъявление уже claimed token должно позволять прочитать тот же token и существующую `integration_operation`: `succeeded + external_id` восстанавливает reservation fields без второго create; `pending/ambiguous` не повторяет create; Calendar `failed` не переоткрывается generic retry автоматически. Закрыть тестом crash/failure между `completeIntegrationOperation` и `saveLead`.
3. Заменить ручной JSON-RPC POST на поддерживаемый Composio SDK или корректный Streamable HTTP MCP client с handshake/session handling. Read-only получить точные tool names, input schemas и output fixtures из isolated Composio project; разрешить только availability и create event. Валидировать ответы typed/Zod-схемами и fail closed: неизвестный availability payload не считается пустым календарём. Если create schema принимает client event ID, передавать deterministic ID.
4. Исправить lifecycle/quote separation: Calendar conflict, transport failure или ambiguous create может поставить `Human Needed`, но не supersede активный quote и не менять `Qualified`.
5. Сделать Telegram flow пользовательским: сообщение со слотами должно содержать реальные numbered labels, а следующий вход `first`/`1` или эквивалент backend детерминированно сопоставляет с неистёкшим сохранённым server-side token до вызова агента. Это одинаково работает с fake и real Agents SDK и не требует передавать UUID token клиенту. Тест не должен читать token напрямую из repository.
6. Добавить отсутствующие tests: preferred date далеко в будущем, точный 14-day horizon, обычный current-day без past slots, Deep/minimum duration, duration overflow across midnight, token ownership/expiry/replay, Calendar-success + lead-save failure recovery, malformed Composio availability response и exact adapter fixtures.
7. Добавить Telegram reset boundary для повторных заказов по новому адресу. На всех обычных ответах показывать persistent reply keyboard с фиксированной English-кнопкой `New address`. Exact button text обрабатывать до Agents SDK: атомарно деактивировать предыдущий active lead, создать новый active lead с тем же `telegram_chat_id`, сохранённым языком и текущей `agent_config` version, но пустыми order data/quote/reservation/Human Needed и без старой OpenAI Conversation. Отправить детерминированный локализованный divider `— New cleaning location —` (Russian template: `— Новый адрес уборки —`, unknown/unsupported language fallback: English). Новый OpenAI Conversation создавать лениво при первом следующем содержательном сообщении. Старый lead, Calendar event и будущая Trello card остаются неизменными; reset не переводит lead в `Lost` и не отменяет external objects.
8. Сделать data-preserving forward migration для нескольких leads одного Telegram chat: убрать прежнюю глобальную уникальность `leads.telegram_chat_id` и `conversations.telegram_chat_id`, сохранить уникальность conversation по `lead_id`, добавить `active_in_chat` или эквивалентный pointer и partial uniqueness максимум одного active lead на chat. Repository должен искать именно active lead, а reset — выполняться одной транзакцией/RPC с server-only доступом и без промежуточного состояния с двумя active leads. Новую таблицу/функцию в exposed schema защитить RLS/revokes по существующему server-only паттерну.
9. Покрыть reset contract тестами: кнопка присутствует в Telegram payload; divider использует сохранённый язык и English fallback; новый lead не наследует client data, quote, slots, reservation, Human Needed или Conversation; следующий message создаёт новую Conversation; historical lead не меняется; duplicate Telegram update и двойное нажатие до новых данных не создают пустые leads/Conversations; два конкурентных reset/message update сериализованы; новая заявка проходит fake `message → quote → slots` независимо от старой.
10. Повторить lint, typecheck, все unit/contract tests, build, `git diff --check` и Playwright smoke; обновить `PROJECT_CONTEXT.md` и остановиться на review.

### Обязательные исправления итогового review 2026-08-21

Более дешёвая модель исправляет только пункты ниже, обновляет tests и `PROJECT_CONTEXT.md`, повторяет локальный gate и останавливается без cloud/PR/deploy:

1. Free/busy parser должен принимать только exact successful Composio contract pinned toolkit version для выбранного calendar. Для `googlecalendar@20260821_00` это `data.calendars[calendar_id]` с валидными массивами `busy` и `free`; timestamps являются RFC 3339 и могут иметь Belgrade offset (`+02:00`), отсутствие calendar entry либо любого из обязательных массивов — failure, а не свободный календарь. Основной fixture должен соответствовать фактическому SDK output; добавить отрицательный fixture для неполного calendar payload.
2. `request_available_slots` должен fail closed на transport/schema/SDK error: не превращать интеграционную ошибку в `invalid_tool_arguments`, не предлагать слоты, сохранить active quote и lifecycle `Qualified`, установить backend-owned `Human Needed` с конкретной Calendar-причиной и записать диагностируемую activity без секретов.
3. Calendar write должен реально резервировать cleaning interval вместе с 30-minute buffer. В create-event передавать `bufferEnd` как конец занятого Calendar event; при этом `booked_end` может оставаться концом самой уборки. Тест обязан отдельно проверить create input end и сохранённый cleaning end.
4. Повторный reserve после consumed token разрешает expired token только для восстановления уже `succeeded + external_id` operation. Если operation ещё не существует, expired token не должен создавать operation/event. Добавить ownership, fresh expiry, consumed-expired-before-operation и replay tests.
5. Recovery test после `completeIntegrationOperation` → failed `saveLead` должен повторять запрос с заново загруженным/клонированным lead без мутированных reservation fields. Он обязан доказать чтение существующей succeeded operation и отсутствие второго Calendar create.
6. Перед reserve повторно проверить, что lead всё ещё имеет active qualified quote и не требует ручного вмешательства. Старый token не должен создать событие после quote supersede или изменения schedule-defining данных; добавить regression test и минимальную deterministic invalidation/check без расширения архитектуры.

Real Calendar adapter использует server-only `COMPOSIO_GOOGLE_CALENDAR_USER_ID`, `COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID` и pinned `COMPOSIO_GOOGLE_CALENDAR_TOOLKIT_VERSION=20260821_00`; они заполнены в `.env.local` и Railway production без вывода values. Composio direct execution требует user ID даже при переданном private connected account. Новый `COMPOSIO_API_KEY` isolated project `Sherlock_Cleaning` валиден: прежний 401 был вызван ошибочной строкой с двойным `COMPOSIO_API_KEY=` в `.env.local`. Реальный read-only free/busy preflight подтвердил active connection и schema `calendars[id].busy/free`; все Calendar env values синхронизированы в Railway production без deploy. После adapter fix typecheck и 49 unit tests прошли на Node 26; полный gate повторяется перед deploy.

Cloud acceptance выполнена: data-preserving migrations в `cleaning-autopilot-demo`, SQL/RLS/RPC verification, точный PR commit в Railway production, health/webhook preflight и один controlled synthetic Telegram `New address → Quote → slots → choice → one Calendar event` E2E. Supabase подтвердил один succeeded Calendar create, сохранённые event/team/cleaning interval, 30-minute buffer и duplicate update без второй operation. Fake PR preview задеплоен в isolated mode с fake adapters и отвечает health. Перед merge нужен независимый final review; только после него Этап 3 принимается.

### Обязательные исправления Telegram conversation UX review 2026-08-21

Статус локальной реализации 2026-08-21: все пункты ниже реализованы в рабочей ветке вместе с новой additive migration `20260821194020_telegram_conversation_ux.sql`. Локальный gate прошёл: lint, source/test typecheck, 59 Vitest tests, production build, Playwright smoke и `git diff --check`. Cloud migration, deploy, real OpenAI/Telegram/Calendar calls, commit и PR не выполнялись. Следующий шаг — review большой модели, затем отдельно разрешённый cloud/real E2E:

1. Убрать slot UUID из клиентского и model-visible контекста. `request_available_slots` возвращает модели только безопасные numbered labels; prompt и tool descriptions запрещают показывать tokens, UUID, JSON, tool names, external IDs и внутренние статусы. `reserve_slot` принимает semantic option number либо selection полностью обрабатывается backend до LLM. Calendar token остаётся только в server-side repository/callback data.
2. Добавить стабильную сущность/границу выдачи слотов: `display_order 1..3` и active offer/batch или эквивалент. Новая выдача атомарно supersede прежние невыбранные tokens без удаления истории. Typed `1/2/3` выбирает последний активный offer; одинаковый start упорядочивается детерминированно по team. Старый inline callback fail closed и не может выбрать вариант из нового списка.
3. Добавить Telegram inline buttons для каждого слота и обработку `callback_query`: проверить принадлежность lead/token, повторно проверить availability, выполнить существующий idempotent reservation, вызвать `answerCallbackQuery` best-effort. Текст кнопки содержит только локализованные дату/время и при необходимости customer-facing team name. Постоянная reply-keyboard `New address` сохраняется; typed `1/2/3`, `first/second/third`, Russian и Serbian Latin/Cyrillic equivalents остаются fallback.
4. Ввести typed Telegram message renderer. Для всех outbound сообщений использовать `parse_mode: HTML`; свободный agent text полностью HTML-escaped и не интерпретирует model markup. Только backend templates создают allowlisted `<b>`, `<i>` и переносы. Проверить escape для `<`, `>`, `&`, кавычек, user-derived district/address и отсутствие raw `**`/backticks. Не использовать MarkdownV2 из-за сложного escaping произвольного текста.
5. Переписать customer copy и immutable `agent_config` новой version. Voice: внимательный, спокойный, краткий координатор Sherlock Cleaning; естественно подтверждать полученные сведения, задавать обычно один-два связанных вопроса, не выдавать анкету и не повторять известное. Никогда не говорить `Qualified`, `Human Needed`, `team sync`, `tool`, `token` или `event id`; не заявлять, что помощник человек, и правдиво отвечать на прямой вопрос об автоматизации.
6. Убрать текущий `ensureAuthoritativeQuote`, который при несовпадении суммы уничтожает весь conversational reply. Backend-owned renderer формирует локализованный authoritative quote block с форматированной суммой (`8,000 RSD`) и естественным следующим шагом. Аналогично backend рендерит slots, reservation и escalation; обычные уточняющие вопросы остаются за агентом.
7. Добавить best-effort Telegram `typing` action вокруг долгого OpenAI/Calendar шага; его failure не влияет на business result и не создаёт persisted integration operation.
8. Добавить tests: ни один visible reply/tool result не содержит UUID; HTML parse mode и escaping; friendly partial-intake question без raw field list; quote/slots/reservation golden copy для English/Russian; inline callback success/duplicate/stale/wrong-lead; repeat availability supersedes old offer; same-time Team A/B ordering; natural typed selections; Telegram formatting failure сохраняет существующую delivery idempotency.
9. Повторить `pnpm check`, Playwright, `git diff --check`; обновить актуальное состояние и external side effects в `PROJECT_CONTEXT.md`. Реальные OpenAI/Telegram/Calendar прогоны оставляет большой модели после review.

## Этап 1 — Bootstrap и инфраструктура

Статус: принят и merged через PR #1.

- Next.js App Router, TypeScript, Tailwind, Node 26, pnpm и standalone build.
- Supabase bootstrap migration, health route, CI и безопасная environment-конфигурация.
- GitHub, Railway, Supabase demo project и постоянный Telegram bot созданы после разрешения владельца.

## Этап 2 — Telegram → Conversation → Quote

Статус: принят и merged через PR #2 после исправления обязательных review замечаний надёжности.

- На Этапе 2 существовал один lead на Telegram chat; принятое расширение 3B сохраняет один active lead и допускает исторические leads. На каждый lead остаётся ровно одна OpenAI Conversation.
- Idempotent Telegram updates и delivery operations.
- Сбор валидированных данных, детерминированный pricing и независимый `Human Needed`.
- Этап принимается только после исправления review findings, повторных локальных checks и review большой модели.

## Этап 3 — Agents SDK и Calendar reservation

Статус: принят и merged через PR #4 после финального review, cloud migrations, fake Railway preview и зелёного CI. Перед Этапом 4 запланирован отдельный независимый post-merge audit без реализации нового scope.

### 3A — Agents SDK migration

- Сохранить проектный интерфейс `AgentGateway`.
- Подключить `@openai/agents` и реализовать одного сфокусированного агента без handoffs и multi-agent architecture.
- Использовать существующий OpenAI `conversationId` как server-managed continuation state.
- Перенести текущие typed tools и лимит не более четырёх tool-call шагов без изменения поведения Этапа 2.
- Pricing, lifecycle, idempotency и side-effect authorization оставить в backend.
- Сначала пройти parity unit/contract tests и fake Telegram flow; Calendar tools до этого не добавлять.

### 3B — Calendar reservation

- Через минимальный Composio allowlist читать availability двух календарей и создавать событие.
- Рассчитывать длительность, рабочие интервалы и до трёх slot tokens детерминированно server-side.
- Перед create повторно проверять slot; сохранять `calendar_event_id` немедленно после подтверждённого side effect.
- После Calendar success сохранять reservation/pending Trello sync, но оставлять lifecycle `Qualified` и не отправлять финальный booking confirmation.
- Проверить duplicate choice, ambiguous create, Calendar failure и отсутствие второго event.
- Добавить persistent Telegram button `New address` и отдельную backend-owned order boundary: один chat может иметь исторические leads, но только один active lead и отдельную OpenAI Conversation на каждый заказ.

## Этап 4 — Trello lifecycle и финальный Booked

- Создать ровно пять English lists и label `Human Needed`.
- Одна card на lead; обновлять её только на значимых изменениях.
- Lifecycle transitions выполняет backend, а не свободное решение LLM.
- После Calendar success и успешного Trello move установить `Booked` и только тогда отправить финальное confirmation.
- При Trello failure сохранить Calendar event и pending sync; не создавать событие повторно.
- Проверить standard и escalation flows, duplicate delivery и partial Calendar/Trello failure.

## Этап 5 — English Demo Console

- Один заранее созданный Admin через Supabase Auth; public signup и recovery отсутствуют.
- Dashboard: integration statuses, leads/lifecycle, Human Needed queue, activity, Calendar iframes, prompt/pricing editors и Miro embed/fallback.
- Prompt и pricing сохраняются immutable versions; secrets никогда не возвращаются во frontend.
- Проверить RLS и Playwright-сценарии login, versioning, leads, Human Needed, iframe fallback и responsive smoke.
- После отдельного разрешения выполнить финальные real E2E: standard `Lead → Booked` и escalation без quote.

## Общий gate каждого этапа

Перед передачей на review должны пройти доступные lint, typecheck, tests, `git diff --check`, build и релевантный fake E2E. После разрешённых deploy/migrations проверяется именно deployed demo. Непроверенные сценарии и все фактические external side effects перечисляются явно.
