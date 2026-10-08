# CDR compatibility and eMAID ownership

This document describes the local CDR normalisation boundary for the existing
Hubject/OICP and OCPI partners. The normaliser keeps the historical output
names (`uid`, `sessionId`) for API and deduplication compatibility. The value
of `uid` is the owner eMAID/contract ID; it is never an RFID or token UID.

## Automatic protocol detection and canonical result

One normalisation boundary accepts both OCPI and OICP structures. Protocol is
detected from the payload shape: OCPI markers include `cdr_token`, `id`,
`cdr_location`, and `start_date_time`; OICP markers include `Identification`,
`SessionID`, `EvseID`, `ChargingStart`, and `ConsumedEnergy`. A payload that
contains both structures is reported as `MIXED` and still undergoes the same
identity conflict checks. There is no protocol selector in the admin panel or
ingestion request.

Every successful normalised result includes:

- `eMAID` and the lower-camel `emaid` alias as the canonical owner value;
- `protocol` (`OCPI`, `OICP`, `MIXED`, or `UNKNOWN`);
- `sourceField`, naming the exact wire field used for ownership; and
- optional `tokenMetadata`, which can retain a token/RFID UID, token type,
  country/party, or OICP identification variant for audit only.

The historical `uid` result field remains an alias of the same eMAID so wallet
derivation, database columns, and award deduplication do not change. A token or
RFID UID is never copied into `uid`, `eMAID`, or wallet ownership.

Identity-boundary failures carry a structured `normalisationError` in preview
and ingest validation responses and in the corresponding audit metadata. The
error includes a code (`MISSING_EMAID`, `UID_ONLY`, `CONFLICTING_IDENTIFIERS`,
or `INVALID_EMAID`), detected protocol, and source fields. UID-only records
are rejected/quarantined for audit and cannot enter award processing.

## Accepted owner identifiers

The normaliser considers these populated aliases, in this order:

- `cdr_token.contract_id` (native OCPI object)
- `cdr_token_contract_id` (flattened OCPI export)
- `ContractID` (existing Hubject export spelling)
- native OICP `Identification` owner fields: `EvcoID`/`eMAID`/`EMAID`, including
  the `RFIDIdentification`, `QRCodeIdentification`,
  `PlugAndChargeIdentification`, and `RemoteIdentification` variant objects

The first three are the documented partner aliases. In OICP, `EvcoID` is the
contract identifier carried by the identification variant. Only owner fields
inside the actual `Identification` object are considered. `UID`,
`cdr_token.uid`, and flattened `cdr_token_uid` remain authentication/token
identifiers and are not used as ownership. A literal blank or `null`
`ContractID` is treated as absent. If two populated owner aliases differ in
case, punctuation, or value, the CDR is rejected as contradictory; accepted
values are returned without case or punctuation changes. Owner aliases must be
strings without leading or trailing whitespace; numeric values are rejected
because spreadsheet conversion can lose leading zeroes in a charging contract.

