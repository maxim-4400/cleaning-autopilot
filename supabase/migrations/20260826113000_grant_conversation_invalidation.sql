-- Terminal availability responses deliberately reset the disposable OpenAI
-- Conversation before the next customer turn. The server-side repository
-- performs that reset through PostgREST as service_role, so it needs this one
-- table-scoped destructive privilege in addition to the existing read/write
-- grant from the Stage 2 schema.
grant delete on table public.conversations to service_role;
