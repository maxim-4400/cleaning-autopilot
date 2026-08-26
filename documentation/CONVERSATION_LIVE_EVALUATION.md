# Local live conversation evaluation

This opt-in evaluator uses the production `processTelegramWebhook`
orchestration against an immutable synthetic manifest of **20** scenarios and
**89** customer messages: six progressive 6–8-message conversations and
fourteen focused checks. Only the OpenAI agent is live. Repository, Telegram,
Calendar, Trello and clock adapters remain in memory/fake, so the evaluator
cannot send Telegram messages, write Supabase, create Calendar events, update
Trello or deploy the application.

## Current local-only v36.3 contract

The next dry run is **v36.3**. It supersedes v36.2, v36.1, v36 and v35.2, v35.1, v35, v34.3, v34.2, v33, v32, v31, v30, v29, v28, v27, v26, v25, v24, v23, v22, v21, v20, v19, v18, v17, v16 and v15 as an approval input because
quoted/offered scheduling is now decided by the single agent through typed,
privacy-safe semantic actions, rather than a phrase router. Evaluation records
the selected canonical availability intent or explicit no-Calendar decision in
addition to tool names, without retaining customer text, Calendar IDs, tokens
or provider payloads. A successful fully-booked Calendar read is checked as a
qualified, queryable no-slots outcome; a separate synthetic Calendar transport
failure is the only `calendar_unavailable` / Human Needed case. The prior v21 contract
also proves that a Calendar search aligns the durable preferred date and price
to the actual offered day, isolates date/time updates from ordinary re-quote
patches in quoted/offered state, and records a semantic action only after the
tool executor has actually completed. A calendar offer created from an agent
tool is persisted only after that provider turn has a final response, so a
post-tool provider failure cannot leave invisible active tokens. If the deferred
token write or agent-turn completion acknowledgement fails, the backend writes
an empty replacement offer before restoring the lead and rendering the safe
Calendar handoff. Date-only semantic follow-ups explicitly preserve a prior
time window, while explicit `any` clears it; both modes are required in each
availability action and the latter has an explicit absent-window checkpoint.
The mode has no schema default: generic or date-only availability asks must
explicitly select `preserve`, while midpoint/evening/literal-any requests use
`explicit`.

V35 treats literal `after`, `before`, and `range` bounds as hard deterministic
constraints across the full 14-day search and any fallback ranking. If no
compliant start exists, `request_available_slots` returns typed
`no_available_slots` / `requested_time_unavailable` with the failed bound,
offer disposition, and only two consented next paths (`earlier_time` or
`different_date`); it does not create a replacement offer, mutate the durable
date/window/quote, or silently show an out-of-bound time. A retained prior
offer remains selectable and uses dedicated RU/EN/SR copy; an explicit
`reject_now` makes it stale. A later customer intent still performs a fresh
Team A + Team B read. Completed availability reads remain auditable even for
no-slots business outcomes, while a refused `record_scheduling_decision` is
not recorded as a semantic scheduling action.

V35.1 makes the allowed consent paths constraint-specific: `after` can only
ask for `earlier_time` or `different_date`, `before` for `later_time` or
`different_date`, and a `range` for `outside_requested_range` or
`different_date`. Dedicated RU/EN/SR retained-offer copy follows the same
meaning and never suggests an earlier time for a `before` request.

V35.2 changes no timeout or scheduling product behavior. It narrows two
evaluator-only semantic equivalents: before any availability offer, a completed
`question_not_about_scheduling` no-Calendar decision may accompany a price
correction, and a date-only `Tomorrow` follow-up may explicitly repeat the
already-selected `evening` window instead of encoding it as `preserve`. Both
alternatives remain exact and bounded. Provider accounting is conservative:
every final timeout/transport leg is explicitly unreconciled, regardless of
whether the SDK exposes partial or zero-valued usage. Any released subtotal is
retained once; no token or currency usage is invented and the started Responses
request still consumes the shared cap.

