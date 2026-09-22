import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { APP_NAME } from '@/lib/constants';
import LogoutButton from './LogoutButton';
import MuseSessionBanner from './MuseSessionBanner';
import MuseAutoLogin from './MuseAutoLogin';
import AvatarAutoLogin from './AvatarAutoLogin';

/**
 * 页头 + 妙思登录态提示栏 + 登录后自动扫码弹窗。
 *
 * 提示栏与自动弹窗放在这里而不是各页面里：6 个页面都用同一个 AppHeader，
 * 挂在页头正下方即可全站覆盖，登录页天然不涉及（它不渲染 AppHeader）。
 *
 * 两者分工（2026-09-22）：MuseAutoLogin 只管「刚登录工作台那一次」自动检查并按需弹码；
 * MuseSessionBanner 长期挂在顶部提醒（漏掉的、当场跳过的、用着用着过期的）。
 */
export default async function AppHeader() {
  const user = await getCurrentUser();
  return (
    <>
      <div className="header">
        <span className="brand">{APP_NAME}</span>
        <Link href="/tasks" style={{ fontSize: 13 }}>
          任务列表
        </Link>
        <Link href="/tasks/new" style={{ fontSize: 13 }}>
          新建任务
        </Link>
        <Link href="/export" style={{ fontSize: 13 }}>
          导出
        </Link>
        <Link href="/settings/ip-profile" style={{ fontSize: 13 }}>
          资料包
        </Link>
        <Link href="/settings/muse-session" style={{ fontSize: 13 }}>
          我的妙思会话
        </Link>
        <span className="spacer" />
        <span className="who">
          {user ? `${user.displayName}（${user.role === 'MAINTAINER' ? '维护人员' : '编导'}）` : '未登录'}
        </span>
        <LogoutButton />
      </div>
      <MuseSessionBanner />
      <MuseAutoLogin />
      <AvatarAutoLogin />
    </>
  );
}
