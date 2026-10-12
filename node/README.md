# Cairnfield team node

A team node is the one piece of Cairnfield a team hosts: a Cloudflare Worker that keeps the team's repos in the team's own Artifacts namespace. It serves the team's records and patch commits over HTTP, and its base URL is the team's identity. At that address it shows a page that lists the team's records.

## What you need

- Node 22.22 or later, and on the Node 23 line 23.6 or later. In a clone of the repo, `nvm use` selects it.
- A Cloudflare account on the Workers Paid plan, which Artifacts requires. Usage beyond the included amounts is billed to you.

## Deploy a node

Run these in this folder:

```sh
npm install
npx wrangler login
npm run setup
```

`npm run setup` deploys the node on `workers.dev`. It deploys twice: once to learn the node's address, and once to give the node that address. Options go after `--`:

| Option | What it sets |
| --- | --- |
| `--url <base-url>` | The node's base URL, when you know it. The script then deploys once. |
| `--domain <hostname>` | A hostname of your own for the node, in a zone of your Cloudflare account. The node's base URL is then `https://<hostname>`. Give it only from a terminal: outside one, Wrangler replaces a DNS record or another Worker's custom domain at that hostname without asking, so the script stops. |
| `--index <address>` | The index that the node tells about each push. |

The script checks each address before it deploys anything. Given both `--url` and `--domain`, it stops unless the two name the same address. It stops when Wrangler is not logged in, and it never uses a temporary Cloudflare account. Every run sets the node's address and its index address again, so give the same options each time. The node's address is the team's identity, and an index or a lens that names the old address does not know a new one.

## What the script creates

In the account that Wrangler is logged in to:

- the Worker `cairnfield-node`, with its Durable Object class `ReadTokens`
- the Artifacts namespace `cairnfield-node`
- the Workflow `cairnfield-node-on-push`
- the trigger that starts that Workflow on each push to that namespace
- the Workflow `cairnfield-node-on-fetch`
- the two triggers that start that Workflow on each fetch and each clone from that namespace
- the custom domain, when you give one

It updates each of these that is already there. With `--domain`, it switches off the node's address on `workers.dev`, because Wrangler gives a Worker with a custom domain no address there. It deletes nothing.

## Set the admin key

The `cairnfield` command manages the node with an admin key: it imports a component, creates a fork and gets repo tokens. The script never makes, reads or stores that key. You set it by hand, and the node refuses every admin call until you do.

```sh
openssl rand -hex 32
npx wrangler secret put ADMIN_KEY --env=""
```

The first line prints a new key. The second asks for it and gives it to the node. Write the key in no file. Where you run `cairnfield`, put it in the environment as `CAIRNFIELD_ADMIN_KEY`.

## The index address

A team can work alone, with no index, and a node with no index address sends no notice. To share through an index, add `--index` with the index's address: an HTTPS URL with no slash at its end. This line deploys a node on a domain of your own that tells an index:

```sh
npm run setup -- --domain node.team-a.example --index https://index.cairnfield.example
```

## Check the node

```sh
curl https://node.team-a.example/records
```

A new node answers with status 404 and `{"error":"not-found"}`, because it has no team repo yet. A node the team has published from answers with its listing. The script reads this address once after the deploy and says whether the node answered. A new address can take a few minutes to start.

The node's own address shows a page for a person:

```
https://node.team-a.example/
```

The page lists the records the team repo holds, by component, and each record links to its file on the node. On a new node it says that the team has published nothing yet. It is the team's own list: nothing on it was checked, and no index and no command reads it. The node keeps the page for 30 seconds, so a record can take that long to show.

The node counts how often each fork it holds is fetched over Git, and serves the count:

```sh
curl "https://node.team-a.example/fetches?component=<component commit>"
```

It answers `{"component":"<component commit>","fetches":3}`. A fork with no counted fetch has no count, and the node answers with status 404 and `{"error":"not-found"}`. The count is the node's own statement. It names no reader, your own command's fetches are in it, and anyone can raise it. A node with an index address sends the index a notice after each fetch it counts, as it does after a push.

Then name the node in the `cairnfield.json` of the folder you work in:

```json
{ "node": "https://node.team-a.example" }
```

## The one-click button

A one-click deploy button for the node waits on platform support. Cloudflare's documentation for the button does not list Artifacts, Workflows or event triggers among what it sets up, and nobody has tested it on a node. The setup script is the way to deploy one until a test shows that the button sets up all three. `package.json` already describes the node's three settings for the button's setup page.
