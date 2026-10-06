# BEIA SPARKZ Integration Guide

This guide describes the current local release candidate for integrating the
NEVERFLAT SPARKZ charging flow into the BEIA end-user app. It is an integration
contract, not evidence that a target release has been published or deployed.

## Candidate and deployment status

The package and examples in this repository are a **local candidate** for
review. They have not been published, pushed, or deployed. The existing
`neverflat-sparkz-charging-card-0.1.0.tgz` and
`neverflat-sparkz-charging-card-0.2.0.tgz` files are historical artifacts and
must not be overwritten.

The current npm-pack candidate is `@neverflat/sparkz-charging-card@0.2.1-rc.1`.
Its source-tree filename and SHA-256 are recorded in the local release
verification record:

```text
packages/sparkz-charging-card/neverflat-sparkz-charging-card-0.2.1-rc.1.tgz
CBE128B3AB3AD0E17F0DA84B7B64497008D0552FAEE87BF2E797776A6C2FA401
```

The old local handoff archives are preserved for audit history but are
superseded by the 30 September tarball manifest and must not be treated as the
current artifact. The current package test and browser scope are summarised in
the [local release verification record](RELEASE_VERIFICATION_2026-10-01.md).

Install the current tarball from the extracted candidate workspace or handoff:

```bash
npm install ./neverflat-sparkz-charging-card-0.2.1-rc.1.tgz
```

The command above is intentionally a local artifact install; it is not a
release, publish, or deployment command. Confirm the manifest and checksum
before handing a copy to a partner.

Target API documentation is a separate reference and may describe a different
build. It has not been verified as part of this local candidate. Check it only
when an environment owner provides the target environment and release
identifier:

- Swagger UI: `https://neverflat.zentrix.io/docs`
- OpenAPI JSON: `https://neverflat.zentrix.io/openapi.json`

The examples below use a same-origin BEIA proxy path so a browser does not
call that live URL directly.

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
- Passing the logged-in user's charging-contract eMAID as `contractId`.
- Passing charging-session context when a charger/session is active.
- Passing the canonical session and provider identifiers that will later
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

### Same-origin proxy boundary

The package examples use `apiBaseUrl="/api/sparkz"`. This is a BEIA
backend-for-frontend route on the same origin as the end-user app. The proxy
must:

- resolve the authenticated BEIA account to its authorised eMAID on the
  server;
- set `x-contract-id` from that server-side eMAID, and reject a browser value
  that does not match it;
- allowlist only the package routes (`/wallet/me`, `/spend/session`,
  `/spend/me`, `/spend/reservations/:reservationId`, and the wallet approval or
  mode routes when those features are enabled); and
- add the upstream `API_KEY` on the server side without returning it to the
  browser. The `INGEST_API_KEY` belongs to the trusted CDR ingestion path and
  is not a substitute for the package API key.

The eMAID is an ownership identifier, not an authentication credential. Do not
build a proxy that trusts an arbitrary `x-contract-id` supplied by the browser,
and do not put `API_KEY`, `INGEST_API_KEY`, treasury keys, or signing material
in the React bundle. Forward upstream status and structured error information
without converting a pending or review-required result into success.

The secret-free proxy and settlement examples are executable without API
credentials or network calls from the repository root:

```bash
node docs/examples/beia-integration-contract.mjs
```

The superseded 24 September handoff archive contained a copied helper under a
different path; use the repository `docs/examples` path above for this current
candidate.

## Identity

Use the logged-in user's charging-contract eMAID as the SPARKZ `contractId`. It must match the eMAID in the final CDR; an app account ID or RFID UID is not interchangeable with it.

The backend receives this as:

```http
x-contract-id: <emaid>
```

The React package sets this header automatically from the `contractId` prop.

Keep the eMAID value unchanged across wallet, reservation and CDR requests. Do
not change existing wallet identity values automatically. If an earlier
integration used an app account ID, reconcile its existing wallet and balance
before switching that account to an eMAID.

