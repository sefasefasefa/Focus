import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const dbPath = resolve(process.env.DATA_PATH || "./data/licenses.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS shopier_orders (
    order_id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    payment_status TEXT NOT NULL,
    email_hash TEXT NOT NULL,
    paid_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    device_limit INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS license_devices (
    order_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (order_id, device_id),
    FOREIGN KEY (order_id) REFERENCES shopier_orders(order_id) ON DELETE CASCADE
  );
`);

const [command, orderId] = process.argv.slice(2);
if (command === "list") {
  const rows = db.prepare(`
    SELECT o.order_id, o.product_id, o.payment_status, o.paid_at, o.expires_at,
           o.revoked_at, o.device_limit, COUNT(d.device_id) AS device_count
    FROM shopier_orders o
    LEFT JOIN license_devices d ON d.order_id = o.order_id
    GROUP BY o.order_id
    ORDER BY o.paid_at DESC
    LIMIT 100
  `).all();
  console.table(rows.map(row => ({
    ...row,
    paid_at: new Date(Number(row.paid_at)).toISOString(),
    expires_at: row.expires_at === null ? "lifetime" : new Date(Number(row.expires_at)).toISOString(),
    revoked_at: row.revoked_at ? new Date(Number(row.revoked_at)).toISOString() : "",
    device_limit: "unlimited",
  })));
} else if (command === "revoke" && orderId) {
  const result = db.prepare(`
    UPDATE shopier_orders SET revoked_at = ? WHERE order_id = ?
  `).run(Date.now(), String(orderId));
  if (Number(result.changes) === 0) {
    console.error("No matching Shopier order found.");
    process.exitCode = 1;
  } else {
    console.log("License revoked.");
  }
} else {
  console.log("Usage: node --env-file=.env admin.mjs list");
  console.log("   or: node --env-file=.env admin.mjs revoke <order-id>");
  process.exitCode = 1;
}

db.close();
