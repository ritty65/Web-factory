# Using Web Factory

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
