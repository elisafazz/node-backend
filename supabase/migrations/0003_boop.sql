-- ============================================================
-- Migration 0003_boop.sql
-- Boop: cross-node broadcast ping. Author-owned, fan-out via
-- boop_visibility junction table (mirrors story_visibility pattern).
-- See ADR-013.
-- ============================================================

-- 1. Boops table (author-owned, optional short message)
create table public.boops (
  id uuid primary key default gen_random_uuid(),
  sender_user_id uuid not null references public.users(id) on delete cascade,
  message text check (message is null or length(message) <= 100),
  created_at timestamptz not null default now()
);

-- 2. Junction table: which nodes each boop is sent to
create table public.boop_visibility (
  boop_id uuid not null references public.boops(id) on delete cascade,
  node_id uuid not null references public.nodes(id) on delete cascade,
  primary key (boop_id, node_id)
);
create index boop_visibility_node_idx on public.boop_visibility(node_id, created_at desc)
  include (boop_id);
create index boop_visibility_boop_idx on public.boop_visibility(boop_id);

-- 3. RLS on boops
alter table public.boops enable row level security;

-- A viewer can see a boop if they belong to at least one node it was sent to.
create policy boops_visible_to_member on public.boops for select to authenticated
  using (
    exists (
      select 1 from public.boop_visibility bv
      where bv.boop_id = boops.id and public.is_member_of(bv.node_id)
    )
  );

create policy boops_sender_insert on public.boops for insert to authenticated
  with check (sender_user_id = auth.uid());

create policy boops_sender_delete on public.boops for delete to authenticated
  using (sender_user_id = auth.uid());

-- 4. RLS on boop_visibility
alter table public.boop_visibility enable row level security;

create policy boop_visibility_member_read on public.boop_visibility for select to authenticated
  using (public.is_member_of(node_id));

create policy boop_visibility_sender_insert on public.boop_visibility for insert to authenticated
  with check (
    public.is_member_of(node_id)
    and exists (
      select 1 from public.boops b where b.id = boop_id and b.sender_user_id = auth.uid()
    )
  );

create policy boop_visibility_sender_delete on public.boop_visibility for delete to authenticated
  using (
    exists (
      select 1 from public.boops b where b.id = boop_id and b.sender_user_id = auth.uid()
    )
  );

-- 5. SECURITY DEFINER RPC: atomically insert boop + visibility rows.
--    Validates the caller is a member of every requested node.
create or replace function public.send_boop(
  p_message text,
  p_node_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_boop_id uuid;
  v_node_id uuid;
  v_unauthorized_node uuid;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  if array_length(p_node_ids, 1) is null or array_length(p_node_ids, 1) = 0 then
    raise exception 'no_nodes_selected';
  end if;

  if p_message is not null and length(p_message) > 100 then
    raise exception 'message_too_long';
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

  insert into public.boops (sender_user_id, message)
  values (v_user_id, p_message)
  returning id into v_boop_id;

  foreach v_node_id in array p_node_ids loop
    insert into public.boop_visibility (boop_id, node_id)
    values (v_boop_id, v_node_id);
  end loop;

  return v_boop_id;
end;
$$;

grant execute on function public.send_boop(text, uuid[]) to authenticated;