For native Hubject records, the provider/session pair is `ProviderID` and
`SessionID`. For OCPI records, use the provider identifier selected by the
existing NEVERFLAT mapping and the actual `session_id` when supplied. A CDR's
`id` can differ from its session ID. Confirm this mapping with the existing
integration contact; do not infer the provider from an unrelated token field.

NEVERFLAT detects the CDR protocol from the payload structure. There is no BEIA
selector for OCPI versus OICP:

- OCPI ownership comes from `cdr_token.contract_id`.
- OICP ownership comes from the present field or fields among
  `Identification.RemoteIdentification.EvcoID`,
  `Identification.QRCodeIdentification.EvcoID`,
  `Identification.PlugAndChargeIdentification.EvcoID`, and
  `Identification.RFIDIdentification.EvcoID`.

All present OICP `EvcoID` values must agree before the record is accepted; a
conflict is rejected or quarantined. The agreed value becomes the internal
eMAID. A UID-only payload is rejected or quarantined, and raw token or RFID
UIDs may remain audit metadata, but they never select the wallet or award owner.

Keep the actual provider and physical charging session identifiers in a durable
BEIA session record and rehydrate that record after an app or service restart.
Do not create a new session ID for a poll, retry, or reload. If the provider's
wire payload carries both an OCPI CDR `id` and `session_id`, preserve both and
do not substitute the CDR ID for the physical session ID.

## Install

Until the package is published to a registry, install the reviewed local
candidate recorded in the handoff manifest or use the package workspace.

```bash
npm install ./neverflat-sparkz-charging-card-0.2.1-rc.1.tgz
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
  emaid,
  activeSession,
}: {
  emaid: string;
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
      apiBaseUrl="/api/sparkz"
      contractId={emaid}
      sessionStatus={activeSession?.status || 'UNPLUGGED'}
      sessionId={activeSession?.sessionId}
      providerId={activeSession?.providerId} // provider ID used by final CDR normalisation
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
  apiBaseUrl="/api/sparkz"
  contractId={emaid}
  sessionStatus="UNPLUGGED"
/>
```

In this mode, the component calls:

```http
GET /wallet/me
x-contract-id: <emaid>
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
  apiBaseUrl="/api/sparkz"
  contractId={emaid}
  sessionStatus="PLUGGED_IN"
  sessionId="session-123"
  providerId="CDR-PROVIDER-ID"
  chargerId="charger-001"
/>
```

In this mode, the component calls:

```http
POST /spend/session
x-contract-id: <emaid>
```

Body:

```json
{
  "sessionId": "session-123",
  "providerId": "CDR-PROVIDER-ID",
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
x-contract-id: <emaid>
```

Body:

