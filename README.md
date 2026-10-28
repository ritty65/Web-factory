# Web Factory / Simulacra Factory

A local operator workspace for finding suitable local service businesses, verifying their evidence, producing private website proposals, and reviewing the exact output before any customer delivery.

**Current status:** the DeepSeek-first pilot is implemented: private multi-provider setup, a shared $100 allowance, Google/Apollo/Firecrawl source checks, real Scrapling and guarded Camofox adapters, an advisory Overture import, automatic private drafts, three rendered opening alternatives, browser/factual/visual checks, exact-version review and private VPS service templates. The local tests use fictional providers. Live lead yield, actual DeepSeek output, native Camoufox and the Hostinger deployment still require live acceptance.

Start with [the DeepSeek-first guide](docs/DEEPSEEK-PILOT.md), [actual validation](docs/DEEPSEEK-VALIDATION.md) and [the visual walkthrough](docs/STUDIO-WALKTHROUGH.html).

## Start here

- [North Star: product, workflow and definition of success](docs/NORTH-STAR.md)
- [Technical and product review](docs/APP-REVIEW.md)
- [Interactive proposed UI](docs/UX-PROTOTYPE.html) — open this file in a browser; illustrative data only.
- [Prioritized implementation plan](docs/ROADMAP.md)
- [Automated lead pipeline, source choice and live acceptance](docs/LEAD-SOURCING.md)
- [How to use the implemented flows](docs/OPERATING-GUIDE.md)
- [Private Hostinger VPS setup](deploy/README.md)
- [Original import validation results and limits](docs/VALIDATION.md)
- [Implementation validation](docs/IMPLEMENTATION-VALIDATION.md)

## Run locally

Use Node.js 24.13 or newer (Node 24.19 tested), npm, and Python 3.12 for the isolated source runtimes.

```sh
npm ci
npm run init
npm start
```

Open the loopback app URL printed by the command in a local development session. The app listens on port 8780; its read-only static website previews use a separate origin on 8781. Keep it on loopback. The default private state is `.factory-state/` in this checkout, ignored by Git. Stop with Ctrl-C. Services must restart after restoring a cloud snapshot.

For another private data directory, set **both** `FACTORY_STATE` and `FACTORY_DB`. For inspection without worker execution, set `FACTORY_AUTORUN=0` before starting. Use `npm run doctor` to see missing integrations; tool presence does not prove sign-in, model compatibility or successful business research.

## Test

```sh
# Install the locked source runtimes and matching browser on a fresh machine:
node scripts/install-studio-runtimes.mjs
npx playwright install --with-deps chromium
npm test
```

If Chromium is already installed, set `FACTORY_BROWSER_EXECUTABLE` to its absolute path, e.g. `/usr/bin/chromium`. The suite uses fictional local fixtures; it does not establish current live lead supply or generated-site quality. No frontend build step is required; the server serves vanilla JS/CSS directly.

## Live operation prerequisites

Open **Setup & API keys** and save a private API profile. DeepSeek is the default code provider; OpenRouter is the default image-review route. OpenAI and registered compatible services are supported. The full pilot requires tested Google Places, Apollo, Firecrawl, Scrapling and guarded Camofox integrations, confirmed current prices/source use, and an allowance. A ChatGPT subscription is separate from API credit. See the [guide](docs/DEEPSEEK-PILOT.md) for installation, exact limits and recovery.

`node scripts/install-studio-runtimes.mjs` installs locked isolated Python 3.12/Node tools. Genuine Camoufox download is explicit with `--fetch-browser`; the broker/source service must be started separately. Use the VPS installer only on the documented private server. Saving keys starts no provider request; an automatic pilot starts only after explicit authorization. Existing legacy histories remain; their paid routes are held after an API profile is adopted so they cannot bypass its shared allowance.

Without an API profile, the earlier owner-supplied Codex and research-led OpenCode workflows remain available with their original prerequisites and separate authority. Their earlier documentation is historical alongside the new guide. No live integration, human acceptance, sale or deployment is inferred from a fixture.

## Data and publication

Never commit credentials, databases, customer photos, raw research, generated job folders or local logs. Publicly visible media is not automatically licensed for public use. Review every factual claim and obtain appropriate media permission before publishing a customer website. The current app prepares local review packages; sending, deployment and verified payment are not implemented end-to-end.

## Source and licensing

Imported from `simulacra-factory-app-20261028.zip`. Original historical operational documents and historical agent directives were retained outside this checkout, not imported as current instructions. See [source manifest](docs/IMPORT-MANIFEST.json) for the original archive hash and file inventory. No app-wide redistribution license was present in the upload; the repository remains without a new open-source license. Bundled fonts retain their OFL notices. Review ownership and licensing before public distribution.
