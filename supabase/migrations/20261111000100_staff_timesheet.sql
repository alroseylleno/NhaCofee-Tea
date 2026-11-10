-- Chấm công: ca làm của nhân viên + kết sổ lương sang Tài chính.
--
-- Long, 11/11/2026: lịch tháng, bấm vào ngày để ghi ca (giờ đến, giờ về, tên
-- nhân viên, đơn giá/giờ, vi phạm). Tên, đơn giá và lý do vi phạm nhập lần đầu
-- rồi được nhớ. Nút Kết sổ đưa tiền lương sang Tài chính → Chi phí vận hành →
-- Lương nhân viên. Vi phạm chỉ trừ điểm chuyên cần, KHÔNG trừ tiền (Điều 127
-- BLLĐ 2019 cấm phạt tiền thay kỷ luật; Long chốt 11/11).
--
-- Rules held here, not only in the browser:
--   * A shift's minutes are a generated column — no client can store a number
--     that disagrees with its own check-in/check-out.
--   * Each shift keeps the hourly rate it was worked at, so a raise never
--     rewrites a past month.
--   * Kết sổ (close_staff_payroll) is one transaction per (month, điểm bán):
--     it recomputes every amount from the shifts, refuses a browser total that
--     disagrees, writes one finance_expenses row per person (source 'payroll'),
--     and locks the month's shifts. Mở lại sổ (reopen_staff_payroll) voids
--     those rows (kept for history) and unlocks the shifts.
--   * While a month is closed its shifts cannot be added, edited or deleted,
--     and a payroll expense's amount, name, date and store cannot be changed
--     or deleted from Tài chính — only its payment status, bills and note.
--     Both are enforced by triggers that only the two RPCs can pass
--     (transaction-local setting nha_ops.payroll_rpc).
--
-- The four manual "Lương nhân viên" rows already on Production (05/08 → 05/11,
-- each the previous month's pay) are left exactly as they are (Long, 11/11).

-- 1. Nhân viên -----------------------------------------------------------------

create table if not exists public.staff_members (
  id text primary key,
  name text not null check (btrim(name) <> ''),
  default_rate numeric not null default 0 check (default_rate >= 0 and default_rate = trunc(default_rate)),
  default_store_id uuid references public.stores(id),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- "Tự nhớ": typing the same name again picks the same person.
create unique index if not exists staff_members_name_key
  on public.staff_members (lower(btrim(name)));

-- 2. Lý do vi phạm -------------------------------------------------------------

create table if not exists public.staff_violation_reasons (
  id text primary key,
  label text not null check (btrim(label) <> ''),
  points numeric not null default 2 check (points >= 0 and points <= 10),
  created_at timestamptz not null default now()
);

create unique index if not exists staff_violation_reasons_label_key
  on public.staff_violation_reasons (lower(btrim(label)));

insert into public.staff_violation_reasons (id, label, points) values
  ('vi-pham-di-tre', 'Đi trễ', 2),
  ('vi-pham-ve-som', 'Về sớm', 2),
  ('vi-pham-vang-khong-bao', 'Vắng không báo', 10)
on conflict do nothing;

-- 3. Kết sổ --------------------------------------------------------------------

create table if not exists public.staff_payroll_closings (
  id text primary key,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  store_id uuid not null references public.stores(id),
  staff_id text not null references public.staff_members(id),
  shift_count integer not null check (shift_count >= 0),
  minutes integer not null check (minutes >= 0),
  base_amount numeric not null check (base_amount >= 0),
  bonus numeric not null default 0 check (bonus >= 0 and bonus = trunc(bonus)),
  amount numeric not null check (amount >= 0),
  -- NULL when the person worked no paid minute that month (absences only):
  -- finance_expenses refuses an amount of 0.
  expense_id text references public.finance_expenses(id) on delete restrict,
  incurred_on date not null,
  status text not null default 'closed' check (status in ('closed', 'reopened')),
  closed_at timestamptz not null default now(),
  reopened_at timestamptz,
  check (amount = base_amount + bonus)
);

create unique index if not exists staff_payroll_closings_open_key
  on public.staff_payroll_closings (month, store_id, staff_id)
  where status = 'closed';

create index if not exists staff_payroll_closings_month_idx
  on public.staff_payroll_closings (month, store_id);

-- 4. Ca làm --------------------------------------------------------------------

create table if not exists public.staff_shifts (
  id text primary key,
  staff_id text not null references public.staff_members(id) on delete restrict,
  store_id uuid not null references public.stores(id),
  work_date date not null,
  -- A day off recorded with its reason ("Vắng không báo"): no hours, no pay.
  absent boolean not null default false,
  check_in time,
  check_out time,
  break_minutes integer not null default 0 check (break_minutes >= 0 and break_minutes < 1440),
  -- Whole đồng, so pay rounds the same in the browser and here.
  hourly_rate numeric not null default 0 check (hourly_rate >= 0 and hourly_rate = trunc(hourly_rate)),
  -- Check-out earlier than check-in = the shift ran past midnight; it belongs
  -- to the day it started.
  minutes integer generated always as (
    case when absent then 0 else
      (extract(epoch from (check_out - check_in))::integer / 60
        + case when check_out < check_in then 1440 else 0 end)
      - break_minutes
    end
  ) stored,
  -- [{ "reasonId": "...", "label": "Đi trễ", "points": 2, "count": 1 }] —
  -- label and points are a snapshot, so editing a reason later changes no
  -- past score.
  violations jsonb not null default '[]'::jsonb check (jsonb_typeof(violations) = 'array'),
  note text,
  payroll_closing_id text references public.staff_payroll_closings(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (absent and check_in is null and check_out is null)
    or (not absent and check_in is not null and check_out is not null and check_in <> check_out)
  ),
  check (minutes >= 0)
);

create index if not exists staff_shifts_date_idx on public.staff_shifts (work_date, store_id);
create index if not exists staff_shifts_staff_idx on public.staff_shifts (staff_id, work_date);
create index if not exists staff_shifts_closing_idx on public.staff_shifts (payroll_closing_id);

-- 5. Chi phí từ Chấm công ------------------------------------------------------

alter table public.finance_expenses
  add column if not exists source text not null default 'manual' check (source in ('manual', 'payroll'));
alter table public.finance_expenses
  add column if not exists source_id text;

-- 6. Khoá ----------------------------------------------------------------------

create or replace function public.staff_payroll_rpc_active()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('nha_ops.payroll_rpc', true), '') = 'on';
$$;

create or replace function public.staff_shifts_lock_guard()
returns trigger
language plpgsql
as $$
declare
  closed_month text;
begin
  if public.staff_payroll_rpc_active() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.payroll_closing_id is not null then
    raise exception 'Ca ngày % thuộc tháng đã kết sổ. Muốn sửa: Chấm công → Mở lại sổ tháng %.',
      to_char(old.work_date, 'DD/MM/YYYY'), to_char(old.work_date, 'MM/YYYY')
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if new.payroll_closing_id is not null then
    raise exception 'Chỉ nút Kết sổ mới khoá được ca.' using errcode = 'P0001';
  end if;
  closed_month := to_char(new.work_date, 'YYYY-MM');
  if exists (
    select 1 from public.staff_payroll_closings
    where status = 'closed' and store_id = new.store_id and month = closed_month
  ) then
    raise exception 'Tháng % của điểm bán này đã kết sổ — không thêm hay sửa ca được. Muốn sửa: Chấm công → Mở lại sổ.',
      to_char(new.work_date, 'MM/YYYY')
      using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists staff_shifts_lock_guard on public.staff_shifts;
create trigger staff_shifts_lock_guard
before insert or update or delete on public.staff_shifts
for each row execute function public.staff_shifts_lock_guard();

create or replace function public.staff_payroll_closings_guard()
returns trigger
language plpgsql
as $$
begin
  if not public.staff_payroll_rpc_active() then
    raise exception 'Kết sổ lương chỉ ghi được qua nút Kết sổ / Mở lại sổ trong Chấm công.' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists staff_payroll_closings_guard on public.staff_payroll_closings;
create trigger staff_payroll_closings_guard
before insert or update or delete on public.staff_payroll_closings
for each row execute function public.staff_payroll_closings_guard();

-- Tài chính keeps working on a payroll row (mark it paid, attach the transfer
-- screenshot, write a note); what makes it a salary stays with Chấm công.
-- Finance's upsert sends every column back unchanged, so an untouched field
-- passes the IS DISTINCT FROM checks.
create or replace function public.finance_expenses_payroll_guard()
returns trigger
language plpgsql
as $$
begin
  if public.staff_payroll_rpc_active() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.source = 'payroll' then
      raise exception 'Dòng lương từ Chấm công chỉ được tạo bằng nút Kết sổ.' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.source = 'payroll' then
      raise exception 'Dòng "%" tạo từ Chấm công. Muốn bỏ: Chấm công → Mở lại sổ.', old.name using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.source = 'payroll' or new.source = 'payroll' then
    if new.source is distinct from old.source
      or new.source_id is distinct from old.source_id
      or new.name is distinct from old.name
      or new.category is distinct from old.category
      or new.subcategory is distinct from old.subcategory
      or new.amount is distinct from old.amount
      or new.incurred_on is distinct from old.incurred_on
      or new.recurrence is distinct from old.recurrence
      or new.store_id is distinct from old.store_id
      or new.vendor is distinct from old.vendor
      or new.status is distinct from old.status
    then
      raise exception 'Dòng "%" tạo từ Chấm công: số tiền, tên, ngày ghi nhận và điểm bán chỉ sửa từ Chấm công (Mở lại sổ rồi kết sổ lại). Ở Tài chính chỉ đổi được thanh toán, hoá đơn và ghi chú.', old.name
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists finance_expenses_payroll_guard on public.finance_expenses;
create trigger finance_expenses_payroll_guard
before insert or update or delete on public.finance_expenses
for each row execute function public.finance_expenses_payroll_guard();

-- 7. RPC kết sổ / mở lại sổ ----------------------------------------------------

-- p_lines: one entry per person with a shift (paid or absent) in that month at
-- that store — [{ "staff_id", "closing_id", "expense_id", "bonus", "amount",
-- "note" }]. "amount" is what the browser showed (base + bonus); the RPC
-- recomputes base from the shifts and refuses any difference, and refuses a
-- line list that misses or adds a person (another device added a shift).
create or replace function public.close_staff_payroll(p_month text, p_store_id uuid, p_incurred_on date, p_lines jsonb)
returns setof public.staff_payroll_closings
language plpgsql
security invoker
set search_path = public
as $$
declare
  month_start date;
  month_end date;
  line jsonb;
  person record;
  bonus_value numeric;
  total numeric;
  shown numeric;
  member_name text;
  expense_name text;
  line_count integer;
  db_count integer;
begin
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Tháng kết sổ không hợp lệ: %', p_month using errcode = '22023';
  end if;
  if p_store_id is null then
    raise exception 'Chọn một điểm bán để kết sổ.' using errcode = '22023';
  end if;
  month_start := to_date(p_month || '-01', 'YYYY-MM-DD');
  month_end := (month_start + interval '1 month' - interval '1 day')::date;
  if p_incurred_on is null or p_incurred_on < month_start then
    raise exception 'Ngày ghi nhận chi phí phải từ % trở đi.', to_char(month_start, 'DD/MM/YYYY') using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'Danh sách kết sổ không hợp lệ.' using errcode = '22023';
  end if;

  perform set_config('nha_ops.payroll_rpc', 'on', true);
  -- Two devices pressing Kết sổ for the same month and store run one after
  -- the other; the second then finds the month closed.
  perform pg_advisory_xact_lock(hashtext('staff_payroll:' || p_month || ':' || p_store_id::text));

  if exists (select 1 from public.staff_payroll_closings where status = 'closed' and month = p_month and store_id = p_store_id) then
    raise exception 'Tháng % của điểm bán này đã kết sổ. Tải lại trang để thấy số mới nhất.', to_char(month_start, 'MM/YYYY') using errcode = 'P0001';
  end if;

  select count(distinct staff_id) into db_count
  from public.staff_shifts
  where store_id = p_store_id and work_date between month_start and month_end;
  if db_count = 0 then
    raise exception 'Tháng % chưa có ca nào ở điểm bán này.', to_char(month_start, 'MM/YYYY') using errcode = 'P0001';
  end if;
  select count(distinct value ->> 'staff_id') into line_count from jsonb_array_elements(p_lines);
  if line_count <> jsonb_array_length(p_lines) then
    raise exception 'Danh sách kết sổ có một người hai lần.' using errcode = '22023';
  end if;
  if line_count <> db_count or exists (
    select 1 from public.staff_shifts s
    where s.store_id = p_store_id and s.work_date between month_start and month_end
      and not exists (select 1 from jsonb_array_elements(p_lines) l where l ->> 'staff_id' = s.staff_id)
  ) then
    raise exception 'Danh sách ca đã đổi ở máy khác (thêm hoặc bớt người). Tải lại trang rồi kết sổ lại.' using errcode = 'P0001';
  end if;

  for line in select value from jsonb_array_elements(p_lines) loop
    select
      count(*) filter (where not s.absent) as shift_count,
      coalesce(sum(s.minutes), 0)::integer as minutes,
      -- Σ (minutes × rate) is exact; divide once, round half up — lib/staff.ts payOf.
      round(coalesce(sum(s.minutes * s.hourly_rate), 0) / 60.0) as base_amount
    into person
    from public.staff_shifts s
    where s.store_id = p_store_id and s.work_date between month_start and month_end
      and s.staff_id = line ->> 'staff_id';
    bonus_value := coalesce(nullif(line ->> 'bonus', '')::numeric, 0);
    if bonus_value < 0 then
      raise exception 'Thưởng không được âm.' using errcode = '22023';
    end if;
    total := person.base_amount + bonus_value;
    shown := nullif(line ->> 'amount', '')::numeric;
    select name into member_name from public.staff_members where id = line ->> 'staff_id';
    if shown is distinct from total then
      raise exception 'Số tiền của % đã đổi (máy này thấy %, dữ liệu ca cho %). Tải lại trang rồi kết sổ lại.',
        member_name, coalesce(shown::text, '—'), total using errcode = 'P0001';
    end if;
    if total > 0 and coalesce(line ->> 'expense_id', '') = '' then
      raise exception 'Thiếu mã dòng chi phí cho %.', member_name using errcode = '22023';
    end if;
    expense_name := 'Lương T' || to_char(month_start, 'MM/YYYY') || ' · ' || member_name;

    if total > 0 then
      insert into public.finance_expenses (id, name, category, subcategory, amount, incurred_on, recurrence, payment_status, vendor, note, status, store_id, source, source_id, receipts)
      values (line ->> 'expense_id', expense_name, 'operating', 'Lương nhân viên', total, p_incurred_on, 'once', 'unpaid', member_name, nullif(line ->> 'note', ''), 'active', p_store_id, 'payroll', line ->> 'closing_id', '[]'::jsonb);
    end if;

    insert into public.staff_payroll_closings (id, month, store_id, staff_id, shift_count, minutes, base_amount, bonus, amount, expense_id, incurred_on)
    values (line ->> 'closing_id', p_month, p_store_id, line ->> 'staff_id', person.shift_count, person.minutes, person.base_amount, bonus_value, total,
      case when total > 0 then line ->> 'expense_id' end, p_incurred_on);

    update public.staff_shifts
    set payroll_closing_id = line ->> 'closing_id'
    where store_id = p_store_id and work_date between month_start and month_end and staff_id = line ->> 'staff_id';
  end loop;

  return query select * from public.staff_payroll_closings where status = 'closed' and month = p_month and store_id = p_store_id;
end;
$$;

create or replace function public.reopen_staff_payroll(p_month text, p_store_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  reopened integer;
begin
  perform set_config('nha_ops.payroll_rpc', 'on', true);
  perform pg_advisory_xact_lock(hashtext('staff_payroll:' || p_month || ':' || p_store_id::text));

  update public.finance_expenses
  set status = 'voided', updated_at = now()
  where id in (
    select expense_id from public.staff_payroll_closings
    where status = 'closed' and month = p_month and store_id = p_store_id and expense_id is not null
  );

  update public.staff_shifts
  set payroll_closing_id = null
  where payroll_closing_id in (
    select id from public.staff_payroll_closings
    where status = 'closed' and month = p_month and store_id = p_store_id
  );

  update public.staff_payroll_closings
  set status = 'reopened', reopened_at = now()
  where status = 'closed' and month = p_month and store_id = p_store_id;
  get diagnostics reopened = row_count;
  if reopened = 0 then
    raise exception 'Tháng này chưa kết sổ — không có gì để mở lại.' using errcode = 'P0001';
  end if;
  return reopened;
end;
$$;

-- 8. Quyền ---------------------------------------------------------------------

alter table public.staff_members enable row level security;
alter table public.staff_violation_reasons enable row level security;
alter table public.staff_shifts enable row level security;
alter table public.staff_payroll_closings enable row level security;

revoke all on table public.staff_members, public.staff_violation_reasons, public.staff_shifts, public.staff_payroll_closings from anon;
grant select, insert, update, delete on table public.staff_members, public.staff_violation_reasons, public.staff_shifts, public.staff_payroll_closings to authenticated;

drop policy if exists "authenticated staff can manage staff members" on public.staff_members;
create policy "authenticated staff can manage staff members" on public.staff_members
for all to authenticated using (true) with check (true);

drop policy if exists "authenticated staff can manage violation reasons" on public.staff_violation_reasons;
create policy "authenticated staff can manage violation reasons" on public.staff_violation_reasons
for all to authenticated using (true) with check (true);

drop policy if exists "authenticated staff can manage shifts" on public.staff_shifts;
create policy "authenticated staff can manage shifts" on public.staff_shifts
for all to authenticated using (true) with check (true);

-- Writes go through the RPCs; the guard trigger refuses any other write.
drop policy if exists "authenticated staff can manage payroll closings" on public.staff_payroll_closings;
create policy "authenticated staff can manage payroll closings" on public.staff_payroll_closings
for all to authenticated using (true) with check (true);

revoke all on function public.close_staff_payroll(text, uuid, date, jsonb) from public, anon;
revoke all on function public.reopen_staff_payroll(text, uuid) from public, anon;
grant execute on function public.close_staff_payroll(text, uuid, date, jsonb) to authenticated;
grant execute on function public.reopen_staff_payroll(text, uuid) to authenticated;
