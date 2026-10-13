# Platform notes

Cairnfield runs on Cloudflare Workers and Cloudflare Artifacts, and is deployed with Wrangler. These notes say what each was seen to do while the prototype was built, and what was only read in documentation.

Every note carries one of three labels.

- **Observed.** Someone ran it and saw the result, on the date given.
- **Documentation.** It was read in Cloudflare's documentation or in the binding types. It was not run.
- **Working note.** It was written down while building. The note does not say whether it was run.

The platform changes. Check a note against the live service before you rely on it.

## Local environment

**Observed in October 2026.**

- Outside the repo folder a shell may fall back to an older Node. The command needs Node 22.22, and Wrangler does not start on Node 20. Run `nvm use` in the repo root. `.nvmrc` names 22.22.1.

**Working notes.**

- Wrangler 4.147 needs Node 22. A global Wrangler 4.43 had no `artifacts` commands. Use the Wrangler installed in each project, never a global one.
- `node/` pins Wrangler to one exact version, because the push trigger shape it accepts differs from the guide and may change. Run the dry-run deploy again after any upgrade.
- Worker secrets are set by hand, with `wrangler secret put`. No secret is written to a file in the repo.
- When Wrangler is not logged in, it suggests `wrangler deploy --temporary`. That flag creates a temporary Cloudflare account and accepts Cloudflare's terms for whoever runs it. Do not run it.
- `wrangler dev` with `"remote": true` on the `artifacts` binding runs a Worker locally against the real Artifacts service.
- A Worker registered as a queue consumer must export a queue handler, or the deploy fails.
- Leaving a KV namespace ID out of the Wrangler config provisions the namespace on deploy.
- `"workers_dev": false` with `"preview_urls": false` deploys a Worker with no public URL.
- npm 10 crashes while it resolves the peer set of Vitest 4.1, which the Workers test pool needs. `.npmrc` sets `legacy-peer-deps` in the repo root and in `node/` for that reason.

## Tests and the Artifacts binding

**Observed in October 2026.** Artifacts has no local simulation. The Workers test pool would open a session on the developer's Cloudflare account to reach it. `remoteBindings: false` in `node/vitest.config.ts` and `index/vitest.config.ts` stops that. The tests put an in-memory fake in place of the binding, and no test reaches the live service.

## Artifacts, first check

**Observed on Oct 4, 2026**, against a live Artifacts namespace made for the check.

### Names and tokens

- A namespace is created by the first repo created in it. `wrangler artifacts namespaces list` was empty before that.
- A repo remote has the form `https://<account-id>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`.
- A repo token has the form `art_v2_<hex>?expires=<unix seconds>`. The documentation still shows `art_v1_`. Match both when you redact a log.
- `wrangler artifacts repos create --json` returns `id`, `name`, `description`, `default_branch`, `remote` and `token`.
- `wrangler artifacts repos issue-token --json` returns `id`, `plaintext`, `scope` and `expires_at`.
- The Wrangler CLI has no import command and no fork command. Both exist on the binding and in the REST API.

### Git over HTTPS

- `git -c http.extraHeader="Authorization: Bearer <token>"` works for clone, fetch, pull and push.
- A token for one repo, used on another repo, fails with HTTP 403 and "Invalid or expired token".
- A read token used to push fails with HTTP 403 and "Insufficient permissions".
- With no token, the remote answers "Authentication required".
- Two rejections appear when pushes collide: `! [rejected] (fetch first)` and `! [remote rejected] (stale ref)`. Treat both as "pull and retry". Three pushes at once to one branch all landed within three tries.
- `git fetch <remote> <full commit hash>` works, so one patch commit can be fetched with no branch name.
- A clone that held only a fork's URL and a read token fetched a patch commit from the fork, with no Cloudflare credentials. This was within one account.
- A repo marked read-only accepted pushes and a force-push from a write token. So Cairnfield never issues a write token for a component copy, and names a component by commit hash, never by branch.
- A force-push is allowed, so a team can rewrite the history of its own repo.

### The Workers binding