V36 adds a privacy-safe **current-turn date coordinate** for an exact date the
customer actually states while a quote is active. It is derived once from the
fixed Belgrade turn clock for RU/EN/SR today, tomorrow, day-after/in-N and
absolute-date forms, then passed only in that in-memory scheduling snapshot.
It is never written to the lead, activity log or provider Conversation. The
provider's `request_available_slots` schema dynamically exposes only dates the
authoritative snapshot supports; without a durable preferred date it cannot
choose `current_preferred_date`, and an exact stated date permits only that
exact ISO date. The backend repeats this fence before Team A/B reads, so an
injected or stale coordinate yields typed validation with zero Calendar reads,
slot tokens, quote/date writes or urgency drift. A later customer turn receives
no old transient coordinate and uses only its durable offer/state.

V36.1 makes that coordinate exclusive: when the current customer message names
one valid date, the provider schema and deterministic executor accept only that
date branch, never a stale preferred date or an old offer. The parser collects
RU/EN/SR candidates and refuses date-scoped negation or multiple distinct dates
instead of guessing. If there is no current or durable date after a safe
no-slots result, its typed candidate date is exposed only as one exact fallback
for a fresh time-only Calendar re-read; it remains non-durable and cannot drift
the quote, urgency or lead date on another no-slots/transport result.

V36.2 keeps that current-turn exclusivity, but when no current coordinate is
present it exposes a validated `lastAvailabilityAttempt.candidateDate` as an
exact option alongside durable preferred/offer references. Thus a time-only
refinement after a typed `no_slots` or Calendar failure re-reads the exact date
the customer just asked about instead of drifting to an older request. The
executor accepts that sanitized exact candidate even while an old offer remains
selectable; no-slots/failure still changes neither durable date nor quote.
Absolute ISO input is intentionally strict: exactly one valid current/future
`YYYY-MM-DD` date is recognized before localized parsing. A past, invalid,
negated, or multiple ISO date is not a coordinate, and slash-form dates are
not treated as ISO.

V36.3 is evaluator/fixture-only. It adds no runtime branch: the 55 m²
correction permits only its existing two finite tool paths (direct
`update_client_data → calculate_quote`, or one truthful
`record_scheduling_decision` after that re-quote) and either no scheduling audit or
that exact truthful audit. On the third fully-booked checkpoint, the two
existing `current_preferred_date` forms are joined only by exact
`2026-08-26` `any/fresh/none` forms with `preserve` or `explicit` mode. Quote,
preferred-date and typed last-attempt assertions remain unchanged.

#### Recorded manual waiver: v36.2 diagnostic mapping (2026-08-26)

- Immutable smoke report SHA-256:
  `619ea5f44c8317d865ccde91fd3a6ec7d88b688b7a9f7bb1e4281e87f6800f47`.
- Immutable remaining report SHA-256:
  `b4a96176fef7003f5139b9b30ac5c79e70cfb696b2abde80eae9e74dbdf46853`.
- Both reports bind the prior v36.2 manifest:
  `3449e897297d7dfd0b0295f86af41192c2c4835a09ff35e6341ff04d0ad3543b`.
- The v36.3 dry manifest is
  `15b9017308c4d1d6d3909fddff2efa74f8b7d6b805b0e5b868feaab7d13ef8bf`.

Read-only re-evaluation is 5/5 smoke and 15/15 remaining. It changes only the
two finite classifications above: the correction's observed ordered tool path
is `update_client_data → calculate_quote → record_scheduling_decision` with no
scheduling action; the fully-booked final action is the safe `exact_date`,
`any`, `fresh`, `none`, `explicit` variant while its typed candidate-date
evidence remains exact. The two source reports remain byte-for-byte immutable;
this diagnostic waiver is not a new paid/live run, not an accepted continuation
and not production acceptance.

