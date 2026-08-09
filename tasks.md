# Open work

The August 2026 audit (38 findings) is closed in code. What is left is work
only you can do: run the migrations, fill the legal placeholders, and make five
business decisions.

Architecture and conventions are in [`CODEBASE_SUMMARY.md`](./CODEBASE_SUMMARY.md).

---

## ⚠ 1. Run the migrations, in this order

**Nothing in `sql/` runs automatically.** Each file is pasted into the Supabase
SQL Editor. They are idempotent — a second run changes nothing — but the order
matters, and two of them have a deploy-order constraint.

| # | File | Notes |
|---|---|---|
| 03 | `03_refunds.sql` | **Before** deploying. The backend calls `cancel_order_with_stock`. |
| 04 | `04_email_outbox.sql` | Either side of the deploy. |
| 05 | `05_order_maintenance.sql` | Either side. |
| 06 | `06_privacy.sql` | Either side. |
| 07 | `07_email_status.sql` | Run PART 1 alone first to see the scale. |
| 08 | `08_admin_users.sql` | **Before** deploying. The login route reads `admin_users`. |
| 09 | `09_rls_hardening.sql` | ⚠ **Last, and only after both apps are deployed.** See below. |
| 10 | `10_moderation_disputes.sql` | Before deploying. |
| 11 | `11_fulfilment.sql` | Before deploying. |
| 12 | `12_food_labelling.sql` | Before deploying. |
| 13 | `13_trader_details.sql` | Before deploying. |
| 14 | `14_seasonality_subscriptions.sql` | Before deploying. |
| 15 | `15_escrow_payouts.sql` | **Before** deploying. The new code writes `transfer_state = 'held'`, which the old check constraint rejects. |

### 15 changes when farmers are paid

Until now the farmer's share was transferred the moment the card cleared.
It is now **held on the platform balance until the customer confirms the order
arrived**, and refunded to the customer if it never does. Migration 15 widens
the `transfer_state` constraint, adds the columns that track the hold, and
backfills every currently open paid order to `held`.

Orders already transferred under the old model are left exactly as they are —
`sent` is `sent`, and nothing tries to claw anything back.

Two environment variables control the deadlines, both optional:
`AUTO_CONFIRM_DAYS` (default 7) is when a delivered-but-unconfirmed order
closes itself and pays the farm; `PAYOUT_HOLD_EXPIRY_DAYS` (default 14) is when
an order that never arrived is cancelled and refunded.

### The one with a real ordering constraint — 09

Enabling RLS breaks the browser's old Supabase Realtime subscription. The
replacement (a backend SSE channel) ships with the code, so:

1. deploy the **backend** (SSE endpoint + server-side subscription)
2. deploy the **frontend** (no Supabase client at all any more)
3. **then** run `09_rls_hardening.sql`

Between 2 and 3 nothing is broken — you are simply still exposed. Doing 3 first
freezes live updates for anyone mid-session.

### Environment variables to set before deploying

```
SUPABASE_SERVICE_ROLE_KEY   # the backend now REFUSES TO BOOT without it
OPERATOR_LEGAL_NAME         # these render in the footer and every email
OPERATOR_CUI
OPERATOR_TRADE_REGISTER
OPERATOR_ADDRESS
OPERATOR_EMAIL
OPERATOR_PHONE
VITE_OPERATOR_*             # the same values, for the frontend footer
RESEND_API_KEY              # without it, email is logged to the console
```

The backend warns at boot for every `OPERATOR_*` still on a placeholder.

### After deploying

- Sign in to `/manage-portal` once with the existing `ADMIN_USERNAME` /
  `ADMIN_PASSWORD`. It bootstraps one `admin_users` row and immediately demands
  TOTP enrolment. **Save the backup codes — they are shown once.**
- Then set `ADMIN_BOOTSTRAP_DISABLED=1` and redeploy. **The old admin password
  is in git history; treat it as public.** This is what makes it inert.
- Check `/api/health/diagnostics` — it lists stuck emails, refunds needing
  manual recovery, failed transfers and placeholder operator data.

---

## 2. Fill the legal placeholders, then get sign-off

Seven documents in `local-farmers-frontendd/src/content/legal/`, all still
`status: draft`. Every `[SQUARE BRACKET]` is a decision or a fact only you have.

- `terms-customers.md` · `terms-producers.md` — company details, mediator names
  (§ P2B), the guarantee decision (§14)
- `privacy.md` — processor regions, DPO, retention confirmations
- `returns.md` · `cookies.md` · `contact.md` · `ranking.md` — company details

`ranking.md` fills the LEG-05 gap: it publishes the ranking parameters and the
50/30/20 weighting the code actually uses, as P2B art. 5 requires.