- `repo.info()` returns `id`, `name`, `description`, `defaultBranch`, `createdAt`, `updatedAt`, `lastPushAt`, `source`, `readOnly` and `remote`.
- An entry of `repo.log()` carries `hash`, `treeHash`, `message`, `author`, `committer`, `parents`, `authoredAt` and `committedAt`. The two times are Unix seconds.
- `repo.readFile({ ref, path })` returns a Blob, or null for a missing path. A 40-character commit hash works as `ref`. A short hash returns null.
- An import takes a branch, not a commit. Older commits on that branch were readable by full hash.
- `import()` returns before the import finishes. In the check, `log()` returned commits about 3 seconds later.
- An imported repo reported `defaultBranch` as `main` when its only branch was `master`. `lastPushAt` stayed null after pushes. Rely on neither field.
- `info().source` reads `git:<url>` for an import and `artifacts:<namespace>/<repo>` for a fork.
- `repo.createToken(scope, ttl)` returns `id`, `plaintext`, `scope` and `expiresAt`.

### The push trigger

This entry in a Wrangler config deployed and fired. The Artifacts guide shows another shape, with `filter.repoName` and a single `target`, which Wrangler 4.147 does not accept.

```jsonc
"workflows": [{ "name": "<workflow-name>", "binding": "ONPUSH", "class_name": "OnPush" }],
"triggers": {
  "events": [
    {
      "type": "cf.artifacts.repo.pushed",
      "filter": { "namespace": "<namespace>" },
      "targets": [{ "type": "workflow", "workflow_name": "<workflow-name>" }]
    }
  ]
}
```

- The Workflow's `event.payload` held `id`, `type`, `source` with `namespace` and `repoName`, and an inner `payload` with `ref`, `before`, `after`, `commits`, `totalCommitsCount` and `commitsTruncated`.
- The Workflow instance finished about 2 seconds after the push.
- A Workflow step called an outside host over HTTP.
- `wrangler queues subscription create --source artifacts.repo` fails, because it has no flags for the namespace and the repo that the API requires.

**Not known.** Whether the trigger honors the Workflow creation limit of 100 per second. The second check below saw what it uses as the instance ID.

## Artifacts events, second check

**Observed on Oct 12, 2026**, against a live Artifacts namespace made for the check. A throwaway Worker was deployed with Wrangler 4.147.0. Its Workflow kept each event it was started with. Each row of the check had a repo of its own, so an event named the row it came from. Every repo was pushed to first, and one repo was only pushed to, as the control. A run waited 90 seconds after its last operation. The check ran to its end twice, and both runs agreed. The row for a second fetch, into a repo that already held a commit, was in the second run only. A run between the two stopped early: about a minute after the Worker was deployed again under the name it had just been deleted from, `workers.dev` answered one request with a 404 of its own, after three requests had reached the Worker.

### The trigger

- A config with three `triggers.events` entries deployed: `cf.artifacts.repo.pushed`, `cf.artifacts.repo.fetched` and `cf.artifacts.repo.cloned`. Each had the shape of the push trigger above, with a namespace filter, and one Workflow was the target of all three. Wrangler printed `event triggers: 3`.
- The two runs kept 17 and 21 events. Each event had an `id`, no two were the same, and each Workflow instance's ID was its event's `id`. The events-schemas page shows no event ID.

### What sent an event

| Operation | Token | Event |
| --- | --- | --- |
| `git fetch --depth=1 <remote> <commit hash>` into an empty bare repo | read | One `cloned`, 2.1 to 4.5 seconds later |
| The same fetch | write | One `cloned`, 3.5 and 5.4 seconds later |
| A second fetch of that kind, of a newer commit, into a repo that held the first commit under a ref | read | One `fetched`, 3.5 seconds later |
| `git clone` | read | One `cloned`, 2.8 and 3.9 seconds later |
| `git fetch <remote> refs/notes/cairnfield:refs/notes/cairnfield` into an empty bare repo | read | One `cloned`, 2.8 and 3.1 seconds later |
| `git ls-remote` | read | None |
| `readCommit`, `readTree`, `readBlob`, `readFile` and `log` on the binding, each on a repo of its own | | None. Each read found what it asked for |
| `git push` of a branch | write | One `pushed`, 1.9 to 7.0 seconds later |
| `git push` of `refs/notes/cairnfield` | write | One `pushed` that names the ref, with no commit in `commits` |
| Nothing but the first push, on the control repo | | No `cloned` and no `fetched` |

- A fetch into a repo that held nothing came as `cloned`, whatever the Git command. A fetch into a repo that already held a commit of the repo came as `fetched`.
- The payload of a `cloned` and of a `fetched` event held `id`, `type`, `source` with `namespace` and `repoName`, and an inner `payload` with no member. It names the repo, and nothing about who fetched or what.

### The notes ref

