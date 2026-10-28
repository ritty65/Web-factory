# North Star: Web Factory

Product direction • 28 October 2026 • v1 proposal grounded in the uploaded code and the user's choice of local service businesses.

## What we are building

Web Factory helps a small website studio turn carefully chosen local service businesses into paying website customers by producing credible, business-specific website proposals efficiently. An operator stays in control of whom to target, which claims and assets to use, what to build, and what to deliver.

The promise: **find a business with an observable website opportunity, explain that opportunity with evidence, make a persuasive private website concept, then help the operator turn an approved concept into a maintained customer website.**

The initial product is an internal studio tool. A public multi-tenant subscription platform would be a later product with substantially different security and operations needs.

## Customer and first market

Primary user: an owner/operator selling websites to local businesses. Customer: an independent local service business that can benefit from more calls, quote requests or bookings.

Proposed first pilot: Houston mobile auto detailing, including businesses whose main presence is social media or a booking platform. Houston matches the present code; the niche is a proposal, not an already validated market choice. Use one niche and one city before generalizing.

Current policy excludes functioning independent websites in the no-site lane. The broader vision includes weak-site redesigns in a **separate, explicitly defined lane** after the first pilot. Do not silently reinterpret “no website found” as “has no website,” or treat a booking platform as a broken business.

## The end-to-end experience

1. **Choose a target.** City, niche, lead source, website-opportunity lane and explicit usage/cost limits. Show which integrations work before starting.
2. **Find and normalize businesses.** Import from an approved provider, a CSV or manual entry. Deduplicate by stable provider ID, normalized phone, domain and location; ambiguous identity stays unresolved.
3. **Qualify the opportunity.** Confirm the business identity, service area, current operations, website status, reachable business contact and useful content. Show dated sources, confidence and gaps. Supported private concepts may be queued automatically within the saved pilot authority; a provider result is not qualification.
4. **Prepare the brief.** Choose a primary conversion goal, services, differentiators, tone, factual claims, contact/booking destination, and approved imagery. Separate “not known” from “not applicable.” Show missing items as tasks.
5. **Make one private concept.** Create three distinct openings, compare real desktop/mobile renders, then build the selected complete proposal within the saved budget. Show actual stage/results and retained errors. Permit explicit bounded revisions.
6. **Review the exact version.** Present the site first. Technical checks, factual verification, media permission and human creative judgment are separate. Human approval binds a version digest and never becomes automatic approval after QA.
7. **Sell and hand off.** Prepare an editable outreach draft and review package. Operator controls sending, price, agreement and scope. Public customer review, deployment, domain connection and billing require new integrations and explicit customer/operator decisions.
8. **Maintain.** Track ownership of domains/accounts, backups, uptime, form delivery and support obligations after launch. This phase is a future capability, not delivered by the current package.

## Lead qualification: gates first, ranking second

A buildable opportunity needs the correct business identity and geography, evidence of current operations, an observed website opportunity, a reachable business contact, enough factual material for a useful concept, and a permitted media strategy. It must pass duplicate/suppression checks and have budget remaining.

Use gates to prevent unsupported claims. Then rank passing opportunities by observed website need, fit for the niche, conversion potential, content readiness and contactability. A possible initial ranking is 30/20/20/15/15 respectively; these are proposed weights to validate, not a trained score or a probability of purchase. No high score overrides a failed gate. A phone listed in a directory proves neither buying intent nor consent to marketing.

Social-only and booking-only businesses can have strong opportunities but may be difficult to verify automatically. Owner-supplied facts and photos should be a supported first-class assisted path with provenance. Such a path needs its own documented policy; do not weaken the existing automatic evidence checks to achieve yield.

## What “good website” means

A useful mobile-first website communicates what the business does, where it serves, why a customer should trust it, and one clear next action. It has distinctive art direction, readable type, deliberate imagery and appropriate motion. It accurately represents services and published prices; unknown prices are not invented. Contact links and booking destinations work. No fake reviews, fabricated guarantees, invented team or unverifiable awards.

