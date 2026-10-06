# Trusted token spend evidence

`verifySpendEvidence` in `src/spendEvidence.ts` is a read-only verification
boundary for externally signed legacy spend transactions. It does not submit a
transaction, write a receipt, or write database state.

The verifier receives a configured ethers provider, expected chain ID, expected
ERC20 token contract, source wallet, treasury recipient, exact integer
`amountUnits`, and transaction hash. For an 18-decimal token, the integration
must convert the canonical decimal amount with `ethers.parseUnits(amount, 18)`
and pass the resulting string or bigint. Floating point amounts are rejected.

Verification requires all of the following:

1. The hash has valid 32-byte syntax and the provider reports the expected
   chain.
2. The returned transaction hash and mined receipt hash both match the
   requested hash, the receipt sender matches the transaction sender, and the
   receipt target matches the configured token contract.
3. The transaction exists, has a mined receipt with status `1`, and any nonzero
   typed transaction chain ID matches the expected chain. Legacy chain ID `0`
   relies on the verified provider network.
4. The transaction targets the configured token contract.
5. Calldata is an ERC20 `transfer` or `transferFrom` call whose source,
   treasury recipient, and exact integer amount match the expected values.
6. The receipt contains a decodable ERC20 `Transfer` event emitted by the
   expected token contract with the same source, recipient, and amount.

The final event requirement follows [EIP-20](https://eips.ethereum.org/EIPS/eip-20):
successful token movement must emit `Transfer`, and callers must not treat
transaction success alone as proof of the requested movement. Calldata alone is
therefore insufficient.

The result is a discriminated object. A successful result contains a proof with
canonical addresses, chain ID, exact base-unit amount, transfer method, block,
and log index. A failed result contains a stable code, message, and `pending`
flag. `TRANSACTION_NOT_FOUND`, `RECEIPT_PENDING`, `TRANSACTION_FAILED`, wrong
asset, wrong sender/recipient/amount, missing event, and malformed call/log
cases are distinguishable for API validation and pending handling.

The public `POST /spend/custodial-record` path calls the helper before either
`recordSpend` or receipt creation. It obtains the chain from the configured RPC
provider and rejects an explicit `CHAIN_ID` assertion that disagrees with that
network. Token contract, treasury recipient, and linked source wallet come
from server configuration and the linked-wallet record; none is accepted from
the request as authority. A pending receipt or provider lookup returns HTTP
202/503 with `proofFailure`, `pending`, and `retryable` fields. Wrong asset,
sender, recipient, amount, hash, reverted receipt, or malformed event returns
a structured validation error and creates no spend projection or receipt.

A repeated custodial hash is accepted only when the existing spend projection
belongs to the requested eMAID and its receipt matches the requested linked
wallet, exact two-decimal amount, session, provider, token contract, chain, and
configured signer. An owner lookup outage returns HTTP 202 for recovery; an
owner mismatch returns HTTP 409 with `requiresReview: true`. The response
includes the stored receipt and `duplicate: true`. A missing or conflicting
historical projection/receipt returns `requiresReview: true`; it is never
reported as a generic successful "already recorded" result. A newly verified
transfer writes its signed receipt context before the database projection. If
the receipt write fails, HTTP 202 keeps the transfer unprojected so the exact
request can retry. If the projection write fails, HTTP 202 includes the
validated receipt and the exact hash; a retry validates that same receipt and
performs one idempotent projection without submitting another transfer.
Existing/raced receipts are checked against the same frozen context before
reuse. A historical spend row without a matching receipt remains review-only.

Reservation recovery applies the same rule to the durable reservation spend
operation: the original owner, amount, reservation ID, session/provider, hash,
and captured token asset context must still match. If the operation or its
asset context is missing, or the configured token/chain/treasury/signer has
changed, receipt recovery returns `requiresReview` and does not mint a new
receipt under the current configuration. The CDR award is validated first;
the reservation is settled only after that frozen award intent succeeds.
For a zero-settlement discharge, the API first claims a durable amount-zero
operation with the same owner/wallet/session/provider/reservation fingerprint
and asset context, then releases the hold. A completion failure can therefore
retry the same release; an existing positive operation under that key is a
review mismatch and cannot be overwritten.

The evidence proof is used as the write gate. The current receipt schema does
not have dedicated proof columns, so the API must not claim that proof fields
were persisted separately; the chain hash and the signed receipt payload remain
the durable compatibility fields. A provider or receipt lookup error remains
unsettled until verification can be retried.

The intended call shape is:

```ts
import { verifySpendEvidence } from './spendEvidence';

const evidence = await verifySpendEvidence({
  provider: configuredProvider,
  tokenContractAddress: configuredTokenContract,
  chainId: configuredChainId,
  sourceWallet: expectedLinkedWallet,
  treasuryRecipient: configuredTreasuryAddress,
  amountUnits: ethers.parseUnits(canonicalAmount, 18),
  txHash: submittedTxHash,
});

if (!evidence.valid) {
  // Map evidence.failure.code; do not record a settled spend.
}
```

For a valid result, the useful proof fields are
`txHash`, `chainId`, `tokenContractAddress`, `sourceWallet`,
`treasuryRecipient`, `amountUnits`, `transferMethod`, `transactionFrom`,
`blockNumber`, and `logIndex`. The API must supply the expected values from
server-side configuration or the already-authorized linked-wallet context;
they must not be copied from untrusted request fields.

Receipt signatures retain the existing payload, canonical JSON, and signature
schema. `verifySpendReceiptAgainstTrustedSigner` adds the server-side trust
boundary: the caller's submitted `signerAddress` must match the configured
NEVERFLAT signer, and the signature must recover to that configured address.
The generic `verifySpendReceipt` helper remains available for compatibility but
must not receive a caller-chosen trusted signer in the API path.

The trusted receipt call is:

```ts
import { verifySpendReceiptAgainstTrustedSigner } from './receipt';

const signatureCheck = verifySpendReceiptAgainstTrustedSigner(
  payload,
  signature,
  req.body.signerAddress ?? configuredNeverflatReceiptSigner,
  configuredNeverflatReceiptSigner,
);
```

Only `signatureCheck.valid === true` should permit a settled receipt response.
`POST /spend-receipts/verify` applies this rule with the configured treasury
signer. `signerAddress` remains optional for compatibility: when omitted, the
server uses that configured signer, while a caller-supplied attacker address is
only a claim and cannot establish trust.

`GET /spend/reservations/:reservationId` exposes additive `receiptStatus` and
reports the current persisted state. It does not itself recover a missing
receipt. Settled reservations with a missing receipt report `pending`, while
released reservations have `receiptStatus: "none"`; the charging-card client
keeps polling a settled reservation whose receipt is still pending.

`POST /ingest/cdr` runs the durable award validation/recovery before it settles
the matching reservation. A duplicate award still performs missing reservation
or receipt recovery. If award settlement is known but reservation recovery is
pending, the response keeps `awardTxHash`/`tokensAwarded` separate from the
reservation `txHash`, returns HTTP 202, and marks ambiguous pre-hash outcomes
for review rather than instructing an unsafe blind retry. A changed CDR or
owner must therefore fail before any reservation debit.

Managed-wallet approval preparation is also fail-closed. If funding or
allowance preparation has an ambiguous or review-required state, `/spend`
returns HTTP 202 with `pending: true`, `requiresReview: true`,
`preflightFailure: false`, and `retryable: false`; the client keeps the same
operation/idempotency key for recovery.
