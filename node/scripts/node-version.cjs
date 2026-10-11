// `npm run setup` runs this before the setup script. The script needs Node 22.22, and an
// older Node stops on a `.ts` file with an error that names no version. So does Node 23
// before 23.6, the first of that line to run TypeScript as it is. So this file is
// plain JavaScript in the oldest form, which every Node runs, and it says what is needed.

var parts = process.versions.node.split(".");
var major = Number(parts[0]);
var minor = Number(parts[1]);
var needs = major === 23 ? "23.6" : "22.22";
if (major < 22 || (major === 22 && minor < 22) || (major === 23 && minor < 6)) {
  console.error("The setup script needs Node " + needs + " or later. This is Node " + process.versions.node + ".");
  console.error("With nvm, run `nvm install 22` and `nvm use 22`, then run the setup again.");
  process.exit(1);
}
