# Nhà Ops - Phần 1: Nhập kho NVL

Web app mobile-first để ghi nhận mỗi lần nhập nguyên vật liệu: tên, số lượng, đơn vị, đơn giá, ngày mua, nhà cung cấp và ảnh/PDF hóa đơn.

## Chạy local

```bash
npm install
npm run dev
```

Mở `http://localhost:3000`.

## Lưu ý dữ liệu

Phiên bản đầu lưu dữ liệu và file đính kèm trong `localStorage` của trình duyệt hiện tại để có thể chạy ngay trên Vercel Free mà chưa cần database. Không dùng đây làm dữ liệu kế toán chính thức hoặc dữ liệu chia sẻ giữa nhân viên.

## Bước deploy sau

Project tương thích Vercel. Khi cần nhiều thiết bị và lưu hóa đơn thật, phần tiếp theo là thay `localStorage` bằng Supabase (Postgres + Storage), rồi deploy từ Git repository lên Vercel Free.