- A write token pushed `refs/notes/cairnfield`.
- A read token then listed that ref with `git ls-remote` and fetched it. The fetched ref was the commit that was pushed. Its tree held one entry, named by the commit the note was on.
- A push of the notes ref sends a `pushed` event, as the table says. So a node's push Workflow starts on it.

**Not known.** What a fetch that brings nothing new sends. Whether one event can arrive twice. Whether an import brings a notes ref of the repo it imports into a copy, and so into the forks of that copy. What a subscription for one repo delivers to a queue: the check did not need one and did not try it.

## Deployed nodes and index

**Observed on Oct 9 and 10, 2026**, on the demo's deployed Workers.

- Artifacts refused a push made with a read token, at the handshake and at the push endpoint.
- An import brought a branch's full history.
- A fetch of one commit by its hash at depth 1 worked.
- The command on one team's machine fetched another team's patch commit from that team's fork, with the fork's public read token. Both nodes were in one account.
- The index read the nodes over HTTP. The index and the nodes are Workers in one account, and each sets the `global_fetch_strictly_public` compatibility flag.
- A node shows a new head in the index within about a minute of a push.
- **Observed on Oct 11, 2026**, after a deploy of the index. Its two pages answered with the content type `text/html`, and their script and stylesheet with `text/javascript` and `text/css`, each with no charset. The stand-in for the assets binding in the tests answers `text/html; charset=utf-8`.
- **Observed on Oct 11, 2026**, in a browser. Cloudflare added the script of its Web Analytics beacon, from `static.cloudflareinsights.com`, to both pages of the index. The pages' content security policy takes scripts from the index's own origin alone, so the browser refused it and wrote one error to the console on each load. The pages drew as they should. The HTML that `curl` received held no such script.
- **Observed on Oct 12, 2026**, after a deploy of the index and of both nodes with the count of fetches. A node's config has two Workflows and three event triggers, and a fetch was counted on a deployed node.
  - One node answered `not-found` for the count of its fork. One `git fetch --depth=1` of the component's commit into an empty repo followed, with the token from that node's `read-token` route. The node answered `not-found` 1, 3 and 5 seconds after the fetch, and a count of 1 after 8 seconds. No more looks were made in between.
  - The index's view held no count for the node about 8 and 12 seconds after the node first served one, and held it after about 16. The other node did not run the new code yet. It answered 404 for the route, and its entry held no count.
  - The demo was then reset and played twice, with both nodes on the new code. The nodes served counts of 22 and 11. A `git ls-remote` of each fork changed neither. A fetch of each fork's notes ref into an empty repo raised each by one, to 23 and 12. The index's page, in a browser, drew the section of fetches with those two numbers.
  - After the two plays each fork held `refs/notes/cairnfield`, and a token from the node's `read-token` route listed and fetched it. Each ref held two commits, one for each note, so the second play added none. Each commit had the fixed author, date and message of a notes commit. Each tree held two plain files, each named by a patch commit that the fork's team had pushed. Each note held `commit`, `findings`, `model`, `recording` and `version`. None held `prompt`: the demo's recordings are from before a recording held one. Each of the four notes named its recording by the hash that the saved recording in `fixtures/recordings/` has. Both teams wrote the same patch commit for one finding, and each fork's note under that commit named its own team's recording.
  - **Not known.** Whether a push alone still leads to a notice on a node with the three triggers. The plays did not show it apart, because a counted fetch sends the notice a push sends. What the two plays printed: only what they left on the nodes and the index was read.
- Artifacts took a push of a commit whose root tree holds no file. The demo's reset pushed one to each node's repo of records on Oct 10, twice, and each node then listed no record at the new head.

## What the command has done on the deployed demo

These notes say what each command has done on the demo's deployed nodes and index, apart from the tests. They are the long form of the "Note" column of the README's status table. The dates are the days the README first recorded each run.

**Observed on Oct 9, 2026.**

- One demo node held a patch commit and passed the contract check in `scripts/check-node-contract.ts`.
- `patch`, in a live run with a model, on a deployed node, patched the demo plugin's any-host rule. Its recording is in `fixtures/recordings/`. A replay from that recording gave the same commit and the same records. Live runs on both injection fixtures in `fixtures/injection/` changed only the cited line.
- `assemble`, on a deployed node with no index, built one demo team's copy of the demo plugin twice with one file-tree hash, and published its recipe.
- `verify`, from a clean folder with no config file and no key, passed on a clone of a demo team's published copy and failed on a clone of the original. A run on a second machine is still to come.

