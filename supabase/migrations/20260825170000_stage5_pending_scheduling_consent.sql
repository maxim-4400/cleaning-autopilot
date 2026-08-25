-- A short-lived semantic marker for the next customer turn after the typed
-- quote template. It is not a booking consent and does not contain a token.
alter table public.leads
  add column if not exists pending_scheduling_consent_quoted_at timestamptz;
