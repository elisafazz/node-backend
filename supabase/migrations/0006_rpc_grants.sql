-- Migration 0006_rpc_grants.sql
-- Explicit GRANT/REVOKE on the three original RPCs from 0001_init.sql.
-- 0005 added these for create_story_with_visibility and create_meeting_with_slots;
-- the 0001 RPCs were missing them, leaving their access governed by the default
-- inherited from the schema rather than explicitly stated.

grant execute on function public.create_node(text) to authenticated;
revoke execute on function public.create_node(text) from public;

grant execute on function public.join_node_by_invite_code(text) to authenticated;
revoke execute on function public.join_node_by_invite_code(text) from public;

grant execute on function public.rotate_invite_code(uuid) to authenticated;
revoke execute on function public.rotate_invite_code(uuid) from public;
