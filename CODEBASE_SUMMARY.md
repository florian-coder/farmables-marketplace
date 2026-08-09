# Farmables (local-farm) — codebase summary

Marketplace connecting Romanian small farms to local buyers. The platform is an
**intermediary, never the seller**: each farm sells directly to the customer, and
the platform takes a commission for the intermediation.

> Read this before scanning files. For open work see [`tasks.md`](./tasks.md).

## 1. Architecture

- **Two deployed apps in one repo**, no monorepo tooling — each has its own `package.json`.
  - `local-farmers-backendd` — Express API on **Render**
  - `local-farmers-frontendd` — React SPA (Vite) on **Vercel**
- **Supabase (Postgres) is the only datastore.** The backend talks to it with the
  **service role key**, and refuses to boot without it. **The browser has no
  database key at all** — `@supabase/supabase-js` is not a frontend dependency.
- **Auth is custom, not Supabase Auth.** Stateless HMAC-signed cookie (`lf_session`),
  minted in `src/lib/auth.js`. RLS policies therefore have no `auth.uid()` to
  check against, which is why every table is service-role-only.
- **Live updates are server-sent.** One Supabase Realtime subscription per
  backend process, fanned out to browsers over SSE (`src/lib/eventStream.js`).
  This is what let RLS go on `orders` and `messages`.
- **Payments: Stripe Connect Express, separate charges and transfers, with an
  escrow window.** One `PaymentIntent` on the platform account for the whole
  basket. Each farm's share is then **held** on the platform balance
  (`orders.transfer_state = 'held'`) and only transferred when the customer
  confirms the order arrived. If it never arrives, the money goes back to the
  customer instead. Refunds against a share already sent run the other way:
  **reverse the transfer first, then refund the card.**
- Request flow: `browser → apiFetch (credentials: include) → Express → Supabase`.
  Stripe calls the webhook directly.

## 2. Tech stack

| Layer | Choice |
|---|---|
| Backend | Node ≥18, Express 4, CommonJS (`require`) |
| Frontend | React 18, Vite 7, react-router-dom 6, ESM |
| DB | Supabase Postgres, `@supabase/supabase-js` v2 (**backend only**) |
| Payments | `stripe` v20, Connect **Express** accounts, API pinned `2024-06-20` |
| 2FA | `otplib` **v12** — v13 is ESM-only and Jest cannot require it |
| Email | Resend, through an outbox table with retry/backoff |
| Live updates | Server-Sent Events, `EventSource` in the browser |
| Tests | Jest + supertest (backend, 380), Vitest + Testing Library (frontend, 38) |
| Markdown | `react-markdown` + `remark-gfm`, **lazy-loaded** (legal pages only) |
| Styling | One hand-written `global.css`. No CSS framework, no CSS-in-JS. |

## 3. Directory map