**Observed on Oct 10, 2026.**

- `patch`, in a live run on the other demo team's node, narrowed the environment variables the demo plugin may read. Its recording is in `fixtures/recordings/`.
- On the demo plugin's hidden instruction, `patch` wrote no patch in four live runs with two models. The model's service refused the first run. In the other three the model read the line, then called a tool again and again until the run's limit of 40 requests. The command published only the claim each time. The demo's two recordings for that line are written by hand, with the model `none`.
- Through the deployed index, one demo team's lens named the other, and `assemble` fetched that team's patch from its fork, checked it again and built a copy with both teams' patches.
- `carry`, on a deployed node, moved one demo team's work to the demo plugin's later commit. Its patch kept its patch ID, its finding on the script that changed was reported as not carried, and the copy it then built passed `verify`. A second run published nothing. From a home whose copy of the older commit held the other team's patch, the command named that patch as left behind.
- Both demo scripts ran on the two deployed nodes and the deployed index: the reset, then the demo, then both again. The reset emptied both nodes and the index, and the demo then played its four steps to the end. The second run left the page with the same finding IDs, patch IDs and file-tree hashes as the first.

**Observed on Oct 11, 2026.**

- Both pages of the deployed index were opened in a browser and drew what the index served: two patches on adjoining lines side by side, one patch that both teams wrote as one confirmed entry, and a patch made by hand rejected as out of scope. The index's own page listed the demo plugin's two commits.
- The node's page was opened in a browser from a local address, over the tests' stand-in for Artifacts and with the headers a node sets.

**Observed on Oct 12, 2026.**

- Both demo nodes served their page, and a team's name on the index's page led to it.
- The deployed page drew the line of a declared model for each of the demo's four patch records.
- The section of fetches was drawn in a browser from the built page over a saved view of the demo, with a count added by hand for each team. Later that day the deployed view held a node's count within 20 seconds of the node first serving it, and the deployed page listed a count for each demo node. The notes under "Deployed nodes and index" above say what the counts were.

**Not run.** `npm run setup` has not run on a Cloudflare account. Its tests run it against a stand-in for Wrangler and a fake node. Nobody has followed the replay's deploy steps from the first step in a new Cloudflare account: the deploys and the two scripts ran at different times, on nodes and an index that were already there.

## The index's first deploy

**Observed on Oct 10, 2026**, with Wrangler 4.148.0.

- `wrangler deploy` found no D1 database and no queue under the configured names, and created both by itself.
- It then rewrote the Wrangler config file, with resource IDs in it and without the comments. This repo keeps no ID in `index/wrangler.jsonc`, so that rewrite is discarded.
- The new database had no tables. The view answered HTTP 500 until the migrations ran.
- Afterwards Wrangler found the database by its name, with no ID in the config.

`AGENTS.md` gives the order of an index release.

## Artifacts reference check

**Documentation, read on Oct 6, 2026.** The full Artifacts reference was read against the design. A fact marked (types) came from the binding types bundled with Wrangler 4.147.0, which the documentation names as the source of truth. Nothing in this section was run against the live service on that day.

### What the reference and the types say

- A tree entry has `name`, `mode`, `hash` and `type` (types). `type` is one of `tree`, `blob`, `symlink`, `gitlink` and `exec`, so a walk can spot a symbolic link and a submodule entry. `readTree` returns the immediate children of one tree. Commit metadata has `treeHash` and `parents` (types).
- The config schema in Wrangler 4.147.0 accepts `filter.namespace`, `filter.repo_name` and `targets` entries with `type` and `workflow_name`, and no other keys. The guide, updated Oct 1, still shows `filter.repoName` and one `target` with `scriptName` and `workflowName`.
- A create, an import and a fork each return a token. `createToken` defaults to write scope and a life of 24 hours.
- `fork()` copies only the default branch unless `defaultBranchOnly` is false (types).
- `log()` reads `HEAD` by default, returns an empty list for a ref it cannot resolve, and follows first parents only. `get()` throws `IMPORT_IN_PROGRESS` or `FORK_IN_PROGRESS` until a repo is ready.
- A name starts with a letter or a digit. A namespace name has 2 to 63 characters. Object IDs are lower-case.
- Control-plane requests are limited per namespace.
- The documentation promises no delivery for a push event. So `publish` sends the index a notice of its own.
- The `filter` capability of Git is not supported. A shallow fetch is.
- Every remote has one form, on `artifacts.cloudflare.net`.
- An import can fail with `INVALID_URL`, `REMOTE_AUTH_REQUIRED`, `NOT_FOUND`, `UPSTREAM_UNAVAILABLE` or `MEMORY_LIMIT`. An import takes a branch and an optional depth.
- A push to any repo in a namespace starts the Workflow of a trigger that filters by namespace only. A delete is accepted before it completes.
- The best-practices page prefers a repo per agent to one shared repo.
- The binding names a namespace and no account. That is why an index reads another team's repos through that team's node.

