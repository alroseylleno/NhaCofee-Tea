-- Ảnh / PDF hoá đơn đính kèm một khoản chi phí, giống lô nhập kho
-- (inventory_receipts.receipt_path / receipt_name). File nằm trong bucket "bills",
-- thư mục expenses/; policy "shared staff can manage bills" (20260701000001) đã
-- cho mọi tài khoản đăng nhập đọc và ghi bucket này, nên không cần policy mới.
--
-- Chỉ thêm 2 cột text cho phép null, không default: Postgres chỉ sửa metadata,
-- không viết lại bảng, không đụng 168 dòng hiện có. Không view, hàm hay trigger
-- nào đọc finance_expenses (đã kiểm trên Production 30/10/2026). Chạy lại an toàn.

alter table public.finance_expenses add column if not exists receipt_path text;
alter table public.finance_expenses add column if not exists receipt_name text;

comment on column public.finance_expenses.receipt_path is 'Đường dẫn file hoá đơn trong bucket bills (expenses/<id chi phí>-<thời điểm>-<tên file>). Null = chưa đính kèm.';
comment on column public.finance_expenses.receipt_name is 'Tên file hoá đơn gốc để hiển thị.';

notify pgrst, 'reload schema';