Technical acceptance: navigation and primary conversions work, no missing media or console errors, no horizontal overflow across supported widths, keyboard access, reduced-motion support and no critical accessibility violations. Performance is measured rather than assumed. A small one-page pilot can be a later product option; the current engine expects a five-page proposal and needs an explicit contract change to support other sizes.

## What we measure

Primary business outcome: **customer-approved websites that reach paid delivery with positive contribution margin.** Count paid delivery only against the agreed payment/delivery evidence; today's sales desk records operator reports and does not verify bank settlement.

Early learning measures, with frozen cohort denominators:

- Qualification yield = businesses passing review / unique candidates examined.
- Proposal completion = review-ready proposals / explicitly started builds, including failed attempts in the denominator.
- Review acceptance = human-approved exact versions / reviewed proposals.
- Customer conversion = signed paid engagements / qualified businesses actually contacted.
- Cost per qualified lead and per accepted proposal = recorded provider/model spend plus attributable operator time / relevant completed outcomes. Unknown spend stays unknown.
- Contribution margin = collected revenue minus direct production, provider and delivery costs; track ongoing support separately.
- Time to first reviewable proposal and operator minutes per accepted proposal.

Suggested pilot acceptance criteria, **targets rather than forecasts**: review one fixed 30-business cohort; retain a reason for every exclusion/hold; identify at least 5 genuinely suitable opportunities; build 3 selected private proposals; have at least 2 accepted by the operator on real phone/desktop review; track every external call and failure. Only after that, run a separately approved outreach pilot and learn willingness to pay. Do not buy a large lead plan based on fixture success.

## Product boundaries

First release: one operator, local private workspace, one city/niche, assisted and source-backed intake, inspectable evidence, bounded generation, exact-version review and editable unsent contact plans.

Deferred: mass outreach, autonomous purchases, broad scraping, multi-tenant SaaS, public owner-review portals, domain buying, payment verification, production hosting and unlimited automatic retries. Defer a rewrite into another frontend framework until operator usability and customer demand justify it.

## Decisions and assumptions

Confirmed: local service businesses are the initial customer segment. Proposed: Houston/detailing pilot, assisted-first reliability, optional source-provider comparison and human-controlled delivery. Pricing, first customer acquisition channel, maintenance offer and future hosting are open business decisions. Start with fixed scope and explicit revisions; validate price with actual customers rather than embedding an assumed price into generated proposals.

## Definition of the next milestone

On a clean checkout, a developer can install and run the app; an operator can prepare one business with no hand-authored internal JSON; all missing prerequisites are clear; the system creates one real private proposal through configured integrations; the operator reviews desktop/mobile and requests or approves an exact version; costs, sources and errors remain visible. No end-to-end claim is complete until this real pilot succeeds.

## Current implementation and acceptance boundary

Houston is confirmed; the initial category defaults to mobile detailing. DeepSeek is the default for code and text tasks; a separately tested vision provider reviews real screenshots. The new API profile supplies guarded multi-source research, literal evidence gates, private photos with unconfirmed rights or a photo-free fallback, three opening designs, five-page production, bounded repairs, exact ZIPs and operator-declared version review. The first automatic pilot has a fixed cohort of up to 30 identities, ten investigations/day, one proposal/day and three proposals total under a shared $100 allowance including declared fees.

The older supplied-content and research-led workflows remain distinct in history. Once an API profile is adopted, their paid entry points are held to preserve the new metering boundary. There is no autonomous outreach or public release.

The missing proof is operational: real provider access/permissions, a real fixed-cohort audit, three actual AI-generated proposals with two operator acceptances, genuine Camoufox extraction and an actual 72-hour Hostinger deployment/restore/outage exercise. Offline tests do not satisfy those targets. See [the implemented guide](DEEPSEEK-PILOT.md) and [validation](DEEPSEEK-VALIDATION.md).
