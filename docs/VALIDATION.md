# Validation record • 28 October 2026

## Environment and installation

- Node 24.19.0, npm 11.9.0, Python 3.12.14 and system Chromium available. Some existing Python fixture tests select `/usr/bin/python3` explicitly; the optional PlaceRoot runtime was not installed.
- Fresh `npm ci --ignore-scripts --no-audit` succeeded against the updated lockfile. Package lifecycle scripts remain disabled by `.npmrc`; TLS/checksum checks remain enabled.
- Sharp 0.35.5, Playwright 1.64.1 and @axe-core/playwright 4.14.0 are now declared, locked project dependencies instead of dependencies borrowed from a different local project.
- `npm audit --omit=dev --json` reported zero known advisories at check time. This does not certify the application or future dependency safety.
- `bin/factory` is executable. Default data paths now point to the ignored checkout-local `.factory-state`, while explicit state/DB overrides retain credential isolation.

## Checks executed

- First complete imported-code test run: 1,313 tests, 1,281 passed, 32 failed, no skips. Failures exposed a shared branding/accessibility defect and import portability issues; they were investigated rather than disabled.
- Focused path/credential/Python-bridge regression verification after correction: **54 passed, 0 failed, 0 skipped**.
- Final complete suite: **1,313 passed, 0 failed, 0 skipped/cancelled**, completed in 239.678 seconds using `FACTORY_BROWSER_EXECUTABLE=/usr/bin/chromium npm test`. No assertions or suites were disabled.
- Actual UI/UX smoke: **18 view/width combinations**, covering current app Start plus proposed Workspace/Opportunities/Brief/Review/Product-plan at desktop, 390 and 320 pixels. Zero observed horizontal overflow and zero Axe violations for those checked views; incomplete Axe checks are retained in `visuals/smoke-results.json` and still require judgment.
- Syntax checks: **196 JavaScript files** passed `node --check`; Python bridge files parsed successfully and `sh -n bin/factory` passed.
- Browser smoke confirmed no page JavaScript errors; application health and isolated preview health responded correctly. Empty private store had zero jobs. A mutation without session/origin credentials was rejected with HTTP 403.
- Prototype search/filter, evidence dialog, handoff to brief, phone review and explicit demo decision were exercised. This prototype writes no real application data and does not call generation, lead or messaging APIs.
- Real current screenshots and fictional concept screenshots are retained in `visuals/`. They are not captures of generated customer websites.

## Not verified / not supplied

No live model request, business-source query, lead cohort, generated customer site, outreach, deployment, customer acceptance or sale occurred. The external `opencode` and `agent-browser` commands are unavailable here. Their authentication/config/schema/model route still need validation. Optional Firecrawl has no binding in this instance. Apollo, Google Places and licensed lead providers are not connected.

The original private DB, actual customer proposal, historical run receipts and photos were not in the ZIP. Historical documentation claims do not supply that evidence. There is no current proof of reliable live lead yield, repeatable site quality, customer willingness to pay, production hosting or public media rights.

The limited source scan found no matching private-key / common credential-token patterns in the original upload. It is not a complete secret/privacy/license audit. The clean import excludes old operational diaries/directives and all runtime state. The user explicitly approved uploading the branch publicly after the public visibility was explained. That approval does not create a new redistribution license.

GitHub CI configuration was added but cannot be described as passed until a real GitHub Actions run completes. Local tests do not establish clean hosted-runner results or fresh cloud-task restoration. Environment `install_script` and `start_skill` were saved to a draft; saving does not publish the environment. Review/save that draft in environment settings, then publish if you want to retain this prepared filesystem for future tasks.
