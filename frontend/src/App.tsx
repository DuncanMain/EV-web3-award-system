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
        <div className="brand-lockup brand-lockup--centered">
          <div className="brand-glyph brand-glyph--lg">N</div>
          <div>
            <h1>NEVERFLAT</h1>
            <p>Token Platform</p>
          </div>
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

