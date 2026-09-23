'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { APP_NAME } from '@/lib/constants';

/**
 * 首次登录强制改密表单。
 * 装机时用统一初始口令建的账号，登录后只能停在这一页：
 * 业务接口同样会拦（requireUser 抛 409），所以这不是前端障眼法。
 */
export default function ChangePasswordForm({ username }: { username: string }) {
  const router = useRouter();
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('新密码至少 8 位');
      return;
    }
    if (newPassword !== confirm) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(j.error ?? '修改失败');
        return;
      }
      router.replace('/tasks');
      router.refresh();
    } catch (err) {
      setError(`请求失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-box" onSubmit={submit}>
        <h1>{APP_NAME}</h1>
        <p style={{ margin: '0 0 14px', color: '#8a8f98', fontSize: 13, lineHeight: 1.7 }}>
          你正在使用安装时下发的初始口令（账号 {username}）。
          为了你自己的任务数据不被别人看到，请先把口令换成只有你知道的。
        </p>
        {error && <div className="banner danger">{error}</div>}
        <div className="field">
          <label>原密码</label>
          <input
            type="password"
            value={oldPassword}
            onChange={(e) => setOld(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <div className="field">
          <label>新密码（至少 8 位）</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className="field">
          <label>确认新密码</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <button className="primary" style={{ width: '100%', padding: '9px' }} disabled={busy}>
          {busy ? '修改中…' : '修改并进入工作台'}
        </button>
      </form>
    </div>
  );
}
