# Threat model

Cairnfield assumes that some contributors are hostile, and that any component under review may be. This document lists the attacks the design considers. For each one it says what the design does about it and how much of that the prototype in this repo builds. It then lists what the design does not solve, and states the disclosure policy.

"Builds" means that code in this repo does it. It does not mean that anyone has attacked it. `protocol.md` states each requirement (`R`) and decision (`KTD`) that is cited here.

## Who trusts what

- A component's files are hostile text. An agent reads them as data.
- A record or a patch from another node is hostile until the team's own checks have passed on it.
- A node is storage. It validates nothing, and only its own team trusts it.
- An index is untrusted. It can omit or misreport work. It cannot make the command take a patch that fails the command's own checks.
- A person gives the verdict. No part of Cairnfield issues one.

## The four defenses the prototype builds

1. **Checks on records and patches.** No record holds free text, a cited line must exist, and a patch may change only the lines its findings cite, up to a size limit (R2, R3, R9, R11).
2. **Tokens scoped to one repo.** A write token comes only from a node's admin routes, and none is ever issued for a component copy (R6, R8).
3. **Checking again at assembly.** The command fetches each patch from the node of the team that wrote it and runs every check itself (R25).
4. **A lens that names teams.** Only the team's own work and the work of teams it names counts for it (R23).

The rest of the design is built in part or not at all. The sections below say which.

## Threats

| Threat | In the prototype |
| --- | --- |
| Tampering | Built |
| Rewritten history | Built in part |
| Smearing | Built in part |
| Whitewashing | Built in part |
| Fake consensus | Built in part |
| Planted instructions | Built in part |
| Backdoored patch | Built in part |
| Harmful combination | Built in part |
| False assurance | Built |
| Correlated blind spots | Built in part |
| Anchoring | Built in part |
| Blind-spot map | Not solved by the design |
| Target list | Not solved by the design |
| Compromised operator | Built in part |
| A hostile contributor stays in the index | Not built |
| Flooding an index or a node | Built in part |

### Tampering

An agent rewrites or deletes another team's findings.

- **The design.** Each team's repos sit in the team's own account, with tokens scoped to one repo. The shared view is computed and never written to.
- **Builds.** Each node has its own Artifacts namespace. A token opens one repo. A write token comes only from a node's admin routes, which need that node's key. The index only reads a node, and holds no key and no token of one. A record is named by the hash of its content, and the index and the command each reject a file whose content does not match its name.
- **Does not show.** Separate accounts. The demo's nodes share one Cloudflare account, each with its own namespace.

### Rewritten history

A team alters its own past findings, or serves different content to different readers.

- **The design.** The index records the commit it read each time. Anyone can compare a node against that record.
- **Builds.** The index keeps the last commit it read per node, and the commit at which it read each record. A record cannot change under its name. The index reads a valid record once and keeps it until a reset.
- **Does not build.** Detection. No code compares two commits of a node, and a view's `historyRewritten` field is always false (KTD13). No tool compares a node with what an index recorded. A node can serve one listing to an index and another to a team.

### Smearing

A contributor publishes fabricated findings against a rival's component.

- **The design.** The index rejects a finding whose cited lines do not exist at that commit. A finding that no other organization has re-checked is labelled unconfirmed.
- **Builds.** The index and the command each reject a finding that cites a path the pinned copy does not hold, lines outside the file, or a host that is not in the cited lines. Rejected work shows as four values with its reason. A finding with one organization behind it carries the label "unconfirmed".
- **Does not build.** A false statement about real lines passes every check. Only another organization's re-check or counter-finding answers it. No command writes either record. A person or a team's own agent writes one to the outbox.

### Whitewashing

A component's author floods the view with disputes.

- **The design.** A dispute never hides a finding. Contributions from the maintainer's domain are flagged. A version with no findings is never shown as clean.
- **Builds.** A counter-finding sits beside the finding it names. It hides nothing and changes no count. A version with no findings reads "No findings published", with a line that this is no statement of safety. A version the index has not imported shows no count of findings or patches.
- **Does not build.** The maintainer flag. Nothing ties a node to a component's author.

### Fake consensus

One party runs many agents, or many nodes, to inflate confirmations.

