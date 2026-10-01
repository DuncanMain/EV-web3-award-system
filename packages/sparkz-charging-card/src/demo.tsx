import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { SparkzChargingCard } from './index';
import './demo.css';

function DemoApp() {
  const [pluggedIn, setPluggedIn] = useState(false);
  const [demoEmaid, setDemoEmaid] = useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/sparkz/demo-config')
      .then(response => {
        if (!response.ok) throw new Error('Local demo identity is not configured.');
        return response.json() as Promise<{ emaid?: string }>;
      })
      .then(config => {
        if (!cancelled) setDemoEmaid(config.emaid?.trim() || null);
      })
      .catch(() => {
        if (!cancelled) setDemoEmaid('');
      });
    return () => { cancelled = true; };
  }, []);

  if (demoEmaid === null) {
    return <main className="demo-shell"><p>Loading local demo identity...</p></main>;
  }

  if (demoEmaid === '') {
    return (
      <main className="demo-shell">
        <p role="alert">Local demo identity is not configured.</p>
      </main>
    );
  }

  return (
    <main className="demo-shell">
      <div className="demo-controls" role="group" aria-label="Session state">
        <button type="button" aria-pressed={!pluggedIn} onClick={() => setPluggedIn(false)}>
          Unplugged
        </button>
        <button type="button" aria-pressed={pluggedIn} onClick={() => setPluggedIn(true)}>
          Plugged in
        </button>
      </div>
      <SparkzChargingCard
        apiBaseUrl="/api/sparkz"
        // The dev endpoint exposes only the configured public eMAID. The
        // proxy still server-binds the same value for every request.
        contractId={demoEmaid}
        sessionId={pluggedIn ? 'spend-001' : undefined}
        providerId={pluggedIn ? 'NF' : undefined}
        chargerId={pluggedIn ? 'charger-001' : undefined}
        sessionStatus={pluggedIn ? 'PLUGGED_IN' : 'UNPLUGGED'}
        hideAfterSpend={false}
        hideAfterSkip={false}
        reservationPollIntervalMs={1000}
      />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <DemoApp />
  </React.StrictMode>
);
