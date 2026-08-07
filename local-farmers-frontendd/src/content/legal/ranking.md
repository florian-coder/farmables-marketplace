---
key: ranking
title: How Ranking Works
audience: all
version: 1.0
updated_at: 2026-08-07
effective_from: "[EFFECTIVE DATE]"
status: draft
---

# How Ranking Works

Required by Regulation (EU) 2019/1150 (the P2B Regulation), art. 5: a platform must explain, in plain language, the main parameters that decide the order in which producers and products are shown, and their relative importance.

This page is that explanation. It describes what the code actually does.

## 1. The short version

- **Nobody can pay for a better position.** There is no promoted placement, no sponsored slot, no advertising, and no arrangement in which a producer gets ranked higher for money. If that ever changes we will say so here first, with notice.
- **Which producers can be shown at all** is decided by one thing: whether they can legally be paid.
- **The order within a category** is by relevance and availability, not by anything a producer buys.
- **"Farmer of the month"** is a separate award with a published formula, set out in §4.

## 2. Who appears in the catalogue at all

A producer's products are visible only when **all** of these are true:

1. **The farm has been approved.** An administrator has checked the producer's certificate, trade register registration or sanitary authorisation for the category.
2. **The farm has the permission for that category.** Selling eggs requires a sanitary-veterinary authorisation for eggs; honey requires one for honey; fruit and vegetables require a producer's certificate or trade register registration. Permissions are granted per category, from the documents actually uploaded.
3. **The farm can be paid.** The producer has completed Stripe's onboarding and Stripe reports the account as able to receive charges.
4. **The product is marked available** and has stock.

Point 3 surprises people, so it is worth saying plainly: **a farm that has not finished setting up payments is invisible**, however good its produce is. We are not willing to take a customer's money for an order we cannot pass on. It is not a penalty and it is not a ranking decision — it is a hard gate, and it disappears the moment onboarding is done.

## 3. The order products appear in

Within a category, products are ordered by:

1. **Availability** — anything out of stock or marked unavailable is not shown.
2. **The category you are browsing** — you see what you asked for.
3. **Recency** — recently listed and recently updated products come first, so what a farm has just harvested is what you see.

We do **not** rank by:

- any payment from the producer
- the producer's commission rate — it is the same for everyone
- how long the producer has been on the platform
- any customer star rating (there is no customer rating system on this platform; see §5)

## 4. "Farmer of the month"

One producer per category is highlighted each month. The categories are **Fruits & Vegetables**, **Eggs** and **Honey** — the three the site sells.

The score is computed from that month's completed sales, in that category:

| Parameter | Weight | What it measures |
|---|---|---|
| Revenue | **50%** | Total value of completed sales |
| Number of orders | **30%** | How many separate customers were served |
| Quantity sold | **20%** | Total kilos, litres or units |

Each parameter is normalised against the best performer in that category that month, so the leader on any single measure scores 100 for it. The three scores are then combined with the weights above.

Worked example, for Fruits & Vegetables in a month where the best figures were 1,000 RON, 25 orders and 210 kg:

- Farm A: 1,000 RON, 20 orders, 200 kg → 100×0.5 + 80×0.3 + 95.2×0.2 = **93.05**
- Farm B: 800 RON, 25 orders, 210 kg → 80×0.5 + 100×0.3 + 100×0.2 = **90.00**

Farm A wins, because revenue carries half the weight.

**Ties** are broken by revenue, then order count, then quantity, then producer id — a deterministic order, so the same month always produces the same result.

**Cancelled and refunded orders do not count.** Only orders that completed count towards the score, which is why the award cannot be gamed by placing and cancelling orders.

Each category is scored **independently**. A small honey producer competes only against other honey producers; being outsold by a large vegetable farm is irrelevant.

## 5. What we do *not* have

**There is no customer star rating on this platform.**

We calculate an internal number from sales volume, used only to decide which products to surface. It is **not** a customer review, it has never been one, and it is never shown as a star or a mark — presenting a sales figure as though customers had rated the product would be misleading, and would breach Law 363/2007 on unfair commercial practices.

If we add real customer reviews, they will be clearly labelled as such, only from verified purchases, and this page will say so.

## 6. Changes

If we change how ranking works in a way that disadvantages producers, the Producer Terms require **30 days' notice** before it takes effect, and this page is updated at the same time. Every version is kept.

## 7. Questions and complaints

Producers may raise a ranking complaint through the internal complaint-handling system described in the [Producer Terms](/legal/terms-producers), §11. We respond within 15 working days.

Write to [PRODUCER EMAIL].

---

**Version 1.0 · Last updated [DATE] · Effective from [EFFECTIVE DATE]**