The OICP variant names and `EvcoID` contract field follow Hubject's primary
[OICP 2.3 EMP datatype definition](https://github.com/hubject/oicp/blob/master/OICP-2.3/OICP%202.3%20EMP/03_EMP_Data_Types.asciidoc).
Its `RFIDMifareFamilyIdentification` variant carries only an RFID `UID`, so it
is deliberately excluded from owner candidates and cannot infer an eMAID.

## Session, provider, and EVSE mapping

Native OICP names are supported alongside the existing aliases:

| Canonical output | Accepted fields |
| --- | --- |
| `sessionId` | `SessionID`, `sessionId`, OCPI `id`, legacy `session_id` fallback |
| `providerId` | `ProviderID`, `providerId`, `provider`, `HubProviderID`, `provider_id`, `custom_data.provider_id`, OCPI `party_id` |
| `evseId` | `EVSEID`, OICP `EvseID`, `evseId`, `evse`, `cdr_location.evse_id`, flattened `cdr_location_evse_id`, `evse_id` |

`SessionID` remains the native OICP session identity and wins over other
session fields. For OCPI, the existing `sessionId` output remains the CDR
`id`, preserving the legacy `${sessionId}-${providerId}` deduplication key.
When an OCPI `id` selects the canonical session identity and `session_id` is
populated, the normalised result also exposes:

- `cdrId`: the OCPI CDR `id`
- `reservationSessionId`: the OCPI `session_id`

These fields are optional and additive. The API/reservation integration uses
`reservationSessionId` for reservation lookup while continuing to use
`sessionId`/`providerId` for legacy award deduplication. Native OICP
reservation matching continues to use `sessionId`; an unrelated OCPI
`session_id` in a mixed native/legacy payload is ignored for reservation
matching.

EVSE country extraction reads the first two leading letters, so both
`DE*GUC*E*EZO*0877` and compact `BEBECE041503003` produce `DE` and `BE`
respectively. The EVSE value itself is preserved.

## Time and energy mapping

The normaliser accepts existing fields and native spellings:

- start: `Session Start`, `SessionStart`, `Charging Start`, `ChargingStart`,
  `StartTime`, `timestamp`, `start_date_time`
- end: `Session End`, `SessionEnd`, `Charging End`, `ChargingEnd`, `EndTime`,
  `end_date_time`
- energy: `Consumed Energy`, `ConsumedEnergy`, `Energy`,
  `chargedEnergyKwh`, `charged`, `total_energy`

Validated CDRs require explicit start and end values and reject invalid
chronology. Date-time values must be ISO8601 with an explicit timezone offset
(`Z` or `+/-HH:MM`). Hubject Excel serial dates are rejected because the
workbook contains no timezone policy; callers must provide an offset-aware
timestamp. Date components are checked before parsing, so invalid calendar
dates such as 31 February are rejected instead of being normalised by the
JavaScript date parser. Direct legacy calls to `normaliseSession` retain the
historical missing-start (current time) and missing-end (start time) fallbacks
for compatibility, but an explicitly malformed end is rejected. The financial
entrypoint must call `validateAndNormaliseCdr` so those fallbacks cannot award
an incomplete CDR.

Energy parsing is strict. Finite numeric values and the documented Hubject
thousands convention `11.040.483` are accepted. Trailing text, `NaN`,
infinities, and decimal commas are rejected. Proper JSON energy fields must
already be expressed in kWh; the normaliser does not globally divide numeric
energy by 1000. The updated worksheet stores `total_energy=15342`, but the
user-confirmed interpretation of that workbook example is 15 kWh. The
workbook-derived fixtures therefore supply JSON `total_energy: 15` (or `-15`
for `DISCHARGE`); no exact `15.342` value is inferred. This workbook-specific
interpretation does not establish a general JSON scaling convention. A
separate numeric `Energy: 15342` regression remains face-value to preserve the
existing API field semantics. The normaliser does not derive energy from
`TIME` dimensions or from `charging_dimension_volume`/`total_time`.

Negative energy means `DISCHARGE` and is converted to an absolute kWh amount
for reward calculation. Positive energy means `CHARGE` unless a documented
explicit `DISCHARGE` direction is supplied. An explicit `CHARGE` alongside
negative energy is rejected as contradictory. Existing award flooring and
positive CHARGE/DISCHARGE reward conventions remain in the award rules.

## Unsupported CDR kinds

OCPI credit CDRs (`credit: true`) and any populated
`credit_reference_id`/correction reference are rejected with a validation
error. The award path does not create correction or credit token movements.
The same rejection is applied to direct normaliser callers so a bypass of the
HTTP validation boundary cannot award a correction CDR.

The supplied workbook is evidence of partner field spellings and export
formats. It does not establish a safe unit conversion, an energy interval, a
timezone, or export proof. In particular, a TIME dimension is not treated as
energy and a compact numeric `total_energy` is not silently rescaled.

## Reservation integration

The API prefers `normalised.reservationSessionId ?? normalised.sessionId`
for reservation matching, while retaining `normalised.sessionId` for award
deduplication and response compatibility. The frontend reservation must use
the same eMAID, provider and actual session identifier as the final CDR.
The award's saved financial intent is validated before reservation settlement;
a duplicate CDR can recover an incomplete settlement or receipt without
another award. See the [API contract](../API.md) and [local release
verification](RELEASE_VERIFICATION_2026-10-01.md) for the recorded compatibility
checks and remaining OCPI replacement-CDR limitation.
