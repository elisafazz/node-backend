-- 0008_maintenance.sql
-- Retention policy for invite_code_attempts.
-- The rate-limit window is 1 hour (see join_node_by_invite_code). Rows older than
-- 30 days are beyond any audit horizon and should not accumulate indefinitely.
--
-- Requires the pg_cron extension (enabled by default on Supabase Pro; on Free,
-- enable via Dashboard > Database > Extensions > pg_cron before running this migration).

create or replace function public.purge_old_invite_attempts()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.invite_code_attempts
  where attempted_at < now() - interval '30 days';
$$;

-- Schedule daily at 03:15 UTC (low-traffic window). Job is idempotent -- re-running
-- this migration will update the schedule, not duplicate it.
select cron.schedule(
  'purge-invite-attempts',
  '15 3 * * *',
  $$select public.purge_old_invite_attempts()$$
);
