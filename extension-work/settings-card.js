// settings-card.js — Keşif ve otomasyon içerik türü ayarları
//
// İki farklı sayfada yaşayabilir:
//   1) DOM'da #dov-s-slot varsa → içine otomatik enjekte (popup.html için)
//   2) React-rendered "AYARLAR" başlığı varsa → ondan hemen sonra enjekte
//      (panel.html'nin React AYARLAR sayfası için)
// Hiçbiri yoksa sessizce bekler, hata vermez.

'use strict';

(function () {
  const DOV_S_STYLE = `
.dov-s-card { display:block; width:100%; box-sizing:border-box; margin:0 0 14px; padding:14px; background:rgba(10,10,18,.72); border:1px solid rgba(255,255,255,.08); border-radius:12px; }
.dov-s-dash-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; }
.dov-s-dashboard { min-width:0; padding:13px; background:linear-gradient(145deg,rgba(255,255,255,.045),rgba(255,255,255,.015)); border:1px solid rgba(255,255,255,.08); border-radius:12px; }
.dov-s-dashboard .dov-s-head { min-height:28px; }
.dov-s-head { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
.dov-s-title { font-size:12px; font-weight:700; color:#f0f0f8; letter-spacing:-0.2px; }
.dov-s-sub { font-size:9px; font-family:monospace; color:#6b7280; text-transform:uppercase; letter-spacing:1px; }
.dov-s-row { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
.dov-s-tog { min-width:0; padding:12px 6px; background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.06); border-radius:10px; cursor:pointer; text-align:center; transition:.15s; font-family:monospace; user-select:none; }
.dov-s-tog:hover { border-color:rgba(131,52,180,.5); }
.dov-s-tog.active { background:linear-gradient(135deg,#833ab4,#fd1d1d); color:#fff; border-color:transparent; box-shadow:0 4px 14px rgba(131,52,180,.25); }
.dov-s-tog-icon { font-size:22px; line-height:1; }
.dov-s-tog-lbl { font-size:10px; font-weight:700; margin-top:6px; text-transform:uppercase; letter-spacing:1px; }
.dov-s-tog-sub { font-size:8px; opacity:.65; margin-top:3px; }
@media (max-width:760px) { .dov-s-dash-grid { grid-template-columns:1fr; } }
@media (max-width:560px) { .dov-s-row { grid-template-columns:repeat(2,minmax(0,1fr)); } }
.dov-s-save { width:100%; margin-top:12px; padding:9px; font-size:11px; font-weight:700; letter-spacing:.5px; background:linear-gradient(135deg,#833ab4,#fd1d1d); color:#fff; border:none; border-radius:7px; cursor:pointer; transition:.15s; font-family:monospace; }
.dov-s-save:hover { opacity:.92; }
.dov-s-save:active { transform:scale(.98); }
.dov-s-save:disabled { opacity:.5; cursor:not-allowed; }
.dov-s-reset { display:none; width:100%; margin-top:7px; padding:7px; font-size:9px; font-weight:700; letter-spacing:.3px; background:transparent; color:#c4b5fd; border:1px solid rgba(196,181,253,.25); border-radius:7px; cursor:pointer; font-family:monospace; }
.dov-s-reset:hover { background:rgba(196,181,253,.08); }
.dov-s-status { margin-top:8px; font-size:10px; font-family:monospace; color:#6b7280; min-height:14px; }
.dov-s-status.ok  { color:#4ade80; }
.dov-s-status.err { color:#fb7185; }
.dov-s-section-title { margin:10px 12px 4px; font-family:monospace; font-size:9px; color:#c084fc; text-transform:uppercase; letter-spacing:1.4px; font-weight:700; }
.dov-s-field { display:block; margin:9px 0; color:#9ca3af; font-size:10px; font-family:monospace; }
.dov-s-field input { display:block; width:100%; box-sizing:border-box; margin-top:5px; padding:9px 10px; border:1px solid rgba(255,255,255,.1); border-radius:8px; background:#11111a; color:#f8fafc; font:11px monospace; outline:none; }
.dov-s-field input:focus { border-color:rgba(192,132,252,.7); box-shadow:0 0 0 2px rgba(131,58,180,.15); }
.dov-s-discovery-dashboard { background:linear-gradient(145deg,rgba(131,58,180,.13),rgba(253,29,29,.04)); border-color:rgba(192,132,252,.2); }
.dov-s-discovery-row { display:flex; align-items:center; gap:10px; margin-bottom:4px; }
.dov-s-discovery-toggle { position:relative; width:42px; height:23px; flex:none; padding:0; border:1px solid rgba(255,255,255,.1); border-radius:999px; background:rgba(255,255,255,.06); cursor:pointer; transition:.18s; }
.dov-s-discovery-toggle span { position:absolute; top:3px; left:3px; width:15px; height:15px; border-radius:50%; background:#fff; box-shadow:0 2px 5px rgba(0,0,0,.3); transition:.18s; }
.dov-s-discovery-toggle.active { background:linear-gradient(135deg,#833ab4,#fd1d1d); border-color:transparent; box-shadow:0 3px 12px rgba(131,58,180,.25); }
.dov-s-discovery-toggle.active span { transform:translateX(19px); }
.dov-s-discovery-state { color:#f0f0f8; font:11px/1.35 monospace; font-weight:700; }
.dov-s-discovery-state small { display:block; color:#6b7280; font-size:9px; font-weight:400; margin-top:2px; }
.dov-s-system-row { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; padding:9px 10px; border:1px solid rgba(255,255,255,.08); border-radius:9px; background:rgba(255,255,255,.025); }
.dov-s-system-label { color:#d1d5db; font:10px monospace; }
.dov-s-system-label small { display:block; margin-top:3px; color:#6b7280; font-size:9px; }
.dov-s-system-toggle { position:relative; width:48px; height:24px; flex:none; padding:0; border:1px solid rgba(255,255,255,.1); border-radius:999px; background:rgba(255,255,255,.06); cursor:pointer; transition:.18s; }
.dov-s-system-toggle span { position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 2px 5px rgba(0,0,0,.3); transition:.18s; }
.dov-s-system-toggle.active { background:linear-gradient(135deg,#22c55e,#16a34a); border-color:transparent; box-shadow:0 3px 12px rgba(34,197,94,.25); }
.dov-s-system-toggle.active span { transform:translateX(24px); }
.dov-s-system-toggle:disabled { opacity:.55; cursor:wait; }
.dov-s-discovery-help { color:#6b7280; font:10px/1.45 monospace; margin:4px 0 0; }
.dov-s-discovery-last-action { display:none; margin-top:8px; padding:8px 10px; border-left:2px solid rgba(192,132,252,.7); border-radius:0 7px 7px 0; background:rgba(255,255,255,.035); color:#9ca3af; font:10px/1.4 monospace; }
.dov-s-discovery-last-action.rate-limit { color:#fca5a5; border-left-color:#fb7185; background:rgba(244,63,94,.08); }
.dov-s-discovery-relation { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:9px 0; }
.dov-s-discovery-relation label { display:flex; align-items:center; gap:7px; padding:9px 10px; color:#d1d5db; font:10px monospace; background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.08); border-radius:8px; cursor:pointer; }
.dov-s-discovery-relation label:has(input:checked) { color:#fff; background:rgba(131,58,180,.22); border-color:rgba(192,132,252,.55); }
.dov-s-discovery-relation input { accent-color:#c084fc; }
.dov-s-gender-target { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin:9px 0; }
.dov-s-gender-target label { display:flex; align-items:center; justify-content:center; gap:6px; padding:9px 7px; color:#d1d5db; font:10px monospace; text-align:center; background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.08); border-radius:8px; cursor:pointer; }
.dov-s-gender-target label:has(input:checked) { color:#fff; background:rgba(131,58,180,.22); border-color:rgba(192,132,252,.55); }
.dov-s-gender-target input { accent-color:#c084fc; }
@media (max-width:560px) { .dov-s-gender-target { grid-template-columns:1fr; } }
`;

  function ensureStyles() {
    if (document.getElementById('dov-s-style')) return;
    const s = document.createElement('style');
    s.id = 'dov-s-style';
    s.textContent = DOV_S_STYLE;
    document.head.appendChild(s);
  }

  function dovInjectSettingsCard(targetEl) {
    const target = targetEl || document.getElementById('dov-s-slot') || document.body;
    if (!target) return;
    if (document.getElementById('dov-s-card')) return;
    ensureStyles();

    const TYPES_META = [
      { key: 'story', icon: '📖', label: 'Hikaye',  sub: '24 saat' },
      { key: 'post',  icon: '📸', label: 'Gönderi', sub: 'kalıcı' },
      { key: 'reel',  icon: '🎬', label: 'Reels',   sub: 'kısa' },
      { key: 'all',   icon: '✦',  label: 'Hepsini Beğen', sub: 'tüm içerikler' },
    ];
    const LABELS = { story: 'Hikâye', post: 'Gönderi', reel: 'Reels' };

    const card = document.createElement('div');
    card.className = 'dov-s-card';
    card.id = 'dov-s-card';
    card.innerHTML = `
      <div class="dov-s-dash-grid">
        <section class="dov-s-dashboard dov-s-discovery-dashboard">
          <div class="dov-s-discovery-row">
            <div class="dov-s-discovery-state" id="dov-s-discovery-state">
              <span id="dov-s-discovery-label">Manuel hesap taraması</span>
                <small>Hedef hesabın takipçileri girilen minimum ortak hesap sayısına göre kontrol edilir.</small>
            </div>
          </div>
          <label class="dov-s-field">Hedef hesap kullanıcı adı
            <input id="dov-s-discovery-username" type="text" autocomplete="off" placeholder="@kullanici_adi">
          </label>
          <div class="dov-s-discovery-help" id="dov-s-discovery-help">
             Beğeni sistemi kapalıysa hedef hesabın takipçileri, girilen minimum ortak hesap sayısına göre taranır. Beğeni sistemi açıksa kaynak beğeni atılan hesaba geçer ve aynı sayı kullanılır.
          </div>
           <label class="dov-s-field">Minimum ortak hesap sayısı
             <input id="dov-s-mutual-min" type="number" min="0" max="10000" step="1" value="2" inputmode="numeric" aria-label="Minimum ortak hesap sayısı" aria-describedby="dov-s-mutual-state dov-s-mutual-help">
             <small id="dov-s-mutual-state">0 girilirse ortak hesap filtresi uygulanmaz.</small>
           </label>
           <p class="dov-s-discovery-help" id="dov-s-mutual-help">En az girilen sayıda ortak hesabı olan adaylar aranır. 0 girersen ortak hesap filtresi kapatılır.</p>
          <div class="dov-s-system-row">
            <div class="dov-s-system-label">
              Takip isteği sistemi
              <small>Uygun kadın adaylara otomatik takip isteği gönderir</small>
            </div>
            <button type="button" class="dov-s-system-toggle" id="dov-s-discovery-toggle" role="switch" aria-checked="false" aria-label="Takip isteği sistemini aç veya kapat"><span></span></button>
          </div>
          <div class="dov-s-system-row">
            <div class="dov-s-system-label">
              Tarama bitince rastgele kaynağa geç
              <small>Açıkken takip ettiklerinden yeni hesap seçilir; kapalıyken mevcut kaynakta durur</small>
            </div>
            <button type="button" class="dov-s-system-toggle active" id="dov-s-source-rotation-toggle" role="switch" aria-checked="true" aria-label="Tarama bitince rastgele yeni kaynağa geç"><span></span></button>
          </div>
           <p class="dov-s-discovery-help">Hedef kullanıcı adını yazıp bu anahtarı aç. Beğeni sistemiyle birlikte açıldığında kaynak otomatik olarak beğeni atılan hesaba geçer.</p>
          <button class="dov-s-reset" id="dov-s-discovery-reset" type="button">Yerel cooldown'u temizle ve tekrar dene</button>
          <div class="dov-s-status" id="dov-s-discovery-status"></div>
          <div class="dov-s-discovery-last-action" id="dov-s-discovery-last-action"></div>
        </section>
        <section class="dov-s-dashboard">
          <div class="dov-s-head">
            <div class="dov-s-title">⚙ Beğeni otomasyonu</div>
            <div class="dov-s-sub" style="margin-left:auto">Otomasyon</div>
          </div>
          <div class="dov-s-system-row">
            <div class="dov-s-system-label">
               Beğeni sistemi
               <small id="dov-s-system-state">Kapalı — beğeni otomasyonu çalışmaz</small>
            </div>
            <button type="button" class="dov-s-system-toggle" id="dov-s-system-toggle" role="switch" aria-checked="false" aria-label="Beğeni sistemini aç veya kapat"><span></span></button>
          </div>
          <div class="dov-s-row">
            ${TYPES_META.map(t => `
              <div class="dov-s-tog" data-type="${t.key}">
                <div class="dov-s-tog-icon">${t.icon}</div>
                <div class="dov-s-tog-lbl">${t.label}</div>
                <div class="dov-s-tog-sub">${t.sub}</div>
              </div>
            `).join('')}
          </div>
          <button class="dov-s-save" id="dov-s-save">Kaydet</button>
          <div class="dov-s-status" id="dov-s-status">Mevcut ayar yükleniyor…</div>
        </section>
      </div>
    `;
    target.appendChild(card);

    const toggles = card.querySelectorAll('.dov-s-tog');
    const saveBtn = card.querySelector('#dov-s-save');
    const status  = card.querySelector('#dov-s-status');
    const discoveryStateEl = card.querySelector('#dov-s-discovery-state');
    const discoveryLabel = card.querySelector('#dov-s-discovery-label');
    const discoveryUsernameInput = card.querySelector('#dov-s-discovery-username');
    const discoveryResetBtn = card.querySelector('#dov-s-discovery-reset');
    const discoveryAutoFollow = card.querySelector('#dov-s-discovery-toggle');
    const mutualFilterInput = card.querySelector('#dov-s-mutual-min');
    const mutualFilterState = card.querySelector('#dov-s-mutual-state');
    const mutualFilterHelp = card.querySelector('#dov-s-mutual-help');
    const discoveryHelp = card.querySelector('#dov-s-discovery-help');
    const discoveryStatus = card.querySelector('#dov-s-discovery-status');
    const discoveryLastAction = card.querySelector('#dov-s-discovery-last-action');
    const systemToggle = card.querySelector('#dov-s-system-toggle');
    const systemState = card.querySelector('#dov-s-system-state');
    const sourceRotationToggle = card.querySelector('#dov-s-source-rotation-toggle');
    const selected = new Set(['story', 'post', 'reel']);
    let discoverySourceId = '';
    // Background keşif turları igAutoState'i sık sık günceller. Kullanıcı
    // hedef kullanıcı adını yazarken bu canlı güncellemenin input'u eski
    // değerle ezmesine izin verme.
    let discoveryUsernameDirty = false;
    let systemEnabled = false;
    let discoveryRotateSources = true;
    let discoveryMinMutualCount = 2;
    let discoveryMutualDirty = false;

    function normalizeMutualCount(value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return null;
      return Math.max(0, Math.min(10000, Math.floor(parsed)));
    }

    function storedMutualThreshold(state) {
      if (state?.discoveryMinMutualCount !== undefined
        && state?.discoveryMinMutualCount !== null
        && state?.discoveryMinMutualCount !== '') {
        return normalizeMutualCount(state.discoveryMinMutualCount) ?? 2;
      }
      return state?.discoveryRequireMutuals === false ? 0 : 2;
    }

    function currentMutualThreshold() {
      const value = mutualFilterInput?.value ?? '';
      const parsed = normalizeMutualCount(value);
      return value.trim() !== '' && parsed !== null && Number(value) === parsed
        ? parsed
        : discoveryMinMutualCount;
    }

    function isDiscoveryEnabled() {
      return discoveryAutoFollow?.getAttribute('aria-checked') === 'true';
    }

    function renderDiscoveryToggle(enabled) {
      if (!discoveryAutoFollow) return;
      const active = enabled === true;
      discoveryAutoFollow.classList.toggle('active', active);
      discoveryAutoFollow.setAttribute('aria-checked', String(active));
    }

    function renderSourceRotationToggle(enabled) {
      discoveryRotateSources = enabled !== false;
      if (!sourceRotationToggle) return;
      sourceRotationToggle.classList.toggle('active', discoveryRotateSources);
      sourceRotationToggle.setAttribute('aria-checked', String(discoveryRotateSources));
    }

    function renderMutualThreshold(value) {
      discoveryMinMutualCount = normalizeMutualCount(value) ?? 2;
      if (mutualFilterInput) mutualFilterInput.value = String(discoveryMinMutualCount);
      if (mutualFilterState) {
        mutualFilterState.textContent = discoveryMinMutualCount === 0
          ? 'Ortak hesap koşulu yok'
          : `Adayda en az ${discoveryMinMutualCount} ortak hesap aranır`;
      }
      if (mutualFilterHelp) {
        mutualFilterHelp.textContent = discoveryMinMutualCount === 0
          ? 'Ortak hesap şartı uygulanmaz. Bu ayar manuel ve otomatik taramaları etkiler.'
          : `Manuel ve otomatik taramalarda en az ${discoveryMinMutualCount} ortak hesabı olmayan adaylar elenir.`;
      }
      if (discoveryHelp) {
        const mutualCondition = discoveryMinMutualCount === 0
          ? 'ortak hesap sayısı şartı aranmadan'
          : `en az ${discoveryMinMutualCount} ortak hesabı olan`;
        discoveryHelp.textContent = `Beğeni sistemi kapalıysa bu hedef hesabın takipçileri taranır; ${mutualCondition} kadın adaylar değerlendirilir ve takip isteği gönderilir. Beğeni sistemi açıksa kaynak beğeni atılan hesaba geçer ve aynı minimum sayı uygulanır.`;
      }
    }

    function renderSelection() {
      const order = ['story', 'post', 'reel'].filter(k => selected.has(k));
      return order.map(k => LABELS[k]).join(' + ') || '(hiçbiri)';
    }

    function setAllToggleState() {
      const allToggle = card.querySelector('[data-type="all"]');
      if (allToggle) {
        allToggle.classList.toggle('active', selected.size === 3);
      }
    }

    function renderDiscoveryState() {
      discoveryLabel.textContent = isDiscoveryEnabled()
        ? (systemEnabled ? 'Beğeni sonrası ortak hesap akışı hazır' : 'Ortak hesap kontrolü hazır')
        : 'Manuel hesap taraması';
      discoveryStateEl.querySelector('small').textContent =
        isDiscoveryEnabled()
          ? (systemEnabled
            ? (discoveryMinMutualCount > 0
              ? `Beğeni atılan hesabın takip ettikleri taranır; en az ${discoveryMinMutualCount} ortak hesabı olan kadın adaya istek gönderilir.`
              : 'Beğeni atılan hesabın takip ettikleri taranır; ortak hesap şartı olmadan kadın adaya istek gönderilir.')
            : (discoveryMinMutualCount > 0
              ? `En az ${discoveryMinMutualCount} ortak hesabı olan kadın adaya otomatik takip isteği gönderilir.`
              : 'Ortak hesap şartı aranmadan uygun kadın adaylara otomatik istek gönderilir.'))
          : 'Takip sistemi kapalı; kullanıcı adı girildiğinde hazır bekler.';
    }

    function renderSystemState(enabled) {
      systemEnabled = enabled === true;
      if (!systemToggle || !systemState) return;
      systemToggle.classList.toggle('active', systemEnabled);
      systemToggle.setAttribute('aria-checked', String(systemEnabled));
       systemState.textContent = systemEnabled
         ? 'Açık — beğeni otomasyonu çalışabilir'
         : 'Kapalı — beğeni otomasyonu çalışmaz';
    }

    function renderLastAction(state) {
      if (!discoveryLastAction) return;
      const label = String(state?.lastActionLabel || '').trim();
      if (!label) {
        discoveryLastAction.style.display = 'none';
        discoveryLastAction.textContent = '';
        return;
      }
      const rateLimit = /Instagram istek sınırı|rate-limit|429/i.test(label);
      discoveryLastAction.style.display = 'block';
      discoveryLastAction.className = `dov-s-discovery-last-action${rateLimit ? ' rate-limit' : ''}`;
      discoveryLastAction.textContent = label.startsWith('>') ? label : `> ${label}`;
    }

    function sendDiscoveryMessage(message) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || 'Keşif ayarları kaydedilemedi'));
            return;
          }
          resolve(response);
        });
      });
    }

    function resolveDiscoverySource() {
      const username = discoveryUsernameInput.value.trim().replace(/^@/, '');
      if (!username) {
         return Promise.reject(new Error('Önce kaynak hesap kullanıcı adını yazın'));
      }
      return sendDiscoveryMessage({
        type: 'IG_DISCOVERY_RESOLVE_PROFILE',
        username,
      }).then(response => {
        const user = response?.data || response;
        const id = String(user?.id || user?.pk || '');
        if (!id) throw new Error('Kaynak hesap bulunamadı');
        return { id, username: String(user?.username || username).replace(/^@/, '') };
      });
    }

    async function saveDiscoverySettings(previouslyEnabled = isDiscoveryEnabled()) {
      const wasEnabled = previouslyEnabled === true;
      const minMutualCount = currentMutualThreshold();
      discoveryStatus.className = 'dov-s-status';
      discoveryStatus.textContent = systemEnabled
        ? 'Beğeni sonrası ortak hesap akışı hazırlanıyor…'
        : 'Takip sistemi başlatılıyor; hedef hesap doğrulanıyor…';
      try {
        const enteredUsername = discoveryUsernameInput.value.trim().replace(/^@/, '');
        // İki sistem birlikte açıkken kaynak hesap, az önce beğeni atılan
        // hesap olur; bu nedenle ayrıca bir hedef kullanıcı adı zorunlu değil.
        const source = systemEnabled
          ? { id: '', username: enteredUsername }
          : await resolveDiscoverySource();
        await sendDiscoveryMessage({
          type: 'IG_DISCOVERY_SET',
          enabled: isDiscoveryEnabled(),
          sourceId: source.id,
          sourceUsername: source.username || '',
          // Yeni akış hedef hesabın mutual followers sayısını kontrol eder.
          relation: 'followers',
          targetGender: 'female',
          minMutualCount,
        });
        renderMutualThreshold(minMutualCount);
        discoveryMutualDirty = false;
        discoverySourceId = source.id;
        discoveryUsernameDirty = false;
        if (source.username && discoveryUsernameInput.value.trim() !== '@' + source.username) {
          discoveryUsernameInput.value = source.username;
        }
        discoveryStatus.className = 'dov-s-status ok';
        discoveryResetBtn.style.display = 'none';
        discoveryStatus.textContent = isDiscoveryEnabled()
          ? (systemEnabled
            ? '✓ Beğeni sonrası ortak hesap akışı hazır. Her başarılı beğeniden sonra takip edilenler taranacak.'
            : `✓ @${source.username || enteredUsername} kaydedildi. Ortak hesap kontrolü otomatik başladı.`)
          : `✓ @${source.username || enteredUsername} kaydedildi. Takip sistemi kapalı.`;
      } catch (error) {
        discoveryStatus.className = 'dov-s-status err';
        discoveryStatus.textContent = error.message || String(error);
        if (!wasEnabled) {
          // İlk açılışta doğrulama başarısızsa anahtar kapalı kalsın.
          renderDiscoveryToggle(false);
          renderDiscoveryState();
        } else {
          // Mevcut çalışan akışta yalnızca yeni kullanıcı adı doğrulanamadı
          // diye eski, geçerli kaynak hesabı kapatma. Kullanıcı tekrar
          // denediğinde mevcut kaynak çalışmaya devam eder.
          renderDiscoveryToggle(true);
          renderDiscoveryState();
        }
        discoveryResetBtn.style.display = /rate-limit cooldown aktif|429/i.test(discoveryStatus.textContent)
          ? 'block'
          : 'none';
      }
    }

    discoveryAutoFollow?.addEventListener('click', async () => {
      const wasEnabled = isDiscoveryEnabled();
      const next = !wasEnabled;
      renderDiscoveryToggle(next);
      if (!next) {
        try {
          await sendDiscoveryMessage({
            type: 'IG_DISCOVERY_SET',
            enabled: false,
          });
          discoveryStatus.className = 'dov-s-status ok';
          discoveryStatus.textContent = '✓ Takip isteği sistemi kapatıldı.';
          renderDiscoveryState();
        } catch (error) {
          renderDiscoveryToggle(true);
          discoveryStatus.className = 'dov-s-status err';
          discoveryStatus.textContent = error.message || String(error);
        }
        return;
      }
       // Açma işlemi artık alttaki ayrı bir düğmeye bağlı değil. Hedef hesap
       // doğrulanır ve ortak hesap akışı aynı akışta başlar.
      await saveDiscoverySettings(wasEnabled);
    });

    sourceRotationToggle?.addEventListener('click', async () => {
      const previous = discoveryRotateSources;
      const next = !previous;
      sourceRotationToggle.disabled = true;
      renderSourceRotationToggle(next);
      try {
        await sendDiscoveryMessage({
          type: 'IG_DISCOVERY_SET',
          rotateSources: next,
        });
        discoveryStatus.className = 'dov-s-status ok';
        discoveryStatus.textContent = next
          ? '✓ Tamamlanan hesaptan sonra rastgele yeni kaynak seçilecek.'
          : '✓ Mevcut kaynak tamamlanınca otomatik keşif duracak.';
      } catch (error) {
        renderSourceRotationToggle(previous);
        discoveryStatus.className = 'dov-s-status err';
        discoveryStatus.textContent = error.message || String(error);
      } finally {
        sourceRotationToggle.disabled = false;
      }
    });

    mutualFilterInput?.addEventListener('input', () => {
      discoveryMutualDirty = true;
      discoveryStatus.className = 'dov-s-status';
        discoveryStatus.textContent = 'Minimum ortak hesap sayısı değiştirildi; kaydetmek için alandan çıkın.';
    });

    mutualFilterInput?.addEventListener('change', async () => {
      const next = normalizeMutualCount(mutualFilterInput.value);
      if (next === null || mutualFilterInput.value.trim() === ''
        || Number(mutualFilterInput.value) !== next) {
        discoveryMutualDirty = false;
        renderMutualThreshold(discoveryMinMutualCount);
        discoveryStatus.className = 'dov-s-status err';
        discoveryStatus.textContent = '0 ile 10000 arasında tam sayı girin.';
        return;
      }
      const previous = discoveryMinMutualCount;
      mutualFilterInput.disabled = true;
      try {
        await sendDiscoveryMessage({
          type: 'IG_DISCOVERY_SET',
          minMutualCount: next,
        });
        discoveryMutualDirty = false;
        renderMutualThreshold(next);
        renderDiscoveryState();
        discoveryStatus.className = 'dov-s-status ok';
        const continuationNote = isDiscoveryEnabled()
          ? ' Takip sistemi açık; otomatik akış yeni sayıyla devam edecek.'
          : ' Takip sistemi kapalı; sayı yalnızca kaydedildi.';
        discoveryStatus.textContent = next === 0
          ? `✓ Ortak hesap şartı kaldırıldı.${continuationNote}`
          : `✓ Minimum ortak hesap sayısı ${next} olarak kaydedildi.${continuationNote}`;
      } catch (error) {
        discoveryMutualDirty = false;
        renderMutualThreshold(previous);
        renderDiscoveryState();
        discoveryStatus.className = 'dov-s-status err';
        discoveryStatus.textContent = error.message || String(error);
      } finally {
        mutualFilterInput.disabled = false;
      }
    });

    discoveryUsernameInput?.addEventListener('input', () => {
      discoveryUsernameDirty = true;
      discoveryStatus.className = 'dov-s-status';
      discoveryStatus.textContent = 'Yeni hedef adı yazılıyor…';
    });

    discoveryUsernameInput?.addEventListener('change', async () => {
      if (!discoveryUsernameDirty || !isDiscoveryEnabled()) return;
      // Akış zaten açıksa kullanıcıdan kapat-aç isteme; yeni adı aynı
      // güvenli doğrulama akışından geçirip atomik olarak değiştir.
      if (discoveryAutoFollow) discoveryAutoFollow.disabled = true;
      try {
        await saveDiscoverySettings(true);
      } finally {
        if (discoveryAutoFollow) discoveryAutoFollow.disabled = false;
      }
    });

    systemToggle?.addEventListener('click', async () => {
      const next = !systemEnabled;
      systemToggle.disabled = true;
      try {
        await sendDiscoveryMessage({ type: 'IG_AUTO_SET', patch: { enabled: next } });
        renderSystemState(next);
        renderDiscoveryState();
        discoveryStatus.className = 'dov-s-status ok';
        discoveryStatus.textContent = next
            ? (isDiscoveryEnabled()
            ? '✓ Beğeni sistemi açıldı. Beğeni sonrası ortak hesap akışı devrede.'
            : '✓ Beğeni sistemi açıldı. Takip isteği sistemi kendi anahtarıyla çalışır.')
          : '✓ Beğeni sistemi kapatıldı. Takip isteği sistemi etkilenmedi.';
      } catch (error) {
        discoveryStatus.className = 'dov-s-status err';
        discoveryStatus.textContent = error.message || String(error);
      } finally {
        systemToggle.disabled = false;
      }
    });

    discoveryResetBtn.addEventListener('click', async () => {
      discoveryResetBtn.disabled = true;
      discoveryStatus.className = 'dov-s-status';
      discoveryStatus.textContent = 'Uzantının yerel cooldown kaydı temizleniyor…';
      try {
        await sendDiscoveryMessage({ type: 'IG_RATE_LIMIT_RESET_LOCAL' });
        discoveryResetBtn.style.display = 'none';
        await saveDiscoverySettings();
      } catch (error) {
        discoveryStatus.className = 'dov-s-status err';
        discoveryStatus.textContent = error.message || String(error);
      } finally {
        discoveryResetBtn.disabled = false;
      }
    });

    toggles.forEach(el => {
      el.addEventListener('click', () => {
        const t = el.dataset.type;
        if (t === 'all') {
          const selectAll = selected.size !== 3;
          selected.clear();
          if (selectAll) ['story', 'post', 'reel'].forEach(type => selected.add(type));
          toggles.forEach(toggle => {
            const type = toggle.dataset.type;
            if (type === 'all') return;
            toggle.classList.toggle('active', selected.has(type));
          });
          setAllToggleState();
          status.className = 'dov-s-status';
          status.textContent = selectAll
            ? 'Hepsi seçildi. Kaydetmek için "Kaydet"e bas.'
            : 'İçerik türü seç. Kaydetmek için "Kaydet"e bas.';
          return;
        }
        if (selected.has(t)) {
          if (selected.size === 1) {
            status.className = 'dov-s-status err';
            status.textContent = 'En az bir tür seçili olmalı.';
            el.animate(
              [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }],
              { duration: 220 }
            );
            return;
          }
          selected.delete(t);
          el.classList.remove('active');
        } else {
          selected.add(t);
          el.classList.add('active');
        }
        setAllToggleState();
        status.className = 'dov-s-status';
        status.textContent = 'Seçili: ' + renderSelection() + '. Kaydetmek için "Kaydet"e bas.';
      });
    });

    // ── Toggleları storage'daki değerlere göre güncelle ─────────────
    function _applyStorageToToggles(igAutoState) {
      const cfg = igAutoState || {};
      const types = Array.isArray(cfg.enabledContentTypes) && cfg.enabledContentTypes.length > 0
        ? cfg.enabledContentTypes.filter(t => ['story', 'post', 'reel'].includes(t))
        : ['story', 'post', 'reel'];
      selected.clear();
      toggles.forEach(el => {
        const t = el.dataset.type;
        if (t === 'all') return;
        if (types.includes(t)) { selected.add(t); el.classList.add('active'); }
        else { el.classList.remove('active'); }
      });
      setAllToggleState();
    }

    // Mevcut değerleri storage'dan yükle
    if (window.chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['igAutoState'], ({ igAutoState }) => {
        _applyStorageToToggles(igAutoState);
        renderSystemState(igAutoState?.enabled === true);
        renderSourceRotationToggle(igAutoState?.discoveryRotateSources);
        renderMutualThreshold(storedMutualThreshold(igAutoState));
        discoverySourceId = String(igAutoState?.discoverySourceId || '');
        discoveryUsernameInput.value = igAutoState?.discoverySourceUsername || '';
        discoveryUsernameDirty = false;
        renderDiscoveryToggle(igAutoState?.discoveryEnabled === true);
        renderDiscoveryState();
        renderLastAction(igAutoState);
        status.className = 'dov-s-status';
        status.textContent = '';
      });
      // ── Canlı güncelleme: storage değiştiğinde toggleları anlık yansıt ──
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        if (!changes.igAutoState) return;
        // Kullanıcı şu an kaydetme işlemi yapıyorsa (buton disabled) güncelleme yapma
        if (saveBtn.disabled) return;
        _applyStorageToToggles(changes.igAutoState.newValue);
        renderSystemState(changes.igAutoState.newValue?.enabled === true);
        renderSourceRotationToggle(changes.igAutoState.newValue?.discoveryRotateSources);
        if (!discoveryMutualDirty) {
          renderMutualThreshold(storedMutualThreshold(changes.igAutoState.newValue));
        }
        discoverySourceId = String(changes.igAutoState.newValue?.discoverySourceId || '');
        if (!discoveryUsernameDirty) {
          discoveryUsernameInput.value = changes.igAutoState.newValue?.discoverySourceUsername || '';
        }
        renderDiscoveryToggle(changes.igAutoState.newValue?.discoveryEnabled === true);
        renderDiscoveryState();
        renderLastAction(changes.igAutoState.newValue);
        status.className = 'dov-s-status';
        status.textContent = '';
      });
    } else {
      status.className = 'dov-s-status';
      status.textContent = '';
    }

    saveBtn.addEventListener('click', () => {
      if (selected.size === 0) {
        status.className = 'dov-s-status err';
        status.textContent = 'En az bir tür seçili olmalı.';
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Kaydediliyor…';
      const payload = ['story', 'post', 'reel'].filter(k => selected.has(k));
      chrome.runtime.sendMessage(
        { type: 'IG_AUTO_SET', patch: { enabledContentTypes: payload } },
        (resp) => {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Kaydet';
          if (chrome.runtime.lastError) {
            status.textContent = 'Hata: ' + chrome.runtime.lastError.message;
            status.className = 'dov-s-status err';
            return;
          }
          if (resp && resp.ok) {
            status.textContent = payload.length === 3
              ? '✓ Kaydedildi: Hepsi (Hikâye + Gönderi + Reels)'
              : '✓ Kaydedildi: ' + payload.map(k => LABELS[k]).join(' + ');
            status.className = 'dov-s-status ok';
          } else {
            status.textContent = 'Kaydedilemedi — uzantıyı yeniden yüklemeyi dene.';
            status.className = 'dov-s-status err';
          }
        }
      );
    });
  }

  // Globale expose — sayfada slot yoksa elle çağrılabilsin
  window.dovInjectSettingsCard = dovInjectSettingsCard;

  // ── Path 1: #dov-s-slot varsa oraya doğrudan enjekte ─────────────
  function _injectViaSlot() {
    const slot = document.getElementById('dov-s-slot');
    if (!slot) return false;
    if (document.getElementById('dov-s-card')) return true;
    try {
      dovInjectSettingsCard(slot);
      return !!document.getElementById('dov-s-card');
    } catch (e) {
      console.warn('[settings-card] slot inject failed:', e);
      return false;
    }
  }

  // ── Path 2: React "AYARLAR" başlığının hemen altına enjekte ───────
  //
  // ÖNEMLİ TAKİP/AYARLAR FARKINI YAP:
  // React uygulamasında "AYARLAR" kelimesi hem alt navigasyonda bir tab
  // (orada "AYARLAR" yazıyor) hem de bazı sayfa içi bölümlerde
  // (özellikle TAKİP sayfasında kullanıcı eylemi etiketi olarak) geçebiliyor.
  // Hangi sayfada olduğumuzu öğrenmek için ALT NAV'daki AYARLAR butonunun
  // active / aria-current durumuna bakıyoruz. Aktif değilse → sessizce geç.
  function _isInsideNav(el) {
    let p = el;
    while (p && p !== document.body) {
      const tag = (p.tagName || '').toLowerCase();
      if (tag === 'nav' || p.getAttribute('role') === 'navigation') return true;
      p = p.parentElement;
    }
    return false;
  }

  function _findAyarHeading() {
    const candidates = Array.from(document.querySelectorAll(
      'h1,h2,h3,h4,h5,h6,div,p,span,strong,li'
    ));
    return candidates.find(el => {
      if (el.children.length > 0) return false;
      const t = (el.textContent || '').trim();
      if (t !== 'AYARLAR' && t !== 'Ayarlar' && t !== 'ƏYARLAR') return false;
      // nav/footer içinde olmasın — sadece sayfa-içi başlıkları hedefle
      if (_isInsideNav(el)) return false;
      return true;
    });
  }

  function _isAyarTabActive() {
    // React navigasyonu history API ile yaptığı için nav öğesinde "active"
    // sınıfı olmayabilir. Önce gerçek rotayı kontrol et; bu, kartın Ayarlar
    // ekranında güvenilir şekilde görünmesini sağlar.
    try {
      const routeSources = [
        window.location.pathname,
        window.location.hash.replace(/^#/, ''),
        new URLSearchParams(window.location.search).get('path') || '',
      ];
      if (routeSources.some(route => /(?:^|\/)settings(?:\/|$)/i.test(route))) {
        return true;
      }
    } catch (e) {
      // Aşağıdaki DOM tabanlı algılama yedek olarak devam eder.
    }

    // Alt navigasyondaki AYARLAR butonunun aktif olup olmadığını kontrol et
    const links = Array.from(document.querySelectorAll('button, a, div, li'));
    const ayar = links.find(el => {
      if (el.children.length > 0) return false;
      const t = (el.textContent || '').trim().toUpperCase();
      return t === 'AYARLAR' || t === 'ƏYARLAR';
    });
    if (!ayar) return false;
    if (_isInsideNav(ayar) === false) return false; // AYARLAR etiketi nav içinde olmalı
    // Aktif göstergeleri: class, aria, data attribute, parent'a tırmanma
    if (ayar.classList.contains('active')) return true;
    if (ayar.classList.contains('selected')) return true;
    if (ayar.getAttribute('aria-current') === 'page') return true;
    if (ayar.getAttribute('aria-selected') === 'true') return true;
    if (ayar.getAttribute('data-state') === 'active') return true;
    if (ayar.getAttribute('data-active') === 'true') return true;
    // 2 seviye üste kadar active class ara
    let p = ayar.parentElement;
    for (let i = 0; i < 3 && p; i++) {
      if (p.classList && p.classList.contains('active')) return true;
      p = p.parentElement;
    }
    return false;
  }

  function _injectAfterAyar() {
    if (document.getElementById('dov-s-card')) return true;
    if (!_isAyarTabActive()) return false; // kullanıcı AYARLAR sayfasında değil
    const heading = _findAyarHeading();
    if (!heading) return false;
    // Önce geçici kaba yükle, sonra başlık satırının altına taşı.
    // Başlığın kendisi bir flex satırının içindedir; kartı doğrudan
    // başlığın yanına eklemek kartı o satırın dar bir flex item'ı yapar.
    const tmp = document.createElement('div');
    tmp.style.cssText = 'display:contents';
    document.body.appendChild(tmp);
    try {
      dovInjectSettingsCard(tmp);
    } catch (e) {
      console.warn('[settings-card] ayar-page inject failed:', e);
      tmp.remove();
      return false;
    }
    const card = tmp.querySelector('#dov-s-card');
    if (!card) { tmp.remove(); return false; }
    const headingRow = heading.parentElement;
    if (!headingRow || !headingRow.parentNode) {
      card.remove();
      tmp.remove();
      return false;
    }
    headingRow.parentNode.insertBefore(card, headingRow.nextSibling);
    tmp.remove();
    return true;
  }

  // ── Orquestrator: önce slot dene, sonra AYARLAR başlığını bekle ────
  let _done = false;
  function _tryOnce() {
    if (_injectViaSlot())  { _done = true; return true; }
    if (_injectAfterAyar()) { _done = true; return true; }
    // Kart React tarafından route değişiminde kaldırıldıysa daha sonra
    // yeniden eklenebilmesi için kilitli kalma.
    _done = false;
    return false;
  }

  function _startObserver() {
    let attempts = 0;
    const maxAttempts = 60; // ~30 sn (500 ms aralıkla)
    const tick = () => {
      attempts++;
      if (_done) return;
      if (_tryOnce()) return;
      if (attempts >= maxAttempts) return;
      setTimeout(tick, 500);
    };
    tick();

    // React DOM değişikliklerini de dinle (klavye tıklamasıyla AYARLAR sayfası
    // açılınca sayfa yenilenmeden DOM'a gelir)
    try {
      const obs = new MutationObserver(() => {
        _tryOnce();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
      // observer başarısızsa sadece tarama modu devam eder
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      _tryOnce();
      _startObserver();
    });
  } else {
    _tryOnce();
    _startObserver();
  }
})();
