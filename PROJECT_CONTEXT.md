# Cleaning Autopilot — project context

## Goal and current stage

Цель MVP1 — довести стандартный разовый lead из Telegram от первого сообщения до подтверждённого бронирования: собрать недостающие данные, детерминированно рассчитать цену, подобрать слот одной из двух команд, создать событие Google Calendar и синхронизировать бизнес-статус с Trello.

Этап 1 (Bootstrap и инфраструктура) принят после итогового review большой модели 2026-08-20 и merged в `main` через [GitHub PR #1](https://github.com/maxim-4400/cleaning-autopilot/pull/1) после зелёного CI. Этап 2 `Telegram → Quote`, включая reliability hardening, принят в GitHub CI и merged в `main` через [PR #2](https://github.com/maxim-4400/cleaning-autopilot/pull/2) 2026-08-20. Этап 3 поставлен одним [PR #4](https://github.com/maxim-4400/cleaning-autopilot/pull/4) и merged в `main` commit `b5087c8` 2026-08-21: Agents SDK migration, Calendar reservation, order boundary `New address` и Telegram conversation UX прошли итоговый review. Независимый post-merge audit обнаружил и исправил recovery gap Telegram chat lease в [PR #5](https://github.com/maxim-4400/cleaning-autopilot/pull/5), merged commit `70edb66` 2026-08-21.

Этап 4 (реальный Trello lifecycle и recovery) завершён production acceptance 2026-08-23. Контролируемый synthetic flow в реальном Telegram подтвердил `New address → English quote 6,500 RSD → Serbian Latin slots → one selected slot → one Calendar event → one Trello card Booked → final Telegram confirmation`. Этап 5 (Demo Console) завершён production acceptance 2026-08-23: защищённые `/login`, `/dashboard` и `/settings` доступны в Railway, Admin login через Supabase проверен в пользовательском Chrome, а presentation-консоль показывает safe latest-lead evidence, integration snapshot, Trello, Miro и редактируемую configuration. Synthetic demo-данные намеренно сохранены. Следующий этап не начинается автоматически.

Stage 5 consistency slice (2026-08-24) добавляет privacy-safe Telegram profile metadata, human-readable Trello presentation, durable primary-locale fallback, deterministic relative-date/weekend/time-window handling, компактную lifecycle projection, exact team-calendar routing guard, optional public team-calendar embeds и Tailwind-based Demo Console. Calendar create сохраняет UTC instants в приложении, но передаёт Composio local wall-clock datetime вместе с явным `Europe/Belgrade`, чтобы 08:00 agreed slot не отображался в календаре как 06:00; этот DST-safe boundary покрыт локальным regression test и уже развёрнут в Railway production. Публичные Team A/B calendar embeds сконфигурированы. 2026-08-24 четыре точно идентифицированных synthetic reservations, ошибочно отображавшихся в 06:00, были скорректированы на 08:00 с сохранением event IDs, duration и private lead/idempotency markers; дополнительно созданы 40 явно маркированных `[DEMO]` дневных events на конец августа–сентябрь. Seed utility по умолчанию выполняет только dry-run, а при `--apply` изменяет исключительно свои marked events и exact operator-supplied correction IDs. Полная production acceptance новых booking, Telegram и dashboard сценариев ещё выполняется; никаких production migrations для этого slice не потребовалось.

Для внешней presentation-истории 2026-08-24 создан новый чистый public GitHub repository `maxim-4400/cleaning-autopilot`; локальный `origin` указывает на него. Предыдущий repository сохранён как `maxim-4400/cleaning-autopilot-old` до проверки первого clean PR, CI и production delivery нового repository; он не удалён. Railway не имеет GitHub source (deploy остаётся CLI-driven), а Supabase не имеет GitHub repository binding, поэтому их переключение не требуется.

Исходный продуктовый контракт находится в [documentation/MVP1_REQUIREMENTS.md](./documentation/MVP1_REQUIREMENTS.md). Этот файл фиксирует текущее состояние и решения, но не заменяет requirements.

## Actual repository structure

Текущая подтверждённая структура:

```text
Cleaning service/
├─ AGENTS.md
├─ PROJECT_CONTEXT.md
├─ documentation/
│  ├─ MVP1_REQUIREMENTS.md
│  ├─ MVP1_IMPLEMENTATION_PLAN.md
│  ├─ SHERLOCK_CLEANING_HANDOFF_2026-08-21_B5087C8_STAGE3_TO_STAGE4.md
│  └─ STAGE4_COMPLETION_HANDOFF_2026-08-23.md
├─ src/
│  ├─ app/                 # App Router, landing page, health and Telegram webhook route
│  └─ lib/                 # contracts, pricing, leads, agent/Telegram gateways and server-only env
├─ supabase/
│  ├─ config.toml
│  └─ migrations/          # init_profiles, Stage 2 and additive Stage 3 migrations
├─ tests/
│  ├─ unit/
│  └─ e2e/
├─ .github/workflows/ci.yml
├─ package.json
├─ pnpm-lock.yaml
└─ configuration files for TypeScript, ESLint, Vitest, Playwright and Tailwind
```

Проект использует `pnpm@11.19.0`, Node.js `>=26 <27` (`.nvmrc` = `26`), Next.js App Router, strict TypeScript, Tailwind CSS и standalone output. На 2026-08-20 Node.js 26 имеет официальный статус `Current`, а не LTS; версия 26 остаётся явным решением владельца проекта. Production build намеренно использует `next build --webpack`: Turbopack в этом macOS окружении не может создать свой внутренний socket, тогда как Webpack build успешно проходит.

Команды проекта: `pnpm dev`, `pnpm build`, `pnpm start`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm verify:instrumentation-build` и `pnpm check`. `check` после production build импортирует emitted Next.js instrumentation artifact и проверяет export `register()`. CI выполняет `pnpm install --frozen-lockfile`, затем lint, typecheck, unit tests и build под Node 26.

## Product boundaries

Core flow:

```text
Telegram
→ AI conversation
→ deterministic pricing
→ quote
→ availability of Team A / Team B
→ Calendar event
→ pending Trello sync
→ Booked
```

Trello отражает только бизнес lifecycle:

```text
New Lead → Qualified → Booked
                         │
                         └─ Done вручную

Lost — отдельное финальное состояние для потерянной заявки
Human Needed — label/flag поверх любого состояния
```

В MVP1 явно не входят Gmail, recurring cleaning, подписки, автоматический повтор заказов, `Next Week`, multi-agent architecture и новая CRM. При этом один Telegram-клиент может вручную начать следующую независимую разовую заявку для другого адреса через кнопку `New address`; это новый lead, а не recurring schedule.

## Selected architecture

Архитектурная основа, зафиксированная requirements:

- одно full-stack приложение на Next.js App Router, React, TypeScript и Tailwind CSS;
- Node.js 26 и pnpm с зафиксированным lockfile; на 2026-08-20 это `Current`, а не LTS, но версия остаётся явным выбором владельца;
- Next.js обслуживает Demo Console, server-side API, Telegram webhook и orchestration;
- Railway размещает приложение;
- Supabase предоставляет PostgreSQL и Auth;
- Telegram подключается напрямую через Telegram Bot API;
- OpenAI Responses API выполняет агентные шаги;
- OpenAI Conversations API хранит долговечное состояние диалога;
- начиная с подэтапа 3A OpenAI Agents SDK выполняет runner/tool loop одного агента за существующей границей `AgentGateway`;
- pricing выполняется детерминированной backend-функцией;
- Composio MCP используется только для Trello и Google Calendar с минимальным allowlist;
- Calendar reservation остаётся backend-owned: агент получает только semantic tools для получения слотов и выбора opaque token; duration, availability, idempotency и Calendar create проверяются вне LLM;
- Trello остаётся операционной CRM;
- два Google Calendar являются источником доступности `Cleaning Team A` и `Cleaning Team B`.

Multi-agent architecture и handoffs не используются. Отдельный backend или worker пока не выбраны. Для межпроцессной сериализации Telegram updates допустим минимальный DB-backed lock/lease внутри текущего приложения; отдельная очередь добавляется только при доказанной необходимости.

## Main application surfaces

### Telegram bot

Клиент сообщает параметры, получает уточняющие вопросы, quote, варианты времени и подтверждение. Telegram chat имеет не более одного active lead, но может сохранять несколько исторических leads; каждый lead связан со своей OpenAI Conversation.

Решение owner от 2026-08-22 о pure per-message English fallback заменено локальным Stage 5 slice: backend детерминированно выбирает `en`, `ru`, `sr-Latn` или `sr-Cyrl` для каждого incoming text; clearly recognized later messages не блокируются, но short/mixed/numeric acknowledgements используют первый уверенно распознанный язык текущей заявки. `first_message_language` используется как durable primary locale и сбрасывается в `und` через `New address`. Reply templates, agent instruction, quote, slots, reservation и escalation используют выбранный locale. Persistent reply-keyboard `New address` сохраняет English label, обрабатывается backend до agent turn и создаёт новый active lead; divider — `New cleaning location` без dash. Старые client data, address, quote, slots, reservation, Human Needed и OpenAI Conversation не переносятся и не передаются агенту; предыдущий lead и external objects остаются историей без автоматической отмены или `Lost`. Slot callback несёт ограниченный locale из предложения, поэтому его reservation/stale reply остаётся на языке кнопки; legacy callback получает English fallback.

Решение владельца от 2026-08-20: используется один постоянный Telegram-бот для controlled demo-проверок и дальнейшей рабочей эксплуатации. Отдельный demo-бот не создаётся. Тестовые диалоги используют только синтетические данные.

### Demo Console

Закрытая Admin-панель для демонстрации и конфигурации. Она показывает статусы интеграций, ссылку на Telegram, Main Prompt, Pricing Rules, компактное состояние leads/Trello и Miro. Это не CRM.

### Trello

Одна карточка соответствует одному lead. Колонки фиксированы: `New Lead`, `Qualified`, `Booked`, `Done`, `Lost`. `Human Needed` реализуется label/flag с причиной.

### Google Calendar

Два календаря представляют две команды. Успешно созданное событие фиксирует reservation и pending Trello sync, но само по себе не переводит lead в `Booked`. Финальный `Booked` и клиентское confirmation разрешены только после успешного Trello move.

## Agent and business logic

Один агент ведёт весь flow. LLM отвечает за язык, извлечение параметров, недостающие вопросы, выбор следующего разрешённого semantic tool и решение об эскалации. С 3A `OpenAiAgentsGateway` использует `@openai/agents@0.17.0`: один `Agent`, один `Runner`, existing server-managed `conversationId`, Zod-based strict function tools, `parallelToolCalls: false`, SDK-side tool concurrency `1` и максимум четыре model-requested tool calls. После четвёртого вызова tools становятся недоступны, его output сохраняется в Conversation на пятом final turn, а backend дополнительно ставит детерминированный `mark_human_needed(scope_uncertain)`, если агент сам ещё не эскалировал. Это terminal backend side effect не входит в лимит model tool calls. Встроенные повторы `openai` client отключены (`maxRetries: 0`); Runner допускает не более одного retry и только для `429/5xx`, когда OpenAI помечает replay stateful request безопасным. Handoffs и multi-agent tools не сконфигурированы.

Agents SDK не меняет границу ответственности: backend детерминированно контролирует pricing, quote validity, lifecycle transitions, slot calculation, idempotency и разрешение внешних side effects. Один agent не получает свободный низкоуровневый инструмент для произвольного перемещения Trello card или создания Calendar event вне валидированного slot token.

Деньги рассчитывает обычная функция. Агент передаёт ей структурированные параметры и сообщает только полученный результат. Автоматическая цена запрещена для площади больше 200 m², уборки после ремонта, коммерческих объектов, необычно сильного загрязнения, услуг вне списка и неуверенно понятого scope.

Pricing contract:

- Standard cleaning: `80 RSD/m²`, минимум `4 000 RSD`;
- Deep cleaning: `160 RSD/m²`, минимум `9 000 RSD`;
- каждый санузел после первого: `+500 RSD`;
- heavy pet hair: `+900 RSD`;
- windows: `+900 RSD`;
- oven inside: `+1 000 RSD`;
- fridge inside: `+900 RSD`;
- balcony or terrace: `+1 000 RSD`;
- скидка на base: 0% до 100 m², 5% для 101–150 m², 10% для 151–200 m²;
- same-day: `+20%` после base, скидки и доплат.

`Standard cleaning` — разовая услуга. Recurring schedules отсутствуют.

## Planned data model

Схема зафиксирована migrations. `profiles` остаётся таблицей Этапа 1; Этап 2 добавляет:

- `leads` — максимум один active lead на Telegram chat и исторические leads того же chat, legacy `first_message_language` для истории (не runtime language lock), lifecycle, валидированный `client_data` JSONB, version/snapshot pricing, quote, Human Needed, booking и external-ID колонки;
- `conversations` — один mapping lead/Telegram/OpenAI Conversation;
- `telegram_updates` — уникальный `update_id`, исходный payload, processing outcome и lease для atomic reclaim;
- `telegram_chat_leases` — DB-backed per-chat serialization разных Telegram updates без отдельной очереди;
- `agent_config` — versioned prompt/rules; v1 вставлен migration и в приложении читается без mutation;
- `activity_log` — append-only business events;
- `integration_operations` — idempotency и outcome Telegram/OpenAI side effects.

Все public tables имеют RLS и не имеют anonymous/authenticated policies. Routes используют только server-side Supabase secret key; `activity_log` service role может только читать/вставлять, а не изменять/удалять.

## State transitions and invariants

- первое сообщение создаёт `New Lead` и одну Trello-карточку;
- quote переводит lead в `Qualified`;
- успешное Calendar event creation сохраняет reservation и pending Trello sync, но оставляет lead `Qualified`;
- только успешный Trello move после Calendar event переводит lead в `Booked` и разрешает финальное confirmation;
- `Done` устанавливается вручную;
- `Lost` в сложных случаях устанавливается вручную;
- `Human Needed` не меняет lifecycle status;
- quote validity и lifecycle status хранятся независимо; непрайсинговое изменение заявки не инвалидирует quote;
- Telegram retries не создают дубли;
- failed/stale Telegram update может быть атомарно повторно захвачен, а updates одного chat сериализуются между processes;
- повторная обработка не создаёт второй Calendar event;
- ошибка Calendar write не может привести к `Booked`;
- external IDs сохраняются после успешных side effects;
- секреты не сохраняются в lead, activity payload, Trello или frontend.

## Integration boundaries

### Direct integration

- Telegram Bot API.

### Composio MCP

- Trello: read/create/update/move card и согласованный label;
- Google Calendar: read availability и create event.

Gmail и Telegram через Composio не подключаются.

### OpenAI

Responses и Conversations используются только server-side. Этап 2 реализует собственный bounded gateway: `gpt-5.6-terra`, reasoning `low`, `max_output_tokens: 1200`, максимум четыре tool-call шага и один retry только для transient `429/5xx`. Доступны только strict tools update validated client data, deterministic price calculation и Human Needed. Controlled live E2E выполнил реальные Responses/Conversations вызовы только для синтетического Telegram lead.

Решение владельца от 2026-08-20: первым подэтапом Этапа 3 выполнить behavior-preserving migration внутреннего runner на `@openai/agents`. Используется один focused agent без handoffs/multi-agent; existing OpenAI `conversationId` остаётся server-managed continuation state. Сначала должны пройти parity tests текущего Telegram → Quote flow, затем разрешается добавлять Calendar tools. Дальнейшие paid calls не нужны до отдельно согласованного сценария следующего этапа.

## Environments and deployment

Supabase: создан отдельный cloud demo-проект `cleaning-autopilot-demo` в `eu-central-1` (ref `oqrwshhozbyrqruahkhx`). Remote history синхронизирована со всеми локальными migrations, включая Stage 4 `20260822181054_stage_4_trello_lifecycle.sql` и `20260822193804_stage_4_trello_recovery_outbox.sql`; это additive/data-preserving изменения business reference, Trello persistence и recovery outbox. RLS включён на всех таблицах. Calendar token RPC доступны только `service_role`: итоговая read-only проверка вернула `false` для `anon`/`authenticated` и `true` для `service_role`. Post-Stage-4 advisors не нашли WARN/ERROR. INFO `RLS enabled without policy` у server-only tables ожидаемы, как и неиспользуемые индексы в ещё почти пустом demo-проекте; отсутствующий covering index на FK `telegram_chat_leases.update_id` — отдельное additive performance-улучшение, не блокирующее корректность.

Railway workspace уже имеет оплаченный владельцем Hobby plan, поэтому отдельный project использует существующий включённый лимит без новой подписки. Создан Railway project `cleaning-autopilot` (id `893e9990-b083-4879-aaf5-5694a4427624`) в workspace `maxim-4400's Projects`; CLI связал с ним этот локальный репозиторий. В нём создан один `web` service и public domain `https://web-production-db062.up.railway.app`, с одной replica в EU West. Server-only Stage-4 Trello и reconciliation configuration переданы в `production/web` через stdin без вывода values; `TRELLO_BOARD_ID` уже существовал и не менялся. Последний production deployment `abc99d65-1c10-4d43-8c6d-07f250c13822` успешен, а `GET /api/health` публично отвечает `200` с `environment: production`. Service currently has no GitHub source configured, поэтому production deploy выполняется явной Railway-командой после разрешённого merge. Первое развёртывание отвечало `502`, поскольку Docker задаёт `HOSTNAME` container ID, который Next standalone принимал за bind hostname; это исправлено Railway env variable. В процессе E2E найден и исправлен лишний trailing whitespace в `OPENAI_REASONING_EFFORT`: backend намеренно принимает только строгое `low`. Создан постоянный Telegram bot `Sherlock Cleaning` (`@sherlock_cleaning_bot`); token и сгенерированный webhook secret сохранены только в игнорируемом `.env.local`, без Git или frontend. Владелец самостоятельно загрузил утверждённый аватар. Его webhook указывает на Railway route; `getWebhookInfo` подтверждает URL, `pending_update_count: 0` и отсутствие последней Telegram ошибки. Ранее ошибочно подставленный token относился к постороннему Composio bot: его ошибочная webhook-registration была снята с сохранением pending updates, а затем правильный token проверен по `getMe` и синхронизирован локально и в Railway без вывода значения. В `.env.local` безопасно сохранены OpenAI project key/model/reasoning configuration, Supabase URL/server secret и project-scoped Composio API key; ни одно значение не выводится. Для будущих этапов созданы два календаря `Cleaning Team A` и `Cleaning Team B` (timezone `Europe/Belgrade`) и private Trello board `Cleaning Autopilot — Demo`. После read-only discovery владелец разрешил controlled setup 2026-08-22: без удаления cards/lists/labels три пустых default lists были переименованы в `New Lead`, `Qualified`, `Booked`; созданы пустые `Done` и `Lost`; один пустой red label переименован в `Human Needed`; пять прочих пустых labels сохранены. В production acceptance 2026-08-23 создана и сохранена одна synthetic запись: один private Calendar event и одна Trello card в `Booked`; очистка demo-данных не выполнялась. Создан изолированный Composio Platform project `Sherlock_Cleaning` (dashboard identifier; пользовательское название ограничено буквами/цифрами/underscore) с managed auth configs для Google Calendar и Trello. Обе connection подтверждены active в новом проекте. Ненужное Miro connected account удалено из старого Composio project; существующие Miro boards не изменялись. Публичный repository [maxim-4400/cleaning-autopilot](https://github.com/maxim-4400/cleaning-autopilot) создан; Bootstrap merged в `main` через PR #1, Stage 2 merged через PR #2, Stage 3 через PR #4 и post-merge reliability fix через PR #5.

Принята поэтапная поставка: infrastructure bootstrap → тестируемый `Telegram → Quote` vertical slice → Booking → Trello → Demo Console. Каждый новый крупный Pull Request по возможности проверяется в Railway Preview Environment до merge. Preview не заменяет локальные проверки и не должен выполнять опасные сценарии против production-данных.

Для Stage 4 recovery не используется Railway Cron. Минимальная периодичность Railway Cron — пять минут, а первый retry outbox требуется через одну минуту; cron поэтому не удовлетворяет принятому retry-contract. При включённом production feature flag `src/instrumentation.ts` запускает singleton in-process runner в единственной persistent `web` replica раз в 60 секунд. После acceptance read-only log подтвердил один реальный цикл `claimed: 1, completed: 1, retried: 0, manual: 0`; runner довёл confirmation-recovery job до `done`. При переходе на несколько web replicas эту модель нужно отдельно пересмотреть и снова проверить lease/operational ownership.

Выполненные external side effects: cloud demo-проект Supabase с additive migrations, публичный GitHub repository с base/feature branches и merged PR #1/#2, постоянный Telegram bot `Sherlock Cleaning` (`@sherlock_cleaning_bot`) с пользовательски загруженным аватаром и active Railway webhook, два Google calendars, private Trello board с пятью Stage 4 lists и одним `Human Needed` label, Composio project `Sherlock_Cleaning`/API key/auth configs/active connections, удаление лишнего Miro connected account из прежнего project и Railway project/web service/EU deployment/public domain. Controlled Stage 4 acceptance создал и сохранил один synthetic Telegram lead/Conversation, выполнил ограниченные real OpenAI calls, создал ровно один private synthetic Calendar event и одну Trello card в `Booked`; final Telegram confirmation доставлен. Другие demo-данные не удалялись.

Для локальной разработки и CI по умолчанию нужны fake/stub adapters. Точные команды фиксируются здесь после появления реального `package.json` и scripts.

## Verification status

Проверено после Этапа 2 под Node `v26.4.0`:

- чистый `pnpm install --frozen-lockfile` в отдельной временной директории проходит под Node 26; `allowBuilds.unrs-resolver` зафиксирован как безопасный boolean `false`;
- чистая CI-последовательность без исходных `.next` и `node_modules`: frozen install, lint, typecheck, unit tests и production build;
- `npm run check` после reliability changes: lint без warnings, source и test-file typecheck, Vitest (`30 passed`) и `next build --webpack`;
- targeted Stage 3A agent gateway tests: реальный SDK transport с fake Responses fixtures подтвердил передачу model/reasoning/token/conversation settings, strict Zod tool schemas, server-managed `conversationId`, serial tool output, один явно safe retry `5xx`, отказ от ambiguous stateful retry после tool output и safe-marked `409`, закрытие четвёртого tool output перед final turn, deterministic escalation и следующий turn того же Conversation;
- Stage 3A local gate: lint, source/test typecheck, все 32 Vitest tests, production Webpack build, `git diff --check` и Playwright Chromium landing-page smoke (`1 passed`) прошли; fake Telegram → Quote coverage остаётся unit-level и не выполняла paid OpenAI calls;
- Stage 3B local gate: lint, source/test typecheck, все 38 Vitest tests, production Webpack build, Playwright Chromium smoke и `git diff --check` прошли. Fake flow покрывает `Quote → slots → opaque token → один persisted Calendar reservation`; Calendar success оставляет lifecycle `Qualified` и создаёт activity `calendar_reserved_pending_trello`.
- 3B review-fix local gate: lint, source/test typecheck, 45 Vitest tests, production Webpack build, Playwright Chromium landing-page smoke (`1 passed`) и `git diff --check` прошли. Новые tests покрывают 14-day availability horizon, current-day/past boundary, deep minimum/overflow, fail-closed Composio free/busy fixture, Calendar-event recovery after lead persistence failure, Calendar failure without quote supersede, numbered fake slot selection и `New address` reset boundary/second press.
- Unit coverage включает pricing minimum/surcharges/extras/same-day, half-up rounding, 100/101/150/151/200 m², >200 escalation, webhook duplicate, conversation persistence, fake Telegram send failure, отсутствие premature `Qualified`, bounded Responses tool loop, transient retry и strict-schema null placeholders;
- Playwright Chromium E2E: стартовая страница открывается (`1 passed`);
- local built-server webhook smoke в явном `INTEGRATION_MODE=fake`: неверный Telegram secret вернул `401`; валидный update — `200 processed`; его повтор — `200 duplicate`; наружу не было вызовов;
- собранный `.next/standalone/server.js` запускается и фактически отвечает `200` на `/api/health`;
- GitHub Actions в PR #1 и PR #2: frozen install, lint, typecheck, unit tests и build успешно завершены;
- cloud Supabase `cleaning-autopilot-demo` повторно проверен после review migration: remote history совпадает с четырьмя local filenames, `agent_config` содержит v1/v2; controlled E2E добавил ровно один synthetic lead и одну persisted Conversation;
- real production E2E через `@sherlock_cleaning_bot`: English synthetic standard lead запросил недостающие поля, после их сообщения бот доставил authoritative quote `4,800 RSD`; lead стал `qualified`, `human_needed=false`;
- повтор последнего signed Telegram update вернул `200` / `duplicate` без повторного OpenAI или Telegram side effect;
- прежний real out-of-scope follow-up (`post-renovation` commercial office) доставил manual-review reply; до reliability fix он очищал quote и ошибочно переводил lead в `new_lead`; новые targeted unit tests подтверждают исправленную модель: `Qualified` и snapshot quote сохраняются, quote помечается `superseded`, `human_needed=true`;
- production webhook safe preflight с валидным secret и пустым update после исправления configuration вернул ожидаемый `400`; до этого `503` был диагностирован как невалидный `OPENAI_REASONING_EFFORT` с trailing whitespace, затем исправлен локально и в Railway;
- ручной smoke-check: landing page открыта в Chrome на `http://localhost:3000`.
- cloud Supabase после reliability migration: remote history содержит `20260820221152_stage_2_review_reliability`; SQL inspection подтвердил новые columns, таблицу и обе RPC functions без чтения клиентских данных.
- локальные migration filenames синхронизированы с remote history, включая Stage 4 Trello lifecycle и recovery outbox migrations.
- `git diff --check` прошёл для reliability edits; новые files дополнительно проверены через build/typecheck/tests и Playwright landing-page E2E (`1 passed`).
- post-merge reliability fix: `npm run check` под Node `v26.4.0` прошёл (76 Vitest tests, lint, source/test typecheck и production build), Playwright Chromium smoke (`1 passed`) и `git diff --check` прошли; GitHub Actions PR #5 завершился успешно.
- cloud migration acceptance: `20260821215641_stage_3_reliability_claim_recovery.sql` применена после dry-run, local/remote history совпадают; direct synthetic RPC проверка подтвердила, что processed chat-lease owner пропускает N+1, а live `received` owner возвращает `in_progress`.
- production acceptance 2026-08-21: Railway deployment `1865406e-676a-43ee-8a66-c8ba1fdccb8b` success и health `200`; controlled synthetic chat прошёл `New address → standard 75 m² / 3 rooms / 2 bathrooms → quote 6,500 RSD → real slots → typed #1`. Создан ровно один private Calendar event, lead остался `Qualified`, а повтор signed update вернул `duplicate` без второго event. Доступный existing test chat был English-locked по контракту, поэтому реальный agent prompt подтвердил короткий natural English request for the only missing date; Russian renderer coverage остаётся unit-level до появления отдельного Russian Telegram test chat.
- adaptive-language release 2026-08-22: [PR #6](https://github.com/maxim-4400/cleaning-autopilot/pull/6) (commit `3d9fdf3`, merge `239d3d3`) прошёл GitHub CI и merged. Независимый review принял per-message locale, bounded locale в slot callback с legacy English fallback, Serbian Latin/Cyrillic slot labels, deterministic ambiguity fallback и text-slot selection. Local `npm run check` прошёл: lint, source/test typecheck, 91 Vitest tests и production build; Playwright Chromium smoke прошёл (`1 passed`), `git diff --check` чист. Additive migration `20260821231317_adaptive_per_message_language.sql` успешно применена: local/remote history совпадает; v5 `agent_config` существует ровно один раз. Railway production deployment `cb103ff1-b6db-4224-bc39-b3642995838e` success, health `200`. Controlled owner-test-chat run отправил `New address`, затем EN → RU → Serbian Latin → Serbian Cyrillic synthetic turns: все пять signed webhook requests вернули `200 processed`, новый lead имеет config v5/`und`, один Conversation и пять успешных Telegram delivery operations. Визуальная проверка в залогиненном Chrome Telegram Web подтвердила четыре live reply: English, Russian, Serbian Latin и Serbian Cyrillic корректны по языку/script и не показывают raw Markdown или internal token. Исторический pre-release turn `Привет → English reply` остаётся в chat как наглядный пример заменённого language-lock поведения.
- Stage 4 cloud release 2026-08-22: две additive migrations прошли `db push` после dry-run, после чего local/remote migration history совпали; Supabase advisors вернули только ожидаемые INFO. Real Trello server-only configuration и internal reconciliation secret записаны в Railway через stdin. Railway production deployment `90cd4da0-f07e-49ad-ad9b-594d90a0ef62` success; public health вернул `200`. Railway Functions API/UI не создаёт cron-function из-за `Unauthorized` сразу после успешного CLI OAuth, но отдельный cron был признан неверным механизмом: Railway минимально запускает его раз в 5 минут, тогда как первый outbox retry должен происходить через минуту. Вместо него `src/instrumentation.ts` запускает singleton in-process recovery runner в единственной persistent `web` replica. После independent review и build-artifact verification production deployment `e0479ed2-5ff3-4a60-a6cd-c787419d6bff` success; feature flag включён только в `production/web`, health вернул `200`, а read-only logs подтвердили последовательные 60-second cycles с `claimed: 0, completed: 0, retried: 0, manual: 0`. Эти empty cycles не создавали Trello/Telegram/Calendar данных. Full final local gate прошёл: lint, source/test typecheck, 147 Vitest tests, production build, executable instrumentation verifier и `git diff --check`. Runner вызывает `trelloRecovery.reconcileDueJobs(25)`, не пересекает запуски, логирует только aggregate counts и не заменяет защищённый internal reconciliation endpoint.
- Stage 4 final release and acceptance 2026-08-23: local `npm run check` прошёл (lint, source/test typecheck, 16 test files / 161 Vitest tests, Webpack production build и executable instrumentation verifier); `git diff --check` чист. Последний Railway deployment `abc99d65-1c10-4d43-8c6d-07f250c13822` имеет status `SUCCESS`, а production health вернул `200`. В залогиненном пользовательском Chrome Telegram проведён один новый synthetic lead: English fixture (standard cleaning, 75 m², 3 rooms, 2 bathrooms, `123 Test Street, Belgrade`, future ISO date, no pets/extras) сразу получил English quote `6,500 RSD` без вопроса о standard/same-day. Запрос Serbian Latin вернул ровно три enabled slots: Team A 03 Sep 08:00, Team B 03 Sep 08:00, Team A 03 Sep 08:30; первый был нажат один раз. Read-only production inspection подтвердил `booked`, `human_needed=false`, active quote `6500`, ровно один созданный Calendar event, одну Trello card в `Booked`, один consumed slot, доставленное финальное Telegram confirmation и outbox job `done`. Runner log подтвердил recovery cycle `claimed: 1, completed: 1, retried: 0, manual: 0`.

Ограничения проверки:

- локальный Supabase Docker stack не запускался: Docker server на этой машине был остановлен; идентичная migration применена к новому пустому cloud demo-проекту;
- локальный Docker/Postgres всё ещё недоступен (`127.0.0.1:54322`), поэтому Stage 3 migration не воспроизводились локально. Data-preserving `20260821150739_stage_3_calendar_reservation.sql` и `20260821150758_stage_3b_order_boundary.sql` применены к cloud demo-проекту; inspection подтвердил columns, active unique index, обе RPC functions и RLS.
- Composio direct execution для private Google Calendar connection требует project `userId` вместе с `connectedAccountId`; прежний adapter передавал только connection и получил `400 ActionExecute_ConnectedAccountEntityIdRequired`. `COMPOSIO_GOOGLE_CALENDAR_USER_ID` добавлен как server-only env, затем read-only preflight подтвердил exact pinned `googlecalendar@20260821_00` payload: `data.calendars[calendar_id]` содержит `busy` и `free`, но не прежний `is_reliable`. Calendar timestamps возвращаются как RFC 3339 с Belgrade offset (например, `+02:00`), поэтому строгая validation принимает ISO `Z` и offset; missing/invalid entry по-прежнему fail-closed. Ошибка более раннего key-preflight была вызвана двойным присваиванием `COMPOSIO_API_KEY=COMPOSIO_API_KEY=...` в `.env.local`, а не самим новым ключом. Лишний префикс удалён без вывода секрета; `COMPOSIO_API_KEY`, user ID, connection ID и toolkit version синхронизированы в Railway production через stdin с `--skip-deploys`. Controlled E2E выполняется на отдельном test lead.
- Railway production deploy в EU West проверен публичным `GET /api/health`; изолированный Railway environment `pr-4` также успешно развернул точный Stage 3 PR commit в EU West. Его public preview использует `INTEGRATION_MODE=fake` и `APP_ENV=preview`, public `GET /api/health` вернул `200` / `environment: preview`. Preview не менял production runtime; позднее в production variables отдельно обновлён только валидный `COMPOSIO_API_KEY` с `--skip-deploys`, поэтому production deploy не перезапускался;
- для local E2E скачен отдельный Playwright Chromium; он не использует пользовательский Chrome profile.
- browser E2E всё ещё покрывает только landing-page smoke; real Telegram flow проверен вручную в пользовательском Chrome и через cloud rows, а не Playwright route test с real credentials.
- Финальный production run покрывает только happy path. Provider failure, delayed retry/reconciliation, duplicate delivery и stale/terminal callback guards проверены автоматизированными unit/integration tests, но не повторялись как отдельные реальные внешние сценарии в финальном run.
- встроенная pnpm-обёртка Codex на этой машине всё ещё передаёт вызов под Node 24 и пытается пересоздать существующий `node_modules`; конфигурация репозитория не допускает Node 24. Эквивалентный package script `check` успешно выполнен через npm, установленный вместе с Node 26; чистый frozen install отдельно проверен настоящим pnpm под Node 26.

Неблокирующие замечания, которые нужно учитывать дальше:

- Supabase Auth для demo-console оставляет password provider включённым, но public signup и confirm-email выключены; создан один подтверждённый Admin user с `profiles.role=admin`.
- Next standalone в Railway требует `HOSTNAME=0.0.0.0`, иначе Docker-provided hostname приводит к edge `502`; это уже задано только в Railway environment.

## Open questions

До соответствующей реализации нужно согласовать:

1. финальные message templates bot, кроме уже принятой кнопки `New address` и divider templates;
2. точный минимальный набор данных Trello card;
3. правила retention персональных данных и conversation history;
4. точную стратегию Railway preview с fake adapters после Этапа 2.

Открытые вопросы не должны блокировать независимый bootstrap, но нельзя молча принимать решения в той части реализации, на которую они влияют.

## Stage 4 — complete

Stage 4 добавил real Trello lifecycle и lease-fenced recovery outbox: additive migrations сохраняют business reference, Trello persistence и recovery jobs; real Composio adapter pinned to `trello@20260812_00` проверяет topology и post-write readback; fake adapter покрывает пять lifecycle states, независимый `Human Needed`, idempotent create/update/move/label sync, Calendar → Trello → Booked ordering, terminal `Done`/`Lost` и локализованное confirmation. Outbox обслуживает qualified и booked failures без нового customer message, создаётся атомарно рядом с persisted Calendar reservation, не создаёт Calendar events, применяет retry `1m → 5m → 15m → 30m`, отражает `Human Needed` с 15-й минуты, становится manual с 60-й минуты и использует единый booking-stable Telegram delivery key.

Финальное точечное hardening: urgency выводится на backend из валидного `preferredDate` в timezone `Europe/Belgrade`; `today` означает `same_day`, future date — `standard`, а изменение даты перезаписывает прежнее значение. Старый или terminal callback не может заново запустить reservation/Trello/booking или customer-message loop; восстановление разрешено только исходному валидно consumed token. Production acceptance 2026-08-23 подтвердил один полный real happy path до `Booked` и финального Telegram confirmation. Synthetic lead, Calendar event, Trello card и related operational rows намеренно retained; удаление или backfill не выполнялись.

## Stage 5 — complete

Stage 5 реализует защищённую Demo Console как презентацию кейса, а не CRM: `/login`, `/dashboard` и `/settings`; реальный Supabase password login/logout и Admin-only API; компактное hamburger-меню; supplied Sherlock avatar; единый `Lead proof` с безопасной сводкой последнего лида, текущим evidence-based статусом и подтверждённой историей только этого `lead_id`.

Dashboard читает server-only privacy-safe DTO через authenticated polling каждые 5 секунд. Он сохраняет последний валидный snapshot при `503`/network error и явно показывает paused updates, а не рисует линейный pipeline или фиктивный provider live state. Persisted `run_turn`, recovery/sync operations, `Human Needed` и terminal state имеют приоритеты, исключающие ложное `Booking confirmed`. Trello показан как application lifecycle projection с безопасной board-link; Miro — embed/fallback одинакового визуального веса. Prompt и Pricing сохраняются как одна атомарная server-file configuration version, строго валидируются и применяются к новым Telegram turns; baseline version-controlled, corrupt active file откатывается к baseline.

Production acceptance 2026-08-23: Additive migration `20260823150000_stage5_direct_trello_card_url.sql` применена без backfill; проверка подтвердила сохранность 11 existing leads и 4 existing Trello card IDs. Создан один confirmed Supabase Admin с `profiles.role=admin`; public signup и confirm-email выключены, password provider остаётся включённым. Railway Volume `web-volume` смонтирован в `/data`; `DEMO_CONSOLE_CONFIG_PATH`, public Supabase browser key и безопасные Trello/Miro ссылки применены в production. PR #9 исправил standalone packaging Next: `.next/static` и `public` копируются в runtime bundle, повторные builds идемпотентны. Final Railway deployment `9bf67b88-98e6-44fa-bf24-59203a152f25` имеет `SUCCESS`; public health и все 9 static login assets вернули `200`. В пользовательском Chrome Admin login открыл dashboard, который показал latest-lead context, evidence-based integration snapshot, Trello projection и Miro fallback; `/settings` загрузил baseline Main Prompt и Pricing Rules. Runtime configuration не изменялась во время acceptance. Пока провайдер при следующей sync не вернёт canonical URL карточки, UI честно использует board fallback. Per-turn runtime prompt fingerprint остаётся отдельным будущим migration/contract: текущая схема хранит immutable DB `agent_config_version`, поэтому runtime hash не подменяется.

Consistency release 2026-08-24: Stage 5 дополнительно исправляет UI/production truthfulness around the demonstrable flow: product-native OpenAI asset, readable human-led Trello titles and safe direct contacts, all five live Trello lifecycle columns, public Team A/Team B availability embeds, public Miro iframe/direct link, responsive admin navigation and independent prompt/pricing editing. `booked` больше не означает `Booking confirmed`, пока pending/recovery Trello sync не завершён; post-commit sync acceleration best-effort и не отменяет durable Calendar reservation. Seeded public calendar load содержит 40 owned synthetic daytime events (20 per team) across late August/September, with current-near density and no 06:00 shifts. Latest accepted Railway deployment `7a9415c7-6ea1-4279-9e54-85a7a5871a6a` is `SUCCESS`; health is production `ok`. Controlled owner-approved Chrome acceptance retained all old data and created two additional synthetic flows: a Russian Team A booking on Sat 29 Aug 12:30 Europe/Belgrade (6,500 RSD, event only in Team A), and a Russian post-renovation Human Needed lead with a readable Trello card, reason, label, and safe Telegram link. Full local `pnpm check` passed (24 files/232 tests, lint, typechecks, production build, instrumentation), Playwright passed 11/11, and `git diff --check` is clean. The owner independently updated the Telegram avatar, so this agent did not mutate or re-verify that profile image. Detailed evidence and any visibility caveat for the Miro public-link check are in [STAGE5_CONSISTENCY_ACCEPTANCE_2026-08-24.md](./documentation/STAGE5_CONSISTENCY_ACCEPTANCE_2026-08-24.md).

## Next step

MVP1 Stages 1–5 завершены. Новую работу начинать только с отдельно согласованного product scope; существующий production demo поддерживать без удаления synthetic данных. Подробное Stage 4 handoff остаётся в [documentation/STAGE4_COMPLETION_HANDOFF_2026-08-23.md](./documentation/STAGE4_COMPLETION_HANDOFF_2026-08-23.md).
