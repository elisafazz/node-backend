-- ============================================================
-- Migration 0002_crossnode.sql
-- Cross-node story visibility: stories become author-owned, with
-- a junction table controlling which nodes each story is visible in.
-- See ADR-012 for rationale.
-- ============================================================

-- 1. Junction table for story -> nodes visibility
create table public.story_visibility (
  story_id uuid not null references public.stories(id) on delete cascade,
  node_id uuid not null references public.nodes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (story_id, node_id)
);
create index story_visibility_node_idx on public.story_visibility(node_id, created_at desc);
create index story_visibility_story_idx on public.story_visibility(story_id);

-- 2. Backfill from existing single-node stories. Dev-only: no live users yet.
insert into public.story_visibility (story_id, node_id, created_at)
select id, node_id, created_at from public.stories
on conflict do nothing;

-- 3. Loosen stories.node_id: keep the column for telemetry (renamed origin_node_id),
--    drop NOT NULL, drop the now-redundant index.
alter table public.stories rename column node_id to origin_node_id;
alter table public.stories alter column origin_node_id drop not null;
drop index if exists stories_active_idx;
-- New index: by author + created_at (the Hub aggregator query pattern).
create index stories_author_created_idx on public.stories(author_user_id, created_at desc);

-- 4. Replace stories RLS policies. Visibility now flows through story_visibility.
drop policy if exists stories_member_read on public.stories;
drop policy if exists stories_member_insert on public.stories;
drop policy if exists stories_author_delete on public.stories;

create policy stories_visible_to_viewer on public.stories for select to authenticated
  using (
    exists (
      select 1 from public.story_visibility sv
      where sv.story_id = stories.id and public.is_member_of(sv.node_id)
    )
  );

create policy stories_author_insert on public.stories for insert to authenticated
  with check (author_user_id = auth.uid());

create policy stories_author_delete on public.stories for delete to authenticated
  using (author_user_id = auth.uid());

-- 5. RLS on story_visibility itself
alter table public.story_visibility enable row level security;

create policy story_visibility_member_read on public.story_visibility for select to authenticated
  using (public.is_member_of(node_id));

create policy story_visibility_author_insert on public.story_visibility for insert to authenticated
  with check (
    public.is_member_of(node_id)
    and exists (
      select 1 from public.stories s where s.id = story_id and s.author_user_id = auth.uid()
    )
  );

create policy story_visibility_author_delete on public.story_visibility for delete to authenticated
  using (
    exists (
      select 1 from public.stories s where s.id = story_id and s.author_user_id = auth.uid()
    )
  );

-- 6. SECURITY DEFINER RPC: atomically insert story + visibility rows, with
--    membership check on every requested node. Pattern from create_node.
create or replace function public.create_story_with_visibility(
  p_cloudinary_public_id text,
  p_caption text,
  p_node_ids uuid[],
  p_origin_node_id uuid default null,
  p_active_window_seconds int default 86400  -- 24h
)
returns table (story_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_story_id uuid;
  v_expires_at timestamptz;
  v_node_id uuid;
  v_unauthorized_node uuid;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  if array_length(p_node_ids, 1) is null or array_length(p_node_ids, 1) = 0 then
    raise exception 'no_nodes_selected';
  end if;

  -- Verify caller is a member of every requested node
  select n into v_unauthorized_node
  from unnest(p_node_ids) as n
  where not exists (
    select 1 from public.memberships
    where node_id = n and user_id = v_user_id
  )
  limit 1;

  if v_unauthorized_node is not null then
    raise exception 'not_member_of_node:%', v_unauthorized_node;
  end if;

  v_expires_at := now() + (p_active_window_seconds || ' seconds')::interval;

  insert into public.stories (origin_node_id, author_user_id, cloudinary_public_id, caption, expires_at)
  values (p_origin_node_id, v_user_id, p_cloudinary_public_id, p_caption, v_expires_at)
  returning id into v_story_id;

  -- Insert visibility rows
  foreach v_node_id in array p_node_ids loop
    insert into public.story_visibility (story_id, node_id)
    values (v_story_id, v_node_id);
  end loop;

  return query select v_story_id, v_expires_at;
end;
$$;

grant execute on function public.create_story_with_visibility(text, text, uuid[], uuid, int) to authenticated;