When a required quoted/offered primary model turn completes with no tool
execution started, no tool result, quote or scheduling action, v30 permits one
bounded stateless **full-primary omission replay**. It rebuilds the same agent,
full primary prompt, original message, validated data, pricing rules,
authoritative scheduling snapshot, allowed tools and shared update lease, but
never passes the durable Conversation id. It may therefore make the ordinary
validated data update, deterministic quote, availability request or truthful
no-Calendar decision; it never bypasses backend validation or executor guards.
The replay is one attempt, no recursion, at most four model turns, nine seconds,
no parallel tool calls, and shares the caller signal and Responses counter.
Zero-tool replay, timeout, executor failure or Conversation invalidation failure
fails closed with no deferred-offer commit or false success. Any primary tool
execution makes the turn ineligible. The omission replay cannot stack with the
pre-tool provider-failure replay. Known provider-leg usage aggregates exactly
once; an unpublished replay leg remains explicitly unreconciled. A successful
omission replay resets the durable Conversation before deferred Calendar state
is committed or the operation is completed. The manifest binds this mechanical
contract, full-primary prompt binding and gateway/webhook source hashes.

V31 adds a deterministic pricing fence around that same replay and the normal
primary path. If a currently active quoted/offered request changes a pricing
input, the earlier quote is superseded in memory; before any Conversation reset,
deferred-offer commit or successful turn completion, that turn must complete a
backend `calculate_quote` or Human Needed outcome. Otherwise it fails closed as
`agent_quote_recalculation_missing`, restores the prior lead and active quote,
and creates no Calendar side effect. The long English correction fixture now
binds message six to an active 4,400 RSD quote, update-plus-calculate semantic
tools, no offer and no Calendar create.

For a provider timeout or transport failure before any tool executor starts,
v23 permits exactly one stateless replay of the complete primary prompt and
tool surface. It uses the same original message, validated data, snapshot,
allowed tools, tool-choice and shared update lease, but omits the durable
Conversation. The primary leg is capped at nine seconds, the replay at six,
and replay has at most four turns, preserving the five-response customer-turn
ceiling. It cannot run after a tool starts, cannot retry auth/HTTP/schema/model
or evaluator failures, and cannot stack with the full-primary omission replay.
The manifest independently binds the replay configuration, the base system
prompt SHA-256, and SHA-256 hashes of the actual
`src/lib/agent/gateway.ts` and `src/lib/telegram/webhook.ts` implementations.
Both source hashes are revalidated before either a dry or live run, so an old
manifest cannot be presented as evidence for changed replay, reset or deferred
commit code.
If a primary/replay provider leg does not publish usage, its known other-leg
subtotal is retained with an explicit unreconciled marker. A successful replay
requires the same Conversation invalidation boundary as omission replay.
If both provider legs fail, the evaluator persists the completed recovery
checkpoint and stops that fixture; it never advances to the next customer line
as if the lost message had been replayed.

v24 made only `request_available_slots` terminal after its executor returns.
The primary Agent uses the SDK's scoped `stopAtToolNames` behavior for that
single tool, not global stop-on-first-tool behavior. Its serialized function
result is never customer text: the webhook retains the canonical tool/audit
evidence and selects backend-owned copy for an exact or nearest offer, no
slots, Calendar failure, duration overflow, date-required/validation result or
business refusal. Deferred token commit and agent-turn operation completion
remain the delivery boundary; executor exceptions still fail closed. That v24
continuation behavior is superseded by the v25 reset below. The manifest binds
this terminal-tool configuration together with the existing gateway source
hash.

v25 treats every successful terminal availability outcome as a Conversation
protocol reset, including offers, no-slots and date-required outcomes. The
strict order is preserved: typed tool/audit work, Conversation mapping
invalidation, deferred token commit, turn-operation completion, then one
deterministic Telegram reply. If invalidation fails, the private offer is
discarded and the pre-turn lead is restored; no operation completion or
Calendar create is claimed. The next turn creates a fresh provider Conversation
from the authoritative `offered` snapshot, including safe last-offer labels and
the current active quote amount after availability repricing.

