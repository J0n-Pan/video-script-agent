import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import LogoutButton from './LogoutButton';

export default async function AppHeader() {
  const user = await getCurrentUser();
  return (
    <div className="header">
      <span className="brand">视频号信息流编导脚本编写 Agent</span>
      <Link href="/tasks" style={{ fontSize: 13 }}>
        任务列表
      </Link>
      <Link href="/tasks/new" style={{ fontSize: 13 }}>
        新建任务
      </Link>
      <Link href="/export" style={{ fontSize: 13 }}>
        导出
      </Link>
      <span className="spacer" />
      <span className="who">
        {user ? `${user.displayName}（${user.role === 'MAINTAINER' ? '维护人员' : '编导'}）` : '未登录'}
      </span>
      <LogoutButton />
    </div>
  );
}