```
local-farmers-backendd/
  src/app.js              route mounting, helmet/cors/CSRF/rate-limit, error handler
  src/server.js           entry point; starts the outbox, maintenance and event stream
  src/lib/
    config.js             ⚠ boot-time secret validation — THROWS if any is missing
    supabase.js           client + TABLES registry; THROWS without the service role key
    auth.js               password hash (scrypt), session sign/verify, revokeUserSessions
    adminAccounts.js      SEC-12 — per-admin identity, TOTP, backup codes
    money.js              ALL money math, integer bani, commission, refund split
    pricing.js            the one place basket prices are computed
    orderState.js         ⚠ the ONLY place an order transition is judged legal
    refunds.js            reversal → refund, full + partial, manual-recovery path
    transfers.js          escrow: hold on payment, release on confirmation
    fulfilment.js         OPS-06/LOG-04 — delivered vs ordered, and the tolerance
    availability.js       farm hours, holidays, daily capacity
    disputes.js           48h farmer window, auto-escalation, resolution
    moderation.js         chat filter (flags, never blocks) and blocking
    labelling.js          LEG-04 — mandatory food information per category
    seasonality.js        season windows (they wrap the year), pre-orders
    subscriptionRuns.js   builds recurring baskets as ordinary unpaid carts
    orderMaintenance.js   the hourly sweep: auto-confirm, escalate, expire, generate
    outbox.js             OPS-02 — enqueue never fails the caller; worker with backoff
    notifications.js      one function per domain event, each with its own event key
    eventStream.js        SEC-01 — Realtime → SSE fan-out
    privacy.js            LEG-03 — export, and what deletion does and does not erase
    traderDetails.js      LEG-07/OPS-05 — public identity vs private contact
    operator.js           who runs the site; footer + email footer
    stripeClient.js       one Stripe client; separate error→message maps for
                          payments and for Connect onboarding
    connect.js            Connect accounts, onboarding links, visibility gate,
                          recovery when a stored account id no longer resolves
    mailer.js             Resend, or console when RESEND_API_KEY is unset
    emailStatus.js        missing vs unverified vs verified, in one place
    platformSettings.js   commission_bps, min charge, weight tolerance; 60s cache
    legalDocuments.js     ⚠ authority on which legal version is in force
    legalAcceptance.js    writes consent records
    audit.js              recordAudit() — never throws; maskEmail()
    domain.js             DB row → API shape mappers, plus DEFAULT_MARKETS
    productRating.js      internal sales score (NOT a customer rating)
    farmerRanking.js      farmer-of-the-month scoring
    cacheStore.js         in-memory TTL cache (the path argument is only a key)
    productMedia.js       Pexels fallback image for a product with no photo
    external/             FAOSTAT, Pexels, SoilGrids, USDA — read-only, cached
    legacyCleanup.js      deletes the pre-Supabase JSON files on boot
    bootstrap.js          ⚠ DEAD. Creates the JSON files legacyCleanup deletes.
    dataPaths.js          ⚠ DEAD. Paths for the same files. See §7.
    fileStore.js          ⚠ DEAD. Reader/writer for the same files. See §7.
  src/emails/             layout.js + templates.js — 13 templates, HTML and text
  src/middleware/         auth, adminAuth (scoped sessions), csrf, rateLimit
  src/routes/             19 routers, mounted under /api/*
  sql/                    hand-run migrations; 01–16 are the current chain,
                          plus RUN_1/RUN_2 bundles and pre-audit leftovers
  tests/                  25 files, security/ + unit; helpers/fakeSupabase.js
                          is an in-memory DB, helpers/fakeStripe.js a fake Stripe

local-farmers-frontendd/
  src/App.jsx             nav + footer (operator identification) + all routes
  src/lib/api.js          apiFetch wrapper (cookies, X-Requested-With, timeout)
  src/lib/auth.jsx        AuthProvider / useAuth
  src/lib/liveUpdates.js  one shared EventSource per tab + fallback poll
  src/lib/operator.js     build-time operator identification (mirrors the backend)
  src/lib/legal.js        loads .md via ?raw, parses frontmatter
  src/content/legal/      7 versioned legal documents + REVIEW-NOTES.md
  src/pages/              19 files, one per route
  src/components/         11 shared components incl. FoodLabel, ReportProblem,
                          FulfilmentForm, PrivacyCard, EmailStatusBanner,
                          PayoutSettingsCard, LabellingFields
  src/__tests__/          6 Vitest files, one per component or page under test
  src/main.jsx            entry; one-time purge of pre-SSE browser storage
  src/styles/global.css   everything — tokens at the top, then components
```

## 4. Data model

**Money is integer `bani` everywhere (1 RON = 100 bani). Never float.** Legacy
`numeric(12,2)` columns (`unit_price`, `line_total`, `total_price`) are the only
exception and are converted at the boundary by `leiToBani`.

### The payment hierarchy — read this before touching orders

```
checkouts          one card charge, one PaymentIntent, one transfer_group
  └─ orders        ONE ROW PER FARM per checkout  ←  this IS the "farmer group"
       └─ order_items
```

`orders.farmer_id` already made `orders` a per-farm row, so `checkouts` was added
*above* it rather than restructuring `orders`. A 3-farm basket = 1 checkout + 3
orders. Money frozen on each `orders` row at placement:
`products_subtotal_bani`, `delivery_fee_bani`, `commission_bps`,
`commission_bani`, `transfer_amount_bani`, `stripe_account_id`.

Written later, as the money moves: `refunded_transfer_bani` (given back to the
customer while still held), `payout_hold_started_at`, `payout_released_at`.

### Tables (`TABLES` registry in `src/lib/supabase.js`)

- **Identity**: `users` (+`token_version`, `email_verified`, `deleted_at`), `farmers`, `customers`, `permission`
- **Admin**: `admin_users`, `admin_backup_codes`
- **Catalog**: `products`, `farm_photos`, `farmer_requests`, `farmer_docs`, `organic_certificates`
- **Orders**: `checkouts`, `orders`, `order_items`, `order_replies`
- **Payments**: `order_transfers` (unique `order_id`), `refunds` (partial unique `order_id`), `platform_settings`
- **Chat & moderation**: `conversations`, `messages`, `message_reports`, `user_blocks`
- **Disputes**: `disputes`, `dispute_evidence`
- **Recurring**: `subscriptions`
- **Compliance**: `audit_log` (append-only, trigger-enforced), `legal_acceptances`, `stripe_events`, `auth_tokens`, `email_outbox`

### The escrow window — where the money is, at each state

```
placed_order            no money anywhere (this is the cart)
pending_order           card authorised, transfer_state = 'none'
received_by_farmer  ─┐
preparing_order      ├─ charged, transfer_state = 'held'
in_transit           │  the platform holds the farmer's share
arrived             ─┘  a cancellation here refunds 100% and costs nobody
received                transfer_state = 'sent' — the farmer has it
cancelled               refunded; the held share is 'reversed', never sent
```