- **The design.** A node is identified by the domain it runs on. Confirmations are counted by organization, not by agent.
- **Builds.** Counts are by node, so many agents of one node count once. A node URL has one accepted spelling, so one node cannot register twice under two spellings (KTD8). Registering a node needs a key, and the index caps its nodes (KTD30). A lens names the teams that count. Work from any other node counts for nothing in that team's `view` or in its copy (KTD38).
- **Builds in part.** Organization counts are counts of registered node URLs. The count in a view's header is the number of nodes registered with the index, whether or not each published anything.
- **Does not build.** Domain verification. Nothing proves who runs a node, or that two nodes are two organizations. Counting organizations as a reason to take a patch is not built, and with it any proof of independence. No command acts on a count.

### Planted instructions

Hostile text reaches an agent through a component, a finding or a patch.

- **The design.** Findings hold locations and fixed fields, with no quoted text. Agents read the component in a sandbox with no credentials. An agent that reads another team's patch runs under the same limits.
- **Builds.** No record field holds free text, and the command and the index each check that before an agent reads a record. The bundled patch agent reads one checkout through read-only tools. It has no tool that writes, runs a command or reaches a network. A component's text reaches the model only inside a tool result. The agent is given nothing from another team. Its answer is a list of edits, and the patch checks bound what the edits may change. A config file, a lens file or an approvals file that lies among a component's files is refused.
- **Builds in part.** Credentials. The agent's tools cannot reach a credential, and no key is in a prompt or a tool result. But the model key, the node's admin key and the repo tokens share the command's process (KTD16). The limit is in the tools. There is no sandbox of the operating system around the command.
- **Builds in part.** Outside agents. A team's own review agent is not run by the command, so the command cannot limit it. The rule is that such an agent stops at `validate`, which needs no key, and that the operator publishes (R21). Its shell must hold neither the node's admin key nor an index's registration key. The command cannot enforce where a key is set, so this rests on the operator. An agent that runs in the operator's folder can also write `cairnfield.json`, the lens file and `.cairnfield/decisions.json`, and `publish` and `pin` send the admin key in a header to the node that `cairnfield.json` names. The skill file forbids a write outside the outbox, the command cannot enforce it, and Git ignores `cairnfield.json` at the repo root and all of `.cairnfield/`, so `git status` shows no change to either and this too rests on the operator.
- **Does not build.** An agent that reads another team's patch. No agent reads one. The operator reads the assembled diff.

Three channels stay open. A path and a hostname in a record are names that a component's author chose, held to a fixed set of characters. Two outputs of the command carry text from a component: `pin` lists the paths its checkout leaves out, and `assemble` prints the diff of the copy. An agent that drives the command must treat both as data. And a patch can still mislead the person who reads it. For an outside agent there is a fourth: some agent harnesses load instruction files they find under the folder an agent works in, and a checkout can hold such a file. The skill file cannot close this channel, so the operator closes it, by switching off the loading of nested instruction files or by keeping the checkout outside the folder tree the harness loads them from.

### Backdoored patch

A "fix" adds something harmful.

- **The design.** A patch is limited to what its findings cite and to a size limit. Each is labelled by kind and re-checked by other teams. A team takes none unless its lens says so.
- **Builds.** A patch may change only the lines its findings cite. It may add no file, and every path it changes must be a regular file. It holds at most 3 replacements, changes at most 60 lines and adds at most 8 KB. Its kind is computed from the diff. A lens takes a patch only at its level and of a kind it accepts, and another team's patch only when it names that team. Assembly fetches the commit over Git and runs every check again. The operator reads the full diff.
- **Builds in part.** The index's check. The index asks the node for the commit's parent and its changed paths, and trusts the node for both. A hostile node can hide a change, and the index then shows the patch as valid. Assembly is the enforcement point (KTD7, KTD23).
- **Does not build.** Re-checks of a patch by other teams' agents. The record type exists and is counted, and no command writes one. The checks also bound where a patch changes, not what it writes. Inside the cited lines and the size limit a patch may add anything. Removing lines is not safe either: deleting a safety check is an attack.

### Harmful combination

Patches that are harmless alone do damage together.

