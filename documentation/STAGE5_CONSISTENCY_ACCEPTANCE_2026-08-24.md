# Stage 5 consistency slice — acceptance checklist

This document is the release gate for the 2026-08-24 Demo Console consistency
slice. Every item below requires evidence from the actual production dashboard
in the owner’s Chrome after the approved deployment. Local tests are necessary
but do not complete this acceptance.

## 1. Navigation and brand

- The Sherlock dog mark in the desktop navigation is large enough to recognise
  and is fully visible: the cleaning sparkle at its top-left is not cropped.
- Desktop has a standard hamburger control. It can collapse and reopen the
  sidebar without breaking Dashboard, Settings, the current-admin indication,
  or Log out.
- Mobile navigation remains an accessible drawer, rather than a desktop panel
  forced into a narrow viewport.

## 2. Latest-lead proof and integration icons

- The lead panel explicitly says that it is real-time information about the
  latest lead, so "booking confirmed" and other statuses have clear scope.
- It does not claim a provider was checked live when the evidence is only an
  application snapshot.
- Telegram, OpenAI, Google Calendar, and Trello each show a recognisable
  product icon in both the hero flow and integration-readiness list. The
  OpenAI mark must be a standalone OpenAI mark, never OpenAI Gym, a text
  substitute, or a crop performed by CSS at render time.

## 3. Trello links, operational cards, and Human Needed

- `Open in Trello` opens the canonical `Cleaning Autopilot — Demo` board, not
  a personal/default Trello board or the top of the dashboard.
- Card links, when present, open their actual Trello cards in a new tab.
- A controlled synthetic Human Needed flow is checked separately after
  approval: its card has a human-readable title, a safe Telegram contact link
  when a public username exists, an explanation of why manual review is
  needed, and the dashboard shows the same current state for the latest lead.
- Any cleanup of old experiment cards is **not** implicit in this checklist.
  Before archiving anything, list the exact cards to retain/archive and obtain
  a separate owner confirmation. Existing demo data is retained by default.

## 4. Team calendars

- Team A and Team B public calendars render as read-only embedded calendar
  views in the dashboard, not as empty configuration placeholders.
- The views display availability/events appropriate to each team. A confirmed
  new booking appears in the selected team calendar and not in the other one.
- The time shown in the selected public calendar matches the Telegram and
  dashboard confirmation in `Europe/Belgrade`; a UTC-shifted event is not
  accepted as correct booking evidence.
- Both public team calendars contain a retained, clearly synthetic demo load
  across late August and September. The load uses varied daytime blocks and
  is denser nearer to the current demo date, so the bot can demonstrate both
  occupied periods and realistic remaining options. Existing demo events are
  preserved; only known synthetic test events may be corrected or added.
- The dashboard does not expose private calendar credentials or event payloads
  outside the public-calendar view.

## 5. Miro embed and page rhythm

- The Miro embed fills its container horizontally with no unused white strip
  or cropped right edge.
- `Open Miro` opens the intended project board in a new tab; iframe fallback is
  compact and clearly explains how to use the direct link if embed is blocked.
- Major sections (hero, latest lead, Trello, calendars, Miro) have visibly
  comfortable separation while preserving the existing vertical composition.

## 6. Live Trello lifecycle projection

- The Trello panel always renders all five lifecycle columns: `New Lead`,
  `Qualified`, `Booked`, `Done`, and `Lost`, including zero-count columns.
- The panel is a read-only live Trello snapshot, not a Supabase-only
  reconstruction. A manually created card and a manually moved card in `Done`
  or `Lost` appear after the bounded refresh interval (target: 30 seconds).
- The dashboard does not write to Trello or change the application lead state
  while reading the board. If Trello becomes unavailable, it shows the last
  confirmed snapshot as stale instead of inventing an empty successful board.
- Only safe card presentation data reaches the browser: bounded card title,
  lifecycle, Human Needed flag, and validated direct card link. Descriptions,
  contacts, provider payloads, and business-reference markers remain server
  side.

## 7. Public Miro access

- The supplied public-view link
  `https://miro.com/app/board/uXjVHwbGl-w=/?share_link_id=104117806222`
  is checked as the candidate canonical board URL.
- If it opens the board in view-only mode without Miro registration, the
  dashboard's direct action and iframe configuration use that public sharing
  context rather than a login-bound editor URL.
- Production evidence must include an unauthenticated browser check. If the
  provider does not permit an unauthenticated iframe despite an unauthenticated
  direct link, the dashboard keeps the compact iframe fallback and directs the
  viewer to the verified public link; it must not claim that an embedded public
  view is available.

## 8. Telegram avatar safe crop

- The Telegram profile avatar uses the avatar-safe revision
  `public/brand/sherlock-cleaning-telegram-avatar-safe.png` after explicit
  approval to update the real bot profile.
