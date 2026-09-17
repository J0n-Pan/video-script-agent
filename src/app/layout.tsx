import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '视频号信息流编导脚本编写 Agent',
  description: '把参考视频还原为可复核、可编辑、可供拍摄团队使用的脚本（PRD v1.1 本地部署版）',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
