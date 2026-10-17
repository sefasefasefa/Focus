const COOKIE_NAMES = new Set([
  "sessionid",
  "csrftoken",
  "ds_user_id",
  "rur",
  "mid",
  "ig_did",
]);

export function sanitizeInstagramSession(input) {
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
  };
}

export function instagramCookieHeader(cookies) {
  return Object.entries(cookies)
    .filter(([name, value]) => COOKIE_NAMES.has(name) && value)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}