- Telegram's circular crop must preserve both the dog/halo identity and the
  teal cleaning sparkle badge. No meaningful badge detail may sit in a corner
  that Telegram clips.
- The final bot profile is visually checked in Telegram at its rendered small
  size; the source square alone is not acceptance evidence.

## 9. Conversational booking resilience

- After `New address`, a Russian service conversation retains Russian as its
  primary language when later messages include normal Latin notation such as
  `m²`, `m2`, or a Latin spelling of a Belgrade district. Replies remain
  natural and do not fall back to English merely because of that notation.
- A single detailed Russian message preserves every explicit fact before any
  Human Needed handoff. A post-renovation or commercial request is escalated
  in Russian and gets a labelled `New Lead` Trello card; it is not silently
  absent from the live board projection.
- The bot accepts customer-friendly date language, including a date without a
  year, relative dates such as "in two days", and weekend requests. When a
  phrase has more than one reasonable interpretation, it proposes a concrete
  date/time for confirmation rather than asking for a backend-only `urgency`
  field or a rigid date format.
- A confirmed booking is the only point at which the dashboard's booking
  value is populated and the selected team calendar receives an event. A
  preferred date or a presented slot must not be displayed as confirmed.

## Required release evidence

1. Relevant unit, lint, typecheck, build, and end-to-end checks pass locally.
2. The exact Railway environment values needed for the canonical board and
   public embeds are set through stdin without logging values, then a fresh
   production deployment succeeds.
3. Production health passes and each checklist item is inspected in the
   owner’s Chrome.
4. The controlled Human Needed test and any Trello cleanup only run after the
   explicitly scoped external-data approval described above.

## 2026-08-24 release-evidence record

The owner approved controlled synthetic external tests. Existing demo data was
retained; no Trello cards, Calendar events, or conversations were deleted.

- **1. Navigation and brand — passed.** Production Chrome shows the complete
  dog mark, desktop sidebar collapse control, Dashboard/Settings, current
  admin, and Log out. Responsive drawer behavior is covered by the local
  end-to-end suite.
- **2. Latest-lead proof and product icons — passed.** The production panel is
  explicitly scoped to the latest lead and labels provider data as an
  application snapshot. Telegram, OpenAI, Google Calendar, and Trello use
  their product assets in both required locations.
- **3. Trello and Human Needed — passed.** A fresh Russian synthetic
  post-renovation request created a `New Lead` card titled
  `Maxim Savchenko · Vračar · 55 m²`, with the `Human Needed` label, explicit
  `Human Needed: after renovation` reason, and a public Telegram contact link.
  The dashboard simultaneously showed `Human Needed` and linked to that exact
  card. `Open in Trello` points to the canonical demo board.
- **4. Team calendars — passed.** A fresh Russian booking selected Team A on
  Saturday 29 August at 12:30 Europe/Belgrade. The same booking and 6,500 RSD
  quote appeared in Telegram and in the latest-lead panel; the event appeared
  in Team A's public calendar and did not appear in Team B's. Both public
  embeds rendered their retained synthetic daytime load.
- **5. Miro and page rhythm — passed with public-link evidence.** The dashboard
  rendered the configured Miro embed without the former right-side white strip,
  and its direct action targets the supplied board. A cookie-free request to
  the supplied view link returned HTTP 200. The owner Chrome was already
  signed in to Miro, so this release record does not claim a separate visual
  anonymous-browser screenshot.
- **6. Live Trello projection — passed.** Production Chrome showed all five
  lists, including `Done` and `Lost`, from the live board snapshot. The
  dashboard's Trello and per-card actions contain canonical external URLs.
- **7. Public Miro access — passed at transport level.** The supplied share URL
  returned HTTP 200 without browser credentials. The dashboard retains a
  compact fallback if an embedding context blocks the provider.
- **8. Telegram avatar — owner-managed and excluded from this agent release
  gate.** The owner confirmed that the real bot profile image has already been
  updated; no second avatar upload or profile mutation was made.
- **9. Conversational booking resilience — passed.** `New address` followed by
  a detailed Russian message with Latin `m²`/`Vračar` retained Russian,
  calculated the quote, offered actual calendar slots, and confirmed the
  chosen booking. A separate Russian post-renovation request retained its
  facts and escalated rather than being silently lost. The dashboard leaves a
  requested date distinct from a confirmed booking.

Local release checks passed after the final code changes: `pnpm check`
(24 test files / 232 tests, lint, both typechecks, production build, and
instrumentation verification), `pnpm test:e2e` (11/11), and `git diff --check`.
Initial Railway deployment `7a9415c7-6ea1-4279-9e54-85a7a5871a6a` succeeded.
After GitHub PR #3 merged, the exact released source was deployed again as
`21bcabdc-0328-4730-8fe5-3a55929d1f2d`, also `SUCCESS`; `GET /api/health`
returned production `ok` after that final deployment.
