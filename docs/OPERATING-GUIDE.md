# Using Web Factory

> Current API workflow: read [DeepSeek-first pilot](DEEPSEEK-PILOT.md), [validation](DEEPSEEK-VALIDATION.md) and [actual UI walkthrough](STUDIO-WALKTHROUGH.html). The earlier sections below describe the legacy workflow, including its separate quotas and former diagnostics-only Camofox behavior. Those paid entry points are held once the new API profile is saved.

## Start with one business

Use Node 24.13+ and install the locked packages with `npm ci`. Use the system Chromium path or install the matching Playwright Chromium. For a ChatGPT/Codex proposer:

```sh
npm run init
export FACTORY_MODEL_BACKEND=codex
export FACTORY_BROWSER_EXECUTABLE=/usr/bin/chromium
npm start
```

Codex must be installed and signed in as the account running the app. The app reuses that sign-in without reading/copying credential files. The VPS needs its own sign-in. Account limits and network access still apply. The project-local `agent-browser` is now installed with the app; lifecycle scripts remain disabled.

**Business intake** is the simplest path:

1. Enter the business name, area, type, real source/profile URL, summary and at least three real services.
2. Enter the actual phone, email or booking destination and choose the primary customer action.
3. Confirm the accuracy and permission statements only after checking them. Save the brief. Saving makes no external request.
4. Optionally upload JPEG/PNG/WebP photos you own or may use for a private concept. The browser accepts files up to 12 MB / 24 megapixels and prepares a bounded WebP copy locally before upload. Keep your full-resolution original. The API accepts prepared files up to 675 KB; the server independently checks format/dimensions, removes metadata from the web copy and binds the hashes/permission to this brief. Save again to attach uploads.
5. Check model/browser availability, then explicitly build the saved version. The job gets a frozen copy of the brief. It can make one model attempt; an uncertain failure is held. A new version needs an explicit Save and Build. Three attempts per brief are allowed, including stopped work.
6. Inspect the private website, phone layout, QA report and exact review ZIP. Technical success is separate from factual/creative review and public media permission. Version notes do not approve, send or publish.

This supplied-content path creates one five-page concept per explicit build. It does not run the legacy three-study/research sequence or turn an unverified prospect into a qualified lead. The old research-led workflow remains separate and still needs its own model/source-tool integration.

## Keep the lead list trustworthy

**Lead workspace** accepts manual businesses and small CSV imports without any API subscription. A CSV uses these headers:

```text
name,area,sourceUrl,observedAt,phone,website,sourceId
```

The first four columns are required. Observation dates need a timezone. Import at most 100 rows at once. Text/formula-looking fields are handled as literal data, never executed. The app retains sources, quarantines stale/invalid rows, deduplicates exact name/area or matching provider IDs, flags conflicting contacts and preserves suppression. A shared phone alone does not merge different names. Ambiguous branch/franchise identity needs manual resolution; automated deduplication cannot certify legal identity.

Every pointer starts unverified. Review these six checks with a dated source and a clear observation: identity, location, current activity, website opportunity, reachable contact and enough factual content. A high-level operator-reviewed label still does not establish buying intent, consent, a successful sale or build authorization. Evidence expires; importing fresh pointers does not refresh old review dates. Suppression stays sticky. No pointer is automatically imported into the original qualified-candidate table.

## Optional local-business discovery

A Google Places Text Search adapter is available. Add `FACTORY_GOOGLE_PLACES_KEY` through secure environment settings, restricted to the Places API and the account's application/IP restrictions as appropriate. Enable billing/API access in the actual Google account and set account-side quotas/budget alerts. Review current storage, display, attribution and backup rules first. Google API fields/tiers can affect charges; the app does not quote dollar prices.

One explicit search requests up to 20 pointers, with no additional pages or automatic retry. The global allowance is three request attempts per rolling 24 hours. Failed/uncertain work stays consumed. Invalid/closed records are quarantined without replacements. A missing website field is **unknown**, never proof that a business lacks a website. Provider contact data is not proof of purchase intent or permission for outreach.

After a lost response, retrying the same request retrieves the saved receipt. The browser retains a source request identity across reloads in its private origin's session storage. Server request IDs are the authority. A stranded requesting record blocks new paid-capable work. Use the exact `leads_source_resolve` operation to acknowledge an old-enough attempt as uncertain; this does not refund or retry it. Manual/CSV intake remains available during provider outages.

