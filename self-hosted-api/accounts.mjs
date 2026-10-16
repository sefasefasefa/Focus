import { createHmac, randomBytes, randomInt, scryptSync } from "node:crypto";
import nodemailer from "nodemailer";

const ACCOUNT_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const PURCHASE_CODE_TTL_MS = 10 * 60 * 1000;
const PURCHASE_CODE_RESEND_WAIT_MS = 60 * 1000;
const PURCHASE_CODE_MAX_ATTEMPTS = 5;
const FREE_TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAC_ADDRESS_PATTERN = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;

export function createAccountHandlers({
  db,
  plans,
  trialDeviceLimit = 2,
  tokenTtlMs,
  refreshTtlMs,
  writeJson,
  readJson,
  isRateLimited,
  requireConfiguredLicenseSecrets,
  emailDigest,
  hmacHex,
  secureTextEqual,
  makeAccessToken,
  getBearerToken,
}) {
  function validEmail(email) {
    return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email);
  }

  function validPassword(password) {
    return typeof password === "string" && password.length >= 8 && password.length <= 256;
  }

  function validDeviceId(deviceId) {
    return /^rdn1_[a-f0-9]{64}$/.test(deviceId);
  }

  function parseMacAddresses(value) {
    if (!Array.isArray(value) || value.length > 64) return null;
    const addresses = value.map(address =>
      typeof address === "string" ? address.trim().toLowerCase() : "",
    );
    if (addresses.some(address => {
      if (!MAC_ADDRESS_PATTERN.test(address)) return true;
      if (address === "00:00:00:00:00:00") return true;
      const firstOctet = Number.parseInt(address.slice(0, 2), 16);
      return (firstOctet & 0x03) !== 0;
    })) return null;
    return [...new Set(addresses)].sort();
  }

  function hashMacAddresses(addresses) {
    return addresses.map(address =>
      hmacHex(process.env.LICENSE_DATA_SECRET, `license-mac-history-v1:${address}`),
    ).sort();
  }

  function passwordDigest(password, salt) {
    return scryptSync(password, salt, 64).toString("base64url");
  }

  function findActiveOrder(emailHash) {
    return db.prepare(`
      SELECT order_id, product_id, payment_status, email_hash, expires_at, revoked_at, device_limit
      FROM shopier_orders
      WHERE email_hash = ? AND payment_status IN ('paid', 'trial') AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY CASE WHEN payment_status = 'paid' THEN 0 ELSE 1 END, paid_at DESC LIMIT 1
    `).get(emailHash, Date.now());
  }

  function findActivePaidOrder(emailHash, now = Date.now()) {
    return db.prepare(`
      SELECT order_id FROM shopier_orders
      WHERE email_hash = ? AND payment_status = 'paid' AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY paid_at DESC LIMIT 1
    `).get(emailHash, now);
  }

  function hasLicensedDevice(deviceId, macHashes = []) {
    if (db.prepare(
      "SELECT 1 FROM license_device_history WHERE device_id = ?",
    ).get(deviceId)) return true;
    return macHashes.some(macHash => Boolean(db.prepare(
      "SELECT 1 FROM license_mac_history WHERE mac_hash = ?",
    ).get(macHash)));
  }

  function rememberLicensedDevice(deviceId, macHashes = [], firstSeenAt = Date.now()) {
    db.prepare(`
      INSERT OR IGNORE INTO license_device_history (device_id, first_seen_at)
      VALUES (?, ?)
    `).run(deviceId, firstSeenAt);
    const rememberMac = db.prepare(`
      INSERT OR IGNORE INTO license_mac_history (mac_hash, first_seen_at)
      VALUES (?, ?)
    `);
    for (const macHash of macHashes) rememberMac.run(macHash, firstSeenAt);
  }

  function blockedTrialDeviceResponse(response) {
    return writeJson(response, 409, {
      ok: false,
      error: "Bu cihazda daha önce lisans kullanılmış. Yeni ücretsiz deneme açılamaz; mevcut hesabınla giriş yap veya aylık satın al.",
    });
  }

  function smtpSettings() {
    if (
      !process.env.SMTP_HOST ||
      !process.env.SMTP_USER ||
      !process.env.SMTP_PASS ||
      !process.env.SMTP_FROM ||
      !Number.isInteger(Number(process.env.SMTP_PORT)) ||
      Number(process.env.SMTP_PORT) < 1 ||
      Number(process.env.SMTP_PORT) > 65535
    ) {
      throw Object.assign(new Error("E-posta gönderimi için SMTP sunucu ayarları eksik."), { status: 503 });
    }
    return {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    };
  }

  async function sendPurchaseVerificationCode(email, code, purpose) {
    const isRegistration = purpose === "registration";
    const transporter = nodemailer.createTransport(smtpSettings());
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: isRegistration ? "RODON ücretsiz hesap doğrulama kodu" : "RODON lisans doğrulama kodu",
      text: isRegistration
        ? `RODON ücretsiz hesabını doğrulama kodun: ${code}\n\nHesabın oluşturulunca 7 günlük ücretsiz denemen başlar. Kod 10 dakika içinde geçersiz olur. Bu isteği sen yapmadıysan bu e-postayı yok say.`
        : `RODON lisansını etkinleştirme kodun: ${code}\n\nKod 10 dakika içinde geçersiz olur. Bu isteği sen yapmadıysan bu e-postayı yok say.`,
      html: isRegistration
        ? `<p>RODON ücretsiz hesabını doğrulama kodun:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>Hesabın oluşturulunca 7 günlük ücretsiz denemen başlar. Kod 10 dakika içinde geçersiz olur. Bu isteği sen yapmadıysan bu e-postayı yok say.</p>`
        : `<p>RODON lisansını etkinleştirme kodun:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>Kod 10 dakika içinde geçersiz olur. Bu isteği sen yapmadıysan bu e-postayı yok say.</p>`,
    });
  }

  function codeDigest(emailHash, purpose, code) {
    return hmacHex(process.env.LICENSE_DATA_SECRET, `purchase-email:${purpose}:${emailHash}:${code}`);
  }

  function genericVerificationResponse(response, purpose) {
    return writeJson(response, 200, {
      ok: true,
      verificationRequired: true,
      message: purpose === "registration"
        ? "Hesap doğrulama isteği alındı. E-posta adresini ve spam klasörünü kontrol et."
        : "Bu e-posta için etkin bir lisans varsa doğrulama kodu gönderildi.",
    });
  }

  async function requestPurchaseVerification(request, response, purpose) {
    const bucket = purpose === "registration" ? "account-register" : "license-activate";
    if (isRateLimited(request, bucket)) {
      return writeJson(response, 429, { ok: false, error: "Çok fazla istek; daha sonra tekrar deneyin." });
    }
    requireConfiguredLicenseSecrets();
    smtpSettings();

    const input = await readJson(request, 16 * 1024);
    const email = String(input?.email || "").trim().toLowerCase().slice(0, 320);
    const password = typeof input?.password === "string" ? input.password : "";
    const deviceId = String(input?.deviceId || "").trim();
    const macAddresses = parseMacAddresses(input?.macAddresses);
    if (!validEmail(email)) {
      return writeJson(response, 400, { ok: false, error: "Geçerli bir e-posta adresi girin." });
    }
    if (purpose === "registration" && !validPassword(password)) {
      return writeJson(response, 400, { ok: false, error: "Parola en az 8 karakter olmalı." });
    }
    if (
      (purpose === "registration" || purpose === "license-activation") &&
      (!validDeviceId(deviceId) || macAddresses === null)
    ) {
      return writeJson(response, 400, { ok: false, error: "Cihaz bilgisi geçersiz." });
    }

    const macHashes = hashMacAddresses(macAddresses || []);
    const emailHash = emailDigest(email);
    const existingAccount = purpose === "registration"
      ? db.prepare("SELECT 1 FROM account_users WHERE email_hash = ?").get(emailHash)
      : null;
    const activePaidOrder = purpose === "registration" ? findActivePaidOrder(emailHash) : null;
    if (
      purpose === "registration" &&
      !existingAccount &&
      !activePaidOrder &&
      hasLicensedDevice(deviceId, macHashes)
    ) {
      return blockedTrialDeviceResponse(response);
    }
    const hasActivationLicense = purpose !== "license-activation" || Boolean(findActiveOrder(emailHash));
    if (existingAccount || !hasActivationLicense) return genericVerificationResponse(response, purpose);

    const now = Date.now();
    const existingCode = db.prepare(`
      SELECT created_at FROM purchase_email_verifications
      WHERE email_hash = ? AND purpose = ?
    `).get(emailHash, purpose);
    if (existingCode && now - Number(existingCode.created_at) < PURCHASE_CODE_RESEND_WAIT_MS) {
      return genericVerificationResponse(response, purpose);
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const salt = purpose === "registration" ? randomBytes(16).toString("base64url") : null;
    const passwordHash = purpose === "registration" ? passwordDigest(password, salt) : null;
    const codeHash = codeDigest(emailHash, purpose, code);
    db.prepare(`
      INSERT INTO purchase_email_verifications
        (email_hash, purpose, code_hash, device_id, mac_hashes, password_salt, password_hash, expires_at, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(email_hash, purpose) DO UPDATE SET
        code_hash = excluded.code_hash,
        device_id = excluded.device_id,
        mac_hashes = excluded.mac_hashes,
        password_salt = excluded.password_salt,
        password_hash = excluded.password_hash,
        expires_at = excluded.expires_at,
        attempts = 0,
        created_at = excluded.created_at
    `).run(
      emailHash,
      purpose,
      codeHash,
      purpose === "registration" || purpose === "license-activation" ? deviceId : null,
      purpose === "registration" || purpose === "license-activation" ? JSON.stringify(macHashes) : null,
      salt,
      passwordHash,
      now + PURCHASE_CODE_TTL_MS,
      now,
    );

    try {
      await sendPurchaseVerificationCode(email, code, purpose);
    } catch {
      db.prepare(`
        DELETE FROM purchase_email_verifications
        WHERE email_hash = ? AND purpose = ? AND code_hash = ?
      `).run(emailHash, purpose, codeHash);
      console.warn("[license-api] Purchase verification email could not be sent.");
      return writeJson(response, 503, { ok: false, error: "Doğrulama e-postası gönderilemedi. Sunucunun posta ayarlarını kontrol edin." });
    }
    return genericVerificationResponse(response, purpose);
  }

  function checkedPurchaseVerification(emailHash, purpose, code) {
    const pending = db.prepare(`
      SELECT code_hash, device_id, mac_hashes, password_salt, password_hash, expires_at, attempts
      FROM purchase_email_verifications WHERE email_hash = ? AND purpose = ?
    `).get(emailHash, purpose);
    if (!pending) return null;
    if (Number(pending.expires_at) <= Date.now() || Number(pending.attempts) >= PURCHASE_CODE_MAX_ATTEMPTS) {
      db.prepare("DELETE FROM purchase_email_verifications WHERE email_hash = ? AND purpose = ?")
        .run(emailHash, purpose);
      return null;
    }
    if (!secureTextEqual(pending.code_hash, codeDigest(emailHash, purpose, code))) {
      const attempts = Number(pending.attempts) + 1;
      if (attempts >= PURCHASE_CODE_MAX_ATTEMPTS) {
        db.prepare("DELETE FROM purchase_email_verifications WHERE email_hash = ? AND purpose = ?")
          .run(emailHash, purpose);
      } else {
        db.prepare(`
          UPDATE purchase_email_verifications SET attempts = ?
          WHERE email_hash = ? AND purpose = ?
        `).run(attempts, emailHash, purpose);
      }
      return null;
    }
    return pending;
  }

  function listSubscriptions(emailHash) {
    return db.prepare(`
      SELECT product_id, payment_status, paid_at, expires_at, revoked_at
      FROM shopier_orders
      WHERE email_hash = ? AND payment_status IN ('paid', 'trial')
      ORDER BY paid_at DESC
    `).all(emailHash).map(order => {
      const isTrial = order.payment_status === "trial";
      const plan = plans.find(item => item.productId === order.product_id);
      const expired = order.expires_at !== null && Number(order.expires_at) <= Date.now();
      return {
        planName: isTrial ? `${FREE_TRIAL_DAYS} günlük ücretsiz deneme` : plan?.name || "Lisans paketi",
        status: order.revoked_at ? "revoked" : expired ? "expired" : isTrial ? "trial" : "active",
        isTrial,
        purchasedAt: Number(order.paid_at),
        expiresAt: order.expires_at === null ? null : Number(order.expires_at),
      };
    });
  }

  function issueLicense(order, deviceId, macHashes = []) {
    const existing = db.prepare(`
      SELECT device_id FROM license_devices WHERE order_id = ? AND device_id = ?
    `).get(order.order_id, deviceId);
    if (!existing) {
      const count = db.prepare(`
        SELECT COUNT(*) AS total FROM license_devices WHERE order_id = ?
      `).get(order.order_id);
      if (
        order.payment_status !== "paid" &&
        Number(count.total) >= Number(order.device_limit)
      ) {
        throw Object.assign(new Error("Bu lisans için cihaz sınırına ulaşıldı."), { status: 409 });
      }
      db.prepare(`
        INSERT INTO license_devices (order_id, device_id, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?)
      `).run(order.order_id, deviceId, Date.now(), Date.now());
    } else {
      db.prepare(`
        UPDATE license_devices SET last_seen_at = ? WHERE order_id = ? AND device_id = ?
      `).run(Date.now(), order.order_id, deviceId);
    }
    rememberLicensedDevice(deviceId, macHashes);

    const refreshToken = randomBytes(48).toString("base64url");
    db.prepare(`
      UPDATE license_devices SET refresh_hash = ?, refresh_until = ?
      WHERE order_id = ? AND device_id = ?
    `).run(
      hmacHex(process.env.LICENSE_SIGNING_SECRET, refreshToken),
      Date.now() + refreshTtlMs,
      order.order_id,
      deviceId,
    );
    return {
      deviceId,
      accessToken: makeAccessToken(order.order_id, deviceId),
      refreshToken,
      tokenExpiresAt: Date.now() + tokenTtlMs,
      expiresAt: order.expires_at === null ? null : Number(order.expires_at),
      licenseType: order.payment_status,
    };
  }

  function authenticateAccount(request) {
    const token = getBearerToken(request);
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
      throw Object.assign(new Error("Hesap oturumu geçersiz; tekrar giriş yapın."), { status: 401 });
    }
    const tokenHash = hmacHex(process.env.LICENSE_DATA_SECRET, token);
    const session = db.prepare(`
      SELECT token_hash, email_hash, device_id, expires_at
      FROM account_sessions WHERE token_hash = ?
    `).get(tokenHash);
    if (!session || Number(session.expires_at) <= Date.now()) {
      if (session) db.prepare("DELETE FROM account_sessions WHERE token_hash = ?").run(tokenHash);
      throw Object.assign(new Error("Hesap oturumunun süresi dolmuş; tekrar giriş yapın."), { status: 401 });
    }
    if (!validDeviceId(session.device_id)) {
      db.prepare("DELETE FROM account_sessions WHERE token_hash = ?").run(tokenHash);
      throw Object.assign(
        new Error("Cihaz koruması güncellendi. Yardımcı uygulamayı kurup e-posta ve parolanla yeniden giriş yap."),
        { status: 401 },
      );
    }
    return { ...session, tokenHash };
  }

  async function register(request, response) {
    return requestPurchaseVerification(request, response, "registration");
  }

  async function verifyRegistration(request, response) {
    if (isRateLimited(request, "account-register-verify")) {
      return writeJson(response, 429, { ok: false, error: "Çok fazla deneme; daha sonra tekrar deneyin." });
    }
    requireConfiguredLicenseSecrets();
    const input = await readJson(request, 16 * 1024);
    const email = String(input?.email || "").trim().toLowerCase().slice(0, 320);
    const code = String(input?.code || "").trim();
    const deviceId = String(input?.deviceId || "").trim();
    const macAddresses = parseMacAddresses(input?.macAddresses);
    if (
      !validEmail(email) ||
      !/^\d{6}$/.test(code) ||
      !validDeviceId(deviceId) ||
      macAddresses === null
    ) {
      return writeJson(response, 400, { ok: false, error: "E-posta, doğrulama kodu veya cihaz bilgisi geçersiz." });
    }
    const macHashes = hashMacAddresses(macAddresses);

    db.exec("BEGIN IMMEDIATE");
    try {
      const emailHash = emailDigest(email);
      const pending = checkedPurchaseVerification(emailHash, "registration", code);
      if (!pending || !validDeviceId(pending.device_id)) {
        db.exec("COMMIT");
        return writeJson(response, 401, { ok: false, error: "Kod yanlış, süresi dolmuş veya kullanılmış. Yeni kod isteyip tekrar deneyin." });
      }
      if (pending.device_id !== deviceId || pending.mac_hashes !== JSON.stringify(macHashes)) {
        db.exec("COMMIT");
        return writeJson(response, 409, { ok: false, error: "Doğrulamayı hesabı açma isteğini başlattığın aynı tarayıcı profiliyle tamamla." });
      }
      if (db.prepare("SELECT 1 FROM account_users WHERE email_hash = ?").get(emailHash)) {
        db.prepare("DELETE FROM purchase_email_verifications WHERE email_hash = ? AND purpose = 'registration'")
          .run(emailHash);
        db.exec("COMMIT");
        return writeJson(response, 409, { ok: false, error: "Bu e-posta için hesap zaten var. Giriş yapın veya parolanızı sıfırlayın." });
      }

      const now = Date.now();
      const activePaidOrder = findActivePaidOrder(emailHash, now);
      if (!activePaidOrder && hasLicensedDevice(deviceId, macHashes)) {
        db.prepare("DELETE FROM purchase_email_verifications WHERE email_hash = ? AND purpose = 'registration'")
          .run(emailHash);
        db.exec("COMMIT");
        return blockedTrialDeviceResponse(response);
      }
      if (!activePaidOrder) {
        db.prepare(`
          INSERT OR IGNORE INTO shopier_orders
            (order_id, product_id, payment_status, email_hash, paid_at, expires_at, revoked_at, device_limit)
          VALUES (?, 'free-trial', 'trial', ?, ?, ?, NULL, ?)
        `).run(
          `trial:${emailHash}`,
          emailHash,
          now,
          now + FREE_TRIAL_DAYS * DAY_MS,
          trialDeviceLimit,
        );
      }
      db.prepare(`
        INSERT INTO account_users (email_hash, password_salt, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(emailHash, pending.password_salt, pending.password_hash, now, now);
      rememberLicensedDevice(deviceId, macHashes, now);
      db.prepare("DELETE FROM purchase_email_verifications WHERE email_hash = ? AND purpose = 'registration'")
        .run(emailHash);
      db.exec("COMMIT");
      return writeJson(response, 201, { ok: true });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async function requestLicenseActivation(request, response) {
    return requestPurchaseVerification(request, response, "license-activation");
  }

  async function verifyLicenseActivation(request, response) {
    if (isRateLimited(request, "license-activate-verify")) {
      return writeJson(response, 429, { ok: false, error: "Çok fazla deneme; daha sonra tekrar deneyin." });
    }
    requireConfiguredLicenseSecrets();
    const input = await readJson(request, 16 * 1024);
    const email = String(input?.email || "").trim().toLowerCase().slice(0, 320);
    const code = String(input?.code || "").trim();
    const deviceId = String(input?.deviceId || "").trim();
    const macAddresses = parseMacAddresses(input?.macAddresses);
    if (
      !validEmail(email) ||
      !/^\d{6}$/.test(code) ||
      !validDeviceId(deviceId) ||
      macAddresses === null
    ) {
      return writeJson(response, 400, { ok: false, error: "E-posta, doğrulama kodu veya cihaz bilgisi geçersiz." });
    }
    const macHashes = hashMacAddresses(macAddresses);

    db.exec("BEGIN IMMEDIATE");
    try {
      const emailHash = emailDigest(email);
      const pending = checkedPurchaseVerification(emailHash, "license-activation", code);
      if (
        !pending ||
        pending.device_id !== deviceId ||
        pending.mac_hashes !== JSON.stringify(macHashes)
      ) {
        db.exec("COMMIT");
        return writeJson(response, 401, { ok: false, error: "Kod yanlış, süresi dolmuş veya bu cihaz için istenmemiş." });
      }
      const order = findActiveOrder(emailHash);
      if (!order) {
        db.prepare("DELETE FROM purchase_email_verifications WHERE email_hash = ? AND purpose = 'license-activation'")
          .run(emailHash);
        db.exec("COMMIT");
        return writeJson(response, 401, { ok: false, error: "Bu e-posta için etkin bir satın alma bulunamadı." });
      }

      const license = issueLicense(order, deviceId, macHashes);
      db.prepare("DELETE FROM purchase_email_verifications WHERE email_hash = ? AND purpose = 'license-activation'")
        .run(emailHash);
      db.exec("COMMIT");
      return writeJson(response, 200, { ok: true, ...license });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async function login(request, response) {
    if (isRateLimited(request, "account-login")) {
      return writeJson(response, 429, { ok: false, error: "Çok fazla giriş denemesi; daha sonra tekrar deneyin." });
    }
    requireConfiguredLicenseSecrets();
    const input = await readJson(request, 16 * 1024);
    const email = String(input?.email || "").trim().toLowerCase().slice(0, 320);
    const password = typeof input?.password === "string" ? input.password : "";
    const deviceId = String(input?.deviceId || "").trim();
    const macAddresses = parseMacAddresses(input?.macAddresses);
    if (
      !validEmail(email) ||
      password.length > 256 ||
      !validDeviceId(deviceId) ||
      macAddresses === null
    ) {
      return writeJson(response, 400, { ok: false, error: "E-posta, parola veya cihaz bilgisi geçersiz." });
    }
    const macHashes = hashMacAddresses(macAddresses);

    const emailHash = emailDigest(email);
    const account = db.prepare(`
      SELECT password_salt, password_hash FROM account_users WHERE email_hash = ?
    `).get(emailHash);
    const salt = account?.password_salt || "invalid-account-password-salt";
    const suppliedHash = passwordDigest(password, salt);
    if (!account || !secureTextEqual(account.password_hash, suppliedHash)) {
      return writeJson(response, 401, { ok: false, error: "E-posta veya parola hatalı." });
    }

    const activeOrder = findActiveOrder(emailHash);
    const license = activeOrder ? issueLicense(activeOrder, deviceId, macHashes) : null;
    if (!activeOrder && db.prepare(`
      SELECT 1 FROM shopier_orders
      WHERE email_hash = ? AND payment_status IN ('paid', 'trial')
      LIMIT 1
    `).get(emailHash)) {
      rememberLicensedDevice(deviceId, macHashes);
    }

    const sessionToken = randomBytes(48).toString("base64url");
    const sessionExpiresAt = Date.now() + ACCOUNT_SESSION_TTL_MS;
    db.prepare(`
      INSERT INTO account_sessions (token_hash, email_hash, device_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      hmacHex(process.env.LICENSE_DATA_SECRET, sessionToken),
      emailHash,
      deviceId,
      sessionExpiresAt,
      Date.now(),
    );
    return writeJson(response, 200, {
      ok: true,
      account: { email },
      sessionToken,
      sessionExpiresAt,
      license,
      subscriptions: listSubscriptions(emailHash),
      monthlyPlans: plans.filter(plan => Number(plan.days) === 30),
      trialDays: FREE_TRIAL_DAYS,
      monthlyPlanRequired: true,
    });
  }

  async function subscriptions(request, response) {
    requireConfiguredLicenseSecrets();
    const session = authenticateAccount(request);
    return writeJson(response, 200, {
      ok: true,
      subscriptions: listSubscriptions(session.email_hash),
    });
  }

  async function refreshAccountLicense(request, response) {
    requireConfiguredLicenseSecrets();
    const session = authenticateAccount(request);
    const input = await readJson(request, 16 * 1024);
    const macAddresses = parseMacAddresses(input?.macAddresses);
    if (macAddresses === null) {
      return writeJson(response, 400, { ok: false, error: "Cihaz bilgisi geçersiz." });
    }
    const macHashes = hashMacAddresses(macAddresses);
    const order = findActiveOrder(session.email_hash);
    const license = order ? issueLicense(order, session.device_id, macHashes) : null;
    if (!order && db.prepare(`
      SELECT 1 FROM shopier_orders
      WHERE email_hash = ? AND payment_status IN ('paid', 'trial')
      LIMIT 1
    `).get(session.email_hash)) {
      rememberLicensedDevice(session.device_id, macHashes);
    }
    return writeJson(response, 200, {
      ok: true,
      license,
      subscriptions: listSubscriptions(session.email_hash),
    });
  }

  async function logout(request, response) {
    requireConfiguredLicenseSecrets();
    const session = authenticateAccount(request);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM account_sessions WHERE token_hash = ?").run(session.tokenHash);
      db.prepare(`
        DELETE FROM license_devices
        WHERE device_id = ?
          AND order_id IN (SELECT order_id FROM shopier_orders WHERE email_hash = ?)
      `).run(session.device_id, session.email_hash);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return writeJson(response, 200, { ok: true });
  }

  function resetMailSettings() {
    let publicBaseUrl;
    try {
      publicBaseUrl = new URL(String(process.env.PUBLIC_API_BASE_URL || "").trim());
    } catch {
      throw Object.assign(new Error("Parola sıfırlama sunucu ayarları eksik."), { status: 503 });
    }
    if (
      publicBaseUrl.protocol !== "https:" ||
      publicBaseUrl.username ||
      publicBaseUrl.password ||
      publicBaseUrl.search ||
      publicBaseUrl.hash ||
      !["", "/"].includes(publicBaseUrl.pathname)
    ) {
      throw Object.assign(new Error("Parola sıfırlama sunucu ayarları eksik."), { status: 503 });
    }
    return {
      publicBaseUrl: publicBaseUrl.origin,
      ...smtpSettings(),
    };
  }

  async function requestPasswordReset(request, response) {
    if (isRateLimited(request, "password-reset")) {
      return writeJson(response, 429, { ok: false, error: "Çok fazla istek; daha sonra tekrar deneyin." });
    }
    requireConfiguredLicenseSecrets();
    const mailSettings = resetMailSettings();
    const input = await readJson(request, 16 * 1024);
    const email = String(input?.email || "").trim().toLowerCase().slice(0, 320);
    if (!validEmail(email)) {
      return writeJson(response, 400, { ok: false, error: "Geçerli bir e-posta adresi girin." });
    }

    const emailHash = emailDigest(email);
    const account = db.prepare("SELECT 1 FROM account_users WHERE email_hash = ?").get(emailHash);
    if (account) {
      db.prepare("DELETE FROM password_reset_tokens WHERE email_hash = ?").run(emailHash);
      const token = randomBytes(32).toString("base64url");
      const tokenHash = hmacHex(process.env.LICENSE_DATA_SECRET, token);
      db.prepare(`
        INSERT INTO password_reset_tokens (token_hash, email_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(tokenHash, emailHash, Date.now() + PASSWORD_RESET_TTL_MS, Date.now());

      const resetUrl = `${mailSettings.publicBaseUrl}/api/account/password/reset?token=${encodeURIComponent(token)}`;
      try {
        const transporter = nodemailer.createTransport({
          host: mailSettings.host,
          port: mailSettings.port,
          secure: mailSettings.secure,
          auth: mailSettings.auth,
        });
        await transporter.sendMail({
          from: process.env.SMTP_FROM,
          to: email,
          subject: "RODON hesabı parola sıfırlama",
          text: `Parolanızı değiştirmek için bu bağlantıyı açın (1 saat geçerlidir): ${resetUrl}`,
          html: `<p>Parolanızı değiştirmek için aşağıdaki bağlantıyı açın. Bağlantı 1 saat geçerlidir.</p><p><a href="${resetUrl}">Parolayı sıfırla</a></p>`,
        });
      } catch {
        db.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?").run(tokenHash);
        console.warn("[license-api] Password reset email could not be sent.");
        return writeJson(response, 503, { ok: false, error: "Sıfırlama e-postası gönderilemedi. Sunucunun posta ayarlarını kontrol edin." });
      }
    }
    return writeJson(response, 200, {
      ok: true,
      message: "Bu e-posta kayıtlıysa parola sıfırlama bağlantısı gönderildi.",
    });
  }

  function passwordResetPage(token) {
    const safeToken = JSON.stringify(token).replace(/</gu, "\\u003c");
    return `<!doctype html>
<html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Parola sıfırlama · RODON</title>
<style>
body{margin:0;background:#09090b;color:#fafafa;font:15px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}
main{box-sizing:border-box;width:min(420px,calc(100% - 32px));padding:28px;background:#15151e;border:1px solid #292936;border-radius:16px}
h1{font-size:20px;margin:0 0 8px}p{color:#a1a1aa;line-height:1.5}label{display:block;margin:20px 0 8px;font-size:13px}
input,button{box-sizing:border-box;width:100%;padding:12px;border-radius:9px;font:inherit}
input{background:#09090b;border:1px solid #3f3f46;color:#fff}
button{margin-top:14px;background:linear-gradient(100deg,#833ab4,#fd1d1d);color:white;border:0;font-weight:700;cursor:pointer}
#message{min-height:20px;font-size:13px}
</style>
<main><h1>Yeni parola belirle</h1><p>Parolanız en az 8 karakter olmalı.</p>
<form id="reset-form"><label for="password">Yeni parola</label>
<input id="password" type="password" minlength="8" maxlength="256" autocomplete="new-password" required>
<button type="submit">Parolayı güncelle</button></form><p id="message" role="status"></p></main>
<script>
const token=${safeToken};
const form=document.getElementById("reset-form");
form.addEventListener("submit",async event=>{
 event.preventDefault();
 const message=document.getElementById("message");
 const button=form.querySelector("button");
 button.disabled=true; message.textContent="Güncelleniyor…";
 try{
  const response=await fetch("/api/account/password/reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token,password:document.getElementById("password").value})});
  const result=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(result.error||"Parola güncellenemedi.");
  form.hidden=true; message.textContent="Parolanız güncellendi. Uzantıdan yeni parolanızla giriş yapabilirsiniz.";
 }catch(error){message.textContent=error.message||"Parola güncellenemedi.";button.disabled=false;}
});
</script></html>`;
  }

  async function resetPassword(request, response, url) {
    if (request.method === "GET") {
      requireConfiguredLicenseSecrets();
      const token = String(url.searchParams.get("token") || "");
      if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
        return writeJson(response, 400, { ok: false, error: "Sıfırlama bağlantısı geçersiz." });
      }
      const tokenHash = hmacHex(process.env.LICENSE_DATA_SECRET, token);
      const reset = db.prepare(`
        SELECT token_hash FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?
      `).get(tokenHash, Date.now());
      if (!reset) return writeJson(response, 410, { ok: false, error: "Sıfırlama bağlantısının süresi dolmuş veya kullanılmış." });
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
      });
      response.end(passwordResetPage(token));
      return;
    }

    if (isRateLimited(request, "password-reset-complete")) {
      return writeJson(response, 429, { ok: false, error: "Çok fazla istek; daha sonra tekrar deneyin." });
    }
    requireConfiguredLicenseSecrets();
    const input = await readJson(request, 16 * 1024);
    const token = String(input?.token || "");
    const password = typeof input?.password === "string" ? input.password : "";
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token) || !validPassword(password)) {
      return writeJson(response, 400, { ok: false, error: "Bağlantı veya yeni parola geçersiz." });
    }
    const tokenHash = hmacHex(process.env.LICENSE_DATA_SECRET, token);
    const reset = db.prepare(`
      SELECT email_hash FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?
    `).get(tokenHash, Date.now());
    if (!reset) return writeJson(response, 410, { ok: false, error: "Sıfırlama bağlantısının süresi dolmuş veya kullanılmış." });

    const salt = randomBytes(16).toString("base64url");
    db.exec("BEGIN IMMEDIATE");
    try {
      const stillValid = db.prepare(`
        SELECT email_hash FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?
      `).get(tokenHash, Date.now());
      if (!stillValid) {
        db.exec("ROLLBACK");
        return writeJson(response, 410, { ok: false, error: "Sıfırlama bağlantısının süresi dolmuş veya kullanılmış." });
      }
      db.prepare(`
        UPDATE account_users SET password_salt = ?, password_hash = ?, updated_at = ?
        WHERE email_hash = ?
      `).run(salt, passwordDigest(password, salt), Date.now(), reset.email_hash);
      db.prepare("DELETE FROM password_reset_tokens WHERE email_hash = ?").run(reset.email_hash);
      db.prepare("DELETE FROM account_sessions WHERE email_hash = ?").run(reset.email_hash);
      db.prepare(`
        DELETE FROM license_devices
        WHERE order_id IN (SELECT order_id FROM shopier_orders WHERE email_hash = ?)
      `).run(reset.email_hash);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return writeJson(response, 200, { ok: true });
  }

  return {
    register,
    verifyRegistration,
    requestLicenseActivation,
    verifyLicenseActivation,
    login,
    subscriptions,
    refreshAccountLicense,
    logout,
    requestPasswordReset,
    resetPassword,
  };
}
