-- Stage 5: an optional, server-owned date proposal. It is deliberately
-- separate from preferred_date until the customer confirms it.
alter table public.leads
  add column if not exists pending_preferred_date date,
  add column if not exists date_proposal_expires_at timestamptz,
  add column if not exists date_proposal_version text,
  add column if not exists date_proposal_locale text;

alter table public.leads
  add constraint leads_date_proposal_pair_check
    check ((pending_preferred_date is null) = (date_proposal_expires_at is null)) not valid;

alter table public.leads validate constraint leads_date_proposal_pair_check;

alter table public.leads
  add constraint leads_date_proposal_version_check
    check (date_proposal_version is null or date_proposal_version ~ '^[A-Za-z0-9_-]{12,80}$') not valid,
  add constraint leads_date_proposal_locale_check
    check (date_proposal_locale is null or date_proposal_locale in ('en', 'ru', 'sr-Latn', 'sr-Cyrl')) not valid;

alter table public.leads validate constraint leads_date_proposal_version_check;
alter table public.leads validate constraint leads_date_proposal_locale_check;
