-- Permanent receipt codes: DDMMYY plus an incrementing daily sequence.

alter table public.inventory_receipts
  add column if not exists receipt_code text;

create table if not exists public.inventory_receipt_daily_sequences (
  purchased_on date primary key,
  last_number integer not null check (last_number > 0)
);

with numbered_receipts as (
  select id, purchased_on,
    row_number() over (partition by purchased_on order by created_at, id) as sequence_number
  from public.inventory_receipts
  where receipt_code is null
)
update public.inventory_receipts as receipt
set receipt_code = to_char(numbered_receipts.purchased_on, 'DDMMYY') || '-' || lpad(numbered_receipts.sequence_number::text, 3, '0')
from numbered_receipts
where receipt.id = numbered_receipts.id;

insert into public.inventory_receipt_daily_sequences (purchased_on, last_number)
select purchased_on, count(*)::integer
from public.inventory_receipts
group by purchased_on
on conflict (purchased_on) do update
set last_number = greatest(
  public.inventory_receipt_daily_sequences.last_number,
  excluded.last_number
);

alter table public.inventory_receipts
  alter column receipt_code set not null;

create unique index if not exists inventory_receipts_receipt_code_key
  on public.inventory_receipts(receipt_code);

create or replace function public.assign_inventory_receipt_code()
returns trigger
language plpgsql
as $$
declare
  next_number integer;
begin
  if new.receipt_code is not null then
    return new;
  end if;

  insert into public.inventory_receipt_daily_sequences (purchased_on, last_number)
  values (new.purchased_on, 1)
  on conflict (purchased_on) do update
  set last_number = public.inventory_receipt_daily_sequences.last_number + 1
  returning last_number into next_number;

  new.receipt_code := to_char(new.purchased_on, 'DDMMYY') || '-' || lpad(next_number::text, 3, '0');
  return new;
end;
$$;

drop trigger if exists assign_inventory_receipt_code on public.inventory_receipts;
create trigger assign_inventory_receipt_code
before insert on public.inventory_receipts
for each row execute function public.assign_inventory_receipt_code();