Provider data retention and contractual compliance are not certified by this release. Configure retention/export/deletion and attribution for your specific source agreement before sustained commercial collection. Do not treat private DB backups as exempt from provider terms. For large-scale production, choose a provider whose contract explicitly permits your intended storage and use, and measure its quality against an audited fixed cohort.

## Daily automation

The daily schedule is **off by default**. In Lead workspace, choose a category, area and Chicago hour, review the provider terms/attempt limits, and explicitly enable it. Then install the private service-user timer described in `deploy/README.md`.

The timer checks every five minutes. At most one due attempt is reserved per **America/Chicago calendar date**, even across daylight-saving repeats, config edits, lost responses or crashes. The three-attempt rolling quota also applies to manual and scheduled calls together. A missing key is reported without consuming a slot. A provider failure is retained without an automatic retry that day. A crash during a reserved slot remains visible; it is not silently restarted. “Pause daily discovery” stops future slots and retains history.

The scheduler discovers unverified pointers only. It does not qualify them, build websites, send messages or publish. Look at saved outcomes and service logs; notification/email integrations are not supplied. Systemd process restart and timers support recovery, but do not guarantee provider uptime or useful lead yield.

## VPS and Camofox

Use a Hostinger VPS for the running app. The reviewed templates in `deploy/` keep Node on loopback, use a dedicated user, restart owned processes, and support an HTTPS reverse proxy with authentication. App and previews require distinct origins. No VPS was deployed in this task; DNS, TLS, account sign-in, auth, firewall, Chromium behavior and backups still need verification on your machine.

Camofox remains an optional diagnostic connection. Its public package supports persistent sessions and cookie import, so it needs a separate isolation review before serving as a trusted source reader. The installed fresh-session `agent-browser` path has been exercised against a local fixture. That does not establish access to any particular real social page. Blocks/login requests remain holds; neither browser guarantees that social pages are readable.

## Acceptance before unattended use

- A clean locked install and full offline suite pass.
- Actual model sign-in **and one bounded generation** succeed; a CLI version alone is insufficient.
- One small explicitly authorized live source request succeeds and each proposed lead is audited by a person.
- One real supplied business produces an accurate, appealing private site. Test the actual contact/booking action.
- Wrong-origin/missing-session requests are denied; both hosted origins require the operator login; internal ports remain private.
- A paused schedule makes no calls; restarted/failed requests do not duplicate work or reset quotas.
- Off-server backup and a separate-root restore are exercised, with source/customer retention requirements reviewed.

The current implementation is an operator-assisted product foundation. A failed integration, unknown fact or missing credential stays visible. Do not call it an autonomous lead-to-paying-customer service until a real pilot supports that claim.


## Lead reliability update

Lead workspace now starts with pipeline health and the ranked review queue. Save your city/service rules under **Choose which businesses fit**. Use the **no independent website** lane; listed independent sites are excluded, while missing fields remain unknown. Ranking is research priority, not buying probability.

The optional secondary search needs `FIRECRAWL_API_KEY` for `api.firecrawl.dev`. An explicit one-lead check is available in its evidence panel. Enabling the schedule's separate secondary-search checkbox authorizes up to three such searches daily; enabling discovery alone does not. Both provider terms and real data retention/export rights must allow the proposed use. See [lead sourcing](LEAD-SOURCING.md) before adopting a permanent source.

Enter one search area per line to rotate daily searches. The schedule skips an area after three zero-new-identity responses and pauses once all areas are exhausted. A provider/research failure pauses future work, retaining rows, errors and consumed attempts. Inspect the reason before explicitly resuming. A stranded secondary request can be acknowledged through `leads_research_resolve` with its exact ID/start date after two minutes; this never refunds or retries it. The VPS lead service timeout is 120 seconds to accommodate one primary and up to three bounded secondary requests.

A secondary search may find a possible independent site. That conflict stays held across later listing refreshes. Inspect the candidate sites, save a specific later website observation, and explicitly resolve the conflict in the evidence form if appropriate. A missing search result is never evidence that a site does not exist.

Read `leads_health` for fixed-cohort new/refresh/held counts, current gaps and scheduler alerts. Read `leads_research_status` for secondary quotas/unresolved requests. Neither operation calls a provider. The saved environment key requirements are optional configuration slots, not connected accounts. Automatic discovery remains disabled in real private state until live acceptance.
