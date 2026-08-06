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
  **service role key**, so it bypasses RLS. The browser holds the publishable key
  and uses it *only* for Realtime subscriptions.
- **Auth is custom, not Supabase Auth.** Stateless HMAC-signed cookie (`lf_session`),
  minted in `src/lib/auth.js`. This matters constantly: RLS policies have no
  `auth.uid()` to check against, which is why most tables are service-role-only
  and why enabling RLS on `orders` would break browser Realtime.
- **Payments: Stripe Connect Express, separate charges and transfers.** One
  `PaymentIntent` on the platform account for the whole basket, then one
  `Transfer` per farm to their own Connect account, immediately on payment
  confirmation. The platform never holds farmer money.
- Request flow: `browser → apiFetch (credentials: include) → Express → Supabase`.
  Stripe calls the webhook directly.

## 2. Tech stack

| Layer | Choice |
|---|---|
| Backend | Node ≥18, Express 4, CommonJS (`require`) |
| Frontend | React 18, Vite 7, react-router-dom 6, ESM |
| DB | Supabase Postgres, `@supabase/supabase-js` v2 |
| Payments | `stripe` v20, Connect **Express** accounts, API pinned `2024-06-20` |
| Email | Resend via `fetch` in `src/lib/mailer.js` (no outbox/retry yet) |
| Tests | Jest + supertest (backend, 82), Vitest + Testing Library (frontend, 3) |
| Markdown | `react-markdown` + `remark-gfm`, **lazy-loaded** (legal pages only) |
| Styling | One hand-written `global.css`. No CSS framework, no CSS-in-JS. |

## 3. Directory map

```
local-farmers-backendd/
  src/app.js              route mounting, helmet/cors/CSRF/rate-limit, error handler
  src/server.js           entry point
  src/lib/
    config.js             ⚠ boot-time secret validation — THROWS if any is missing
    supabase.js           client + TABLES registry (single source of table names)
    auth.js               password hash (scrypt), session sign/verify, revokeUserSessions
    money.js              ALL money math, integer bani, commission, invariant check
    pricing.js            the one place basket prices are computed
    stripeClient.js       single Stripe client + error → user-message mapping
    connect.js            Connect accounts, onboarding links, visibility gate
    transfers.js          farmer payouts, double idempotency
    platformSettings.js   commission_bps from DB, 60s cache
    legalDocuments.js     ⚠ authority on which legal version is in force
    legalAcceptance.js    writes consent records
    audit.js              recordAudit() — never throws
    domain.js             DB row → API shape mappers
    productRating.js      internal sales score (NOT a customer rating)
    farmerRanking.js      farmer-of-the-month scoring
  src/middleware/         auth, adminAuth, csrf (requireSameOrigin), rateLimit
  src/routes/             16 routers, mounted under /api/*
  sql/                    hand-run migrations, numbered ones are current
  tests/                  security/ + unit; helpers/fakeSupabase.js is an in-memory DB

local-farmers-frontendd/
  src/App.jsx             nav + footer + all routes
  src/lib/api.js          apiFetch wrapper (cookies, X-Requested-With, timeout)
  src/lib/auth.jsx        AuthProvider / useAuth
  src/lib/legal.js        loads .md via ?raw, parses frontmatter
  src/content/legal/      versioned legal documents + REVIEW-NOTES.md (not routed)
  src/pages/              one file per route
  src/components/         5 shared components
  src/styles/global.css   everything
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
*above* it rather than restructuring `orders` (which chat, earnings, admin,
ratings and browser Realtime all depend on). A 3-farm basket = 1 checkout + 3
orders. Money frozen on each `orders` row at placement:
`products_subtotal_bani`, `delivery_fee_bani`, `commission_bps`,
`commission_bani`, `transfer_amount_bani`, `stripe_account_id`.

### Tables (`TABLES` registry in `src/lib/supabase.js`)

- **Identity**: `users` (+`token_version`, `email_verified`), `farmers`, `customers`, `permission`
- **Catalog**: `products`, `farm_photos`, `farmer_requests`, `farmer_docs`
- **Orders**: `checkouts`, `orders`, `order_items`, `order_replies`
- **Payments**: `order_transfers` (unique on `order_id` = the idempotency claim), `platform_settings` (single row, `commission_bps`)
- **Chat**: `conversations`, `messages`
- **Compliance**: `audit_log`, `legal_acceptances`, `stripe_events`, `auth_tokens`

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

### State

- Frontend: local `useState` only. **No Redux/Zustand/Context beyond `AuthProvider`.**
- Server state is re-fetched, plus Supabase Realtime on `orders` / `order_replies` / `messages`.
- Order states: `placed_order`(=cart) → `pending_order` → `received_by_farmer` → `preparing_order` → `in_transit` → `arrived` → `received`, plus `cancelled`.

## 5. Conventions

**Non-negotiable**
- **Fail fast on missing secrets.** `config.js` throws at boot. A process that runs
  insecurely is worse than one that will not start.
- **Idempotency** on: Stripe webhooks (`stripe_events` PK on `event.id`), transfers
  (`order_transfers` unique `order_id` + Stripe idempotency key), `process_checkout`,
  `mark_checkout_paid`.
- **Integer bani.** Explicit half-up rounding, duplicated in SQL
  (`public.commission_bani`) and JS (`src/lib/money.js`) — change both together.
- **New tables get RLS enabled with NO policies** → service-role-only.
  Do **not** enable RLS on `orders`/`messages` without moving Realtime off the browser.
- **A paid order is never deleted.** `cancelled` is a state with `cancelled_by`,
  `cancel_reason`, `cancelled_at`.
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
- ⚠ **SQL must be run BEFORE deploying the backend** — function signatures change.

**Testing**
- `tests/helpers/fakeSupabase.js` is an in-memory Supabase stub; `buildApp(seed)` boots the
  real app against it, so tests exercise real routes/middleware. It does **not** apply
  column defaults.
- Security tests are named after the audit finding they cover (`SEC-05 — ...`).

## 6. Gotchas

- A farmer without `charges_enabled` is **hidden everywhere** (`markets`, `products`,
  `vendors`, and blocked at add-to-cart). After the payments migration the catalog
  looks empty until farms complete Stripe onboarding — that is correct, not a bug.
- `/profile` renders `VendorPage` or `CustomerProfilePage` by role; `/vendor` redirects to it.
- Admin panel is at `/manage-portal` with a single shared credential (see `tasks.md`).
- `productRating.js` output is a **sales score**, not a customer review. It must never
  be displayed as a star or a mark (LEG-06).
- Legal doc versions live in **two places** and must be bumped together:
  `src/lib/legalDocuments.js` (backend, authoritative) and the `.md` frontmatter.
