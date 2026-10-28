# DeepSeek-first private website studio

This is a small studio tool for finding suitable Houston service businesses and preparing private website proposals. DeepSeek is the default for research, design instructions, site code and repairs. A separately tested image-capable model reviews real photographs and screenshots. Your verdict remains separate from the AI checks.

**Implementation is complete for the bounded pilot. Live provider acceptance and an actual Hostinger deployment remain outstanding.** Keys, account permissions and useful source coverage have to pass real checks; entering a key cannot guarantee good leads or good design.

## What to open

Run the app and open **Setup & API keys**, then **Automatic drafts**. For a business you already know, Business intake can build from supplied facts/photos with tested text/vision providers and Chromium; the source accounts are required for the automatic lead pilot. Existing users keep their earlier records and Business intake. Once an API profile is saved, legacy external-work routes are held so they cannot bypass the new allowance. Read-only history and manual/CSV records remain accessible.

```sh
npm ci
node scripts/install-studio-runtimes.mjs
npm run init
npm start
```

Use Node 24.13+ and Python 3.12 on Linux x86_64. The isolated runtimes have pinned packages and lockfiles. This installation does not download a browser implicitly. Install matching Playwright Chromium explicitly, or set `FACTORY_BROWSER_EXECUTABLE` to your installed Chromium. Download genuine Camoufox explicitly with `node scripts/install-studio-runtimes.mjs --fetch-browser`. Browser download access is a separate prerequisite.

Set both `FACTORY_STATE` and `FACTORY_DB` for another private state location. For inspection without job execution, set `FACTORY_AUTORUN=0`. Never share a real state directory with fictional proof scripts. Starting the app can resume previously authorized owned jobs; it does not activate a new pilot.

## Which services do what?

| Service | Job | Requirement |
| --- | --- | --- |
| DeepSeek | Default research, creative planning, code and repair | Direct API key and tested JSON/coding capability |
| OpenRouter | Default actual-image/screenshot review | API key and a model that passes the vision canary |
| OpenAI | Alternative text/code/vision provider | Optional; uses the Responses API |
| Other compatible AI | Configurable task provider | Register a public HTTPS chat-completions endpoint and explicit model; pass the relevant checks |
| Google Places | Current discovery pointers, status, listed site and business phone | Required for this pilot; account-specific permitted use and retention must be confirmed |
| Apollo | Company matching and bounded work-contact enrichment | Required account features; an empty match stays empty, and is not a published contact or buying interest |
| Firecrawl | Bounded website search and managed extraction | Required; failures do not establish website absence |
| Scrapling 0.5 | Parse actual retrieved HTML into text, links, contacts and image references | Installed isolated Python runtime; real extraction check |
| Camofox 1.18.1 | Fresh public rendering for pages needing a browser | Genuine browser plus the authenticated Factory guard and broker |
| Overture | Advisory, source-preserving open-data baseline | Optional bounded local Parquet import with the actual release/licence notice; not a verified unattended feed |

A ChatGPT subscription does not provide DeepSeek, OpenAI or OpenRouter API credit. The default model IDs are editable; account/model availability must be tested. Failed tasks do not silently switch providers.

## Setup once, test before running

1. Enter keys in the private Setup screen, or use the documented environment variables. Key files are immutable, mode 0600, outside SQLite and backups. Key values are never returned by status APIs or stored in browser storage.
2. Select models and task roles. DeepSeek handles code by default. Do not select a text-only model for screenshot review.
3. Confirm current account-specific token prices, fixed per-request ceilings, pricing references and any subscriptions/fees. Zero-price profiles require an explicit finite free-request allowance. Rate confirmations expire after 30 days. Do not purchase a subscription through the app; no purchases are implemented.
4. Confirm the intended source use, retention and attribution under the actual account agreements. The app cannot establish that a provider permits prospecting or durable storage merely from a checkbox. If the intended use is prohibited, use a suitable licensed source before collection.
5. Save. This makes no provider call. Test each required connection explicitly; tests may consume credits. A canary checks a small actual response and the required feature schema. It does not prove useful Houston coverage.
6. Start the two private Camofox services and run **Test installed readers**. A health response alone is insufficient: the check requires installed Scrapling extraction and actual guarded browser extraction.
7. When the blockers are resolved, explicitly start the private pilot. The separate VPS timer is what supplies future daily queue ticks.

Proxy-bound cloud secrets can be entered securely in environment settings. On your VPS, use the app's private key vault or a restricted environment file. Never paste keys into chat, commit them or copy this cloud machine's authentication.

## The actual flow

```text
Explicit start + saved target + tested services + allowance
  → Google discovery: fixed cohort of up to 30 stable identities
  → obvious exclusions: closed, conflicting identities, independent sites
  → two bounded website searches + Apollo company/contact checks
  → independent public pages: Scrapling → guarded browser → permitted managed extraction
  → literal evidence checks and prepared private images
  → source-checked opportunity or a retained hold with its reason
  → frozen business facts/media/provider profile
  → creative brief → three real rendered opening designs
  → image-capable model compares actual desktop/phone screenshots
  → DeepSeek builds the selected five-page static site
  → real browser/accessibility/interaction checks + factual audit + visual critique
  → bounded repair, or a clear retained failure
  → exact private ZIP → your exact-version verdict
```

