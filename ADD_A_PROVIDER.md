# Add a country or provider adapter

RideAgent providers implement the shared `RideProvider` contract in `packages/providers/src/types.ts`. A provider is a capability boundary, not a place for planner logic or payment automation. Keep the planner and mobile flow country-neutral.

## 1. Define the adapter and configuration

1. Add `packages/providers/src/<provider>-provider.ts`.
2. Implement `RideProvider` with a stable `name`, `capabilities()`, `getQuotes()`, `book()`, `track()`, and `cancel()`.
3. Put endpoint URLs, subscriber identifiers, and other credentials in environment/config input. Do not hard-code secrets, tokens, signing keys, or card data.
4. Use an injected transport for network calls. The adapter must remain deterministic and testable without a live provider; the existing Beckn/ONDC adapter uses `BecknTransport` for this seam.

Normalize every response into the shared shapes: `Quote`, `BookedRide`, and `ProviderRideStatus`. Validate amounts, currency, vehicle type, timestamps, and status before returning them to the API.

## 2. Declare truthful capabilities

Return `ProviderCapabilities` that describe what the adapter can actually do:

```ts
{
  quoting: true,
  booking: true,
  tracking: true,
  cancellation: true,
  supportedVehicleTypes: ["bike", "auto", "cab"],
}
```

Do not advertise an operation that still requires a human or an undocumented client flow. The API uses these flags when selecting a provider and deciding whether tracking/cancellation are available.

## 3. Register the region

Register the adapter with an explicit normalized country and city. The region router only returns providers registered for the resolved pickup region:

```ts
const provider = new MyCountryProvider(config);
const registry = new RegionRouter([
  { country: "India", city: "Delhi", provider },
]);
```

For a new country:

1. Add the country/city registration at the composition boundary (or extend the default registry when the adapter is ready for the demo).
2. Add aliases only when the region resolver needs them; keep canonical country and city values stable.
3. Confirm an unregistered country or city returns no provider rather than falling back to a global provider.
4. Keep provider registration separate from planner code so another country does not require a planner or mobile rewrite.

## 4. Handle deep links and human action safely

For a provider that cannot complete booking through an approved API:

1. Set `capabilities().booking` to `false` (and set tracking/cancellation to `false` unless they are genuinely supported).
2. Return a quote with an HTTPS `deepLink` and `humanActionRequired: true` in the adapter's normalized representation.
3. Make `book()` throw `HumanActionRequiredProviderError` with the link. Never fabricate `BookedRide`, provider ride ids, driver details, or a `BOOKED` state.
4. The assistant must say that the user needs to continue in the provider app/site. CAPTCHA, bot checks, OTP entry, and payment approval stay in the human/provider flow.
5. Only a later provider-confirmed operation may transition the ride to `booked`.

## 5. Preserve provider correlation data

For ONDC/Beckn-style adapters, record the operation and validate the callback context:

- Keep the operation (`search`, `select`, `init`, `confirm`, `status`, `track`, or `cancel`) tied to the RideAgent user, ride/quote when known, and provider id.
- Generate and persist the `transaction_id` and request `message_id`; record response/callback ids when returned.
- Reject a callback whose transaction or message correlation does not match the request.
- Store redacted request/response snapshots and metadata only. Never store bearer tokens, signing secrets, or payment data in snapshots or logs.

## 6. Add tests before registration

Add tests beside the adapter and run them before wiring the provider into a default registry:

1. **Contract tests:** deterministic quote mapping, supported vehicles, currency/amount normalization, expiry, and required identifiers.
2. **Booking tests:** successful booking returns a provider id and normalized status; repeated calls are idempotent when the provider supports idempotency.
3. **Failure tests:** timeout, malformed payload, unavailable capability, rejected booking, and provider error mapping.
4. **Tracking/cancellation tests:** every returned status is a legal shared `RideStatus`; unsupported operations fail explicitly.
5. **Correlation tests:** mismatched Beckn/ONDC transaction or message ids are rejected; injected transports receive the expected operation/context.
6. **Region tests:** the adapter is returned only for registered country/city combinations.
7. **Human-action tests:** a deep-link adapter returns a handoff response and never changes a quoted ride to `booked`.
8. **API integration tests:** user isolation, saved-rule caps, confirmation gating, and provider selection are still enforced when the registry contains the new adapter.

Run the focused checks:

```bash
npm run test --workspace=@rideagent/providers
npm run typecheck --workspace=@rideagent/providers
npm run test --workspace=@rideagent/api
npm run typecheck --workspace=@rideagent/api
```

## 7. Safety checklist

- [ ] No undocumented provider automation, CAPTCHA bypass, OTP interception, or payment approval automation.
- [ ] No card-number fields, payment credentials, provider tokens, or signing secrets in code, fixtures, JSON snapshots, or logs.
- [ ] Credentials come from local environment/injected configuration and are redacted from errors and test output.
- [ ] Provider payloads are treated as untrusted and validated before state changes.
- [ ] Booking is blocked unless the backend rules pass and the user's required confirmation has been received (unless explicit auto-booking rules apply).
- [ ] Per-ride and daily caps are rechecked immediately before booking.
- [ ] Provider is selected only from the resolved region registry.
- [ ] Every ride read, event, decision, tool log, and provider operation carries the owning user id for later tenancy enforcement.
- [ ] Human-action fallbacks are clearly labeled and never represented as completed bookings.
- [ ] Tests use deterministic mocks or sandbox credentials. Do not claim production or live ONDC booking verification from local tests.

After the checks pass, register the adapter in the smallest composition boundary that needs it and update the phase status/docs. Keep persistence adapter changes separate from the provider change.
