# Open work

Tracked against the August 2026 audit (38 findings). Architecture and conventions
are in [`CODEBASE_SUMMARY.md`](./CODEBASE_SUMMARY.md).

Status key: **OPEN** · **PARTIAL** (started, not finished) · **DEFERRED** (decided, later)

---

## Blocking the first real customer

### OPS-01b — Refunds do not exist ⚠ the biggest hole
**PARTIAL.** Half of OPS-01 is done: a paid order becomes `cancelled` instead of
being deleted, with `cancelled_by` / `cancel_reason` / `cancelled_at`. The other
half was never built.

What is missing, verified in code:
- **No refund code anywhere.** `grep -ri refund src/` returns only a comment.
  A customer whose paid order is declined by the farmer gets no money back.
- **Stock is not restored on cancellation.** `rollback_checkout` only handles
  unpaid checkouts. Cancelling a paid order silently loses the stock.
- **No `Transfer Reversal`.** The farmer has already been paid by the time a
  cancellation happens, so the money must be clawed back before refunding.
- **No `refunds` table.**
- **No state machine.** Transitions are validated by a lookup table in
  `orders.js`; invalid ones return 400, and the spec asks for 409 plus a single
  transition function.

Build:
- `refunds` table: order, group, amount, reason, author, `stripe_refund_id`,
  `stripe_transfer_reversal_id`, state, timestamps.
- Full and partial refund. Full = products + delivery + commission. Partial =
  missing products + proportional commission, delivery kept if anything shipped.
- Reversal before refund. Handle insufficient balance (farmer already withdrew):
  log, alert admin, mark the group `refund_pending_manual`.
- Restore stock **in the same transaction** as the cancellation.
- One transition function with an explicit state machine; invalid → 409.

### OPS-02 — No notifications at all
**DEFERRED by decision, but this is the largest operational gap.** No email, no
SMS, no push. Realtime only works while a tab is open. A farmer can miss an
order for days; for perishable goods that is fatal. It is also the only reason a
farmer would prefer a free Facebook group.

`src/lib/mailer.js` exists (Resend, single `sendMail`). Missing: `email_outbox`
table with retry/backoff (max 5) and `event_key` uniqueness, `src/emails/`
templates with a shared layout and plain-text fallback, and sending that does not
block the HTTP request or break the transaction.

Events: new order → farmer · payment confirmation + summary → customer (durable
medium, required by GEO 34/2014) · state changes → customer · cancellation +
refund initiated → customer · refund completed → customer · new chat message
(debounced, max 1 per 15 min per conversation) · email verification · password
reset · Stripe onboarding incomplete → farmer · transfer sent → farmer ·
account approved/rejected → farmer.

**Blocks:** the order confirmation email in LEG-02, and the refund notifications
in OPS-01b.

### LEG-02 — Distance selling obligations, partially done
**PARTIAL.** Done: customer + producer terms (English, versioned Markdown,
draft status banner), consent at signup with version + timestamp + IP,
"Order with obligation to pay" button, full price breakdown before payment.

Missing:
- Privacy policy, return policy, cookies page, contact page — the renderer and
  routing already exist, they need content files and registry entries.
- Footer: ANPC + SAL links, and operator identification (name, CUI, registered
  office, email, phone) as config variables.
- **Consent at order placement**, not only at signup. The registry already
  supports it (`requiredAtOrder: true` on the customer terms) — it just is not
  wired into checkout.
- Order confirmation on a durable medium → depends on OPS-02.

### LEG-03 — GDPR
**DEFERRED.** No privacy policy, no documented legal bases, no Art. 30 register,
no processor agreements (Supabase, Stripe, Vercel, Resend), no retention policy.

- **Account deletion (Art. 17):** anonymise personal data, keep orders
  pseudonymised for accounting and food traceability. Document exactly what is
  erased and what is kept.
- **Data export (Art. 20):** downloadable JSON. `acceptancesFor()` in
  `legalAcceptance.js` is already written for this.

---

## Security

### SEC-01 — RLS ⚠ verify before anything else
**UNVERIFIED — the only remaining *Critical*.** New tables (`checkouts`,
`order_transfers`, `platform_settings`, `legal_acceptances`) have RLS on with no
policies. The seven original tables were never covered by any migration here.

```sql
select tablename, rowsecurity from pg_tables
where schemaname = 'public'
  and tablename in ('orders','order_items','order_replies','messages',
                    'conversations','farmer_requests','products');
```
Any `rowsecurity = false` means the publishable key in the JS bundle can still
read and write it. **Enabling RLS on `orders`/`messages` breaks browser
Realtime** (sessions are not Supabase Auth) — move Realtime to a backend SSE/WS
channel, or migrate to Supabase Auth, before flipping it.

