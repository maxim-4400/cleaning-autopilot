# Cleaning Autopilot

Cleaning Autopilot is a presentation-ready MVP for a small Belgrade cleaning
service. It demonstrates how a customer enquiry can move from a Telegram
conversation to a confirmed, operationally traceable booking without turning a
demo dashboard into a replacement CRM.

## What the product demonstrates

```text
Telegram customer enquiry
  -> AI assistant gathers only the missing details
  -> deterministic backend pricing
  -> availability across two Google Calendar team calendars
  -> explicit customer slot choice
  -> Google Calendar reservation and Trello lifecycle update
```

The assistant keeps the conversation natural, but pricing, availability,
booking state, idempotency, and integration side effects remain controlled by
typed backend rules. Requests outside the supported scope are retained for a
human follow-up instead of receiving an invented quote.

## Scope

This repository is an interview/demo MVP, not a public consumer service or a
general-purpose CRM. It includes one operational flow for one-time cleaning,
a protected Demo Console, and synthetic demonstration data. Recurring
cleaning, customer sign-up, and unrelated business operations are deliberately
out of scope.

## Public demo links

- [Try the Telegram assistant](https://t.me/sherlock_cleaning_bot)
- [Open the protected Demo Console](https://web-production-db062.up.railway.app)
- [View the project Miro board](https://miro.com/app/board/uXjVHwbGl-w=/?share_link_id=104117806222)

The Demo Console requires its intentionally restricted Admin sign-in. The
Telegram assistant and Miro board are the public entry points for the showcase.

## Architecture and stack

- **Application:** Next.js, React, TypeScript, Tailwind CSS
- **Conversation layer:** Telegram Bot API and OpenAI Agents SDK
- **Business rules:** deterministic pricing, lifecycle and scheduling services
- **Data and auth:** Supabase PostgreSQL and Supabase Auth
- **Operations:** Google Calendar and Trello through Composio
- **Hosting:** Railway

The application uses a hybrid design: the language model handles natural
conversation and structured understanding, while the backend owns all
financial and external-write decisions.

## Safe local start

The project declares Node.js 26 and pnpm 11. Use the repository's own
versions; do not substitute a system launcher with a different Node major.

```bash
cp .env.example .env.local
npm run check
```

`.env.example` defaults to fake integrations. Local checks do not require
production credentials and must not create external provider data. To run a
fully interactive local console, provide your own non-production Supabase
settings in `.env.local`; never copy owner, production, or provider secrets
into the repository.

Useful commands:

```bash
pnpm dev
npm run test:e2e
npm run check
```

## Documentation map

- [Documentation index](documentation/README.md) — a readable map of current
  documents, operations and historical records.
- [MVP1 requirements](documentation/MVP1_REQUIREMENTS.md) — product contract
  and acceptance boundaries.
- [Project context](PROJECT_CONTEXT.md) — current architecture, operational
  decisions and verified state.
- [Calendar isolation](documentation/CALENDAR_PRIMARY_ISOLATION.md) — the
  safety rule that prevents demo events from reaching a personal primary
  calendar.
- [Conversation evaluation](documentation/CONVERSATION_LIVE_EVALUATION.md) —
  controlled evaluation protocol and evidence boundaries.

## Security and demo-data policy

No secrets, admin credentials, provider identifiers, customer data, or private
integration values belong in Git, screenshots, or frontend responses. The
repository stores only configuration names and safe examples. External
operations are performed only through explicitly approved, synthetic scenarios.