v26 adds a separate whole-suite Conversation-create ledger. The historical v26 cap was exactly
86 (one possible fresh provider Conversation per immutable customer message),
and every attempted `createConversation` is counted immediately before the
external call; the 87th attempt fails closed. The smoke report persists this
ledger and the remaining phase restores it, so acceptance cannot reset the
limit. The v26 manifest also source-binds the gateway **and** webhook above.
v30 preserves that binding and replaces the former structured-repair path;
v29 and earlier reports remain immutable.
For a generic or date-only availability question with no existing durable time
window, the fixture accepts exactly two equivalent canonical decisions:
`preserve` or explicit `any`; it still requires one ordered Calendar request,
with at most one preceding client-data update, and proves that no time window
was persisted. This finite allowance applies to the Russian relative-date,
Serbian generic, fully-booked, Calendar-transport-failure and same-day-after-hours
checkpoints. It does not relax the strict cases: a prior durable window
must be preserved by a date-only follow-up, literal `any time` must explicitly
clear it, and midpoint/evening/after/range requests must carry their exact
explicit constraint.

The synthetic same-day-after-hours scenario runs at 21:42
Europe/Belgrade. A selected option performs one additional selected-team
recheck after the two Team A/B reads. All v28 and earlier reports remain
immutable historical artifacts and must not be relabelled or used as v31
continuation evidence. Generate a new manifest immediately
before any separately approved paid run.

## Dry run first

```bash
node scripts/conversation-live-eval.mjs
```

Dry run never constructs an OpenAI gateway. It prints the canonical manifest
SHA-256, which binds the fixtures, prompt revision/hash, pricing rules/model,
both critical production source hashes and every execution limit to a later
paid invocation.

The first two smoke fixtures are exact shared bindings: `ru-price-no-booking`
and `ru-correction-date-booking` use the same customer messages, turn cap and
post-message quote/date/slot/reservation checkpoints in the deterministic
webhook suite. The S2 evening path uses an explicitly isolated fake-calendar
fixture for a 90 m² Team A evening slot on 26 August; it is evaluator-only and
does not assert or alter production team capacity.
The fixed 20-scenario manifest also includes `pet-hair-context`: after the
bot asks for the missing pet-hair detail, an ambiguous "dog at home" message
must not alter pricing, while a later explicit Russian negation produces the
base quote. Local webhook regressions retain the matching affirmative,
ambiguous and negative parsing evidence.
The v32 dry manifest supersedes every v31 (and earlier) report. It retains
v20's strict no-default time-mode evidence while accepting only the two
semantically equivalent no-prior-window `any` modes described above. The
immutable v19, v20, v21, v22, v23, v24, v25 and v26 paid reports remain failed historical artifacts;
their observed product behavior is not relabelled as a v32 result.
Generate its exact SHA-256 locally immediately before any separately approved
paid invocation; an earlier report cannot be reused. V32 binds the strict
provider-facing `request_available_slots` envelope: required
`intent.date`, `intent.time`, `intent.relation` and, in V34, required
`intent.existingOfferDisposition` discriminators. `none` is valid only without
an active offer; `retain_until_replacement` preserves it through an unavailable
query; `reject_now` retires it before reads after explicit rejection. Exact dates,
after/before bounds and ranges have their required coordinates; `preserve`
normalizes only to canonical `any + preserve`, while all other time variants
normalize to explicit canonical intent before the unchanged backend validator.
Malformed or semantically invalid provider arguments fail closed before a Team
Calendar read, offer or Calendar create. The latest verified local v33 dry run
must be generated after the gateway, webhook and fixture gates. V33 changes no
runtime product behavior. It adds three synthetic follow-ups and safe
audit-only evidence: every processed message records only sorted active
fake-slot start instants (never token, offer, provider, payload or Calendar
identifiers). The `date-preserve-vs-any` fixture now proves a
later-on-the-same-day replacement after preserve/explicit `any`;
`same-day-after-hours` proves a fresh `after 19:00` request and the explicit
customer-visible no-slots answer; its safe audit evidence separately proves
the nearest 17:30 alternatives; and the long English correction retains the active
4,400 RSD quote while a strict 10:00–16:00 range reads both teams. The
immutable manifest is 20 scenarios / 89 messages: smoke remains 5 / 31,
remaining is 15 / 58, six scenarios remain long, and the whole-suite
Conversation-create cap is exactly 89.
The v24 failed report remains immutable historical evidence and is not
relabelled; the immutable v28 remaining report is not promoted to v32 evidence,
and any approved paid smoke must restart from scenario one.

