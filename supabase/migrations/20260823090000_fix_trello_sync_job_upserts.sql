-- Keep the Stage 4 outbox additive.  Both functions return a table with a
-- `lead_id` output variable, so `ON CONFLICT (lead_id)` can resolve
-- ambiguously in PL/pgSQL.  Target the primary-key constraint directly.
create or replace function public.enqueue_trello_sync_job(
  p_lead_id uuid,
  p_desired_lifecycle text,
  p_reply_language text,
  p_confirmation_key text,
  p_now timestamptz
) returns table (lead_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.trello_sync_jobs (
    lead_id, desired_lifecycle, reply_language, confirmation_key, state, next_attempt_at, updated_at
  ) values (
    p_lead_id, p_desired_lifecycle, p_reply_language, p_confirmation_key, 'pending', p_now, p_now
  )
  on conflict on constraint trello_sync_jobs_pkey do update set
    desired_lifecycle = case when excluded.desired_lifecycle = 'booked' then 'booked' else trello_sync_jobs.desired_lifecycle end,
    reply_language = case when trello_sync_jobs.desired_lifecycle = 'booked' and excluded.desired_lifecycle = 'qualified' then trello_sync_jobs.reply_language else excluded.reply_language end,
    confirmation_key = coalesce(excluded.confirmation_key, trello_sync_jobs.confirmation_key),
    state = 'pending',
    next_attempt_at = excluded.next_attempt_at,
    updated_at = p_now;
  return query select p_lead_id;
end;
$$;

create or replace function public.persist_calendar_reservation_with_trello_job(
  p_lead_id uuid, p_assigned_team text, p_booked_start timestamptz, p_booked_end timestamptz,
  p_calendar_event_id text, p_reply_language text, p_confirmation_key text
) returns table (lead_id uuid)
language plpgsql security invoker set search_path = public
as $$
begin
  update public.leads set assigned_team = p_assigned_team, booked_start = p_booked_start, booked_end = p_booked_end,
    calendar_event_id = p_calendar_event_id where id = p_lead_id;
  if not found then return; end if;
  insert into public.trello_sync_jobs (lead_id, desired_lifecycle, reply_language, confirmation_key, state, next_attempt_at)
  values (p_lead_id, 'booked', p_reply_language, p_confirmation_key, 'pending', now() + interval '2 minutes')
  on conflict on constraint trello_sync_jobs_pkey do update set
    desired_lifecycle = 'booked',
    reply_language = case when trello_sync_jobs.desired_lifecycle = 'booked' then trello_sync_jobs.reply_language else excluded.reply_language end,
    confirmation_key = coalesce(trello_sync_jobs.confirmation_key, excluded.confirmation_key),
    state = case when trello_sync_jobs.desired_lifecycle = 'qualified' then 'pending' else trello_sync_jobs.state end,
    next_attempt_at = case when trello_sync_jobs.desired_lifecycle = 'qualified' then now() + interval '2 minutes' else trello_sync_jobs.next_attempt_at end,
    created_at = case when trello_sync_jobs.desired_lifecycle = 'qualified' then now() else trello_sync_jobs.created_at end,
    attempt_count = case when trello_sync_jobs.desired_lifecycle = 'qualified' then 0 else trello_sync_jobs.attempt_count end,
    human_needed_escalated = case when trello_sync_jobs.desired_lifecycle = 'qualified' then false else trello_sync_jobs.human_needed_escalated end,
    last_error_code = case when trello_sync_jobs.desired_lifecycle = 'qualified' then null else trello_sync_jobs.last_error_code end,
    lease_token = case when trello_sync_jobs.desired_lifecycle = 'qualified' then null else trello_sync_jobs.lease_token end,
    lease_expires_at = case when trello_sync_jobs.desired_lifecycle = 'qualified' then null else trello_sync_jobs.lease_expires_at end;
  return query select p_lead_id;
end;
$$;
