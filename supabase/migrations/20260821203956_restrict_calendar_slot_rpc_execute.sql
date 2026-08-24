revoke all on function public.consume_calendar_slot_token(uuid, uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.replace_calendar_slot_offer(uuid, uuid, timestamptz, jsonb)
  from public, anon, authenticated;

grant execute on function public.consume_calendar_slot_token(uuid, uuid, timestamptz)
  to service_role;
grant execute on function public.replace_calendar_slot_offer(uuid, uuid, timestamptz, jsonb)
  to service_role;
