import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const examplePath = new URL("./.env.example", import.meta.url);
const envPath = new URL("./.env", import.meta.url);

if (existsSync(envPath)) {
  console.log(".env already exists; it was not changed.");
  process.exit(0);
}

copyFileSync(examplePath, envPath);
let contents = readFileSync(envPath, "utf8");
contents = contents
  .replace(/^LICENSE_SIGNING_SECRET=.*$/m, `LICENSE_SIGNING_SECRET=${randomBytes(48).toString("base64url")}`)
  .replace(/^LICENSE_DATA_SECRET=.*$/m, `LICENSE_DATA_SECRET=${randomBytes(48).toString("base64url")}`)
  .replace(/^INSTAGRAM_SESSION_ENCRYPTION_KEY=.*$/m, `INSTAGRAM_SESSION_ENCRYPTION_KEY=${randomBytes(32).toString("base64url")}`);
writeFileSync(envPath, contents, { mode: 0o600 });
chmodSync(envPath, 0o600);
console.log("Created .env with fresh local license secrets. Add Shopier and AI settings locally; do not send them in chat.");
