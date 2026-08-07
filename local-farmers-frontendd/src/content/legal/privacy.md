---
key: privacy
title: Privacy Policy
audience: all
version: 1.0
updated_at: 2026-08-07
effective_from: "[EFFECTIVE DATE]"
status: draft
---

# Privacy Policy

This policy explains what personal data we collect, why, on what legal basis, who we share it with, and how long we keep it. It is written to describe what the platform actually does — if you find something here that does not match your experience, that is a bug and we want to hear about it.

## 1. Who is responsible for your data

- **Company name:** [COMPANY NAME], [LEGAL FORM]
- **Registered office:** [FULL ADDRESS]
- **Unique registration code / VAT ID:** [CUI]
- **Trade register number:** [J.../.../...]
- **Contact for privacy questions:** [PRIVACY EMAIL]
- **Data Protection Officer** (if appointed): [DPO EMAIL]

We are the **controller** for the data described below.

**The farms are separate controllers for their own purposes.** When you place an order, the farm receives the data it needs to prepare and deliver it. What the farm then does with that data — its own records, its own bookkeeping — is its responsibility, not ours. We are an intermediary, never the seller.

## 2. What we collect, why, and on what basis

### 2.1 Account data

| Data | Why | Legal basis (GDPR Art. 6) |
|---|---|---|
| Username, email address, password (stored only as a scrypt hash) | To create and secure your account | Art. 6(1)(b) — performance of a contract |
| Role (customer or producer) | To show you the right parts of the platform | Art. 6(1)(b) |
| Name, surname, city, county (customers) | To let farms deliver to you | Art. 6(1)(b) |

We never store your password. We store a scrypt hash of it, which cannot be reversed.

### 2.2 Producer data

| Data | Why | Legal basis |
|---|---|---|
| Farm name, address, phone, delivery radius, description | To publish the farm's public profile | Art. 6(1)(b) |
| Producer certificates, trade register documents, sanitary authorisations | To check the farm may legally sell what it lists | Art. 6(1)(c) — legal obligation; Art. 6(1)(f) — legitimate interest in a safe marketplace |
| Stripe account identifier | To pay the farm | Art. 6(1)(b) |

**We do not store bank account numbers.** Payment details are collected by Stripe under its own identity checks. Any IBAN we held before August 2026 has been erased.

Uploaded documents are stored in a **private** bucket. They are never publicly accessible. An administrator viewing one generates a link that expires in two minutes, and every such view is recorded in our audit log.

### 2.3 Order and payment data

| Data | Why | Legal basis |
|---|---|---|
| Orders, products, quantities, prices, delivery addresses | To perform the contract | Art. 6(1)(b) |
| Payment records, refunds, transfer references | Accounting and tax | Art. 6(1)(c) |
| Food traceability records | Regulation (EC) 178/2002 | Art. 6(1)(c) |

Your **card details never reach us.** Payment happens on Stripe's own hosted page. We receive a payment reference and the result, nothing more.

### 2.4 Messages

Messages you exchange with a farm are stored so both sides have a record of what was agreed. An administrator can read a conversation **only** in the context of a reported message or an open dispute, and every such access is written to our audit log with the administrator's identity and the reason.

Legal basis: Art. 6(1)(b) and Art. 6(1)(f) — our legitimate interest in resolving disputes and keeping the platform safe.

### 2.5 Consent records

When you accept the terms — at signup and again when you place an order — we record which document, **which version**, when, your IP address and your browser's user agent.

Without the version, a consent record proves nothing the moment the text changes, which is exactly when it is needed. Legal basis: Art. 6(1)(c) and Art. 6(1)(f) — demonstrating compliance.

### 2.6 Security and audit logs

We log security-relevant actions: sign-ins, password changes, changes to payout settings, administrator actions, order state changes, refunds, and administrator access to private conversations. These entries include the actor, the action, the time and the IP address.

Legal basis: Art. 6(1)(f) — our legitimate interest in detecting fraud and abuse, and in being able to reconstruct what happened.

**Sensitive values are never written in clear text.** Where a log entry refers to something confidential, it is masked.

### 2.7 What we do *not* do

- We do **not** use analytics or advertising cookies.
- We do **not** sell or rent your data to anyone.
- We do **not** use your data for automated decision-making or profiling with legal effects.
- We do **not** send marketing email unless you have separately asked for it.

Every email we send is transactional: it is about your account or an order you placed.

## 3. Cookies

We use two cookies, both strictly necessary:

