// Exercise the actual npm archive without relying on the source checkout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "inherit", shell: process.platform === "win32" && command.endsWith(".cmd"), ...options });
try {
  const result = JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", temporary], { encoding: "utf8", shell: process.platform === "win32" }))[0];
  const files = result.files.map(file => file.path);
  for (const file of files) {
    if (/(^|\/)(node_modules|\.git|evidence)(\/|$)/.test(file) || /(^|\/)\.env($|\.(?!example$))/.test(file) || /\.(log|tgz)$/.test(file)) throw new Error(`Unexpected package file: ${file}`);
  }
  run("tar", ["-xzf", path.join(temporary, result.filename), "-C", temporary]);
  run(npm, ["test"], { cwd: path.join(temporary, "package") });
  console.log(`Package verified: ${result.filename}; ${files.length} files`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
