# Premium sites: try the effects, then test a real build

New API builds use `premium-practical-v1`. DeepSeek still plans and codes the site; a separate vision provider reviews actual screenshots. No frontend framework, CDN or additional animation-service key is required.

## Try it without keys

Start the app with the private state/database settings in [the pilot guide](DEEPSEEK-PILOT.md), open **Setup & API keys**, and use its three demo links. The third demonstrates all five effects. On a default local installation it is also available at `http://127.0.0.1:8781/demo/2/index.html`.

These are authored fictional examples with original geometric illustrations, not AI-generated customer sites, real leads or client portfolio photographs. They run on the isolated preview origin and start no research, generation, outreach or publication.

| Example | Visual direction | Effect families |
| --- | --- | --- |
| Midnight Motor Studio | Dark, asymmetric workshop | Magnetic button, split heading, clip reveal |
| Fieldwork Garden Care | Warm, centered garden journal | Those three plus sticky service cards |
| Clearspace Home Care | Airy blue, reversed composition | All five, including a draggable illustration gallery |

Use the mouse on desktop, try gallery buttons and arrow keys, resize to a phone width, and turn on your operating system's reduced-motion setting. Normal touch scrolling stays available. Effects are enhancements; contact links and readable content do not wait for animation.

## Recorded validation

The full regression suite passed **1,582 tests**. Two additional proofs checked six five-page packages and 150 page/viewport cases. All inputs were authored or injected fictional fixtures; real AI quality and useful live leads remain unproven. [Read the receipts](visuals/premium-proof.json).

[Detailing desktop](visuals/premium-demo-0-1440.png) · [Garden phone](visuals/premium-demo-1-390.png) · [All-five-effects desktop](visuals/premium-demo-2-1440.png) · [All-five-effects phone](visuals/premium-demo-2-390.png). These are settled browser captures of the authored examples.

## How a new site is made

1. Freeze the supplied brief or source-checked business assessment, photos, provider settings and design profile.
2. DeepSeek proposes three different visual directions and an effects plan, using three to five families on the homepage. Inner pages get effects only where useful.
3. Render the three openings at desktop and phone sizes. A vision model compares actual screenshots and can hold weak work.
4. DeepSeek expands the chosen direction into five distinct pages, using the protected local effect library.
5. Chromium checks layout, accessibility, useful interactions, real effect behavior and fallback states. Factual and screenshot reviews are separate. Repairs stay within the existing allowance.
6. Package the exact passing site, frozen effects plan, observations and provenance. You try the interactive site and record your own verdict. Nothing is automatically accepted or published.

The generator cannot replace the host effect files. Unsupported effects, missing targets, conflicting motion, invisible content, unsupported service facts or insufficient gallery images hold the build. A photo-free site can use magnetic, split-text and clip-reveal effects; it does not invent photographs.

Old jobs keep their original profile. Upgrading does not rewrite their packages, reset costs or authorize another attempt.

## Where the lead services fit

**Google Places** discovers local businesses and listing information. A missing website field is only a starting clue. **Apollo** tries to match a company and identify a business contact; it may have little coverage of small local businesses. It does not supply buying interest or a client image portfolio.

**Firecrawl** searches and collects public content. **Scrapling** extracts page information, and the guarded **Camofox** browser handles browser-based collection. Business identity, locality, services, activity, contact evidence and website checks still have to pass the existing gates. A provider response alone cannot qualify a lead.

Images come from checked business sources or supplied uploads. Public availability does not establish publication permission. Google Images scraping is not part of this workflow.

## First real test

For one supplied-business draft, configure **DeepSeek** and a supported **vision API** such as OpenRouter, confirm current account pricing, run their connection tests, and check Chromium readiness. A ChatGPT subscription does not include those API credits. Complete **Business intake** with accurate information and approved photos, then explicitly start one build.

For automatic Houston lead discovery, also connect and test **Google Places, Apollo and Firecrawl**, confirm their permitted use, and pass actual Scrapling/Camofox extraction checks. Setup shows this separately from supplied-business readiness. Network access and genuine Camoufox installation are independent prerequisites.

Inspect the first real result on desktop and phone. Check its facts, media rights, contact links, effect behavior and appearance. Connection tests and mocks cannot establish lead quality, provider-plan coverage or DeepSeek's design quality. The fixed cohort and actual Hostinger reliability pilot remain necessary.

## What “dynamic” currently includes

It includes working client-side galleries, disclosures, filters, responsive layouts and progressive effects. Real form delivery, booking engines, accounts and payments need working backend integrations. There is no fake submission or booking success.

WebGL distortion, cursor trails, water simulations, Lenis and horizontal scroll hijacking are deferred. This first pack keeps natural scrolling and the existing 2 MiB total / 50 KiB JavaScript / 50 KiB CSS limits.

## Reproduce the offline proof

```sh
FACTORY_BROWSER_EXECUTABLE=/usr/bin/chromium npm test
FACTORY_BROWSER_EXECUTABLE=/usr/bin/chromium npm run effects:proof
FACTORY_BROWSER_EXECUTABLE=/usr/bin/chromium node scripts/proof-studio-pilot.mjs
```

Use the installed Chromium path on your machine, or omit the variable when using Playwright's installed browser. The effect proof checks three authored examples and exact ZIPs. The studio proof runs source and AI adapters with injected fictional responses. Neither makes a live provider call or certifies real-business outcomes. Private generated outputs stay under ignored `.artifacts/`.
