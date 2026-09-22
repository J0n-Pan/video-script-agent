'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { APP_NAME } from '@/lib/constants';
import { clearMuseAutoCheck } from '@/lib/muse-ui';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(j.error ?? '登录失败');
        return;
      }
      // 每次登录工作台都要重走一遍妙思自动检查，所以这里清掉「本浏览器已检查过」的记忆。
      // 放在登录成功这个唯一必然经过的点上（登出不一定发生：可能直接关标签页）。
      clearMuseAutoCheck(j.data?.id ?? '');
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
        {error && <div className="banner danger">{error}</div>}
        <div className="field">
          <label>账号</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </div>
        <div className="field">
          <label>密码</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <button className="primary" style={{ width: '100%', padding: '9px' }} disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
