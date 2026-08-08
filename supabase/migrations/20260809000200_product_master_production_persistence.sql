-- Production persistence for the Product workspace. This is additive and does
-- not alter the existing inventory or finance import tables.

alter table public.ingredient_master
  add column if not exists aliases jsonb not null default '[]'::jsonb,
  add column if not exists standard_waste_percent numeric not null default 0 check (standard_waste_percent >= 0),
  add column if not exists oldest_in_stock_purchased_on date,
  add column if not exists stock_quantity_base numeric not null default 0 check (stock_quantity_base >= 0),
  add column if not exists stock_lot_count integer not null default 0 check (stock_lot_count >= 0);

alter table public.product_master
  add column if not exists aliases jsonb not null default '[]'::jsonb;

create table if not exists public.product_recipe_versions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.product_master(id) on delete cascade,
  version integer not null check (version > 0),
  effective_from date not null,
  effective_to date,
  status text not null check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  unique (product_id, version),
  check (effective_to is null or effective_to >= effective_from)
);

alter table public.product_recipe_items
  add column if not exists recipe_version_id uuid references public.product_recipe_versions(id) on delete cascade;

create index if not exists product_recipe_versions_product_status_idx on public.product_recipe_versions(product_id, status, version desc);
create index if not exists product_recipe_items_recipe_version_idx on public.product_recipe_items(recipe_version_id);

create table if not exists public.product_audit_events (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  entity_type text not null check (entity_type in ('product', 'ingredient', 'recipe')),
  entity_id uuid not null,
  action text not null,
  detail text not null,
  created_at timestamptz not null default now()
);

alter table public.product_recipe_versions enable row level security;
alter table public.product_audit_events enable row level security;

drop policy if exists "authenticated staff can manage product recipe versions" on public.product_recipe_versions;
create policy "authenticated staff can manage product recipe versions" on public.product_recipe_versions for all to authenticated using (true) with check (true);
drop policy if exists "authenticated staff can manage product audit events" on public.product_audit_events;
create policy "authenticated staff can manage product audit events" on public.product_audit_events for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
