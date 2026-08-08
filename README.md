# Nhà Ops

Web app mobile-first cho Kho NVL và Tài chính của Nhà Coffee & Tea. Production chạy trên Vercel, dùng Supabase cho dữ liệu dùng chung; localhost/UAT dùng kho dữ liệu trình duyệt tách biệt để kiểm thử.

## Code map

Đọc [`MOC.md`](./MOC.md) trước khi sửa code. File này định tuyến chức năng đến đúng UI, data store, Supabase migration và checklist UAT/Production.

## Chạy local

```bash
npm install
npm run dev -- -p 3001
```

Mở `http://localhost:3001`.

## Ranh giới dữ liệu

- Localhost và hostname có `-uat` dùng local storage riêng, không ghi vào Production Supabase.
- Production dùng Supabase Auth, Postgres và Storage.
- Không đưa dữ liệu mẫu/nút reset UAT lên Production.
- Nếu thay đổi schema/RLS/RPC, tạo migration timestamp mới trong `supabase/migrations/`.

## Deploy

GitHub `main` tự động redeploy project Vercel hiện có. Migration Supabase mới được GitHub Actions áp dụng khi push thay đổi trong `supabase/migrations/` hoặc workflow migration.
