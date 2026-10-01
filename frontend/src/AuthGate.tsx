import React, { FormEvent, ReactNode, useEffect, useState } from 'react';
import { getDefaultApiBaseUrl, rememberApiBaseUrl } from './apiConfig';

type AuthGateRenderProps = {
  adminToken: string;
  baseUrl: string;
  onLogout: () => void;
};

interface AuthGateProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  children: (props: AuthGateRenderProps) => ReactNode;
}

export default function AuthGate({ title, subtitle = 'Authorised access only', onBack, children }: AuthGateProps) {
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [baseUrl, setBaseUrl] = useState(getDefaultApiBaseUrl());

  useEffect(() => {
    rememberApiBaseUrl(baseUrl);
  }, [baseUrl]);

  async function login(e: FormEvent) {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch(`${baseUrl}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginUsername, password: loginPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data?.message || 'Invalid credentials');
        return;
      }
      setAdminToken(data.token);
      setLoginPassword('');
      setShowLoginPassword(false);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err));
    }
  }

  async function logout() {
    if (adminToken) {
      await fetch(`${baseUrl}/admin/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => {});
    }
    setAdminToken(null);
  }

  if (adminToken) {
    return <>{children({ adminToken, baseUrl, onLogout: logout })}</>;
  }

  return (
    <div className="wallet-shell login-shell">
      {onBack && <button className="back-btn back-btn--bottom-left" onClick={onBack}>Back</button>}
      <div className="login-panel">
        <div className="brand-lockup" style={{ marginBottom: '1.5rem' }}>
          <div className="brand-glyph"><img src="/logo-blue.svg" alt="NEVERFLAT logo" /></div>
          <div>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
        </div>
        <form className="action-card" onSubmit={login} style={{ maxWidth: 360 }}>
          <label>
            API URL
            <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
          </label>
          <label>
            Admin email
            <input type="email" value={loginUsername} onChange={e => setLoginUsername(e.target.value)} autoComplete="username" required />
          </label>
          <label htmlFor="admin-login-password">Password</label>
          <div className="password-field">
            <input
              id="admin-login-password"
              type={showLoginPassword ? 'text' : 'password'}
              value={loginPassword}
              onChange={e => setLoginPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              className="password-toggle"
              aria-controls="admin-login-password"
              aria-pressed={showLoginPassword}
              onClick={() => setShowLoginPassword(current => !current)}
            >
              {showLoginPassword ? 'Hide password' : 'Show password'}
            </button>
          </div>
          {loginError && <p className="admin-error">{loginError}</p>}
          <button type="submit">Sign In</button>
        </form>
      </div>
    </div>
  );
}