### Where the documentation is stale

- The documentation shows the token prefix `art_v1_`. The service issued `art_v2_` (observed Oct 4).
- The documentation presents `readOnly` as a guard. A write token still pushed to a read-only repo (observed Oct 4).
- The documentation says `list()` returns a `status` for each repo. The types have no such field, so readiness comes from `get()`.
- One page says the binding cannot read files. The types have `readFile`, `readTree` and `readBlob`, and `readFile` was observed on Oct 4.

### Where the reference agreed with what was observed

- The remote URL form, and a namespace created by its first repo.
- Repo-scoped read and write tokens, sent in `http.extraHeader`.
- `readFile` at a full commit hash.
- Import by branch from a public HTTPS remote, and no Wrangler command for import or fork.
- The fields of the push payload.

## A walk shared between requests

**Observed on Oct 12, 2026, in local workerd only.** The runtime was workerd 1.20260815.1 through Miniflare, at the compatibility date `2026-08-15`. The Worker kept a promise in module state, as the node's page does, and a slow service binding stood in for Artifacts.

- Two requests that arrived while a first request's reads ran got that walk's answer when it ended, about 1.2 seconds in.
- They still got it when the first request's reader left 200 ms in, before the walk ended.
- The same run without the hand-off to `waitUntil` gave the same answers. So the local runtime does not show what the hand-off adds.
- A request after the walk got the kept answer at once.

**Observed on Oct 12, 2026, on a deployed node.** Five requests for a node's page were sent together, 35 seconds after the last view of it, so the node kept no page.

- All five answered 200 between 1.5397 and 1.5411 seconds after they were sent, each with the same time of drawing. The page gives that time to the second. This fits one walk that all five waited on, and does not show it: several isolates that each walked would give the same second.
- A request five seconds later got the same page, with that time.
- The page carried its policy with the hash of its one style, `cache-control: no-store`, `x-robots-tag: noindex, nofollow`, `referrer-policy: no-referrer` and `nosniff`. A request with a query answered 400.
- In a browser the style applied under the policy, at 1280 and at 390 pixels wide, with no message in the console. A team's name on the index's page led to that team's page.

**Not known.** Whether the five requests reached one isolate and shared one walk, or reached several that each walked: nothing in the check counted the node's reads of Artifacts. What the hand-off to `waitUntil` adds on a deployed Worker: no reader left during a walk in this check.

## Platform limits

**Documentation, not run.**

- **Workflows.** 10,000 steps per instance by default. 1 MiB per step result and per event payload. 50,000 concurrent instances. 100 instance creations per second per Workflow. The documentation gives no default for step retries and timeouts.
- **D1.** 10 GB per database. 1,000 queries per Worker invocation. 100 bound parameters per query. One writer per database. `db.batch()` runs as one transaction.
- **Queues.** No built-in deduplication.
- **Artifacts.** 2,000 control-plane requests per 10 seconds per namespace. 2,000 Git requests per 10 seconds per repo. 1 GB per repo, 32 MB per blob and 1 TB per account. The documentation classes the binding as control plane, so a node's reads and its token mints share one namespace budget.
- **Artifacts pricing.** The first 10,000 operations and the first 1 GB each month are included. A clone or a fetch with a read token that a node issued is an operation on that node's account. The pricing page and the changelog say billing starts Oct 14, 2026. The announcement post says Oct 15.
- **Worker to Worker.** A `fetch` from one Worker to another in the same account fails with error 1042 unless `global_fetch_strictly_public` is set.
- **Plan.** Artifacts needs the Workers Paid plan.

## The deploy button

**Result: not tested.** Nobody has run Cloudflare's deploy button against the node in `node/`.

Until a test shows otherwise, the setup script in `node/` is the supported way to deploy a node. It runs as `npm run setup` there. A test has to show that the button sets up three things: the Artifacts binding, the Workflow and the push trigger. It also has to leave the admin key for the operator to set.

