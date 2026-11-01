import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function log(message) {
  const file = path.join(os.homedir(), ".zcode", "mistral-proxy", "proxy.log");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.renameSync(file, file + ".1");
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}
