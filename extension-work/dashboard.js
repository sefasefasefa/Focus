// dashboard.js — Takipçi Paneli Dashboard (MV3 CSP uyumlu)
'use strict';

// ── Dashboard state ──────────────────────────────────────────────────
const LOG_KEY = '__analytics_log';
const DEBUG_LOG_KEY = '__automation_debug_log';
const CANDIDATE_REPORTS_KEY = 'lastCandidateReports';
let dovLogs = [];
let dovDebugLogs = [];
let dovCandidateReports = [];
let dovCandidateLastScanAt = 0;
let dovFollowingUsers = [];
let dovDiscoveryUsers = [];
let dovUnknownGenderUsers = [];
let dovManualDiscoveryResults = [];
let dovDiscoveryFollowStatuses = {};
let dovDiscoveryMinMutualCount = 2;
let dovTab_current = 'all';
let dovActivityView = 'likes';
// (charts removed)

function openDashboard() {
  const overlay = document.getElementById('dash-overlay');
  if (!overlay) return;
  overlay.classList.add('open');
  const fab = document.getElementById('dash-fab');
  if (fab) fab.classList.add('hidden');
  // Overlay kapalıyken birikmiş değişiklik varsa taze veri çek
  _dovPendingUpdate = false;
  dovLoadData();
}

function closeDashboard() {
  document.getElementById('dash-overlay').classList.remove('open');
  const fab = document.getElementById('dash-fab');
  if (fab) fab.classList.remove('hidden');
}

// ── Yardımcılar ──────────────────────────────────────────────────────
function dovFmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function dovFmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }) + ' ' +
    d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

function dovGetMinMutualCount(state) {
  const value = state?.discoveryMinMutualCount;
  if (value !== undefined && value !== null && value !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(10000, Math.floor(parsed))) : 2;
  }
  return state?.discoveryRequireMutuals === false ? 0 : 2;
}

function dovRelationshipFlag(value) {
  return value === true || value === 1 || value === '1';
}

function dovFollowingKeys(users) {
  const keys = new Set();
  for (const user of Array.isArray(users) ? users : []) {
    const id = String(user?.id ?? user?.pk ?? user?.fbid_v2 ?? '').trim();
    const username = String(user?.username ?? '').replace(/^@/, '').trim().toLowerCase();
    if (id) keys.add(`id:${id}`);
    if (username) keys.add(`user:${username}`);
  }
  return keys;
}

function dovIsAlreadyFollowing(user, followingKeys) {
  const friendship = user?.friendship_status ?? user?.friendshipStatus ?? {};
  if (
    dovRelationshipFlag(user?.alreadyFollowing) ||
    dovRelationshipFlag(user?.followRequestSent) ||
    dovRelationshipFlag(friendship.following) ||
    dovRelationshipFlag(friendship.is_following) ||
    dovRelationshipFlag(friendship.outgoing_request) ||
    dovRelationshipFlag(friendship.outgoingRequest)
  ) return true;
  const id = String(user?.id ?? user?.pk ?? user?.fbid_v2 ?? '').trim();
  const username = String(user?.username ?? '').replace(/^@/, '').trim().toLowerCase();
  return Boolean(
    (id && followingKeys?.has(`id:${id}`)) ||
    (username && followingKeys?.has(`user:${username}`))
  );
}

function dovIsConfirmedFollowSent(user) {
  const id = String(user?.id ?? user?.pk ?? user?.fbid_v2 ?? '').trim();
  return user?.followStatus === 'sent' ||
    (id && dovDiscoveryFollowStatuses[id]?.status === 'sent');
}

function dovShouldShowDiscoveryUser(user, followingKeys) {
  if (!user || !(user.username || user.id || user.pk)) return false;
  // Confirmed follow records are history: retain them even if the candidate
  // is now in the account's following cache or the threshold later changed.
  if (dovIsConfirmedFollowSent(user)) return true;
  return dovHasRequiredMutuals(user) && !dovIsAlreadyFollowing(user, followingKeys);
}

function dovGetConfirmedFollowResults(statuses = dovDiscoveryFollowStatuses) {
  return Object.entries(statuses && typeof statuses === 'object' ? statuses : {})
    .filter(([, status]) => status?.status === 'sent' && status?.username)
    .map(([id, status]) => ({
      id,
      pk: id,
      username: String(status.username).replace(/^@/, ''),
      gender: status.gender || 'unknown',
      followStatus: 'sent',
      following: status.following === true ? true : undefined,
      outgoingRequest: status.outgoingRequest === true ? true : undefined,
      followReason: status.outgoingRequest === true
        ? 'Instagram giden takip isteğini doğruladı'
        : status.following === true
          ? 'Instagram takip ilişkisini doğruladı'
          : 'Eski kayıtta istek ve takip durumu ayrı tutulmamış',
      ts: Number(status.ts) || 0,
      source: 'confirmed-follow-status',
      discoveryVersion: 6,
    }));
}

