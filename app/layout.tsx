import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kuang Info Hub｜你的個人情報台",
  description: "整合市場、財經、NBA、遊戲與社群趨勢的個人情報中心。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
