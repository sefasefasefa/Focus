(() => {
  "use strict";

  const root = document.getElementById("account-root");
  if (!root || !globalThis.chrome?.storage?.local) return;

  const API_URL_KEY = "tpLicenseApiBaseUrl";
  const DEVICE_ID_KEY = "tpLicenseDeviceId";
  const ACCOUNT_KEY = "tpAccountState";
  const LICENSE_KEY = "tpLicenseState";
  const SESSION_DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;
  const api = {
    url: "",
    deviceId: "",
    deviceIdVerified: false,
    account: null,
    subscriptions: [],
    view: "login",
    busy: false,
    message: "",
    messageKind: "",
    lastEmail: "",
    registerEmail: "",
    registerPassword: "",
  };

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, result => {
        const error = chrome.runtime?.lastError;
        if (error) reject(new Error(error.message || "Uzantı ayarları okunamadı."));
        else resolve(result || {});
      });
    });
  }

  function storageSet(values) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(values, () => {
        const error = chrome.runtime?.lastError;
        if (error) reject(new Error(error.message || "Uzantı ayarları kaydedilemedi."));
        else resolve();
      });
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        const error = chrome.runtime?.lastError;
        if (error) reject(new Error(error.message || "Oturum kaldırılamadı."));
        else resolve();
      });
    });
  }

  function validateApiUrl(raw) {
    let url;
    try {
      url = new URL(String(raw || "").trim());
    } catch {
      throw new Error("API sunucu yapılandırması geçersiz.");
    }
    const localHttp = url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !localHttp) {
      throw new Error("API adresi HTTPS olmalı. HTTP yalnızca localhost için kullanılabilir.");
    }
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
      throw new Error("Yalnızca API sunucusunun kök adresini girin.");
    }
    return url.origin;
  }

  function requestServerPermission(apiBaseUrl) {
    const origin = new URL(apiBaseUrl).origin;
    const permission = { origins: [`${origin}/*`] };
    return new Promise((resolve, reject) => {
      if (!chrome.permissions?.request) {
        reject(new Error("API sunucusuna erişim izni alınamıyor."));
        return;
      }
      try {
        // Called directly from the submit gesture so the browser can show
        // the optional-host permission prompt.
        chrome.permissions.request(permission, granted => {
          const error = chrome.runtime?.lastError;
          if (error) reject(new Error(error.message || "API sunucu izni alınamadı."));
          else if (!granted) reject(new Error("API sunucusuna erişim izni verilmedi."));
          else resolve();
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async function hasServerPermission(apiBaseUrl) {
    const origin = new URL(apiBaseUrl).origin;
    if (!chrome.permissions?.contains) return false;
    return new Promise(resolve => {
      chrome.permissions.contains({ origins: [`${origin}/*`] }, granted => {
        resolve(Boolean(granted && !chrome.runtime?.lastError));
      });
    });
  }

  async function requestJson(apiBaseUrl, path, { method = "GET", body, token } = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        method,
        cache: "no-store",
        credentials: "omit",
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.ok === false) {
        const message = response.status === 404
          ? "API isteği bulunamadı. Eklentideki sunucu adresini ve lisans API sürümünü kontrol edin."
          : String(result?.error || "Sunucu isteği tamamlanamadı.");
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function ensureDeviceId() {
    if (api.deviceIdVerified && SESSION_DEVICE_ID_PATTERN.test(api.deviceId)) {
      return api.deviceId;
    }
    const stored = await storageGet([DEVICE_ID_KEY, ACCOUNT_KEY, LICENSE_KEY]);
    const candidates = [
      stored[ACCOUNT_KEY]?.deviceId,
      stored[LICENSE_KEY]?.deviceId,
      stored[DEVICE_ID_KEY],
    ];
    const existing = candidates.find(value =>
      SESSION_DEVICE_ID_PATTERN.test(String(value || "")),
    );
    api.deviceId = existing
      ? String(existing)
      : crypto.randomUUID().replace(/-/g, "");
    api.deviceIdVerified = true;
    if (!SESSION_DEVICE_ID_PATTERN.test(api.deviceId)) {
      throw new Error("Oturum kimliği oluşturulamadı.");
    }
    await storageSet({ [DEVICE_ID_KEY]: api.deviceId });
    return api.deviceId;
  }

  function setMessage(message, kind = "") {
    api.message = message;
    api.messageKind = kind;
    const node = root.querySelector("[data-account-message]");
    if (node) {
      node.textContent = message;
      if (kind) node.dataset.kind = kind;
      else delete node.dataset.kind;
    }
  }

  function clearMessage() {
    api.message = "";
    api.messageKind = "";
  }

  function renderMessage() {
    const node = root.querySelector("[data-account-message]");
    if (!node) return;
    node.textContent = api.message;
    if (api.messageKind) node.dataset.kind = api.messageKind;
    else delete node.dataset.kind;
  }

  function iconMarkup() {
    return `<span class="account-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"></circle><path d="M4.5 21a7.5 7.5 0 0 1 15 0"></path></svg></span>`;
  }

  function renderLogin() {
    root.innerHTML = `
      <section aria-labelledby="account-title">
        <div class="account-heading">${iconMarkup()}<div><h2 class="account-title" id="account-title">Hesabına giriş yap</h2><p class="account-subtitle">Aboneliğini ve hesap ayarlarını görüntüle.</p></div></div>
        <form class="account-form" id="account-login-form">
          <label class="account-field" for="account-email">E-posta<input class="account-input" id="account-email" name="email" type="email" autocomplete="username" required></label>
          <label class="account-field" for="account-password">Parola<input class="account-input" id="account-password" name="password" type="password" autocomplete="current-password" required></label>
          <button class="account-button primary" type="submit" ${api.busy ? "disabled" : ""}>${api.busy ? "Giriş yapılıyor…" : "Giriş yap"}</button>
        </form>
        <div class="account-links"><button class="account-link" type="button" data-action="forgot">Parolamı unuttum</button><button class="account-link" type="button" data-action="register">Hesap oluştur</button></div>
        <p class="account-message" data-account-message role="status"></p>
      </section>`;
    root.querySelector("#account-email").value = api.lastEmail;
    root.querySelector("#account-login-form").addEventListener("submit", handleLogin);
    root.querySelector('[data-action="forgot"]').addEventListener("click", () => {
      clearMessage();
      api.view = "reset";
      render();
    });
    root.querySelector('[data-action="register"]').addEventListener("click", () => {
      clearMessage();
      api.view = "register";
      render();
    });
    renderMessage();
  }

  function renderRegister() {
    root.innerHTML = `
      <section aria-labelledby="account-title">
        <button class="account-back" type="button" data-action="back">← Girişe dön</button>
        <div class="account-heading">${iconMarkup()}<div><h2 class="account-title" id="account-title">Ücretsiz hesap oluştur</h2><p class="account-subtitle">Satın alma gerekmez. E-postanı doğrula ve 7 gün ücretsiz kullan.</p></div></div>
        <form class="account-form" id="account-register-form">
          <label class="account-field" for="account-email">E-posta<input class="account-input" id="account-email" name="email" type="email" autocomplete="email" required></label>
          <label class="account-field" for="account-password">Parola (en az 8 karakter)<input class="account-input" id="account-password" name="password" type="password" minlength="8" maxlength="256" autocomplete="new-password" required></label>
          <button class="account-button primary" type="submit" ${api.busy ? "disabled" : ""}>${api.busy ? "Hesap oluşturuluyor…" : "Hesap oluştur"}</button>
        </form>
        <p class="account-message" data-account-message role="status"></p>
      </section>`;
    root.querySelector("#account-email").value = api.lastEmail;
    root.querySelector("#account-register-form").addEventListener("submit", handleRegister);
    root.querySelector('[data-action="back"]').addEventListener("click", () => {
      clearMessage();
      api.view = "login";
      render();
    });
    renderMessage();
  }

  function renderRegisterVerify() {
    root.innerHTML = `
      <section aria-labelledby="account-title">
        <button class="account-back" type="button" data-action="back">← Kayıt bilgilerine dön</button>
        <div class="account-heading">${iconMarkup()}<div><h2 class="account-title" id="account-title">E-postanı doğrula</h2><p class="account-subtitle">E-postana gönderilen 6 haneli kodu gir. Hesabın açılınca 7 günlük denemen başlar; kod 10 dakika geçerlidir.</p></div></div>
        <form class="account-form" id="account-register-verify-form">
          <label class="account-field" for="account-verification-code">Doğrulama kodu<input class="account-input" id="account-verification-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
          <button class="account-button primary" type="submit" ${api.busy ? "disabled" : ""}>${api.busy ? "Doğrulanıyor…" : "E-postayı doğrula ve hesabı oluştur"}</button>
        </form>
        <p class="account-message" data-account-message role="status"></p>
      </section>`;
    root.querySelector("#account-register-verify-form").addEventListener("submit", handleRegisterVerify);
    root.querySelector('[data-action="back"]').addEventListener("click", () => {
      clearMessage();
      api.view = "register";
      render();
    });
    renderMessage();
  }

  function formatDate(value) {
    if (value === null || value === undefined) return "Süresiz";
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return "Bitiş tarihi belirtilmemiş";
    return `Bitiş: ${new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(date)}`;
  }

  function statusLabel(status) {
    if (status === "active") return "Aktif";
    if (status === "trial") return "Ücretsiz deneme";
    if (status === "expired") return "Süresi doldu";
    if (status === "revoked") return "İptal";
    return "Beklemede";
  }

  function renderHome() {
    const hasActivePaidPlan = api.subscriptions.some(item => !item.isTrial && item.status === "active");
    const trialExpired = !hasActivePaidPlan && api.subscriptions.some(item => item.isTrial && item.status === "expired");
    const subscriptionsMarkup = api.subscriptions.length
      ? `<div class="subscription-list">${api.subscriptions.map(item => `
          <article class="subscription-card">
            <div><p class="subscription-name"></p><p class="subscription-expiry"></p></div>
            <span class="subscription-status"></span>
          </article>`).join("")}</div>`
      : `<p class="account-subtitle">${api.busy ? "Abonelikler yükleniyor…" : "Bu hesapta kayıtlı abonelik bulunamadı."}</p>`;
    root.innerHTML = `
      <section aria-labelledby="account-title">
        <div class="account-heading">${iconMarkup()}<div><h2 class="account-title" id="account-title">Hesabım</h2><p class="account-subtitle" data-account-email></p></div></div>
        <div class="account-actions">
          <button class="account-button" type="button" data-action="settings">Ayarlar</button>
          <button class="account-button danger" type="button" data-action="logout" ${api.busy ? "disabled" : ""}>${api.busy ? "Çıkış yapılıyor…" : "Çıkış yap"}</button>
        </div>
        <button class="account-button primary purchase-page-button" type="button" data-action="purchase">Aylık satın alma sayfası</button>
        <div class="account-divider"></div>
        <h3 class="subscription-title">Abonelikler</h3>
        ${trialExpired ? `<aside class="trial-expired-notice"><strong>7 günlük ücretsiz denemen sona erdi.</strong><span>Devam etmek için aylık satın alma sayfasından bu hesapla devam et. Ödeme onaylandıktan sonra erişimin otomatik açılır.</span></aside>` : ""}
        <div data-subscription-list>${subscriptionsMarkup}</div>
        <p class="account-message" data-account-message role="status"></p>
      </section>`;
    root.querySelector("[data-account-email]").textContent = api.account?.email || "";
    const cards = root.querySelectorAll(".subscription-card");
    cards.forEach((card, index) => {
      const subscription = api.subscriptions[index];
      card.querySelector(".subscription-name").textContent = subscription.planName || "Lisans paketi";
      card.querySelector(".subscription-expiry").textContent = formatDate(subscription.expiresAt);
      const status = card.querySelector(".subscription-status");
      status.textContent = statusLabel(subscription.status);
      status.classList.add(subscription.status);
    });
    root.querySelector('[data-action="settings"]').addEventListener("click", () => {
      clearMessage();
      api.view = "settings";
      render();
    });
    root.querySelector('[data-action="logout"]').addEventListener("click", handleLogout);
    root.querySelector('[data-action="purchase"]').addEventListener("click", () => {
      try {
        chrome.tabs.create({ url: chrome.runtime.getURL("license.html") });
      } catch {
        setMessage("Satın alma sayfası açılamadı. Uzantı izinlerini kontrol edin.", "error");
      }
    });
    renderMessage();
  }

  async function storeAccountLogin(result, email, apiBaseUrl, deviceId) {
    if (!result.sessionToken || !result.account?.email) {
      throw new Error("Sunucu geçerli bir hesap oturumu döndürmedi.");
    }
    api.url = apiBaseUrl;
    api.account = {
      email: result.account.email,
      sessionToken: result.sessionToken,
      sessionExpiresAt: Number(result.sessionExpiresAt) || 0,
      apiBaseUrl,
      deviceId,
    };
    api.subscriptions = Array.isArray(result.subscriptions) ? result.subscriptions : [];
    const values = {
      [API_URL_KEY]: apiBaseUrl,
      [DEVICE_ID_KEY]: deviceId,
      [ACCOUNT_KEY]: api.account,
    };
    if (result.license?.accessToken) {
      values[LICENSE_KEY] = {
        apiBaseUrl,
        deviceId,
        accessToken: result.license.accessToken,
        refreshToken: String(result.license.refreshToken || ""),
        tokenExpiresAt: Number(result.license.tokenExpiresAt) || Date.now() + 9 * 60 * 1000,
        validatedAt: Date.now(),
        expiresAt: result.license.expiresAt == null ? null : Number(result.license.expiresAt),
        licenseType: String(result.license.licenseType || ""),
      };
    }
    await storageSet(values);
    if (!result.license?.accessToken) await storageRemove([LICENSE_KEY]);
  }

  function renderSettings() {
    root.innerHTML = `
      <section aria-labelledby="account-title">
        <button class="account-back" type="button" data-action="back">← Hesabıma dön</button>
        <div class="account-heading">${iconMarkup()}<div><h2 class="account-title" id="account-title">Ayarlar</h2><p class="account-subtitle">Parola sıfırlama</p></div></div>
        <form class="account-form" id="account-reset-form">
          <p class="account-subtitle">Hesabına parola sıfırlama bağlantısı gönder.</p>
          <button class="account-button primary" type="submit" ${api.busy ? "disabled" : ""}>${api.busy ? "Gönderiliyor…" : "Sıfırlama bağlantısı gönder"}</button>
        </form>
        <p class="account-message" data-account-message role="status"></p>
      </section>`;
    root.querySelector('[data-action="back"]').addEventListener("click", () => {
      clearMessage();
      api.view = "home";
      render();
    });
    root.querySelector("#account-reset-form").addEventListener("submit", handleSettingsReset);
    const accountEmail = document.createElement("p");
    accountEmail.className = "account-subtitle";
    accountEmail.textContent = api.account?.email || "";
    root.querySelector("#account-reset-form").prepend(accountEmail);
    renderMessage();
  }

  function renderReset() {
    root.innerHTML = `
      <section aria-labelledby="account-title">
        <button class="account-back" type="button" data-action="back">← Girişe dön</button>
        <div class="account-heading">${iconMarkup()}<div><h2 class="account-title" id="account-title">Parolamı unuttum</h2><p class="account-subtitle">Hesabının e-posta adresini yaz.</p></div></div>
        <form class="account-form" id="account-reset-form">
          <label class="account-field" for="account-email">E-posta<input class="account-input" id="account-email" name="email" type="email" autocomplete="email" required></label>
          <button class="account-button primary" type="submit" ${api.busy ? "disabled" : ""}>${api.busy ? "Gönderiliyor…" : "Sıfırlama bağlantısı gönder"}</button>
        </form>
        <p class="account-message" data-account-message role="status"></p>
      </section>`;
    root.querySelector("#account-email").value = api.lastEmail;
    root.querySelector('[data-action="back"]').addEventListener("click", () => {
      clearMessage();
      api.view = "login";
      render();
    });
    root.querySelector("#account-reset-form").addEventListener("submit", handleForgotReset);
    renderMessage();
  }

  function render() {
    if (api.view === "settings") document.body.dataset.accountView = "settings";
    else delete document.body.dataset.accountView;
    if (api.view === "home") renderHome();
    else if (api.view === "settings") renderSettings();
    else if (api.view === "register") renderRegister();
    else if (api.view === "register-verify") renderRegisterVerify();
    else if (api.view === "reset") renderReset();
    else renderLogin();
  }

  function getFormServerUrl() {
    return validateApiUrl(
      api.account?.apiBaseUrl ||
      globalThis.__TAKIPCI_ENV__?.LICENSE_API_BASE_URL ||
      api.url,
    );
  }

  async function handleLogin(event) {
    event.preventDefault();
    if (api.busy) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");
    api.lastEmail = email;
    let apiBaseUrl;
    let permissionRequest;
    try {
      apiBaseUrl = getFormServerUrl();
      permissionRequest = requestServerPermission(apiBaseUrl);
    } catch (error) {
      setMessage(error.message || "API sunucusuna bağlantı kurulamadı.", "error");
      return;
    }
    api.url = apiBaseUrl;
    api.busy = true;
    render();
    try {
      await permissionRequest;
      await storageSet({ [API_URL_KEY]: apiBaseUrl });
      const deviceId = await ensureDeviceId();
      const result = await requestJson(apiBaseUrl, "/api/account/login", {
        method: "POST",
        body: { email, password, deviceId },
      });
      await storeAccountLogin(result, email, apiBaseUrl, deviceId);
      api.busy = false;
      api.view = "home";
      clearMessage();
      render();
    } catch (error) {
      api.busy = false;
      render();
      setMessage(error.message || "Giriş yapılamadı. API sunucusunun çalıştığını ve hesap bilgilerini kontrol edin.", "error");
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    if (api.busy) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");
    api.lastEmail = email;
    let apiBaseUrl;
    let permissionRequest;
    try {
      apiBaseUrl = getFormServerUrl();
      if (password.length < 8) throw new Error("Parola en az 8 karakter olmalı.");
      permissionRequest = requestServerPermission(apiBaseUrl);
    } catch (error) {
      setMessage(error.message || "API sunucusuna bağlantı kurulamadı.", "error");
      return;
    }
    api.busy = true;
    render();
    try {
      await permissionRequest;
      api.url = apiBaseUrl;
      await storageSet({ [API_URL_KEY]: apiBaseUrl });
      await requestJson(apiBaseUrl, "/api/account/register", {
        method: "POST",
        body: { email, password },
      });
      api.registerEmail = email;
      api.registerPassword = password;
      api.busy = false;
      api.view = "register-verify";
      clearMessage();
      render();
      setMessage("Doğrulama kodu e-postana gönderildi. 7 günlük ücretsiz deneme hesabın açılınca başlar.", "success");
    } catch (error) {
      api.busy = false;
      render();
      setMessage(error.message || "Hesap oluşturulamadı.", "error");
    }
  }

  async function handleRegisterVerify(event) {
    event.preventDefault();
    if (api.busy) return;
    const form = new FormData(event.currentTarget);
    const code = String(form.get("code") || "").trim();
    let apiBaseUrl;
    let permissionRequest;
    try {
      apiBaseUrl = getFormServerUrl();
      if (!/^\d{6}$/.test(code)) throw new Error("E-postana gelen 6 haneli kodu gir.");
      permissionRequest = requestServerPermission(apiBaseUrl);
    } catch (error) {
      setMessage(error.message || "API sunucusuna bağlantı kurulamadı.", "error");
      return;
    }
    api.busy = true;
    render();
    try {
      await permissionRequest;
      api.url = apiBaseUrl;
      const email = api.registerEmail;
      await requestJson(apiBaseUrl, "/api/account/register/verify", {
        method: "POST",
        body: { email, code },
      });
      try {
        const deviceId = await ensureDeviceId();
        const result = await requestJson(apiBaseUrl, "/api/account/login", {
          method: "POST",
          body: { email, password: api.registerPassword, deviceId },
        });
        await storeAccountLogin(result, email, apiBaseUrl, deviceId);
        api.view = "home";
        clearMessage();
      } catch {
        api.lastEmail = email;
        api.view = "login";
        clearMessage();
      }
      api.busy = false;
      render();
      setMessage(
        api.view === "home"
          ? "E-posta doğrulandı. 7 günlük ücretsiz denemen başladı."
          : "Hesabın ve 7 günlük ücretsiz denemen oluşturuldu. Şimdi giriş yapabilirsin.",
        "success",
      );
      api.registerEmail = "";
      api.registerPassword = "";
    } catch (error) {
      api.busy = false;
      render();
      setMessage(error.message || "E-posta doğrulanamadı.", "error");
    }
  }

  async function submitPasswordReset(email, apiBaseUrl, permissionRequest) {
    if (api.busy) return;
    api.busy = true;
    render();
    try {
      await permissionRequest;
      api.url = apiBaseUrl;
      await storageSet({ [API_URL_KEY]: apiBaseUrl });
      await requestJson(apiBaseUrl, "/api/account/password/reset/request", {
        method: "POST",
        body: { email },
      });
      api.busy = false;
      render();
      setMessage("İstek alındı. Kayıtlı hesapsa sıfırlama bağlantısı e-postayla gönderildi.", "success");
    } catch (error) {
      api.busy = false;
      render();
      setMessage(error.message || "Sıfırlama isteği gönderilemedi.", "error");
    }
  }

  async function handleForgotReset(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") || "").trim();
    api.lastEmail = email;
    try {
      const apiBaseUrl = getFormServerUrl();
      const permissionRequest = requestServerPermission(apiBaseUrl);
      await submitPasswordReset(email, apiBaseUrl, permissionRequest);
    } catch (error) {
      setMessage(error.message || "API sunucusuna bağlantı kurulamadı.", "error");
    }
  }

  async function handleSettingsReset(event) {
    event.preventDefault();
    try {
      const apiBaseUrl = validateApiUrl(api.account?.apiBaseUrl || api.url);
      const permissionRequest = requestServerPermission(apiBaseUrl);
      await submitPasswordReset(api.account.email, apiBaseUrl, permissionRequest);
    } catch (error) {
      setMessage(error.message || "Sıfırlama isteği gönderilemedi.", "error");
    }
  }

  async function handleLogout() {
    if (api.busy || !api.account) return;
    let permissionRequest;
    try {
      const apiBaseUrl = validateApiUrl(api.account.apiBaseUrl);
      permissionRequest = requestServerPermission(apiBaseUrl);
    } catch (error) {
      setMessage(error.message || "API sunucusuna bağlantı kurulamadı.", "error");
      return;
    }
    api.busy = true;
    render();
    try {
      await permissionRequest;
      await requestJson(api.account.apiBaseUrl, "/api/account/session", {
        method: "DELETE",
        token: api.account.sessionToken,
      });
      await storageRemove([ACCOUNT_KEY, LICENSE_KEY]);
      api.account = null;
      api.subscriptions = [];
      api.view = "login";
      api.busy = false;
      clearMessage();
      render();
    } catch (error) {
      if (error.status === 401) {
        await storageRemove([ACCOUNT_KEY, LICENSE_KEY]);
        api.account = null;
        api.subscriptions = [];
        api.view = "login";
        api.busy = false;
        render();
        setMessage("Hesap oturumunun süresi dolmuş. Yeniden giriş yapın.", "error");
        return;
      }
      api.busy = false;
      render();
      setMessage(error.message || "Çıkış yapılamadı. Bağlantıyı kontrol edip tekrar deneyin.", "error");
    }
  }

  async function refreshSubscriptions() {
    if (!api.account) return;
    try {
      if (!(await hasServerPermission(api.account.apiBaseUrl))) {
        throw new Error("Abonelikleri görmek için API sunucu izni gerekli.");
      }
      const entitlement = await requestJson(api.account.apiBaseUrl, "/api/account/license/refresh", {
        method: "POST",
        body: {},
        token: api.account.sessionToken,
      });
      api.subscriptions = Array.isArray(entitlement.subscriptions)
        ? entitlement.subscriptions
        : api.subscriptions;
      if (entitlement.license?.accessToken) {
        await storageSet({
          [LICENSE_KEY]: {
            apiBaseUrl: api.account.apiBaseUrl,
            deviceId: api.account.deviceId,
            accessToken: entitlement.license.accessToken,
            refreshToken: String(entitlement.license.refreshToken || ""),
            tokenExpiresAt: Number(entitlement.license.tokenExpiresAt) || Date.now() + 9 * 60 * 1000,
            validatedAt: Date.now(),
            expiresAt: entitlement.license.expiresAt == null
              ? null
              : Number(entitlement.license.expiresAt),
            licenseType: String(entitlement.license.licenseType || ""),
          },
        });
      } else {
        await storageRemove([LICENSE_KEY]);
      }
      await storageSet({ [ACCOUNT_KEY]: api.account });
      render();
    } catch (error) {
      if (error.status === 401) {
        await storageRemove([ACCOUNT_KEY, LICENSE_KEY]);
        api.account = null;
        api.subscriptions = [];
        api.view = "login";
        api.busy = false;
        render();
        setMessage("Hesap oturumunun süresi dolmuş. Yeniden giriş yapın.", "error");
        return;
      }
      setMessage(error.message || "Abonelikler yüklenemedi.", "error");
    }
  }

  async function initialize() {
    try {
      const stored = await storageGet([
        API_URL_KEY,
        DEVICE_ID_KEY,
        ACCOUNT_KEY,
        LICENSE_KEY,
      ]);
      api.url = String(
        globalThis.__TAKIPCI_ENV__?.LICENSE_API_BASE_URL ||
        stored[API_URL_KEY] ||
        stored[LICENSE_KEY]?.apiBaseUrl ||
        "",
      ).trim();
      api.deviceId = String(
        stored[ACCOUNT_KEY]?.deviceId ||
        stored[LICENSE_KEY]?.deviceId ||
        stored[DEVICE_ID_KEY] ||
        "",
      );
      api.account = stored[ACCOUNT_KEY] && typeof stored[ACCOUNT_KEY] === "object"
        ? stored[ACCOUNT_KEY]
        : null;
      if (
        api.account?.sessionToken &&
        api.account?.email &&
        api.account?.apiBaseUrl &&
        Number(api.account.sessionExpiresAt) > Date.now()
      ) {
        api.url = api.account.apiBaseUrl;
        api.busy = true;
        api.view = "login";
        render();
        let currentDeviceId;
        try {
          currentDeviceId = await ensureDeviceId();
        } catch (error) {
          api.busy = false;
          api.lastEmail = api.account.email;
          render();
          setMessage(error.message || "Hesap oturumu hazırlanamadı.", "error");
          return;
        }
        if (api.account.deviceId !== currentDeviceId) {
          api.lastEmail = api.account.email;
          await storageRemove([ACCOUNT_KEY, LICENSE_KEY]);
          api.account = null;
          api.subscriptions = [];
          api.view = "login";
          api.busy = false;
          render();
          setMessage("Hesap oturumu bu uzantı kurulumuyla eşleşmiyor. E-posta ve parolanla yeniden giriş yap.", "info");
          return;
        }
        api.view = "home";
        render();
        await refreshSubscriptions();
        api.busy = false;
        render();
        return;
      }
      if (api.account) await storageRemove([ACCOUNT_KEY]);
      api.account = null;
      render();
    } catch (error) {
      render();
      setMessage(error.message || "Hesap bilgileri yüklenemedi.", "error");
    }
  }

  initialize();
})();
