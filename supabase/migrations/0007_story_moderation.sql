-- Migration 0007_story_moderation.sql
-- Adds delete_story_visibility(story_id, node_id) so a node owner can remove
-- a story from their node's feed without deleting the story globally
-- (which only the story author can do).

create or replace function public.delete_story_visibility(
  p_story_id uuid,
  p_node_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  -- Only the node owner may remove a story from their node.
  if not public.is_owner_of(p_node_id) then
    raise exception 'not_node_owner';
  end if;

  delete from public.story_visibility
  where story_id = p_story_id
    and node_id = p_node_id;
end;
$$;

grant execute on function public.delete_story_visibility(uuid, uuid) to authenticated;
revoke execute on function public.delete_story_visibility(uuid, uuid) from public;
