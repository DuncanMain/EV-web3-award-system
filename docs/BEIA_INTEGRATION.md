# BEIA SPARKZ Integration Guide

This guide explains how BEIA should integrate the NEVERFLAT SPARKZ user-facing
charging flow into the BEIA end-user app.

Live API documentation:

- Swagger UI: `https://neverflat.zentrix.io/docs`
- OpenAPI JSON: `https://neverflat.zentrix.io/openapi.json`

## What BEIA Gets

NEVERFLAT provides a reusable React package:

```text
@neverflat/sparkz-charging-card
```

The package is pre-wired to the NEVERFLAT API endpoints. BEIA does not need to
implement the SPARKZ wallet UI, spend prompt, amount validation, wallet activity
display, reward-rate display, or spend API calls.

BEIA is responsible for:

- Rendering the component in the app.
- Passing the logged-in BEIA user UID as `contractId`.
- Passing charging-session context when a charger/session is active.
- Passing the canonical session and EMP provider identifiers that will later
  appear in the Aarhus CDR data.
- Forwarding the completed settlement from NEVERFLAT to the EMP.

## Integration Topology

NEVERFLAT has no direct outbound connection to the EMP. Information travels in
two different directions:

```text
EMP -> Aarhus database -> NEVERFLAT final CDR processing
NEVERFLAT -> BEIA integration -> EMP settlement/discount processing
```

The HTTP response produced while NEVERFLAT processes an Aarhus CDR is not a
delivery channel to BEIA or the EMP. BEIA must retrieve the completed
reservation settlement from NEVERFLAT and forward it to the EMP.

The reservation is matched using the exact combination of `contractId`,
`sessionId`, and `providerId`. BEIA must not invent its own provider or session
identifier if it differs from the values that will appear in the final CDR.

## Identity

Use the logged-in BEIA app user's UID as the SPARKZ `contractId`.

The backend receives this as:

```http
x-contract-id: <beia-user-uid>
```

The React package sets this header automatically from the `contractId` prop.

## Install

Until the package is published to a registry, install from the provided package
tarball or workspace package.

```bash
npm install ./neverflat-sparkz-charging-card-0.1.0.tgz
```

Import the component and styles:

```tsx
import { SparkzChargingCard } from '@neverflat/sparkz-charging-card';
import '@neverflat/sparkz-charging-card/styles.css';
```

## Basic Integration

```tsx
import { SparkzChargingCard } from '@neverflat/sparkz-charging-card';
import '@neverflat/sparkz-charging-card/styles.css';

export function SparkzPanel({
  userUid,
  activeSession,
}: {
  userUid: string;
  activeSession?: {
    sessionId: string;
    providerId: string;
    chargerId: string;
    status: 'CHARGER_OPENED' | 'PLUGGED_IN' | 'SESSION_STARTED';
    countryCode?: string;
    estimatedKwh?: number;
    estimatedCost?: number;
  };
}) {
  return (
    <SparkzChargingCard
      apiBaseUrl="https://neverflat.zentrix.io"
      contractId={userUid}
      sessionStatus={activeSession?.status || 'UNPLUGGED'}
      sessionId={activeSession?.sessionId}
      providerId={activeSession?.providerId} // canonical EMP provider ID
      chargerId={activeSession?.chargerId}
      countryCode={activeSession?.countryCode}
      estimatedKwh={activeSession?.estimatedKwh}
      estimatedCost={activeSession?.estimatedCost}
      onReservationSuccess={(reservation) => {
        // The final CDR settles this at 1 SPARKZ per delivered kWh.
        console.log(reservation);
      }}
      onSkipSession={(context) => {
        // User chose not to spend SPARKZ for this charging session.
        console.log(context);
      }}
    />
  );
}
```

## Session Lifecycle

### 1. No Active Charging Session

When there is no active charger/session, render the card as unplugged:

```tsx
<SparkzChargingCard
  apiBaseUrl="https://neverflat.zentrix.io"
  contractId={userUid}
  sessionStatus="UNPLUGGED"
/>
```

