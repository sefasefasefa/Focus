import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const COOKIE_NAMES = new Set([
  "sessionid",
  "csrftoken",
  "ds_user_id",
  "rur",
  "mid",
  "ig_did",
]);

export function parseInstagramSessionKey(value) {
  const key = Buffer.from(String(value || ""), "base64url");
  if (key.length !== 32) {
    throw new Error("INSTAGRAM_SESSION_ENCRYPTION_KEY must be a 32-byte base64url key.");
  }
  return key;
}

export function sanitizeInstagramSession(input) {
  if (input?.consent !== true || input?.consentVersion !== "instagram-session-v1") {
    throw Object.assign(new Error("Instagram oturumunu sunucuya bağlamak için açık onay gerekli."), {
      status: 400,
    });
  }
  const instagramUserId = String(input?.instagramUserId || "").trim();
  if (!/^\d{1,24}$/.test(instagramUserId)) {
    throw Object.assign(new Error("Instagram kullanıcı kimliği geçersiz."), { status: 400 });
  }
  const cookies = {};
  const source = input?.cookies;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw Object.assign(new Error("Instagram oturum bilgisi geçersiz."), { status: 400 });
  }
  for (const [name, rawValue] of Object.entries(source)) {
    if (!COOKIE_NAMES.has(name)) continue;
    const value = String(rawValue || "");
    if (!value || value.length > 8192 || /[\r\n;]/.test(value)) {
      throw Object.assign(new Error("Instagram oturum çerezi geçersiz."), { status: 400 });
    }
    cookies[name] = value;
  }
  if (
    !cookies.sessionid ||
    !cookies.csrftoken ||
    !cookies.ds_user_id ||
    cookies.ds_user_id !== instagramUserId
  ) {
    throw Object.assign(new Error("Instagram oturum çerezleri eksik veya hesap kimliği eşleşmiyor."), {
      status: 400,
    });
  }
  return {
    instagramUserId,
    cookies,
    consentAt: Number.isFinite(Number(input?.consentAt))
      ? Number(input.consentAt)
      : Date.now(),
  };
}

export function encryptInstagramSession(session, key, associatedData) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: encrypted.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptInstagramSession(record, key, associatedData) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(record.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext);
}

export function instagramCookieHeader(cookies) {
  return Object.entries(cookies)
    .filter(([name, value]) => COOKIE_NAMES.has(name) && value)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}
