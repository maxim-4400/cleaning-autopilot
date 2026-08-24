alter table public.leads add column trello_card_url text;

alter table public.leads add constraint leads_trello_card_url_canonical_check
  check (trello_card_url is null or trello_card_url ~ '^https://trello\.com/c/[A-Za-z0-9_-]{1,64}$');

create unique index leads_trello_card_url_nonempty_unique_idx
  on public.leads ((nullif(btrim(trello_card_url), '')))
  where nullif(btrim(trello_card_url), '') is not null;
