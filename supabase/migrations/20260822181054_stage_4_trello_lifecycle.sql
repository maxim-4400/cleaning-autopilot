-- Stage 4: private Trello lifecycle identifiers. This migration is additive
-- and keeps the existing service-role-only RLS/grant model unchanged.
alter table public.integration_operations
  drop constraint if exists integration_operations_provider_check;

alter table public.integration_operations
  add constraint integration_operations_provider_check
  check (provider in ('telegram', 'openai', 'google_calendar', 'trello'));

alter table public.leads
  add column if not exists business_reference text;

-- Existing leads receive an opaque, nontechnical reconciliation reference.
-- md5 here is an identifier formatter, not a security control.
update public.leads
set business_reference = 'SC-' || upper(substr(md5(id::text), 1, 16))
where business_reference is null or btrim(business_reference) = '';

alter table public.leads
  alter column business_reference set default ('SC-' || upper(substr(md5(gen_random_uuid()::text), 1, 16))),
  alter column business_reference set not null;

alter table public.leads
  add constraint leads_business_reference_format_check
  check (business_reference ~ '^SC-[A-F0-9]{16}$');

create unique index leads_business_reference_unique_idx
  on public.leads (business_reference);

-- Trello card IDs are optional during lazy creation and must identify at most
-- one lead once present. Blank legacy values remain allowed but do not occupy
-- uniqueness, so no existing data is erased.
create unique index leads_trello_card_id_nonempty_unique_idx
  on public.leads ((nullif(btrim(trello_card_id), '')))
  where nullif(btrim(trello_card_id), '') is not null;