// ── Veri Yükleme ─────────────────────────────────────────────────────
async function dovLoadData() {
  const btn = document.getElementById('dovRefreshBtn');
  btn.classList.add('spin');
  try {
    const storage = await new Promise(r => chrome.storage.local.get(null, r));
    dovDiscoveryMinMutualCount = dovGetMinMutualCount(storage.igAutoState);

    // Profil / otomasyon durumu
    const cfgEntry = Object.entries(storage).find(([k, v]) => v && typeof v === 'object' && 'todayCount' in v);
    if (cfgEntry) {
      const cfg = cfgEntry[1];
      const today = cfg.todayCount || 0;
      const maxD  = cfg.maxPerDay || 840;
      document.getElementById('dov-today').textContent = today;
      document.getElementById('dov-limit').textContent = '/ ' + maxD + ' limit';
      document.getElementById('dov-prog').style.width = Math.min(100, (today / maxD) * 100) + '%';
      if (cfg.discoveryLastActionLabel || cfg.lastActionLabel) {
        document.getElementById('dov-last-action').style.display = 'flex';
        document.getElementById('dov-la-val').textContent = cfg.discoveryLastActionLabel || cfg.lastActionLabel;
        document.getElementById('dov-la-ts').textContent = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      }
      dovCandidateReports = Array.isArray(cfg[CANDIDATE_REPORTS_KEY]) ? cfg[CANDIDATE_REPORTS_KEY] : [];
      dovCandidateLastScanAt = Number(cfg.lastScanAt) || 0;
      dovRenderCandidateReports();
      const followingEl = document.getElementById('dov-following');
      const followingSubEl = document.getElementById('dov-following-sub');
      if (followingEl) followingEl.textContent = dovFmt(dovCandidateReports.length);
      if (followingSubEl) followingSubEl.textContent = dovCandidateReports.length
        ? 'Son kontrolde'
        : 'Henüz kontrol yok';
    }

    // Gerçek log verisi — yoksa boş göster, ASLA sahte veri kullanma
    dovLogs = Array.isArray(storage[LOG_KEY]) ? storage[LOG_KEY] : [];
    dovDebugLogs = Array.isArray(storage[DEBUG_LOG_KEY]) ? storage[DEBUG_LOG_KEY] : [];
    const followingCache = storage.__cached_following;
    const followingUsers = Array.isArray(followingCache?.users) && followingCache.users.length
      ? followingCache.users
      : storage.__ai_gender_users_v1;
    const followingKeys = dovFollowingKeys(followingUsers);
    window.__dovGenderLabels = storage.__ai_gender_labels_v1 || {};
    dovDiscoveryFollowStatuses = storage.__discovery_follow_status_v1 || {};
    // Include confirmed follow-status records as a recovery source. The
    // like-triggered discovery flow in older builds saved the status but did
    // not add its candidate to __discovery_auto_results.
    const autoResultRows = [
      ...(Array.isArray(storage.__discovery_auto_results)
        ? storage.__discovery_auto_results
        : []),
      ...dovGetConfirmedFollowResults(dovDiscoveryFollowStatuses),
    ];
    const autoResults = autoResultRows
      .filter(user => dovShouldShowDiscoveryUser(user, followingKeys));
     const manualResults = storage.__discovery_manual_results_v1;
     dovManualDiscoveryResults = Array.isArray(manualResults?.users)
       ? manualResults.users.filter(user => dovShouldShowDiscoveryUser(user, followingKeys))
       : [];
    // The discovery tab must contain only candidates produced by discovery.
    // The account's ordinary following list is not a discovery result and
    // must never be shown as "Takip isteği gönderildi".
    // Pending queue entries are intentionally not shown here: they have not
    // passed the integrated AI gender filter yet.
     dovDiscoveryUsers = [...autoResults, ...dovManualDiscoveryResults]
      .filter((user, index, list) => {
        const key = String(user?.id ?? user?.pk ?? user?.username ?? '');
        return key && list.findIndex(item => String(item?.id ?? item?.pk ?? item?.username ?? '') === key) === index;
      });
    dovUnknownGenderUsers = dovGetUnknownGenderUsers(
      dovDiscoveryUsers,
      storage.__ai_gender_labels_v1,
    );
    dovRenderUnknownGenderUsers();
    dovFollowingUsers = dovGetFemaleFollowingUsers(followingUsers, storage.__ai_gender_labels_v1);
    const femaleMenuBtn = document.getElementById('dovFemaleMenuBtn');
    if (femaleMenuBtn) femaleMenuBtn.textContent = `◎ Hesaplar (${dovDiscoveryUsers.length})`;
    dovRenderStats();
    // The dashboard can finish loading after the user has already selected
    // "Hesaplar". In that case rendering only the hidden likes table leaves
    // the account grid empty even though its counter is updated.
    if (dovTab_current === 'female') {
      dovRenderFemaleActivityCards();
    } else {
      dovRenderTable();
    }
    dovRenderDebugLogs();
  } catch (e) {
    // Hata durumunda da gerçek veri yok, boş göster
    dovLogs = [];
    dovRenderStats();
    dovRenderTable();
  } finally {
    btn.classList.remove('spin');
  }
}

function dovRenderDebugLogs() {
  const body = document.getElementById('dov-debug-body');
  const count = document.getElementById('dov-debug-count');
  if (!body || !count) return;
  count.textContent = dovDebugLogs.length + ' kayıt';
  if (!dovDebugLogs.length) {
    body.textContent = 'Henüz otomasyon veya hesap listesi logu yok. Ayarlar’dan bir hesap listesi çektiğinde sonuçlar burada görünür.';
    return;
  }
  body.innerHTML = dovDebugLogs.slice().sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0)).slice(0, 80).map(log => {
    const time = log.ts ? new Date(log.ts).toLocaleTimeString('tr-TR') : '--:--:--';
    const level = String(log.level || 'info').toLowerCase();
    const label = level === 'error' ? 'HATA' : level === 'warn' ? 'UYARI' : 'BİLGİ';
    const ctx = log.context ? ` ${dovEscapeHtml(JSON.stringify(log.context))}` : '';
    return `<div class="dov-debug-row ${dovEscapeHtml(level)}">[${time}] ${label}: ${dovEscapeHtml(String(log.message || ''))}${ctx}</div>`;
  }).join('');
}

function dovEscapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[char]));
}

function dovBindImageErrorHandling(grid) {
  if (!grid || grid._dovImageErrorBound) return;
  grid._dovImageErrorBound = true;
  grid.addEventListener('error', event => {
    if (event.target instanceof HTMLImageElement) {
      event.target.style.display = 'none';
    }
  }, true);
}

