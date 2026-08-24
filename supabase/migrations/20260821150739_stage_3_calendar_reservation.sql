-- Stage 3B: server-owned Calendar reservation tokens. This migration is additive.
alter table public.integration_operations
  drop constraint if exists integration_operations_provider_check;

alter table public.integration_operations
  add constraint integration_operations_provider_check
  check (provider in ('telegram', 'openai', 'google_calendar'));

create table public.calendar_slot_tokens (
  token uuid primary key,
  lead_id uuid not null references public.leads(id) on delete cascade,
  team text not null check (team in ('team_a', 'team_b')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  buffer_ends_at timestamptz not null,
  expires_at timestamptz not null,
  schedule_fingerprint text not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (starts_at < ends_at and ends_at < buffer_ends_at)
);

create index calendar_slot_tokens_lead_expires_at_idx
  on public.calendar_slot_tokens (lead_id, expires_at desc);

alter table public.calendar_slot_tokens enable row level security;
revoke all on public.calendar_slot_tokens from anon, authenticated, service_role;
grant select, insert, update on public.calendar_slot_tokens to service_role;

create or replace function public.consume_calendar_slot_token(
  p_token uuid,
  p_lead_id uuid,
  p_now timestamptz
)
returns table (
  token uuid,
  lead_id uuid,
  team text,
  starts_at timestamptz,
  ends_at timestamptz,
  buffer_ends_at timestamptz,
  expires_at timestamptz,
  schedule_fingerprint text,
  consumed_at timestamptz
)
language sql
set search_path = public
as $$
  update public.calendar_slot_tokens as slot
  set consumed_at = p_now
  where slot.token = p_token
    and slot.lead_id = p_lead_id
    and slot.consumed_at is null
    and slot.expires_at > p_now
  returning slot.token, slot.lead_id, slot.team, slot.starts_at, slot.ends_at,
    slot.buffer_ends_at, slot.expires_at, slot.schedule_fingerprint, slot.consumed_at;
$$;

revoke all on function public.consume_calendar_slot_token(uuid, uuid, timestamptz) from public;
grant execute on function public.consume_calendar_slot_token(uuid, uuid, timestamptz) to service_role;

insert into public.agent_config (version, system_prompt, pricing_rules)
select
  3,
  $prompt$
You are the single customer-facing assistant for a Belgrade home-cleaning service.

Language:
- Continue in the lead's fixed first-message language. For an unknown first language, detect it and include its BCP-47 code in update_client_data.

Data and quote:
- Save only facts supported by the customer message. Use null for unknown fields and never erase known data.
- Ask only for missing required intake details.
- Never calculate or invent a price. Call calculate_quote only after all required fields are saved.
- Escalate renovation, commercial, unusually dirty, unsupported or uncertain work; do not quote it.

Scheduling:
- After an active quote, call request_available_slots only when the customer asks to see or choose times.
- Present only returned slot labels and their opaque slot tokens. Never invent a time, a team or a token.
- Call reserve_slot only when the customer explicitly selects one offered token.
- A calendar reservation is not final booking confirmation. Do not say Booked or promise final confirmation.

Safety:
- You may use only the supplied semantic tools. Pricing, availability, lifecycle and external writes are decided by the backend.
  $prompt$,
  pricing_rules
from public.agent_config
where version = 2;
