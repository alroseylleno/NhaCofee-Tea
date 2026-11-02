-- Nhiều ảnh / PDF hoá đơn cho một khoản chi phí. 20261030000200 chỉ chứa 1 file
-- (receipt_path / receipt_name); từ đây danh sách đầy đủ nằm ở cột receipts:
--   [{"name": "<tên file gốc>", "path": "expenses/<id chi phí>-<thời điểm>-<thứ tự>-<tên file>"}, …]
-- theo thứ tự người dùng thêm. File vẫn ở bucket "bills", policy cũ đủ dùng.
--
-- receipt_path / receipt_name được GIỮ: app ghi file ĐẦU TIÊN vào đó, để bản app
-- chưa deploy xong vẫn thấy một hoá đơn, và để app đọc được hàng cũ.
--
-- Backfill: 86 chi phí đang có 1 hoá đơn (đếm trên Production 02/11/2026) được
-- chép sang receipts. Cột thêm với default hằng nên Postgres không viết lại bảng.
-- Không view, hàm hay trigger nào đọc finance_expenses (đã kiểm trên Production
-- 02/11/2026). Chạy lại an toàn.

alter table public.finance_expenses add column if not exists receipts jsonb not null default '[]'::jsonb;

update public.finance_expenses
set receipts = jsonb_build_array(jsonb_build_object('name', coalesce(receipt_name, 'Hóa đơn'), 'path', receipt_path))
where receipt_path is not null and receipts = '[]'::jsonb;

alter table public.finance_expenses drop constraint if exists finance_expenses_receipts_is_array;
alter table public.finance_expenses add constraint finance_expenses_receipts_is_array check (jsonb_typeof(receipts) = 'array');

comment on column public.finance_expenses.receipts is 'Danh sách hoá đơn đính kèm [{name, path}] trong bucket bills, theo thứ tự thêm. [] = chưa đính kèm.';
comment on column public.finance_expenses.receipt_path is 'Bản sao path của hoá đơn ĐẦU TIÊN trong receipts, cho app trước 20261102000100. Null = chưa đính kèm.';

notify pgrst, 'reload schema';
