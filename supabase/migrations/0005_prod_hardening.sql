-- ============================================================
-- Migration 0005_prod_hardening.sql
-- Production-readiness hardening from /c-prod-ready audit (2026-05-06):
--   C3: validate cloudinary_public_id path in create_story_with_visibility
--   C9: enforce non-empty node_ids in create_meeting_with_slots
-- ============================================================

-- C3: Reject cloudinary_public_id values that don't live under the caller's user folder.
-- Without this, an attacker who learns another user's public_id (e.g. from a story they could
-- previously view) could reference that asset in a new story row across nodes they're in.
-- The cloudinary-sign Edge Function already scopes the upload folder to user/{auth.uid}/stories/,
-- so this RPC just enforces the same invariant on the database side.
create or replace function public.create_story_with_visibility(
  p_cloudinary_public_id text,
  p_caption text,
  p_node_ids uuid[],
  p_origin_node_id uuid default null,
  p_active_window_seconds int default 86400
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
  v_required_prefix text;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  if array_length(p_node_ids, 1) is null or array_length(p_node_ids, 1) = 0 then
    raise exception 'no_nodes_selected';
  end if;

  -- Path validation: cloudinary public_ids for stories must start with user/{auth.uid()}/stories/
  -- to prevent cross-user asset reuse.
  v_required_prefix := 'user/' || v_user_id::text || '/stories/';
  if p_cloudinary_public_id is null or position(v_required_prefix in p_cloudinary_public_id) <> 1 then
    raise exception 'invalid_public_id_path';
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

  -- Single set-based insert for visibility rows
  insert into public.story_visibility (story_id, node_id)
  select v_story_id, n from unnest(p_node_ids) as n;

  return query select v_story_id, v_expires_at;
end;
$$;

grant execute on function public.create_story_with_visibility(text, text, uuid[], uuid, int) to authenticated;
revoke execute on function public.create_story_with_visibility(text, text, uuid[], uuid, int) from public;


-- C9: enforce array_length(p_node_ids, 1) >= 1 so an empty array can't create a meeting
-- visible to nobody (including the organizer).
create or replace function public.create_meeting_with_slots(
  p_title text,
  p_duration_minutes int,
  p_node_ids uuid[],
  p_slot_starts timestamptz[],
  p_slot_ends timestamptz[]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meeting_id uuid;
  v_node_id uuid;
  i int;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if array_length(p_node_ids, 1) is null or array_length(p_node_ids, 1) = 0 then
    raise exception 'no_nodes_selected';
  end if;

  foreach v_node_id in array p_node_ids loop
    if not public.is_member_of(v_node_id) then
      raise exception 'not_member_of_node';
    end if;
  end loop;

  if array_length(p_slot_starts, 1) is null
    or array_length(p_slot_starts, 1) != array_length(p_slot_ends, 1) then
    raise exception 'slot_arrays_length_mismatch';
  end if;

  if array_length(p_slot_starts, 1) < 1 or array_length(p_slot_starts, 1) > 50 then
    raise exception 'slot_count_out_of_range';
  end if;

  insert into public.meetings (organizer_user_id, title, duration_minutes)
  values (auth.uid(), p_title, p_duration_minutes)
  returning id into v_meeting_id;

  foreach v_node_id in array p_node_ids loop
    insert into public.meeting_node_visibility (meeting_id, node_id)
    values (v_meeting_id, v_node_id);
  end loop;

  for i in 1..array_length(p_slot_starts, 1) loop
    insert into public.meeting_slots (meeting_id, start_at, end_at)
    values (v_meeting_id, p_slot_starts[i], p_slot_ends[i]);
  end loop;

  return v_meeting_id;
end;
$$;

grant execute on function public.create_meeting_with_slots(text, int, uuid[], timestamptz[], timestamptz[]) to authenticated;
revoke execute on function public.create_meeting_with_slots(text, int, uuid[], timestamptz[], timestamptz[]) from public;
