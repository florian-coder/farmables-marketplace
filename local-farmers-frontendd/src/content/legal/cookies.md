---
key: cookies
title: Cookie Policy
audience: all
version: 1.0
updated_at: 2026-08-07
effective_from: "[EFFECTIVE DATE]"
status: draft
---

# Cookie Policy

This site uses **two cookies, both strictly necessary**. There is no consent banner because there is nothing to consent to.

## The full list

| Name | Set by | Purpose | Lifetime | Type |
|---|---|---|---|---|
| `lf_session` | This site | Keeps you signed in between page loads | 7 days | Strictly necessary |
| `lf_admin_session` | This site | Keeps an administrator signed in | 12 hours | Strictly necessary |

That is the whole list.

## What we do not use

- **No analytics cookies.** No Google Analytics, no Plausible, no Matomo.
- **No advertising or tracking cookies.** Nothing follows you to another site.
- **No social media pixels.** No Meta pixel, no LinkedIn Insight Tag.
- **No A/B testing or session recording.** Nobody watches a replay of your visit.
- **No third-party cookies at all** while you are on this site.

If that changes, this page changes with it, we will ask for your consent first, and you will see a banner. Until then there is nothing to ask about.

## Why these two do not need consent

Article 82 of Law 506/2004 — Romania's implementation of the ePrivacy Directive — requires consent for storing information on your device, **except** where it is strictly necessary to provide a service you explicitly asked for.

Staying signed in is that service. Without `lf_session`, every page would ask you to log in again.

Both cookies are:

- **`HttpOnly`** — no script on the page can read them, which is what stops a cross-site scripting bug from stealing your session
- **`SameSite`-restricted** — they are not sent when another site links to us in a way that could act on your behalf
- **`Secure`** in production — never sent over an unencrypted connection
- **Signed** — the contents are cryptographically signed, so a modified cookie is rejected rather than trusted

## Related technology

**Local storage.** We use your browser's local storage once, to clear data left behind by an older version of this site. Nothing is kept there afterwards.

**Realtime connection.** When you have the orders or chat page open, your browser holds a live connection to our database so updates appear without a refresh. This is a network connection, not a cookie, and it stores nothing on your device.

**Stripe.** When you pay, you are on Stripe's own page, not ours. Stripe sets its own cookies there, for fraud prevention. That is governed by [Stripe's privacy policy](https://stripe.com/privacy) and its own cookie notice. We never see your card details.

## Turning them off

You can block or delete cookies in your browser settings. If you block ours, you will not be able to stay signed in, which means you cannot place an order — everything else on the site still works.

## Questions

Write to [PRIVACY EMAIL]. See also the [Privacy Policy](/legal/privacy).

---

**Version 1.0 · Last updated [DATE] · Effective from [EFFECTIVE DATE]**