function dovRenderCandidateReports() {
  const body = document.getElementById('dov-candidate-body');
  const count = document.getElementById('dov-candidate-count');
  if (!body || !count) return;
  count.textContent = dovCandidateReports.length + ' hesap';
  if (!dovCandidateReports.length) {
    body.textContent = 'Henüz hesap kontrolü tamamlanmadı.';
    return;
  }
  const labels = { story: 'Hikaye', post: 'Gönderi', reel: 'Reels' };
  body.innerHTML = dovCandidateReports.map(report => {
    const summaries = ['story', 'post', 'reel'].map(type => {
      const status = report[type] || {};
      const stateClass = status.error
        ? 'error'
        : status.reasonCode === 'empty_response'
        ? 'empty'
        : status.reasonCode === 'all_liked'
        ? 'liked'
        : 'ok';
      return `<span class="dov-candidate-status ${stateClass}"><b>${labels[type]}:</b> ${dovEscapeHtml(status.display || status.reason || 'Kontrol edilmedi')}</span>`;
    }).join('');
    return `<div class="dov-candidate-row"><span class="dov-candidate-user">${dovEscapeHtml(report.username || 'Bilinmeyen hesap')}</span><span class="dov-candidate-summary">${summaries}</span></div>`;
  }).join('');
}

function dovRenderFollowingUsers() {
  const grid = document.getElementById('dov-following-grid');
  const count = document.getElementById('dov-following-count');
  if (!grid || !count) return;
  const users = dovFollowingUsers
    .filter(user => user && (user.username || user.pk))
    .filter((user, index, list) => {
      const key = String(user.pk || user.username);
      return list.findIndex(item => String(item.pk || item.username) === key) === index;
    });
  count.textContent = users.length + ' bayan';
  if (!users.length) {
    grid.innerHTML = '<div class="dov-empty" style="grid-column:1/-1;padding:20px 10px;">Henüz çekilen hesap yok.</div>';
    return;
  }
  grid.innerHTML = users.slice(0, 100).map(user => {
    const username = String(user.username || 'Bilinmeyen');
    const avatar = user.profile_pic_url_hd || user.profile_pic_url || '';
    const image = avatar
      ? `<img class="dov-following-avatar" src="${dovEscapeHtml(avatar)}" alt="" decoding="async">`
      : '<div class="dov-following-avatar"></div>';
    const href = 'https://www.instagram.com/' + encodeURIComponent(username.replace(/^@/, '')) + '/';
    const followers = user.follower_count != null ? `${dovFmt(Number(user.follower_count))} takipçi` : 'Instagram profili';
    return `<div class="dov-following-user" data-href="${dovEscapeHtml(href)}">
      ${image}
      <div style="min-width:0">
        <div class="dov-following-name">@${dovEscapeHtml(username.replace(/^@/, ''))}</div>
        <div class="dov-following-meta">${dovEscapeHtml(followers)}</div>
        </div>
    </div>`;
  }).join('');
  if (!grid._dovClickBound) {
    grid._dovClickBound = true;
    grid.addEventListener('click', event => {
      const card = event.target.closest('[data-href]');
      if (card) chrome.tabs.create({ url: card.dataset.href, active: true });
    });
  }
}

function dovGetFemaleFollowingUsers(users, labels) {
  const labelMap = labels && typeof labels === 'object' ? labels : {};
  return (Array.isArray(users) ? users : []).filter(user => {
    const id = String(user?.pk ?? user?.id ?? user?.user_id ?? '');
    const username = String(user?.username ?? '').replace(/^@/, '').toLowerCase();
    // Different Instagram responses use pk/id, while the AI service can
    // persist either an id key or a u:username key. Try all of them.
    const label = labelMap[id]
      || labelMap[String(user?.id ?? '')]
      || labelMap[username]
      || labelMap['u:' + username]
      || labelMap['u:@' + username];
    // Instagram list objects commonly carry the old "unknown" value even
    // after the AI label has been stored. A known label must win over that
    // placeholder, otherwise real female matches disappear from the panel.
    const gender = String(label?.gender || user?.gender || '').toLowerCase();
    return gender === 'female' || gender === 'kadın' || gender === 'kadin';
  });
}

function dovGenderForUser(user, labels = window.__dovGenderLabels || {}) {
  const env = window.__TAKIPCI_ENV__ || {};
  const provider = String(env.GENDER_PROVIDER || 'gemini').trim().toLowerCase();
  const hasGenderProvider = provider === 'gemini'
    ? Boolean(String(env.GEMINI_API_KEY || '').trim())
    : provider === 'genderize'
      ? Boolean(String(env.AI_API_URL || '').trim())
      : provider === 'mistral'
        ? Boolean(String(env.MISTRAL_API_KEY || '').trim())
        : false;
  if (!hasGenderProvider) return 'unknown';
  const id = String(user?.pk ?? user?.id ?? user?.user_id ?? '');
  const username = String(user?.username ?? '').replace(/^@/, '').toLowerCase();
  const label = labels[id]
    || labels[String(user?.id ?? '')]
    || labels[username]
    || labels['u:' + username]
    || labels['u:@' + username];
  const labelGender = String(label?.gender || '').toLowerCase();
  if (['male', 'female', 'kadın', 'kadin', 'erkek'].includes(labelGender)) return labelGender;
  return String(user?.gender || '').toLowerCase() || 'unknown';
}

