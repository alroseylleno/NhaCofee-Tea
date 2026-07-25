-- Foundation for moving Nhà Ops from browser-only storage to shared cloud data.
create table if not exists public.inventory_receipts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'Chưa phân loại',
  brand text not null default 'Chưa ghi thương hiệu',
  total_quantity numeric not null check (total_quantity > 0),
  unit text not null,
  specification text not null default 'Chưa ghi định lượng',
  unit_cost numeric not null check (unit_cost >= 0),
  purchased_on date not null,
  supplier text not null default 'Chưa ghi nhà cung cấp',
  receipt_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_history (
  id uuid primary key default gen_random_uuid(),
  inventory_receipt_id uuid not null references public.inventory_receipts(id) on delete cascade,
  action text not null check (action in ('created', 'updated')),
  changes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.inventory_receipts enable row level security;
alter table public.inventory_history enable row level security;

-- Activate these policies only after Supabase Auth is connected.
-- create policy "authenticated staff can manage inventory" on public.inventory_receipts for all to authenticated using (true) with check (true);
-- create policy "authenticated staff can read inventory history" on public.inventory_history for select to authenticated using (true);