```json
{
  "amount": 5,
  "sessionId": "session-123",
  "providerId": "CDR-PROVIDER-ID",
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

If the active wallet is external, the component first requests a capped ERC-20
approval from the connected wallet. The user signs and submits that approval
once, before the reservation is created. NEVERFLAT verifies the confirmed
allowance and can then settle up to the reserved amount after the CDR without a
second user signature.

`/spend/me` is the reservation flow used by this component. Its durable
identity is the eMAID plus the exact `sessionId` and `providerId`; do not add a
random or server-generated idempotency key to make a retry safe. Store the
returned reservation ID together with its original `sessionId` and `providerId`
and poll it after a browser, app, or proxy restart.
The card keeps one non-terminal reservation in flight; wait for `released` or
for `settled` with a persisted receipt before creating another reservation for
that card. Cryptographic receipt trust remains a BEIA/EMP backend check.

Any separate BEIA integration that calls the direct manual `POST /spend` route
must create a stable, non-empty string `idempotencyKey` before its first
attempt and reuse the exact same bytes for transport failures, pending
operations, and receipt recovery. A new key means a new intended spend. The
manual route's `operationKey` is a returned recovery handle for an existing
operation; it cannot be used to create a new spend. Keyless new manual spends
are rejected before wallet creation or transfer.

### 4. User Skips Spending

If the user taps `Do not spend tokens for this session`, the component calls
`onSkipSession`.

BEIA can then close or hide the prompt for that charging session.

No backend spend is created.

### 5. Final CDR Arrives Through Aarhus

The existing AU/provider integration posts the final CDR to NEVERFLAT's
`POST /ingest/cdr` endpoint independently of BEIA. NEVERFLAT accounts for the
token entitlement at `1 SPARKZ = 1 delivered charging kWh`, capped by the
reservation and supported token precision. Any unused reservation is released.
The EMP applies the actual charging discount.

The partner defines a negative CDR energy value as discharge. Its absolute kWh
can earn V2G rewards; it does not consume a reservation for charging energy.

BEIA does not submit this CDR and cannot use the CDR-processing HTTP response.

### 6. BEIA Retrieves And Forwards Settlement

BEIA must retrieve the reservation status using the `reservation.id` returned
by `POST /spend/me`. A `settled` reservation is ready to forward when its signed
`spendReceipt` is present and `receiptStatus` is `settled`. A `released`
reservation has no spend receipt. BEIA forwards the complete result to the EMP,
which applies the discount.

A confirmed token movement can have a pending receipt after a database outage.
Keep polling for the receipt; polling observes the saved state. The existing
CDR integration retries the same immutable CDR to perform recovery. A response
requiring operator review must not cause a replacement spend.

Treat the outcomes as follows:

- `settled` with `receiptStatus: "settled"` and a `spendReceipt` is a delivery
  candidate.
- `settled` with `receiptStatus: "pending"` or `"not_created"` remains pending;
  poll and retry the saved receipt/recovery path, never a replacement spend.
- `reserved` or `settling` remains pending until the CDR worker reaches a
  terminal state.
- `released` with no receipt is a terminal release. Forward the release state
  to the EMP without inventing a token receipt.
- Any `requiresReview`, blocked, conflicting, or otherwise unknown result stops
  automatic forwarding and goes to operator review.

Before forwarding a settled result, the BEIA/EMP trusted backend must verify
the signature over `spendReceipt.canonicalPayload` using the configured trusted
NEVERFLAT signer, then compare the signed eMAID, wallet, amount, provider,
session, token transaction hash, token contract, and chain ID with the expected
reservation context. Receipt presence alone is not proof of trust. The EMP
delivery worker must durably deduplicate by its receipt or token transaction
identity plus the charging context and retry its own outbox idempotently;
NEVERFLAT does not deliver directly to the EMP.

The component uses this BEIA-facing reservation-status endpoint as the delivery
channel:

```http
GET /spend/reservations/:reservationId
x-contract-id: <emaid>
```

Expected final information:

```json
{
  "status": "settled",
  "reservationId": "...",
  "sessionId": "session-123",
  "providerId": "CDR-PROVIDER-ID",
  "reservedSparkz": "5.00",
  "settledSparkz": "3.00",
  "freeKwh": "3.00",
  "releasedSparkz": "2.00",
  "receiptStatus": "settled",
  "spendReceipt": {}
}
```

**Implementation status:** reservation creation, CDR settlement, contract-scoped
status retrieval, and component polling are implemented. BEIA receives the final
result through `onReservationSettlement` and must forward it to the EMP.

### Resuming after a reload or session close

Persist the reservation ID returned by `POST /spend/me` in the BEIA session
record together with the original session and provider identifiers. A resumed
reservation requires all three values; missing any one of them must fail closed
and must not start a new reservation. On a remount, pass the saved values back
to the component so it performs a read-only poll of the existing reservation:

```tsx
<SparkzChargingCard
  apiBaseUrl="/api/sparkz"
  contractId={emaid}
  reservationId={savedReservationId}
  sessionId={savedReservationSessionId}
  providerId={savedReservationProviderId}
  sessionStatus="UNPLUGGED"
  onReservationSettlement={forwardSettlementToEmp}
