# Design quality: the next benchmark

Status: the reference packet, homepage gate, readable review, advanced runtime and profile-specific limits are implemented in `cinematic-director-v2`. [The implementation guide](CINEMATIC-DIRECTOR.md) describes the executable flow; [validation](CINEMATIC-VALIDATION.md) distinguishes actual browser checks, fictional AI integration tests and the blocked live AI run. This blueprint also retains longer-term work that is not implemented, including video, page morphs and a human-calibrated benchmark.

## The goal

Make each business feel as though a designer understood its work, chose a visual idea, and directed its content, images and movement together. Produce fewer drafts when that is necessary to maintain the standard. A technically correct draft is not automatically a strong design.

The current demos are rejected as the creative benchmark. Their repeated abstract artwork, headings, service cards and closing copy must not become the defaults for production. They remain labelled fictional engineering examples.

## The chosen references

The operator supplied these five references and wants their desktop craft studied. These are directions for inspection, not verified dependency or award claims:

| Reference | What to study and adapt |
| --- | --- |
| [Obys Agency](https://obys.agency/) | Expressive type, project-list interaction, restrained magnetic feedback, image-led storytelling and deliberate scroll pacing. |
| [Exo Ape](https://exoape.com/) | Strong media composition, gallery behavior, scene transitions and continuity between sections. |
| [Locomotive](https://locomotive.ca/) | Layered parallax, scroll choreography and changes of section geometry without losing navigation. |
| [Lusion](https://lusion.co/) | A purposeful interactive WebGL scene, pointer response, loading behavior and fallback design. |
| [Bruno Simon](https://bruno-simon.com/) | A memorable interactive concept, discovery and playful feedback. A complete navigable 3D world is a separate production scope. |

Use Obys and Exo Ape as the primary direction for composition and interaction. Treat Lusion/Bruno-style scenes as optional specialist work for appropriate brands, assets and budgets. Give phones, keyboards and reduced-motion users an independently useful experience.

This environment now permits public browsing. Fresh Chromium inspections produced content-ready captures of Exo Ape, Locomotive and Lusion. Obys and Bruno Simon remained on loading screens and are held as visually unresolved; their nonempty pixels cannot qualify as usable reference evidence. Exo Ape required one retry after a navigation failure. Captures stay private and expire after 30 days. These observations do not verify the supplied stack descriptions or award claims.

## Gaps that prompted the change

These observations describe the earlier basic process. The cinematic profile addresses reference delivery, review readability, homepage expansion and the capability budget. Its actual design quality still needs live-model output and human calibration.

1. **The API generator receives no inspected reference packet.** Its shared input currently sets `references: []`. The reference shelf exists, but those observations and screenshots do not reach this build path.
2. **The reviewer receives overly small long-page images.** Review attachments are resized to a maximum 1,024-pixel edge. One actual 1,440 × 3,095 demo capture becomes approximately 476 × 1,024; a 390 × 2,207 phone capture becomes approximately 181 × 1,024. Composition is visible, but small type and detail are hard to assess.
3. **The examples repeat a visual formula.** Different arrangements and colors still share the same illustration, section language, typography system and generic copy.
4. **The engine asks for three complete opening studies in one response, then five complete pages in another.** The default DeepSeek output ceiling is 8,192 tokens. This may encourage compressed, repetitive output; actual live model behavior is still untested.
5. **Effect counts do not establish art direction.** Three working mechanisms can coexist with an ordinary layout. The existing pack also explicitly excludes GSAP, Lenis and WebGL; stronger effects need a new tested capability profile.
6. **Current evidence is technical.** The 1,582 passing tests and fictional packages establish useful behavior. They do not establish attractive real AI output or operator acceptance.

## The better production process

### 1. Prepare enough material to design with

Create a business content packet: what the customer needs, the main action, supported service details, genuine distinguishing information, approved media and important gaps. Assess visual readiness separately from lead qualification.

Select a hero asset and supporting material by resolution, subject, crop and relevance. Preserve original quality and provenance. Use real before/after pairs only when they actually correspond. If usable material is missing, choose a deliberate typography-led concept or hold for content; do not fill the site with invented work or generic reassurance.

### 2. Give the generator something specific to aim at

Create a curated library of operator-approved reference captures. For each new business, select two or three relevant references and explain what to learn from each: type hierarchy, opening composition, image treatment, section rhythm or interaction. Supply actual readable images to the art-direction/review stage, not names alone.

Keep an approved/rejected example library. Record the operator's reasons, including the rejection of the current demo style. Use those decisions as future context without treating them as customer approval or media permission.

### 3. Design the opening before expanding the site

Generate three substantially different opening concepts. Differences must include composition, type, imagery and the main interaction. Compare them against the selected references and the visitor's task; the strongest of three weak options can still be rejected.

Finish one actual desktop-and-phone homepage first. Establish its typography, crop decisions, custom graphic language, transitions and conversion path before expanding it. Avoid regenerating the entire site to adjust one section. Inner pages inherit the system and get their own useful structures. A future version should allow page count to follow available content; the current five-page contract remains unchanged until that feature is implemented explicitly.

### 4. Compose motion as a sequence

Choose one memorable interaction supported by the business's material, then use quieter supporting effects. The existing three-to-five-family requirement is a technical floor, not the creative verdict.

Example for a detailing business: a strong real-car opening image or supplied clip; carefully timed type and image reveals; an actual before/after comparison; a vehicle/service explorer using supplied facts; and a project gallery with deliberate pointer feedback. Keep calling and booking destinations easy to find.

Define the sequence: what enters first, what changes as the visitor scrolls, how pointer input responds, and how each scene resolves. Document the touch, keyboard, reduced-motion and loading alternatives. Shared motion timing and spatial relationships should make the page feel coherent.

### 5. Add advanced capabilities deliberately

Keep DeepSeek as the default coding provider. Add a trusted host-owned GSAP/ScrollTrigger bundle and optional Lenis support in a new profile; use one owner for scroll position and progress to avoid competing scroll systems. Choose exact packages and licences during implementation rather than assuming the five reference sites use the same stack.

Add image trails, hover displacement, character-level typography and progressive page morphs as independently tested capabilities. Use OGL or Three.js only for a justified WebGL scene, load it when needed, and dispose of resources when it leaves the page. Provide useful static fallbacks and survive context loss and weaker devices.

Add a real permitted-video asset path before promising cinematic video. Keep declared loading and media budgets, posters, interruption behavior and reduced-motion/data-saving alternatives. The present 50 KiB JavaScript / 2 MiB total limits cannot accommodate every proposed media/WebGL experience; revise budgets explicitly for the new profile while preserving old jobs and packages. Generated customer code still must not execute arbitrary shell commands or access studio credentials.

### 6. Make the review capable of seeing defects

Retain a full-page overview, but review the actual desktop/phone opening and important sections in readable viewport crops. Bind each crop to page, viewport, scroll position, state and site digest. Use focused review batches within provider image limits.

Capture interaction storyboards and short recordings in addition to browser assertions. Stills do not establish smoothness. Check real scrolling, dragging, focus, mobile gestures, rapid input, loading, long tasks and layout stability. WebGL effects also need capability, resource-cleanup and context-loss checks.

Ask the creative reviewer for observations against the actual reference packet: identity, composition, typography, imagery, business relevance, section variation, motion and conversion clarity. A convincing written explanation cannot override weak pixels. Do not turn arbitrary model scores into quality guarantees.

### 7. Calibrate the gate with human decisions

Build a small benchmark of approved and rejected designs with explicit reasons. Check whether automated review reliably distinguishes them before allowing it to guide more automatic production. Include attractive but unusable examples and technically passing but generic examples.

Maintain separate outcomes: technical pass, factual/media readiness, creative review, and exact-version operator acceptance. A creative hold prevents expansion or packaging under the new quality profile. Revisions consume a visible, bounded allowance. On exhaustion, retain the work and reason; never silently approve it, reset spending or retry indefinitely.

## Practical order

1. Assemble the reference packet and rejection criteria; fix readable review crops.
2. Art-direct one complete local-service homepage to the chosen standard, with actual usable imagery and one strong interaction. Inspect desktop motion and phone behavior.
3. Get the operator's explicit verdict and refine the benchmark. This first example should justify the visual direction before mass generation resumes.
4. Generalize that process into the generator, advanced-effect components and design memory. Preserve existing evidence, accounting, authority and old packages.
5. With real API access, compare generated output against the accepted benchmark and measure acceptance, revisions, latency and actual cost. Keep the existing global allowance; changing per-build call caps needs an explicit new quality profile and visible cost control.

The dependable promise is that weak work is identified, held and improved within limits. Exceptional design on every first attempt is not a defensible promise. A clear benchmark, better material, focused generation and real review are how acceptance can become more consistent.
