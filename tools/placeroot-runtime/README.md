# Isolated PlaceRoot runtime

Observed setup: **27 October 2026**. This is source-connector setup and offline
verification, **not a live seed cohort, qualification or business/site proof**.

## Stable policy inputs

- `src/seed-source.mjs`: fixed connector, limits and normalization.
- `tools/placeroot-runtime/server.py`: fixed Python stdio bridge; no CLI warmers.
- `tools/placeroot-runtime/requirements.lock`: 31 exact wheel dependencies with
  SHA-256 hashes, resolved from `https://pypi.org/simple`.
- `tools/placeroot-runtime/runtime-manifest.json`: pinned package versions, wheel
  hashes and installed RECORD hashes. The bridge verifies RECORD hashes and all
  RECORD-hashed installed files before importing PlaceRoot. It exits 78 with only
  `SEED_SOURCE_INSTALL_DRIFT` on failure. A temporary installed-file drift was
  actually rejected and the original bytes restored during offline verification.

Do not bind the entire `.venv` or mutable caches into production policy.
`resolution.json` is a sanitized public package-resolution audit (names, versions,
public wheel URLs and hashes), not an installer environment dump. `tools-list.json`
is actual initialize/tools-list evidence from the installed server. Package tool
selection also exposes `preferences` in its catalog; the connector never dispatches
it. Only the five approved tool names can be called.

## Setup and verification

An isolated `.venv` was created with Python 3.12.3. PyPI PlaceRoot **0.12.0** wheel
SHA-256 is `a6878883a35d7d6f1dac5d0e10c1ad12e05a2ceccb711f43c81b052a4fc0f706`.
Resolution used `pip --isolated install --dry-run --only-binary=:all:`;
installation used `--only-binary=:all: --require-hashes -r requirements.lock`.
No source distribution, system package, Node dependency, global MCP configuration
or alternate provider was installed. Installation used pip's existing wheel cache;
the environment itself is project-local. For a future explicitly authorized
reinstall, pass a project-local `--cache-dir` as well. Do not refresh the manifest
to hide drift: compare with the pinned wheel resolution and re-review policy.

Read-only checks:

```sh
node --test tests/seed-source.test.mjs
tools/placeroot-runtime/.venv/bin/python -m pip --isolated check
node --input-type=module -e "import('./src/seed-source.mjs').then(async m => console.log(await m.preflightSource()))"
```

The bridge runs with `-I -S -B`: no user site, environment Python path,
`sitecustomize` or `.pth` execution. It explicitly adds only the fixed venv's
site-packages path after starting in isolated Python mode. It imports the installed
package server and runs stdio directly, rather than the package CLI, whose startup
otherwise launches metadata/division/home warmers.

## Interface and bounds

`collectSeeds({settings, signal?, connector?})` returns plain JSON:

```text
{ provider:'placeroot', retrievedAt,
  version:{package:'0.12.0',release,resolution}, attribution:[...],
  limitations:[...], items:[{
    id,name,location:{lat,lon,addresses},categories:[...],
    urls:{websites:[...],socials:[...]},operatingStatus,confidence,phones,
    provenance:{dataset,release,retrievedAt,sources:[actualSourceRecords...],
                licenses:[{dataset,license,notice}...]}
  }] }
```

`settings` is not interpreted as tool names, SQL, paths, URLs or arbitrary source
scope. The shared `seed_prepare` operation validates the saved approved preset.
The connector itself always resolves Houston, Texas, US, requires one Houston
locality with Texas admin context, and searches only the three fixed category
intents. Actual category slugs must come from `search_categories`; they are not
invented. Categories remain discovery approximations, not category qualification.

Limits: one child; initialize/list each 20 seconds; preparation ten minutes;
data calls each 120 seconds; at most 28 calls (one version, three category, one
geocode, three find, twenty detail); find limits **7/7/6**, at most twenty returned
business rows and twenty deduplicated items. No continuation, confirm/warm-up,
replacement sweep, retry, routing, map generation or generic tool dispatch.
Cancellation kills the owned child with SIGTERM, then SIGKILL after two seconds,
and waits for process/stdio close. Spawn errors are also closed without waiting
for an impossible process exit event. One-MiB incoming lines are bounded before
JSON parsing. Child stderr and source exceptions are not copied into diagnostics.

The environment is fixed, not inherited: dedicated HOME/config/temp/cache and
DuckDB extension directories, native routing/recreation/autowarm disabled, four
DuckDB threads, one cursor, 512MB DuckDB memory, 128MB cache, 32MB divisions cache,
15-second HTTP timeout and 16,000-token soft response budget. These are NOT a
whole-process RSS ceiling, whole-download quota or a guarantee of fast cold scans.

Incomplete/truncated identities or provenance, degraded schema, unknown source
licenses, unsafe/signed/non-HTTPS public metadata URLs and changed detail IDs fail
the entire preparation. No successful empty or partial cohort is returned. Missing
optional contact/operating fields stay null/empty, never absence or qualification.
Raw names and source text are untrusted data, never instructions.

## Sources and limitations

- PyPI metadata: <https://pypi.org/pypi/placeroot/0.12.0/json>.
- Installed wheel source: `placeroot/server.py` (tool signatures and
  `build_server`), `_server_cli.py` (CLI warmers), `overture.py` (taxonomy and detail
  records), `db.py`, `cache.py`, `budget.py`, `resources.py` (actual environment and
  release contracts). Actual package code reads `taxonomy.primary` and
  `basic_category`, not the removed source `categories` column.
- Current Places guide, read 27 October:
  <https://docs.overturemaps.org/guides/places/>. The guide identifies release
  **2026-10-21.0**; the connector records the release actually reported by
  `data_version`, rather than forcing that date or claiming the package-selected
  release is latest. Actual release discovery was NOT called in this subtask.
- Per-record provider mapping from that guide: Foursquare Apache-2.0;
  AllThePlaces CC0-1.0; Meta, Microsoft, Birdeye, BrightQuery, DAC, Krick,
  OpenTravel, PinMeTo, RenderSEO and Uberall CDLA-Permissive-2.0. Unknown provider
  strings fail closed. Preserve original `sources` records and IDs alongside
  derived license labels; do not replace them with blanket CDLA attribution.
- <https://docs.overturemaps.org/attribution/>. Division boundary selection carries
  separately labelled OSM/Overture ODbL attribution; Places is not labelled ODbL.

Actual installed Python/MCP initialize/list passed; `pip check` passed. All **19
focused tests passed** after observed RED failures (missing connector, then eight
acquisition failures, then the real ENOENT/close-lifecycle regression). JS and
Python bridge syntax checks passed. Effective named-user ACL read access for the
five documentation/metadata files and ancestor traversal for `msi` were checked;
switched-user execution was unavailable. The lead owns the integrated full suite.
Offline
fixtures cover malicious names, unsafe URLs, source failures/partial records,
license gaps, cancellation, bounds, actual oversized child output, child reaping
and spawn failure. **No real business query, live data_version call, category or
geocode tool call, seed_prepare, DB mutation, model-production call, paid API,
credential read, publication or acceptance occurred in this runtime task.**
DuckDB extension availability, cloud source accessibility, actual release/schema
completeness and useful live seed supply remain unproved. The lead owns integrated
preflight and the separately bounded live proof; no readiness result silently
authorizes it. Do not install unbounded replacement dependencies if it fails.