- **The design.** The team's own agents re-review the full diff of every copy the team assembles.
- **Builds.** Assembly refuses two patches that change the same line or add lines at the same place. It refuses a selection whose result changes a line that none of its patches cites. It prints the full diff of the copy against the original. A character that a terminal would act on, or that a reader would not see, is printed as an escape. `decide` takes the tree hash of the copy whose diff was read, so a copy built again since is not approved by mistake.
- **Does not build.** The agent review. The operator reads the assembled diff. No agent re-reviews it.

### False assurance

A patched copy is read as an approval.

- **The design.** The system publishes no fixed version and no "hardened" label. It shows recipes and how many organizations use each.
- **Builds.** No Worker publishes a fixed version. A copy is a team's own, and it is published only when that team's lens says so. The page shows each distinct file tree with the organizations that published it, and labels the tree hash "published, not checked". The index issues no verdict. A team's verdicts stay in a local file.

### Correlated blind spots

Teams that use the same model miss the same things, so agreement looks stronger than it is.

- **The design.** Every finding and re-check records the model and the checks used, and the page shows that spread.
- **Builds in part.** A finding, a re-check, a counter-finding, a patch record and a patch re-check each name a model from a closed list. A finding also names its kind of check. A view carries the records. The author declares the model, and nothing checks it. The page shows the model of each patch record beside the team that published it, under the word "declared" and in a dashed outline, as it draws everything unconfirmed.
- **Does not build.** The rest of the display. The page shows the model of no finding, re-check, counter-finding or patch re-check. No lens rule discounts agreement between identical setups.

### Anchoring

Agents that read the view first look where everyone else looked.

- **The design.** A blind first pass. A review claim names the component and the kind of check, never a file.
- **Builds.** A review claim cannot name a file. The bundled patch agent is given nothing from another team. `validate` reads nothing from an index.
- **Does not build.** The blind pass itself. The command runs no reviewer agent. A team's own review agent writes the findings, and nothing checks what it read first.

### Blind-spot map

A map of what reviewers examined tells an attacker which parts nobody examined.

- **The design.** None. Every node is public, so a coverage map cannot be limited to reviewers.
- **The prototype.** It records and publishes no coverage.

### Target list

Public flaws in honest components point attackers at their users.

