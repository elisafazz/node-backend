-- Node v1 base schema
-- See ~/Dropbox/claude/node/data-model.md for full design rationale.

-- ============================================================
-- 1. Schemas
-- ============================================================

create schema if not exists private;

-- ============================================================
-- 2. Public profiles
-- ============================================================

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  apple_user_id text unique,
  display_name text not null check (length(display_name) between 1 and 60),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public, auth as $$
declare
  default_name text;
  apple_id text;
begin
  -- Apple Sign-In may send name as full_name OR as separated firstName/lastName via raw_user_meta_data.
  -- Email may be relay-masked or null with "Hide My Email." Fall back gracefully.
  default_name := coalesce(
    nullif(new.raw_user_meta_data->>'full_name', ''),
    nullif(trim(coalesce(new.raw_user_meta_data->>'firstName', '') || ' ' || coalesce(new.raw_user_meta_data->>'lastName', '')), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'New user'
  );
  -- Apple's "sub" claim is the stable user identifier. Supabase exposes it as provider_id in raw_user_meta_data.
  apple_id := nullif(new.raw_user_meta_data->>'provider_id', '');
  insert into public.users(id, apple_user_id, display_name, avatar_url)
    values (new.id, apple_id, default_name, null)
    on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ============================================================
-- 3. Apple OAuth credentials (PRIVATE, service-role only)
-- ============================================================

create table private.apple_oauth_credentials (
  user_id uuid primary key references public.users(id) on delete cascade,
  refresh_token text not null,
  last_refreshed_at timestamptz,
  created_at timestamptz not null default now()
);

create table private.deletion_requests (
  user_id uuid primary key,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('pending', 'apple_revoked', 'media_scrubbed', 'completed', 'failed')),
  error text
);

-- Lock private schema down to service_role only.
-- service_role is the role used by Edge Functions calling supabase-js with the SERVICE_ROLE_KEY.
revoke all on schema private from anon, authenticated, public;
revoke all on all tables in schema private from anon, authenticated, public;
grant usage on schema private to service_role;
grant all on all tables in schema private to service_role;
alter default privileges in schema private grant all on tables to service_role;

-- ============================================================
-- 4. Nodes + memberships
-- ============================================================

