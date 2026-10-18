# RideAgent

RideAgent is a chat-first ride assistant demo. It compares registered providers, applies saved ride rules, asks for confirmation by default, and exposes a tracked ride flow. The first market is Delhi, India; the provider seams are country-neutral.

## Build status

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Shared contracts, Zod schemas, and ride state machine | Complete |
| 2 | Fastify API, planner seam, quote selection, booking safety rules | Complete |
| 3 | Tracking, normalized events, notifications, SSE snapshot, cancellation | Complete |
| 4 | Chat-first Expo mobile preview with Rules and Activity surfaces | Complete |
| 5 | Region router plus Mock, DeepLink, and injected Beckn/ONDC adapter seams | Complete for demo/sandbox seams; no live booking claim |
| 6 | Prisma schema, Docker Compose, environment reference, and contributor docs | Scaffolded in this change; database/cache adapters remain a later hardening pass |

**Persistence status:** the current API uses `InMemoryStore`. The Prisma schema and Redis service describe the target runtime, but Prisma and Redis adapters are not wired into the API yet. Until that later hardening pass, restarting the API clears rules, rides, and activity.

## Requirements

- Node.js 20+ and npm 10+
- Docker Desktop with Compose, only if you want the containerized local shape
- An Expo-compatible device/emulator or a browser for the mobile preview

## Local setup

From the repository root:

```bash
npm install
cp .env.example .env
```

In PowerShell, use `Copy-Item .env.example .env` for the second command.

The API's current demo path does not require Postgres, Redis, Anthropic, or ONDC credentials. Direct Node runs use the shell environment; the `.env` file is also the Compose input file and a documented set of local values.

Start the API:

```bash
npm run start --workspace=@rideagent/api
```

Check it:

```bash
curl http://localhost:3000/health
```

## Docker Compose

Compose supplies API, Postgres, and Redis with health checks. Postgres and Redis use named volumes. This phase intentionally does not add an application Dockerfile; the API service uses a Node image, bind-mounts the workspace, installs the lockfile dependencies, and starts the existing API entry point.

```bash
docker compose up -d postgres redis api
docker compose logs -f api
```

Stop the stack while keeping data:

```bash
docker compose down
```

Remove the local database/cache volumes as well:

```bash
docker compose down -v
```

The Compose Postgres URL is assembled for the `postgres` service and is separate from the host-oriented `DATABASE_URL` in `.env.example`. No production secrets or deployment configuration are included.

## Checks

Run the existing checks from the repository root:

```bash
npm test
npm run test:step1
npm run test --workspace=@rideagent/api
npm run typecheck
npm run typecheck --workspace=@rideagent/api
npm run typecheck --workspace=@rideagent/mobile
```

The Prisma schema is a starting migration source. When the Prisma client and persistence adapter are added, validate and create the first migration with:

```bash
npx prisma validate --schema=prisma/schema.prisma
npx prisma migrate dev --schema=prisma/schema.prisma --name init
```

Those commands are not part of the current API startup path, and no migration has been generated or applied by this phase.

## Local demo flow

1. Start the API and confirm `/health` returns `{"status":"ok"}`.
2. Start the mobile preview. A fresh API store has no rules; the app seeds its safe default rules through `PUT /v1/rules`.
3. Ask RideAgent, for example: `I need a ride to the airport`.
4. With the default `ask_before_booking` mode, inspect the recommendation and press **Confirm booking**. The API will not call a provider's booking operation before positive confirmation.
5. In the active ride card, refresh tracking, share the trip, or cancel it. The Activity surface shows decisions and ride events.
6. To exercise the human-handoff boundary, register only a `DeepLinkProvider` in an API test or injected registry. It returns a link and a `human_action_required` response; it is never reported as booked until a provider confirms a booking through an allowed adapter.

All demo API requests are isolated by the `X-Demo-User` header, which defaults to `demo-user`. This is a demo boundary, not production authentication.

## API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness check |
| GET | `/v1/rules` | Read the current demo user's rules |
| PUT | `/v1/rules` | Save booking mode, caps, preferences, and preferred providers |
| POST | `/v1/chat` | Request a quote, confirm/reject a recommendation, or ask a follow-up |
| GET | `/v1/rides/:id` | Read an ownership-protected ride |
| GET | `/v1/rides/:id/events` | Read normalized ride, agent, and tool events |
| GET | `/v1/rides/:id/track` | Ask the registered provider for a status update |
| GET | `/v1/rides/:id/stream` | Return a closing SSE snapshot for the current ride |
| POST | `/v1/rides/:id/cancel` | Cancel an active ride, subject to provider capability |

The mobile app sends `X-Demo-User: demo-user` automatically. An API client can send another stable user id to exercise isolation in tests.

## Provider and safety boundaries

- The backend owns hard rules: rules must exist, the per-ride cap and daily cap must pass, the provider must be registered for the resolved region, and any price change must be revalidated before booking.
- The default mode is `ask_before_booking`. Auto-booking is opt-in through `auto_book_within_rules` and still cannot bypass caps or provider capability checks.
- `DeepLinkProvider` is a human-action fallback. A link is not a booking receipt; CAPTCHA, bot detection, OTP, and payment approval remain with the human/provider flow.
- `BecknOndcProvider` uses an injected `BecknTransport` and sandbox configuration. It has no default network transport, and this repository does not verify live ONDC discovery, dispatch, or booking.
- No card-number fields are modeled or accepted. Provider credentials/tokens belong in an encrypted integration layer and must never be placed in logs, snapshots, or tool arguments.
- Callback/request correlation must be checked before accepting provider state. Provider payloads are untrusted input and must be normalized and validated.
- The current `X-Demo-User` boundary is not authentication, authorization, rate-limit policy, or production tenancy isolation.

See [ADD_A_PROVIDER.md](ADD_A_PROVIDER.md) before adding an adapter or region.

## Mobile preview

From the repository root:

```bash
npm run web --workspace=@rideagent/mobile
npm run start --workspace=@rideagent/mobile
```

Use Expo's prompts for iOS or Android. To point a device at a LAN API, set the public API URL before starting Expo (use the equivalent environment syntax for your shell):

```bash
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:3000 npm run web --workspace=@rideagent/mobile
```

The app falls back to clearly labeled deterministic Demo mode when the API is unreachable, so the preview can still be reviewed without credentials.