function dovGetUnknownGenderUsers(users, labels) {
  const seen = new Set();
  return (Array.isArray(users) ? users : []).filter(user => {
    const id = String(user?.pk ?? user?.id ?? user?.user_id ?? user?.username ?? '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    const gender = dovGenderForUser(user, labels);
    return !['male', 'female', 'kadın', 'kadin', 'erkek'].includes(gender);
  });
}

function dovHasRequiredMutuals(user) {
  return dovDiscoveryMinMutualCount === 0
    || Number(user?.mutualCount) === dovDiscoveryMinMutualCount;
}

function dovRenderUnknownGenderUsers() {
  const body = document.getElementById('dov-unknown-gender-body');
  const count = document.getElementById('dov-unknown-gender-count');
  if (!body || !count) return;
  const users = Array.isArray(dovUnknownGenderUsers) ? dovUnknownGenderUsers : [];
  count.textContent = `${users.length} kayıt`;
  if (!users.length) {
    body.innerHTML = '<div class="dov-empty" style="padding:16px;">Yeniden analiz bekleyen Belirsiz kayıt yok.</div>';
    return;
  }
  body.innerHTML = users.slice(0, 100).map(user => {
    const username = String(user.username || 'Bilinmeyen').replace(/^@/, '');
    const displayName = String(user.full_name || user.name || '').trim();
    const mutual = Number(user.mutualCount) || 0;
    const source = user.sourceUsername ? `Kaynak: @${String(user.sourceUsername).replace(/^@/, '')}` : 'Eski keşif kaydı';
    const mutualLabel = mutual
      ? `${mutual} ortak hesap`
      : user.mutualFilterEnabled === false
        ? 'Ortak hesap filtresi kapalı'
        : 'Ortak hesap bilgisi yok';
    return `<div class="dov-unknown-row">
      <div>
        <div class="dov-following-name">@${dovEscapeHtml(username)}</div>
        <div class="dov-following-meta">${dovEscapeHtml(displayName || source)}</div>
      </div>
      <div class="dov-following-meta">${dovEscapeHtml(mutualLabel)}</div>
    </div>`;
  }).join('');
}

function dovReanalyzeUnknownGender() {
  const button = document.getElementById('dov-reanalyze-unknown-btn');
  const status = document.getElementById('dov-reanalyze-unknown-status');
  if (button) {
    button.disabled = true;
    button.textContent = 'Analiz ediliyor…';
  }
  if (status) status.textContent = 'Eski kayıtlar zorunlu yeniden analiz ediliyor…';
  chrome.runtime.sendMessage({ type: 'GENDER_REANALYZE_UNKNOWN' }, response => {
    if (chrome.runtime.lastError) {
      if (status) status.textContent = `Hata: ${chrome.runtime.lastError.message}`;
    } else if (!response?.ok) {
      if (status) status.textContent = `Hata: ${response?.error || 'Analiz başlatılamadı'}`;
    } else {
      const sent = Number(response.sent) || 0;
      const unknown = Number(response.unknown) || 0;
      if (status) {
        status.textContent = `${response.total || 0} kayıt analiz edildi · ${sent} takip isteği · ${unknown} hâlâ belirsiz`;
      }
      dovLoadData();
    }
    if (button) {
      button.disabled = false;
      button.textContent = '↻ Belirsizleri tekrar analiz et';
    }
  });
}

function dovAnalyzeDashboardAccounts() {
  const button = document.getElementById('dov-dashboard-analyze-btn');
  const count = document.getElementById('dov-following-count');
  if (!button || button.disabled) return;
  button.disabled = true;
  button.textContent = 'Analiz ediliyor…';
  button.title = 'Dashboard hesapları analiz ediliyor';
  if (count) count.textContent = 'Analiz ediliyor…';

  chrome.runtime.sendMessage({ type: 'GENDER_ANALYZE_DASHBOARD' }, response => {
    let message = '';
    if (chrome.runtime.lastError) {
      message = `Hata: ${chrome.runtime.lastError.message}`;
    } else if (!response?.ok) {
      message = `Hata: ${response?.message || response?.error || 'Analiz başlatılamadı'}`;
    } else {
      message = `${response.total || 0} analiz · ${response.female || 0} kadın · ${response.sent || 0} istek`;
      dovLoadData();
    }
    button.disabled = false;
    button.textContent = '♀ Manuel analiz';
    button.title = message;
    if (count) {
      count.textContent = message.startsWith('Hata:')
        ? message
        : `${dovDiscoveryUsers.length} aday · ${message}`;
    }
  });
}

function dovRenderStats() {
  const likes = dovLogs.filter(dovIsLikeEntry);
  const posts   = likes.filter(l => l.type === 'post').length;
  const stories = likes.filter(l => l.type === 'story').length;
  const reels   = likes.filter(l => l.type === 'reel').length;
  const total   = likes.length;
  document.getElementById('dov-posts').textContent   = dovFmt(posts);
  document.getElementById('dov-stories').textContent = dovFmt(stories);
  document.getElementById('dov-reels').textContent   = dovFmt(reels);
  document.getElementById('dov-total').textContent   = dovFmt(total);
  document.getElementById('dov-posts-sub').textContent   = posts + ' kayıt';
  document.getElementById('dov-stories-sub').textContent = stories + ' kayıt';
  document.getElementById('dov-reels-sub').textContent = reels + ' kayıt';
  const first = likes[likes.length - 1];
  document.getElementById('dov-total-sub').textContent = first ? 'İlk: ' + new Date(first.ts).toLocaleDateString('tr-TR') : '—';
}

function dovTab(tab, el) {
  dovTab_current = tab;
  dovSetActivityView(tab === 'female' ? 'female' : 'likes');
  document.querySelectorAll('.dov-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  if (tab === 'female') {
    dovRenderFemaleActivityCards();
  } else {
    dovRenderTable();
  }
}

function dovSetActivityView(view) {
  dovActivityView = view === 'female' ? 'female' : 'likes';
  const femaleCard = document.getElementById('dov-following-card');
  const logCard = document.querySelector('.dov-log-card');
  const femaleMenuBtn = document.getElementById('dovFemaleMenuBtn');
  // Discovery has its own card. Keeping it separate makes the panel visible
  // even when there are no like records and avoids mixing two data sources.
  if (femaleCard) {
    const showAccounts = dovActivityView === 'female';
    // Use both hidden and an important inline display value. The overlay is
    // mounted beside the React app and its broad layout rules can otherwise
    // leave the account card hidden while the tab counter still updates.
    femaleCard.hidden = !showAccounts;
    femaleCard.style.setProperty('display', showAccounts ? 'block' : 'none', 'important');
    femaleCard.style.setProperty('flex', '0 0 auto', 'important');
    femaleCard.style.setProperty('min-height', showAccounts ? '42px' : '0', 'important');
    if (showAccounts) {
      document.getElementById('dovBody')?.scrollTo({ top: 0, behavior: 'auto' });
    }
  }
  if (logCard) logCard.style.display = dovActivityView === 'female' ? 'none' : 'block';
  if (femaleMenuBtn) {
    femaleMenuBtn.classList.toggle('open', dovActivityView === 'female');
    femaleMenuBtn.setAttribute('aria-expanded', String(dovActivityView === 'female'));
  }
}

function dovIsFemaleEntry(entry) {
  const username = String(dovGetUsername(entry) || '').replace(/^@/, '').toLowerCase();
  const labels = window.__dovGenderLabels || {};
  const id = String(entry?.pk ?? entry?.id ?? entry?.user_id ?? '');
  const usernameLabel = labels[username] || labels['u:' + username];
  const gender = String(entry?.gender || '').toLowerCase();
  const labelGender = String(labels[id]?.gender || usernameLabel?.gender || '').toLowerCase();
  return gender === 'female' ||
    gender === 'kadın' ||
    gender === 'kadin' ||
    labelGender === 'female' ||
    labelGender === 'kadın' ||
    labelGender === 'kadin';
}

function dovGetUsername(entry) {
  // New entries have a dedicated username field
  if (entry.username) return entry.username;
  // Old entries: label format is "Hikaye beğenildi (username)"
  const m = (entry.label || '').match(/\(([^)]+)\)$/);
  return m ? m[1] : 'bilinmiyor';
}


