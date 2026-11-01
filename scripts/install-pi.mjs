// Install a standalone user extension, outside Pi's versioned runtime.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--agent-dir")) throw new Error("Usage: node scripts/install-pi.mjs [--agent-dir PATH]");
const agentDir = args.length ? path.resolve(args[1]) : path.join(os.homedir(), ".pi", "agent");
const destination = path.join(agentDir, "extensions", "mistral-request-budget");
const marker = path.join(destination, ".mistral-request-budget.json");
if (fs.existsSync(destination) && !fs.existsSync(marker)) throw new Error(`Refusing to overwrite an unrecognized extension: ${destination}`);
fs.mkdirSync(destination, { recursive: true });
for (const name of ["pi-extension.mjs", "request-budget.mjs"]) fs.copyFileSync(path.join(source, name), path.join(destination, name));
fs.writeFileSync(path.join(destination, "index.ts"), 'export { default } from "./pi-extension.mjs";\n');
fs.writeFileSync(marker, JSON.stringify({ plugin: "mistral-request-budget", source, installedAt: new Date().toISOString() }, null, 2) + "\n");
console.log(`Installed native Mistral request budget extension: ${destination}\nRun /reload in Pi, or restart Pi. Provider and credential settings were not changed.`);
