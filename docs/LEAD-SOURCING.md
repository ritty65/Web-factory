# Lead sourcing: Apollo and alternatives

Recommendation: start with a small source-comparison experiment, not a subscription or a large automated campaign. No provider was purchased, connected or queried for business leads in this review. Provider availability, current prices, quotas and contractual storage/display rights must be checked against the plan actually offered to you; links below are references, not a current pricing audit.

## Two different problems

**Business discovery** asks which real local businesses fit our city/niche and have an observable website opportunity. **Contact enrichment** asks how to reach the appropriate person or published business channel. Apollo may help with the second problem and some company discovery, but it does not replace direct website assessment or establish intent to buy.

| Option | Best role to evaluate | Main limits / integration implications |
|---|---|---|
| Manual shortlist + owner referrals / CSV | Fastest way to prove the assisted product with known suitable businesses | Operator effort; validate identity and provenance; CSV UI not yet implemented |
| Approved local-business listings / Google Places API | Local category/location discovery and stable place identity | Review current API fields, allowed storage/display and attribution; a missing website field is only a clue; Google Places is not connected |
| Overture / existing PlaceRoot bridge | Open-data discovery pointers, category/location exploration | Existing bridge is Houston-specific, strict, cold-query/provenance failures appear in bundled history; needs installed pinned runtime and measured source proof |
| Licensed local-business data provider | Potentially broad local coverage and exportable commercial data | Test locality accuracy, freshness, website-field coverage, permitted retention and real cost per qualified business; evaluate contracted provenance |
| Apollo | Company/person search and optional decision-maker enrichment, especially businesses with organized B2B profiles | Measure coverage for small local operators; plan/API rights and credits vary; contact validity is not permission or buying intent; no adapter exists |
| Firecrawl | Existing public web-search adapter and optional source research | Current app uses it for search only; separate page reader still needed; not a lead database or qualification guarantee |

## Suggested experiment

1. Define a single frozen Houston/detailing sample and qualification rules before seeing results. Compare manual selection with one local-data source and, optionally, Apollo. Do not silently replace failures to make yield look good.
2. Use equal sample sizes or explicitly account for source overlap. Normalize names, phone E.164, canonical domains, place/provider IDs, location and contact channel. Keep originals and merge history.
3. Independently inspect identity, recent activity, website/booking presence, useful media and reachable business contact. Record “unknown” separately from an exclusion.
4. Manually audit every proposed qualified lead in the initial small sample. Report duplicates, wrong-city/wrong-category records, stale businesses, missing websites vs actual website findings, contact coverage, evidence completion time and cost.
5. Build the best three passing opportunities, then compare site quality and operator effort. Judge sources by cost per genuinely qualified opportunity, not rows returned or emails found.
6. Add enrichment only if contactability is the actual bottleneck. Do not pay to enrich excluded or duplicate businesses.

## Adapter contract to implement

Each adapter returns `source`, `providerRecordId`, `retrievedAt`, `name`, `location`, `categories`, `websites`, `socials`, `businessContacts`, `provenance`, `licenseOrContract`, `limitations` and `usage`. Optional fields remain null/empty. Source records enter an unverified intake stage. A shared evidence normalizer and gate evaluator decide qualification; adapters cannot set “qualified,” media rights, human approval or commercial success.

Add request idempotency, bounded retries for safe read failures only, per-provider throttles, cancellation, replayable sanitized receipts, spend reservation, consumed-attempt accounting, durable errors and duplicate/suppression checks. Keep raw personal data out of public artifacts. For outreach, record approved channel, opt-outs and retention policy; evaluate applicable source terms and marketing rules for the actual campaign.

Official starting points: [Apollo API documentation](https://docs.apollo.io/), [Apollo plans](https://www.apollo.io/pricing), [Google Places policies](https://developers.google.com/maps/documentation/places/web-service/policies), [Google Places API](https://developers.google.com/maps/documentation/places/web-service/overview), [Overture Places](https://docs.overturemaps.org/guides/places/), [Firecrawl docs](https://docs.firecrawl.dev/).
