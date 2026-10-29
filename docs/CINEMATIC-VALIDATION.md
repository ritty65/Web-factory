# Cinematic director: actual validation

Run date: 28 October 2026, America/Chicago (29 October UTC). Node 24.19.0, Python 3.12.14 and actual `/usr/bin/chromium` in the managed cloud environment.

## What was exercised

| Check | Outcome |
| --- | --- |
| Locked installation | `npm ci` succeeded with the pinned GSAP/Lenis dependencies. |
| Targeted runtime and sandbox checks | 19 tests passed, no failures or skips. Actual WebGL pixels changed; context loss, touch, keyboard, reduced motion, missing APIs and the real opaque preview were exercised. |
| Cinematic API pipeline | Fictional DeepSeek/vision responses passed through the real shared service, accounting, three-study renderer, homepage QA, expansion, full-site QA and ZIP packaging. No real AI-quality claim. |
| Negative generation paths | A held homepage exhausted its one repair without expansion; a changed frozen reference stopped before another model call. Contradictory creative reviews, missing runtime scripts, tampered vendor/capture bytes and exhausted model allowances were held. |
| Full regression suite | **1,605 passed, zero failures, cancellations or skips; 523.16 seconds.** Includes the new cinematic tests and the existing lead, spending, evidence, recovery, security, UI and production checks. |
| Public reference browsing | Three content-ready references: Exo Ape, Locomotive and Lusion. Obys and Bruno Simon were held on loader-only captures. Exo Ape succeeded after one navigation retry. |
| Private public-source redesign | Manually authored five-page concept using five images and contact/service information from an existing published detailing website. This was not an AI-generated site, a newly qualified lead or independent confirmation of current operations. |
| Real concept browser checks | 25 page/viewport checks, 25 effect cases and 36 interaction observations passed; zero reported issues and zero installed-Axe violations. No-JS and missing-API alternatives passed. |
| Actual app preview | All five declared effects passed inside the app's real opaque sandbox. The WebGL texture uses anonymous local-image CORS; the private studio API stays inaccessible. A real browser walkthrough was recorded. |
| Genuine AI generation | Not completed. No provider API keys were available. The existing native Codex adapter was attempted; its server returned 401 and rejected the saved authentication token despite `login status` reporting a login. No fake response replaced it. |

The initial private preview checks exposed an actual sandbox/WebGL texture incompatibility. The implementation now supplies anonymous local image loading and narrowly allows opaque-origin CORS on static preview images. A regression test proves that this does not enable access to the studio API. A separate test rejects a cinematic page that stages vendor assets but omits the required deferred runtime sequence.

The final concept is approximately **915 kB**, including photos, fonts, scripts and styles; JavaScript is approximately **162 kB**. After preloading its local font, the ten recorded opening observations reported zero sampled CLS and zero long tasks, with local LCP samples of 84–420 ms. These are unthrottled local Chromium observations under the current machine's conditions, not internet/device field performance or a Core Web Vitals certification.

## Private deliverables

The exact site, source/media receipts, browser captures, walkthrough, QA report and checksummed ZIP stay under ignored `.artifacts/cinematic-live-prototype-v5/`. The source application, tests, protected runtime and aggregate validation are in Git. Real business media, HTML research, credentials and generated customer files are excluded.

The ZIP keeps `humanDecision:null`, `publicRelease:false` and `automaticAiGeneration:false`. Publicly accessible photographs have unconfirmed publication rights. The published source includes development/booking-placeholder behavior, so this exercise makes no independently verified booking, live availability, qualification or business-activity claim. No business was contacted or website published.

## Still needed for live acceptance

1. Configure and test DeepSeek plus a supported vision API, then run one genuine supplied-business cinematic build. Judge the actual generated result on desktop and phone and record a version-specific verdict.
2. Build an approved/rejected benchmark with your own reasons. Check whether AI reviews distinguish those examples before expecting consistent design quality.
3. Separately connect the lead providers and source readers, inspect a fixed real Houston cohort and measure actual qualification yield, contact accuracy, cost and failure recovery. Mocks and public reference browsing do not prove this.
4. Deploy the private operator app to the Hostinger VPS and exercise restart, backup/restore and provider outages over the documented reliability pilot. That deployment was not performed here.

The repeatable test command removes only the optional application native-backend override, because the regression fixtures test their own explicit routes:

```sh
env -u FACTORY_MODEL_BACKEND FACTORY_BROWSER_EXECUTABLE=/usr/bin/chromium npm test
```

The live sign-in failure is a separate result; clearing a fixture override does not repair authentication. See [the operating guide](CINEMATIC-DIRECTOR.md) for exact prerequisites and bounds.
