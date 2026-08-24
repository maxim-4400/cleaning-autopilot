-- Recover a later Telegram update when an older update is no longer actively leased.
-- This replaces the Stage 2 claim function without changing its signature or grants.
create or replace function public.claim_telegram_update(
  p_update_id bigint,
  p_telegram_chat_id bigint,
  p_telegram_message_id bigint,
  p_payload jsonb,
  p_lease_seconds integer default 300
)
returns table (claim_status text)
language plpgsql
set search_path = public
as $$
declare
  v_update_claimed boolean := false;
  v_chat_claimed boolean := false;
  v_existing_status public.telegram_update_status;
  v_lease_expires_at timestamptz;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'p_lease_seconds must be between 30 and 600';
  end if;

  v_lease_expires_at := now() + make_interval(secs => p_lease_seconds);

  with claimed_update as (
    insert into public.telegram_updates (
      update_id,
      telegram_chat_id,
      telegram_message_id,
      payload,
      processing_status,
      processing_started_at,
      processing_lease_expires_at,
      failure_code
    )
    values (
      p_update_id,
      p_telegram_chat_id,
      p_telegram_message_id,
      p_payload,
      'received',
      now(),
      v_lease_expires_at,
      null
    )
    on conflict (update_id) do update
    set
      processing_status = 'received',
      processing_started_at = now(),
      processing_lease_expires_at = v_lease_expires_at,
      failure_code = null
    where public.telegram_updates.processing_status = 'failed'
      or (
        public.telegram_updates.processing_status = 'received'
        and coalesce(public.telegram_updates.processing_lease_expires_at, public.telegram_updates.received_at) <= now()
      )
    returning 1
  )
  select exists (select 1 from claimed_update) into v_update_claimed;

  if not v_update_claimed then
    select processing_status into v_existing_status
    from public.telegram_updates
    where update_id = p_update_id;

    claim_status := case when v_existing_status = 'processed' then 'duplicate' else 'in_progress' end;
    return next;
    return;
  end if;

  if p_telegram_chat_id is null then
    claim_status := 'claimed';
    return next;
    return;
  end if;

  if exists (
    select 1
    from public.telegram_updates
    where telegram_chat_id = p_telegram_chat_id
      and update_id < p_update_id
      and processing_status = 'received'
      and coalesce(processing_lease_expires_at, received_at) > now()
  ) then
    update public.telegram_updates
    set processing_lease_expires_at = now()
    where update_id = p_update_id;

    claim_status := 'in_progress';
    return next;
    return;
  end if;

  with claimed_chat as (
    insert into public.telegram_chat_leases (telegram_chat_id, update_id, lease_expires_at)
    values (p_telegram_chat_id, p_update_id, v_lease_expires_at)
    on conflict (telegram_chat_id) do update
    set
      update_id = excluded.update_id,
      lease_expires_at = excluded.lease_expires_at,
      acquired_at = now()
    where public.telegram_chat_leases.lease_expires_at <= now()
      or public.telegram_chat_leases.update_id = p_update_id
      or not exists (
        select 1
        from public.telegram_updates as lease_update
        where lease_update.update_id = public.telegram_chat_leases.update_id
          and lease_update.processing_status = 'received'
          and coalesce(lease_update.processing_lease_expires_at, lease_update.received_at) > now()
      )
    returning 1
  )
  select exists (select 1 from claimed_chat) into v_chat_claimed;

  if not v_chat_claimed then
    update public.telegram_updates
    set processing_lease_expires_at = now()
    where update_id = p_update_id;

    claim_status := 'in_progress';
    return next;
    return;
  end if;

  claim_status := 'claimed';
  return next;
end;
$$;