| Cookie | Purpose | Lifetime |
|---|---|---|
| `lf_session` | Keeps you signed in | 7 days |
| `lf_admin_session` | Keeps an administrator signed in | 12 hours |

Both are `HttpOnly`, so no script on the page can read them. Neither tracks you across sites. Because they are strictly necessary for a service you asked for, they do not require consent under Art. 82 of Law 506/2004.

See the [Cookie Policy](/legal/cookies) for the full detail.

## 4. Who we share data with

We use the following processors. Each acts only on our instructions, under a data processing agreement.

| Processor | What it handles | Where |
|---|---|---|
| Supabase | Database and file storage | [REGION — CONFIRM BEFORE PUBLISHING] |
| Stripe Payments Europe, Ltd. | Payments, producer identity checks, payouts | EU / Ireland |
| Resend | Transactional email delivery | [REGION] |
| Vercel | Hosting the website | [REGION] |
| Render | Hosting the API | [REGION] |

**Stripe is a separate controller** for the identity checks it performs on producers. Those are its own legal obligations under anti-money-laundering rules, not ours.

We also disclose data to public authorities where we are legally required to.

### International transfers

Where a processor stores data outside the European Economic Area, the transfer relies on the European Commission's Standard Contractual Clauses. [CONFIRM PER PROCESSOR BEFORE PUBLISHING.]

## 5. How long we keep things

| Data | Retention |
|---|---|
| Account data | While your account exists, then anonymised on deletion |
| Orders, invoices, payment records | 10 years — accounting law (Law 82/1991) |
| Food traceability records | 5 years — food safety rules |
| Consent records | 3 years after the account closes, as proof of consent |
| Audit logs | 2 years |
| Messages | 3 years after the conversation's last message |
| Producer documents | While the farm is active, then 5 years |

These periods are why deleting your account does not erase everything — see below.

## 6. Your rights

Under GDPR you may:

- **Access** your data, and get a copy of it (Art. 15)
- **Correct** anything inaccurate (Art. 16)
- **Erase** your data (Art. 17), within the limits in §7
- **Restrict** processing (Art. 18)
- **Take your data elsewhere** in a machine-readable format (Art. 20)
- **Object** to processing based on legitimate interest (Art. 21)
- **Withdraw consent** at any time, where consent is the basis
- **Complain** to the Romanian supervisory authority, the ANSPDCP (<https://www.dataprotection.ro>)

Two of these are built into the platform and need no email:

- **Download everything we hold about you** — Profile → Privacy → *Download my data*. You get a JSON file.
- **Delete your account** — Profile → Privacy → *Delete my account*.

For anything else, write to [PRIVACY EMAIL]. We answer within one month, as Art. 12(3) requires.

## 7. What deleting your account does — and does not do

We are honest about this because a promise to "delete everything" would be a promise we cannot legally keep.

**Erased or anonymised immediately:**

- Your username is replaced with an irreversible pseudonym
- Your email address, password hash and phone number are removed
- Your name, surname, city and county are removed
- The text of your messages is replaced with a placeholder
- Your sessions are revoked everywhere

**Kept, in pseudonymised form:**

- **Orders, prices, quantities and payment records** — accounting law requires 10 years, and we cannot shorten it
- **Food traceability records** — who produced what, and when it was sold
- **Refunds and transfers** — the money trail has to stay reconstructable
- **Consent records** — proof that consent was given, which is worthless if it can be deleted by the person disputing it
- **Audit log entries** — the append-only record of what happened

After deletion, these records refer to a pseudonym. Nobody looking at them can tell who you were without the mapping we have destroyed.

## 8. Security

- Passwords are stored as scrypt hashes, never in clear text.
- Sessions are signed and revocable: changing your password invalidates every session everywhere, immediately.
- Producer documents live in a private bucket, reachable only through short-lived signed links.
- Administrator access to a private conversation is always logged.
- All traffic is encrypted in transit.

No system is perfect. If you find a security problem, write to [SECURITY EMAIL] — we would much rather hear from you than from an attacker.

## 9. Children

The platform is not intended for anyone under 16, and we do not knowingly collect their data. If you believe a child has created an account, tell us and we will remove it.

## 10. Changes to this policy

If we change this policy materially, we will tell you by email and ask you to read the new version before you continue. Every version is kept, with its version number and date, so you can see what changed and when.

---

**Version 1.0 · Last updated [DATE] · Effective from [EFFECTIVE DATE]**
