# Cinematic director: build the homepage before the rest

The new `cinematic-director-v2` profile adds reference-led art direction, a separately checked homepage, readable visual reviews and a protected advanced-effect library. DeepSeek remains the default code provider. A tested vision provider examines actual images and screenshots.

This is a quality process, not a promise that every AI draft will be excellent. A weak homepage can stop before the other pages are generated. Passing browser tests and an AI visual review still require your own desktop and phone verdict.

## Start a real AI build

1. Run the app using the private state settings in [the pilot guide](DEEPSEEK-PILOT.md). Open **Setup & API keys**.
2. Add DeepSeek and a supported vision connection, such as OpenRouter or OpenAI. Confirm current pricing, save and pass their actual connection tests. ChatGPT subscription access is separate from API credit.
3. Select **Cinematic director — reference-led, homepage first** and save. Saving alone makes no paid request. Existing jobs keep their original frozen profile.
4. Open **References**. Inspect at least two of the five selected sites. Captures must be recent, content-ready and registered. A failed or loader-only inspection cannot guide a cinematic build. A new Inspect click creates a fresh audit; retries of the same request remain idempotent.
5. Use **Business intake** for one business with accurate facts, a real contact action and permitted photos. Confirm the brief and explicitly start one private build.
6. Review the interactive result, its sources, desktop/phone captures and checks. Record your verdict on the exact version. Nothing is automatically sent, accepted or published.

For one supplied-business build, Google, Apollo and Firecrawl are unnecessary. For the automatic Houston lead pilot, those integrations, permitted-use confirmations, current prices, genuine Scrapling/Camofox checks and a fixed pilot allowance are separate prerequisites. [Lead sourcing](LEAD-SOURCING.md) explains their roles. Provider results do not establish business fit, current activity, purchase intent or media rights.

## What the engine does

1. Freeze the exact business facts, approved media, provider settings, profile and two or three inspected references. Recheck those bindings before each paid model request.
2. Give a vision model the actual reference crops and business photos. Produce a business-specific visual thesis and a practical interaction contract.
3. Have DeepSeek code three opening studies. Render desktop and phone versions; compare actual images and permit a hold when all options are weak.
4. Have DeepSeek finish one homepage with reusable styling. Run five-width browser checks, then compare readable opening and section crops against the references. Allow one bounded homepage repair. A remaining hold prevents expansion.
5. Freeze the passing homepage and shared assets. Generate four additional HTML pages. The host adds a small inner-page navigation; the expansion cannot replace the homepage or shared files.
6. Check all five pages at 1440, 1280, 768, 390 and 320 pixels. Check actual effects, native interactions, keyboard, reduced motion, no JavaScript, missing APIs, accessibility, resources and reflow. Review every page's claims separately.
7. Review ten first-screen crops and ten section crops in readable batches. The creative reviewer must cite current captures for identity, composition, typography, imagery, business fit, motion purpose and phone layout. Contradictory verdicts are rejected.
8. Apply at most one full-site technical repair and one creative repair. Package only exact checked bytes, reference bindings, creative observations, licences and a pending operator verdict.

Up to **16 AI attempts** per cinematic proposal, including failures, share the existing **$100 pilot ceiling**. The basic profile keeps its ten-attempt cap. No automatic budget reset or unlimited regeneration. Unknown provider charges retain their reservations and hold further spending.

## What the effects include

Choose three to five coherent families, with at least one advanced family on the homepage. There is no requirement to use every effect.

| Capability | Behavior and fallback |
| --- | --- |
| Character reveal | A short semantic heading enters once; text stays readable without JS or under reduced motion. |
| Image trail | Up to three transient previews follow desktop exploration of real approved gallery images. Original images and links remain visible. |
| Hover displacement | A small host-owned WebGL shader reacts to pointer movement over an approved photo. At most two GPU contexts; original image survives context loss, missing WebGL, touch and reduced motion. |
| Scroll scene | GSAP/ScrollTrigger coordinates one to three supporting layers with bounded parallax and velocity response. Phone/reduced-motion layout stays static. |
| Optional smooth scrolling | Local Lenis on desktop; keyboard switches it back to native scrolling. Touch, reduced motion, dialogs and gallery tracks retain native behavior. |
| Existing five families | Magnetic label, sticky cards, split words, clip reveal and draggable gallery remain available with their existing evidence and fallback checks. |

Pinned local packages: GSAP **3.15.0**, ScrollTrigger and Lenis **1.3.27**. No animation API key or CDN is needed. GSAP uses its Standard License, not MIT; Lenis is MIT. Exact vendor bytes and licence notices travel in the private package. The model cannot replace these host files. See [the retained GSAP licence](../runtime/vendor/GSAP-LICENSE.txt).

The cinematic budget is **8 MiB total / 256 KiB JavaScript / 80 KiB CSS**, including host assets. The basic profile keeps 2 MiB / 50 KiB / 50 KiB. These are ceilings, not performance scores. Actual local loading, CLS and long-task observations are retained; field performance and physical devices still need testing.

## Current proof and remaining limits

See [the validation record](CINEMATIC-VALIDATION.md) for actual outcomes, including a manually authored real-business private redesign and the blocked live-model attempt. A hand-built prototype is not evidence that DeepSeek automatically produced it.

The five selected reference descriptions are study directions. We have not established that their current sites all use the same stack, nor independently verified supplied award claims. References supply craft guidance; their code, branding and client media are not copied into proposals.

Not implemented here: complete interactive 3D worlds, water simulations, video acquisition/encoding, page morphs, mandatory horizontal scroll, backend form delivery, live booking, accounts or payments. Those require separate scope and verification. Hostinger deployment and long-running lead reliability still need a real VPS/provider pilot.

## Reproduce checks

```sh
npm ci
# Use your installed Chromium path. Clear the optional native backend override
# for the regression fixtures, which test their own explicit model selections.
env -u FACTORY_MODEL_BACKEND FACTORY_BROWSER_EXECUTABLE=/usr/bin/chromium npm test

# Explicit, read-only public browser work; no AI request:
FACTORY_BROWSER_EXECUTABLE=/usr/bin/chromium node scripts/audit-design-references.mjs
# Or inspect one registered site:
FACTORY_BROWSER_EXECUTABLE=/usr/bin/chromium node scripts/audit-design-references.mjs exoape

# Explicit manual-proof route; keep case JSON, site, photos and outputs private:
FACTORY_BROWSER_EXECUTABLE=/usr/bin/chromium node scripts/check-private-concept.mjs /absolute/private/case.json
```

The manual checker expects `siteRoot`, `outputRoot`, `candidate`, `media`, `effectsPlan`, `interaction`, `design` and `sourceProof`. Paths are relative to that private case file. It records `automaticAiGeneration:false` and never fabricates a model job or operator acceptance.
