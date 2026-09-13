import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '知径',
  description: '从一个话题，长出一张地图',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