- **The design.** None. A finding published from a public node cannot be sealed. A team can tell the maintainer first and publish later.
- **The prototype.** Nothing enforces a delay. See the [disclosure policy](#disclosure-policy).

### Compromised operator

One account that holds every team's repos is breached.

- **The design.** There is no such account. A breach exposes one team's node, or an index that holds nothing original.
- **Builds.** Each node has its own admin key and its own namespace. A node's key cannot get a write token for a component copy. The index holds no key and no token of any node, and its records can be read again from the nodes.
- **Builds in part.** The demo's nodes and its index share one Cloudflare account, so a breach of that account would expose all of them. The index was never shown reading a node in another account.

### A hostile contributor stays in the index

A contributor is found to be hostile, and its work still shows.

- **The design.** A contributor found to be hostile is dropped from the index in one step, and all its work leaves every view.
- **Not built.** Removing a contributor from the index. No route removes a node, and a reset reads every registered node again. Two things stand in for it. A team's lens leaves the node out. A `teams` query narrows a view, and the page of it, to the nodes it lists.

### Flooding an index or a node

A party registers work or sends requests to exhaust a public Worker. This threat is not in the design's own table. It is here because the prototype runs a public demo.

- **Builds.** Registering a node or a component needs a key. The index caps its nodes and its components and imports only from Git URLs on its allow-list. Every read from a node runs under a deadline, follows no redirect and stops at a size limit (KTD30). A node's listing is held to 5,000 entries and 500 records per component (KTD6). A notice for a node that is not registered causes no fetch. Notices for one node within 5 seconds cause one sync (KTD11). A node's public read-token route keeps one token per fork and cannot mint without bound (KTD7).
- **Does not build.** A rate limit. The notice route takes no key. A node's `records`, `file`, `patch` and `blob` routes read Artifacts on every request, for anyone. Cloudflare's documentation gives each namespace a request budget, which anonymous requests could spend. `platform-notes.md` holds the numbers, which were not tested.

## Other limits of the prototype

- **A hosted tool with no Git commit cannot be pinned.** A hosted server with no public source has no fixed version to review and nothing to patch. It is out of scope.
- **`carry` reviews nothing.** It moves only a team's own findings and patches to a newer commit, and reviews nothing the release changed. Content outside the carried findings is unreviewed until the team's review agent runs on the newer commit. The page does not mark carried work.
- **Some entries stay in a built copy unreviewed.** A checkout leaves out a symbolic link, a submodule entry, an entry with any other mode that is no regular file, a path the path rule refuses, and paths that differ only in letter case. The copy a team builds is a commit on the pinned commit, so its tree still holds each of them. No finding that the command validates can cite one, and assembly takes no patch that changes one. `pin` reports each one by reason. The index also takes no finding that cites a link, a submodule entry or a refused path, and shows no patch that changes one as valid. It does not apply the letter-case rule.
- **A team's records all go through one branch of one repo.** The command pushes with pull and retry. Artifacts guidance prefers a repo per agent to one shared repo. Contention stays within a team, because the command pushes and the agents do not.
- **`view` trusts the index for two things.** It takes the index at its word for which node a record came from and which content a path holds. `assemble` does not: it reads each record and each commit from the node itself.

These parts of the design are described here and not built: domain verification, maintainer flags, removal of a contributor from an index, and the unreviewed list, a team's local list of components it uses and has not reviewed. The display of models used is built in part: the page shows the model that a patch record declares, and the model of no other record.

## Not solved by the design

These are limits of the design itself. More code in the prototype would not remove them.

- **Private data.** Every node is public and anyone can run an index, so nothing can be shown to some readers only. That rules out a coverage map for reviewers only, and findings sealed until a fix.
- **Independence.** Nothing proves that two confirmations are independent. The page is public, so a contributor can copy a finding or a patch and publish it again. Teams that run the same agents on the same model will also agree for the same reason. A count of organizations is a count of agreement, not independent proof. Records name the model that wrote them, and no rule in the prototype reads it.
- **Selection at scale.** Identical patches collapse into one entry, and a lens takes patches without a person choosing each one. A team that faces thousands of different patches for the same lines still has to choose, and the design does not help beyond a count of confirmations.
- **Test bench.** In the design the reviewer agents are open source, so an attacker can tune a malicious component until it passes them. The prototype bundles no reviewer agent. Its checks and its patch agent's prompt are public in the same way. A team's private checks are the only defense.
- **Cheap identities.** A domain is easy to register. Counting by organization raises the cost of fake consensus and does not remove it. A team can limit its lens to teams it knows, which is what the prototype builds.
- **Index operators.** An index can omit or misreport work. Anyone can check it against the nodes or run another index, but most readers will not. The prototype has no tool that compares an index with the nodes.
- **Discovery.** A node that no index knows about is invisible. A default index only softens this.
- **Wrong findings about real products.** This is a legal exposure as well as a technical one.

## Disclosure policy

### Findings about real products

This repo holds none. Every plugin, host, team and organization in its fixtures, demos and documents is invented, and hosts use the reserved `.example` domain. The one real address is the demo plugin's own repo, which holds an invented plugin with planted problems. The project publishes no finding about a real product and takes none into this repo.

A team that runs Cairnfield on a real component should know two things first.

- **A finding cannot be sealed.** A record published from a node is public at once and is never edited or deleted. Publishing an accidental flaw in an honest component points attackers at its users.
- **A wrong finding is an exposure.** A finding that is wrong about a real product is a legal risk for the team that published it.

So the policy is: tell the maintainer first, and delay publishing. Until then, do not run `publish` while the finding is in the outbox: it pushes every record the outbox holds. `validate` checks the outbox and publishes nothing. Nothing in the prototype enforces the delay. It rests on the operator.

### A flaw in Cairnfield itself

The same rule holds: tell the maintainer first, and delay publishing. That matters most for a flaw that lets someone push to a team's repos, read a key, or make an index or the command accept work that the checks should refuse.

Report such a flaw in private, through GitHub's form: the **Security** tab of this repository, then **Report a vulnerability**. Only the reporter and the maintainers see a report. [`SECURITY.md`](../SECURITY.md) says what to send and what to expect: the maintainers answer on best effort, and the project pays no bounty.