### V34.2 candidate availability commit hardening

V34.2 hardens the V34 deterministic availability boundary without adding a
model call.
The semantic resolver builds a private candidate lead for Team A/B reads. An
exact offer commits that candidate date/window and aligned quote before the
deferred token write. A nearest fallback commits the actual offered date and
aligned quote but preserves the pre-attempt authoritative time window, so an
unmatched requested window never silently becomes durable. No-slots, transport,
duration and validation outcomes do not persist candidate date, urgency or
quote; no-slots no longer reprices an unchanged lead.

Every completed query records a privacy-safe `calendar_availability_attempted`
activity: outcome class, candidate date, typed time preference/bounds, relation
and timestamp only. A no-slots or failure attempt must be written before the
turn completes; successful-offer logging is best effort only after the deferred
token, operation and customer-delivery boundaries succeed, so a rolled-back
offer cannot leave false success history. Attempt time values use the canonical
08:00–19:30 grid and conditional preference/bound shapes. Attempt history is
read only for `quoted`/`offered` state, and evaluator checkpoints expose only
the validated safe attempt projection. A retained existing offer remains
selectable after a pure Calendar read transport failure; an explicit
`reject_now` remains stale. Fresh Conversations may see that prior attempt as context but must
still call Calendar. Checkpoint comparisons use canonical structural equality,
so object-key insertion order cannot alter acceptance evidence. V33 and older
reports remain immutable and cannot be relabelled as V34 evidence.

When Telegram positively rejects delivery of a newly committed exact/fallback
offer, the webhook retires that deferred generation, restores the pre-turn
scheduling coordinate and aligned quote, then persists `delivery_failed` Human
Needed. An ambiguous Telegram outcome is deliberately different: it preserves
the possibly seen generation for audit but sets `delivery_ambiguous`, which
blocks every automatic callback reservation. A replacement Calendar read that
fails while `retain_until_replacement` is active instead has dedicated RU/EN/SR
copy: the previous options remain selectable and no manual-review follow-up is
promised.

### V34.3 bounded evaluator variants

V34.3 changes only the local evaluator fixture and rubric; runtime gateway,
webhook, renderer, Calendar and repository behavior remain source-identical to
V34.2. A checkpoint may now declare `lastAvailabilityAttemptOneOf`, a finite
exact structural set rather than a partial matcher. The fully-booked fixture
accepts only canonical `no_slots` attempts for 26 August 2026 with
`any`/`fresh` and either `preserve` or `explicit` mode. The date-preserve
fixture permits only the availability tool or one preceding client-data update
plus availability for each of its two date requests. Its final rejection stays
restricted to exactly three same-day/later/reject-now actions:
`any/preserve`, `any/explicit`, or explicit `after 08:30`. Calendar-read
counts, offered starts, stale-token behavior, no-create, state and visible text
remain strict. V34.2 and earlier reports remain immutable; a read-only
re-evaluation is diagnostic only and cannot relabel failed evidence.

The evaluator treats the authoritative Responses-start counter as the 220-call
budget ledger. A completed smoke checkpoint may carry a bounded unpublished
usage gap smaller than one customer turn's five-response ceiling: the gap has
already consumed capacity, while only the provider-published token subtotal is
carried forward. It never invents token usage. Negative gaps, a gap at or above
the five-response bound, malformed counters, or an exhausted budget fail
closed. Read-only evaluation and preflight never mutate or remove supplied
reports; test reports use isolated generated paths.

### Read-only artifact re-evaluation

To diagnose an old immutable report under the current rubric without creating
an OpenAI gateway or writing any report, run:

```bash
node scripts/conversation-live-eval.mjs \
  --re-evaluate-report=.runtime/conversation-live-evaluations/2026-08-25T11-20-13Z.json
```

The command prints a prior-state → re-evaluated-state mapping only. It never
modifies the source artifact and is not a new live evaluation, an accepted
smoke checkpoint, or permission to continue a remaining phase. If an owner
wants to rely on a changed classification, they must record a manual waiver
that names the immutable source report hash, the v15 manifest/hash and the
specific mapping; a separately approved v15 paid run is still required for
fresh acceptance evidence.

