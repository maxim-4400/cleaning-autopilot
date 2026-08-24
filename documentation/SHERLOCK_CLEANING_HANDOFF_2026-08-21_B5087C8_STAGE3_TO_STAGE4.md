# Sherlock Cleaning — hand-off после Этапа 3

Уникальный идентификатор документа: `SHERLOCK-CLEANING-HANDOFF-2026-08-21-B5087C8-STAGE3-TO-STAGE4`.

Дата snapshot: 2026-08-21, timezone `Europe/Belgrade`.

## 1. Для чего нужен этот документ

Это стартовый документ для нового чата, который должен независимо проверить завершённый Этап 3 и только после принятия этой проверки переходить к проектированию и реализации Этапа 4.

Документ не заменяет другие источники проекта. Их приоритет:

1. `AGENTS.md` — обязательные правила работы, безопасности, Git и внешних side effects.
2. `documentation/MVP1_REQUIREMENTS.md` — продуктовый контракт и границы MVP1.
3. `PROJECT_CONTEXT.md` — актуальная архитектура, решения, окружения и состояние реализации.
4. `documentation/MVP1_IMPLEMENTATION_PLAN.md` — этапность и review gates.
5. Фактический код и миграции — что действительно реализовано.
6. Этот hand-off — точка входа и компактная карта состояния на указанную дату.

Если документы и код расходятся, нельзя выбирать версию молча. Нужно описать расхождение и согласовать существенное решение с владельцем.

## 2. Короткий ответ: где проект сейчас