/>
```

`reservationId` never creates a new reservation. Keep polling one pending
reservation across a UI session close or a later app reload, and use
`onReservationSettlement` as the authoritative completion callback. If the
authenticated eMAID changes, stop the old poll and resolve the ownership issue
server-side; never poll a previous user's reservation under a new eMAID. The
saved session/provider pair belongs to the resumed reservation; do not replace
it with identifiers from a new active charging session on the same card. If a
new session begins before the old reservation is terminal, keep the old poll
separate or wait for a fresh component instance.

### 7. Session Closed

When BEIA considers the charging session closed, return the component to
unplugged mode. BEIA does not need to receive the CDR itself to do this:

```tsx
<SparkzChargingCard
  apiBaseUrl="/api/sparkz"
  contractId={emaid}
  sessionStatus="UNPLUGGED"
/>
```

When there is no outstanding or resumed reservation, remove `sessionId`,
`providerId`, and `chargerId` from props when unplugged. While a reservation is
still pending, retain its original `sessionId` and `providerId` alongside
`reservationId` for read-only polling; `chargerId` is not needed for that
resume. Do not replace those saved values with a new active session on the same
card.

## Component Props

```ts
type SparkzChargingCardProps = {
  apiBaseUrl?: string;
  contractId: string;
  /** Resume read-only polling; sessionId and providerId must be the saved original pair. */
  reservationId?: string;
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
  onReservationSettlement?: (settlement: SparkzReservationSettlement) => void;
  reservationPollIntervalMs?: number; // defaults to 10000, minimum 1000
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
x-contract-id: <emaid>
```

Purpose:

- Load SPARKZ wallet balance.
- Load recent activity.
- Load wallet mode and wallet addresses.

### `POST /spend/session`

Used when a charging session is active.

Headers:

```http
x-contract-id: <emaid>
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
x-contract-id: <emaid>
```

Purpose:

- Reserve SPARKZ for the charging session.
- Return the reservation ID and 1:1 maximum kWh entitlement.

### `GET /spend/reservations/:reservationId`

Used by the component to obtain the final Aarhus-CDR settlement and pass it to
BEIA through `onReservationSettlement`. The lookup is restricted to the
`x-contract-id` that owns the reservation.

### `POST /spend/reservation-approval-intent`

Used automatically by the component for an active external wallet. It returns
an ERC-20 `approve` transaction capped to the existing active reservations plus
the new reservation. After the wallet confirms that transaction, the component
passes its hash to `POST /spend/me`.

If final energy is lower than the reservation, the unused SPARKZ are released
in NEVERFLAT but the equivalent residual on-chain allowance can remain. The
settlement status will flag that the external wallet should revoke or replace
the residual allowance. A later reservation approval replaces it with the
allowance required for then-active reservations.

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

The eMAID is an identifier, not an authentication credential. The trusted
partner backend must bind the logged-in user to their authorised charging
contract and set or validate `x-contract-id`. The current shared API-key check
does not establish that a browser-supplied eMAID belongs to that user.

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
- External-wallet residual-allowance cleanup UI.
- Custom spend rules beyond the configured reward policy and server-enforced
  per-operation token cap.
- Discount amounts above available balance or the server's per-operation cap.

## Local Demo

Run the API locally, then run the package demo:

```bash
cd packages/sparkz-charging-card
npm install
export NVF_DEMO_API_ORIGIN=http://127.0.0.1:3005
export NVF_DEMO_API_KEY='<isolated-local-api-key>'
export NVF_DEMO_EMAID='<isolated-local-emaid>'
npm run dev -- --host 127.0.0.1 --port 3002
```

On PowerShell, set the same values with `$env:NVF_DEMO_API_ORIGIN`,
`$env:NVF_DEMO_API_KEY`, and `$env:NVF_DEMO_EMAID`. Use only an isolated local
API fixture and synthetic credentials for this demo; the proxy rejects missing
configuration and non-loopback API origins.

The demo includes local `Unplugged` and `Plugged in` buttons only for testing.
BEIA should wire state changes to real charger/session/CDR events.
