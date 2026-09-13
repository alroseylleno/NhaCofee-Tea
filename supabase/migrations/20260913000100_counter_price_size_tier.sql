-- The price book lost every size-L row.
--
-- SAPO merges the item-name cell across an item's price tiers, so each row after
-- the first exports with a BLANK name. `parseCounterPriceRows` skipped nameless
-- rows, so only an item's first tier survived: the 66-row export landed as 48
-- rows, and đối soát valued every multi-size item at its smallest tier
-- (`Latte cà phê` at the S price of 28.000 instead of 36.000 for an L).
--
-- The parser now carries the name down and keeps `Tên giá` as the tier, so the
-- table needs a `size` column and a key that admits one row per tier. Invoice
-- line items still carry no size, so đối soát keeps resolving a bare name to the
-- untiered row first and then S, M, L — the same number it produced before, now
-- as a deliberate choice rather than a side effect of which row was dropped.

alter table public.finance_counter_prices
  add column if not exists size text not null default '';

alter table public.finance_counter_prices
  drop constraint if exists finance_counter_prices_pkey,
  add constraint finance_counter_prices_pkey primary key (name, size);

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

  delete from public.finance_counter_prices where name is not null;

  insert into public.finance_counter_prices (name, size, store_price, grab_price, shopee_price, green_price)
  select row_data.name, coalesce(row_data.size, ''), row_data.store_price,
         row_data.grab_price, row_data.shopee_price, row_data.green_price
  from jsonb_to_recordset(p_rows) as row_data(
    name text,
    size text,
    store_price numeric,
    grab_price numeric,
    shopee_price numeric,
    green_price numeric
  );
end;
$$;

revoke all on function public.replace_finance_counter_prices(jsonb) from public;
grant execute on function public.replace_finance_counter_prices(jsonb) to authenticated;

notify pgrst, 'reload schema';