`orders.refunded_transfer_bani` is the part of the farmer's share already
returned to the customer during the hold. The release pays
`transfer_amount_bani - refunded_transfer_bani`, so a partial refund is never
paid out twice. Two deadlines make sure nothing is held forever:
`AUTO_CONFIRM_DAYS` (7) closes a forgotten `arrived` order and pays the farm,
`PAYOUT_HOLD_EXPIRY_DAYS` (14) cancels and refunds an order that never arrived.

### Pricing formula (frozen per order)

```
displayed price   = farmer's price
commission        = 10% of products subtotal ONLY (never of delivery), half-up per farm group
delivery fee      = per farm, once per order, waived above free_delivery_threshold
customer pays     = products + commission + delivery
farmer receives   = products + delivery
```
Invariant `charged == transferred + commission` is asserted in `assertTotalsBalance`,
which **throws** rather than returning false.

**Refunds** split the same way: full = products + delivery + commission;
partial = missing products + proportional commission, delivery kept because
something was still driven to the door. The farmer only ever gives back
products + delivery — the commission is the platform's to forgo.

### State

- Frontend: local `useState` only. **No Redux/Zustand/Context beyond `AuthProvider`.**
- Server state is re-fetched, triggered by the SSE stream (topics: `orders`,
  `conversations`, `messages`, `products`) with a 45s fallback poll.
- Order states: `placed_order`(=cart) → `pending_order` → `received_by_farmer` → `preparing_order` → `in_transit` → `arrived` → `received`, plus `cancelled`.

## 5. Conventions

**Non-negotiable**
- **Fail fast on missing secrets.** `config.js` and `supabase.js` throw at boot.
  A process that runs insecurely — or that answers health checks while every
  query fails — is worse than one that will not start.
- **One state machine.** `lib/orderState.js` decides every transition, for every
  actor including `system` and `admin`. An invalid transition is **409**, not
  400; a state that does not exist is 400.
- **Idempotency** on: Stripe webhooks (`stripe_events`), transfers
  (`order_transfers.order_id`), refunds (`refunds`, partial unique), emails
  (`email_outbox.event_key`), `process_checkout`, `mark_checkout_paid`.
  The pattern is always the same: **the insert IS the claim.**
- **Integer bani.** Explicit half-up rounding, duplicated in SQL
  (`public.commission_bani`) and JS (`src/lib/money.js`) — change both together.
- **Every table has RLS enabled with NO policies** → service-role-only. The
  browser holds no database key, so this needs no `auth.uid()`.
- **A paid order is never deleted.** `cancelled` is a state, and cancelling
  restores stock and refunds in one flow (`cancelPaidOrder`).
- **A farmer is paid on confirmed receipt, never on payment.**
  `lib/transfers.releaseOrderPayout` is the only thing that moves money to a
  farm, and it refuses any order not in `received`.
- **Reversal before refund, always.** When a share was already sent, refunding
  first pushes the platform balance negative and Stripe starts declining other
  farmers' transfers. When it is still held, there is nothing to reverse —
  `withhold_farmer_share` records it and the release nets it out.
- **Notifications never fail the thing they describe.** Enqueue swallows its own
  errors; sending never happens inside a request or a transaction.
- **Payment/upload paths never return a bare 500.** User-actionable message +
  `requestId`, structured JSON log line.

**Style**
- Comments in **English** for new code; older files still have Romanian comments.
- **All user-facing text is English**, money formatted `12.34 RON`.
- Backend: CommonJS, `router.get(path, middleware, async (req,res,next))`, errors via `next(error)`.
- Supabase columns are quoted where they contain spaces/caps: `'"farm name"'`, `'"photo url"'`, `Price`, `Unit`.
- `orders.farmer_id` / `products.id` are **text vs bigint** — SQL casts with `id::text`.
- Comments explain *why*, not *what*. Load-bearing decisions get a paragraph.

**Migrations**
- Hand-pasted into the Supabase SQL Editor. **Nothing runs automatically.**
- Idempotent (`if not exists`, `drop policy if exists`), with backfill, destructive parts clearly marked.
- ⚠ **Most must run BEFORE deploying the backend.** Two exceptions, both about
  RLS, must run **after** both apps are deployed — see `tasks.md`.
- `15_escrow_payouts.sql` widens `orders.transfer_state` to accept `'held'`.
  Deploying the backend before it runs breaks the first paid order.
- `16_rls_all_tables.sql` supersedes the hand-written table list in `09` /
  `RUN_2`. It reads `pg_class` instead, because a list is right exactly once:
  migrations 10, 12 and 14 each added tables afterwards, and
  `customer_farmer_distances` was never in anybody's list at all.

