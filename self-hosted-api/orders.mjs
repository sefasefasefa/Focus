const DAY_MS = 86_400_000;

// Synchronous transaction: duplicate delivery must never extend a license twice.
export function recordPaidOrder(db, { orderId, productId, emailHash, paidAt, days, deviceLimit, now = Date.now() }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const duplicate = db.prepare(`
      SELECT order_id FROM shopier_orders WHERE order_id = ?
      UNION ALL SELECT order_id FROM shopier_renewals WHERE order_id = ?
    `).get(orderId, orderId);
    if (duplicate) {
      db.exec("COMMIT");
      return { duplicate: true };
    }
    const previous = db.prepare(`
      SELECT order_id, expires_at FROM shopier_orders
      WHERE email_hash = ? AND product_id = ? AND revoked_at IS NULL AND payment_status = 'paid'
      ORDER BY paid_at DESC LIMIT 1
    `).get(emailHash, productId);
    if (previous) {
      const expiresAt = previous.expires_at === null || days === 0
        ? null
        : Math.max(now, Number(previous.expires_at)) + days * DAY_MS;
      db.prepare("UPDATE shopier_orders SET expires_at = ? WHERE order_id = ?")
        .run(expiresAt, previous.order_id);
      db.prepare(`
        INSERT INTO shopier_renewals (order_id, license_order_id, paid_at) VALUES (?, ?, ?)
      `).run(orderId, previous.order_id, paidAt);
      db.exec("COMMIT");
      return { renewed: true };
    }
    db.prepare(`
      INSERT INTO shopier_orders
        (order_id, product_id, payment_status, email_hash, paid_at, expires_at, revoked_at, device_limit)
      VALUES (?, ?, 'paid', ?, ?, ?, NULL, ?)
    `).run(orderId, productId, emailHash, paidAt, days === 0 ? null : Math.max(now, paidAt) + days * DAY_MS, deviceLimit);
    db.exec("COMMIT");
    return { renewed: false };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
