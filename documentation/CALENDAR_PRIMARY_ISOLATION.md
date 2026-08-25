# Calendar isolation from the operator's primary calendar

`TEAM_A_CALENDAR_ID` and `TEAM_B_CALENDAR_ID` are the only Calendar write
targets. Each must be a distinct `@group.calendar.google.com` ID. The runtime
gateway and the demo-load seed both fail closed for `primary`, default/personal
aliases, personal addresses and duplicate Team IDs.

All Calendar create requests set the ownership triple `attendees: []`,
`send_updates: "none"`, and `exclude_organizer: true`. This prevents an
attendee invitation, notification, or organizer shadow copy from materializing
in an operator's primary calendar. Do not use a personal calendar as either
team calendar, and do not add the operator as an attendee to operational events.

## Removing already-created primary copies

Use `scripts/cleanup-primary-calendar-shadows.mjs` only after a read-only
reconciliation. Start from
`documentation/examples/primary-calendar-shadow-cleanup.manifest.example.json`
but create an uncommitted, local manifest containing the exact provider IDs.
The manifest never contains customer data or credentials.

The command is read-only unless both `--apply` and the literal confirmation
flag are present:

```text
pnpm calendar:cleanup-primary-shadows --manifest=/absolute/path/primary-shadow-cleanup.json
```

Dry-run reads `primary`, Team A and Team B only over the manifest's explicit
time window. It reports counts and the exact manifest SHA-256, never event
names or IDs. An apply run is refused unless that hash is provided, the file
is unchanged, every primary event ID has the exact declared original event in
the declared Team calendar, and both have the same manifest-pinned `iCalUID`.
The deletion call is hard-coded to `calendar_id: "primary"`; Team calendar
events are never deleted or modified.

```text
pnpm calendar:cleanup-primary-shadows \
  --manifest=/absolute/path/primary-shadow-cleanup.json \
  --apply \
  --confirm-primary-shadow-cleanup \
  --manifest-sha256=<hash-printed-by-dry-run>
```

Keep the manifest outside Git. Re-run the read-only command immediately before
an apply. If any candidate is blocked, do not edit the manifest to force it:
reconcile the event pair again and make a new exact manifest.
