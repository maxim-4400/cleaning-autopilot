-- Stage 3B: data-preserving multiple orders in one Telegram chat.
alter table public.leads
  add column active_in_chat boolean not null default true;

alter table public.leads
  drop constraint if exists leads_telegram_chat_id_key;

alter table public.conversations
  drop constraint if exists conversations_telegram_chat_id_key;

create unique index leads_one_active_per_telegram_chat_idx
  on public.leads (telegram_chat_id)
  where active_in_chat;

create index leads_telegram_chat_history_idx
  on public.leads (telegram_chat_id, created_at desc);

create or replace function public.start_new_address_lead(
  p_telegram_chat_id bigint,
  p_first_message_language text,
  p_agent_config_version integer
)
returns setof public.leads
language plpgsql
set search_path = public
as $$
declare
  v_current public.leads%rowtype;
  v_new public.leads%rowtype;
begin
  select * into v_current
  from public.leads
  where telegram_chat_id = p_telegram_chat_id
    and active_in_chat
  for update;

  -- A second button press before a new message should reuse the pristine lead.
  if found
    and v_current.client_data = '{}'::jsonb
    and v_current.quoted_price_rsd is null
    and v_current.human_needed = false
    and v_current.calendar_event_id is null
    and not exists (select 1 from public.conversations where lead_id = v_current.id)
  then
    return next v_current;
    return;
  end if;

  if found then
    update public.leads
    set active_in_chat = false
    where id = v_current.id;
  end if;

  insert into public.leads (
    telegram_chat_id,
    active_in_chat,
    first_message_language,
    agent_config_version
  ) values (
    p_telegram_chat_id,
    true,
    p_first_message_language,
    p_agent_config_version
  )
  returning * into v_new;

  return next v_new;
end;
$$;

revoke all on function public.start_new_address_lead(bigint, text, integer) from public;
grant execute on function public.start_new_address_lead(bigint, text, integer) to service_role;