In this mode, the component calls:

```http
GET /wallet/me
x-contract-id: <beia-user-uid>
```

The UI shows:

- Available SPARKZ.
- Recent activity.
- Contract ID.
- Blockchain address.
- Polygon explorer links.
- Wallet mode.
- Custodial wallet connection controls.
- "How it works" content.

It does not show spend controls.

### 2. Charger Opened, Plugged In, Or Session Started

When BEIA detects an active session, pass one of these statuses:

- `CHARGER_OPENED`
- `PLUGGED_IN`
- `SESSION_STARTED`

Example:

```tsx
<SparkzChargingCard
  apiBaseUrl="https://neverflat.zentrix.io"
  contractId={userUid}
  sessionStatus="PLUGGED_IN"
  sessionId="session-123"
  providerId="EMP-PROVIDER-ID"
  chargerId="charger-001"
/>
```

In this mode, the component calls:

```http
POST /spend/session
x-contract-id: <beia-user-uid>
```

Body:

```json
{
  "sessionId": "session-123",
  "providerId": "EMP-PROVIDER-ID",
  "chargerId": "charger-001",
  "status": "PLUGGED_IN",
  "countryCode": "GB"
}
```

This endpoint does not spend SPARKZ. It returns:

- Available balance.
- Spend eligibility.
- Maximum spendable amount.
- Suggested spend amount.
- Admin-configured reward rates.
- Recent activity for context.

The active-session UI is deliberately focused. It shows:

- Available SPARKZ.
- Reward rates, such as `1 SPARKZ = 4 kWh`.
- Spend amount input.
- `Apply discount`.
- `Do not spend tokens for this session`.

It does not show Account, How it works, Earned, or Spent in active-session mode.

`estimatedKwh` and `estimatedCost` are optional and should be omitted when the
final session values are not yet known.

### 3. User Reserves A Discount

When the user taps `Apply discount`, the component calls:

```http
POST /spend/me
x-contract-id: <beia-user-uid>
```

Body:

```json
{
  "amount": 5,
  "sessionId": "session-123",
  "providerId": "EMP-PROVIDER-ID",
  "label": "Charging discount"
}
```

The backend validates:

- `amount > 0`
- `amount <= availableBalance`
- `sessionId` is present
- `providerId` is present

This call reserves SPARKZ; it does not transfer them. The response contains a
reservation representing up to the same number of free kWh.

### 4. User Skips Spending

If the user taps `Do not spend tokens for this session`, the component calls
`onSkipSession`.

BEIA can then close or hide the prompt for that charging session.

No backend spend is created.

### 5. Final CDR Arrives Through Aarhus

The EMP writes the final CDR to the Aarhus database. NEVERFLAT obtains and
processes that CDR independently of BEIA. NEVERFLAT settles at `1 SPARKZ = 1
delivered kWh`. The settled amount is `min(reserved SPARKZ, final delivered
kWh)` and any remainder is released automatically.

BEIA does not submit this CDR and cannot use the CDR-processing HTTP response.

### 6. BEIA Retrieves And Forwards Settlement

BEIA must retrieve the reservation status using the `reservation.id` returned
by `POST /spend/me`. Once its status becomes `settled` or `released`, BEIA
forwards the complete result to the EMP so it can apply the free-kWh discount.

The required BEIA-facing reservation-status endpoint is the intended delivery
channel, for example:

```http
GET /spend/reservations/:reservationId
x-contract-id: <beia-user-uid>
```

Expected final information:

```json
{
  "status": "settled",
  "reservationId": "...",
  "sessionId": "session-123",
  "providerId": "EMP-PROVIDER-ID",
  "reservedSparkz": "5.00",
  "settledSparkz": "3.00",
  "freeKwh": "3.00",
  "releasedSparkz": "2.00",
  "spendReceipt": {}
}
```