#### Recorded manual waiver: v14 artifact mapping (2026-08-25)

- Immutable source report SHA-256:
  `f3918f553e8551a3c2c30c3dd1ad5a4ab52fa05b4acf643765fb3d94d72975ac`.
- Source v14 manifest:
  `14d204e56ceceb4b001ee35f2e805297bece27babac85c33761e000f3d102ecf`.
- Current v15 manifest:
  `cf79e80f98c4e3181dd153d3df7cd891556448d52b055ba7d9e1ea6831ce0534`.
- The sole re-evaluated classification is `en-commercial`: `failed` →
  `passed`, because `commercial-space` and `commercial space` are equivalent
  under v15 `visibleIncludes` normalization.

The v14 artifact itself is unchanged. It remains historical, manually accepted
evidence and is not erased; it is incompatible with any future canonical v15
continuation. This mapping is not a canonical v15 live run and has no
production effect.

Manual product acceptance is 15/15: `en-commercial` is the mapped pass and
the other 14 scenarios remained passed.

## Two manually approved phases

Only after the owner has approved the displayed model and cost boundary, run
the exact smoke command from a persistent terminal session:

```bash
node scripts/conversation-live-eval.mjs --live \
  --phase=smoke \
  --confirm=I_UNDERSTAND_THIS_CALLS_OPENAI \
  --manifest-sha256=THE_MANIFEST_SHA256_FROM_DRY_RUN \
  --scenario-count=20 \
  --max-tool-steps=4 \
  --model=THE_MODEL_FROM_DRY_RUN \
  --reasoning-effort=low \
  --max-output-tokens=1200 \
  --max-suite-duration-ms=1200000
```

All flags are mandatory. The command runs **only the first five immutable
fixtures** (31 customer messages), then writes terminal state
`smoke_complete_pending_acceptance`; it never starts fixtures 6–20 on its
own. Someone must review the five saved transcripts and explicitly approve a
separate continuation. A smoke checkpoint is not evidence that all 20
real-model scenarios passed.

The remaining fifteen fixtures may be started only as a separate, explicitly
approved command. It requires the exact terminal smoke report path; the runner
validates its manifest hash, five immutable fixture IDs, passing status and
remaining Responses capacity before it constructs an OpenAI gateway. It writes
a new report and never rewrites or replays the smoke evidence.

```bash
node scripts/conversation-live-eval.mjs --live \
  --phase=remaining \
  --accepted-smoke-report=.runtime/conversation-live-evaluations/SMOKE.json \
  --confirm=I_UNDERSTAND_THIS_CALLS_OPENAI \
  --manifest-sha256=THE_MANIFEST_SHA256_FROM_DRY_RUN \
  --scenario-count=20 \
  --max-tool-steps=4 \
  --model=THE_MODEL_FROM_DRY_RUN \
  --reasoning-effort=low \
  --max-output-tokens=1200 \
  --max-suite-duration-ms=1200000
```

## Enforced bounds and cancellation

- strict sequential execution, no evaluator retries;
- no more than five Responses model calls per customer message: up to four
  semantic tools plus the mandatory final model closure after the fourth tool;
- semantic tool limit remains four. Reaching an SDK turn ceiling is a technical
  failure, never an automatic `Human Needed` handoff or a reusable poisoned
  Conversation. The local mapping is invalidated before the customer-visible
  resend; the next message creates a fresh Conversation from validated facts.
  Only a second consecutive technical failure in that fresh Conversation may
  become `conversation_ambiguous` Human Needed;
- a first quote is terminal for that customer turn. Availability is allowed
  only on a later, explicit scheduling request with a previously active quote;
  backend remains authoritative for quote, slots, reservation and Human Needed;
- a quote can be issued before a date is chosen. That typed reply must state
  both the ordinary base price and the today price with its +20% uplift, and
  must not offer slots until the customer supplies a date and later asks to
  schedule. A later today request supersedes the base quote and requires that
  separate scheduling acceptance;
