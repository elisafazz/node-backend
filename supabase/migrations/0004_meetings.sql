-- Migration 0004: Schedule Meeting
-- meetings, meeting_node_visibility, meeting_slots, meeting_responses
-- RPCs: create_meeting_with_slots, confirm_meeting_slot

-- ============================================================
-- Tables
-- ============================================================

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  organizer_user_id uuid not null references public.users(id) on delete cascade,
  title text not null check (length(title) between 1 and 100),
  duration_minutes int not null check (duration_minutes between 15 and 480),
  status text not null default 'polling' check (status in ('polling', 'confirmed', 'cancelled')),
  confirmed_slot_id uuid, -- set when organizer confirms; FK added after meeting_slots exists
  created_at timestamptz not null default now()
);

-- which nodes' members can see this meeting poll
create table public.meeting_node_visibility (
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  node_id uuid not null references public.nodes(id) on delete cascade,
  primary key (meeting_id, node_id)
);

-- time blocks proposed by the organizer
create table public.meeting_slots (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  check (end_at > start_at)
);

-- close the forward reference
alter table public.meetings
  add constraint meetings_confirmed_slot_fk
  foreign key (confirmed_slot_id) references public.meeting_slots(id) on delete set null;

-- per-user availability responses
create table public.meeting_responses (
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  slot_id uuid not null references public.meeting_slots(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  available boolean not null,
  responded_at timestamptz not null default now(),
  primary key (meeting_id, slot_id, user_id)
);

-- ============================================================
-- Indexes
-- ============================================================

create index meeting_node_visibility_node_idx on public.meeting_node_visibility(node_id);
create index meeting_slots_meeting_idx on public.meeting_slots(meeting_id, start_at);
create index meeting_responses_slot_idx on public.meeting_responses(slot_id);
create index meeting_responses_user_idx on public.meeting_responses(meeting_id, user_id);

-- ============================================================
-- RLS
-- ============================================================

alter table public.meetings enable row level security;
alter table public.meeting_node_visibility enable row level security;
alter table public.meeting_slots enable row level security;
alter table public.meeting_responses enable row level security;

-- meetings: visible if you're a member of at least one visibility node
create policy meetings_member_read on public.meetings for select to authenticated
  using (
    exists (
      select 1 from public.meeting_node_visibility mnv
      where mnv.meeting_id = id and public.is_member_of(mnv.node_id)
    )
  );

create policy meetings_organizer_update on public.meetings for update to authenticated
  using (organizer_user_id = auth.uid())
  with check (organizer_user_id = auth.uid());

create policy meeting_visibility_member_read on public.meeting_node_visibility for select to authenticated
  using (public.is_member_of(node_id));

create policy meeting_slots_member_read on public.meeting_slots for select to authenticated
  using (
    exists (
      select 1 from public.meeting_node_visibility mnv
      where mnv.meeting_id = meeting_id and public.is_member_of(mnv.node_id)
    )
  );

create policy meeting_responses_member_read on public.meeting_responses for select to authenticated
  using (
    exists (
      select 1 from public.meeting_node_visibility mnv
      where mnv.meeting_id = meeting_id and public.is_member_of(mnv.node_id)
    )
  );

create policy meeting_responses_self_insert on public.meeting_responses for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.meeting_node_visibility mnv
      where mnv.meeting_id = meeting_id and public.is_member_of(mnv.node_id)
    )
  );

create policy meeting_responses_self_update on public.meeting_responses for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy meeting_responses_self_delete on public.meeting_responses for delete to authenticated
  using (user_id = auth.uid());

-- ============================================================
-- RPCs
-- ============================================================

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

create or replace function public.confirm_meeting_slot(
  p_meeting_id uuid,
  p_slot_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.meetings m
    where m.id = p_meeting_id and m.organizer_user_id = auth.uid()
  ) then
    raise exception 'not_organizer';
  end if;

  if not exists (
    select 1 from public.meeting_slots s
    where s.id = p_slot_id and s.meeting_id = p_meeting_id
  ) then
    raise exception 'slot_not_in_meeting';
  end if;

  update public.meetings
  set status = 'confirmed', confirmed_slot_id = p_slot_id
  where id = p_meeting_id;
end;
$$;
