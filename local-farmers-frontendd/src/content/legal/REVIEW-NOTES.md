# Legal review notes — INTERNAL, NOT PUBLISHED

This file is deliberately **not** routed and **not** imported by any page. It exists
so the lawyer-review markers survive in the repo without appearing on the public
pages. Give this file to the lawyer together with the two published documents.

> **These documents were drafted by an AI assistant, not by a lawyer, and are not
> legal advice.** They are structured to cover the layout, the liability logic and
> the key clauses, so a lawyer starts from an advanced draft rather than a blank
> page — but **they must be reviewed in full by a lawyer practising in consumer
> law and e-commerce before the first real sale.**

Published documents:

- `terms-customers.md` → Part I + customer terms (B2C, sections renumbered 7–19)
- `terms-producers.md` → Part I + producer terms (B2B, sections 7–24)

Both carry `status: draft` in the frontmatter, which makes the page render a
visible "pending legal review" banner. **Flip to `status: final` only after the
lawyer signs off** — and bump `version` at the same time.

---

## Cross-reference map after renumbering

The source document numbered customer sections 25–37. In `terms-customers.md`
they are renumbered 7–19 so the published document reads continuously. The map:

| Source | Published (customers) |
|---|---|
| 25 Who sells to you | 7 |
| 26 Your account | 8 |
| 27 How an order is formed | 9 |
| 28 Prices | 10 |
| 29 Payment | 11 |
| 30 Delivery | 12 |
| 31 Right of withdrawal | 13 |
| 32 If something is wrong | 14 |
| 33 Our liability | 15 |
| 34 Conduct | 16 |
| 35 Your data | 17 |
| 36 Disputes | 18 |
| 37 Final provisions | 19 |

Producer sections kept their original numbers (7–24). Part I (1–6) is duplicated
in both documents on purpose: each must stand alone legally.

---

## ⚠️ LAWYER — Section 3 (both documents)

Section 3 is the clause that carries the entire liability architecture. Check:
(a) whether the collection mandate is sufficiently qualified against PSD2
requirements and the commercial agent exemption; (b) whether the structure
survives a possible reclassification by ANPC. The technical precondition —
Stripe Connect with immediate transfer to the Producer — **is now implemented**,
so 3.4 corresponds to reality.

## ⚠️ LAWYER + PRODUCT — Section 4 (both documents)

Art. 6(3) DSA removes the platform's liability exemption where information is
presented in a way that leads an average consumer to believe the Product comes
from the platform or from someone under its control.

**Practical consequence, mandatory:** if the site shows wording such as "verified
farmers", "quality guaranteed by us", "validated certificates", "producers
certified by [PLATFORM]" — badges, verification ticks, marketing copy — then 4.2
becomes inoperative, and having it alongside those messages is a **misleading
commercial practice** (Law 363/2007).

**Pick one and apply it consistently across the whole site:**

- **(A) We do not verify** — no ticks, no badges, no guarantee language. 4.2 stays as written.
- **(B) We verify** — describe exactly what is verified, how and how often, and rewrite 4.2 accordingly, assuming liability for the verification performed.

The hybrid — badge on the site, disclaimer in the terms — is the worst possible
legal position.

Same decision governs customer terms 7.4.

## ⚠️ LAWYER — Section 5.3

Corrects a problem flagged in the technical audit: the score shown today with a
star and decimals is computed from price, quantity sold and order count, not from
reviews. **Not yet fixed in code** — this is Phase 2, item 2. Until the split is
implemented, the current display is exposed to being classified as a misleading
commercial practice. The text above assumes the split has been done.

## ⚠️ LAWYER + COMMERCIAL DECISION — Producer Section 14 / Customer 14.4

Optional legally, but it is the only element that commercially justifies the
Intermediation fee against the free alternative (local selling groups). Legally,
granting a commercial guarantee of one's own does **not** turn the Platform into
a seller, provided Section 3 stays intact and the guarantee is presented
explicitly as a service of the Platform, not as a guarantee of the Product.
If you drop it, delete it from both documents.

## ⚠️ LAWYER — Producer Section 17

Non-circumvention clauses have limits in competition law. The wording must stay
proportionate; a disguised exclusivity clause or a disproportionate penalty risks
being declared void and may attract competition problems.

## ⚠️ LAWYER — Producer Section 23

Mandatory. Micro-enterprises are exempt from Art. 11 and 12 of the P2B
Regulation, but the exemption is not automatic and ceases once the thresholds are
exceeded. Check the classification and, if the exemption applies, decide whether
to invoke it or keep the mechanism voluntarily.

