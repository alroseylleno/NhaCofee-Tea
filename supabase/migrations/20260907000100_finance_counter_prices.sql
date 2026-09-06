-- The price book from SAPO's "Danh mục mặt hàng" export: one row per menu item
-- with the in-store price and each sàn's list price. This is what turns "giá
-- quầy" in the reconciliation detail from an estimate into a lookup, so it must
-- live in Supabase for Production instead of only in browser storage.

create table if not exists public.finance_counter_prices (
  -- Accent-insensitive lookups happen in the app; the row key is the exact
  -- item name as SAPO exports it.
  name text primary key,
  store_price numeric not null check (store_price > 0),
  grab_price numeric check (grab_price is null or grab_price > 0),
  shopee_price numeric check (shopee_price is null or shopee_price > 0),
  green_price numeric check (green_price is null or green_price > 0),
  imported_at timestamptz not null default now()
);

alter table public.finance_counter_prices enable row level security;
revoke all on table public.finance_counter_prices from anon;
grant select, insert, update, delete on table public.finance_counter_prices to authenticated;

drop policy if exists "authenticated staff can manage counter prices" on public.finance_counter_prices;
create policy "authenticated staff can manage counter prices"
on public.finance_counter_prices for all to authenticated
using (true)
with check (true);

-- A price-book import is a full snapshot, so replacing wholesale keeps deleted
-- menu items from lingering with stale prices.
create or replace function public.replace_finance_counter_prices(p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Counter price import must contain at least one row';
  end if;

  delete from public.finance_counter_prices;

  insert into public.finance_counter_prices (name, store_price, grab_price, shopee_price, green_price)
  select row_data.name, row_data.store_price, row_data.grab_price, row_data.shopee_price, row_data.green_price
  from jsonb_to_recordset(p_rows) as row_data(
    name text,
    store_price numeric,
    grab_price numeric,
    shopee_price numeric,
    green_price numeric
  )
  where row_data.name is not null and row_data.store_price > 0;
end;
$$;

revoke all on function public.replace_finance_counter_prices(jsonb) from anon;
grant execute on function public.replace_finance_counter_prices(jsonb) to authenticated;

notify pgrst, 'reload schema';
