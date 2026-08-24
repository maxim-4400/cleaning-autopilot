-- A new webhook turn can reopen a projection while an older recovery worker
-- still owns its lease. Fence that older worker so it cannot mark the newer
-- projection complete after this upsert.
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
    state = case when trello_sync_jobs.desired_lifecycle = 'booked' and excluded.desired_lifecycle = 'qualified' then trello_sync_jobs.state else 'pending' end,
    next_attempt_at = case when trello_sync_jobs.desired_lifecycle = 'booked' and excluded.desired_lifecycle = 'qualified' then trello_sync_jobs.next_attempt_at else excluded.next_attempt_at end,
    created_at = case when trello_sync_jobs.desired_lifecycle = 'booked' and excluded.desired_lifecycle = 'qualified' then trello_sync_jobs.created_at else p_now end,
    attempt_count = case when trello_sync_jobs.desired_lifecycle = 'booked' and excluded.desired_lifecycle = 'qualified' then trello_sync_jobs.attempt_count else 0 end,
    human_needed_escalated = case when trello_sync_jobs.desired_lifecycle = 'booked' and excluded.desired_lifecycle = 'qualified' then trello_sync_jobs.human_needed_escalated else false end,
    last_error_code = case when trello_sync_jobs.desired_lifecycle = 'booked' and excluded.desired_lifecycle = 'qualified' then trello_sync_jobs.last_error_code else null end,
    lease_token = case when trello_sync_jobs.desired_lifecycle = 'booked' and excluded.desired_lifecycle = 'qualified' then trello_sync_jobs.lease_token else null end,
    lease_expires_at = case when trello_sync_jobs.desired_lifecycle = 'booked' and excluded.desired_lifecycle = 'qualified' then trello_sync_jobs.lease_expires_at else null end,
    updated_at = p_now;
  return query select p_lead_id;
end;
$$;
