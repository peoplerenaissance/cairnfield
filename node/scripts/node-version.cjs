// `npm run setup` runs this before the setup script. The script needs Node 22.22, and an
// older Node stops on a `.ts` file with an error that names no version. So this file is
// plain JavaScript in the oldest form, which every Node runs, and it says what is needed.

var parts = process.versions.node.split(".");
var major = Number(parts[0]);
var minor = Number(parts[1]);
if (major < 22 || (major === 22 && minor < 22)) {
  console.error("The setup script needs Node 22.22 or later. This is Node " + process.versions.node + ".");
  console.error("With nvm, run `nvm install 22` and `nvm use 22`, then run the setup again.");
  process.exit(1);
}