When a lawyer has signed off:

1. flip `status: draft` → `final` in the frontmatter
2. bump `version` in **both** the `.md` frontmatter and
   `src/lib/legalDocuments.js` — they are cross-checked at runtime and a
   mismatch stops signup

---

## 3. Business decisions (not code)

These are unchanged from the audit. Each one changes text that is already
written, so they are cheap to act on once decided.

1. **Do we verify producer documents, or not?** Rewrites customer terms §7.4,
   Section 4, and all site marketing. "Partly" is not available — badges plus a
   disclaimer is the worst legal position (DSA art. 6(3) + Law 363/2007).
   *The code currently assumes yes: approval checks documents per category.*
2. **Do we offer the commercial guarantee?** (producer §14 / customer §14.4)
   The only thing that commercially justifies 10% against a free Facebook group.
3. **Platform minimum order.** Break-even is ~11.80 RON of products; with a
   15 RON delivery fee it rises to ~14.30. `platform_settings.min_charge_bani`
   raises it without a deploy.
4. **One city, saturated** — delivery radius means growth does not transfer
   between cities.
5. **Set `weight_tolerance_bps`** if ±10% is wrong for your produce. It is in
   `platform_settings`, and customer terms §10.4 states the same number —
   change both together.

---

## 4. Explicitly out of scope

- **LOG-01 — courier, tracking, delivery slots.** Farms deliver themselves.
  `lead_time_hours` and `expected_delivery_date` exist as the hooks for the day
  this changes.

---

## 5. Worth doing next, none of it blocking

- **Backfill the trader details.** `farmers.legal_name`, `trade_register_number`,
  `cui` and `trader_type` are collected going forward but blank for existing
  farms. The public page shows an explicit "not supplied yet" until they are —
  see the verification query in `13_trader_details.sql`.
- **Complete the catalogue's labelling.** Migration 12 grandfathers existing
  products (`{"needsAttention": true}`); they keep selling and the next edit
  completes them. Set yourself a deadline — the query is at the bottom of the file.
- **Move the outbox and the maintenance sweep to their own process** if volume
  grows. Both already use `for update skip locked`, so running several
  instances is safe today; splitting them out is a deployment change, not a
  code change.
- **Rate limiting is in-memory.** Correct for one instance. More than one needs
  Redis, or each instance counts separately.

---

## Done

Every finding below is implemented and covered by tests (380 backend, 38
frontend). The commit for each explains the reasoning.

**Blocking the first customer**
PAY-01 escrow payouts (held on payment, released on confirmed receipt, refunded
if the order never arrives; undelivered-order expiry sweep; Connect onboarding
recovery for a dead Stripe account) ·
OPS-01b refunds (reversal before refund, full + partial, manual-recovery path) ·
OPS-02 notifications (outbox, 13 templates, retry/backoff) · LEG-02 distance
selling (5 new documents, footer identification, ANPC/SAL, consent at order) ·
LEG-03 GDPR (export + anonymising deletion)

**Security**
SEC-01 RLS on all 23 tables, Realtime moved to a backend SSE channel, Supabase
removed from the frontend bundle entirely · SEC-03 private docs bucket ·
SEC-09b email enforcement at checkout · SEC-11 audit coverage + append-only ·
SEC-12 admin hardening (per-admin identity, TOTP with replay protection, backup
codes, 8h sessions)

**Operations**
OPS-03 disputes (48h then auto-escalation, private evidence bucket, admin
tools) · OPS-04 auto-confirm with prior warning · OPS-05 contact revealed after
a paid order · OPS-06 availability + partial fulfilment · OPS-07 chat
moderation (flag-not-block, reporting, blocking)

**Legal / logistics**
LEG-04 food labelling (1169/2011, eggs 589/2008, honey HG 1050/2003, organic
certificates that expire) · LEG-05 ranking transparency + category fix ·
LEG-07 DSA art. 30 trader details · LOG-04 weight tolerance · LOG-06
seasonality, pre-orders, recurring baskets

**Earlier deliveries**
SEC-02 secrets · SEC-04 CSRF · SEC-05 checkout ownership · SEC-06 webhook
signature + idempotency · SEC-07 rate limiting · SEC-08 `token_version` ·
SEC-10 PDF uploads · SEC-13 request-id errors · LEG-01 Stripe Connect ·
LEG-06 sales score not shown as a star · BIZ-01 commission · BIZ-02 monthly
payout removed · BIZ-03 `|| true` permission bug · LOG-02 delivery fee +
minimum · LOG-03 single payment per basket · LOG-05 stock leak on abandoned
checkout