**Documentation, not run.** This is what Cloudflare's page on deploy buttons says.

- The URL form is `https://deploy.workers.cloudflare.com/?url=<public repo URL>`. A subdirectory is given as `.../tree/main/<dir>`. The repo must be public, on GitHub or GitLab.
- The subdirectory becomes the root of a new repo, so it must hold its own dependencies and lockfile. `node/` does.
- The resources it lists as provisioned are KV, D1, R2, Hyperdrive, Vectorize, Secrets Store, Durable Objects, Workers AI and Queues.
- Artifacts, Workflows and event triggers are not listed. The page does not say that they fail.
- It prompts for the secrets named in `.dev.vars.example` or `.env.example`. Plain values go in `vars`.
- It runs a `deploy` script from `package.json` when one exists, and `npx wrangler deploy` otherwise.
- A `cloudflare.bindings.<NAME>.description` entry in `package.json` adds help text for that variable or secret on the setup page.
- The setup page lets the operator rename the repository, the Worker and the resources.
- Each Worker in a repo needs its own button.
- A temporary account, as `wrangler deploy --temporary` makes one, cannot host a node or an index. Its supported resources do not include Artifacts or Workflows.
- Cloudflare's Terraform provider documents no Artifacts binding and no Workflow binding. So the other route to a node is a Wrangler script, not Terraform.

## Wrangler environments

**Documentation, not run.** A Wrangler environment deploys as `<name>-<env>` and inherits no bindings and no `vars`. Wrangler 4.147.0 requires a Workflow name to be unique in the account, and a deploy from another environment takes over a Workflow of the same name.

So each demo node environment in `node/wrangler.jsonc` repeats its `artifacts` binding, and declares its own Workflow and its own push trigger for its own namespace.

## Workers Builds for Artifacts

**Documentation, read on Oct 8, 2026. Not run.**

- An Artifacts repository connects to a Worker through Workers Builds. The guide describes the connection only as dashboard steps.
- A push to the production branch runs the build and deploy commands. Only `main` is supported as the production branch.
- Builds for other branches must be switched on. A push then creates or updates a Preview URL for the branch.
- The repository must hold the source and the configuration to build and deploy. An empty repository connects, and its first build fails until a commit arrives.
- The account role needs the Artifacts Read and Artifacts Edit permissions.

One consequence holds for Cairnfield whatever a test shows. Nothing deploys from a records repo. A push there would become a deploy, and a token that can write records could then change a Worker.

## Workers Builds and Access for the site

**Observed on Oct 11, 2026**, on the site's Worker, which serves static files and has no script.

- Importing the GitHub repository in the dashboard made the Worker and ran one build from the repository's default branch. The form had a field for the folder to build in, and none for the branch.
- The branch a Worker deploys from is set afterwards, in the Worker's build settings. Changing it started no build.
- With the folder set to `/site/`, the build ran `npx wrangler deploy` there with the repo's own config. That deploy attached the custom domain the config names and made its DNS record.
- With `workers_dev` and `preview_urls` set to false in the config, the Worker's address on `workers.dev` answered 404.
- An Access application for the domain's hostname was made before the Worker existed. From the first deploy, every path answered with a redirect to the login, `robots.txt` among them. So Access stands in front of a Worker that only serves static files, and a crawler sees no page of it.
- A push to the deploy branch started a build. The first release was a pull request merged as a merge commit. Its build ran and deployed in about 25 seconds, and GitHub showed it as a check on that commit.

**Documentation, read on Oct 11, 2026. Not run.**

- Access can also be attached to a Worker by name. It then covers every address of that Worker: its routes, its custom domains, its address on `workers.dev` and its previews.
- A build for a branch other than the deploy branch runs only when preview builds are switched on.

## The demo's account

The demo's two nodes and its index run as separate Workers in one Cloudflare account. Each node has its own Artifacts namespace. The index was never shown reading a node in another account.

## Leftovers of the first check

The check of Oct 4 left a namespace with five repos, a Worker with its Workflow, a KV namespace and a queue. All were deleted on Oct 9, 2026. No part of Cairnfield used them.

A report to Cloudflare that a read-only repo accepts pushes was drafted and not sent.

Each run of the check of Oct 12 deleted its repos, its Worker and its Workflow at its end. The check left its namespace, empty, to be deleted in the dashboard: Wrangler 4.147 has no command that deletes a namespace. It did not look at its three event triggers, because Wrangler lists none.