## ⚠️ LAWYER — Producer Section 24

The jurisdiction clause is valid against professionals but **cannot** be extended
to consumer Customers. Check the wording against Art. 1203 of the Civil Code
(unusual clauses, which require express and separate acceptance).

## ⚠️ LAWYER — Customer Section 10.4 (weight tolerance)

Must be aligned with the technical implementation. A declared tolerance is
acceptable only if it is communicated clearly before the order and is not
disproportionate. The safer alternative is authorising the payment and then
capturing at the actual weight. **Not implemented either way yet.**

## ⚠️ LAWYER — Customer Section 13 (right of withdrawal)

The most sensitive section in the whole document. The perishable-goods exception
applies **only** if it is communicated explicitly before the order. Check:
(a) the wording and its visual placement; (b) per-product marking in the
interface; (c) that the full pre-contractual information is actually displayed.
Without that information, the general rule applies and the withdrawal period
extends to 12 months (Art. 11, GEO 34/2014). **Per-product marking is not
implemented yet.**

## ⚠️ LAWYER — Customer Section 15 (our liability)

Highest risk of nullity in the document. Any wording going beyond 15.2 risks
being classified as an unfair term (Law 193/2000), with the consequence that the
term is void **and** administrative liability follows. Firm recommendation: do
not extend the exclusion. The real protection comes from Sections 3 and 7 — the
intermediary structure — not from limiting liability.

Additionally: Directive (EU) 2024/2853 on liability for defective products may
attach liability to the online platform where the responsible economic operator
cannot be identified. That is one more reason why displaying each producer's full
details (7.2) is not optional.

## ⚠️ LAWYER — Customer Section 18.4 (ODR)

The European ODR platform ceased operating during 2025, following the repeal of
Regulation (EU) No 524/2013. The obligation to display the ODR link — a classic
requirement for Romanian online shops — may no longer apply. Confirm the current
position and keep or remove the reference accordingly. The ANPC link and the SAL
structure link remain mandatory in any case.

---

## Decisions to make before taking the text to a lawyer

1. **Do we verify producers' documents or not?** The answer rewrites Section 4, customer 7.4 and all the marketing on the site. "Partly" is not an available answer.
2. **Do we offer the commercial guarantee (producer 14 / customer 14.4)?** Without it, the commercial proposition is weaker than a free local selling group. With it, you take on a treasury risk that is cappable and recoverable from the producer.
3. **What weight tolerance?** Or move to authorise + capture at weighing.
4. **Exact deadlines** for complaints, producer response, platform decision, balance retention.
5. **Mandatory insurance threshold** for producers and the point from which you impose it.

## Technical preconditions

| Precondition | Status |
|---|---|
| Stripe Connect with immediate transfer to the producer (3.4) | **done** |
| "Order with obligation to pay" button (9.3) | **done** |
| Full price breakdown before payment (10.1, 10.2) | **done** |
| Minimum order value shown with the shortfall (10.3) | **done** |
| Platform does not store the producer's IBAN (11.6) | **done** |
| Separate acceptance, unticked by default, version + date + IP stored | **done (signup)** |
| Each producer's full details displayed publicly (7.2, Art. 30 DSA) | partial — no CUI/registered office on the public page yet |
| Order confirmation email with all pre-contractual information (9.4) | not yet — email block |
| Mandatory food labelling fields before publishing a product (9.2) | not yet — Phase 2 |
| Per-product marking of whether withdrawal applies (13.2) | not yet |
| Popularity indicator separated from real reviews (5.3) | not yet — Phase 2 |
| "Bio" label conditional on a validated certificate, auto-expiring (9.4) | not yet — Phase 2 |
| Working dispute system with measured deadlines (producer 15) | not yet — Phase 2 |
| Account deletion and data export (8.3) | not yet — legal block |
| Acceptance at order placement, not only at signup | not yet |

## To ask the lawyer explicitly

- Confirmation that the collection-mandate structure survives reclassification under PSD2
- Review of the indemnity and set-off clauses from the point of view of B2B contractual balance
- Review of the non-circumvention clause from a competition law standpoint
- Verification of micro-enterprise classification for the P2B Regulation exemptions
- Impact of Directive (EU) 2024/2853 on platform liability
- Current status of the obligation to display the ODR link
- Tax treatment of the fee and DAC7 reporting obligations
