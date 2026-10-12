# Security policy

Cairnfield is a prototype. This file says how to report a flaw in it, and what to expect when you do.

## Report a flaw in Cairnfield

Report it in private, through GitHub's form:

https://github.com/peoplerenaissance/cairnfield/security/advisories/new

The same form is under the **Security** tab of this repository, at **Report a vulnerability**. Only you and the maintainers see the report.

Do not open a public issue or a pull request for a flaw, and do not publish it until a fix is out.

The reports that matter most are of a flaw that lets someone:

- push to a team's repos,
- read a key,
- or make an index or the command accept work that the checks should refuse.

Say in the report:

- which part it is in: the protocol library, the team node, the index, the command or the skill file,
- the commit you looked at,
- the steps that show it, and what you expected in their place.

[`reference/threat-model.md`](reference/threat-model.md) says what the prototype defends against and what it leaves open. A risk it already lists as open is known. A report of one is still welcome when it shows something the document does not say.

## What to expect

- **Best effort.** The maintainers read each report and answer when they can. There is no promised response time.
- **No bounty.** The project pays for no report.
- **Fixes land on `main`.** No older version of the code gets a fix.
- **Credit.** A report that leads to a fix is credited in the advisory, unless you ask not to be named.

## What is not a flaw

- **The demo plugin's problems.** `fellbeck-sync` is an invented plugin, and its problems are planted, a hidden instruction among them. The same holds for the components under `fixtures/injection/`.
- **What the demo's nodes and index show.** They hold the demo's findings and patches about that invented plugin.

## Findings about real products

This repository takes none. Do not report a problem in someone else's product here. Tell that product's maintainer first, and delay publishing. The [disclosure policy](reference/threat-model.md#disclosure-policy) says why: a published record is public at once and is never edited or deleted.
