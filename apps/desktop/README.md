# Lexar AI desktop preview

The browser-based desktop preview keeps the approved chat-only experience in one conversation. Rich route, traffic, quote, booking, and live-ride blocks are rendered inline; provider tool calls are intentionally not shown.

## Run locally

From this directory:

```bash
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). The preview reads `VITE_API_BASE_URL` and defaults to `/api`; the Vite dev server proxies that path to `http://127.0.0.1:3000`, while a deployed build can use a same-origin reverse proxy. To point at another same-origin or CORS-enabled API, create an `.env.local` file in this directory:

```bash
VITE_API_BASE_URL=http://localhost:3000
```

The client always sends `X-Demo-User: demo-user`. If the API cannot be reached, the preview switches to deterministic Demo mode and labels mock route, traffic, quote, and live telemetry data.

## Checks

```bash
npm run typecheck
npm run build
```

The desktop preview supports rules read/save, chat and confirmation, live ride polling, manual tracking refresh, cancellation, and trip sharing through the browser Share API or clipboard fallback.
