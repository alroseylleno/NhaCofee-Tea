import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nhà Ops | Nguyên vật liệu",
  description: "Quản lý nguyên vật liệu cho Nhà Coffee & Tea",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body>{children}</body></html>;
}