- Репозиторий: `https://github.com/maxim-4400/cleaning-autopilot`.
- Локальный checkout: `/Users/maxim4400/Projects/vibecoding-sandbox/Cleaning service`.
- Ветка: `main`.
- `HEAD` и `origin/main`: merge commit `b5087c8e051072ee427ee9504c7a09c6e992c07e`.
- PR Этапа 3: [#4](https://github.com/maxim-4400/cleaning-autopilot/pull/4), состояние `MERGED`.
- Merge PR #4: 2026-08-21 20:49:48 UTC.
- Рабочее дерево перед созданием этого hand-off было чистым.
- Этапы 1, 2 и 3 формально приняты и merged.
- Этап 4, Trello lifecycle и финальный переход `Booked`, ещё не реализованы.
- Этап 5, English Demo Console и Admin Auth, ещё не реализованы.

Следующий чат не должен немедленно писать Trello-код. Его первый блок — независимый post-merge audit Этапа 3 по новой агентской схеме пользователя. После аудита нужно остановиться, сообщить findings и предложить скорректированный план Этапа 4.

## 3. Что считается завершённым

### Этап 1 — Bootstrap

- Next.js App Router, React, TypeScript, Tailwind.
- Node.js 26 и `pnpm@11.19.0`.
- ESLint, Vitest, Playwright, standalone build.
- Health route и GitHub Actions.
- Начальная Supabase migration с `profiles`, ролью Admin и RLS.
- PR #1 merged.

### Этап 2 — Telegram → Conversation → Quote

- Постоянный Telegram bot `Sherlock Cleaning`, username `@sherlock_cleaning_bot`.
- Signed Telegram webhook с duplicate protection.
- DB-backed reclaim failed/stale update и per-chat lease.
- Один active lead на chat и долговечная OpenAI Conversation на lead.
- Валидация client data.
- Детерминированный pricing и отдельная quote validity.
- `Human Needed` не изменяет lifecycle автоматически.
- Один focused OpenAI agent за `AgentGateway`.
- PR #2 merged.

### Этап 3A — OpenAI Agents SDK

- Самописный runner заменён на `@openai/agents@0.17.0`.
- Сохранена граница `AgentGateway`.
- Один `Agent` и один `Runner`; handoffs и multi-agent отсутствуют.
- Используется server-managed OpenAI `conversationId`.
- Strict Zod tools, `parallelToolCalls: false`, tool concurrency `1`.
- Не более четырёх model-requested tool calls.
- Встроенные OpenAI retries выключены; допускается один retry только для безопасно replayable `429/5xx`.
- Pricing, lifecycle, slot calculation, idempotency и side-effect authorization остались backend-owned.

### Этап 3B — Calendar reservation и Telegram UX

- Детерминированный scheduling двух команд в `Europe/Belgrade`.
- Mon–Sat 08:00–20:00, Sunday closed.
- Standard duration: `area / 25 m²` hours.
- Deep duration: `area / 15 m²` hours.
- Округление duration вверх до 30 минут, минимум 2 часа.
- Calendar event блокирует cleaning interval и 30-minute buffer.
- До трёх слотов на 30-minute grid в 14-дневном горизонте.
- Same-day не предлагает время раньше `now + 2h`.
- Availability читается для `Cleaning Team A` и `Cleaning Team B`.
- Слот повторно проверяется перед Calendar create.
- Server-side opaque tokens, stable `display_order`, supersede старых offers.
- Typed `1/2/3`, English/Russian natural variants и inline callback обрабатываются backend-owned путём.
- UUID, token, tool names и external IDs не показываются клиенту и модели.
- Calendar create защищён `integration_operations` и не повторяется после ambiguous/succeeded state.
- Calendar success сохраняет event/team/cleaning interval, но lead остаётся `Qualified` до Trello.
- Кнопка `New address` начинает новый active lead без переноса order context.
- Предыдущий lead и его external objects остаются историей.
- Telegram использует HTML renderer с escaping и backend-owned quote/slots/reservation/escalation templates.
- Best-effort typing indicator не влияет на business result.
- Natural conversation voice закреплён immutable `agent_config` version 4.
- PR #4 merged.

## 4. Что именно ещё не завершено в конце Этапа 3

Нельзя считать весь MVP1 готовым:

- Trello card не создаётся на первом сообщении.
- Trello lists и label на demo board ещё не настроены.
- `TrelloGateway` и deterministic Trello sync service отсутствуют.
- `StoredLead` пока не отображает существующую DB-колонку `trello_card_id`.
- `integration_operations` поддерживает Telegram, OpenAI и Google Calendar, но schema constraint ещё нужно безопасно расширить для Trello.
- Lead не переходит в `Booked` после Calendar reservation.
- Клиент не получает финальное booking confirmation, подтверждённое Trello move.
- Partial Calendar-success/Trello-failure recovery не реализован.
- Demo Console, login и Admin Auth не реализованы.
- Browser E2E покрывает только landing-page smoke.
- Финальная merged Telegram conversation UX не проходила новый real Telegram callback E2E после UX hardening; её проверили unit/fake tests и Railway preview health.
- Финальный merged код не развёрнут в Railway production. Production обслуживает более ранний Stage 3 runtime, а финальный runtime commit `0ef60ba` проверен только в fake environment `pr-4`.

## 5. Первый блок работы нового чата

### Цель

Независимо проверить merged Этап 3 и определить, можно ли начинать Этап 4 без дополнительного исправления core flow.

### Обязательная последовательность

1. Полностью прочитать `AGENTS.md`, `MVP1_REQUIREMENTS.md`, `PROJECT_CONTEXT.md`, `MVP1_IMPLEMENTATION_PLAN.md` и этот hand-off.
2. Проверить `pwd`, Git root, ветку, `HEAD`, `origin/main`, `git status`, open PR и recent GitHub Actions.
3. Изучить фактический код Telegram webhook, agent gateway, repository, Calendar gateway/service, scheduling, renderer и все migrations.
4. Запустить локальный gate под Node 26:

   ```text
   npm run check
   npm run test:e2e
   git diff --check
   ```

5. Выполнить targeted review инвариантов из следующего раздела.
6. Read-only проверить актуальное состояние Supabase migrations/RPC privileges и Railway deployments/health, потому что cloud state может измениться после этого snapshot.
7. Не выполнять paid OpenAI calls, реальный Telegram flow, Calendar/Trello writes, deploy, migrations, commit, push, PR или merge без нового явного разрешения в следующем чате.
8. Остановиться с findings. Если блокирующих findings нет, выдать детальный план Этапа 4 и явно предложить переключение модели для реализации.

### Не начинать в этом блоке

- создание Trello lists/label/cards;
- изменение Supabase schema;
- production deploy;
- Stage 5 UI/Auth;
- расширение на recurring cleaning, Gmail, multi-agent или новую CRM.

## 6. Targeted audit Этапа 3

Проверить минимум следующие истории.

### Telegram update reliability

- Processed duplicate возвращает success без OpenAI/Telegram/Calendar side effects.
- Failed/stale update можно reclaim.
- Updates одного chat сериализуются lease-механизмом.
- Callback query получает best-effort acknowledgement и не оставляет spinner.
- Telegram delivery ambiguity после Calendar reservation приводит к manual follow-up, а не второму event.

### Conversation boundary

- Один active lead на chat.
- `New address` атомарно деактивирует старый lead и создаёт новый.
- Повторное нажатие до появления данных не создаёт цепочку пустых leads.
- Новая Conversation создаётся лениво для нового meaningful message.
- Старые client data, quote, tokens, reservation и Human Needed не передаются новому agent turn.

### Quote и lifecycle

- Деньги считает только backend.
- Quote становится active только после сохранения и подтверждённой доставки клиенту.
- Calendar error не supersede активный quote.
- Schedule-defining изменение инвалидирует старый token.
- `Human Needed` не меняет `New Lead`/`Qualified` сам по себе.
- Calendar success оставляет lead `Qualified` и создаёт `calendar_reserved_pending_trello`.

### Slot offer и Calendar idempotency

- Новая выдача supersede предыдущую.
- Старый callback и wrong-lead token fail closed.
- Token принадлежит lead, имеет expiry и schedule fingerprint.
- Перед create availability перечитывается.
- Event занимает cleaning end плюс buffer end.
- `succeeded + external_id` восстанавливает lead без второго Calendar create.
- `pending/ambiguous/failed` не инициирует опасный автоматический повтор create.
- Transport/schema failure availability не трактуется как свободный календарь.

### Клиентский Telegram UX

- Agent prose полностью escaped.
- Raw Markdown не показывается.
- Quote, slots, reservation, stale selection, no availability и escalation создаёт backend renderer.
- Visible reply и model-visible tool result не содержат UUID/token/internal status.
- Russian BCP-47 variants используют Russian templates.
- Вопросы естественные, короткие и не повторяют известные данные.

### Database security

- Все public tables имеют RLS.
- Webhook/repositories используют server secret только server-side.
- `consume_calendar_slot_token` и `replace_calendar_slot_offer` недоступны `anon` и `authenticated`, доступны `service_role`.
- `activity_log` остаётся append-only для application path.
- Миграции additive и remote history совпадает с local history.

## 7. Архитектурные инварианты, которые нельзя менять молча

- Одно self-hosted Next.js App Router приложение; отдельный worker/backend только при доказанной необходимости.
- Один focused agent; multi-agent и handoffs вне MVP1.
- `AgentGateway`, `TelegramGateway`, `CalendarGateway` и будущий `TrelloGateway` отделяют business logic от transport.
- LLM отвечает за язык, extraction, вопросы и scope confidence.
- Backend отвечает за pricing, quote validity, lifecycle, slots, idempotency и разрешение external writes.
- Google Calendar — источник availability команд.
- Trello — операционная CRM, не внутренний state machine агента.
- Одна Trello card на lead.
- Ровно пять lists: `New Lead`, `Qualified`, `Booked`, `Done`, `Lost`.
- `Human Needed` — label/flag, не шестая колонка.
- Calendar event сам по себе не означает финальный `Booked`.
- `Booked` разрешён только после Calendar success и подтверждённого Trello move.
- Финальное клиентское confirmation отправляется только после `Booked`.
- Внешние IDs сохраняются сразу после подтверждённого side effect.
- Preview использует fake adapters для изменяющих сценариев.
- Секреты никогда не выводятся, не попадают в Git, frontend, Trello, Miro или логи.

## 8. Карта кода

### HTTP surfaces

- `src/app/api/health/route.ts` — безопасный health payload.
- `src/app/api/webhooks/telegram/route.ts` — Node runtime route, проверка Telegram secret и server-side dependency wiring.
- `src/app/page.tsx` — пока только стартовая foundation page.

### Core contracts и rules

- `src/lib/contracts/domain.ts` — основные enums/types/Zod schemas и default pricing rules.
- `src/lib/pricing/engine.ts` — deterministic pricing и escalation.
- `src/lib/scheduling/engine.ts` — timezone, duration, grid, working hours и slot calculation.

### Agent

- `src/lib/agent/gateway.ts` — `AgentGateway`, `OpenAiAgentsGateway`, `FakeAgentGateway`, strict tools и bounded runner.

### Telegram

- `src/lib/telegram/webhook.ts` — orchestration всего current flow.
- `src/lib/telegram/gateway.ts` — real/fake Telegram transport.
- `src/lib/telegram/renderer.ts` — safe HTML и backend-owned customer templates.
- `src/lib/telegram/language.ts` — BCP-47 Russian-family detection.

### Calendar

- `src/lib/calendar/gateway.ts` — `CalendarGateway`, fake adapter и pinned Composio adapter.
- `src/lib/calendar/reservation-service.ts` — offers, token consume, recheck, create, recovery и persistence.

### Persistence

- `src/lib/leads/repository.ts` — application repository contract и stored types.
- `src/lib/leads/in-memory-repository.ts` — fake repository для tests/local flow.
- `src/lib/leads/supabase-repository.ts` — REST/RPC adapter к Supabase.
- `src/lib/stage2/dependencies.ts` — fake/real dependency assembly; имя историческое, но сейчас обслуживает и Stage 3.
- `src/lib/env/server.ts` — server-only Zod validation environment.

### Tests

- `tests/unit/telegram-webhook.test.ts` — главный orchestration regression suite.
- `tests/unit/agent-gateway.test.ts` — Agents SDK contract/retry/tool-limit tests.
- `tests/unit/scheduling.test.ts` — scheduling, Composio schema и Calendar idempotency.
- `tests/unit/telegram-renderer.test.ts` — escaping/copy/language.
- `tests/unit/telegram-gateway.test.ts` — Telegram request contract.
- `tests/unit/pricing.test.ts` — pricing boundaries.
- `tests/unit/supabase-repository.test.ts` — offer replacement RPC contract.
- `tests/e2e/home.spec.ts` — только landing-page smoke.

## 9. Supabase snapshot

- Project: `cleaning-autopilot-demo`.
- Project ref: `oqrwshhozbyrqruahkhx`.
- Region: `eu-central-1`.
- На snapshot применены девять migrations:

  1. `20260820144138_init_profiles.sql`
  2. `20260820155459_stage_2_telegram_quote.sql`
  3. `20260820155555_stage_2_agent_config_index.sql`
  4. `20260820163648_stage_2_review_hardening.sql`
  5. `20260820221152_stage_2_review_reliability.sql`
  6. `20260821150739_stage_3_calendar_reservation.sql`
  7. `20260821150758_stage_3b_order_boundary.sql`
  8. `20260821194020_telegram_conversation_ux.sql`
  9. `20260821203956_restrict_calendar_slot_rpc_execute.sql`

- Последняя security migration явно revoke Calendar token RPC у `PUBLIC`, `anon`, `authenticated` и grant только `service_role`.
- Post-migration ACL check: обе RPC дали `anon=false`, `authenticated=false`, `service_role=true`.
- Supabase security advisor после последней migration: no issues.
- Локальный Docker/Postgres stack на момент приёмки был недоступен; migrations проверялись в отдельном cloud demo project.
- В cloud остаются только synthetic test records и один private synthetic Calendar reservation flow; реальные пользователи отсутствовали.

Cloud состояние временно нестабильно по определению. Следующий чат должен сначала выполнить read-only migration/ACL/advisor verification и не повторять migration вслепую.

## 10. Railway snapshot

- Project: `cleaning-autopilot`.
- Project ID: `893e9990-b083-4879-aaf5-5694a4427624`.
- Service: `web`.
- Service ID: `cdf175b6-d2f6-41fe-943c-62af8ff8449b`.
- Production environment ID: `06709d25-56ee-4af5-9776-0f5fdc508fcb`.
- Production domain: `https://web-production-db062.up.railway.app`.
- Preview environment: `pr-4`.
- Preview environment ID: `bdf87f25-7b73-4854-ac4e-b9d3e87272ef`.
- Preview domain: `https://web-pr-4-6013.up.railway.app`.
- Final Stage 3 runtime commit `0ef60ba` deployed to `pr-4` with fake adapters.
- Preview deployment ID: `1e7fe675-f9cf-4637-986f-6db7aec24ab6`.
- Preview health returned `200` with `environment: preview`.
- Production uses real integrations and has `HOSTNAME=0.0.0.0` to avoid Next standalone `502`.
- Production service has no GitHub source configured; merge does not automatically deploy.
- Production was not redeployed after final Telegram UX hardening and PR #4 merge.

Do not infer production freshness from an old `200` health response. Verify deployment metadata and exact commit/message before claiming the merged runtime is live.

## 11. External integrations snapshot

### Telegram

- Permanent bot: `Sherlock Cleaning`.
- Username: `@sherlock_cleaning_bot`.
- Один bot используется и для controlled demo, и для дальнейшей эксплуатации.
- Avatar загружен владельцем.
- Webhook указывает на Railway production route.
- Bot token и webhook secret находятся только в server-side environment.

### OpenAI

- Project key хранится в `.env.local` и Railway, значение не показывать.
- Model/reasoning конфигурация читается из environment.
- Current accepted configuration: `gpt-5.6-terra`, reasoning `low`, max output 1200 внутри gateway, bounded four-tool loop.
- Реальные платные calls в новом чате требуют отдельного preflight и подтверждения.

### Composio

- Isolated project: `Sherlock_Cleaning`.
- Active managed connections: Google Calendar и Trello.
- Calendar direct execution требует одновременно project `userId` и `connectedAccountId`.
- Calendar toolkit pinned: `googlecalendar@20260821_00`.
- Availability accepted contract: `data.calendars[calendar_id].busy` и `.free`; отсутствие entry/arrays fail closed.
- Ранее встречавшийся `401` был вызван локальной строкой с двойным `COMPOSIO_API_KEY=`, а не невалидным ключом.
- Miro через Composio не нужен и был отключён; Stage 5 использует public embed URL или обычную ссылку.

### Google Calendar

- `Cleaning Team A`.
- `Cleaning Team B`.
- Timezone: `Europe/Belgrade`.
- Controlled Stage 3 E2E создал один private synthetic event; его намеренно не удаляли автоматически.

### Trello

- Private board существует: `Cleaning Autopilot — Demo`.
- Board пока пустой: финальные lists/label не настроены.
- Trello connection в Composio project активна.
- Реальных карточек Stage 3 не создавал.

### Miro

- Владелец ранее указал на существующую test SmartCAD board для будущего embed/link.
- Exact board URL и permission mode в текущем коде не проверены.
- Composio для Miro не нужен.

## 12. Environment variables

Значения не читать вслух и не копировать в документацию. Допустимо проверять только наличие/валидность без вывода.

Текущий публичный контракт `.env.example`:

```text
APP_ENV
INTEGRATION_MODE
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
OPENAI_API_KEY
OPENAI_MODEL
OPENAI_REASONING_EFFORT
COMPOSIO_API_KEY
COMPOSIO_GOOGLE_CALENDAR_USER_ID
COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID
COMPOSIO_GOOGLE_CALENDAR_TOOLKIT_VERSION
TRELLO_BOARD_ID
TRELLO_HUMAN_NEEDED_LABEL_ID
TEAM_A_CALENDAR_ID
TEAM_B_CALENDAR_ID
NEXT_PUBLIC_TEAM_A_CALENDAR_EMBED_URL
NEXT_PUBLIC_TEAM_B_CALENDAR_EMBED_URL
NEXT_PUBLIC_MIRO_EMBED_URL
MIRO_BOARD_URL
```

Для Этапа 4, вероятно, потребуются project-scoped Trello `userId`, `connectedAccountId` и pinned toolkit version, аналогично Calendar. Не добавлять их по предположению: сначала read-only получить актуальный Composio direct-execution contract и затем согласовать минимальный env contract.

## 13. Последняя подтверждённая проверка

Перед merge PR #4 выполнено:

- `npm run check` под Node 26;
- ESLint без ошибок;
- source и test TypeScript checks;
- 8 Vitest files, 71 tests passed;
- Next.js production Webpack build;
- `npm run test:e2e`, один Chromium smoke passed;
- `git diff --check`;
- GitHub Actions `verify` passed для final PR head `8b9f013`;
- Railway fake preview build/deploy success для runtime commit `0ef60ba`;
- public preview health `200` / `environment: preview`;
- cloud Supabase migrations applied;
- Calendar RPC privileges verified service-role-only;
- Supabase security advisor clean.

Ранее controlled real flow подтвердил:

```text
New address
→ Quote
→ 3 slots
→ numbered choice
→ exactly one Calendar event
→ persisted reservation
→ duplicate update without second operation/event
```

Этот real flow был выполнен до финального Telegram inline-button/renderer hardening. Поэтому следующий независимый audit должен честно разделять core Calendar E2E evidence и final UX evidence.

## 14. Известные ограничения и ловушки

- `PROJECT_CONTEXT.md` и implementation plan ранее содержали исторический текст «до merge PR #4»; при создании этого hand-off они обновлены до post-merge состояния.
- Railway production не содержит final merged UX runtime.
- Preview `pr-4` использует fake adapters и доказывает build/start/health, но не real Telegram/OpenAI/Calendar behavior.
- Cloud Supabase schema уже содержит финальные Stage 3 migrations, хотя production runtime старше merge; migrations additive и backward-compatible.
- Локальный Supabase Docker stack был остановлен.
- Codex pnpm wrapper на машине ранее запускался под Node 24 и пытался пересоздать `node_modules`; принятый обход — настоящий Node 26 и эквивалентный `npm run check`.
- Next standalone на Railway требует `HOSTNAME=0.0.0.0`.
- Composio private direct execution требует project `userId`; одного connection ID недостаточно.
- Calendar RFC 3339 timestamps могут иметь Belgrade offset `+02:00`, не только `Z`.
- Не трактовать malformed Composio availability payload как пустой календарь.
- Не retry ambiguous Calendar create автоматически.
- Не удалять synthetic Calendar event без отдельного разрешения.
- Не показывать значения `.env.local`, Railway variables или Composio credentials.
- Не переносить approvals этого чата автоматически в новый чат.

## 15. План Этапа 4 после принятия аудита

Этап 4 лучше вести одним связанным PR, но реализацию разбить на проверяемые блоки.

### 4A. Read-only discovery и контракт Trello

1. Проверить active Trello connection в `Sherlock_Cleaning`.
2. Получить exact toolkit version, tool names, schemas и read fixtures через поддерживаемый Composio SDK.
3. Зафиксировать минимальный allowlist: read board/lists/labels, create card, update card, move card, add/remove согласованный label.
4. Проверить существующую board `Cleaning Autopilot — Demo` без изменений.
5. Согласовать exact environment variable names для Trello direct execution.
6. Не создавать lists/label/cards в discovery-блоке.

### 4B. Contracts, migration и fake adapter

1. Создать feature branch после повторной проверки Git state, например `feat/stage-4-trello-lifecycle`.
2. Добавить `TrelloGateway` отдельно от transport/orchestration.
3. Добавить fake gateway с детерминированным состоянием для tests.
4. Отобразить существующий `leads.trello_card_id` в `StoredLead` и Supabase mapper/save path.
5. Additive migration должна минимум:
   - безопасно разрешить provider `trello` в `integration_operations`;
   - при необходимости добавить partial unique index на непустой `trello_card_id`;
   - не удалять и не переписывать существующие данные;
   - сохранить RLS/server-only contract.
6. Не добавлять Trello state machine в LLM tools.

### 4C. Deterministic Trello lifecycle service

1. Создать одну card на lead с idempotency key и немедленно сохранить card ID.
2. Обновлять card только на meaningful state/data changes.
3. English title: `Client name · District · Area m²` с безопасным fallback для неизвестных полей.
4. English description содержит только бизнес-минимум:
   - contact;
   - cleaning type;
   - area / rooms / bathrooms;
   - extras / heavy pet hair;
   - address or district;
   - preferred date;
   - quote;
   - assigned team and reserved time;
   - short English conversation summary;
   - Human Needed reason.
5. `Human Needed` синхронизируется отдельным label и не меняет list.
6. Backend выбирает lifecycle list; agent не получает arbitrary move-card.

### 4D. Board provisioning и backfill после отдельного разрешения

На private board создать ровно:

```text
New Lead
Qualified
Booked
Done
Lost
```

И ровно один согласованный label:

```text
Human Needed
```

Затем idempotent backfill создаёт/синхронизирует cards для существующих synthetic leads. Повторный запуск не создаёт duplicates и не добавляет шестую колонку.

### 4E. Calendar → Trello → Booked orchestration

1. Первое сообщение создаёт/schedules единственную `New Lead` card.
2. После доставленного quote card обновляется и перемещается в `Qualified`.
3. После Calendar reservation повторный Calendar create не допускается.
4. Система обновляет существующую card и перемещает её в `Booked`.
5. Только после успешного Trello move:
   - сохранить lead status `booked`;
   - записать activity;
   - отправить финальное клиентское confirmation.
6. Calendar success + Trello failure:
   - Calendar event сохраняется;
   - lead остаётся `Qualified`;
   - Trello operation остаётся recoverable pending/failed;
   - при необходимости ставится `Human Needed` с конкретной причиной;
   - клиент не получает финальное booking confirmation;
   - retry синхронизирует Trello без второго Calendar event.
7. Ambiguous Trello create/move не повторять вслепую: сначала read/reconcile по сохранённому ID или детерминированному marker.

### 4F. Tests

Минимальный contract suite:

- одна card на lead;
- duplicate Telegram update не создаёт вторую card;
- duplicate Trello delivery/retry не создаёт вторую card;
- card title/description English и без секретов/internal IDs;
- только пять lists;
- `Human Needed` независим от lifecycle;
- New Lead → Qualified после подтверждённой quote delivery;
- Qualified + Calendar reservation остаётся Qualified до Trello move;
- successful Trello move → Booked → final confirmation;
- Calendar success + Trello failure не создаёт второй event;
- failed/ambiguous Trello operation recoverable без duplicate;
- existing Stage 3 tests остаются зелёными;
- fake standard и escalation end-to-end flows.

### 4G. Acceptance и delivery

1. Локально: lint, source/test typecheck, all unit/contract tests, build, `git diff --check`, relevant fake E2E.
2. Обновить `PROJECT_CONTEXT.md` фактическим состоянием.
3. Большая модель проводит independent review.
4. После отдельного разрешения применить additive cloud migration.
5. После отдельного разрешения provision board lists/label и выполнить synthetic backfill.
6. Проверить fake Railway preview exact runtime commit.
7. После отдельного paid/external preflight выполнить максимум необходимые real standard/escalation scenarios.
8. Только после зелёного CI и review — merge Stage 4 PR.

## 16. Этап 5 после Этапа 4

Не реализовывать заранее. Следующая крупная работа:

- один заранее созданный Supabase Admin;
- public signup, invitations и password recovery выключены;
- `/login`, `/auth/callback`, `/dashboard`;
- integration status strip без секретов;
- Open Telegram;
- lifecycle/leads и Human Needed queue;
- recent activity;
- два official Google Calendar iframe;
- Main Prompt editor;
- structured Pricing Rules editor;
- Miro embed/fallback;
- immutable `agent_config` versions;
- RLS verification;
- Playwright login/versioning/leads/Human Needed/iframe/responsive scenarios.

## 17. Команды, которым можно доверять на snapshot

```text
pnpm dev
pnpm build
pnpm start
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm check
```

На этой машине для полного gate уже использовалось:

```text
npm run check
npm run test:e2e
git diff --check
```

Не выдумывать дополнительные команды. Для Supabase, Railway, GitHub и Composio сначала читать фактический CLI help/current state.

## 18. Stop conditions и отчёт следующего чата

После независимого Stage 3 audit следующий чат должен остановиться и сообщить:

1. Findings с приоритетами и точными файлами/строками.
2. Что проверено локально.
3. Что проверено read-only в cloud/preview.
4. Что не проверено.
5. Нужны ли исправления Stage 3 до Stage 4.
6. Скорректированный план Stage 4.
7. Можно ли переключать модель для реализации.

После каждого блока реализации Этапа 4 исполнитель обновляет `PROJECT_CONTEXT.md` и останавливается на review. Он не начинает следующий этап автоматически.

## 19. Готовый стартовый prompt для нового чата

```text
Работай в /Users/maxim4400/Projects/vibecoding-sandbox/Cleaning service.

Полностью прочитай AGENTS.md, documentation/MVP1_REQUIREMENTS.md,
PROJECT_CONTEXT.md, documentation/MVP1_IMPLEMENTATION_PLAN.md и
documentation/SHERLOCK_CLEANING_HANDOFF_2026-08-21_B5087C8_STAGE3_TO_STAGE4.md.

Первый блок — только независимый post-merge audit завершённого Этапа 3.
Не начинай Этап 4 и не меняй код, пока не закончишь review и не отдашь findings.
Проверь main/HEAD/working tree, локальный Node 26 gate, Telegram/Agents SDK/
Calendar/idempotency/security contracts и read-only актуальность Supabase,
Railway и GitHub evidence. Разделяй final UX fake/preview evidence и более ранний
real Calendar E2E. Не выполняй paid calls, cloud writes, deploy, migrations,
commit, push, PR или merge без нового явного разрешения.

По итогам дай findings, ограничения и скорректированный подробный план Этапа 4,
после чего остановись и скажи, можно ли переключать модель для реализации.
```

## 20. Финальная граница hand-off

На этом snapshot Этап 3 принят и merged, но требует запланированного независимого post-merge аудита перед Этапом 4. Самый важный operational gap — final merged UX runtime ещё не развёрнут в production. Самый важный product gap — Trello lifecycle отсутствует, поэтому Calendar reservation ещё не становится финальным `Booked`.
