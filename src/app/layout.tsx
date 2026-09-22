import type { Metadata } from 'next';
import './globals.css';
import { APP_NAME } from '@/lib/constants';

export const metadata: Metadata = {
  title: APP_NAME,
  description: '把参考视频还原为可复核、可编辑、可供拍摄团队使用的脚本（PRD v1.1 本地部署版）',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
