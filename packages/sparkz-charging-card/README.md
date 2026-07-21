# SPARKZ Charging Card

Embeddable React component for BEIA's end-user app.

The component has two runtime modes:

- `UNPLUGGED`: account view for the logged-in user.
- Active charging session: spend prompt view after BEIA provides session details.

BEIA should use the logged-in app user's UID as `contractId`. The backend reads
that value through the existing `x-contract-id` identity header.

## Install

Until this package is published to a registry, install from a packed tarball or
from this folder in a workspace.

```bash
npm install ./sparkz-charging-card-0.1.0.tgz
```

Import the component and styles:

```tsx
import { SparkzChargingCard } from '@neverflat/sparkz-charging-card';
import '@neverflat/sparkz-charging-card/styles.css';
```

## Basic Usage

```tsx
import { useState } from 'react';
import { SparkzChargingCard, SparkzSessionStatus } from '@neverflat/sparkz-charging-card';
import '@neverflat/sparkz-charging-card/styles.css';

export function SparkzPanel({ userUid }: { userUid: string }) {
  const [sessionStatus, setSessionStatus] = useState<SparkzSessionStatus>('UNPLUGGED');
  const [sessionId, setSessionId] = useState<string | undefined>();

  return (
    <SparkzChargingCard
      apiBaseUrl="https://api.example.com"
      contractId={userUid}
      sessionStatus={sessionStatus}
      sessionId={sessionId}
      providerId={sessionId ? 'EMP-PROVIDER-ID' : undefined}
      chargerId={sessionId ? 'charger-001' : undefined}
      onReservationSuccess={(reservation) => {
        // Store this ID; BEIA will use it to retrieve final settlement.
        console.log(reservation);
      }}
      onSkipSession={() => {
        // User chose not to spend SPARKZ for this session.
      }}
    />
  );
}
```

## State Model

### Unplugged/account mode

Use this before a charging session exists, and again after the CDR/session close
event is received.

```tsx
<SparkzChargingCard
  apiBaseUrl="https://api.example.com"
  contractId={userUid}
  sessionStatus="UNPLUGGED"
/>
```

In this mode the component calls:

```http
GET /wallet/me
x-contract-id: <userUid>
```

It shows balance, totals, recent activity, blockchain address, contract ID,
wallet mode, Polygon explorer links, and custodial wallet connection controls.
It does not show spend controls.

### Active charging-session mode

When BEIA detects charger opened, plugged in, or session started, pass the active
session details.

```tsx
<SparkzChargingCard
  apiBaseUrl="https://api.example.com"
  contractId={userUid}
  sessionStatus="PLUGGED_IN"
  sessionId="session-123"
  providerId="EMP-PROVIDER-ID"
  chargerId="charger-001"
/>
```

Active statuses:

- `CHARGER_OPENED`
- `PLUGGED_IN`
- `SESSION_STARTED`

In this mode the component calls:

```http
POST /spend/session
x-contract-id: <userUid>
```

The spend prompt appears only after that endpoint returns. If the user applies a
discount, the component calls:

```http
POST /spend/me
x-contract-id: <userUid>
```

Active-session mode is intentionally focused on the charging decision. It shows
available-to-reserve SPARKZ, the admin-configured reward rates returned by
`/spend/session`, and the spend/skip controls. Account details, full activity,
and the "How it works" tab remain in unplugged mode only.

`POST /spend/me` now creates a reservation. The final CDR settles no more than
the delivered energy at `1 SPARKZ = 1 kWh` and releases the unused remainder.

The EMP sends its CDR through the Aarhus database, not through BEIA. NEVERFLAT
has no direct outbound connection to the EMP, so BEIA must retrieve the final
reservation settlement from NEVERFLAT and forward it to the EMP. The required
reservation-status endpoint and component polling are planned but not yet
implemented.

### CDR received/session closed

When BEIA considers the session complete, pass `UNPLUGGED` again and remove
active session props. BEIA does not receive the CDR itself.

```tsx
<SparkzChargingCard
  apiBaseUrl="https://api.example.com"
  contractId={userUid}
  sessionStatus="UNPLUGGED"
/>
```

## Custodial Wallet Switching

The component does not allow custodial mode by typing an address. It requires an
installed EVM wallet such as MetaMask or Rabby.

Flow:

1. User clicks `Connect wallet and switch to custodial`.
2. Wallet extension returns the selected account.
3. User signs the NEVERFLAT wallet-link message.
4. Component calls `POST /wallet/:uid/linked-wallets` with `walletAddress` and
   `signature`.
5. After the backend verifies the signature, component calls
   `POST /wallet/:uid/mode`.

The signed message is:

```text
NEVERFLAT link wallet address
EMP contract: <contractId>
Wallet address: <walletAddress>
```

## Props

```ts
type SparkzChargingCardProps = {
  apiBaseUrl?: string;
  contractId: string;
  sessionId?: string;
  providerId?: string;
  chargerId?: string;
  sessionStatus?: 'UNPLUGGED' | 'CDR_RECEIVED' | 'CHARGER_OPENED' | 'PLUGGED_IN' | 'SESSION_STARTED';
  countryCode?: string;
  estimatedKwh?: number;
  estimatedCost?: number;
  logoSrc?: string;
  showWalletDetails?: boolean;
  hideAfterSpend?: boolean;
  hideAfterSkip?: boolean;
  polygonExplorerBaseUrl?: string;
  onSpendSuccess?: (receipt: SparkzSpendReceipt) => void;
  onReservationSuccess?: (reservation: SparkzReservation) => void;
  onSpendError?: (error: unknown) => void;
  onWalletLoaded?: (wallet: SparkzWalletResponse) => void;
  onWalletModeChange?: (wallet: SparkzWalletResponse) => void;
  onSkipSession?: (context: {
    contractId: string;
    sessionId: string;
    providerId: string;
    chargerId?: string;
    sessionStatus: 'CHARGER_OPENED' | 'PLUGGED_IN' | 'SESSION_STARTED';
  }) => void;
  onDismiss?: (reason: 'spent' | 'skipped') => void;
};
```

## Local Demo

```bash
cd packages/sparkz-charging-card
npm install
npm run dev -- --host 127.0.0.1 --port 3002
```

The local demo includes `Unplugged` and `Plugged in` simulator buttons. BEIA
should not ship those controls; their app should switch props based on real
session/CDR state.