**Implementation status:** reservation creation and CDR settlement are
implemented, but this BEIA-facing status endpoint and component polling are not
yet implemented. They are required before the end-to-end EMP discount flow is
complete.

### 7. Session Closed

When BEIA considers the charging session closed, return the component to
unplugged mode. BEIA does not need to receive the CDR itself to do this:

```tsx
<SparkzChargingCard
  apiBaseUrl="https://neverflat.zentrix.io"
  contractId={userUid}
  sessionStatus="UNPLUGGED"
/>
```

Remove `sessionId`, `providerId`, and `chargerId` from props when unplugged.

## Component Props

```ts
type SparkzChargingCardProps = {
  apiBaseUrl?: string;
  contractId: string;
  sessionId?: string;
  providerId?: string;
  chargerId?: string;
  sessionStatus?:
    | 'UNPLUGGED'
    | 'CDR_RECEIVED'
    | 'CHARGER_OPENED'
    | 'PLUGGED_IN'
    | 'SESSION_STARTED';
  countryCode?: string;
  estimatedKwh?: number;
  estimatedCost?: number;
  logoSrc?: string;
  showWalletDetails?: boolean;
  hideAfterSpend?: boolean;
  hideAfterSkip?: boolean;
  polygonExplorerBaseUrl?: string;
  onReservationSuccess?: (reservation: SparkzReservation) => void;
  onSpendSuccess?: (receipt: SparkzSpendReceipt) => void; // legacy immediate-spend flows
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

## API Calls Made By The Component

### `GET /wallet/me`

Used in unplugged/account mode.

Headers:

```http
x-contract-id: <beia-user-uid>
```

Purpose:

- Load SPARKZ wallet balance.
- Load recent activity.
- Load wallet mode and wallet addresses.

### `POST /spend/session`

Used when a charging session is active.

Headers:

```http
x-contract-id: <beia-user-uid>
```

Purpose:

- Build the session spend prompt.
- Return reward rates.
- Return max spendable amount.
- Confirm whether the user can spend SPARKZ.

This endpoint does not spend tokens.

### `POST /spend/me`

Used only after the user confirms an amount.

Headers:

```http
x-contract-id: <beia-user-uid>
```

Purpose:

- Reserve SPARKZ for the charging session.
- Return the reservation ID and 1:1 maximum kWh entitlement.

### Planned: `GET /spend/reservations/:reservationId`

Required for BEIA to obtain the final Aarhus-CDR settlement and pass it to the
EMP. This endpoint is documented as planned and is not currently implemented.

### `POST /wallet/:uid/linked-wallets`

Used when a user connects a wallet app and signs the ownership message.

The component does not allow wallet switching by typed address alone.

### `POST /wallet/:uid/mode`

Used to switch between managed and custodial wallet mode after wallet ownership
has been proven.

## Authentication Notes

The component always sends `x-contract-id`.

If an environment is configured to require an additional API key, do not expose a
secret API key directly in the end-user app. Use an approved BEIA/backend proxy
or deployment-level auth pattern instead.

## Error Handling

The component displays backend errors clearly. BEIA can also listen to:

```tsx
onSpendError={(error) => {
  console.error(error);
}}
```

Relevant spend validation codes:

- `MISSING_SESSION_ID`
- `MISSING_PROVIDER_ID`
- `INVALID_AMOUNT`
- `INSUFFICIENT_SPARKZ`

## Not Included

The current charging-session flow does not implement:

- Manual cancellation before the final CDR.
- BEIA reservation-status polling and settlement delivery to the EMP.
- Spend caps beyond available balance.
- Custom spend rules beyond `amount > 0` and `amount <= availableBalance`.

## Local Demo

Run the API locally, then run the package demo:

```bash
cd packages/sparkz-charging-card
npm install
npm run dev -- --host 127.0.0.1 --port 3002
```

The demo includes local `Unplugged` and `Plugged in` buttons only for testing.
BEIA should wire state changes to real charger/session/CDR events.
