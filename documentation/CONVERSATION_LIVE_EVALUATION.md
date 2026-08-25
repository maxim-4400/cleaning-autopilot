# Local live conversation evaluation

This opt-in evaluator uses the production `processTelegramWebhook`
orchestration against an immutable synthetic manifest of **20** scenarios and
**86** customer messages: six progressive 6–8-message conversations and
fourteen focused checks. Only the OpenAI agent is live. Repository, Telegram,
Calendar, Trello and clock adapters remain in memory/fake, so the evaluator
cannot send Telegram messages, write Supabase, create Calendar events, update
Trello or deploy the application.

## Dry run first

```bash
node scripts/conversation-live-eval.mjs
```

Dry run never constructs an OpenAI gateway. It prints the canonical manifest
SHA-256, which binds the fixtures, prompt revision/hash, pricing rules/model,
and every execution limit to a later paid invocation.

The first two smoke fixtures are exact shared bindings: `ru-price-no-booking`
and `ru-correction-date-booking` use the same customer messages, turn cap and
post-message quote/date/slot/reservation checkpoints in the deterministic
webhook suite. The S2 evening path uses an explicitly isolated fake-calendar
fixture for a 90 m² Team A evening slot on 26 August; it is evaluator-only and
does not assert or alter production team capacity.
The v15 dry manifest supersedes every v14 (and earlier) report. Its evaluator
normalizes **only** `visibleIncludes` comparison (case, Unicode hyphen/dash and
whitespace), while preserving raw transport text and all safety checks. Failed
checkpoint output now identifies its exact checkpoint index and field. Generate
its exact SHA-256 locally immediately before any separately approved paid
invocation; an earlier v14/v13/v12/v11/v10/v9 report cannot be reused.
The latest verified v15 dry run has fixture SHA-256
`affe83df59727bbcda357b131a14665f789109c5283fa510598b408e72bea27e`
and manifest SHA-256
`cf79e80f98c4e3181dd153d3df7cd891556448d52b055ba7d9e1ea6831ce0534`.

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