### SEC-03 — Private docs bucket
**UNVERIFIED.** `sql/security_hardening.sql` sets it. Confirm:
`select id, public from storage.buckets;` Already-public URLs may be cached.

### SEC-09b — Legacy auto-generated emails
**PARTIAL.** Verification and reset work; `email_verified` is written but
**never enforced**. Accounts created before this with generated
`user@localfarmers.app` addresses were never migrated to a "missing email" state
that blocks checkout until corrected.

### SEC-11 — Audit log coverage
**PARTIAL.** Table, indexes and `recordAudit()` exist. Coverage is thin —
`recordAudit` appears **zero times in `orders.js`**, so order state transitions
are unaudited. Add: state transitions, refunds, admin approvals/rejections,
permission grants, suspensions, admin access to private conversations.
Make it append-only (revoke UPDATE/DELETE) like `legal_acceptances`.

### SEC-12 — Admin hardening
**OPEN.** One shared credential from env, no 2FA, no per-admin identity, no IP
allowlist. Need `admin_users` with TOTP (`otplib`), hashed backup codes, max 8h
sessions, separate rate limiting. **The current password is in git history —
treat it as compromised.**

### OPS-07 — Chat moderation
**OPEN.** No reporting, blocking, admin visibility or filtering.

---

## Before scaling

- **OPS-03 disputes** — `disputes` table, evidence upload to a **private** bucket
  served via short-lived `createSignedUrl`, 48h farmer response then auto-escalation,
  opening window after `arrived`. Admin tools: search orders, view history, refund
  from the panel, suspend a farm with reason and notice, view a conversation in
  dispute context (with access logged).
- **OPS-04** — auto-confirm orders stuck in `arrived` after N days, with prior email.
- **OPS-05** — phone/email still render as `tel:`/`mailto:` on the public farm page
  before any order. Reveal only after a first paid order. **DEFERRED.**
- **OPS-06** — no working hours, holidays, daily capacity or partial fulfilment.
  A farmer with 3 of 5 kg can only decline the whole order.
- **LEG-04 food labelling** — allergens, net quantity, storage, durability, batch,
  producer details, origin. Eggs (Reg. 589/2008), honey (HG 1050/2003). "Bio" only
  with an admin-validated certificate that auto-expires. Block publishing without
  the mandatory fields for the category.
- **LEG-05 P2B** — producer terms now cover 30-day notice, internal complaints and
  mediators (mediator names still `[TO BE COMPLETED]`). Missing: a **public page
  explaining ranking parameters**; §5.1 is still a placeholder.
  Also `farmerRanking.js` uses `meat` / `fruits_and_vegetables` / `dairy_products`
  while the site sells fruit & veg, eggs and honey — two categories are always empty.
- **LEG-07 DSA** — producer CUI and registered office are not shown publicly
  (Art. 30), although customer terms §7.2 promises it. **DEFERRED.**
- **LOG-01** — no courier, tracking or delivery slots. Explicitly out of scope so far.
- **LOG-04** — variable weight vs prepaid card. Either authorise + capture at the
  real weight, or a declared tolerance. Customer terms §10.4 has a `±[10]%`
  placeholder that matches no implementation.
- **LOG-06** — no seasonality, pre-orders or recurring baskets. The subscription
  box is the model that actually produces predictable revenue.

---

## Product / business decisions (not code)

1. **Do we verify producer documents, or not?** Rewrites customer terms §7.4,
   Section 4, and all site marketing. "Partly" is not available — badges plus a
   disclaimer is the worst legal position (Art. 6(3) DSA + Law 363/2007).
2. **Do we offer the commercial guarantee?** (producer §14 / customer §14.4) The
   only thing that commercially justifies 10% against a free Facebook group.
3. **Platform minimum order.** Break-even is ~11.80 RON of products; with a 15 RON
   delivery fee it rises to ~14.30. Below that each order loses money.
   `platform_settings.min_charge_bani` already exists to raise it without a deploy.
4. **One city, saturated** — delivery radius means growth does not transfer between cities.
5. Fill the `[PLACEHOLDER]` fields in both legal documents, then flip
   `status: draft` → `final` **after** a lawyer signs off, bumping `version` in
   both `legalDocuments.js` and the `.md` frontmatter.

---

## Done (do not redo)

SEC-02 secrets · SEC-04 CSRF · SEC-05 checkout ownership · SEC-06 webhook signature
+ idempotency · SEC-07 rate limiting · SEC-08 `token_version` · SEC-10 PDF uploads ·
SEC-13 request-id error handling · LEG-01 Stripe Connect · LEG-06 sales score no
longer shown as a star · BIZ-01 commission · BIZ-02 monthly payout removed ·
BIZ-03 `|| true` permission bug · LOG-02 delivery fee + minimum · LOG-03 single
payment per basket · LOG-05 stock leak on abandoned checkout
