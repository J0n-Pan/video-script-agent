'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
        <h1>视频号信息流编导脚本编写 Agent</h1>
        <div className="sub">本机部署版 · PRD v1.1 · 仅本机浏览器访问</div>
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
        <div className="mute2" style={{ marginTop: 16, lineHeight: 1.8 }}>
          首批账号由维护人员配置，不开放自助注册。
          <br />
          口令在部署时通过 `.env` 中的 `SEED_*` 变量设置，仓库内不提供默认口令。
        </div>
      </form>
    </div>
  );
}
