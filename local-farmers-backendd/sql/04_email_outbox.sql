-- =====================================================================
-- OPS-02 — THE EMAIL OUTBOX
--
-- Solves: "no notifications at all". Realtime only works while a tab is open,
-- so a farmer could miss an order for days. For perishable goods that is
-- fatal, and it is the only reason a farmer would prefer a free Facebook
-- group over paying us 10%.
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR.
-- Idempotent. NON-DESTRUCTIVE.
--
-- Can be run before or after the backend deploy: until the table exists,
-- enqueueing logs a warning and the request it belongs to still succeeds.
-- =====================================================================


-- =====================================================================
-- PART 1/3 — `email_outbox`
--
-- Why a table and not just "call Resend":
--
--   * Sending inside the request makes the customer wait on a third party we
--     do not control, and makes a Resend outage look like a checkout outage.
--   * Sending inside a transaction is worse: the email goes out and then the
--     transaction rolls back, so we have told someone about an order that
--     does not exist.
--   * Without a record, a failed send is simply lost. Nobody finds out that
--     the farmer never heard about the order until the customer complains.
--
-- `event_key` is the idempotency claim, the same trick as `stripe_events` and
-- `order_transfers`: the caller derives a stable key from the thing that
-- happened ("order-paid:<order id>"), the unique index refuses the second
-- insert, and a webhook redelivery cannot email the same person twice.
-- =====================================================================

create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),

  -- Stable, caller-derived. Two attempts to announce the same fact collapse
  -- into one row.
  event_key text not null unique,
  -- Which template rendered it. Kept so a template bug can be found by
  -- querying rather than by reading logs.
  template text not null,

  recipient text not null,
  -- Denormalised so a deleted account (GDPR Art. 17) does not orphan the
  -- queue, and so we can see who a message was for without a join.
  recipient_user_id text not null default '',
  subject text not null,
  body_text text not null,
  body_html text not null default '',

  -- Free-form context the template rendered from, kept for debugging and for
  -- re-rendering if a template is fixed before the message goes out.
  payload jsonb not null default '{}'::jsonb,

  state text not null default 'pending'
    check (state in ('pending', 'sending', 'sent', 'failed', 'cancelled')),

  attempts integer not null default 0 check (attempts >= 0),
  -- Five attempts over roughly a day and a half of backoff. After that a
  -- human has to look: either the address is wrong or the provider is down
  -- for longer than any retry policy can paper over.
  max_attempts integer not null default 5 check (max_attempts > 0),
  -- Nothing is picked up before this. Backoff is written here, not slept on.
  next_attempt_at timestamptz not null default timezone('utc', now()),
  last_error text,

  sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- The worker's only query: what is due, oldest first.
create index if not exists email_outbox_due_idx
  on public.email_outbox (next_attempt_at)
  where state = 'pending';

create index if not exists email_outbox_state_idx
  on public.email_outbox (state, created_at desc);
create index if not exists email_outbox_recipient_idx
  on public.email_outbox (recipient_user_id, created_at desc);

alter table public.email_outbox enable row level security;
-- RLS on with no policies: service role only.
drop policy if exists email_outbox_no_public_access on public.email_outbox;

create or replace function public.set_email_outbox_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_email_outbox_updated_at on public.email_outbox;
create trigger trg_email_outbox_updated_at
before update on public.email_outbox
for each row
execute function public.set_email_outbox_updated_at();


-- =====================================================================
-- PART 2/3 — `claim_due_emails`
--
-- Hands the worker a batch and marks it `sending` in the same statement.
-- `for update skip locked` is what makes two workers safe: the second one
-- steps over the rows the first is holding instead of waiting for them, so a
-- second process (or a redeploy that overlaps) cannot send the same message
-- twice.
-- =====================================================================

create or replace function public.claim_due_emails(p_limit integer default 20)
returns setof public.email_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.email_outbox o
  set
    state = 'sending',
    attempts = o.attempts + 1
  where o.id in (
    select c.id
    from public.email_outbox c
    where c.state = 'pending'
      and c.next_attempt_at <= timezone('utc', now())
    order by c.next_attempt_at
    limit greatest(1, coalesce(p_limit, 20))
    for update skip locked
  )
  returning o.*;
end;
$$;


-- =====================================================================
-- PART 3/3 — Verification
-- =====================================================================

-- select column_name, data_type from information_schema.columns
--   where table_name = 'email_outbox' order by ordinal_position;
--
-- select proname from pg_proc where proname = 'claim_due_emails';
--
-- -- What is stuck and why:
-- select template, recipient, attempts, last_error, next_attempt_at
--   from public.email_outbox where state = 'failed' order by updated_at desc;
--
-- -- Queue health at a glance:
-- select state, count(*) from public.email_outbox group by state;
