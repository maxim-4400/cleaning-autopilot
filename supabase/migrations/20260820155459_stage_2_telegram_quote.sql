-- Stage 2: Telegram → AI conversation → deterministic quote.
-- Calendar, Trello, booking and Admin UI intentionally remain out of scope.
create type public.lead_status as enum ('new_lead', 'qualified', 'booked', 'done', 'lost');
create type public.telegram_update_status as enum ('received', 'processed', 'failed');
create type public.integration_operation_status as enum ('pending', 'succeeded', 'failed', 'ambiguous');

create table public.agent_config (
  version integer primary key,
  system_prompt text not null,
  pricing_rules jsonb not null,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(pricing_rules) = 'object')
);

insert into public.agent_config (version, system_prompt, pricing_rules)
values (
  1,
  $prompt$
You are the intake assistant for a Belgrade home-cleaning service. Continue in the lead's first-message language. Collect only missing fields, never calculate prices yourself, and use the provided tools. Escalate uncertain or out-of-scope work instead of guessing. Calendar, booking and Trello are unavailable in this stage.
$prompt$,
  '{
    "version": 1,
    "standardRateRsdPerM2": 80,
    "standardMinimumRsd": 4000,
    "deepRateRsdPerM2": 160,
    "deepMinimumRsd": 9000,
    "extraBathroomRsd": 500,
    "heavyPetHairRsd": 900,
    "extrasRsd": {
      "windows": 900,
      "oven_inside": 1000,
      "fridge_inside": 900,
      "balcony_or_terrace": 1000
    },
    "sameDayMultiplierPercent": 120,
    "volumeDiscountPercent": {
      "upTo100": 0,
      "from101To150": 5,
      "from151To200": 10
    }
  }'::jsonb
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint not null unique,
  first_message_language text not null default 'en' check (char_length(first_message_language) between 2 and 16),
  status public.lead_status not null default 'new_lead',
  client_data jsonb not null default '{}'::jsonb check (jsonb_typeof(client_data) = 'object'),
  agent_config_version integer not null default 1 references public.agent_config(version),
  pricing_rules_snapshot jsonb,
  quoted_price_rsd integer check (quoted_price_rsd > 0),
  quoted_at timestamptz,
  human_needed boolean not null default false,
  human_needed_reason text,
  assigned_team text,
  booked_start timestamptz,
  booked_end timestamptz,
  trello_card_id text,
  calendar_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (human_needed and human_needed_reason is not null)
    or (not human_needed and human_needed_reason is null)
  ),
  check ((quoted_price_rsd is null) = (quoted_at is null))
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null unique references public.leads(id) on delete cascade,
  telegram_chat_id bigint not null unique,
  openai_conversation_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.telegram_updates (
  update_id bigint primary key,
  telegram_chat_id bigint,
  telegram_message_id bigint,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  processing_status public.telegram_update_status not null default 'received',
  failure_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  check (
    (processing_status = 'failed' and failure_code is not null)
    or (processing_status <> 'failed' and failure_code is null)
  )
);

create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create table public.integration_operations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  provider text not null check (provider in ('telegram', 'openai')),
  operation_type text not null,
  idempotency_key text not null,
  status public.integration_operation_status not null default 'pending',
  external_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, operation_type, idempotency_key)
);

create index leads_status_created_at_idx on public.leads (status, created_at desc);
create index activity_log_lead_created_at_idx on public.activity_log (lead_id, created_at desc);
create index integration_operations_lead_created_at_idx on public.integration_operations (lead_id, created_at desc);

alter table public.agent_config enable row level security;
alter table public.leads enable row level security;
alter table public.conversations enable row level security;
alter table public.telegram_updates enable row level security;
alter table public.activity_log enable row level security;
alter table public.integration_operations enable row level security;

create trigger leads_set_updated_at
before update on public.leads
for each row
execute function public.set_updated_at();

create trigger conversations_set_updated_at
before update on public.conversations
for each row
execute function public.set_updated_at();

create trigger integration_operations_set_updated_at
before update on public.integration_operations
for each row
execute function public.set_updated_at();

revoke all on public.agent_config, public.leads, public.conversations, public.telegram_updates,
  public.activity_log, public.integration_operations from anon, authenticated, service_role;

grant select on public.agent_config to service_role;
grant select, insert, update on public.leads, public.conversations, public.telegram_updates,
  public.integration_operations to service_role;
grant select, insert on public.activity_log to service_role;
