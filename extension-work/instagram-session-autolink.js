"use strict";

(() => {
  const statusElement = document.getElementById("instagram-session-sync-status");
  if (!statusElement || !globalThis.chrome?.runtime?.sendMessage) return;

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message || "Uzantı arka planına ulaşılamadı."));
        else resolve(response);
      });
    });
  }

  function showStatus(message, kind, showLicenseLink = false) {
    statusElement.replaceChildren(document.createTextNode(message));
    statusElement.dataset.kind = kind;
    statusElement.hidden = false;
    if (showLicenseLink) {
      const link = document.createElement("a");
      link.href = chrome.runtime.getURL("license.html");
      link.textContent = "Lisans ayarlarını aç";
      statusElement.append(link);
    }
  }

  async function syncInstagramSession() {
    let licenseStatus;
    try {
      licenseStatus = await sendMessage({ type: "LICENSE_GET_STATUS" });
    } catch {
      return;
    }
    if (licenseStatus?.active !== true) return;

    try {
      const result = await sendMessage({ type: "INSTAGRAM_SESSION_AUTO_LINK" });
      if (result?.linked === true) {
        showStatus("Instagram oturumu lisans sunucusuna gönderildi.", "success");
        window.setTimeout(() => {
          statusElement.hidden = true;
        }, 6000);
        return;
      }
      if (result?.reason === "user-unlinked") {
        showStatus(
          "Otomatik bağlantı kapalı. Yeniden bağlamak için lisans ayarlarını açın.",
          "error",
          true,
        );
        return;
      }
      const message = String(
        result?.error || "Instagram oturumu sunucuya bağlanamadı.",
      );
      showStatus(
        `${message} Oturum bilgileri okunamadıysa API'ye gönderilmemiş olabilir.`,
        "error",
        true,
      );
    } catch (error) {
      showStatus(
        `${error?.message || "Instagram oturumu sunucuya bağlanamadı."} Lisans ayarlarını kontrol edin.`,
        "error",
        true,
      );
    }
  }

  void syncInstagramSession();
})();
