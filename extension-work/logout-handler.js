// logout-handler.js — Uzantı verilerini temizleme düğmeleri
(function () {
  'use strict';

  function clearExtensionData(button) {
    if (button?.dataset.busy === '1') return;
    if (button) {
      button.dataset.busy = '1';
      button.disabled = true;
    }

    chrome.runtime.sendMessage({ type: 'CLEAR_EXTENSION_DATA' }, res => {
      if (button) {
        button.dataset.busy = '0';
        button.disabled = false;
      }
      if (!res?.ok) {
        console.error('[Takipçi Paneli] Uzantı verileri temizlenemedi:', res?.error || 'bilinmiyor');
      }
    });
  }

  function makeButton(id, label, title) {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.className = 'dov-refresh';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.textContent = label;
    button.addEventListener('click', () => clearExtensionData(button));
    return button;
  }

  function styleHeaderButton(button) {
    button.className = 'dov-refresh';
    button.style.cssText = `
      margin-left: 8px;
      width: auto;
      min-width: 64px;
      height: 28px;
      padding: 0 8px;
      flex-shrink: 0;
      border-color: rgba(255,255,255,0.12);
      background: rgba(20,20,28,0.9);
      color: #f87171;
    `;
  }

  function addHeaderButton() {
    const header = document.querySelector('.dov-header');
    if (!header) return;

    const existingHeaderButton = document.getElementById('dov-logout-btn');
    const floatingButton = document.getElementById('floating-logout-btn');
    if (!floatingButton && existingHeaderButton?.parentElement === header) {
      if (existingHeaderButton.textContent !== 'Temizle') {
        existingHeaderButton.textContent = 'Temizle';
      }
      if (existingHeaderButton.title !== 'Uzantının yerel verilerini temizle') {
        existingHeaderButton.title = 'Uzantının yerel verilerini temizle';
        existingHeaderButton.setAttribute('aria-label', existingHeaderButton.title);
      }
      styleHeaderButton(existingHeaderButton);
      return;
    }

    existingHeaderButton?.remove();
    const button = floatingButton || makeButton(
      'dov-logout-btn',
      'Temizle',
      'Uzantının yerel verilerini temizle',
    );
    button.id = 'dov-logout-btn';
    button.removeAttribute('style');
    button.textContent = 'Temizle';
    button.title = 'Uzantının yerel verilerini temizle';
    button.setAttribute('aria-label', button.title);
    styleHeaderButton(button);
    const refreshButton = document.getElementById('dovRefreshBtn');
    if (refreshButton && refreshButton.parentElement === header) {
      header.insertBefore(button, refreshButton);
    } else {
      header.appendChild(button);
    }
  }

  function init() {
    addHeaderButton();
    document.getElementById('floating-logout-btn')?.remove();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  const observer = new MutationObserver(init);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();