create table public.nodes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 60),
  owner_id uuid not null references public.users(id) on delete restrict,
  invite_code text not null unique check (length(invite_code) = 8),
  invite_code_revoked_at timestamptz,
  member_cap int not null default 10 check (member_cap between 2 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index nodes_invite_code_active_idx on public.nodes(invite_code) where invite_code_revoked_at is null;

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.nodes(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  per_node_display_name text check (per_node_display_name is null or length(per_node_display_name) between 1 and 40),
  per_node_accent_color text check (per_node_accent_color is null or per_node_accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  per_node_emoji text check (per_node_emoji is null or length(per_node_emoji) between 1 and 8),
  device_token text,
  joined_at timestamptz not null default now(),
  unique(node_id, user_id)
);
create index memberships_user_idx on public.memberships(user_id);
create index memberships_node_idx on public.memberships(node_id);

-- ============================================================
-- 5. Feature tables (node-scoped)
-- ============================================================

create table public.stories (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.nodes(id) on delete cascade,
  author_user_id uuid not null references public.users(id) on delete cascade,
  cloudinary_public_id text not null,
  caption text check (caption is null or length(caption) <= 280),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index stories_active_idx on public.stories(node_id, created_at desc);
create index stories_author_idx on public.stories(author_user_id);

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.nodes(id) on delete cascade,
  author_user_id uuid not null references public.users(id) on delete cascade,
  cloudinary_public_id text not null,
  caption text check (caption is null or length(caption) <= 280),
  tag text check (tag is null or length(tag) <= 40),
  created_at timestamptz not null default now()
);
create index photos_node_idx on public.photos(node_id, created_at desc);
create index photos_author_idx on public.photos(author_user_id);

create table public.thoughts (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.nodes(id) on delete cascade,
  author_user_id uuid not null references public.users(id) on delete cascade,
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index thoughts_node_idx on public.thoughts(node_id, created_at desc);
create index thoughts_author_idx on public.thoughts(author_user_id);

-- ============================================================
-- 6. UGC compliance
-- ============================================================

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_user_id uuid references public.users(id) on delete set null,
  node_id uuid references public.nodes(id) on delete cascade,
  target_kind text not null check (target_kind in ('story', 'photo', 'thought', 'user', 'node')),
  target_id uuid not null,
  reason text not null check (length(reason) between 1 and 1000),
  status text not null default 'pending' check (status in ('pending', 'reviewed_no_action', 'removed', 'user_blocked')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.users(id)
);
create index reports_status_idx on public.reports(status, created_at);

create table public.blocks (
  blocker_user_id uuid not null references public.users(id) on delete cascade,
  blocked_user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  check (blocker_user_id <> blocked_user_id)
);

-- ============================================================
-- 7. Invite-code abuse audit
-- ============================================================

create table public.invite_code_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  attempted_code text not null,
  attempted_at timestamptz not null default now(),
  ip_address inet,
  success boolean not null
);
create index invite_attempts_user_window_idx on public.invite_code_attempts(user_id, attempted_at);
create index invite_attempts_ip_window_idx on public.invite_code_attempts(ip_address, attempted_at);

-- ============================================================
-- 8. updated_at triggers
-- ============================================================

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger users_touch before update on public.users for each row execute function public.touch_updated_at();
create trigger nodes_touch before update on public.nodes for each row execute function public.touch_updated_at();

-- ============================================================
-- 9. Helper: auth.uid() membership check
-- ============================================================

create or replace function public.is_member_of(target_node_id uuid)
returns boolean language sql stable security invoker as $$
  select exists(
    select 1 from public.memberships
    where node_id = target_node_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_owner_of(target_node_id uuid)
returns boolean language sql stable security invoker as $$
  select exists(
    select 1 from public.memberships
    where node_id = target_node_id and user_id = auth.uid() and role = 'owner'
  );
$$;

-- ============================================================
-- 10. RLS enable
-- ============================================================

alter table public.users enable row level security;
alter table public.nodes enable row level security;
alter table public.memberships enable row level security;
alter table public.stories enable row level security;
alter table public.photos enable row level security;
alter table public.thoughts enable row level security;
alter table public.reports enable row level security;
alter table public.blocks enable row level security;
alter table public.invite_code_attempts enable row level security;

-- ============================================================
-- 11. RLS policies
-- ============================================================

-- users: public profiles readable to all authenticated; only self updates
create policy users_read on public.users for select to authenticated using (true);
create policy users_self_update on public.users for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- nodes: members can read; only owner can update/delete; insert via security-definer create_node()
create policy nodes_member_read on public.nodes for select to authenticated using (public.is_member_of(id));
create policy nodes_owner_update on public.nodes for update to authenticated using (public.is_owner_of(id)) with check (public.is_owner_of(id));
create policy nodes_owner_delete on public.nodes for delete to authenticated using (public.is_owner_of(id));
-- no insert policy: nodes created via public.create_node()

-- memberships: members of the same node can see each other; users can update their own row; owners can delete (kick); insert via join_node_by_invite_code or create_node
create policy memberships_node_read on public.memberships for select to authenticated using (public.is_member_of(node_id));
create policy memberships_self_update on public.memberships for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy memberships_self_delete on public.memberships for delete to authenticated using (user_id = auth.uid() or public.is_owner_of(node_id));

-- stories
create policy stories_member_read on public.stories for select to authenticated using (public.is_member_of(node_id));
create policy stories_member_insert on public.stories for insert to authenticated with check (author_user_id = auth.uid() and public.is_member_of(node_id));
create policy stories_author_delete on public.stories for delete to authenticated using (author_user_id = auth.uid() or public.is_owner_of(node_id));

-- photos
create policy photos_member_read on public.photos for select to authenticated using (public.is_member_of(node_id));
create policy photos_member_insert on public.photos for insert to authenticated with check (author_user_id = auth.uid() and public.is_member_of(node_id));
create policy photos_author_update on public.photos for update to authenticated using (author_user_id = auth.uid()) with check (author_user_id = auth.uid());
create policy photos_author_delete on public.photos for delete to authenticated using (author_user_id = auth.uid() or public.is_owner_of(node_id));

-- thoughts
create policy thoughts_member_read on public.thoughts for select to authenticated using (public.is_member_of(node_id));
create policy thoughts_member_insert on public.thoughts for insert to authenticated with check (author_user_id = auth.uid() and public.is_member_of(node_id));
create policy thoughts_author_delete on public.thoughts for delete to authenticated using (author_user_id = auth.uid() or public.is_owner_of(node_id));

-- reports: anyone authenticated can insert (against any target on a node they're a member of); only reporter can read their own
create policy reports_self_read on public.reports for select to authenticated using (reporter_user_id = auth.uid());
create policy reports_member_insert on public.reports for insert to authenticated with check (
  reporter_user_id = auth.uid()
  and (node_id is null or public.is_member_of(node_id))
);

-- blocks: self-only
create policy blocks_self_read on public.blocks for select to authenticated using (blocker_user_id = auth.uid());
create policy blocks_self_insert on public.blocks for insert to authenticated with check (blocker_user_id = auth.uid());
create policy blocks_self_delete on public.blocks for delete to authenticated using (blocker_user_id = auth.uid());

-- invite_code_attempts: write-only-by-RPC (no client policy = no access). Service-role and security-definer functions can write.

-- ============================================================
-- 12. Security-definer RPCs
-- ============================================================

-- Create a node with the caller as owner. Returns the new node + invite code.
create or replace function public.create_node(node_name text)
returns table(node_id uuid, invite_code text) as $$
declare
  new_node_id uuid;
  new_code text;
  attempt int := 0;
begin
  if node_name is null or length(node_name) < 1 or length(node_name) > 60 then
    raise exception 'invalid_name';
  end if;

  -- Generate unique 8-char code (retry up to 5 times on collision)
  loop
    new_code := substr(replace(encode(gen_random_bytes(6), 'base64'), '/', '_'), 1, 8);
    new_code := replace(new_code, '+', '-');
    exit when not exists(select 1 from public.nodes where invite_code = new_code);
    attempt := attempt + 1;
    if attempt > 5 then
      raise exception 'code_generation_failed';
    end if;
  end loop;

  insert into public.nodes(name, owner_id, invite_code) values (node_name, auth.uid(), new_code) returning id into new_node_id;
  insert into public.memberships(node_id, user_id, role) values (new_node_id, auth.uid(), 'owner');

  return query select new_node_id, new_code;
end;
$$ language plpgsql security definer set search_path = public;

-- Join a node by invite code. Rate-limited per user.
create or replace function public.join_node_by_invite_code(code text)
returns table(node_id uuid, node_name text, error text) as $$
declare
  target_node public.nodes;
  attempts_recent int;
  current_count int;
begin
  if code is null or length(code) <> 8 then
    return query select null::uuid, null::text, 'invalid_code'::text;
    return;
  end if;

  -- Rate-limit: 10 attempts per user per hour
  select count(*) into attempts_recent
  from public.invite_code_attempts
  where user_id = auth.uid() and attempted_at > now() - interval '1 hour';
  if attempts_recent >= 10 then
    insert into public.invite_code_attempts(user_id, attempted_code, success) values (auth.uid(), code, false);
    return query select null::uuid, null::text, 'rate_limited'::text;
    return;
  end if;

  select * into target_node from public.nodes
    where invite_code = code and invite_code_revoked_at is null;

  if not found then
    insert into public.invite_code_attempts(user_id, attempted_code, success) values (auth.uid(), code, false);
    return query select null::uuid, null::text, 'invalid_code'::text;
    return;
  end if;

  select count(*) into current_count from public.memberships where node_id = target_node.id;
  if current_count >= target_node.member_cap then
    insert into public.invite_code_attempts(user_id, attempted_code, success) values (auth.uid(), code, false);
    return query select null::uuid, null::text, 'node_full'::text;
    return;
  end if;

  if exists (select 1 from public.memberships where node_id = target_node.id and user_id = auth.uid()) then
    insert into public.invite_code_attempts(user_id, attempted_code, success) values (auth.uid(), code, true);
    return query select target_node.id, target_node.name, 'already_member'::text;
    return;
  end if;

  insert into public.memberships(node_id, user_id, role) values (target_node.id, auth.uid(), 'member');
  insert into public.invite_code_attempts(user_id, attempted_code, success) values (auth.uid(), code, true);

  return query select target_node.id, target_node.name, null::text;
end;
$$ language plpgsql security definer set search_path = public;

-- Owner-only invite code rotation
create or replace function public.rotate_invite_code(target_node_id uuid)
returns text as $$
declare
  new_code text;
  attempt int := 0;
begin
  if not public.is_owner_of(target_node_id) then
    raise exception 'not_owner';
  end if;

  loop
    new_code := substr(replace(encode(gen_random_bytes(6), 'base64'), '/', '_'), 1, 8);
    new_code := replace(new_code, '+', '-');
    exit when not exists(select 1 from public.nodes where invite_code = new_code);
    attempt := attempt + 1;
    if attempt > 5 then raise exception 'code_generation_failed'; end if;
  end loop;

  update public.nodes set invite_code = new_code, invite_code_revoked_at = null, updated_at = now()
    where id = target_node_id;
  return new_code;
end;
$$ language plpgsql security definer set search_path = public;

-- ============================================================
-- 13. Realtime publications
-- ============================================================

alter publication supabase_realtime add table public.stories;
-- thoughts, photos, memberships intentionally NOT in realtime (egress conservation, see ADR-008)
