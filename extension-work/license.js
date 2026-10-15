(() => {
  "use strict";

  const runtimeAvailable = Boolean(globalThis.chrome?.runtime?.sendMessage);
  const storageAvailable = Boolean(globalThis.chrome?.storage?.local);
  const elements = {
    orderId: document.getElementById("order-id"),
    email: document.getElementById("purchase-email"),
    activationForm: document.getElementById("activation-form"),
    activateButton: document.getElementById("activate-button"),
    activationFeedback: document.getElementById("activation-feedback"),
    refreshStatus: document.getElementById("refresh-status"),
    logoutButton: document.getElementById("logout-button"),
    statusPanel: document.getElementById("license-status"),
    statusLabel: document.getElementById("status-label"),
    statusDetail: document.getElementById("status-detail"),
    sessionPanel: document.getElementById("instagram-session-status"),
    sessionLabel: document.getElementById("instagram-session-label"),
    sessionDetail: document.getElementById("instagram-session-detail"),
    sessionConsent: document.getElementById("instagram-session-consent"),
    sessionLinkButton: document.getElementById("instagram-session-link"),
    sessionUnlinkButton: document.getElementById("instagram-session-unlink"),
    sessionFeedback: document.getElementById("instagram-session-feedback"),
    refreshPlans: document.getElementById("refresh-plans"),
    plansState: document.getElementById("plans-state"),
    plansTitle: document.getElementById("plans-state-title"),
    plansDetail: document.getElementById("plans-state-detail"),
    plansList: document.getElementById("plans-list"),
  };

  let statusBusy = false;
  let configBusy = false;
  let activationBusy = false;
  let logoutBusy = false;
  let sessionBusy = false;
  let licenseActive = false;
  let sessionLinked = false;
  let licenseApiBaseUrl = "";

  function setStatus(label, detail, state = "loading") {
    elements.statusLabel.textContent = label;
    elements.statusDetail.textContent = detail;
    elements.statusPanel.dataset.state = state;
  }

  function setPlansState(title, detail) {
    elements.plansTitle.textContent = title;
    elements.plansDetail.textContent = detail;
  }

  function setFeedback(message, kind = "error") {
    elements.activationFeedback.textContent = message;
    if (message) elements.activationFeedback.dataset.kind = kind;
    else delete elements.activationFeedback.dataset.kind;
  }

  function setInstagramSessionStatus(label, detail, state = "loading") {
    elements.sessionLabel.textContent = label;
    elements.sessionDetail.textContent = detail;
    elements.sessionPanel.dataset.state = state;
  }

  function setInstagramSessionFeedback(message, kind = "error") {
    elements.sessionFeedback.textContent = message;
    if (message) elements.sessionFeedback.dataset.kind = kind;
    else delete elements.sessionFeedback.dataset.kind;
  }

  function renderBusy() {
    elements.refreshStatus.disabled = statusBusy || !runtimeAvailable;
    elements.refreshPlans.disabled = configBusy || !runtimeAvailable;
    elements.activateButton.disabled = activationBusy || !runtimeAvailable;
    elements.logoutButton.disabled = logoutBusy || statusBusy || !runtimeAvailable;
    elements.sessionLinkButton.disabled =
      sessionBusy || !runtimeAvailable || !licenseActive ||
      !elements.sessionConsent.checked || sessionLinked;
    elements.sessionUnlinkButton.disabled =
      sessionBusy || !runtimeAvailable || !licenseActive || !sessionLinked;
    elements.refreshStatus.setAttribute("aria-busy", String(statusBusy));
    elements.refreshPlans.setAttribute("aria-busy", String(configBusy));
    elements.activateButton.setAttribute("aria-busy", String(activationBusy));
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
      sessionLinked = false;
      setInstagramSessionStatus("Lisans gerekli", "Önce lisansını etkinleştir.", "inactive");
      renderBusy();
      return;
    }
    try {
      const result = await sendMessage({ type: "INSTAGRAM_SESSION_STATUS" });
      if (!result || result.ok !== true) {
        throw new Error(typeof result?.error === "string" ? result.error : "Oturum durumu alınamadı.");
      }
      sessionLinked = result.linked === true;
      if (sessionLinked) {
        setInstagramSessionStatus(
          "Instagram oturumu bağlı",
          `Hesap kimliği: ${result.instagramUserId || "sunucuda kayıtlı"}. Oturum, isteklerle güncel tutulur.`,
          "active",
        );
      } else {
        setInstagramSessionStatus("Instagram oturumu bağlı değil", "Instagram’da giriş yaptıktan sonra aşağıdaki onayla bağla.", "inactive");
      }
    } catch (error) {
      sessionLinked = false;
      setInstagramSessionStatus("Oturum durumu alınamadı", error?.message || "Sunucu bağlantısını kontrol et.", "error");
    } finally {
      renderBusy();
    }
  }

  async function linkInstagramSession() {
    if (sessionBusy || !elements.sessionConsent.checked) return;
    sessionBusy = true;
    setInstagramSessionFeedback("");
    setInstagramSessionStatus("Oturum bağlanıyor", "Güncel oturum bilgileri güvenli bağlantıyla sunucuya gönderiliyor.", "loading");
    renderBusy();
    try {
      const apiBaseUrl = getApiBaseUrl();
      await ensureServerPermission(apiBaseUrl, true);
      await saveUrl(apiBaseUrl);
      const result = await sendMessage({ type: "INSTAGRAM_SESSION_LINK" });
      if (!result || result.ok !== true || result.linked !== true) {
        throw new Error(typeof result?.error === "string" ? result.error : "Instagram oturumu bağlanamadı.");
      }
      sessionLinked = true;
      elements.sessionConsent.checked = false;
      setInstagramSessionFeedback("Onay kaydedildi; oturum sunucuya bağlandı.", "success");
      setInstagramSessionStatus(
        "Instagram oturumu bağlı",
        `Hesap kimliği: ${result.instagramUserId || "sunucuda kayıtlı"}. Güncel oturum eklentiden düzenli aktarılır.`,
        "active",
      );
    } catch (error) {
      sessionLinked = false;
      setInstagramSessionStatus("Oturum bağlanamadı", error?.message || "Instagram oturumunu ve API bağlantısını kontrol et.", "error");
      setInstagramSessionFeedback(error?.message || "Instagram oturumu bağlanamadı.");
    } finally {
      sessionBusy = false;
      renderBusy();
    }
  }

  async function unlinkInstagramSession() {
    if (sessionBusy || !sessionLinked) return;
    if (!globalThis.confirm("Sunucuda şifreli saklanan Instagram oturumu silinsin mi?")) return;
    sessionBusy = true;
    setInstagramSessionFeedback("");
    renderBusy();
    try {
      const result = await sendMessage({ type: "INSTAGRAM_SESSION_UNLINK" });
      if (!result || result.ok !== true) {
        throw new Error(typeof result?.error === "string" ? result.error : "Instagram oturumu kaldırılamadı.");
      }
      sessionLinked = false;
      setInstagramSessionStatus("Instagram oturumu kaldırıldı", "Sunucudaki oturum kopyası silindi; takip/beğeni işlemleri durur.", "inactive");
      setInstagramSessionFeedback("Sunucudaki Instagram oturumu silindi.", "success");
    } catch (error) {
      setInstagramSessionStatus("Oturum kaldırılamadı", error?.message || "Sunucu bağlantısını kontrol et.", "error");
      setInstagramSessionFeedback(error?.message || "Instagram oturumu kaldırılamadı.");
    } finally {
      sessionBusy = false;
      renderBusy();
    }
  }

  async function refreshStatus() {
    if (statusBusy) return;
    statusBusy = true;
    renderBusy();
    setStatus("Durum kontrol ediliyor", "Lisans sunucusuna bağlanılıyor.", "loading");
    try {
      const result = await sendMessage({ type: "LICENSE_GET_STATUS", force: true });
      if (!result || typeof result !== "object") throw new Error("Lisans sunucusu geçerli bir yanıt vermedi.");
      const message = typeof result.message === "string" ? result.message : "";
      licenseActive = result.active === true;
      if (result.active === true) {
        setStatus("Lisans etkin", formatExpiry(result.expiresAt), "active");
      } else {
        setStatus("Etkin lisans bulunamadı", message || "Satın alma bilgilerinle lisansını etkinleştirebilirsin.", "inactive");
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
    if (checkout) {
      const link = document.createElement("a");
      link.className = "plan-link";
      link.href = checkout;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Shopier'de devam et";
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
        return;
      }
      plans.forEach(addPlan);
      setPlansState("Güncel paketler", "Fiyat ve ödeme bağlantıları lisans sunucusundan alınır.");
    } catch (error) {
      setPlansState("Paketlere şu an ulaşılamıyor", error?.message || "API sunucusunun çalıştığını kontrol edip tekrar deneyin.");
    } finally {
      configBusy = false;
      renderBusy();
    }
  }

  async function handleActivation(event) {
    event.preventDefault();
    if (activationBusy) return;
    setFeedback("");
    const orderId = elements.orderId.value.trim();
    const email = elements.email.value.trim();
    let apiBaseUrl;
    try {
      apiBaseUrl = getApiBaseUrl();
      if (!orderId) throw new Error("Shopier sipariş numaranı gir.");
      if (!elements.email.checkValidity()) throw new Error("Geçerli bir satın alma e-postası gir.");
      await ensureServerPermission(apiBaseUrl, true);
    } catch (error) {
      setFeedback(error.message);
      return;
    }
    activationBusy = true;
    renderBusy();
    elements.activateButton.querySelector("span").textContent = "Doğrulanıyor";
    try {
      await saveUrl(apiBaseUrl);
      const result = await sendMessage({
        type: "LICENSE_ACTIVATE",
        apiBaseUrl,
        orderId,
        email,
      });
      if (!result || typeof result !== "object" || result.ok !== true || result.active !== true) {
        throw new Error(typeof result?.error === "string" ? result.error : "Sipariş doğrulanamadı. Bilgilerini kontrol edip tekrar dene.");
      }
      setFeedback("Lisansın başarıyla etkinleştirildi.", "success");
      elements.orderId.value = "";
      elements.email.value = "";
      licenseActive = true;
      setStatus("Lisans etkin", formatExpiry(result.expiresAt), "active");
      await refreshInstagramSessionStatus();
    } catch (error) {
      const message = error?.message || "Lisans sunucusuna ulaşılamadı. Biraz sonra tekrar dene.";
      setFeedback(message);
      setStatus("Etkinleştirme tamamlanmadı", message, "error");
    } finally {
      activationBusy = false;
      elements.activateButton.querySelector("span").textContent = "Bilgileri doğrula";
      renderBusy();
    }
  }

  async function logout() {
    if (logoutBusy) return;
    logoutBusy = true;
    renderBusy();
    try {
      const result = await sendMessage({ type: "LICENSE_LOGOUT" });
      if (!result || result.ok !== true) throw new Error(typeof result?.error === "string" ? result.error : "Lisans oturumu kapatılamadı.");
      setStatus("Lisans oturumu kapatıldı", "Bu uzantıda lisans doğrulaması kaldırıldı.", "inactive");
      await refreshStatus();
    } catch (error) {
      setStatus("Oturum kapatılamadı", error?.message || "Lisans sunucusuna ulaşılamadı.", "error");
    } finally {
      logoutBusy = false;
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
  elements.activationForm.addEventListener("submit", handleActivation);
  elements.logoutButton.addEventListener("click", logout);
  elements.sessionConsent.addEventListener("change", renderBusy);
  elements.sessionLinkButton.addEventListener("click", linkInstagramSession);
  elements.sessionUnlinkButton.addEventListener("click", unlinkInstagramSession);

  async function initialize() {
    if (!runtimeAvailable) {
      setStatus("Uzantı API'si kullanılamıyor", "Lisans işlemleri Chrome uzantısı içinde kullanılabilir; bu önizlemede sunucuya bağlanılamaz.", "error");
      setPlansState("Paketler yüklenemedi", "Chrome uzantı iletişim API'si bulunamadı. Uzantı panelini açıp yeniden deneyin.");
      renderBusy();
      return;
    }
    const savedUrl = await readStoredUrl();
    const defaultUrl = typeof globalThis.__TAKIPCI_ENV__?.LICENSE_API_BASE_URL === "string"
      ? globalThis.__TAKIPCI_ENV__.LICENSE_API_BASE_URL
      : "";
    licenseApiBaseUrl = String(defaultUrl || savedUrl).trim();
    await Promise.all([refreshStatus(), refreshPlans()]);
  }

  initialize();
})();
