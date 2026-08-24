-- Stage 3B Telegram conversation UX: stable server-side slot offers and a new immutable customer voice.
-- Existing rows stay available for audit only; unconsumed legacy offers are not selectable after this migration.
alter table public.calendar_slot_tokens
  add column offer_id uuid,
  add column display_order smallint,
  add column superseded_at timestamptz;

update public.calendar_slot_tokens
set
  offer_id = coalesce(offer_id, gen_random_uuid()),
  display_order = coalesce(display_order, 1),
  superseded_at = coalesce(superseded_at, now())
where offer_id is null or display_order is null;

alter table public.calendar_slot_tokens
  alter column offer_id set not null,
  alter column display_order set not null,
  add constraint calendar_slot_tokens_display_order_check check (display_order between 1 and 3);

create index calendar_slot_tokens_active_offer_idx
  on public.calendar_slot_tokens (lead_id, offer_id, display_order)
  where consumed_at is null and superseded_at is null;

drop function public.consume_calendar_slot_token(uuid, uuid, timestamptz);

create function public.consume_calendar_slot_token(
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
  consumed_at timestamptz,
  offer_id uuid,
  display_order smallint,
  superseded_at timestamptz
)
language sql
set search_path = public
as $$
  update public.calendar_slot_tokens as slot
  set consumed_at = p_now
  where slot.token = p_token
    and slot.lead_id = p_lead_id
    and slot.consumed_at is null
    and slot.superseded_at is null
    and slot.expires_at > p_now
  returning slot.token, slot.lead_id, slot.team, slot.starts_at, slot.ends_at,
    slot.buffer_ends_at, slot.expires_at, slot.schedule_fingerprint, slot.consumed_at,
    slot.offer_id, slot.display_order, slot.superseded_at;
$$;

create or replace function public.replace_calendar_slot_offer(
  p_lead_id uuid,
  p_offer_id uuid,
  p_now timestamptz,
  p_slots jsonb
)
returns setof public.calendar_slot_tokens
language plpgsql
set search_path = public
as $$
begin
  if jsonb_typeof(p_slots) <> 'array' or jsonb_array_length(p_slots) > 3 then
    raise exception 'calendar slot offer must contain zero to three options';
  end if;

  update public.calendar_slot_tokens
  set superseded_at = p_now
  where lead_id = p_lead_id
    and consumed_at is null
    and superseded_at is null;

  return query
  insert into public.calendar_slot_tokens (
    token,
    lead_id,
    team,
    starts_at,
    ends_at,
    buffer_ends_at,
    expires_at,
    schedule_fingerprint,
    offer_id,
    display_order
  )
  select
    (slot.value ->> 'token')::uuid,
    p_lead_id,
    slot.value ->> 'team',
    (slot.value ->> 'starts_at')::timestamptz,
    (slot.value ->> 'ends_at')::timestamptz,
    (slot.value ->> 'buffer_ends_at')::timestamptz,
    (slot.value ->> 'expires_at')::timestamptz,
    slot.value ->> 'schedule_fingerprint',
    p_offer_id,
    (slot.value ->> 'display_order')::smallint
  from jsonb_array_elements(p_slots) with ordinality as slot(value, ordinal)
  order by slot.ordinal
  returning *;
end;
$$;

revoke all on function public.consume_calendar_slot_token(uuid, uuid, timestamptz) from public;
grant execute on function public.consume_calendar_slot_token(uuid, uuid, timestamptz) to service_role;
revoke all on function public.replace_calendar_slot_offer(uuid, uuid, timestamptz, jsonb) from public;
grant execute on function public.replace_calendar_slot_offer(uuid, uuid, timestamptz, jsonb) to service_role;

insert into public.agent_config (version, system_prompt, pricing_rules)
select
  4,
  $prompt$
You are the single customer-facing digital assistant for Sherlock Cleaning, a Belgrade home-cleaning service.

Voice:
- Sound like a warm, attentive and concise service coordinator, never like a form, database or tool loop.
- Acknowledge what the customer has shared. Ask only the next one or two related missing details, and do not ask again for known information.
- Use the lead's fixed first-message language. For an unknown first language, detect it and include its BCP-47 code in update_client_data.
- Never claim to be human. If asked directly, explain briefly and truthfully that you are Sherlock Cleaning's digital assistant.

Customer safety:
- Never expose or mention tools, JSON, UUIDs, slot tokens, event IDs, internal statuses, Human Needed, Qualified, team sync or backend processes.
- Do not use Markdown syntax. The backend owns customer-facing quote, time-option, reservation and escalation blocks.

Data and quote:
- Save only facts supported by the customer message. Use null for unknown fields and never erase known data.
- Ask only for missing required intake details.
- Never calculate or invent a price. Call calculate_quote only after all required fields are saved.
- Escalate renovation, commercial, unusually dirty, unsupported or uncertain work; do not quote it.

Scheduling:
- After an active quote, call request_available_slots only when the customer asks to see or choose times.
- The backend securely presents the returned options and handles customer selections. Never invent a time or identifier.
- A calendar reservation is not final booking confirmation. Do not say Booked or promise a completed booking.

Safety:
- You may use only the supplied semantic tools. Pricing, availability, lifecycle and external writes are decided by the backend.
  $prompt$,
  pricing_rules
from public.agent_config
where version = 3;