function dovMediaToShortcode(mediaId) {
  // Instagram media ID → URL shortcode (base64url)
  try {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = BigInt(String(mediaId).split('_')[0]); // "_userId" suffix varsa kes
    let code = '';
    while (id > 0n) { code = alphabet[Number(id % 64n)] + code; id /= 64n; }
    return code;
  } catch { return ''; }
}

function dovCardUrl(l) {
  const username = dovGetUsername(l);
  if (l.reportEntry) {
    return username && username !== 'bilinmiyor'
      ? 'https://www.instagram.com/' + encodeURIComponent(username) + '/'
      : '';
  }
  // Hikayelerin kalıcı bir /p/{code}/ adresi yoktur — 24 saat içinde
  // kaybolurlar ve medya ID'si post shortcode'una çevrilemez. O yüzden
  // hikaye kayıtları için doğrudan kullanıcı profiline yönlendir; aksi
  // hâlde Instagram "Sorry, this page isn't available" gösterir.
  if (l.mediaId && l.type !== 'story') {
    const code = dovMediaToShortcode(l.mediaId);
    if (code) {
      const base = l.type === 'reel' ? 'reel' : 'p';
      return `https://www.instagram.com/${base}/${code}/`;
    }
  }
  return username && username !== 'bilinmiyor'
    ? 'https://www.instagram.com/' + encodeURIComponent(username) + '/'
    : '';
}

function dovIsLikeEntry(entry) {
  // Only show actual like entries, not status messages
  if (entry.username) return true;
  if (/beğenildi/i.test(entry.label || '')) return true;
  return false;
}

function dovReportStatusClass(status) {
  if (status?.reasonCode === 'retry_pending') return 'available';
  if (status?.error || status?.reasonCode === 'request_error') return 'error';
  if (status?.reasonCode === 'all_liked') return 'liked';
  if (status?.reasonCode === 'unliked_available' || status?.reasonCode === 'follow_guard_skip') return 'available';
  if (status?.reasonCode === 'disabled' || status?.reasonCode === 'not_checked') return 'muted';
  return 'empty';
}

function dovReportStatusText(status) {
  if (!status) return 'Kontrol sonucu yok';
  const detail = status.display || status.reason || status.error || 'Kontrol sonucu yok';
  if (status.reasonCode === 'all_liked') return 'Beğenilmedi — içerik var, hepsi zaten beğenilmiş';
  if (status.reasonCode === 'empty_response') return 'Beğenilmedi — bu tür içerik bulunamadı';
  if (status.reasonCode === 'request_error') return `Beğenilmedi — istek hatası: ${detail}`;
  if (status.reasonCode === 'retry_pending') {
    return `Geçici yanıt — kısa süre sonra yeniden denenecek: ${status.error || status.reason || detail}`;
  }
  if (status.reasonCode === 'follow_guard_skip') {
    return `Beğenilmedi — ${status.reason || 'Güncel takip doğrulanmadığı için güvenlik amacıyla atlandı'}`;
  }
  if (status.reasonCode === 'unliked_available') return `Bu turda beğenilmedi — ${detail}`;
  if (status.reasonCode === 'disabled') return `Kontrol edilmedi — ${detail}`;
  if (status.reasonCode === 'not_checked') return `Kontrol tamamlanmadı — ${status.reason || detail}`;
  return detail;
}

function dovGetReportEntries() {
  return dovCandidateReports.flatMap(report => ['story', 'post', 'reel'].map(type => {
    const status = report?.[type];
    if (!status) return null;
    return {
      reportEntry: true,
      ts: dovCandidateLastScanAt,
      type,
      username: String(report.username || '').replace(/^@/, ''),
      status,
      statusDisplay: dovReportStatusText(status),
    };
  }).filter(Boolean));
}