The initial limits are ten investigations per Chicago date, one proposal per date, three automatic proposal attempts total, and ten AI attempts per proposal including failures. Daily work becomes due at 09:00 America/Chicago; the first explicit start may queue immediately. The cohort does not refill with easier records when checks fail. Changing target settings cannot reset its history. The pilot stops when the fixed work is finished or unsupported; expanding beyond it is a later explicit decision based on actual results.

A source-checked opportunity needs a matched identity, Houston service area, operational listing, at least three literal service facts, a published contact in quoted business context, supported activity within 90 days, two independent public publishers and complete bounded website searches. Contradictory identity/site evidence causes a hold. Search failures and missing fields are not evidence of absence. A listed phone has not been called; reachability and interest in buying remain unknown.

Public pages are untrusted data. Readers use fresh guest sessions, no personal cookies, HTTPS/public-network checks, redirect/subresource guards, output limits and cleanup. Login pages, challenges and private-network destinations remain held. Camofox is not a lead database or a guarantee that social platforms are accessible.

## Photos, websites and review

Matched business-posted public images can be prepared for private concepts under the saved operator choice. Original hashes, source page/account, derivative hashes and the unconfirmed-rights status travel with the media. Download failures use the explicit photo-free design profile. The app does not fabricate a portfolio to fill missing pictures. Public use still needs appropriate permission.

Generated websites are static, mobile-first five-page proposals. They can include native interactive galleries, filters, disclosures and progressive motion. They do not get a server, database, working lead form, payment processing or a booking system automatically. Contact actions use the verified phone/email/booking destination. No model-supplied command or server code executes.

Technical checks cover five pages at five widths, accessibility, contacts/assets, no-JavaScript behavior, interactions and supported motion behavior. Real screenshot review and a factual audit follow. These are useful checks, not a guarantee of exceptional design or complete factual correctness.

Open the job, try desktop and phone, inspect the three opening designs, review the evidence and download the private package. Record your own **Accept** or **Request changes** verdict for the exact digest. It is labelled an operator declaration; it does not become customer approval, media permission or publication. To make a new supplied version, prepare and confirm a revised Business intake brief. Earlier bytes remain intact.

## Spending, failures and recovery

The agreed allowance is **$100 total for the first pilot**, including declared provider fees. Each app-managed call reserves a conservative amount in SQLite before sending. Unknown costs keep the full reservation; token estimates use declared prices. A reported cost above its ceiling stops further spending. This is an app ledger based on your rates, not an independently audited account-wide hard cap. Also set hard limits in provider accounts where available.

Exact request replay reuses retained results. Failed or ambiguous paid attempts are not retried automatically. A timeout can have cost money: inspect the receipt and acknowledge the exact unknown attempt after it is no longer active. The reservation stays consumed. Provider outages pause the pilot; fix the connection and explicitly resume. Exhausted limits do not reset on restart, key changes or profile edits. Saving a changed profile invalidates its old connection checks and queued source proofs.

Google pointer fields and cached responses expire according to the confirmed retention window; stable place IDs and spend receipts remain. The private backup omits Google's cached payloads even before expiry and preserves source-independent evidence/media, source code and cost receipts. No credential files enter it. This does not certify contractual compliance for every source, public fact or backup.

Nightly idle snapshots retain seven successful local backups and verify a separate-root restore. They are local disaster-recovery copies, not encrypted off-server backups. A restored API workspace is paused and blocks paid calls until you check provider accounts and declare total lifetime pilot spending, including work after the backup. That total can only add consumed allowance. Resume explicitly for a future Chicago date; the restore day cannot repeat a daily slot. Restore does not recover missing API keys.

## Hostinger VPS

Use the reviewed Ubuntu 24.04 x86_64 installer and service units in [deploy](../deploy/README.md). The app, preview origin, upstream reader and narrow broker stay on loopback. The reader runs under a separate account without app state/provider keys. Use SSH tunnels for the initial private pilot. Domain access needs two distinct HTTPS origins, authenticated Nginx access to both, DNS and certificates.

The queue timer and backup timer are separate from actual job execution; the persistent app service owns workers and restart recovery. Nginx is not made public automatically by the installer. Actual VPS installation, browser sandbox behavior, HTTPS/authentication, account access and a 72-hour restart/outage/restore soak must be verified on that server. None has been claimed from local fixture tests.

## What is proven, and what comes next?

See [validation](DEEPSEEK-VALIDATION.md) and [the visual walkthrough](STUDIO-WALKTHROUGH.html). Tests use fictional businesses. Real Chromium rendering, Scrapling parsing, DuckDB import, SQLite accounting and exact ZIP checks are distinguished from injected provider replies.

Live acceptance uses one frozen 30-business cohort: manually audit identity/activity/geography/contact/website status, target at least 80% discovery accuracy and five suitable opportunities, produce three real proposals and have at least two accepted by you on actual desktop/phone review. Then run the actual VPS for 72 hours, including an outage, restart and verified restore. These are acceptance targets, not completed outcomes or yield promises.

Current outside prerequisites: provider accounts/keys and suitable plans, confirmed data-use rights, network access to provider/public-source/browser-download destinations, genuine Camoufox installation, and Hostinger access. Low real yield means revising the target or licensed source mix; repeatedly running the same failing search does not solve it. Outreach, public delivery and ongoing client-site maintenance remain later, separately authorized work.
