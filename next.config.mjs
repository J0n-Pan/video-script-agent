/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 首版仅本机访问：默认绑定 127.0.0.1，不开放局域网/公网（PRD 10.1）。
  experimental: {
    serverComponentsExternalPackages: [
      '@prisma/client',
      'bcryptjs',
      'exceljs',
      'ffmpeg-static',
      'ffprobe-static',
      // 可选依赖：妙思抓取用它开专用会话，标记为外部包避免被打进服务端产物
      'playwright',
    ],
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