function dovRenderTable() {
  try {
    if (dovTab_current === 'female') {
      dovRenderFemaleActivityCards();
      return;
    }
    const activityTitle = document.querySelector('.dov-log-card .dov-log-head-title');
    if (activityTitle) activityTitle.textContent = 'Beğeni Geçmişi';
    const byType = dovTab_current === 'all' || dovTab_current === 'female'
      ? dovLogs
      : dovLogs.filter(l => l.type === dovTab_current);
    const likeEntries = byType.filter(dovIsLikeEntry);
    const reportEntries = dovGetReportEntries().filter(l =>
      (dovTab_current === 'all' || dovTab_current === 'female' || l.type === dovTab_current) &&
      (dovTab_current !== 'female' || dovIsFemaleEntry(l))
    );
    const femaleLikeEntries = dovTab_current === 'female'
      ? likeEntries.filter(dovIsFemaleEntry)
      : likeEntries;
    const visibleLikeEntries = dovTab_current === 'female' ? femaleLikeEntries : likeEntries;
    const filtered = [...visibleLikeEntries, ...reportEntries].sort((a, b) => {
      const ta = typeof a.ts === 'number' ? a.ts : (parseInt(a.ts, 10) || 0);
      const tb = typeof b.ts === 'number' ? b.ts : (parseInt(b.ts, 10) || 0);
      return tb - ta;
    });
    const countEl = document.getElementById('dov-log-count');
    if (countEl) {
      countEl.textContent = reportEntries.length
        ? `${visibleLikeEntries.length} beğeni · ${reportEntries.length} kontrol`
        : `${visibleLikeEntries.length} beğeni`;
    }
    // Ensure the card grid container exists
    let grid = document.getElementById('dov-card-grid');
    if (!grid) {
      const logCard = document.querySelector('.dov-log-card');
      if (logCard) {
        grid = document.createElement('div');
        grid.className = 'dov-card-grid';
        grid.id = 'dov-card-grid';
        logCard.appendChild(grid);
      } else {
        return;
      }
    }
    // Remove any overflow clipping on parent
    const logCard = grid.closest && grid.closest('.dov-log-card');
    if (logCard) logCard.style.overflow = 'visible';
    dovBindImageErrorHandling(grid);

    if (!filtered.length) {
      grid.innerHTML = `
        <div class="dov-empty">
          <div style="font-size:28px">📭</div>
          <p style="color:#6b7280;margin-top:8px;">Henüz beğeni veya kontrol sonucu yok.</p>
          <p style="color:#4b5563;font-size:10px;margin-top:4px;">Otomasyon çalıştığında beğeniler ve neden beğenilmediği burada görünür.</p>
        </div>`;
      return;
    }

    const typeMeta = {
      story: { label: 'Hikaye', icon: '🎬', color: '#a855f7', bg: 'rgba(168,85,247,0.15)' },
      post:  { label: 'Gönderi', icon: '📸', color: '#fb7185', bg: 'rgba(251,113,133,0.15)' },
      reel:  { label: 'Reels', icon: '▶', color: '#fbbf24', bg: 'rgba(251,191,36,0.15)' },
    };

    if (!grid._dovClickBound) {
      grid._dovClickBound = true;
      grid.addEventListener('click', e => {
        const card = e.target.closest('[data-href]');
        if (card) chrome.tabs.create({ url: card.dataset.href, active: true });
      });
    }
    grid.innerHTML = filtered.slice(0, 150).map(l => {
      const meta = typeMeta[l.type] || typeMeta.post;
      const username = dovGetUsername(l);
      const isNamed = username !== 'bilinmiyor';
      if (l.reportEntry) {
        return `
        <div class="dov-user-card dov-status-card ${dovReportStatusClass(l.status)}"${(h => h ? ' data-href="' + h + '"' : '')(dovCardUrl(l))}>
          <div class="dov-card-thumb-wrap"><div class="dov-card-thumb dov-card-thumb-fallback">${meta.icon}</div></div>
          <div class="dov-card-body">
            <div class="dov-card-username">${isNamed ? '@' + dovEscapeHtml(username) : 'Bilinmeyen hesap'}</div>
            <div class="dov-card-reason">${dovEscapeHtml(l.statusDisplay)}</div>
            <div class="dov-card-meta">
              <span class="dov-card-badge" style="color:${meta.color};background:${meta.bg}">${meta.icon} ${meta.label} · Kontrol</span>
              <span class="dov-card-time">${l.ts ? dovFmtDate(l.ts) : 'Son tarama'}</span>
            </div>
          </div>
          <div class="dov-card-count dov-card-status-mark">—</div>
        </div>`;
      }
      const thumb = l.thumbnailUrl
        ? `<img class="dov-card-thumb" src="${l.thumbnailUrl}" alt="" decoding="async">`
        : `<div class="dov-card-thumb dov-card-thumb-fallback">${meta.icon}</div>`;
      return `
        <div class="dov-user-card"${(h => h ? ' data-href="' + h + '"' : '')(dovCardUrl(l))}>
          <div class="dov-card-thumb-wrap">${thumb}</div>
          <div class="dov-card-body">
            <div class="dov-card-username">${isNamed ? '@' + username : (l.label || 'Bilinmeyen')}</div>
            <div class="dov-card-meta">
              <span class="dov-card-badge" style="color:${meta.color};background:${meta.bg}">${meta.icon} ${meta.label}</span>
              <span class="dov-card-time">${dovFmtDate(l.ts)}</span>
            </div>
          </div>
          <div class="dov-card-count">+1</div>
        </div>`;
    }).join('');
  } catch (e) {
    console.warn('[Dashboard] Kart render hatası:', e);
  }
}

