-- 0009_device_tokens.sql
-- Multi-device push token registry.
--
-- replaces the single memberships.device_token column, which could only store one token
-- per user per node (last-writer wins). This table lets one user register multiple devices
-- and still receive exactly one push per unique token via the fan-out dedup in push.ts.
--
-- memberships.device_token is left in place as a legacy / fallback column but is no
-- longer written or read by the application code as of this migration.

create table public.device_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  token       text not null,
  updated_at  timestamptz not null default now(),
  constraint device_tokens_token_unique unique (token)
);

-- users manage only their own token rows
alter table public.device_tokens enable row level security;

create policy "owner manages own tokens"
  on public.device_tokens
  for all
  to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

-- service_role bypasses RLS; no extra policy needed for fan-out reads from push.ts

create index device_tokens_user_idx on public.device_tokens (user_id);

-- grant the service role (used by Supabase Edge Functions) full access
grant usage on schema public to service_role;
grant all on public.device_tokens to service_role;
