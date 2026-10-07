# Cairnfield: instructions for agents

Cairnfield lets agents from many teams change the same shared code at once. Teams publish checkable findings and patches from their own repos, an index shows them together, and each team builds the version it trusts.

## Where things stand

The repo holds a static site, the workspace scaffold and the protocol library in `protocol/`. The other packages hold placeholders. Product code arrives unit by unit from a build plan.

- The build plan is a private planning document. It lives under `docs/`, which Git ignores, so it is not part of this repo. Never commit a file under `docs/`.
- When `docs/plans/` exists in your checkout, the plan there is the source of truth. Read its Goal Capsule first, then the unit you are working on and the requirements (R) and decisions (KTD) that unit cites. Do not read the whole file to find your way; scan its headings.
- Never edit anything under `docs/brainstorms/`. It is a historical record, and the plan overrides it wherever they differ.
- Public documentation goes in `reference/`: the protocol, the threat model and the platform notes. It arrives with the README unit.
- `site/` is the public microsite, a Cloudflare Worker that serves static files from `site/public/`.

When the plan and this file disagree, the plan wins. Tell the developer about the disagreement.

## Setup

- Node 22.22.1. Run `nvm use` in the repo root. Wrangler will not start on Node 20.
- Use the Wrangler installed in each project (4.147 or later), never a global one.
- Worker secrets are set by the developer by hand. Stop and ask when a step needs one. Never write a secret to a file in the repo.
- Never run `wrangler deploy --temporary`. When Wrangler is not logged in it suggests that flag, which creates a temporary Cloudflare account and accepts Cloudflare's terms on the developer's behalf. Stop and ask the developer to log in instead.

## Commands that exist today

| Command | Where | What it does |
| --- | --- | --- |
| `npm run dev:site` | repo root | Serves the microsite locally at `http://localhost:8787` |
| `npm run check` | `site/` | Dry-run of the site deploy |
| `npm run deploy:site` | repo root | Deploys the site. Ask the developer first |
| `npm install` | repo root, and again in `node/` | Installs the workspace. `node/` and `site/` install on their own |
| `npm test` | repo root, and in `node/` | Runs the Vitest suites |
| `npm run typecheck` | repo root, and in `node/` | Type-checks every package |
| `npm run scan:secrets` | repo root | Scans the repo for secrets |

Later units add the Worker dry-run, demo and scale commands listed in the plan's Verification Contract.

`.npmrc` sets `legacy-peer-deps` in the repo root and in `node/`. npm 10 crashes while resolving the peer set of Vitest 4.1, and the Workers test pool needs Vitest 4.1. Keep the setting.

## Layout the plan will create

| Path | Holds | Note |
| --- | --- | --- |
| `protocol/` | Record schemas, limits, validation, patch checks | Pure functions, no platform dependency |
| `node/` | Team node Worker | Self-contained, its own lockfile, imports nothing from the workspace |
| `index/` | Index Worker, database migrations, public page | |
| `cli/` | The `cairnfield` command and reviewer agents | |
| `sim/` | Scale simulator | |
| `site/` | Microsite | Self-contained, its own lockfile |
| `reference/` | Public protocol, threat model and platform notes | |

## Rules that must not break

These come from the plan. Each names the requirement or decision that owns it.

1. **No free text in a record.** Every field is an enumerated value, a hash, a number, a path in the pinned copy, or a hostname that appears in the cited lines (R2).
2. **The command pushes, never the agent.** Reviewer agents get read-only file tools, no shell and no network tool, and no credential within reach (R18, KTD16).
3. **Hostile text reaches a model only inside a tool result.** That covers file content, patch diffs and other teams' record fields (KTD16).
4. **A component is its full commit hash.** No write token is ever issued for a component copy (R8).
5. **Records are immutable and named by the hash of their content** (KTD1). Nothing edits or deletes a published record.
6. **The index is untrusted.** Assembly fetches patches and confirmations from the nodes and re-checks them locally (R25, KTD23).
7. **The index serves data, never instructions.** Instructions for agents live only in this repo. Do not add a route or file to the index that tells an agent what to do.
8. **Values from another node are hostile until validated,** above all before they reach Git (KTD33).
9. **Live model calls never run in the test suite.** Tests use the replay mode or fakes (KTD18).

If a change seems to need one of these broken, stop and ask.

## Content rules

- Every plugin, host, team and organization in fixtures, demos, docs and the site is invented. Use the reserved `.example` domain for hosts.
- Never add a finding about a real product. The competition rules bar it, and a wrong finding is a legal exposure.
- The site's press release is a draft written before the build. Do not name the method behind it on the site. Keep its "written before the build" label accurate, and keep the status table in `README.md` current as units land.
- Write docs in short, direct sentences. Use sentence case for headings.

## Working on the site

- Pages are plain HTML in `site/public/`, with no build step. They share `site.css` and `map.js`; the script draws the map behind the page and the trail through it, and each page must stay complete and readable without it. The home page carries what each audience must understand first. The announcement page carries the press release and the two question sets. The sketches page shows the product.
- Every animated figure must rest in its finished state, so a reader who asks for reduced motion sees the complete picture.
- Outline style carries meaning. Solid means confirmed or built. Dashed means unconfirmed or planned. Dotted means simulated or not in this prototype. Do not use a dashed or dotted outline for decoration.
- The page is one landscape: a contour field behind everything, and a small cairn at the start of each section joined by a trail. Give a new section a waymark cairn.
- `site/public/_headers`, `robots.txt`, `sitemap.xml` and `llms.txt` describe the site to agents and crawlers. Update `sitemap.xml` and `llms.txt` when you add a page.
- The 404 page lists the site's pages. Update it when you add one.
