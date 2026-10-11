// The command a team deploys its node with (R30). `npm run setup` runs this file, once
// `node-version.cjs` has seen that this Node can run it. `setup-node.ts` says what the
// script does and which options it takes.
//
// No test imports this file, because it runs the script on this machine's Wrangler.

import { processIo, setupNode } from "./setup-node.ts";

process.exitCode = await setupNode(processIo(), process.argv.slice(2));
