# SPARKZ Charging Card

Embeddable React component for BEIA's end-user app.

The component has two runtime modes:

- `UNPLUGGED`: account view for the logged-in user.
- Active charging session: spend prompt view after BEIA provides session details.

BEIA should use the logged-in user's charging-contract eMAID as `contractId`, matching the final CDR. An app account ID or RFID UID is not interchangeable with it. The backend reads
that value through the existing `x-contract-id` identity header.

## Install

The reviewable artifact is built from this workspace. No registry or partner
publication is claimed. From this directory, reproduce and install the current
release candidate with:

```bash
npm ci
npm run build
npm pack
npm install ./neverflat-sparkz-charging-card-0.2.1-rc.1.tgz
```

The checked-in `neverflat-sparkz-charging-card-0.2.0.tgz` archive is the
historical 0.2.0 artifact and remains unchanged. The current 0.2.1-rc.1
artifact's SHA-256 is recorded in the external release handoff documents
after packing.

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

export function SparkzPanel({ emaid }: { emaid: string }) {
  const [sessionStatus, setSessionStatus] = useState<SparkzSessionStatus>('UNPLUGGED');
  const [sessionId, setSessionId] = useState<string | undefined>();

  return (
    <SparkzChargingCard
      apiBaseUrl="/api/sparkz"
      contractId={emaid}
      sessionStatus={sessionStatus}
      sessionId={sessionId}
      providerId={sessionId ? 'CDR-PROVIDER-ID' : undefined}
      chargerId={sessionId ? 'charger-001' : undefined}
      onReservationSuccess={(reservation) => {
        // The component starts polling this reservation automatically.
        console.log(reservation);
      }}
      onReservationSettlement={(settlement) => {
        // Forward this final settled/released result to the EMP.
        console.log(settlement);
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
  apiBaseUrl="/api/sparkz"
  contractId={emaid}
  sessionStatus="UNPLUGGED"
/>
```

In this mode the component calls:

```http
GET /wallet/me
x-contract-id: <emaid>
```

It shows balance, totals, recent activity, blockchain address, contract ID,
wallet mode, Polygon explorer links, and custodial wallet connection controls.
It does not show spend controls.

### Active charging-session mode

When BEIA detects charger opened, plugged in, or session started, pass the active
session details.

```tsx
<SparkzChargingCard
  apiBaseUrl="/api/sparkz"
  contractId={emaid}
  sessionStatus="PLUGGED_IN"
  sessionId="session-123"
  providerId="CDR-PROVIDER-ID"
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
x-contract-id: <emaid>
```

The spend prompt appears only after that endpoint returns. If the user applies a
discount, the component calls:

```http
POST /spend/me
x-contract-id: <emaid>
```

Active-session mode is intentionally focused on the charging decision. It shows
available-to-reserve SPARKZ, the admin-configured reward rates returned by
`/spend/session`, and the spend/skip controls. Account details, full activity,
and the "How it works" tab remain in unplugged mode only.

`POST /spend/me` now creates a reservation. The final CDR settles no more than
the delivered energy at `1 SPARKZ = 1 kWh` and releases the unused remainder.

The card blocks a second reservation while the previous one is still `reserved`
or `settling`. This protects the saved reservation context while the CDR is
being processed; once the reservation is `released`, or is `settled` with
`receiptStatus: "settled"` and a signed `spendReceipt`, a later session can
reserve independently.

The EMP sends its CDR through the Aarhus database, not through BEIA. NEVERFLAT
has no direct outbound connection to the EMP, so the component polls
`GET /spend/reservations/:reservationId`. It calls `onReservationSettlement`
once the result is `settled` with its signed receipt, or `released` without a
spend. BEIA forwards that result to the EMP, which applies the actual discount.
The component keeps polling when the token movement is confirmed but its
receipt is pending. Polling observes saved state; the CDR integration retries
the original CDR to recover incomplete processing.

Persist the returned reservation ID in BEIA and pass it back as the optional
`reservationId` prop when remounting the card. This resumes read-only polling
for that existing reservation; it never creates or retries a spend. The poll
requires the original `sessionId` and `providerId` props as well as the
original eMAID, and checks all three returned identifiers before notifying the
host. A browser component cannot guarantee
durable polling while it is unmounted, so BEIA should also poll the status API
from its backend when the app is not running.

The legacy `onSpendSuccess` callback is not emitted by this reservation flow,
because `POST /spend/me` does not produce a signed receipt immediately. Use
`onReservationSettlement` as the single settlement delivery callback after the
receipt is persisted.

For an active external wallet, the component obtains a capped ERC-20 approval
transaction from `POST /spend/reservation-approval-intent`, asks the wallet to
submit it, waits for confirmation, and then creates the reservation. This lets
NEVERFLAT perform delayed settlement after the CDR without asking for a second
signature. A partial settlement can leave a residual allowance which should be
revoked or replaced after settlement.

### CDR received/session closed

When BEIA considers the session complete, pass `UNPLUGGED` again and remove
active session props. BEIA does not receive the CDR itself.

```tsx
<SparkzChargingCard
  apiBaseUrl="/api/sparkz"
  contractId={emaid}
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
  reservationId?: string; // resumes read-only polling for an existing reservation
  sessionStatus?: 'UNPLUGGED' | 'CDR_RECEIVED' | 'CHARGER_OPENED' | 'PLUGGED_IN' | 'SESSION_STARTED';
  countryCode?: string;
  estimatedKwh?: number;
  estimatedCost?: number;
  logoSrc?: string;
  showWalletDetails?: boolean;
  hideAfterSpend?: boolean;
  hideAfterSkip?: boolean;
  polygonExplorerBaseUrl?: string;
  /** Deprecated for reservation flow; use onReservationSettlement. */
  onSpendSuccess?: (receipt: SparkzSpendReceipt) => void;
  onReservationSuccess?: (reservation: SparkzReservation) => void;
  onReservationSettlement?: (settlement: SparkzReservationSettlement) => void;
  reservationPollIntervalMs?: number; // defaults to 10000, minimum 1000
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
npm ci
$env:NVF_DEMO_API_ORIGIN = 'http://127.0.0.1:3005' # isolated local API only
$env:NVF_DEMO_API_KEY = '<isolated-local-api-key>'
$env:NVF_DEMO_EMAID = '<isolated-local-emaid>'
npm run dev -- --host 127.0.0.1 --port 3002
```

The local demo includes `Unplugged` and `Plugged in` simulator buttons. Its
Vite-only proxy accepts loopback API origins only, allows only the package's
wallet/session/reservation routes, strips browser credential headers, and adds
the configured API key and eMAID server-side. The demo reads the configured
eMAID from a local no-store config response; the API key is never sent to or
bundled into the browser. Missing configuration and non-loopback targets fail
closed. BEIA should not ship these controls; its app should use the same
server-bound proxy pattern and switch props based on real session/CDR state.