function dovRenderFemaleActivityCards() {
  const grid = document.getElementById('dov-following-grid');
  const femaleCard = document.getElementById('dov-following-card');
  const title = document.querySelector('.dov-log-card .dov-log-head-title');
  const discoveryTitle = document.querySelector('#dov-following-card .dov-log-head-title');
  const count = document.getElementById('dov-log-count');
  const discoveryCount = document.getElementById('dov-following-count');
  if (!grid) return;
  if (femaleCard) {
    femaleCard.hidden = false;
    femaleCard.style.setProperty('display', 'block', 'important');
    femaleCard.style.setProperty('flex', '0 0 auto', 'important');
    femaleCard.style.setProperty('min-height', '42px', 'important');
  }
  grid.style.setProperty('display', 'grid', 'important');
  grid.style.setProperty('min-height', '42px', 'important');
  if (!grid._dovClickBound) {
    grid._dovClickBound = true;
    grid.addEventListener('click', event => {
      const card = event.target.closest('[data-href]');
      if (card) chrome.tabs.create({ url: card.dataset.href, active: true });
    });
  }
  dovBindImageErrorHandling(grid);
  if (title) title.textContent = 'Beğeni Geçmişi';
  if (discoveryTitle) discoveryTitle.textContent = 'Çekilen Hesaplar';
  const users = (Array.isArray(dovDiscoveryUsers) ? dovDiscoveryUsers : [])
    .filter(user => user && (user.username || user.pk || user.id));
  const followStatuses = dovDiscoveryFollowStatuses && typeof dovDiscoveryFollowStatuses === 'object'
    ? dovDiscoveryFollowStatuses
    : {};
  if (count) count.textContent = 'Manuel liste görünümü';
  if (discoveryCount) discoveryCount.textContent = users.length + ' aday';
   if (!users.length) {
     grid.innerHTML = '<div class="dov-empty"><div style="font-size:28px">◎</div><p style="color:#6b7280;margin-top:8px;">Henüz hesap listesi çekilmedi.</p><p style="color:#4b5563;font-size:10px;margin-top:4px;">Ayarlar’dan bir kullanıcı adı ve Takipçileri veya Takip ettikleri seçip “Hesapları çek” düğmesine bas.</p></div>';
    return;
  }
  grid.innerHTML = users.slice(0, 150).map(user => {
    const username = String(user.username || 'Bilinmeyen').replace(/^@/, '');
    const avatar = user.profile_pic_url_hd || user.profile_pic_url || '';
     const image = avatar
       ? `<img class="dov-following-avatar" src="${dovEscapeHtml(avatar)}" alt="" decoding="async">`
      : '<div class="dov-following-avatar"></div>';
    const href = 'https://www.instagram.com/' + encodeURIComponent(username) + '/';
    const savedFollow = followStatuses[String(user.id || user.pk)] || {};
    const savedStatus = savedFollow.status;
    const relationLabel = user.relation === 'following' ? 'Takip ettikleri' : 'Takipçileri';
    const isFollowing = savedFollow.following === true || user.following === true;
    const isPendingRequest = savedFollow.outgoingRequest === true || user.outgoingRequest === true;
    const isSent = savedStatus === 'sent' || user.followStatus === 'sent';
    const isSkipped = !isFollowing && !isPendingRequest && !isSent && (
      savedStatus === 'skipped' ||
      user.followStatus === 'skipped' ||
      /zaten takip|bekleyen takip isteği|bağlı/i.test(String(user.followReason || ''))
    );
    const requestTimestamp = Number(savedFollow.ts) ||
      Number(user.followRequestSentAt) ||
      Number(user.followSentAt) ||
      (isSent ? Number(user.ts) : 0);
    const requestDate = (isSent || savedStatus === 'sent') && requestTimestamp > 0
      ? `<div class="dov-following-meta">İstek: ${dovEscapeHtml(dovFmtDate(requestTimestamp))}</div>`
      : '';
      const aiUnavailable = user.source === 'ai-unavailable' ||
        user.source === 'no-provider' ||
        /AI analizi yapılamadı|AI sunucusu/i.test(String(user.followReason || ''));
    const status = isFollowing
      ? 'Takip ediliyor'
        : isPendingRequest
        ? 'Takip isteği gönderildi'
          : isSent
            ? 'Takip durumu doğrulandı · eski kayıtta türü yok'
            : isSkipped
              ? 'Zaten takip ediliyor · yeni takip isteği gönderilmedi'
              : aiUnavailable
                ? 'AI analizi yapılamadı · takip isteği gönderilmedi'
                : user.gender === 'male'
                  ? 'Erkek aday · takip isteği gönderilmedi'
                  : user.gender === 'unknown'
                    ? 'Belirsiz aday · takip isteği gönderilmedi'
                    : user.manual && user.automaticFollow === true
                      ? `${relationLabel} · AI filtresi ve takip sırası bekleniyor`
                      : user.manual
                        ? `${relationLabel} · liste çekildi — takip isteği gönderilmedi`
                        : 'Takip isteği gönderilmedi';
    const statusClass = isFollowing || isPendingRequest || isSent ? 'sent' : 'not-sent';
    const followers = user.follower_count != null && user.follower_count_known !== false
      ? `${dovFmt(Number(user.follower_count))} takipçi`
      : 'Instagram profili';
     const sourceLabel = user.manual && user.sourceUsername
       ? `<div class="dov-following-meta">Kaynak: @${dovEscapeHtml(user.sourceUsername)}</div>`
       : '';
     return `<div class="dov-following-user" data-href="${dovEscapeHtml(href)}">
      ${image}
      <div style="min-width:0">
        <div class="dov-following-name">@${dovEscapeHtml(username)}</div>
        <div class="dov-following-meta">${dovEscapeHtml(followers)}</div>
         ${sourceLabel}
        ${requestDate}
        <span class="dov-discovery-status ${statusClass}">${dovEscapeHtml(status)}</span>
      </div>
    </div>`;
  }).join('');
}

// ── Storage değişiklik izleme (canlı güncelleme) ─────────────────────
// Bekleyen güncelleme bayrağı: overlay kapalıyken değişiklik gelirse,
// overlay açılır açılmaz dovLoadData çağrılsın diye işaretlenir.
let _dovPendingUpdate = false;

