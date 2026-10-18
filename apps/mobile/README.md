# RideAgent Mobile

Phase 4 chat-first Expo app for the RideAgent demo. The app is intentionally dependency-light and uses React Native primitives for the interface.

## Run

From `apps/mobile`:

```bash
npm install
npm start
```

Use the Expo CLI prompts to open iOS, Android, or a development build. For a browser preview:

```bash
npm run web
```

The app calls `http://localhost:3000` by default and sends `X-Demo-User: demo-user` on every API request. To point the app at another API:

```bash
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:3000 npm start
```

If the API cannot be reached, the app keeps the failed request visible and switches to clearly labeled deterministic Demo mode so the complete interaction can still be previewed.

## API surface

- `GET /v1/rules` and `PUT /v1/rules`
- `POST /v1/chat`
- `GET /v1/rides/:id` and `GET /v1/rides/:id/events`
- `POST /v1/rides/:id/cancel`
