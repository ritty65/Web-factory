# Implemented intake and lead foundation • 28 October 2026

## Delivered code

- Ordinary business-brief fields and bounded private photo uploads; no hand-authored evidence JSON needed for the supplied-content path.
- Separate source-backed lead pointers, manual and CSV imports, duplicate/conflict holds, sticky suppression, six explicit evidence checks, stale-evidence handling and real SQL pagination.
- Optional fixed-endpoint Google Places search with proxy-aware TLS, retained failed/uncertain requests, no blind retry, quarantine and a shared three-attempt rolling quota.
- Opt-in daily Chicago-time discovery with persistent one-use date slots, DST handling, pause, missing-key outcomes and no automatic proposal generation/outreach.
- Explicit ChatGPT/Codex proposer adapter, read-only tool-disabled invocation, stdin prompts, strict output handling and private request/usage receipts. Source-provider keys are removed from the model child's environment.
- Frozen supplied-content proofs and photo metadata, owned background jobs, one model invocation per build, stopped-work retention, exact QA/site digest binding and private ZIP packaging.
- Project-local agent-browser, configurable Chromium, separate hosted app/preview HTTPS origins with Host/Origin/CSRF checks, VPS service/timer/authenticated reverse-proxy templates and updated setup instructions.

## Executed evidence

The final full frozen-code run passed **1,420 tests**, with **zero failures, cancellations or skips**, in **314.304 seconds**. Command: `FACTORY_BROWSER_EXECUTABLE=/usr/bin/chromium npm test`. No assertions, source checks or qualification gates were disabled. See IMPLEMENTATION-TEST-RESULTS.json.

- Source/lead/scheduler checks are included in the full run. They cover malformed CSV, literal text, stale sources, duplicate/contact/provider identity conflicts, provider errors, missing keys, request replay, quota, concurrency, stranded attempts, closure evidence and explicit newer conflict review.
- Supplied-content staging and real browser checks: a **fictional** five-page model-response fixture passed the real isolated Chromium QA (25 page/width checks, accessibility/interaction checks, actual captures), hash binding and ZIP packaging. The generator input in this test was a fixture, not a live model output.
- Actual installed `agent-browser` opened/extracted/closed an owned local page in a fresh allowlisted session. Real public/social access remains unverified.
- Implemented UI screenshot smoke: **6 view/width combinations**, intake and lead workspace at 1440/390/320, no observed overflow, no Axe violations or JavaScript errors. Axe incomplete checks are retained for manual judgment. Fake business records are clearly named fictional. No model/source calls were made by this capture script.
- HTTPS-origin tests cover wrong hosts, forwarded-header spoofing, same-origin mutation, wrong Origin, invalid origin configuration and separate previews using local HTTP fixtures.
- systemd service/timer templates passed static verification after using portable `/usr/bin/env node` startup. They were not installed or started on a VPS. Nginx runtime/TLS/operator-login behavior remains to be checked on the target host.
- A multi-megabyte, high-detail phone-photo fixture was resized in the real browser, stored privately and attached only after an explicit brief Save. The API body/image limits stayed unchanged.
- Private intake photos, dependency-install controls, and exact source/state restore hashes passed the fresh-root recovery checks. Cross-operation record IDs cannot overwrite a source schedule or bypass its ledger namespace.
- Updated dependencies passed npm audit with zero known advisories after replacing the initially selected HTTP-client version with the patched 7.30.1 release. Lockfile/TLS verification stayed enabled; lifecycle scripts remain disabled.

## Live acceptance still blocked

The existing Codex CLI reports a ChatGPT sign-in, but the attempted minimal response hit HTTP CONNECT 403 to the ChatGPT endpoint. The running environment still reports enforced restricted networking at revision 1, while editable settings have changed. No successful live model completion is claimed.

No `FACTORY_GOOGLE_PLACES_KEY` is present in the running instance. Its secure requirement was saved to the environment draft; account billing/API restrictions, source terms/attribution/retention and a real small cohort still need validation. No real lead-provider request or new paid subscription was made.

No real business brief/media was supplied for a customer pilot. No real generated customer website, human acceptance, contact, sale or public customer deployment resulted from the fictional tests.

Hostinger VPS access, actual domains, DNS, TLS and operator authentication were not provided. Deploy files are templates. This cloud's ChatGPT auth must not be copied to a VPS. Camofox remains diagnostics-only until its actual service and isolation/egress contract are tested; the installed guest-reader path does not depend on it.

The remaining acceptance sequence is: apply the intended network settings, verify one bounded Codex completion, supply the Places key securely and audit one bounded live cohort, supply one real business/content, review the actual generated site, then deploy/test the private VPS setup with the real domain and account. Tests establish software behavior, not provider uptime or commercial success.


## Lead reliability follow-up — 28 October 2026

Implemented target-specific research ranking, per-source cohort/new/refresh/held counts, two-sided shared-phone holds, atomic source import/final receipts, daily area rotation, saturation pauses, failure pauses and optional bounded Firecrawl secondary research. Possible independent-site clues stay held across source refreshes until a later explicit review. New rules and research adapters are included in the production policy inventory. The private timer timeout now covers one primary plus up to three secondary requests.

Validation of the stable code: **1,469 full-suite tests passed, zero failed/cancelled/skipped**, in 299.277 seconds with Node 24.19 and system Chromium. The focused lead suites passed 103 cases. The actual browser suite passed five cases, including saving target rules and a rotating research schedule without starting any external work. Desktop/390/320-pixel proof views passed Axe, overflow and page-error checks. `systemd-analyze verify` accepted the updated service/timer; no actual VPS unit was installed or run. `git diff --check` passed.

The reproducible `npm run leads:proof` exercised the actual service/database/scheduler/UI with 18 fictional rows and an injected provider transport: 15 retained identities, three quarantined rows, three listed independent sites excluded, three possible missed websites held by secondary search, three pointers prioritized for further research, and nine needing evidence. One primary and three secondary fixture requests were made; a same-day replay made none. No real business, paid call, model completion, message, website build or qualification was claimed. See `docs/visuals/lead-pipeline-proof.json` and the desktop/mobile captures.

Remaining live blockers: neither `FACTORY_GOOGLE_PLACES_KEY` nor `FIRECRAWL_API_KEY` is configured, and official source/documentation destinations returned HTTP CONNECT 403 under the current cloud network policy. The saved draft now includes the optional Firecrawl credential requirement as well as Google Places. Saving a draft does not apply it. Actual live API schemas/coverage, field billing, account-specific permitted prospecting/storage/export use, provider-specific retention, a fixed real-business quality audit and three daily VPS runs remain unverified. The Google adapter is not certification of a durable licensed prospecting database; see `LEAD-SOURCING.md`.
