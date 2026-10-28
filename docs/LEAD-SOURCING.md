# How reliable lead sourcing will work

Houston is the confirmed first market. Detailing is the small initial test category, not a restriction on the future product. City and service rules are editable in Lead workspace.

The goal is a short list of real businesses with an evidenced website opportunity and a published business contact. A long list of directory records is not success. No provider can guarantee current facts, an endless supply of suitable businesses, buying intent or sales.

## Implemented flow

1. Save the target cities, service phrases and excluded phrases. These rules only prioritize research. A name/category match is not verified service fit; a listing address is not a verified service area.
2. If the account agreement permits this use, discover up to 20 pointers through the Google Places API. Persist the attempt before sending it, record the actual returned cohort, quarantine closed/malformed rows, and never replace bad rows to improve apparent yield.
3. Normalize phones and deduplicate provider IDs and exact name/location identities. Preserve provenance. Conflicting contacts and shared phones hold both identities for review. Suppression cannot be cleared by a refresh.
4. Automatically screen for dated sources, area/service matches, known websites, conflicts and missing contacts. Exclude listed independent websites from the no-independent-site lane. Social/booking pages and blank website fields still require research.
5. Optionally search a second source with Firecrawl. The daily workflow checks up to three strong pointers, within a shared three-attempt rolling quota. Search results can flag possible independent sites and identity/phone clues. They cannot prove that no website exists, that a business operates now, or that a phone will answer. Potential website conflicts remain held across refreshes until explicitly reviewed.
6. Show a ranked queue with concrete reasons and next tasks. Complete the six dated evidence checks before selecting a business. An operator review is labelled as a declaration; it is not independently authenticated qualification. Lead operations never start websites or send messages.
7. On the VPS, an explicitly enabled timer runs one due search per Chicago date and rotates up to 12 saved search areas. Exhausted areas are skipped. Pause when all areas have returned zero new identities three times, or when a source/research attempt fails or becomes uncertain. Inspect and explicitly resume; no silent paid retry or provider switch.

Daily limits are three primary attempts and three secondary attempts per rolling 24 hours, shared with manual actions. The scheduler makes at most one primary attempt per date. These are request limits, not a dollar guarantee. Provider field selection affects billing. Configure provider-side quotas and billing monitoring too; budget alerts alone may not stop charges.

## Source choice for long-term use

**Do not treat the Google adapter as approval to build a permanent prospecting database.** Current Google Maps/Places terms, caching restrictions, attribution, permitted export and the intended prospecting use must be assessed for the actual account. This code retains business fields and history; it does not yet implement provider-specific deletion/retention rules. The terms checkbox records an operator decision, not a contract assessment. Keep sustained Google collection disabled unless the intended use and retention are permitted and enforced.

For a durable business database, evaluate an openly licensed source such as **Overture Places**, or a commercial provider whose written agreement explicitly permits storage, enrichment, export and sales prospecting. Preserve each record's original source, release/update date and applicable notices. The imported app has an experimental Houston/PlaceRoot bridge for Overture. It is separate from the new scheduler, needs its own installed runtime and source validation, and is not certified as a working unattended feed. Dataset refresh dates do not prove that individual businesses are still open.

The shared screening/research queue is the reusable part: a new source must enter as dated unverified pointers with stable IDs, permissions, usage and durable failure receipts. Do not silently replace a failed API with browser scraping. After a source passes a small locality/freshness/contract audit, add its adapter and rerun the same fixed-cohort tests.

**Apollo is optional later.** It may help find decision-makers after suitable companies have been identified. First measure coverage for Houston owner-operated businesses. It does not replace local discovery, website checks or contact permission. No Apollo plan, integration or current pricing has been validated here.

**Camofox is optional research tooling.** A browser is not a licensed lead database. Its adapter currently exposes diagnostics only; it is not a fallback source in this pipeline. Automated research currently uses API results and does not depend on bypassing social-site access restrictions.

## What is actually proved

The reproducible app proof uses 18 fictional listings through an injected provider transport. It exercises real service operations, SQLite persistence, daily scheduling, secondary research, screening and the browser UI. Three closed/malformed rows are quarantined; 15 unique pointers remain; three known independent websites are excluded; three additional possible websites are held; wrong-area, wrong-service and shared-phone cases remain unresolved. Replaying the date makes no further requests. Desktop/phone accessibility and overflow checks are recorded in [the proof result](visuals/lead-pipeline-proof.json).

These are software checks, not live leads. No live provider completion, actual qualified-lead count, contact reachability, sustained yield or customer conversion has been established. Source endpoints were denied by the current cloud network, and neither API credential is configured.

## The first live acceptance test

1. Enable the source destinations in cloud settings, add account keys securely, and verify the actual permitted use. Use a provider-specific retention plan before retaining real data beyond the allowed period. No keys in chat or Git.
2. Save Houston and one service as a fixed target. Start with one explicit search. Keep every returned row, exclusion, duplicate, error and unknown in the denominator. Do not repeatedly search until a favorable sample appears.
3. Manually audit one fixed cohort of 30 unique businesses using independent sources. Record city/service accuracy, closure rate, duplicates, website false positives, contact ownership/coverage, evidence gaps, review time and actual spend. A published phone is not proof it will answer.
4. Proposed acceptance targets, not forecasts: at least 80% correct active local/service identities, at least five genuinely suitable website opportunities, and sourced support for every shortlisted factual claim/contact. Audit every shortlisted business before the first private proposal. If the source fails, fix/change it before scaling.
5. Only then test three consecutive scheduled days on the actual VPS, including a simulated outage, restart and pause. Check source quota, no duplicate charges, stale-data alerts and restoration from backup. Track new suitable opportunities rather than rows returned. Expand categories only after observing acceptable accuracy and costs.

Use `npm run leads:proof` for the isolated fictional app proof, and `npm run leads:health` with the real private state variables for the local health/yield report. Health reports have no external side effects. The dashboard alerts when a configured schedule has no completed run for over 36 hours; service failures also reach systemd logs. External email/SMS alerting is not implemented.

Official references, whose current content and account applicability must be checked before live adoption: [Google Places policies](https://developers.google.com/maps/documentation/places/web-service/policies), [Maps Platform terms](https://cloud.google.com/maps-platform/terms), [Overture Places](https://docs.overturemaps.org/guides/places/), [Overture attribution](https://docs.overturemaps.org/attribution/), [Firecrawl search](https://docs.firecrawl.dev/features/search), [Apollo API](https://docs.apollo.io/).