if (chrome && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    const overlayOpen = document.getElementById('dash-overlay')
      && document.getElementById('dash-overlay').classList.contains('open');

    // Overlay kapalıysa güncellemeyi işaretle; açıldığında dovLoadData çağrılır.
    if (!overlayOpen) {
      _dovPendingUpdate = true;
      return;
    }

    if (changes[LOG_KEY]) {
      const newVal = changes[LOG_KEY].newValue;
      dovLogs = Array.isArray(newVal) ? newVal : [];
      dovRenderStats();
      dovRenderTable();
    }
    if (changes.__cached_following) {
      const cached = changes.__cached_following.newValue;
      chrome.storage.local.get(['__ai_gender_labels_v1'], stored => {
        dovFollowingUsers = dovGetFemaleFollowingUsers(cached?.users, stored.__ai_gender_labels_v1);
      });
    }
    const mutualFilterChanged = changes.igAutoState &&
      dovGetMinMutualCount(changes.igAutoState.oldValue) !==
        dovGetMinMutualCount(changes.igAutoState.newValue);
    if (
      changes.__discovery_auto_results ||
      changes.__discovery_manual_results_v1 ||
      changes.__discovery_queue_v3 ||
      changes.__discovery_follow_status_v1 ||
      mutualFilterChanged
    ) {
      chrome.storage.local.get(['__discovery_auto_results', '__discovery_manual_results_v1', '__discovery_queue_v3', '__discovery_follow_status_v1', '__cached_following', 'igAutoState'], stored => {
        dovDiscoveryMinMutualCount = dovGetMinMutualCount(stored.igAutoState);
        dovDiscoveryFollowStatuses = stored.__discovery_follow_status_v1 || {};
        const followingKeys = dovFollowingKeys(stored.__cached_following?.users);
        const autoResultRows = [
          ...(Array.isArray(stored.__discovery_auto_results)
            ? stored.__discovery_auto_results
            : []),
          ...dovGetConfirmedFollowResults(dovDiscoveryFollowStatuses),
        ];
        const results = autoResultRows
          .filter(user => dovShouldShowDiscoveryUser(user, followingKeys));
        dovManualDiscoveryResults = Array.isArray(stored.__discovery_manual_results_v1?.users)
          ? stored.__discovery_manual_results_v1.users
            .filter(user => dovShouldShowDiscoveryUser(user, followingKeys))
          : [];
        const merged = new Map();
        // Kuyrukta bekleyen hesaplar henüz ortak hesap kapısından geçmedi.
        // Eşik sıfırdan büyükse yalnızca yeterli ortak hesabı olanlar görünür.
        [...dovManualDiscoveryResults, ...results].forEach(user => {
          const key = String(user?.id ?? user?.pk ?? user?.username ?? '');
          if (key) merged.set(key, { ...(merged.get(key) || {}), ...user });
        });
        dovDiscoveryUsers = [...merged.values()];
         dovUnknownGenderUsers = dovGetUnknownGenderUsers(dovDiscoveryUsers, window.__dovGenderLabels);
         dovRenderUnknownGenderUsers();
        const femaleMenuBtn = document.getElementById('dovFemaleMenuBtn');
        if (femaleMenuBtn) femaleMenuBtn.textContent = `◎ Hesaplar (${dovDiscoveryUsers.length})`;
        if (dovTab_current === 'female') dovRenderFemaleActivityCards();
      });
    }
    if (changes.__ai_gender_labels_v1) {
      window.__dovGenderLabels = changes.__ai_gender_labels_v1.newValue || {};
      chrome.storage.local.get(['__cached_following', '__ai_gender_users_v1'], stored => {
        dovFollowingUsers = dovGetFemaleFollowingUsers(
          Array.isArray(stored.__cached_following?.users) && stored.__cached_following.users.length
            ? stored.__cached_following.users
            : stored.__ai_gender_users_v1,
          changes.__ai_gender_labels_v1.newValue
        );
        dovUnknownGenderUsers = dovGetUnknownGenderUsers(
          dovDiscoveryUsers,
          changes.__ai_gender_labels_v1.newValue,
        );
        dovRenderUnknownGenderUsers();
      });
    }
    if (changes.__ai_gender_users_v1) {
      dovFollowingUsers = dovGetFemaleFollowingUsers(
        changes.__ai_gender_users_v1.newValue,
        null
      );
    }
    if (changes[DEBUG_LOG_KEY]) {
      dovDebugLogs = Array.isArray(changes[DEBUG_LOG_KEY].newValue) ? changes[DEBUG_LOG_KEY].newValue : [];
      dovRenderDebugLogs();
    }
    if (changes[CANDIDATE_REPORTS_KEY]) {
      dovCandidateReports = Array.isArray(changes[CANDIDATE_REPORTS_KEY].newValue)
        ? changes[CANDIDATE_REPORTS_KEY].newValue : [];
      dovRenderCandidateReports();
    }

    const cfgChg = Object.entries(changes).find(
      ([, v]) => v.newValue && typeof v.newValue === 'object' && 'todayCount' in (v.newValue || {})
    );
    if (cfgChg) {
      const cfg = cfgChg[1].newValue;
      document.getElementById('dov-today').textContent = cfg.todayCount || 0;
      const m = cfg.maxPerDay || 840;
      document.getElementById('dov-limit').textContent = '/ ' + m + ' limit';
      document.getElementById('dov-prog').style.width = Math.min(100, ((cfg.todayCount || 0) / m) * 100) + '%';
      if (cfg.discoveryLastActionLabel || cfg.lastActionLabel) {
        document.getElementById('dov-last-action').style.display = 'flex';
        document.getElementById('dov-la-val').textContent = cfg.discoveryLastActionLabel || cfg.lastActionLabel;
        document.getElementById('dov-la-ts').textContent = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      }
      dovCandidateReports = Array.isArray(cfg[CANDIDATE_REPORTS_KEY]) ? cfg[CANDIDATE_REPORTS_KEY] : [];
      dovCandidateLastScanAt = Number(cfg.lastScanAt) || 0;
      dovRenderCandidateReports();
      dovRenderTable();
    }
  });
}

// ── Background'dan gelen anlık durum güncellemeleri ─────────────────────
if (chrome && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'IG_AUTO_STATUS') {
      dovLoadData();
    }
  });
}

// ── Dashboard açıkken düzenli aralıklarla yenile (yedek: 2 sn) ──────────
setInterval(() => {
  const overlay = document.getElementById('dash-overlay');
  if (overlay && overlay.classList.contains('open')) {
    dovLoadData();
  }
}, 2000);

// ── Olay dinleyicileri (MV3 CSP: inline onclick yasak) ───────────────
document.addEventListener('DOMContentLoaded', function () {
  const fab = document.getElementById('dash-fab');
  if (fab) fab.addEventListener('click', openDashboard);

  const refreshBtn = document.getElementById('dovRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', dovLoadData);
  const reanalyzeUnknownBtn = document.getElementById('dov-reanalyze-unknown-btn');
  if (reanalyzeUnknownBtn) reanalyzeUnknownBtn.addEventListener('click', dovReanalyzeUnknownGender);
  const dashboardAnalyzeBtn = document.getElementById('dov-dashboard-analyze-btn');
  if (dashboardAnalyzeBtn) dashboardAnalyzeBtn.addEventListener('click', dovAnalyzeDashboardAccounts);

  const tabBar = document.querySelector('.dov-tab-bar');
  if (tabBar) {
    tabBar.addEventListener('click', function (event) {
      const btn = event.target.closest('.dov-tab');
      if (!btn || !tabBar.contains(btn)) return;
      dovTab(btn.getAttribute('data-tab'), btn);
    });
  }

  dovSetActivityView('likes');
    const title = document.querySelector('.dov-log-card .dov-log-head-title');
    if (title) title.textContent = 'Beğeni Geçmişi';
});
