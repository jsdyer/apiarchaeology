# API Archaeology

A public, browser-based explorer for published API definitions. Compare endpoint inventories, authentication requirements, deprecation flags, parameters and response schemas using retained evidence, then export a dated report.

**[Open API Archaeology](https://coolcode.ca/apiarchaeology/)** · [CoolCode](https://coolcode.ca/)

<!-- coolcode:guide -->
API Archaeology watches six public API definitions in the APIs.guru directory: Apicurio Registry, Canada Holidays, APIs.guru itself, NASA APOD, NASA Asteroids and Wikimedia. Select an API, then a “from” and “to” definition. Each choice includes the version and actual collection date. The first capture includes two genuine Apicurio versions, so a meaningful comparison is available immediately; other single-version APIs start as inventories until another collection is retained.

Search by method, path, summary or change type. Select an operation for authentication, parameters, response codes and field-level evidence. The shared-schema inventory provides a second view of additions, removals and changed definitions. “Changed” means the specification differs; it is not a compatibility judgment or proof that a live service behaves differently. Directory update dates can be old and are not provider release dates.

You can also select two local OpenAPI 3.x or Swagger 2.0 JSON files (10 MB each); omit the first file to inspect an inventory. These files stay in the current browser tab and are not uploaded or saved. YAML is not supported. Export JSON for the complete compared evidence and source hashes, or CSV for the operation inventory.

Collection runs weekly on Tuesday at 07:13 UTC through GitHub Actions, subject to scheduler delays. The workflow can also be run manually with “Capture fresh public definitions before building” enabled. All definitions must validate and all checks must pass before new data is committed and the site is deployed. Earlier captures remain available. No keys or API registrations are needed: the collector reads specification documents only and never invokes the APIs they describe.
<!-- /coolcode:guide -->

## Evidence and scope

- **Collection:** [APIs.guru public directory API](https://api.apis.guru/v2/list.json) and the exact `swaggerUrl` definitions returned for the six watched entries. [Directory documentation](https://apis.guru/api-doc) and [source repository](https://github.com/APIs-guru/openapi-directory).
- **Formats:** Swagger 2.0 and OpenAPI 3.x `paths`. [OpenAPI specification](https://spec.openapis.org/oas/v3.0.3.html).
- **Source licenses:** each captured definition retains its original `info.license` and `x-origin` metadata. APIs.guru's [license explanation](https://github.com/APIs-guru/openapi-directory#licenses) distinguishes contributed material from definitions collected from other sources. An open specification does not imply unrestricted access to the underlying service.
- **Comparison:** exact uppercase HTTP method plus path. Root and operation security, applicable security schemes, inherited path parameters (with operation overrides), request bodies, responses, deprecation, servers and documentation are compared. Swagger 2 body parameters appear under parameters. Local references contribute their resolved content; cycles terminate at an explicit reference marker. Named shared schemas are compared separately in their raw form.
- **Semantics:** object key order is ignored. Security alternatives/scopes and merged parameters are normalized; other arrays retain source order. Structural changes may be editorial or reordered examples. Path renames appear as a removal plus addition. Matching paths across versions may have different servers; server changes are reported.
- **Limits:** external references are not fetched; unresolved local references are identified. Callbacks and webhooks are not separate operations in the inventory. Expansion stops after 70 levels or 25,000 nodes per expanded field and reports a warning; definitions exceeding 5,000 operations are rejected. The UI shows at most 40 field-level changes at a time, with full normalized records available in JSON. It does not test live endpoints, infer API shutdowns, or prove backward compatibility.
- **Time:** `capturedAt` is a real collection timestamp. `directoryUpdated` and `directoryAdded` are source metadata. API versions may cover different generations or incomplete old documentation, and are not automatically ordered as releases. No pre-collection history is invented.

## Data retention and refresh

`scripts/refresh.py` downloads the APIs.guru directory and the watched specifications. The collector accepts only HTTPS URLs on `api.apis.guru`, has a 10 MB response limit and spaces requests. All requests and format validation complete before the current manifest is replaced.

- `web/data/manifest.json` lists every retained capture, newest first.
- `web/data/captures/<UTC timestamp>.json` records the versions, source URLs, source metadata and hashes at that observation.
- `web/data/specs/<sha256>.json` retains canonical JSON definitions. Identical documents are stored once, while each dated observation is retained.
- The hash is SHA-256 of UTF-8 JSON with sorted keys, compact separators and a trailing newline. It verifies the stored document, not the original HTTP response bytes.
- The default build is offline. It verifies every retained specification hash and capture reference before replacing `dist/`.
- A failed refresh/check cannot deploy or commit new data. The last successful Pages deployment remains available. GitHub workflow notifications follow the repository owner's notification settings; this tool does not send email itself.

To add an API, edit `WATCH` in `scripts/refresh.py` using an identifier from the directory, review its listed versions and source license, collect a baseline and run all checks. All listed versions of each watched API are collected, not just its preferred version.

## Privacy

The initial page fetches retained JSON from this site's static files. Selecting operations and exporting reports does not call third-party APIs. Local JSON files are read in memory, never uploaded, and are discarded when the page is closed or reloaded. Do not include credentials in specifications that you publish into the repository. User files are not added to the collection.

The page loads Google Fonts and CoolCode's shared visit counter under the site's normal policy. External source links open only when clicked. No API keys or browser storage are used.

## Development

Requires Node.js 24 and Python 3.12. No application dependencies or bundler are required.

```bash
# Optional network refresh; writes a real capture after validating all sources
python3 scripts/refresh.py

# Offline checks and build
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -v
python3 scripts/build.py
```

CI installs test-only Playwright dependencies from `tests/browser-requirements.txt` and runs `tests/browser_smoke.py` against the built app at a project subpath. It covers initial real data, search/filter selection, a single-version inventory, local JSON comparison, safe text rendering, downloads and desktop/mobile layout. Review screenshots are uploaded as an artifact.

PRs check and build. Successful `main` builds deploy through GitHub Pages. The weekly/manual refresh is retained by `github-actions[bot]` only after tests, offline build and browser checks succeed. The workflow needs repository Contents write permission and Pages configured to use GitHub Actions. No CNAME or Cloudflare change is required.

## Files

- `web/model.mjs`: pure parser, reference handling, comparison and CSV generation.
- `web/app.mjs`: selection, safe DOM rendering, local import and exports.
- `scripts/refresh.py`: validated public-data collection and archive verification.
- `scripts/build.py`: offline static build, metadata and archive checks.
- `tests/`: model, archive integrity/failure handling, build and browser checks.
- `tool.json`: CoolCode catalogue entry.
