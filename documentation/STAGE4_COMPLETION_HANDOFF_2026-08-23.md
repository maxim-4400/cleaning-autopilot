# Stage 4 completion handoff — 2026-08-23

## Status

Stage 4 is complete. It delivered the real Trello lifecycle, recovery outbox and the final controlled production happy-path acceptance. No later stage has been authorized or started.

## Production baseline

- Latest Railway production deployment: `abc99d65-1c10-4d43-8c6d-07f250c13822` — `SUCCESS`; public health returned `200`.
- Supabase contains the additive Stage 4 lifecycle/recovery migrations and the subsequent safe outbox upsert fix. No legacy data was deleted or backfilled.
- Recovery is served by the singleton in-process runner in the one persistent production `web` replica, scheduled every 60 seconds. Railway Cron is intentionally not used: its five-minute minimum cannot meet the first one-minute retry. Any future multi-replica deployment requires a fresh ownership/lease review.

## Acceptance evidence

One new synthetic Telegram lead was run through the authenticated owner Chrome session:

1. `New address` followed by an English standard-cleaning fixture (75 m², 3 rooms, 2 bathrooms, test Belgrade address, future ISO date, no pets/extras) received an immediate English quote of `6,500 RSD`, without a standard-versus-same-day question.
2. A Serbian Latin availability request returned exactly three enabled buttons: Team A 03 Sep 08:00, Team B 03 Sep 08:00, Team A 03 Sep 08:30.
3. The first button was clicked once. Read-only production inspection confirmed `booked`, `human_needed=false`, one consumed slot, exactly one Calendar event, one Trello card in `Booked`, and delivered final Telegram confirmation.
4. The recovery outbox reached `done`; the runner log recorded `claimed: 1, completed: 1, retried: 0, manual: 0`.

The synthetic lead, conversation, Calendar event, Trello card and related operational rows are intentionally retained. Do not delete demo data without separate user authorization.

## Important implementation constraints

- Backend, not the model, derives urgency from a valid `preferredDate` in `Europe/Belgrade`: today becomes `same_day`, a future date becomes `standard`, and a date change overwrites stale urgency.
- A stale or terminal inline callback must not create Calendar, Trello, booking or per-update Telegram side effects. Only the original valid consumed callback token may recover its existing reservation.
- No secrets, raw provider IDs or customer data belong in documentation, Git or command output.

## What was not live-tested in the final run

The final production scenario is one successful happy path only. Provider failure, delayed retry/reconciliation, duplicate delivery and stale/terminal callback handling are covered by automated unit/integration tests rather than separate live external scenarios in this run.

## Verification record

The final local gate passed `npm run check` (lint, source/test typecheck, 16 test files / 161 Vitest tests, Webpack production build and instrumentation verifier), plus `git diff --check`. Production health, lead state, Calendar/Trello integration operations and outbox state were inspected read-only after the single approved click.

## Next action

Do not begin Stage 5 or any other work automatically. A new stage requires explicit user authorization, an agreed scope and acceptance criteria; production mutations or paid calls require their own current-turn approval.
