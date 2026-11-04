-- Hoá đơn theo kỳ cho chi phí định kỳ. Long, 04/11/2026: "Mỗi tháng (mỗi dòng)
-- là cho phép up hoá đơn riêng biệt, không phải up 1 lần là apply hết cho toàn bộ
-- tháng / dòng ở trong chi phí cố định."
--
-- Không đổi cấu trúc bảng. Mỗi phần tử của finance_expenses.receipts (20261102000100)
-- có thể mang thêm khoá "period": "YYYY-MM" cho khoản tháng / quý / năm, "YYYY-MM-DD"
-- cho khoản tuần (lib/finance-store.ts, expensePeriodOf). App chỉ hiện hoá đơn ở dòng
-- của kỳ đó. Phần tử không có "period" trong một khoản định kỳ là hoá đơn gắn trước
-- ngày này: app vẫn hiện nó ở mọi kỳ như cũ, cho tới khi bỏ đi.
--
-- Dữ liệu cũ: trên Production (đếm 04/11/2026) chỉ có MỘT khoản định kỳ, "Thuê mặt
-- bằng" (monthly, từ 09/06/2026), mang 2 hoá đơn "MB T10.jpg" và "MB T10.1.jpg" —
-- hoá đơn tháng 10. Quy tắc: hoá đơn chưa có kỳ của một khoản monthly mà tên file ghi
-- "T6" … "T12" được gắn vào tháng đó năm 2026 (app ghi chi phí từ 06/2026, chưa có
-- hoá đơn của năm khác). Tên không ghi tháng thì giữ nguyên, vẫn hiện ở mọi kỳ.
-- Chạy lại an toàn: phần tử đã có "period" không bị đụng; dòng không còn gì để gắn
-- thì không được cập nhật.

update public.finance_expenses as e
set receipts = (
      select jsonb_agg(
        case
          when item.r ? 'period' then item.r
          when (item.r->>'name') ~* '(^|[^a-z0-9])T0?([6-9]|1[0-2])([^0-9]|$)'
            then item.r || jsonb_build_object('period',
              '2026-' || lpad(substring(item.r->>'name' from '(?i)(?:^|[^a-z0-9])T0?([6-9]|1[0-2])(?:[^0-9]|$)'), 2, '0'))
          else item.r
        end
        order by item.position)
      from jsonb_array_elements(e.receipts) with ordinality as item(r, position)
    ),
    updated_at = now()
where e.recurrence = 'monthly'
  and e.status = 'active'
  and exists (
    select 1
    from jsonb_array_elements(e.receipts) as bill(r)
    where not bill.r ? 'period'
      and (bill.r->>'name') ~* '(^|[^a-z0-9])T0?([6-9]|1[0-2])([^0-9]|$)'
  );

notify pgrst, 'reload schema';