- provider HTTP/model-call timeout: at most 12 seconds;
- hard customer-turn deadline: 20 seconds, including Conversation creation;
- focused scenario deadline: 45 seconds; long scenario deadline: 120 seconds;
- whole smoke/suite wall-clock deadline: 20 minutes;
- hard Responses budget: 220. A shared counter increments immediately before
  each actual SDK Responses request at the `ModelProvider → Model` boundary
  and fails closed before request 221. It is restored from the accepted smoke
  report for the remaining phase; no pessimistic per-message reservation is
  made per customer message.
- usage hard caps: input 500,000 tokens, output 20,000 tokens and total
  550,000 tokens. Cached-input tokens are recorded separately. A reached token
  cap yields terminal `incomplete` evidence, never a customer escalation. The
  remaining phase carries the accepted smoke subtotal, so these are whole-suite
  caps rather than two independent budgets.

Timeouts use a real composed `AbortSignal`, propagated to Conversation create
and Agents SDK `Runner.run`; this is not a `Promise.race` wrapper. The gateway
checks that signal before and after semantic tool execution, preventing a
timed-out turn from committing a later result while the evaluator proceeds.

After smoke the report records actual started Responses and remaining capacity.
The accepted smoke checkpoint is the only permitted bridge to phase two; if
the counter reaches the cap, the next model request is refused before sending.

## Checkpoints, evidence and acceptance

Before the first customer message and after **every fully processed customer
message**, the evaluator atomically replaces an owner-only JSON checkpoint
under `.runtime/conversation-live-evaluations/` (gitignored). The report has
only sanitized synthetic text, raw Telegram transport text, normalized visible
prose, trusted-template flag, lead/quote/handoff/slot outcome, ordered
semantic tools, and one provenance-tagged post-message evidence item for each
fixture customer message. Accepted smoke rejects any substituted, reordered or
unprovenanced evidence item even where that message has no special outcome
checkpoint. It also records prompt/pricing/evaluator-rubric hashes, and no provider
conversation IDs, payloads or credentials. Ordinary model prose is treated as
 plain text; raw Telegram HTML is accepted only from typed backend templates.
 If
the launcher detects an abnormal child exit with a still-`running` report, it
marks that checkpoint terminally failed with a sanitized reason.

For completed SDK runs, the report captures aggregate `runContext.usage`:
requests, input/output/total tokens and provider-reported cached-input tokens.
For an aborted/failed provider turn it preserves completed aggregate usage from
the latest partial artifact. `MaxTurnsExceededError` reads released SDK state
usage when exposed; otherwise the report marks it `unreconciled`, never as zero
cost. It never invents a currency cost, response ID or provider payload.

The automated smoke gate requires 5/5 scenarios without critical outcome,
external-artifact, invented quote/slot/booking, unsafe/empty reply, canned
opening thanks or full intake checklist. Intake quality is explicit: a reply
may ask one fact or one related pair, but an enumerated request for three or
more intake groups fails the rubric; repeating already-known context around a
normal related pair does not. The current v11 fixture also asserts: an area
over 200 m² becomes backend-owned Human Needed without a quote; weekend
Sunday fallback persists and confirms one Saturday candidate; post-handoff
questions cannot call tools and later facts have at most one data update; and
an incidental weather/today question cannot create a preferred date. English
named dates persist through a full-calendar failure without reopening the
quote, and `Can someone help find another date?` receives a tool-free direct
handoff confirmation. Unsupported
sofa/carpet and commercial turns must acknowledge stains, carpet material or a
staff kitchen, explain that price needs manual preparation, and record the
nearest Thursday rather than producing a generic handoff acknowledgement. It
records p50/p95 message latency;
targets are p50 ≤8s and p95 ≤15s, with every completed turn ≤20s. Passing
these technical checks does not replace a human review of friendliness,
professionalism and natural conversation in the five transcripts.

Use a persistent terminal and wait for the launcher to exit. It prints the
exact report path, which may be viewed from a second terminal:

```bash
tail -f .runtime/conversation-live-evaluations/THE_TIMESTAMP.json
```
