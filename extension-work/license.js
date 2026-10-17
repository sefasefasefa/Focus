(() => {
  "use strict";

  const runtimeAvailable = Boolean(globalThis.chrome?.runtime?.sendMessage);
  const storageAvailable = Boolean(globalThis.chrome?.storage?.local);
  const SESSION_DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;
  const elements = {
    refreshStatus: document.getElementById("refresh-status"),
    statusPanel: document.getElementById("license-status"),
    statusLabel: document.getElementById("status-label"),
    statusDetail: document.getElementById("status-detail"),
    accountState: document.getElementById("purchase-account-state"),
    accountEmail: document.getElementById("purchase-account-email"),
    purchaseFeedback: document.getElementById("purchase-feedback"),
    openAccountButton: document.getElementById("open-account-button"),
    checkPurchaseButton: document.getElementById("check-purchase-button"),
    sessionPanel: document.getElementById("instagram-session-status"),
    sessionLabel: document.getElementById("instagram-session-label"),
    sessionDetail: document.getElementById("instagram-session-detail"),
    sessionCheckButton: document.getElementById("instagram-session-check"),
    refreshPlans: document.getElementById("refresh-plans"),
    plansState: document.getElementById("plans-state"),
    plansTitle: document.getElementById("plans-state-title"),
    plansDetail: document.getElementById("plans-state-detail"),
    plansList: document.getElementById("plans-list"),
  };

  let statusBusy = false;
  let configBusy = false;
  let purchaseBusy = false;
  let sessionBusy = false;
  let licenseActive = false;
  let sessionAvailable = false;
  let licenseApiBaseUrl = "";
  let trialExpiredNeedsPurchase = false;
  let accountSession = null;

  function setStatus(label, detail, state = "loading") {
    elements.statusLabel.textContent = label;
    elements.statusDetail.textContent = detail;
    elements.statusPanel.dataset.state = state;
  }

  function renderTrialPurchaseLink() {
    elements.statusPanel.querySelector(".trial-purchase-link")?.remove();
    if (!trialExpiredNeedsPurchase) return;
    const link = document.createElement("a");
    link.className = "plan-link trial-purchase-link";
    link.href = "#purchase-account";
    link.textContent = "Aylık satın alma sayfasına git";
    elements.statusPanel.querySelector(".status-copy").append(link);
  }

  function setPlansState(title, detail) {
    elements.plansTitle.textContent = title;
    elements.plansDetail.textContent = detail;
  }

  function setPurchaseFeedback(message, kind = "error") {
    elements.purchaseFeedback.textContent = message;
    if (message) elements.purchaseFeedback.dataset.kind = kind;
    else delete elements.purchaseFeedback.dataset.kind;
  }

  function setInstagramSessionStatus(label, detail, state = "loading") {
    elements.sessionLabel.textContent = label;
    elements.sessionDetail.textContent = detail;
    elements.sessionPanel.dataset.state = state;
  }

  function renderBusy() {
    elements.refreshStatus.disabled = statusBusy || !runtimeAvailable;
    elements.refreshPlans.disabled = configBusy || !runtimeAvailable;
    elements.checkPurchaseButton.disabled =
      purchaseBusy || !runtimeAvailable || !accountSession ||
      Number(accountSession.sessionExpiresAt) <= Date.now();
    elements.sessionCheckButton.disabled = sessionBusy || !runtimeAvailable || !licenseActive;
    elements.refreshStatus.setAttribute("aria-busy", String(statusBusy));
    elements.refreshPlans.setAttribute("aria-busy", String(configBusy));
    elements.checkPurchaseButton.setAttribute("aria-busy", String(purchaseBusy));
  }

  function readStoredAccount() {
    return new Promise(resolve => {
      if (!storageAvailable) {
        resolve(null);
        return;
      }
      chrome.storage.local.get(["tpAccountState", "tpLicenseState", "tpLicenseDeviceId"], result => {
        const account = result?.tpAccountState && typeof result.tpAccountState === "object"
          ? result.tpAccountState
          : null;
        if (account) {
          account.deviceId = String(
            account.deviceId ||
            result?.tpLicenseState?.deviceId ||
            result?.tpLicenseDeviceId ||
            "",
          );
        }
        resolve(account);
      });
    });
  }

  function renderAccountState() {
    const signedIn = Boolean(
      accountSession?.sessionToken &&
      accountSession?.email &&
      Number(accountSession.sessionExpiresAt) > Date.now(),
    );
    elements.accountState.textContent = signedIn
      ? "Hesabınla giriş yaptın. Satın alma bu hesaba bağlanacak."
      : "Satın alma için önce e-posta ve parolanla giriş yap veya ücretsiz hesap oluştur.";
    elements.accountEmail.hidden = !signedIn;
    elements.accountEmail.textContent = signedIn
      ? `Shopier'de kullanacağın e-posta: ${accountSession.email}`
      : "";
    elements.openAccountButton.textContent = signedIn
      ? "Hesap bilgilerini aç"
      : "Giriş yap / ücretsiz hesap oluştur";
    renderBusy();
  }

  function openAccountPage() {
    if (!globalThis.chrome?.tabs?.create || !globalThis.chrome?.runtime?.getURL) {
      setPurchaseFeedback("Hesap ekranı uzantı içinden açılamadı.", "error");
      return;
    }
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
  }

  async function syncAccountLicense(requestPermission = false) {
    if (
      !accountSession?.sessionToken ||
      Number(accountSession.sessionExpiresAt) <= Date.now()
    ) {
      renderAccountState();
      return null;
    }
    const apiBaseUrl = validateApiUrl(accountSession.apiBaseUrl || licenseApiBaseUrl);
    await ensureServerPermission(apiBaseUrl, requestPermission);
    await saveUrl(apiBaseUrl);
    const response = await fetch(`${apiBaseUrl}/api/account/license/refresh`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accountSession.sessionToken}`,
      },
      body: JSON.stringify({}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.ok === false) {
      throw new Error(String(result?.error || "Hesap lisansı yenilenemedi."));
    }
    licenseApiBaseUrl = apiBaseUrl;
    accountSession.apiBaseUrl = apiBaseUrl;
    const sessionDeviceId = String(
      result.deviceId || accountSession.deviceId || result.license?.deviceId || "",
    );
    if (!SESSION_DEVICE_ID_PATTERN.test(sessionDeviceId)) {
      throw new Error("Hesap oturumu yenilenemedi.");
    }
    accountSession.deviceId = sessionDeviceId;
    const license = result.license;
    if (license?.accessToken) {
      await new Promise((resolve, reject) => {
        chrome.storage.local.set({
          tpLicenseApiBaseUrl: apiBaseUrl,
          tpLicenseDeviceId: sessionDeviceId,
          tpLicenseState: {
            apiBaseUrl,
            deviceId: sessionDeviceId,
            accessToken: license.accessToken,
            refreshToken: String(license.refreshToken || ""),
            tokenExpiresAt: Number(license.tokenExpiresAt) || Date.now() + 9 * 60 * 1000,
            validatedAt: Date.now(),
            expiresAt: license.expiresAt == null ? null : Number(license.expiresAt),
            licenseType: String(license.licenseType || ""),
          },
          tpAccountState: accountSession,
        }, () => {
          const error = chrome.runtime?.lastError;
          if (error) reject(new Error(error.message || "Lisans bilgisi kaydedilemedi."));
          else resolve();
        });
      });
    } else if (Array.isArray(result.subscriptions) &&
      result.subscriptions.some(item => item.isTrial === true && item.status === "expired")) {
      const trial = result.subscriptions.find(item => item.isTrial === true && item.status === "expired");
      await new Promise((resolve, reject) => {
        chrome.storage.local.set({
          tpLicenseApiBaseUrl: apiBaseUrl,
          tpLicenseState: {
            apiBaseUrl,
            deviceId: accountSession.deviceId || "",
            accessToken: "",
            refreshToken: "",
            tokenExpiresAt: 0,
            validatedAt: 0,
            expiresAt: Number(trial.expiresAt) || Date.now() - 1,
            licenseType: "trial",
          },
          tpAccountState: accountSession,
        }, () => {
          const error = chrome.runtime?.lastError;
          if (error) reject(new Error(error.message || "Deneme durumu kaydedilemedi."));
          else resolve();
        });
      });
    } else {
      await new Promise((resolve, reject) => {
        chrome.storage.local.remove(["tpLicenseState"], () => {
          const error = chrome.runtime?.lastError;
          if (error) reject(new Error(error.message || "Eski lisans kaldırılamadı."));
          else resolve();
        });
      });
    }
    renderAccountState();
    return result;
  }

  async function checkPurchase() {
    if (purchaseBusy) return;
    purchaseBusy = true;
    setPurchaseFeedback("Shopier bildirimi kontrol ediliyor…", "success");
    renderBusy();
    try {
      const result = await syncAccountLicense(true);
      if (!result?.license?.accessToken) {
        setPurchaseFeedback("Aktif lisans bulunamadı. Shopier ödemesinde hesap e-postanı kullandığını ve ödemenin tamamlandığını kontrol et.", "error");
        return;
      }
      if (String(result.license.licenseType) === "paid") {
        setPurchaseFeedback("Satın alma doğrulandı. Aylık erişimin açıldı; tüm lisanslı özellikler kullanılabilir.", "success");
      } else {
        setPurchaseFeedback("Ödeme bildirimi henüz ulaşmadı. Biraz bekleyip yeniden kontrol et.", "success");
      }
      await refreshStatus(true);
    } catch (error) {
      setPurchaseFeedback(error?.message || "Satın alma durumu kontrol edilemedi.", "error");
    } finally {
      purchaseBusy = false;
      renderBusy();
    }
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      if (!globalThis.chrome?.runtime?.sendMessage) {
        reject(new Error("Chrome uzantı iletişim API'si kullanılamıyor. Bu sayfa lisans işlemleri için uzantı içinde açılmalıdır."));
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message || "Lisans sunucusuna ulaşılamadı."));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function readStoredUrl() {
    return new Promise((resolve) => {
      if (!storageAvailable) {
        resolve("");
        return;
      }
      try {
        chrome.storage.local.get("tpLicenseApiBaseUrl", (result) => {
          if (chrome.runtime?.lastError) {
            resolve("");
            return;
          }
          resolve(typeof result?.tpLicenseApiBaseUrl === "string" ? result.tpLicenseApiBaseUrl : "");
        });
      } catch {
        resolve("");
      }
    });
  }

  function saveUrl(url) {
    return new Promise((resolve, reject) => {
      if (!storageAvailable) {
        resolve();
        return;
      }
      try {
        chrome.storage.local.set({ tpLicenseApiBaseUrl: url }, () => {
          const runtimeError = chrome.runtime?.lastError;
          if (runtimeError) reject(new Error(runtimeError.message));
          else resolve();
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function validateApiUrl(raw) {
    let parsed;
    try {
      parsed = new URL(raw.trim());
    } catch {
      throw new Error("Sunucu yapılandırması geçersiz.");
    }
    const localHttp = parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !localHttp) {
      throw new Error("Uzak sunucular HTTPS kullanmalı; HTTP yalnızca yerel sunucuda kullanılabilir.");
    }
    return parsed.toString().replace(/\/$/, "");
  }

  function getApiBaseUrl() {
    const configuredUrl = licenseApiBaseUrl ||
      globalThis.__TAKIPCI_ENV__?.LICENSE_API_BASE_URL ||
      "";
    return validateApiUrl(configuredUrl);
  }

  function permissionCall(method, details) {
    return new Promise((resolve, reject) => {
      if (!globalThis.chrome?.permissions?.[method]) {
        reject(new Error("Uzantı için API sunucusu erişim izni kullanılamıyor."));
        return;
      }
      chrome.permissions[method](details, (granted) => {
        const runtimeError = chrome.runtime?.lastError;
        if (runtimeError) reject(new Error(runtimeError.message || "Sunucu izni alınamadı."));
        else resolve(granted);
      });
    });
  }

  async function ensureServerPermission(apiBaseUrl, requestIfMissing) {
    const origin = new URL(apiBaseUrl).origin;
    const permission = { origins: [`${origin}/*`] };
    if (requestIfMissing) {
      if (await permissionCall("request", permission)) return;
      throw new Error("Sunucuya erişim izni verilmedi; lisans ve Instagram işlemleri çalışamaz.");
    }
    if (!(await permissionCall("contains", permission))) {
      throw new Error("Sunucu izni eksik. İzin penceresini açmak için Paketleri yenile’ye basın.");
    }
  }

  function formatExpiry(value) {
    if (!value) return "Bitiş tarihi bilgisi sunulmadı.";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Sunucudan gelen bitiş tarihi okunamadı.";
    return `Bitiş: ${new Intl.DateTimeFormat("tr-TR", { dateStyle: "long", timeStyle: "short" }).format(date)}`;
  }

  async function refreshInstagramSessionStatus() {
    if (!licenseActive) {
      sessionAvailable = false;
      setInstagramSessionStatus("Lisans gerekli", "Önce lisansını etkinleştir.", "inactive");
      renderBusy();
      return;
    }
    if (sessionBusy) return;
    sessionBusy = true;
    renderBusy();
    try {
      const result = await sendMessage({ type: "INSTAGRAM_SESSION_STATUS" });
      if (!result || result.ok !== true) {
        if (/Instagram oturumu bulunamadı/i.test(String(result?.error || ""))) {
          sessionAvailable = false;
          setInstagramSessionStatus(
            "Instagram girişi bekleniyor",
            "Instagram’a giriş yaptıktan sonra oturum bilgisi işlemler sırasında tarayıcıdan okunur.",
            "inactive",
          );
          return;
        }
        throw new Error(typeof result?.error === "string" ? result.error : "Oturum durumu alınamadı.");
      }
      sessionAvailable = result.available === true;
      if (sessionAvailable) {
        setInstagramSessionStatus(
          "Tarayıcı oturumu hazır",
          `Hesap kimliği: ${result.instagramUserId || "bulunamadı"}. API oturumu saklamaz.`,
          "active",
        );
      } else {
        setInstagramSessionStatus(
          "Instagram girişi bekleniyor",
          "Instagram’a giriş yaptıktan sonra oturum bilgisi işlemler sırasında tarayıcıdan okunur.",
          "inactive",
        );
      }
    } catch (error) {
      sessionAvailable = false;
      setInstagramSessionStatus("Oturum durumu alınamadı", error?.message || "Lisans durumunu kontrol et.", "error");
    } finally {
      sessionBusy = false;
      renderBusy();
    }
  }

  async function refreshStatus(accountAlreadySynced = false) {
    if (statusBusy) return;
    statusBusy = true;
    renderBusy();
    setStatus("Durum kontrol ediliyor", "Lisans sunucusuna bağlanılıyor.", "loading");
    try {
      if (
        !accountAlreadySynced &&
        accountSession?.sessionToken &&
        Number(accountSession.sessionExpiresAt) > Date.now()
      ) {
        try {
          await syncAccountLicense(false);
        } catch (error) {
          setPurchaseFeedback(error?.message || "Hesap lisansı yenilenemedi.", "error");
        }
      }
      const result = await sendMessage({ type: "LICENSE_GET_STATUS", force: true });
      if (!result || typeof result !== "object") throw new Error("Lisans sunucusu geçerli bir yanıt vermedi.");
      const message = typeof result.message === "string" ? result.message : "";
      licenseActive = result.active === true;
      if (result.active === true) {
        trialExpiredNeedsPurchase = false;
        setStatus(
          result.licenseType === "trial" ? "7 günlük ücretsiz deneme etkin" : "Aylık lisans etkin",
          formatExpiry(result.expiresAt),
          "active",
        );
        renderTrialPurchaseLink();
      } else if (result.trialExpired === true) {
        trialExpiredNeedsPurchase = true;
        setStatus(
          "7 günlük ücretsiz deneme sona erdi",
          "Devam etmek için aylık lisansı Shopier'de hesabının e-posta adresiyle satın almalısın. Satın alım olmadan erişim açılmaz.",
          "inactive",
        );
        renderTrialPurchaseLink();
      } else {
        trialExpiredNeedsPurchase = false;
        setStatus("Etkin lisans bulunamadı", message || "Aylık satın alma sayfasından devam edebilirsin.", "inactive");
        renderTrialPurchaseLink();
      }
      await refreshInstagramSessionStatus();
    } catch (error) {
      licenseActive = false;
      setStatus("Lisans sunucusuna ulaşılamıyor", error?.message || "Bağlantı kurulamadı. Sunucunun çalıştığını ve ağ bağlantını kontrol edip yeniden dene.", "error");
      await refreshInstagramSessionStatus();
    } finally {
      statusBusy = false;
      renderBusy();
    }
  }

  function clearPlans() {
    while (elements.plansList.firstChild) elements.plansList.removeChild(elements.plansList.firstChild);
  }

  function safeCheckoutUrl(raw) {
    if (typeof raw !== "string" || !raw.trim()) return null;
    try {
      const url = new URL(raw);
      return url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  }

  function addPlan(plan) {
    const card = document.createElement("article");
    card.className = "plan-card";
    const details = document.createElement("div");
    const name = document.createElement("h3");
    name.className = "plan-name";
    name.textContent = typeof plan.name === "string" && plan.name.trim() ? plan.name : "Lisans paketi";
    const duration = document.createElement("p");
    duration.className = "plan-duration";
    duration.textContent = Number.isFinite(Number(plan.days)) && Number(plan.days) > 0 ? `${Number(plan.days)} günlük erişim` : "Süre bilgisi sunucuda yok";
    details.append(name, duration);
    const purchase = document.createElement("div");
    const price = document.createElement("p");
    price.className = "plan-price";
    price.textContent = typeof plan.priceLabel === "string" && plan.priceLabel.trim() ? plan.priceLabel : "Fiyat bilgisi sunucuda yok";
    purchase.append(price);
    const checkout = safeCheckoutUrl(plan.checkoutUrl);
    if (!accountSession?.sessionToken || Number(accountSession.sessionExpiresAt) <= Date.now()) {
      const login = document.createElement("button");
      login.className = "plan-link plan-login-link";
      login.type = "button";
      login.textContent = "Satın almak için giriş yap";
      login.addEventListener("click", openAccountPage);
      purchase.append(login);
    } else if (checkout) {
      const link = document.createElement("a");
      link.className = "plan-link";
      link.href = checkout;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Aylık satın al";
      link.addEventListener("click", event => {
        if (
          !accountSession?.sessionToken ||
          Number(accountSession.sessionExpiresAt) <= Date.now()
        ) {
          event.preventDefault();
          accountSession = null;
          renderAccountState();
          setPurchaseFeedback("Satın almaya devam etmek için hesabına yeniden giriş yap.", "error");
          openAccountPage();
        }
      });
      const arrow = document.createElement("span");
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "↗";
      link.append(arrow);
      purchase.append(link);
    } else {
      const unavailable = document.createElement("span");
      unavailable.className = "fine-print";
      unavailable.textContent = "Güvenli ödeme bağlantısı şu an sunulmuyor.";
      purchase.append(unavailable);
    }
    card.append(details, purchase);
    elements.plansList.append(card);
  }

  async function refreshPlans(requestPermission = false) {
    if (configBusy) return;
    configBusy = true;
    renderBusy();
    clearPlans();
    setPlansState("Paketler yükleniyor", "Güncel paket bilgileri sunucudan alınıyor.");
    try {
      const apiBaseUrl = getApiBaseUrl();
      await ensureServerPermission(apiBaseUrl, requestPermission);
      await saveUrl(apiBaseUrl);
      const result = await sendMessage({ type: "LICENSE_PUBLIC_CONFIG", apiBaseUrl });
      if (!result || typeof result !== "object" || result.ok !== true) {
        throw new Error(typeof result?.error === "string" ? result.error : "Paket bilgileri sunucudan alınamadı.");
      }
      const plans = Array.isArray(result.plans) ? result.plans : [];
      if (plans.length === 0) {
        setPlansState("Henüz paket yapılandırılmamış", "Paket seçenekleri lisans sunucusu tarafından henüz yayınlanmadı.");
        renderTrialPurchaseLink();
        return;
      }
      plans.forEach(addPlan);
      setPlansState("Güncel paketler", "Fiyat ve ödeme bağlantıları lisans sunucusundan alınır.");
      renderTrialPurchaseLink();
    } catch (error) {
      setPlansState("Paketlere şu an ulaşılamıyor", error?.message || "API sunucusunun çalıştığını kontrol edip tekrar deneyin.");
      renderTrialPurchaseLink();
    } finally {
      configBusy = false;
      renderBusy();
    }
  }

  elements.refreshStatus.addEventListener("click", async () => {
    try {
      await ensureServerPermission(getApiBaseUrl(), true);
    } catch (error) {
      setStatus("Sunucu izni gerekli", error?.message || "Sunucu erişim iznini verip yeniden dene.", "error");
      return;
    }
    await refreshStatus();
  });
  elements.refreshPlans.addEventListener("click", () => refreshPlans(true));
  elements.openAccountButton.addEventListener("click", openAccountPage);
  elements.checkPurchaseButton.addEventListener("click", checkPurchase);
  elements.sessionCheckButton.addEventListener("click", refreshInstagramSessionStatus);

  async function initialize() {
    if (!runtimeAvailable) {
      setStatus("Uzantı API'si kullanılamıyor", "Lisans işlemleri Chrome uzantısı içinde kullanılabilir; bu önizlemede sunucuya bağlanılamaz.", "error");
      setPlansState("Paketler yüklenemedi", "Chrome uzantı iletişim API'si bulunamadı. Uzantı panelini açıp yeniden deneyin.");
      renderAccountState();
      renderBusy();
      return;
    }
    const savedUrl = await readStoredUrl();
    accountSession = await readStoredAccount();
    const defaultUrl = typeof globalThis.__TAKIPCI_ENV__?.LICENSE_API_BASE_URL === "string"
      ? globalThis.__TAKIPCI_ENV__.LICENSE_API_BASE_URL
      : "";
    licenseApiBaseUrl = String(accountSession?.apiBaseUrl || savedUrl || defaultUrl).trim();
    renderAccountState();
    chrome.storage.onChanged?.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes.tpAccountState) return;
      accountSession = changes.tpAccountState.newValue &&
        typeof changes.tpAccountState.newValue === "object"
        ? changes.tpAccountState.newValue
        : null;
      if (accountSession?.apiBaseUrl) licenseApiBaseUrl = accountSession.apiBaseUrl;
      renderAccountState();
      void refreshPlans(false);
    });
    await Promise.all([refreshStatus(), refreshPlans()]);
  }

  initialize();
})();
