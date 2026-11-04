-- Sửa hoá đơn bị app tự gắn nhầm vào lô kho (báo lỗi của user 05/11/2026: "có những
-- món không up hoá đơn nhưng vẫn hiện hoá đơn, vd tắc tươi"; "hoá đơn bị trùng dù đã
-- chia theo tháng").
--
-- Lỗi (app/page.tsx, sửa cùng commit này): file hoá đơn chọn trong form Nhập kho / Sửa
-- lô nằm lại trong bộ nhớ sau khi lưu, và "Sửa thông tin lô" không xoá nó. Lô sửa tiếp
-- theo (dù chỉ đổi số lượng) được tải lên CHÍNH file đó, đè hoá đơn của lô. Lịch sử lô
-- không ghi đổi hoá đơn vì form vẫn hiện tên hoá đơn cũ — dấu vết dùng để tìm ra lô bị.
--
-- Cách tìm (đối chiếu storage.objects bucket bills với inventory_history, 05/11/2026):
-- lô có hoá đơn hiện tại được tải lên mà lịch sử không ghi đổi hoá đơn và không phải
-- lúc tạo lô; nội dung file (eTag) trùng một file vừa chọn cho lô KHÁC, mua NGÀY KHÁC.
-- 9 lô dưới đây. Lô nào có hoá đơn tự chọn trước đó thì khôi phục hoá đơn đó (file vẫn
-- nằm trong bucket, cùng thư mục shared/<id lô>-…); lô chưa từng có thì bỏ trống để
-- hiện "Chưa có hoá đơn" và gắn lại đúng.
--
-- KHÔNG đụng: lô bị gắn tự động nhưng mua CÙNG NGÀY với lô được chọn (rất có thể cùng
-- một hoá đơn nhà cung cấp), và 4 lô cần người xem: Kem béo CARNATION EXTRA 19/06
-- (NL19.6.1 thay NL19.6), Vải hộp NIF 14/05 (NL14.5 thay NL25.6), 2 lô Nước ngọt Sprite
-- 02/10 (ảnh chụp màn hình 00:44 05/11).
--
-- An toàn: chỉ sửa khi lô vẫn đang mang đúng file sai (người dùng đã tự sửa thì bỏ qua);
-- mỗi lô được sửa có thêm một dòng lịch sử "Hóa đơn: <file sai> → <file đúng | Không có>".
-- Chạy lại không đổi gì. Không xoá file nào trong bucket.

with fixes (lot_id, bad_path, bad_name, restore_path, restore_name) as (
  values
    -- Túi ly 1 ngăn · mua 2026-06-15 · phiếu 010726-021: đang mang NL22.7.jpg (chọn cho trân châu đen 3Q MINH HẠNH mua 2026-07-22)
    ('86e0ab23-2a9f-41f1-ab4d-df71311b84d8'::uuid, 'shared/86e0ab23-2a9f-41f1-ab4d-df71311b84d8-1793708575066-NL22.7.jpg', 'NL22.7.jpg', 'shared/86e0ab23-2a9f-41f1-ab4d-df71311b84d8-1793639544803-15.06-Ly.jpg', '15.06 Ly.jpg'),
    -- nắp L - NẮP VUÔNG · mua 2026-06-15 · phiếu 010726-015: đang mang nl5.8.3.jpg (chọn cho Ly 700ml mua 2026-08-05)
    ('5dbf4d0a-8285-4c9d-8d95-8f840e1fe56b'::uuid, 'shared/5dbf4d0a-8285-4c9d-8d95-8f840e1fe56b-1793772537747-nl5.8.3.jpg', 'nl5.8.3.jpg', 'shared/5dbf4d0a-8285-4c9d-8d95-8f840e1fe56b-1793639438162-15.06-Ly.jpg', '15.06 Ly.jpg'),
    -- nắp L - NẮP CẦU · mua 2026-06-15 · phiếu 010726-016: đang mang nl5.8.3.jpg (chọn cho Ly 700ml mua 2026-08-05)
    ('95e14e1f-d35b-4798-8769-8c76ea0b019e'::uuid, 'shared/95e14e1f-d35b-4798-8769-8c76ea0b019e-1793772561277-nl5.8.3.jpg', 'nl5.8.3.jpg', 'shared/95e14e1f-d35b-4798-8769-8c76ea0b019e-1793639471805-15.06-Ly.jpg', '15.06 Ly.jpg'),
    -- Syrup Chanh dây MAMA ROSA · mua 2026-07-02 · phiếu 010726-065: đang mang NL8.7.jpg (chọn cho Trà olong HOÀNG GIA mua 2026-07-08)
    ('5f62d288-73fa-4a13-9b82-14501561cf55'::uuid, 'shared/5f62d288-73fa-4a13-9b82-14501561cf55-1793706865471-NL8.7.jpg', 'NL8.7.jpg', null, null),
    -- Trân châu đen DOU XIAN 2.2 · mua 2026-07-02 · phiếu 010726-088: đang mang NL15.7.jpg (chọn cho Mứt đào BERINO mua 2026-07-15)
    ('a34f19a8-aac5-4a66-a383-995ad306a304'::uuid, 'shared/a34f19a8-aac5-4a66-a383-995ad306a304-1793707822021-NL15.7.jpg', 'NL15.7.jpg', 'shared/a34f19a8-aac5-4a66-a383-995ad306a304-1793704386066-NL-2.7.pdf', 'NL 2.7.pdf'),
    -- Vải hộp PL · mua 2026-10-05 · phiếu 051026-001: đang mang NL25.6.jpg (chọn cho Đào hộp HOSEN mua 2026-06-25)
    ('4464727b-d9c6-4893-a9ff-8e787fe0575e'::uuid, 'shared/4464727b-d9c6-4893-a9ff-8e787fe0575e-1793813168322-NL25.6.jpg', 'NL25.6.jpg', 'shared/4464727b-d9c6-4893-a9ff-8e787fe0575e-1793791051711-NL5.10.jpg', 'NL5.10.jpg'),
    -- Vải hộp THANH HÀ · mua 2026-10-12 · phiếu 101026-011: đang mang NL25.6.jpg (chọn cho Đào hộp HOSEN mua 2026-06-25)
    ('a61c7223-5d33-42ff-b276-50b3d0ef9c17'::uuid, 'shared/a61c7223-5d33-42ff-b276-50b3d0ef9c17-1793813153353-NL25.6.jpg', 'NL25.6.jpg', 'shared/a61c7223-5d33-42ff-b276-50b3d0ef9c17-1793555963959-Screenshot-2026-10-29-194930.png', 'Screenshot 2026-10-29 194930.png'),
    -- Chanh tươi · mua 2026-10-25 · phiếu 251026-002: đang mang nl24.9.jpg (chọn cho Syrup Bạc hà MAMA ROSA mua 2026-09-24)
    ('b15b939b-2e85-4151-acfb-c1372e79b485'::uuid, 'shared/b15b939b-2e85-4151-acfb-c1372e79b485-1793816496579-nl24.9.jpg', 'nl24.9.jpg', null, null),
    -- Tắc tươi · mua 2026-10-25 · phiếu 251026-003: đang mang nl24.9.jpg (chọn cho Syrup Bạc hà MAMA ROSA mua 2026-09-24)
    ('8a75b38f-d2b1-49cf-b1f3-b65bbdcc56a1'::uuid, 'shared/8a75b38f-d2b1-49cf-b1f3-b65bbdcc56a1-1793816520323-nl24.9.jpg', 'nl24.9.jpg', null, null)
), repaired as (
  update public.inventory_receipts as lot
  set receipt_path = fixes.restore_path,
      receipt_name = fixes.restore_name,
      updated_at = now()
  from fixes
  where lot.id = fixes.lot_id
    and lot.receipt_path = fixes.bad_path
  returning lot.id, fixes.bad_name, fixes.restore_name
)
insert into public.inventory_history (inventory_receipt_id, action, changes)
select id, 'updated', jsonb_build_array(jsonb_build_object('field', 'receipt', 'from', bad_name, 'to', coalesce(restore_name, 'Không có')))
from repaired;