**Testing**
- `tests/helpers/fakeSupabase.js` is an in-memory Supabase stub, including the
  unique and partial-unique indexes that idempotency depends on. `buildApp(seed, opts)`
  boots the real app against it, optionally with a fake Stripe and real JS
  implementations of the SQL functions (`tests/helpers/fakeRpc.js`).
- `tests/helpers/fakeRpc.js` reimplements the SQL functions in JS rather than
  stubbing them. A cancellation test that returned `{success:true}` would prove
  nothing about stock going back on the shelf.
- Security tests are named after the audit finding they cover (`SEC-05 — ...`).
- **Assert the effect, not the field.** The escrow suite checks that no Stripe
  transfer call exists before confirmation and exactly one exists after, not
  that a column says `'held'`. A test that reads back what the code just wrote
  is a tautology.
- Frontend tests mock `../lib/auth.jsx` and stub `fetch`; they render the real
  component and query by role or label, never by class name.

## 6. Gotchas

- A farmer without `charges_enabled` is **hidden everywhere**. So is one whose
  admin suspension has taken effect — that is a separate field, because Stripe
  overwrites `charges_enabled` on every `account.updated`.
- `/profile` renders `VendorPage` or `CustomerProfilePage` by role; `/vendor` redirects to it.
- Admin panel is at `/manage-portal`. The env credential **bootstraps one account
  once**, then must be disabled with `ADMIN_BOOTSTRAP_DISABLED=1` — the old
  password is in git history.
- `productRating.js` output is a **sales score**, not a customer review. It must never
  be displayed as a star or a mark (LEG-06).
- Legal doc versions live in **two places** and must be bumped together:
  `src/lib/legalDocuments.js` (backend, authoritative) and the `.md` frontmatter.
- Seasons **wrap the year**: 11 → 2 is November through February. `start <= m <= end`
  gets it exactly backwards.
- The chat filter **flags, it does not block**. A farmer and a customer
  arranging a delivery legitimately swap phone numbers.
- Email verification gates **paying**, not signing in. A legacy
  `@localfarmers.app` address is *missing*, not merely unverified.
- **Without `RESEND_API_KEY`, queued email is marked `sent`, not retried.**
  `outbox.js` treats `not_configured` as delivered so a development machine
  does not build a queue that never drains. Everything that happened while the
  key was missing is gone; adding the key later resends nothing.
- **"Set up payouts" needs the platform itself to be signed up for Connect.**
  Stripe's error names the farmer's account, which is misleading — only the
  operator can fix it, at dashboard.stripe.com/connect.
- **The platform's own Stripe payout schedule should be manual.** Escrow means
  the balance now holds customers' money for up to 14 days. An automatic daily
  sweep to the bank leaves nothing there when a release fires; the transfer
  fails with `balance_insufficient` and waits for the hourly retry.
- A **failed** transfer claim in `order_transfers` can be retaken; a `sent` one
  never can. Without that the unique key on `order_id` would make one Stripe
  failure permanent.


## 7. Known debt — real, and none of it blocking

Written down because each of these looks intentional from the outside.

- **Product images are resolved but never stored.** `products."photo url"`
  exists, but a product without an uploaded photo gets a Pexels image looked up
  by name at request time and cached only in `cacheStore`'s in-memory Map.
  A restart empties it, Pexels results drift, so **the same product can change
  its picture between restarts**, and every cold start re-queries the API.
  Fixing it means writing the URL back to the row — and dropping the `UNIQUE`
  constraint on that column, which will collide as soon as two products resolve
  to the same stock photo.
- **`bootstrap.js`, `dataPaths.js` and `fileStore.js` are the pre-Supabase file
  database.** `bootstrap.js` creates `data/users.json`, `products.json`,
  `sessions.json` and friends; `legacyCleanup.js`, which *is* wired into
  `app.js`, deletes exactly those files on every boot. Nothing calls
  `bootstrapData()` any more, so the contradiction is dormant. Delete all three,
  and the `data/` paragraph in the README with them — the folder is gone.
- **`DEFAULT_MARKETS` is a hardcoded array in `lib/domain.js`.** One market,
  "Central Market", Bucharest coordinates, id `m1`. Only the counts are computed
  from the database. Fine while the platform is one city — which `tasks.md`
  lists as an open decision — but it is the one place where something shaped
  like data is not data.
- **`customer_farmer_distances` is referenced by no migration and no code.** It
  predates everything in `sql/` and maps customer ids to farm ids with
  distances. `16_rls_all_tables.sql` is what finally secures it.
- **Rate limiting is in-memory.** Correct for one instance; more than one needs
  Redis or each counts separately.
- **Comments are mixed Romanian and English.** New code is English; the older
  files were not translated, and translating them wholesale would bury the
  reasoning under a diff nobody can review.
