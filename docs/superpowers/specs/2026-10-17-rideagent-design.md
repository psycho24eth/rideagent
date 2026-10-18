# Lexar AI Design Specification

**Date:** 2026-10-17
**Status:** Approved design; chat-first revision approved
**Market:** Delhi, India first; country/provider adapters remain extensible
**Demo identity:** `demo-user`; production authentication is intentionally out of scope for the first slice

## 1. User-visible outcome

A user can open Lexar AI and talk to it like a personal assistant. The user can state a goal such as “I need to get to the airport by 10:30,” and Lexar AI researches the pickup, destination, timing, available providers, and the user's saved rules. It explains the recommendation and asks “Want me to proceed with the cab booking?” by default. After confirmation, it books the selected option, posts progress updates in the conversation, tracks the ride, handles routine failures, and exposes live controls. An explicit optional Rules setting can enable auto-booking within the user's rules. The system must never claim that a deep-link fallback is booked until the user completes the required provider handoff.

The first market-specific provider is an ONDC/Beckn mobility adapter for the sandbox/staging environment. Uber, Ola, Rapido, and Bolt are represented initially through a safe deep-link fallback interface rather than undocumented automation.

## 2. Repository and runtime shape

The repository is an npm-workspaces monorepo:

```text
apps/
  mobile/       Expo React Native TypeScript app
  api/          Fastify TypeScript API, planner, workers, Prisma integration
packages/
  shared/       domain types, Zod schemas, ride state machine, shared utilities
  providers/    RideProvider interface, region router, Mock/ONDC/deep-link adapters
tests/          cross-package integration tests where useful
docker-compose.yml
.env.example
README.md
ADD_A_PROVIDER.md
```

The initial development path is local Node.js plus in-memory test doubles. Postgres and Redis are first-class runtime dependencies and are supplied by Docker Compose for the API deployment shape. The API remains testable without external credentials.

## 3. Domain contracts

`packages/shared` owns the contracts that mobile, API, workers, and adapters consume:

- Coordinates and normalized locations with latitude, longitude, address, city, and country.
- Vehicle types: `bike`, `auto`, `cab`, and extensible provider-specific metadata.
- User rules: per-ride cap, daily cap, preferred providers, vehicle preference, and speed-versus-cost preference.
- Quotes with provider, price, currency, ETA, vehicle type, validity, and optional deep-link action.
- Rides with provider reference, quote snapshot, driver/vehicle details, OTP, ETA, and current status.
- An append-only event model for every state transition, agent decision, and tool invocation.

The ride state machine is pure and explicit:

```text
REQUESTED -> QUOTED -> BOOKED -> DRIVER_ASSIGNED -> ARRIVING
           -> ARRIVED -> IN_TRIP -> COMPLETED

Any active state may transition to CANCELLED or FAILED when the reason is valid.
```

Invalid transitions throw a typed domain error. Each valid transition returns an event payload with the previous state, next state, actor, timestamp, and reason. Terminal states cannot transition again.

## 4. Provider abstraction and region routing

The provider package exposes a country-neutral `RideProvider` interface:

```ts
interface RideProvider {
  getQuote(input: QuoteRequest): Promise<RideQuote[]>;
  book(quote: RideQuote): Promise<BookedRide>;
  track(rideId: string): Promise<ProviderRideStatus>;
  cancel(rideId: string): Promise<void>;
  capabilities(): ProviderCapabilities;
}
```

Implementations:

1. `MockProvider`: deterministic quotes and controllable lifecycle for tests and demo.
2. `BecknOndcProvider`: maps search, select, init, confirm, status, track, and cancel to ONDC/Beckn staging; correlates callback message IDs and transaction IDs; never logs secrets.
3. `DeepLinkProvider`: produces a provider handoff link with prefilled pickup/drop data. It returns a human-action-required result and cannot transition directly to `BOOKED`.

The region router accepts GPS coordinates, resolves a normalized country/city, and returns only providers registered for that region. Adding a country means adding region metadata and provider registrations, not changing the planner or mobile flow.

## 5. API, planner, and policy enforcement

The API provides health, rules, quote, book, ride read, cancel, event stream, and trusted-contact endpoints. Demo requests carry `X-Demo-User: demo-user`; the boundary is isolated so a later auth middleware can replace it.

The planner is a bounded Claude tool-use loop. Its tools are `get_location`, `geocode`, `get_quotes`, `book_ride`, `track_ride`, `cancel_ride`, `notify_user`, and `ask_user`. Tool arguments and tool outputs are validated with Zod before reaching application services. The model is selected from an environment variable; no model name is hard-coded into business rules. The planner is conversational: it explains material decisions, asks one focused question when information or approval is missing, and resumes from the user's answer. It must not ask for confirmation when the user has explicitly enabled auto-booking and every hard rule passes.

The planner may recommend, retry, rebook, or ask the user, but the backend owns the hard rules:

- Rules must exist before any booking attempt.
- The default booking mode is `ask_before_booking`; an explicit `auto_book_within_rules` mode is available in Settings.
- In `ask_before_booking`, the planner may research and recommend but must wait for a positive user confirmation before calling `book_ride`.
- The quote price must be at or below the per-ride cap.
- The resulting daily spend must remain at or below the daily cap.
- Any price jump is revalidated immediately before booking.
- No provider is allowed to be selected outside the resolved region.
- CAPTCHA, bot detection, OTP, and payment approval pause for human action.
- Active rides always expose cancellation and trusted-contact sharing.

## 6. Persistence and background work

Prisma models cover users, rules, rides, quotes, ride events, agent decisions, tool-call logs, trusted contacts, and provider-operation correlation records. Payment card numbers are never modeled or stored. Provider tokens and credentials are encrypted at rest and kept out of logs.

Redis/BullMQ owns durable jobs for tracking, provider timeout recovery, notification delivery, and retry/rebooking. A worker polls or subscribes to provider status and emits normalized events. The API exposes SSE for live app updates and a notification adapter for Expo/FCM push.

## 7. Mobile screens

The Expo app is chat-first and implements four navigation surfaces:

- **Chat:** the primary surface, with user messages, agent progress updates, recommendation cards, confirmation questions, exception questions, voice input, and embedded active-ride cards.
- **Active ride:** route map, ride state, driver/vehicle, OTP, ETA, always-visible cancel, and share trip.
- **Rules:** per-ride cap, daily cap, provider preferences, saved Home/Work places, trusted contact, and booking mode.
- **Activity:** agent decisions, tool calls summarized for the user, provider attempts, state transitions, and prior rides.

The preview shown during design review is the target composition. It is a native mockup rather than the running app. After the mobile slice, the actual Expo app will be started with the mock API so the live flow can be reviewed in a browser/device preview.

## 8. Testing strategy

Step 1 tests cover state-machine legality, terminal-state behavior, provider contract behavior, and deterministic MockProvider output. Later slices add:

- spend-cap and daily-cap boundary tests,
- region-router availability tests,
- API validation tests,
- planner tool-loop tests with a fake Claude client,
- tracking/notification tests,
- an end-to-end mock booking test from quote through completion or cancellation,
- adapter mapping tests for ONDC/Beckn request and callback envelopes.

Checks are run after each build step. A check is reported as passed only after the exact command is run successfully.

## 9. Scope boundaries

Authentication, real payment processing, undocumented provider automation, CAPTCHA bypass, production ONDC credentials, and real-world driver dispatch guarantees are not part of the demo-first slice. These boundaries are deliberate: they keep the core flow testable and compliant while leaving clear integration seams for production hardening.
