-- CFO master-data foundation. This migration only adds new tables and leaves
-- the current inventory and finance snapshots untouched.

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.stores (id, code, name, status, is_default)
values ('31070000-0000-4000-8000-000000000001', 'NHA-31-7', 'Nhà Coffee & Tea – 31:7', 'active', true)
on conflict (code) do update set name = excluded.name, status = excluded.status;

create table if not exists public.ingredient_master (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  code text not null,
  name text not null,
  category text not null default 'Chưa phân loại',
  brand text not null default 'Chưa ghi thương hiệu',
  base_unit text not null,
  purchase_unit text not null,
  latest_purchase_price numeric not null default 0 check (latest_purchase_price >= 0),
  latest_purchase_price_per_base_unit numeric not null default 0 check (latest_purchase_price_per_base_unit >= 0),
  latest_purchased_on date,
  source_inventory_receipt_id uuid references public.inventory_receipts(id) on delete set null,
  source_key text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, code),
  unique (store_id, source_key)
);

create table if not exists public.product_master (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  sku text not null,
  name text not null,
  category text not null default 'Chưa phân loại',
  selling_price numeric not null default 0 check (selling_price >= 0),
  packaging_cost numeric not null default 0 check (packaging_cost >= 0),
  source text not null default 'manual' check (source in ('import', 'manual')),
  status text not null default 'draft' check (status in ('draft', 'active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, sku)
);

create table if not exists public.product_recipe_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.product_master(id) on delete cascade,
  ingredient_id uuid not null references public.ingredient_master(id),
  quantity numeric not null check (quantity > 0),
  unit text not null,
  waste_percent numeric not null default 0 check (waste_percent >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.finance_import_batches (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  data_type text not null check (data_type in ('revenue', 'products', 'service')),
  file_name text not null,
  period_start date not null,
  period_end date not null,
  row_count integer not null check (row_count >= 0),
  status text not null default 'completed' check (status in ('completed', 'failed')),
  error_message text,
  imported_at timestamptz not null default now(),
  imported_by uuid,
  check (period_end >= period_start)
);

-- Versioned fact tables support period-scoped replacement while preserving
-- historical imports. Existing snapshot tables remain available during rollout.
create table if not exists public.finance_revenue_facts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  import_batch_id uuid not null references public.finance_import_batches(id) on delete cascade,
  report_date date not null,
  payload jsonb not null,
  unique (import_batch_id, report_date)
);

create table if not exists public.finance_product_facts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  import_batch_id uuid not null references public.finance_import_batches(id) on delete cascade,
  source_row integer not null,
  sku text not null,
  payload jsonb not null,
  unique (import_batch_id, source_row)
);

create table if not exists public.finance_service_facts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  import_batch_id uuid not null references public.finance_import_batches(id) on delete cascade,
  source_row integer not null,
  service_name text not null,
  payload jsonb not null,
  unique (import_batch_id, source_row)
);

alter table public.stores enable row level security;
alter table public.ingredient_master enable row level security;
alter table public.product_master enable row level security;
alter table public.product_recipe_items enable row level security;
alter table public.finance_import_batches enable row level security;
alter table public.finance_revenue_facts enable row level security;
alter table public.finance_product_facts enable row level security;
alter table public.finance_service_facts enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'stores', 'ingredient_master', 'product_master', 'product_recipe_items',
    'finance_import_batches', 'finance_revenue_facts',
    'finance_product_facts', 'finance_service_facts'
  ] loop
    execute format('drop policy if exists "authenticated staff can manage %1$s" on public.%I', table_name, table_name);
    execute format(
      'create policy "authenticated staff can manage %1$s" on public.%I for all to authenticated using (true) with check (true)',
      table_name,
      table_name
    );
  end loop;
end $$;

create index if not exists ingredient_master_store_status_idx on public.ingredient_master(store_id, status);
create index if not exists product_master_store_status_idx on public.product_master(store_id, status);
create index if not exists product_recipe_items_product_idx on public.product_recipe_items(product_id);
create index if not exists finance_import_batches_scope_idx on public.finance_import_batches(store_id, data_type, period_start, period_end, imported_at desc);

notify pgrst, 'reload schema';
