# Deterministic off-peak calculation

Off-peak charging eligibility uses the session start instant and the charging
country's IANA timezone. It does not use the server's local timezone. The
configured pilot defaults are:

| EVSE country | IANA timezone | Assumption |
| --- | --- | --- |
| `DE` | `Europe/Berlin` | Germany |
| `ES` | `Europe/Madrid` | mainland Spain |
| `RO` | `Europe/Bucharest` | Romania |

The existing country windows, token rates, flooring, and positive
`CHARGE`/`DISCHARGE` conventions are unchanged. A charging session is
eligible when its start instant falls inside the configured window. The rest
of the session is not prorated and does not change the result if it crosses a
window boundary. V2G discharge eligibility remains independent of off-peak
windows and uses the existing whole-token calculation.

## Timezone enrichment

CDR input may carry an additive NEVERFLAT enrichment named `timeZone`.
`custom_data.time_zone` is accepted as the preferred nested form, and
`cdr_location.time_zone` is tolerated for flattened location exports. These
are compatibility enrichments, not new OCPI standard fields. The precedence is
top-level `timeZone`, then `custom_data.time_zone`, then
`cdr_location.time_zone`.

Every populated override must be a valid IANA identifier with no surrounding
whitespace. Invalid values and contradictory populated overrides are rejected
by normalisation before an award can be transferred. A valid override is
canonicalised and retained on `NormalisedSession.timeZone` together with its
source. Without an override, the pilot country default is used.

Countries without configured off-peak windows remain charging-ineligible. If
an administrator adds windows for a country without a known default timezone,
charging calculation fails clearly until the CDR supplies an explicit
`timeZone`; the host timezone is never used. A discharge CDR for such a
country can still receive the V2G award because that award is not tied to a
local off-peak window.

## Calculation context contract

`getAwardCalculationContext(session, rules?)` in
`src/config/awardRules.ts` exposes the deterministic evidence needed by the
executor for a new operation:

- `countryCode`: country derived from the EVSE ID.
- `timeZone` and `timeZoneSource`: the selected IANA zone and either the CDR
  override source, `country_default`, or `unconfigured`.
- `localStartTime`: the selected-zone start wall time as
  `YYYY-MM-DDTHH:mm:ss`, or `null` when no timezone is needed or available.
- `eligibilityBasis`: `session_start` for charging and `discharge` for V2G.
- `isOffPeak` and `awardType`: the result of the current runtime rules.
- `configurationSnapshot`: stable JSON containing the relevant rule rates,
  enabled flags, country windows, country, and selected timezone.
- `configurationFingerprint`: SHA-256 of that stable snapshot.

The executor persists this context with newly created operation evidence.
Existing saved operations retain their original amount and metadata when rules
or timezone configuration later change; replay must continue using the saved
decision.

Changing from host-local time to the documented country zones can change an
award near a window boundary. That is an intentional behavioural/API
compatibility change for newly calculated awards and should be called out by
the API integration owner.
