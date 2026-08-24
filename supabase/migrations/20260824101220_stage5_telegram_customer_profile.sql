-- Stage 5: optional operational Telegram profile metadata.
-- Additive only: existing leads and the active-order RPC stay valid.
alter table public.leads
  add column if not exists telegram_user_id bigint,
  add column if not exists customer_display_name text,
  add column if not exists telegram_username text;

alter table public.leads
  add constraint leads_customer_display_name_length_check
    check (customer_display_name is null or char_length(btrim(customer_display_name)) between 1 and 120) not valid,
  add constraint leads_telegram_username_format_check
    check (telegram_username is null or telegram_username ~ '^[A-Za-z0-9_]{5,32}$') not valid;

alter table public.leads validate constraint leads_customer_display_name_length_check;
alter table public.leads validate constraint leads_telegram_username_format_check;
