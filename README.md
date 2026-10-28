# DesignWear API

Accounts, carts, orders, community designs, search and AI for the DesignWear app.
Plain Node (20+), no dependencies.

```sh
cp .env.example .env     # then export the variables, or set them in your host
node src/index.js        # http://127.0.0.1:8787
node --test              # 15 tests
```

Point the app at it with `DESIGNWEAR_API_URL` in the app's `.env`.

## What it does
| Area | Routes |
|---|---|
| Auth | `POST /v1/auth/register`, `/login`, `/password-reset/request`, `/password-reset/confirm`; `GET/PATCH /v1/me`; `POST /v1/me/password` |
| Cart & orders | `GET/PUT /v1/cart`; `POST/GET /v1/orders`; `POST /v1/orders/:id/cancel` |
| Payments | `POST /v1/payments/razorpay/order`, `/verify` (needs Razorpay keys) |
| Community | `POST/GET /v1/designs` (stores the Design Studio's own design JSON plus PNG previews), `GET/DELETE /v1/designs/:id`, `POST /v1/designs/:id/like` |
| Search | `GET /v1/search?q=&inStock=1` |
| AI | `POST /v1/ai/design-agent` (the one chat bot: the Design Studio assistant, which edits the design from what the user asks), `POST /v1/ai/design-image` (Gemini 4 Argon for text, an image model for graphics), `POST /v1/ai/try-on` (a catalog product or the customer's own design image) |
| Google sign-in | `POST /v1/auth/google` (trades a Firebase ID token for a session; needs `FIREBASE_PROJECT_ID`) |
| Challenges | `GET /v1/challenges/current`, `GET /v1/challenges/:id/entries`, `PUT /v1/admin/challenges/:id` (needs `DESIGNWEAR_ADMIN_TOKEN`) |
| Meta | `GET /v1/health`, `GET /v1/config` |

## Security model
- Passwords: scrypt with a per-user salt. Sessions: HS256 JWT (7 days) tied to a per-user
  version, so a password reset or change signs out every session.
- Orders are **priced on the server** from the catalog (or the design price table); prices
  sent by a client are ignored. Stock and sizes are checked.
- Users can only read, cancel or edit their own orders, carts and designs.
- Rate limits on sign-up, sign-in, reset, orders, designs, chat and try-on. Login and reset
  answers don't reveal whether an email has an account.
- Strict CORS allow-list, `no-store`, `nosniff`, 1 MB body limit (9 MB for try-on photos).
- Production refuses to start without a strong `DESIGNWEAR_JWT_SECRET`, `ALLOWED_ORIGINS`
  and `MAIL_WEBHOOK_URL`.
- The AI model keys and Razorpay secret never leave this server. Try-on only fetches the
  catalog's own product image URL, never one supplied by a client.

## Limits
- State is one JSON file and in-memory rate limits, so run **one process**. Swap `src/store.js`
  for a database to scale out.
- Online payments are implemented here but the app does not call them yet (cash on delivery only).
- Orders are not yet mirrored into the SethuCMS `orders` collection.
- Not tested against live Gemini, Razorpay or SethuCMS (only against stand-ins).

## Google sign-in
The app signs in with Firebase Auth (Google provider), then sends the Firebase **ID token**
here. The server checks it itself (RS256 signature against Google's published keys, issuer,
audience = your project id, expiry, `google.com` provider, verified email) and issues its own
session. An existing password account with the same verified email is linked; a different Google
account can't take that email over. Google-only accounts have no password until they use password reset.

## Weekly challenges
```sh
curl -X PUT "$API/v1/admin/challenges/monsoon" \
  -H "authorization: Bearer $DESIGNWEAR_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Monsoon","description":"Remix a rain-ready tee","startsAt":"2026-10-26T00:00:00Z","endsAt":"2026-11-01T00:00:00Z"}'
```
The app's Home banner shows the open challenge (latest start) with its real entry count and time
left. Designs published from the challenge page become entries, ranked by likes.

## Hosting

This is a long-running Node server that keeps its data (accounts, orders, designs) in one
file and its rate limits in memory. That means: **one always-on machine with a persistent
disk.** It is *not* a fit for serverless hosts such as Vercel Functions (no persistent
disk, many short-lived instances). Good fits: Fly.io, Railway, Render (with a disk), or
any VPS running Docker. To run several machines later, replace `src/store.js` with a
database first.

### Fly.io (config included: `fly.toml`)
```sh
fly launch --no-deploy --copy-config          # first time: creates the app, keeps fly.toml
fly volume create designwear_data --size 1 --region sin
fly secrets set \
  DESIGNWEAR_JWT_SECRET="$(openssl rand -base64 48)" \
  ALLOWED_ORIGINS="https://your-web-app.vercel.app" \
  MAIL_WEBHOOK_URL="https://your-mail-service/hook" \
  SETHUCMS_URL=... SETHUCMS_CONNECTION_ID=... SETHUCMS_TOKEN=... \
  FIREBASE_PROJECT_ID=... GEMINI_API_KEY=... \
  DESIGNWEAR_ADMIN_TOKEN="$(openssl rand -base64 32)"
fly deploy --ha=false                          # --ha=false keeps it to one machine
```
Your API address is then `https://designwear-api.fly.dev`. Put it in the app's
`DESIGNWEAR_API_URL`. Production refuses to start unless `DESIGNWEAR_JWT_SECRET`,
`ALLOWED_ORIGINS` and `MAIL_WEBHOOK_URL` are set.

`MAIL_WEBHOOK_URL` receives `POST {to, subject, text}` for password-reset codes; point it at
any small mail relay you control (Resend, Postmark, SES behind a tiny function).

### Back up the disk
All state is `/data/store.json`: `fly ssh sftp get /data/store.json` (or `fly volumes snapshots`).
