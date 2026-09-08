-- Supabase's API connections run with safeupdate, which rejects DELETE without
-- a WHERE clause even inside a security-definer function. The original
-- replace_finance_counter_prices used a bare `delete from`, so every Production
-- price-book import failed with `21000: DELETE requires a WHERE clause`.
-- Same function, same semantics — the full-table delete just states its WHERE.

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

  insert into public.finance_counter_prices (name, store_price, grab_price, shopee_price, green_price)
  select row_data.name, row_data.store_price, row_data.grab_price, row_data.shopee_price, row_data.green_price
  from jsonb_to_recordset(p_rows) as row_data(
    name text,
    store_price numeric,
    grab_price numeric,
    shopee_price numeric,
    green_price numeric
  );
end;
$$;

revoke all on function public.replace_finance_counter_prices(jsonb) from anon;
grant execute on function public.replace_finance_counter_prices(jsonb) to authenticated;

notify pgrst, 'reload schema';
