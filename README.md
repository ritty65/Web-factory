# Web Factory / Simulacra Factory

A local operator workspace for finding suitable local service businesses, verifying their evidence, producing private website proposals, and reviewing the exact output before any customer delivery.

**Current status:** the imported app now includes a real guided Business intake, private supplied-photo uploads, a lead/evidence workspace, manual/CSV intake, an optional Google Places adapter, opt-in daily discovery and a ChatGPT/Codex proposal adapter. The lead workspace also includes target rules, ranked research, optional Firecrawl cross-checks, rotating searches and failure/saturation pauses. See [the operating guide](docs/OPERATING-GUIDE.md). Offline tests and local browser paths are verified. Live model access, real provider yield and VPS deployment remain separate acceptance checks; they have not been certified by fixture tests.

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

For the new supplied-content flow, set `FACTORY_MODEL_BACKEND=codex` and sign in to the supported Codex CLI as the operator account. The adapter uses a read-only proposer with large prompts sent through stdin and no unrelated lead API keys in its environment. The project-local `agent-browser` dependency supplies the existing public reader. The legacy research-led flow still uses its original OpenCode/source-MCP contract; the Codex proposer is not a silent substitute for that research worker. Firecrawl remains optional search. PlaceRoot remains separately installed and Houston-specific.

Start with **Business intake** and one real supplied brief. Save starts nothing; Build requires explicit confirmations, an exact version and model/browser prerequisites. The legacy evidence-JSON import remains for its original stricter source contract. Use **Lead workspace** for manual/CSV pointers or an explicitly authorized Google Places search. Daily discovery starts disabled and needs both an adopted schedule and a separately installed private VPS timer.

## Data and publication

Never commit credentials, databases, customer photos, raw research, generated job folders or local logs. Publicly visible media is not automatically licensed for public use. Review every factual claim and obtain appropriate media permission before publishing a customer website. The current app prepares local review packages; sending, deployment and verified payment are not implemented end-to-end.

## Source and licensing

Imported from `simulacra-factory-app-20261028.zip`. Original historical operational documents and historical agent directives were retained outside this checkout, not imported as current instructions. See [source manifest](docs/IMPORT-MANIFEST.json) for the original archive hash and file inventory. No app-wide redistribution license was present in the upload; the repository remains without a new open-source license. Bundled fonts retain their OFL notices. Review ownership and licensing before public distribution.
