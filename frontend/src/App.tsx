import React, { useState } from 'react';
import './App.css';
import AdminApp from './AdminApp';
import UserDashboard from './UserDashboard';

type Mode = 'picker' | 'admin' | 'user';

function App() {
  const [mode, setMode] = useState<Mode>('picker');

  if (mode === 'admin') return <AdminApp onBack={() => setMode('picker')} />;
  if (mode === 'user') return <UserDashboard onBack={() => setMode('picker')} />;

  return (
    <div className="mode-picker-shell">
      <div className="mode-picker-card">
        <div className="mode-picker-logos" aria-label="SPARKZ by NEVERFLAT">
          <img className="mode-picker-logo mode-picker-logo--neverflat" src="/neverflat-brand-logo.png" alt="NEVERFLAT logo" />
          <img className="mode-picker-logo mode-picker-logo--sparkz" src="/sparkz-brand-logo.png" alt="SPARKZ logo" />
        </div>

        <div className="mode-options">
          <button className="mode-btn" onClick={() => setMode('user')}>
            <span className="mode-btn__title">User Dashboard</span>
            <span className="mode-btn__desc">View your wallet, check balance and spend SPARKZ tokens</span>
          </button>
          <button className="mode-btn mode-btn--admin" onClick={() => setMode('admin')}>
            <span className="mode-btn__title">Admin Dashboard</span>
            <span className="mode-btn__desc">Test transactions and configure reward logic</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
