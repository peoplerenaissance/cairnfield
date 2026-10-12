# Roadmap

The prototype is a slice of a larger design. This document says what the slice leaves out, in three lists: parts of the design that are described and not built, further work past the design, and two ideas that Cloudflare's own deploy path would open. The README's "Roadmap" section names each item in one line. `threat-model.md` lists the parts of the threat model that are not built, and the limits of the design itself.

## Parts of the design that are not built

- **One command that runs a whole review.** It would first check whether confirmed findings already rule the component out for the team's lens. Then it would publish claims, run three reviewer agents that read nothing from other teams, validate and publish. The prototype bundles no reviewer agent.
- **Reconciling.** The command would write re-checks and counter-findings on other teams' findings, once the index has read the team's own push. Today a person or a team's own agent writes those records to the outbox.
- **A scale run.** A simulator would register a few hundred nodes with one index. The page would show the count of organizations, label them as simulated and show the index lag. The page would also say when the index has not read every registered node yet. Today a version whose nodes are not read yet says "No findings published", as a version with no findings does.
- **A node in a second Cloudflare account.** The demo's nodes and its index share one account. The index was never shown reading a node in another one.
- **Cited lines on the page.** A person would see the lines a finding cites, read from the index's own copy (R31 in `reference/protocol.md`).
- **A row per host on the page.** The view already carries one row for each host that a finding names, and the page does not show them (R33).
- **An API catalog on the index.** The library generates a description of the index routes and the record schemas. The index does not serve them yet (R34). It also serves no lookup by Git URL and no short form of the view that holds only criteria and hosts (R13).
- **Merged patches.** A patch record can list the patches it merges. No command writes such a record, and no code reads the list.
- **A fuller lens.** It would state the criterion each kind of use requires, the destinations the team approves and the confirmations it requires. At level 3 it would take a patch that enough organizations stand behind (R41).
- **An agent's review of the assembled diff.** A team's own agent would read the full diff of a copy before a recipe is published. Today the operator reads it, and no agent does.
- **A suggested verdict.** The command would work one out from the lens, the view and the copy, and offer it to the operator. Today a person gives the verdict and the command computes none.

## Further work

- **Carrying other teams' work forward, and showing carried work.** The index would show carried work for a newer commit with a label. A carried confirmation is weaker than a fresh one, because other files changed, so a lens would have to opt in to count it.
- **An install gate.** It would apply a recipe on top of an installed copy, compare the tree hash with the approved one, and fail closed when a patch no longer carries. `verify` is the first step.
- **Pinning what runs.** A package tarball or a hosted server's tool manifest would be pinned by its content hash. That brings in tools with no Git commit, and closes the gap between the source a team reviewed and the package it installed.
- **An egress allow list.** The command would write one from the confirmed destination findings of a version and the team's lens. A team that takes no patch would then have something to enforce.
- **Confirmation by re-running.** A finding would carry a check that fails before a patch and passes after, run in a sandbox on push. Confirmation would then not rest on a count of organizations.
- **Signed requests from nodes to an index.** HTTP message signatures would give a node an identity that an index can verify, and would replace the registration key.
- **An index that reads patch commits over Git.** That would remove its trust in the node for a commit's parent and changed paths.
- **A read-only MCP server on the index.**
- **A `since` cursor and a push feed on the view.**
- **Alerts and diff review of new versions.**
- **A private findings log.** A team would keep free-form findings, evidence and mitigations in a local file beside the decisions file. It would never be placed in the outbox or given to an agent.
- **An unclassified pointer.** A record would say that a team has a concern at some lines that the closed lists cannot express. It would carry only a hash of the private note, so no text crosses.
- **A check that a blind pass was really blind.**
- **A local mode with no node.** Records and patch commits would live in a local repo until the team publishes. A team could then start before it has a Workers Paid account.

Two more are under "Ideas that are not built".

## Ideas that are not built

Cloudflare can deploy a Worker from an Artifacts repository through Workers Builds. A push to `main` builds and deploys the Worker. With previews switched on, a push to another branch makes a Worker Preview. Two uses fit Cairnfield, and neither is in the prototype.

- **A node that deploys from its own namespace.** The node's source would live in an Artifacts repo beside the team's records. Updating a node would be a `git push`, with no account on another Git host, and a branch would give a staging node as a Preview. As of October 8, 2026, Cloudflare's guide describes connecting the repo only in the dashboard, so the setup script could not do it.
- **A running Preview of a patched component.** When a component is itself a Worker, as some MCP servers are, each patch branch could get its own Preview, and the copy a team approves would be the copy it deploys. This runs code that is still under review inside the team's account, so it needs its own safeguards first.

We would not deploy from the records repo. A push there would become a deploy, and a token that can write records could then change a Worker.
