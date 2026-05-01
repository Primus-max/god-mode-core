const fs = require("node:fs");
const path = require("node:path");
const expectedPackageName = "playwright-core";
const expectedCapabilityId = "pdf-renderer";
const manifestPath = path.join(__dirname, "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.name !== expectedPackageName) {
  throw new Error(`bootstrap package mismatch for ${expectedCapabilityId}: ${manifest.name}`);
}
process.stdout.write(`${manifest.name}@${manifest.version ?? "0.0.0"}\n`);
