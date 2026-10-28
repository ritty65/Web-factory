# Web Factory / Simulacra Factory

A local operator workspace for finding suitable local service businesses, verifying their evidence, producing private website proposals, and reviewing the exact output before any customer delivery.

**Current status:** imported from the uploaded source snapshot dated 2026-10-28 and made portable for development. The local UI, database and offline tests can run without a paid account. Live research and AI site generation still need the external model/reader integrations. This is not a hosted SaaS or a proven autonomous sales machine.

## Start here

- [North Star: product, workflow and definition of success](docs/NORTH-STAR.md)
- [Technical and product review](docs/APP-REVIEW.md)
- [Interactive proposed UI](docs/UX-PROTOTYPE.html) — open this file in a browser; illustrative data only.
- [Prioritized implementation plan](docs/ROADMAP.md)
- [Lead sourcing and Apollo decision](docs/LEAD-SOURCING.md)
- [Validation results and limits](docs/VALIDATION.md)

## Run locally

Use Node.js 24.13 or newer (Node 24.19 tested), npm, and Python 3 for the existing offline source fixtures.

```sh
npm ci
npm run init
npm start
```

Open the loopback app URL printed by the command in a local development session. The app listens on port 8780; its read-only static website previews use a separate origin on 8781. Keep it on loopback. The default private state is `.factory-state/` in this checkout, ignored by Git. Stop with Ctrl-C. Services must restart after restoring a cloud snapshot.

For another private data directory, set **both** `FACTORY_STATE` and `FACTORY_DB`. For inspection without worker execution, set `FACTORY_AUTORUN=0` before starting. Use `npm run doctor` to see missing integrations; tool presence does not prove sign-in, model compatibility or successful business research.

## Test

```sh
# Install Playwright's matching browser on a fresh machine:
npx playwright install --with-deps chromium
npm test
```

If Chromium is already installed, set `FACTORY_BROWSER_EXECUTABLE` to its absolute path, e.g. `/usr/bin/chromium`. The suite uses fictional local fixtures; it does not establish current live lead supply or generated-site quality. No frontend build step is required; the server serves vanilla JS/CSS directly.

## Live operation prerequisites

The current generation adapter shells out to an external `opencode` CLI with the exact model route in `src/model.mjs`. Its CLI flags, worker config schema, authentication and model availability must be verified before real use. The public page reader also needs `agent-browser`. Neither integration is installed or authenticated by this source import. Firecrawl is optional search, not a replacement for the page reader. The optional PlaceRoot connector has a separately pinned Python runtime and remains Houston-specific.

Start with one assisted business dossier and one private site, after those dependencies are working. The existing assisted UI expects a structured evidence JSON file; it is **not** a simple business-name upload. Do not click research/build expecting those missing integrations to work. See the roadmap for a guided intake wizard and provider preflight.

## Data and publication

Never commit credentials, databases, customer photos, raw research, generated job folders or local logs. Publicly visible media is not automatically licensed for public use. Review every factual claim and obtain appropriate media permission before publishing a customer website. The current app prepares local review packages; sending, deployment and verified payment are not implemented end-to-end.

## Source and licensing

Imported from `simulacra-factory-app-20261028.zip`. Original historical operational documents and historical agent directives were retained outside this checkout, not imported as current instructions. See [source manifest](docs/IMPORT-MANIFEST.json) for the original archive hash and file inventory. No app-wide redistribution license was present in the upload; the repository remains without a new open-source license. Bundled fonts retain their OFL notices. Review ownership and licensing before public distribution.
