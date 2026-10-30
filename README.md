# DesignWear API

Accounts, carts, orders, community designs, search and AI for the DesignWear app.
Plain Node (20+), no dependencies.

```sh
cp .env.example .env     # private settings, git-ignored; the server loads it itself
npm start                # http://127.0.0.1:8787  (node --env-file-if-exists=.env src/index.js)
node --test              # 29 tests
```

Point the app at it with `DESIGNWEAR_API_URL` in the app's `.env`. The app repository's
`./run.sh` starts this server for you when that address is `http://localhost:<port>`.

Documentation for the whole project (architecture, configuration, API, deployment, CI/CD,
troubleshooting) is in the app repository's `docs/` folder.

## What it does
| Area | Routes |
|---|---|
| Catalog | `GET /v1/products`, `/v1/products/:id` (originals that can be sold; remixes and unpriced items are hidden), `GET /v1/search?q=&inStock=1` |
| Product photos | `GET /v1/img/:host/:project/:dataset/:file` (allow-listed image CDN only; `?w=`, `?q=`, `?auto=format`). Browsers are blocked by the CDN's own CORS list, so web loads photos through here |
| Auth | `POST /v1/auth/register`, `/login`, `/password-reset/request`, `/password-reset/confirm`; `GET/PATCH /v1/me`; `POST /v1/me/password`; `GET/PUT /v1/me/addresses` |
| Google sign-in | `POST /v1/auth/google` (trades a Firebase ID token for a session; needs `FIREBASE_PROJECT_ID`) |
| Cart & orders | `GET/PUT /v1/cart`; `POST/GET /v1/orders`; `POST /v1/orders/:id/cancel` |
| Payments | `POST /v1/payments/razorpay/order`, `/verify` (needs Razorpay keys; the app offers cash on delivery today) |
| Community | `POST/GET /v1/designs` (the Design Studio's own design JSON plus PNG previews), `GET/DELETE /v1/designs/:id`, `POST /v1/designs/:id/like` |
| Challenges | `GET /v1/challenges/current`, `GET /v1/challenges/:id/entries`, `PUT /v1/admin/challenges/:id` (needs `DESIGNWEAR_ADMIN_TOKEN`) |
| AI | `POST /v1/ai/design-agent` (**the one chat bot**: the Design Studio assistant, which edits the design from what the user asks), `POST /v1/ai/design-image`, `POST /v1/ai/try-on` (a catalog product or the customer's own design image) |
| Diagnostics | `POST /v1/logs` (app warnings and errors, redacted), `GET /v1/health`, `GET /v1/config` |

There is no general-purpose chat route.

## Settings
Loaded from the environment, or from `.env` (`.env.example` lists them all):

| Setting | Notes |
|---|---|
| `PORT`, `HOST`, `NODE_ENV` | `NODE_ENV=production` enables the safety checks below |
| `DESIGNWEAR_JWT_SECRET`, `ALLOWED_ORIGINS` | **required in production** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (or `MAIL_WEBHOOK_URL`) | how email leaves the server; without either, no email is sent. `SUPPORT_EMAIL` is printed on receipts, `LOG_LEVEL` filters request logs |
| `SETHUCMS_URL`, `SETHUCMS_CONNECTION_ID`, `SETHUCMS_TOKEN` | the catalog source; use a read-only token |
| `FIREBASE_PROJECT_ID` | enables Google sign-in |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_IMAGE_MODEL` | the assistant, graphics, try-on |
| `DESIGNWEAR_ADMIN_TOKEN` | enables the challenge admin route |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | online payments |
| `IMAGE_HOSTS`, `DESIGNWEAR_DATA_FILE`, `DESIGNWEAR_CLIENT_LOG_FILE`, `TRUST_PROXY` | optional |

## Security model
- Passwords: scrypt with a per-user salt. Sessions: HS256 JWT (7 days) tied to a per-user
  version, so a password reset or change signs out every session.
- Orders are **priced on the server** from the catalog (or the design price table); prices
  sent by a client are ignored. Stock and sizes are checked.
- Users can only read, cancel or edit their own orders, carts and designs.
- Rate limits on sign-up, sign-in, reset, orders, designs, the assistant, graphics, try-on, photos and logs. Login and reset
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

## Orders in SethuCMS (dashboards and status updates)

Set `SETHUCMS_ORDERS_TOKEN` and each order is copied into a SethuCMS collection (`orders` by
default) when it is placed, paid or cancelled. The business then sees orders, dashboards and
can change an order's `status` (and `trackingId`, `carrier`) there; the customer's My orders
screen picks the change up. If SethuCMS is down the customer's order still goes through.

Create the collection with exactly these fields (SethuCMS refuses unknown ones):
`id` (text, key), `createdAt`, `updatedAt` (date and time), `status` (text: `awaiting_payment`,
`placed`, `confirmed`, `packed`, `shipped`, `delivered`, `cancelled`), `customerName`,
`customerEmail`, `customerPhone`, `address`, `city`, `state`, `pin`, `items` (long text),
`itemCount` (integer), `subtotal`, `tax`, `total` (decimal), `paymentMethod`, `paymentStatus`,
`teamId`, `teamName`, `trackingId`, `carrier`. Give the token write access to this collection
only. Delivered and cancelled orders are final: changes made to them in SethuCMS are ignored.

## Notifications

Every order step (placed, paid, confirmed, packed, shipped, delivered, cancelled) tells the
customer in three places: the in-app inbox (`GET /v1/notifications`, `POST /v1/notifications/read`),
an email (SMTP, or `MAIL_WEBHOOK_URL`), and their phones.

Placing an order emails a receipt (HTML and text, with items, GST, total, payment and address);
`POST /v1/orders/:id/receipt` sends it again. Every send is tried up to three times and recorded
in the `outbox` collection (masked address, status, attempts), and sensitive actions (order
created, payment verified, cancelled, status changed in SethuCMS) are written to `audit`.
`GET /v1/health/live` is a cheap ping; `GET /v1/health?deep=1` checks the database and returns 503
naming the failing part. Send `x-request-id` from the app and the same id appears in the logs.

- **Phones:** the app registers its Firebase token with `POST /v1/me/devices`. Set
  `FCM_SERVICE_ACCOUNT` (base64 of a service-account key for the Firebase project) to turn push on.
- **The moment the business changes an order:** create a SethuCMS webhook (`POST /v1/admin/webhooks`
  with `url` = `https://<api>/v1/hooks/sethucms`, `events` = `["record.updated"]`) and set its
  `whsec_` secret as `SETHUCMS_WEBHOOK_SECRET`. Deliveries are signature-checked. Without it the
  customer is notified the next time they open their orders.

## Hosting

Two ways to run it, from the same code:

- **Vercel (serverless).** Data lives in a Redis database reached over HTTPS, so any number
  of short-lived instances can share it. Set it up below.
- **One always-on machine** (Fly.io, a VPS, Docker). Data lives in one JSON file on a
  persistent disk. Used automatically when no Redis settings are present.

### Vercel

1. **Database, SethuCMS only:** in SethuCMS create a collection `dw_store` with text fields
   `id` (key), `coll` and `data` (long text), and a token with read-write access to it alone,
   then set `SETHUCMS_STORE_TOKEN`. Nothing else is needed. It is slower than Redis (every
   read is a call to SethuCMS) and lists read a whole collection, so it suits a small shop.
   Alternatively use Firebase's **Firestore** (you already have a Firebase project):
   in the Firebase console open *Build → Firestore Database → Create database* (production
   mode; the API reaches it with a service account, so no client rules are needed). Then
   *Project settings → Service accounts → Generate new private key*, and paste the whole
   JSON file as the `FIREBASE_SERVICE_ACCOUNT` environment variable. (Upstash Redis also
   works: set `KV_REST_API_URL` and `KV_REST_API_TOKEN` instead.)
2. **Settings.** Add the variables from `.env.example` in *Project → Settings → Environment
   Variables*: at least `NODE_ENV=production`, `DESIGNWEAR_JWT_SECRET`, `ALLOWED_ORIGINS`,
   `MAIL_WEBHOOK_URL`, `SETHUCMS_*`, and optionally Gemini, Razorpay, Firebase and admin keys.
3. **Deploy.** Import this repository as a project (framework "Other"), or run
   `npx vercel deploy --prod`. `vercel.json` sends every `/v1/*` request to `api/index.js`.
4. Point the app's `DESIGNWEAR_API_URL` at the project's address.

What changes on serverless, honestly:

- **Rate limits are per instance** (kept in memory), so they slow abuse but are not a hard
  global cap. Password hashing (scrypt) is the real guard against guessing.
- **Request bodies are capped at 4.5 MB by Vercel.** Try-on photos must be downscaled by
  the app below that.
- **Firestore's free plan** allows about 50k reads and 20k writes a day. Listing a collection
  reads every document in it, so the design feed will use that quickly; fix that before launch.
  A document is capped at 1 MiB, so a design with very large previews can be refused.
- **Collections are read whole** when listed (designs, orders). Fine for a small shop; move
  to indexed queries (or Postgres) if a collection grows into the thousands.
- **Client logs go to Vercel's log stream** only (no disk).
- Accounts are found through small index collections (`emails`, `uids`), never by scanning.

### Fly.io / any single machine (config included: `fly.toml`)
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
