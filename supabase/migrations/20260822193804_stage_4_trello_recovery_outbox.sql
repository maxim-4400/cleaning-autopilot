-- Stage 4 recovery is intentionally an additive, server-only outbox. It
-- cannot create Calendar events: it only reconciles an already persisted
-- reservation with Trello and optionally sends one stable confirmation.
create table public.trello_sync_jobs (
  lead_id uuid primary key references public.leads(id) on delete restrict,
  desired_lifecycle text not null check (desired_lifecycle in ('qualified', 'booked')),
  reply_language text not null check (reply_language in ('en', 'ru', 'sr-Latn', 'sr-Cyrl')),
  confirmation_key text,
  state text not null default 'pending' check (state in ('pending', 'calendar_pending', 'confirmation_pending', 'done', 'manual')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  human_needed_escalated boolean not null default false,
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.trello_sync_jobs enable row level security;
revoke all on table public.trello_sync_jobs from anon, authenticated, service_role;
grant select, insert, update on table public.trello_sync_jobs to service_role;
revoke delete, truncate on table public.trello_sync_jobs from service_role;

create index trello_sync_jobs_due_idx
  on public.trello_sync_jobs (next_attempt_at)
  where state not in ('done', 'manual');

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
  on conflict (lead_id) do update set
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
  on conflict (lead_id) do update set
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

create or replace function public.accelerate_trello_sync_job(p_lead_id uuid, p_now timestamptz, p_reply_language text)
returns table (lead_id uuid)
language plpgsql security invoker set search_path = public
as $$
begin
  return query update public.trello_sync_jobs set next_attempt_at = p_now,
    reply_language = case when desired_lifecycle = 'booked' then reply_language else p_reply_language end,
    updated_at = p_now
  where trello_sync_jobs.lead_id = p_lead_id and state not in ('done', 'manual')
  returning trello_sync_jobs.lead_id;
end;
$$;

create or replace function public.claim_due_trello_sync_jobs(
  p_now timestamptz,
  p_limit integer,
  p_lease_token uuid,
  p_lease_seconds integer
) returns setof public.trello_sync_jobs
language plpgsql
security invoker
set search_path = public
as $$
begin
  return query
  with due as (
    select job.lead_id
    from public.trello_sync_jobs job
    where job.state not in ('done', 'manual')
      and (job.next_attempt_at <= p_now or (not job.human_needed_escalated and job.created_at <= p_now - interval '15 minutes') or job.created_at <= p_now - interval '60 minutes')
      and (job.lease_expires_at is null or job.lease_expires_at <= p_now)
    order by job.next_attempt_at, job.lead_id
    limit greatest(1, least(p_limit, 25))
    for update skip locked
  )
  update public.trello_sync_jobs job
  set lease_token = p_lease_token,
      lease_expires_at = p_now + make_interval(secs => greatest(1, least(p_lease_seconds, 300))),
      updated_at = p_now
  from due
  where job.lead_id = due.lead_id
  returning job.*;
end;
$$;

create or replace function public.complete_trello_sync_job(p_lead_id uuid, p_lease_token uuid)
returns table (lead_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
begin
  return query
  update public.trello_sync_jobs
  set state = 'done', lease_token = null, lease_expires_at = null, last_error_code = null, updated_at = now()
  where trello_sync_jobs.lead_id = p_lead_id and trello_sync_jobs.lease_token = p_lease_token
  returning trello_sync_jobs.lead_id;
end;
$$;

create or replace function public.acknowledge_trello_sync_job_escalation(p_lead_id uuid, p_lease_token uuid)
returns table (lead_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
begin
  return query
  update public.trello_sync_jobs
  set human_needed_escalated = true, lease_token = null, lease_expires_at = null, updated_at = now()
  where trello_sync_jobs.lead_id = p_lead_id and trello_sync_jobs.lease_token = p_lease_token
  returning trello_sync_jobs.lead_id;
end;
$$;

create or replace function public.reschedule_trello_sync_job(
  p_lead_id uuid,
  p_lease_token uuid,
  p_state text,
  p_next_attempt_at timestamptz,
  p_last_error_code text
) returns table (lead_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
begin
  return query
  update public.trello_sync_jobs
  set state = p_state,
      attempt_count = attempt_count + 1,
      next_attempt_at = p_next_attempt_at,
      last_error_code = p_last_error_code,
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where trello_sync_jobs.lead_id = p_lead_id
    and trello_sync_jobs.lease_token = p_lease_token
    and p_state in ('pending', 'calendar_pending', 'confirmation_pending', 'manual')
  returning trello_sync_jobs.lead_id;
end;
$$;

revoke all on function public.enqueue_trello_sync_job(uuid, text, text, text, timestamptz) from public;
revoke all on function public.persist_calendar_reservation_with_trello_job(uuid, text, timestamptz, timestamptz, text, text, text) from public;
revoke all on function public.accelerate_trello_sync_job(uuid, timestamptz, text) from public;
revoke all on function public.claim_due_trello_sync_jobs(timestamptz, integer, uuid, integer) from public;
revoke all on function public.complete_trello_sync_job(uuid, uuid) from public;
revoke all on function public.acknowledge_trello_sync_job_escalation(uuid, uuid) from public;
revoke all on function public.reschedule_trello_sync_job(uuid, uuid, text, timestamptz, text) from public;
grant execute on function public.enqueue_trello_sync_job(uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.persist_calendar_reservation_with_trello_job(uuid, text, timestamptz, timestamptz, text, text, text) to service_role;
grant execute on function public.accelerate_trello_sync_job(uuid, timestamptz, text) to service_role;
grant execute on function public.claim_due_trello_sync_jobs(timestamptz, integer, uuid, integer) to service_role;
grant execute on function public.complete_trello_sync_job(uuid, uuid) to service_role;
grant execute on function public.acknowledge_trello_sync_job_escalation(uuid, uuid) to service_role;
grant execute on function public.reschedule_trello_sync_job(uuid, uuid, text, timestamptz, text) to service_role;
