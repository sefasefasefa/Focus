// background.js — Takipçi Paneli Service Worker (MV3)
'use strict';

import './env.js';
import {
  classifyGenderUsers as classifyGenderUsersShared,
  getGenderProviderStatus,
  normalizeGender,
} from './gender-logic.js';

// ── Global hata yakalama ──────────────────────────────────────────────
self.addEventListener('unhandledrejection', event => {
  event.preventDefault();
  try { console.warn('[Takipçi Paneli] Yakalanmayan promise hatası:', String(event.reason ?? '').slice(0, 200)); } catch {}
});
self.addEventListener('error', event => {
  event.preventDefault();
  try { console.warn('[Takipçi Paneli] Global hata:', String(event.error ?? event.message ?? '').slice(0, 200)); } catch {}
});

// ── Sabitler ─────────────────────────────────────────────────────────
const ALARM_AUTOLIKE  = 'ig-autolike';
const ALARM_AUTOLIKE_START = 'ig-autolike-start';
const ALARM_DISCOVERY_START = 'ig-discovery-start';
const ALARM_DISCOVERY = 'ig-discovery';
const ALARM_KEEPALIVE = 'ig-keepalive';
const ALARM_REFRESH_INSTAGRAM = 'ig-refresh-instagram';
const STATE_KEY       = 'igAutoState';
const LOG_KEY         = '__analytics_log';
const DEBUG_LOG_KEY   = '__automation_debug_log';
const LIKED_KEY       = '__liked_media_ids';
const LIKED_CAP       = 5000; // son 5000 benzer ID'yi "zaten beğenilmiş" say
// Automation API requests share one conservative queue so independent
// automation flows cannot send Instagram requests concurrently.
// This is a safety control, not an attempt to bypass Instagram enforcement.
const IG_REQUEST_MIN_GAP_MS = 10 * 1000;
// Mutual-follower discovery is more sensitive to endpoint-specific throttling.
// Keep its requests at least five minutes apart, including across worker restarts.
const IG_MUTUAL_FOLLOWERS_MIN_GAP_MS = 5 * 60 * 1000;
const IG_RATE_LIMIT_BLOCK_KEY = 'igRateLimitBlockedUntil';
const IG_MUTUAL_FOLLOWERS_BLOCK_KEY = 'igMutualFollowersBlockedUntil';
const IG_MUTUAL_FOLLOWERS_LAST_REQUEST_KEY = 'igMutualFollowersLastRequestAt';
const IG_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;
const IG_SESSION_PROBE_KEY = 'igSessionProbeAt';
const IG_SESSION_PROBE_MIN_GAP_MS = 60 * 1000;
const IG_MAX_FOLLOWING_PAGES = 4;
const IG_MAX_LIST_PAGE_SIZE = 50;
const DOC_ID_LATEST_KEY = 'latestInstagramDocId';
const DOC_ID_PROFILE_LATEST_KEY = 'latestInstagramProfileDocId';
const DOC_ID_PROFILE_CONTEXT_KEY = 'instagramProfileGraphQLContext';
const DOC_ID_HISTORY_KEY = 'instagramDocIdHistory';
const DOC_ID_HISTORY_LIMIT = 500;
const GRAPHQL_OPERATION_IDS_KEY = 'instagramGraphQLOperationIds';
const DISCOVERY_PROFILE_CACHE_KEY = '__discovery_profile_cache_v1';
const DISCOVERY_PROFILE_CACHE_TTL_MS = 15 * 60 * 1000;
const PROFILE_LOOKUP_TIMEOUT_MS = 75 * 1000;
const LICENSE_STATE_KEY = 'tpLicenseState';
const LICENSE_API_URL_KEY = 'tpLicenseApiBaseUrl';
const LICENSE_DEVICE_ID_KEY = 'tpLicenseDeviceId';
const INSTAGRAM_SESSION_CONSENT_KEY = 'tpInstagramSessionConsent';
const INSTAGRAM_SESSION_SYNC_ALARM = 'tp-instagram-session-sync';
const LICENSE_VALIDATION_CACHE_MS = 30 * 1000;
// Keep one compact summary for a whole browser activity burst. A short
// debounce produced several nearly identical lines while Instagram loaded
// the page in separate request batches.
const DOC_ID_CONSOLE_FLUSH_MS = 90 * 1000;

function getLicenseStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function setLicenseStorage(values) {
  return new Promise(resolve => chrome.storage.local.set(values, resolve));
}

function normalizeLicenseApiBase(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('API adresi geçerli bir URL olmalı.');
  }
  const isLocalHttp = url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('Güvenlik için API adresi HTTPS olmalı. HTTP yalnızca localhost için kullanılabilir.');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('API alanına yalnızca sunucunun kök adresini girin; ek yol veya giriş bilgisi eklemeyin.');
  }
  return url.origin;
}

async function getOrCreateLicenseDeviceId() {
  const stored = await getLicenseStorage([LICENSE_DEVICE_ID_KEY]);
  const current = String(stored[LICENSE_DEVICE_ID_KEY] || '');
  if (/^[a-zA-Z0-9_-]{16,128}$/.test(current)) return current;
  const created = crypto.randomUUID().replace(/-/g, '');
  await setLicenseStorage({ [LICENSE_DEVICE_ID_KEY]: created });
  return created;
}

async function licenseApiRequest(
  apiBase,
  endpoint,
  method = 'POST',
  body,
  accessToken = '',
  timeoutMs = 12_000,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiBase}${endpoint}`, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

async function postLicenseApi(apiBase, endpoint, body, accessToken = '', timeoutMs = 12_000) {
  return licenseApiRequest(apiBase, endpoint, 'POST', body, accessToken, timeoutMs);
}

async function getLicensePublicConfig(apiBaseUrl) {
  const apiBase = normalizeLicenseApiBase(apiBaseUrl);
  const response = await fetch(`${apiBase}/api/public-config`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, error: String(payload?.error || 'Paket bilgileri alınamadı.') };
  }
  return { ok: true, ...payload };
}

async function validateExtensionLicense(force = false) {
  const stored = await getLicenseStorage([LICENSE_STATE_KEY, LICENSE_API_URL_KEY]);
  const license = stored[LICENSE_STATE_KEY] || {};
  const rawBase = String(stored[LICENSE_API_URL_KEY] || license.apiBaseUrl || '');
  if (!rawBase || !license.accessToken) {
    return { active: false, message: 'Etkin deneme veya lisans bulunamadı. Ücretsiz hesap oluşturun ya da aylık lisans satın alın.' };
  }
  let apiBase;
  try {
    apiBase = normalizeLicenseApiBase(rawBase);
  } catch (error) {
    return { active: false, message: error.message };
  }
  const licenseExpiresAt = license.expiresAt == null ? null : Number(license.expiresAt);
  if (licenseExpiresAt && licenseExpiresAt <= Date.now()) {
    await chrome.storage.local.remove(LICENSE_STATE_KEY);
    const trialExpired = license.licenseType === 'trial';
    return {
      active: false,
      expired: true,
      trialExpired,
      message: trialExpired
        ? '7 günlük ücretsiz denemen sona erdi. Devam etmek için aylık lisans satın al.'
        : 'Lisans süreniz dolmuş.',
    };
  }
  const tokenExpiresAt = Number(license.tokenExpiresAt) || 0;
  const validatedAt = Number(license.validatedAt) || 0;
  if (
    !force
    && validatedAt + LICENSE_VALIDATION_CACHE_MS > Date.now()
    && tokenExpiresAt > Date.now() + 15_000
  ) {
    return {
      active: true,
      expiresAt: licenseExpiresAt,
      licenseType: String(license.licenseType || ''),
      apiBaseUrl: apiBase,
      accessToken: license.accessToken,
    };
  }
  try {
    if (tokenExpiresAt <= Date.now() + 15_000 && license.refreshToken) {
      const refreshed = await postLicenseApi(
        apiBase,
        '/api/license/refresh',
        { refreshToken: license.refreshToken },
      );
      if (refreshed.response.ok && refreshed.payload?.accessToken) {
        const nextLicense = {
          apiBaseUrl: apiBase,
          deviceId: license.deviceId || '',
          accessToken: refreshed.payload.accessToken,
          refreshToken: license.refreshToken,
          tokenExpiresAt: Date.now() + 9 * 60 * 1000,
          validatedAt: Date.now(),
          expiresAt: refreshed.payload.expiresAt == null
            ? null
            : Number(refreshed.payload.expiresAt),
          licenseType: String(refreshed.payload.licenseType || license.licenseType || ''),
        };
        await setLicenseStorage({
          [LICENSE_API_URL_KEY]: apiBase,
          [LICENSE_STATE_KEY]: nextLicense,
        });
        return {
          active: true,
          expiresAt: nextLicense.expiresAt,
          licenseType: nextLicense.licenseType,
          apiBaseUrl: apiBase,
          accessToken: nextLicense.accessToken,
        };
      }
      if ([401, 403].includes(refreshed.response.status)) {
        const trialExpired = refreshed.payload?.code === 'TRIAL_EXPIRED';
        if (trialExpired) {
          await setLicenseStorage({
            [LICENSE_STATE_KEY]: {
              ...license,
              licenseType: 'trial',
            },
          });
        } else {
          await chrome.storage.local.remove(LICENSE_STATE_KEY);
        }
        return {
          active: false,
          expired: refreshed.response.status === 403,
          trialExpired,
          message: String(refreshed.payload?.error || 'Lisans oturumu yenilenemedi. Tekrar etkinleştirin.'),
        };
      }
      if (!refreshed.response.ok) {
        return {
          active: false,
          message: String(refreshed.payload?.error || 'Lisans sunucusu token yenileme isteğini reddetti.'),
        };
      }
    }
    const { response, payload } = await postLicenseApi(
      apiBase,
      '/api/license/validate',
      {},
      license.accessToken,
    );
    if (!response.ok || !payload?.accessToken) {
      const trialExpired = payload?.code === 'TRIAL_EXPIRED';
      if (trialExpired) {
        await setLicenseStorage({
          [LICENSE_STATE_KEY]: {
            ...license,
            licenseType: 'trial',
          },
        });
      } else if (response.status === 401 || response.status === 403) {
        await chrome.storage.local.remove(LICENSE_STATE_KEY);
      }
      return {
        active: false,
        expired: response.status === 403,
        trialExpired,
        message: String(payload?.error || 'Lisans doğrulanamadı.'),
      };
    }
    const nextLicense = {
      apiBaseUrl: apiBase,
      deviceId: license.deviceId || '',
      accessToken: payload.accessToken,
      refreshToken: license.refreshToken || '',
      tokenExpiresAt: Date.now() + 9 * 60 * 1000,
      validatedAt: Date.now(),
      expiresAt: payload.expiresAt == null ? null : Number(payload.expiresAt),
      licenseType: String(payload.licenseType || license.licenseType || ''),
    };
    await setLicenseStorage({
      [LICENSE_API_URL_KEY]: apiBase,
      [LICENSE_STATE_KEY]: nextLicense,
    });
    return {
      active: true,
      expiresAt: nextLicense.expiresAt,
      licenseType: nextLicense.licenseType,
      apiBaseUrl: apiBase,
      accessToken: nextLicense.accessToken,
    };
  } catch {
    return {
      active: false,
      message: 'Lisans sunucusuna ulaşılamıyor. İnternet ve API adresini kontrol edin.',
    };
  }
}

async function requireActiveLicense() {
  const status = await validateExtensionLicense();
  if (!status.active) {
    const error = new Error(status.message || 'Bu işlem için etkin bir lisans gerekli.');
    error.code = 'LICENSE_REQUIRED';
    throw error;
  }
  return status;
}

const INSTAGRAM_SESSION_COOKIE_NAMES = [
  'sessionid',
  'csrftoken',
  'ds_user_id',
  'rur',
  'mid',
  'ig_did',
];

async function readCurrentInstagramSession() {
  const records = await new Promise((resolve, reject) => {
    try {
      chrome.cookies.getAll({ domain: 'instagram.com' }, cookies => {
        const error = chrome.runtime?.lastError;
        if (error) reject(new Error(error.message || 'Instagram oturumu okunamadı.'));
        else resolve(Array.isArray(cookies) ? cookies : []);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const cookies = {};
  for (const record of records) {
    if (
      INSTAGRAM_SESSION_COOKIE_NAMES.includes(record?.name) &&
      typeof record.value === 'string' &&
      record.value &&
      cookies[record.name] === undefined
    ) {
      cookies[record.name] = record.value;
    }
  }
  if (!cookies.sessionid || !cookies.csrftoken || !cookies.ds_user_id) {
    throw new Error('Instagram oturumu bulunamadı. Tarayıcıda Instagram hesabına giriş yapın.');
  }
  return {
    instagramUserId: String(cookies.ds_user_id),
    cookies,
  };
}

async function getInstagramSessionStatus() {
  const license = await requireActiveLicense();
  const { response, payload } = await licenseApiRequest(
    license.apiBaseUrl,
    '/api/instagram/session',
    'GET',
    undefined,
    license.accessToken,
  );
  if (!response.ok || payload?.ok !== true) {
    throw new Error(String(payload?.error || 'Instagram oturum durumu alınamadı.'));
  }
  return payload;
}

async function linkInstagramSession() {
  const license = await requireActiveLicense();
  const session = await readCurrentInstagramSession();
  const { response, payload } = await postLicenseApi(
    license.apiBaseUrl,
    '/api/instagram/session',
    {
      ...session,
      consent: true,
      consentVersion: 'instagram-session-v1',
    },
    license.accessToken,
  );
  if (!response.ok || payload?.ok !== true || payload?.linked !== true) {
    throw new Error(String(payload?.error || 'Instagram oturumu bağlanamadı.'));
  }
  await setLicenseStorage({ [INSTAGRAM_SESSION_CONSENT_KEY]: true });
  chrome.alarms?.create(INSTAGRAM_SESSION_SYNC_ALARM, { periodInMinutes: 5 });
  return payload;
}

async function syncInstagramSessionSnapshot() {
  const stored = await getLicenseStorage([INSTAGRAM_SESSION_CONSENT_KEY]);
  if (stored[INSTAGRAM_SESSION_CONSENT_KEY] !== true) return { ok: false, skipped: true };
  const license = await requireActiveLicense();
  const session = await readCurrentInstagramSession();
  const { response, payload } = await licenseApiRequest(
    license.apiBaseUrl,
    '/api/instagram/session',
    'PATCH',
    session,
    license.accessToken,
  );
  if (!response.ok || payload?.ok !== true || payload?.linked !== true) {
    throw new Error(String(payload?.error || 'Instagram oturumu güncellenemedi.'));
  }
  return payload;
}

async function unlinkInstagramSession() {
  const license = await requireActiveLicense();
  const { response, payload } = await licenseApiRequest(
    license.apiBaseUrl,
    '/api/instagram/session',
    'DELETE',
    undefined,
    license.accessToken,
  );
  if (!response.ok || payload?.ok !== true) {
    throw new Error(String(payload?.error || 'Instagram oturumu kaldırılamadı.'));
  }
  await chrome.storage.local.remove(INSTAGRAM_SESSION_CONSENT_KEY);
  chrome.alarms?.clear(INSTAGRAM_SESSION_SYNC_ALARM);
  return payload;
}

function serializeInstagramRequestBody(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof body === 'object') {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(body)) {
      if (Array.isArray(value)) {
        for (const item of value) params.append(name, String(item));
      } else if (value !== undefined && value !== null) {
        params.set(name, String(value));
      }
    }
    return params.toString();
  }
  return String(body);
}

async function instagramServerRequest(endpoint, params, method = 'GET', body, headers = {}) {
  const consent = await getLicenseStorage([INSTAGRAM_SESSION_CONSENT_KEY]);
  if (consent[INSTAGRAM_SESSION_CONSENT_KEY] !== true) {
    throw new Error('Instagram işlemleri için lisans sayfasından sunucu oturumuna açık onay verin.');
  }
  const session = await readCurrentInstagramSession();
  let license = await requireActiveLicense();
  const requestBody = {
    endpoint,
    params: params || {},
    method: String(method || 'GET').toUpperCase(),
    body: serializeInstagramRequestBody(body),
    headers,
    session,
  };
  let result = await postLicenseApi(
    license.apiBaseUrl,
    '/api/instagram/request',
    requestBody,
    license.accessToken,
    32_000,
  );
  if (result.response.status === 401) {
    license = await validateExtensionLicense(true);
    if (!license.active) throw new Error(license.message || 'Lisans doğrulanamadı.');
    result = await postLicenseApi(
      license.apiBaseUrl,
      '/api/instagram/request',
      requestBody,
      license.accessToken,
      32_000,
    );
  }
  if (!result.response.ok) {
    throw new Error(String(result.payload?.error || 'Instagram API sunucusuna ulaşılamadı.'));
  }
  const upstreamStatus = Number(result.payload?.status) || 0;
  const responseText = String(result.payload?.text || '').replace(/^for\s*\(;;\);\s*/, '');
  if (result.payload?.ok !== true) {
    const redirectType = String(result.payload?.redirectType || '');
    const message = redirectType === 'login'
      ? 'Instagram isteği giriş sayfasına yönlendirdi. Aynı tarayıcı profilinde Instagram’a giriş yapın; ardından lisans merkezinde sunucudaki oturumu silip yeniden bağlayın.'
      : redirectType === 'verification'
        ? 'Instagram ek doğrulama istedi. Tarayıcıda doğrulamayı tamamlayın; ardından lisans merkezinde sunucudaki oturumu silip yeniden bağlayın.'
        : /login_required|checkpoint_required/i.test(responseText)
          ? 'Instagram oturumu geçersiz veya doğrulama istiyor. Instagram’a giriş yaptıktan sonra tekrar deneyin.'
          : upstreamStatus >= 300 && upstreamStatus < 400
            ? `Instagram isteği başka bir adrese yönlendirdi (HTTP ${upstreamStatus}). Oturum ve istek yolunu kontrol edin.`
            : upstreamStatus === 429
              ? 'Instagram istek sınırı uyguladı. Bir süre bekleyip tekrar deneyin.'
              : `Instagram isteği başarısız oldu (HTTP ${upstreamStatus || 'bilinmiyor'}).`;
    const error = new Error(message);
    Object.assign(error, {
      status: upstreamStatus || result.response.status,
      retryAfter: String(result.payload?.retryAfter || ''),
      endpoint,
    });
    throw error;
  }
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Instagram geçerli JSON yanıtı vermedi (HTTP ${upstreamStatus || 'bilinmiyor'}).`);
  }
  if (
    data?.message === 'login_required' ||
    data?.error_type === 'login_required' ||
    data?.require_login === true
  ) {
    throw new Error('Instagram oturumu geçersiz veya doğrulama istiyor. Instagram’a giriş yaptıktan sonra tekrar deneyin.');
  }
  if (data?.status === 'fail') {
    throw new Error(String(data.message || data.error_title || 'Instagram isteği reddetti.'));
  }
  return data;
}

chrome.alarms?.onAlarm.addListener(alarm => {
  if (alarm?.name !== INSTAGRAM_SESSION_SYNC_ALARM) return;
  syncInstagramSessionSnapshot().catch(() => {});
});

let instagramSessionSyncTimer = null;
chrome.cookies?.onChanged.addListener(change => {
  if (!INSTAGRAM_SESSION_COOKIE_NAMES.includes(change?.cookie?.name)) return;
  if (!String(change?.cookie?.domain || '').includes('instagram.com')) return;
  clearTimeout(instagramSessionSyncTimer);
  instagramSessionSyncTimer = setTimeout(() => {
    getLicenseStorage([INSTAGRAM_SESSION_CONSENT_KEY])
      .then(stored => {
        if (stored[INSTAGRAM_SESSION_CONSENT_KEY] !== true) return;
        syncInstagramSessionSnapshot().catch(error => {
          if (/Instagram oturumu bulunamadı/i.test(String(error?.message || error))) {
            unlinkInstagramSession().catch(() => {});
          }
        });
      })
      .catch(() => {});
  }, 1200);
});

chrome.runtime?.onStartup.addListener(() => {
  getLicenseStorage([INSTAGRAM_SESSION_CONSENT_KEY])
    .then(stored => {
      if (stored[INSTAGRAM_SESSION_CONSENT_KEY] === true) {
        chrome.alarms?.create(INSTAGRAM_SESSION_SYNC_ALARM, { periodInMinutes: 5 });
      }
    })
    .catch(() => {});
});

async function classifyWithLicensedServer(input) {
  let license = await requireActiveLicense();
  let { response, payload } = await postLicenseApi(
    license.apiBaseUrl,
    '/api/ai/gender',
    input,
    license.accessToken,
  );
  if (response.status === 401) {
    license = await validateExtensionLicense(true);
    if (!license.active) throw new Error(license.message || 'Lisans doğrulanamadı.');
    ({ response, payload } = await postLicenseApi(
      license.apiBaseUrl,
      '/api/ai/gender',
      input,
      license.accessToken,
    ));
  }
  if (!response.ok || !Array.isArray(payload?.results)) {
    throw new Error(String(payload?.error || 'AI sunucusundan geçerli yanıt alınamadı.'));
  }
  return payload;
}
const MAX_PER_HOUR = 35;
const MAX_PER_DAY = MAX_PER_HOUR * 24;
// Discovery can fan out into many profile-list requests. Keep this
// deliberately conservative; this is a safety ceiling, not a ban guarantee.
const DISCOVERY_MAX_PER_DAY_CAP = MAX_PER_DAY;
const DISCOVERY_DEFAULT_PER_DAY = MAX_PER_DAY;
const DISCOVERY_MAX_PER_HOUR_CAP = MAX_PER_HOUR;
const DISCOVERY_DEFAULT_PER_HOUR = MAX_PER_HOUR;
// This quota is for follow requests, not for merely scanning candidates.
const DISCOVERY_QUOTA_KEY = '__follow_request_daily_quota_v1';
const DISCOVERY_QUEUE_KEY = '__discovery_queue_v3';
const DISCOVERY_MANUAL_RESULTS_KEY = '__discovery_manual_results_v1';
const DISCOVERY_HISTORY_KEY = '__discovery_history_v1';
const IG_GQL_CONTEXT_TTL_MS = 8 * 60 * 1000;
const IG_REFRESH_MIN_MS = 5 * 60 * 1000;
const IG_REFRESH_MAX_MS = 10 * 60 * 1000;
let _igRequestQueue = Promise.resolve();
let _igMutualRequestQueue = Promise.resolve();
let _likeTriggeredDiscoveryInFlight = false;
let _pendingLikeTriggeredDiscoverySource = null;
const GENDER_STATE_KEY = '__ai_gender_state_v1';
let _discoveryQuotaQueue = Promise.resolve();
let _lastDiscoverySkipSignature = '';
let _followingCacheComplete = false;
const _profileLookupWaiters = new Map();
// The panel, startup probe, and the refresh button can all request the same
// profile refresh within one event-loop turn. Share one promise so a stale
// GraphQL context is not hit twice and the fallback chain does not race itself.
let _refreshUserDataInFlight = null;
const _profileLogLastAt = new Map();
const _discoveryProfileInFlight = new Map();
const _docIdCaptureCounts = new Map();
let _docIdCaptureTotal = 0;
let _docIdCaptureLatest = '';
let _docIdConsoleTimer = null;
let _docIdCaptureQueue = Promise.resolve();

function istanbulDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
  }).format(new Date());
}

function withDiscoveryQuota(task) {
  const run = _discoveryQuotaQueue.then(task);
  _discoveryQuotaQueue = run.catch(() => {});
  return run;
}

async function getDiscoveryQuota() {
  const day = istanbulDay();
  const stored = await new Promise(resolve =>
    chrome.storage.local.get([DISCOVERY_QUOTA_KEY], resolve)
  );
  const current = stored[DISCOVERY_QUOTA_KEY];
  return current?.day === day
    ? { day, count: Math.max(0, Number(current.count) || 0) }
    : { day, count: 0 };
}

async function consumeDiscoveryQuota() {
  return withDiscoveryQuota(async () => {
    const quota = await getDiscoveryQuota();
    const state = await getState();
    const dailyLimit = state.discoveryMaxPerDay;
    const hourlyLimit = state.discoveryMaxPerHour;
    const now = Date.now();
    const hourStart = Number(state.discoveryHourlyWindowStart) || 0;
    const hourlyCount = now - hourStart >= 60 * 60 * 1000
      ? 0
      : Number(state.discoveryHourlyCount) || 0;
    if (quota.count >= dailyLimit) return { allowed: false, ...quota, dailyLimit, hourlyLimit, reason: 'daily' };
    if (hourlyCount >= hourlyLimit) {
      return { allowed: false, ...quota, dailyLimit, hourlyLimit, reason: 'hourly' };
    }
    const next = { day: quota.day, count: quota.count + 1 };
    await new Promise(resolve =>
      chrome.storage.local.set({ [DISCOVERY_QUOTA_KEY]: next }, resolve)
    );
    await patchState({
      discoveryTodayCount: next.count,
      discoveryHourlyCount: hourlyCount + 1,
      discoveryHourlyWindowStart: hourlyCount === 0 ? now : (hourStart || now),
    });
    return {
      allowed: true,
      ...next,
      dailyLimit,
      hourlyLimit,
      dailyRemaining: Math.max(0, dailyLimit - next.count),
    };
  });
}

async function classifyGenderInBackground(users, options = {}) {
  await requireActiveLicense();
  const inputUsers = Array.isArray(users) ? users : [];
  const stored = await new Promise(resolve =>
    chrome.storage.local.get(['__ai_gender_labels_v1', LICENSE_API_URL_KEY], resolve)
  );
  const labels = stored.__ai_gender_labels_v1 || {};
  const providerStatus = getGenderProviderStatus(stored[LICENSE_API_URL_KEY]);
  const pending = inputUsers.filter(user => {
    const id = String(user?.pk ?? user?.id ?? user?.user_id ?? user?.username ?? '');
    const username = String(user?.username || '').replace(/^@/, '').toLowerCase();
    const label = labels[id] || labels[username] || labels[`u:${username}`];
    const retryableSource = [
      'local-fallback',
      'username-name-signal',
      'name-signal',
      'local-fallback-after-ai',
      'ai-unavailable',
      'no-provider',
    ].includes(String(label?.source || ''));
    return options.force
      || !label
      || retryableSource
      || !['male', 'female'].includes(normalizeGender(label.gender));
  });
  if (!providerStatus.available) {
    await appendDebugLog('info', 'Cinsiyet analizi atlandı — AI sağlayıcısı eklenmemiş', {
      candidateCount: inputUsers.length,
      pendingCount: pending.length,
      provider: 'none',
      action: 'Lisans sunucusu ayarlanmamış; kayıtlar Belirsiz bırakıldı',
    });
    return inputUsers.map(user => ({
      ...user,
      gender: 'unknown',
      gender_confidence: 0,
      source: 'no-provider',
    }));
  }
  await appendDebugLog('info', 'Bay/kadın cinsiyet kontrolü başladı', {
    candidateCount: inputUsers.length,
    pendingCount: pending.length,
    candidates: pending.map(user => `@${user.username}`),
    profilePhotoCount: pending.filter(user => Boolean(
      user?.profile_pic_url_hd
        || user?.profile_pic_url
        || user?.hd_profile_pic_url_info?.url
    )).length,
    action: 'kullanıcı adı, profil metni ve mevcut profil fotoğrafı analiz ediliyor',
  });
  let results = [];
  try {
    const response = await classifyGenderUsersShared(inputUsers, {
      ...options,
      requestAI: classifyWithLicensedServer,
      onProviderError: diagnostic => appendDebugLog(
        diagnostic?.status === 429 || diagnostic?.status === 503 ? 'warn' : 'error',
        'AI sağlayıcısından HTTP hata yanıtı alındı',
        diagnostic,
      ),
    });
    results = response.results || [];
  } catch (error) {
    await appendDebugLog('warn', `Cinsiyet etiketi kullanılamadı: ${String(error?.message ?? error).slice(0, 160)}`);
  }
  // Keep the original candidate object if a classifier response is malformed.
  // The shared classifier normally returns one result for every input user.
  if (results.length !== inputUsers.length) {
    results = inputUsers.map(user => ({
      ...user,
      gender: user.gender || 'unknown',
      gender_confidence: Number(user.gender_confidence) || 0,
      source: providerStatus.available ? 'ai-unavailable' : 'no-provider',
      classification_error: providerStatus.available
        ? 'AI sunucusu geçerli bir sonuç döndürmedi'
        : 'AI sağlayıcısı kullanılamıyor',
    }));
  }
  const classificationErrorMessages = results
    .map(user => String(user.classification_error || '').trim())
    .filter(Boolean);
  const classificationErrors = [...new Set(classificationErrorMessages)];
  await appendDebugLog('info', 'Bay/kadın cinsiyet kontrolü tamamlandı', {
    candidateCount: results.length,
    femaleCount: results.filter(user => user.gender === 'female').length,
    maleCount: results.filter(user => user.gender === 'male').length,
    unknownCount: results.filter(user => user.gender === 'unknown').length,
    classificationErrorCount: classificationErrorMessages.length,
    uniqueClassificationErrorCount: classificationErrors.length,
    classificationErrors: classificationErrors.slice(0, 3),
    action: providerStatus.available
      ? 'Lisanslı API sunucusu üzerinden profil sınıflandırıldı'
      : 'Lisanslı API sunucusu yapılandırılmamış',
  });
  return results;
}

function getGenderState() {
  return new Promise(resolve => chrome.storage.local.get([GENDER_STATE_KEY], stored => {
    resolve(stored[GENDER_STATE_KEY] || {
      enabled: false, running: false, scanned: 0, male: 0, female: 0, unknown: 0,
      message: 'Hazır',
    });
  }));
}

async function setGenderState(patch) {
  const current = await getGenderState();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await new Promise(resolve => chrome.storage.local.set({ [GENDER_STATE_KEY]: next }, resolve));
  return next;
}

async function updateDiscoveryGenderState(label, targetGender = 'female') {
  const current = await getGenderState();
  const gender = ['male', 'female', 'unknown'].includes(label?.gender)
    ? label.gender
    : 'unknown';
  const target = ['female', 'male', 'both'].includes(targetGender) ? targetGender : 'female';
  const isTarget = gender === 'female'
    ? target === 'female' || target === 'both'
    : gender === 'male'
      ? target === 'male' || target === 'both'
      : false;
  return setGenderState({
    // This is a discovery sub-step now; there is no separate gender switch.
    enabled: true,
    running: false,
    scanned: (Number(current.scanned) || 0) + 1,
    male: (Number(current.male) || 0) + (gender === 'male' ? 1 : 0),
    female: (Number(current.female) || 0) + (gender === 'female' ? 1 : 0),
    unknown: (Number(current.unknown) || 0) + (gender === 'unknown' ? 1 : 0),
    message: gender === 'unknown'
      ? 'Cinsiyet belirsiz; takip isteği gönderilmedi'
      : isTarget
        ? `${gender === 'female' ? 'Kadın' : 'Erkek'} aday bulundu; takip isteği kontrol ediliyor`
        : `${gender === 'female' ? 'Kadın' : 'Erkek'} aday seçili hedef değil; takip isteği gönderilmedi`,
  });
}
let _lastIgRequestStartedAt = 0;
let _lastMutualFollowersRequestStartedAt = 0;
let _igRequestBlockedUntil = 0;
let _igMutualFollowersBlockedUntil = 0;
let _lastMutualCooldownLogUntil = 0;
let _domStoryLikeInFlight = false;
let _sessionProbeInFlight = false;
let _igRefreshInFlight = null;

function extractGraphQLDocId(details) {
  const formData = details.requestBody?.formData;
  const fromForm = formData?.doc_id?.[0]
    ?? formData?.docId?.[0]
    ?? formData?.query_id?.[0]
    ?? formData?.queryId?.[0];
  if (fromForm) return String(fromForm);
  return extractGraphQLRequestField(details, 'doc_id')
    || extractGraphQLRequestField(details, 'docId')
    || extractGraphQLRequestField(details, 'query_id')
    || extractGraphQLRequestField(details, 'queryId');
}

function extractGraphQLRequestField(details, fieldName) {
  const formData = details.requestBody?.formData;
  const fromForm = formData?.[fieldName]?.[0];
  if (fromForm != null) return String(fromForm);

  try {
    const urlValue = new URL(details.url).searchParams.get(fieldName);
    if (urlValue != null) return String(urlValue);
  } catch {}

  try {
    const raw = details.requestBody?.raw?.[0]?.bytes;
    if (!raw) return '';
    const body = typeof raw === 'string'
      ? raw
      : new TextDecoder().decode(new Uint8Array(raw));
    try {
      const parsed = JSON.parse(body);
      const object = Array.isArray(parsed) ? parsed[0] : parsed;
      const value = object?.[fieldName]
        ?? (fieldName === 'doc_id' ? object?.docId : undefined)
        ?? (fieldName === 'doc_id' ? object?.query_id : undefined)
        ?? (fieldName === 'doc_id' ? object?.queryId : undefined)
        ?? (fieldName === 'fb_api_req_friendly_name' ? object?.operationName : undefined);
      if (value != null) return String(value);
    } catch {}
    return new URLSearchParams(body).get(fieldName) ?? '';
  } catch {
    return '';
  }
}

function extractGraphQLFriendlyName(details) {
  return extractGraphQLRequestField(details, 'fb_api_req_friendly_name')
    || extractGraphQLRequestField(details, 'friendly_name')
    || extractGraphQLRequestField(details, 'operationName');
}

function extractGraphQLVariables(details) {
  const rawVariables = extractGraphQLRequestField(details, 'variables');
  if (!rawVariables) return null;
  try {
    const parsed = JSON.parse(rawVariables);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function isProfileGraphQLOperation(details, friendlyName = '', variables = null) {
  const normalizedFriendlyName = String(friendlyName || '').trim();
  // A profile page also fires helper queries for notes, highlights, school
  // badges, suggested users, posts, and inbox eligibility. They can contain
  // an `id`/`igid` variable but do not return the profile dictionary. Only
  // PolarisProfilePageContentQuery is the profile response observed in the
  // successful browser HAR.
  if (/Polaris(?:ProfileNoteBubble|ProfileStoryHighlights|ProfileSuggestedUsers|SchoolPartnerProfileBadge|ProfilePosts|ProfileDirectOrPartnershipInbox|QuickPromotion)/i.test(normalizedFriendlyName)) {
    return false;
  }
  if (/PolarisProfilePageContentQuery/i.test(normalizedFriendlyName)) {
    return true;
  }
  const source = [
    normalizedFriendlyName,
    details?.url,
    details?.documentUrl,
    details?.initiator,
    variables ? JSON.stringify(variables) : '',
  ].join(' ');
  if (/PolarisProfilePageContent|profilepagecontent|profile.?page.?content|profile.?query|user.?info|user.?profile/i.test(source)) {
    return true;
  }
  const hasProfileIdentity = variables &&
    ['id', 'userID', 'user_id', 'igid', 'profile_id']
      .some(key => Object.prototype.hasOwnProperty.call(variables, key));
  const isListOperation = /followers|following|edge_followed_by|edge_follow/i.test(source);
  const isProfilePage = /instagram\.com\/[^/?#]+\/?(?:[?#]|$)/i.test(
    String(details?.documentUrl || ''),
  );
  // Current Instagram builds sometimes omit the old
  // enable_integrity_filters flag and use a new friendly name. An identity
  // variable on a profile document is still a reliable profile-query signal.
  if (hasProfileIdentity && !isListOperation && (isProfilePage || /profile|user.?info/i.test(source))) {
    return true;
  }
  return false;
}

function flushGraphQLDocIdConsoleSummary() {
  _docIdConsoleTimer = null;
  if (!_docIdCaptureTotal) return;

  const list = [..._docIdCaptureCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([docId, count]) => `${docId} (${count}x)`)
    .join(', ');
  const suffix = _docIdCaptureCounts.size > 20 ? ', …' : '';
  console.log(
    `[+] YAKALANDI ${_docIdCaptureTotal}x doc_id | son: ${_docIdCaptureLatest} | liste: ${list}${suffix}`,
  );
  _docIdCaptureCounts.clear();
  _docIdCaptureTotal = 0;
  _docIdCaptureLatest = '';
}

function queueGraphQLDocIdConsoleSummary(docId) {
  const normalized = String(docId || '').trim();
  if (!normalized) return;
  _docIdCaptureCounts.set(normalized, (_docIdCaptureCounts.get(normalized) || 0) + 1);
  _docIdCaptureTotal += 1;
  _docIdCaptureLatest = normalized;
  if (_docIdConsoleTimer) clearTimeout(_docIdConsoleTimer);
  _docIdConsoleTimer = setTimeout(flushGraphQLDocIdConsoleSummary, DOC_ID_CONSOLE_FLUSH_MS);
}

function recordGraphQLDocId(
  docId,
  friendlyName = '',
  variables = null,
  isProfile = false,
) {
  const normalized = String(docId || '').trim();
  if (!normalized) return;
  const normalizedFriendlyName = String(friendlyName || '').trim();
  queueGraphQLDocIdConsoleSummary(normalized);
  _docIdCaptureQueue = _docIdCaptureQueue
    .then(async () => {
      const stored = await new Promise(resolve =>
        chrome.storage.local.get({
          [DOC_ID_HISTORY_KEY]: [],
          [GRAPHQL_OPERATION_IDS_KEY]: {},
        }, resolve)
      );
      const history = Array.isArray(stored[DOC_ID_HISTORY_KEY])
        ? stored[DOC_ID_HISTORY_KEY]
        : [];
      const capturedAt = new Date().toISOString();
      const previous = history.find(item => String(item?.doc_id || '') === normalized);
      const entry = {
        doc_id: normalized,
        timestamp: capturedAt,
        count: (Number(previous?.count) || 0) + 1,
      };
      const nextHistory = [
        entry,
        ...history.filter(item => String(item?.doc_id || '') !== normalized),
      ].slice(0, DOC_ID_HISTORY_LIMIT);
      const operationKey = getTrackedGraphQLOperationKey(normalizedFriendlyName);
      const operationIds = stored[GRAPHQL_OPERATION_IDS_KEY] &&
        typeof stored[GRAPHQL_OPERATION_IDS_KEY] === 'object' &&
        !Array.isArray(stored[GRAPHQL_OPERATION_IDS_KEY])
        ? { ...stored[GRAPHQL_OPERATION_IDS_KEY] }
        : {};
      if (operationKey) {
        const operationCapture = {
          doc_id: normalized,
          friendly_name: normalizedFriendlyName,
          variables: variables && typeof variables === 'object' ? variables : null,
          timestamp: capturedAt,
        };
        operationIds[operationKey] = operationCapture;
        if (normalizedFriendlyName) operationIds[normalizedFriendlyName] = operationCapture;
        const operationNames = Object.keys(operationIds);
        while (operationNames.length > 120) {
          delete operationIds[operationNames.shift()];
        }
      }
      await new Promise(resolve => chrome.storage.local.set({
        [DOC_ID_LATEST_KEY]: entry,
        [DOC_ID_HISTORY_KEY]: nextHistory,
        [GRAPHQL_OPERATION_IDS_KEY]: operationIds,
        ...(isProfile || /PolarisProfilePageContentQuery/i.test(normalizedFriendlyName)
          ? {
              [DOC_ID_PROFILE_LATEST_KEY]: entry,
              ...(variables ? {
                [DOC_ID_PROFILE_CONTEXT_KEY]: {
                  doc_id: normalized,
                  friendly_name: normalizedFriendlyName,
                  variables,
                  capturedAt,
                },
              } : {}),
            }
          : {} ),
      }, resolve));
    })
    .catch(() => {});
}

function isSupportedProfilePostsOperation(friendlyName) {
  return /^PolarisProfilePosts(?:TabContentQuery(?:_connection)?|Query(?:_connection)?)$/.test(
    String(friendlyName || '').trim(),
  );
}

function getTrackedGraphQLOperationKey(friendlyName) {
  const name = String(friendlyName || '').trim();
  if (isSupportedProfilePostsOperation(name)) {
    return 'posts';
  }
  if (/^PolarisProfileReelsTabContentQuery(?:_connection)?$/.test(name)) {
    return 'reels';
  }
  if (name === 'PolarisAPILikePostMutation') return 'postLike';
  return '';
}

async function getCapturedGraphQLOperation(operationKey, fallbackDocId = '') {
  await _docIdCaptureQueue.catch(() => {});
  const stored = await new Promise(resolve =>
    chrome.storage.local.get([GRAPHQL_OPERATION_IDS_KEY], resolve)
  );
  const operationIds = stored?.[GRAPHQL_OPERATION_IDS_KEY] || {};
  const aliases = {
    posts: [
      'PolarisProfilePostsTabContentQuery_connection',
      'PolarisProfilePostsTabContentQuery',
      'PolarisProfilePostsQuery',
    ],
    reels: [
      'PolarisProfileReelsTabContentQuery',
      'PolarisProfileReelsTabContentQuery_connection',
    ],
    postLike: ['PolarisAPILikePostMutation'],
  }[operationKey] || [];
  const capture = aliases.map(name => operationIds[name]).find(Boolean) ||
    operationIds[operationKey] ||
    null;
  const capturedDocId = String(capture?.doc_id || '');
  const isCaptured = /^\d{10,20}$/.test(capturedDocId);
  const variables = capture?.variables && typeof capture.variables === 'object' &&
    !Array.isArray(capture.variables)
    ? capture.variables
    : null;
  return {
    docId: isCaptured ? capturedDocId : String(fallbackDocId || ''),
    variables,
    isCaptured,
    friendlyName: String(capture?.friendly_name || ''),
  };
}

  // Instagram'ın tarayıcıdan gönderdiği GraphQL isteklerinden doc_id
// değerini al ve tamamen uzantının yerel depolamasında sakla.
chrome.webRequest.onBeforeRequest.addListener(
  details => {
    if (!['POST', 'GET'].includes(details.method) || !details.url.includes('graphql')) return;

    const docId = extractGraphQLDocId(details);
    if (!docId) return;

    const friendlyName = extractGraphQLFriendlyName(details);
    const variables = extractGraphQLVariables(details);
    recordGraphQLDocId(
      docId,
      friendlyName,
      variables,
      isProfileGraphQLOperation(details, friendlyName, variables),
    );
  },
  { urls: ['*://*.instagram.com/*'] },
  ['requestBody'],
);

// Restore rate-limit cooldowns after an MV3 worker restart. Builds through
// 1.0.105 stored every 429 as a global lock; migrate that legacy lock to the
// mutual-followers endpoint, which is the endpoint reported by recent logs.
const _igRequestBlockReady = new Promise(resolve => {
  chrome.storage.local.get(
    [
      IG_RATE_LIMIT_BLOCK_KEY,
      IG_MUTUAL_FOLLOWERS_BLOCK_KEY,
      IG_MUTUAL_FOLLOWERS_LAST_REQUEST_KEY,
    ],
    stored => {
      void chrome.runtime.lastError;
      const now = Date.now();
      const legacyUntil = Number(stored?.[IG_RATE_LIMIT_BLOCK_KEY]) || 0;
      const savedMutualUntil = Number(stored?.[IG_MUTUAL_FOLLOWERS_BLOCK_KEY]) || 0;
      const savedMutualRequestAt = Number(stored?.[IG_MUTUAL_FOLLOWERS_LAST_REQUEST_KEY]) || 0;
      _lastMutualFollowersRequestStartedAt = Math.max(
        0,
        Math.min(savedMutualRequestAt, now),
      );
      _igRequestBlockedUntil = 0;
      _igMutualFollowersBlockedUntil = Math.max(
        legacyUntil > now ? legacyUntil : 0,
        savedMutualUntil > now ? savedMutualUntil : 0,
      );
      const removeKeys = [IG_RATE_LIMIT_BLOCK_KEY];
      if (_igMutualFollowersBlockedUntil <= now) removeKeys.push(IG_MUTUAL_FOLLOWERS_BLOCK_KEY);
      const finishMigration = () => {
        chrome.storage.local.remove(removeKeys, async () => {
          void chrome.runtime.lastError;
          if (legacyUntil > now) {
            const state = await getState().catch(() => null);
            if (state && Number(state.backoffUntil) > now) {
              await patchState({
                backoffUntil: 0,
                nextRunAt: 0,
                discoveryNextRunAt: _igMutualFollowersBlockedUntil,
                lastActionLabel: state.enabled
                  ? 'Beğeni otomasyonu çalışabilir; ortak hesap keşfi uç nokta beklemesinde'
                  : state.lastActionLabel,
                discoveryLastActionLabel: 'Ortak hesap keşfi beklemede; diğer otomasyonlar devam edebilir',
              }).catch(() => {});
            }
          }
          resolve();
        });
      };
      if (_igMutualFollowersBlockedUntil > now) {
        chrome.storage.local.set({
          [IG_MUTUAL_FOLLOWERS_BLOCK_KEY]: _igMutualFollowersBlockedUntil,
        }, finishMigration);
      } else {
        finishMigration();
      }
    },
  );
});

function isRateLimitCooldownError(error) {
  return String(error?.code || '') === 'IG_RATE_LIMIT_COOLDOWN';
}

function isMutualFollowersCooldownError(error) {
  return String(error?.code || '') === 'IG_MUTUAL_FOLLOWERS_COOLDOWN';
}

function isMutualFollowersOperation(operation) {
  return /\/mutual_followers\/?/i.test(String(operation || ''));
}

function makeRateLimitCooldownError() {
  const remainingMs = Math.max(0, _igRequestBlockedUntil - Date.now());
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  const error = new Error(`Instagram ortak kuyruğu beklemede — ${remainingMinutes} dk kaldı`);
  error.code = 'IG_RATE_LIMIT_COOLDOWN';
  return error;
}

function makeMutualFollowersCooldownError() {
  const remainingMs = Math.max(0, _igMutualFollowersBlockedUntil - Date.now());
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  const error = new Error(`Ortak hesap keşfi uç noktası beklemede — ${remainingMinutes} dk kaldı`);
  error.code = 'IG_MUTUAL_FOLLOWERS_COOLDOWN';
  return error;
}

function getRetryAfterMs(error, now = Date.now()) {
  const value = String(error?.retryAfter || '').trim();
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : 0;
  }
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : 0;
}

function getRateLimitBlockedUntil(error, now = Date.now()) {
  // Keep the existing conservative floor, but never retry before Instagram's
  // explicit Retry-After value when the server supplies one.
  return now + Math.max(IG_RATE_LIMIT_COOLDOWN_MS, getRetryAfterMs(error, now));
}

function enqueueInstagramRequest(operation, task) {
  const run = _igRequestQueue.then(async () => {
    // Restore persisted cooldowns before allowing a queued request.
    await _igRequestBlockReady;
    if (_igRequestBlockedUntil > Date.now()) throw makeRateLimitCooldownError();
    if (
      isMutualFollowersOperation(operation) &&
      _igMutualFollowersBlockedUntil > Date.now()
    ) {
      throw makeMutualFollowersCooldownError();
    }
    const isMutualFollowers = isMutualFollowersOperation(operation);
    const globalWaitMs = Math.max(
      0,
      IG_REQUEST_MIN_GAP_MS - (Date.now() - _lastIgRequestStartedAt),
    );
    if (globalWaitMs > 0) await sleep(globalWaitMs);
    const requestStartedAt = Date.now();
    _lastIgRequestStartedAt = requestStartedAt;
    if (isMutualFollowers) {
      _lastMutualFollowersRequestStartedAt = requestStartedAt;
      await new Promise(resolve => chrome.storage.local.set(
        { [IG_MUTUAL_FOLLOWERS_LAST_REQUEST_KEY]: requestStartedAt },
        () => {
          void chrome.runtime.lastError;
          resolve();
        },
      ));
    }
    try {
      return await task();
    } catch (error) {
      if (isRateLimitMessage(error)) {
        const diagnostic = {
          operation,
          status: error?.status != null && Number.isFinite(Number(error.status))
            ? Number(error.status)
            : null,
          statusText: String(error?.statusText || '').slice(0, 120),
          endpoint: String(error?.endpoint || '').slice(0, 500),
          retryAfter: String(error?.retryAfter || '').slice(0, 120),
          responseContentType: String(error?.responseContentType || '').slice(0, 160),
          responseReason: String(error?.responseReason || '').slice(0, 300),
          signal: String(error?.message ?? error).slice(0, 300),
        };
        const blockedUntil = getRateLimitBlockedUntil(error);
        if (isMutualFollowersOperation(operation)) {
          _igMutualFollowersBlockedUntil = Math.max(
            _igMutualFollowersBlockedUntil,
            blockedUntil,
          );
          if (error && typeof error === 'object') error.code = 'IG_MUTUAL_FOLLOWERS_COOLDOWN';
          await new Promise(resolve => chrome.storage.local.set({
            [IG_MUTUAL_FOLLOWERS_BLOCK_KEY]: _igMutualFollowersBlockedUntil,
          }, resolve));
          const cooldownMinutes = Math.max(
            1,
            Math.ceil((_igMutualFollowersBlockedUntil - Date.now()) / 60000),
          );
          await patchState({
            discoveryNextRunAt: _igMutualFollowersBlockedUntil,
            discoveryLastActionLabel: `Ortak hesap keşfi isteği sınırlandırıldı — ${cooldownMinutes} dk beklemede`,
          }).catch(() => {});
          broadcastStatus();
          appendDebugLog('warn', 'Instagram istek sınırı sinyali yalnızca mutual_followers uç noktasında alındı', {
            ...diagnostic,
            cooldownMinutes,
            scope: 'mutual_followers',
            action: 'keşif bekleyecek; beğeni ve diğer Instagram istekleri ortak sırada devam edebilir',
          }).catch(() => {});
        } else {
          _igRequestBlockedUntil = Math.max(_igRequestBlockedUntil, blockedUntil);
          await new Promise(resolve => chrome.storage.local.set({
            [IG_RATE_LIMIT_BLOCK_KEY]: _igRequestBlockedUntil,
          }, resolve));
          const cooldownMinutes = Math.max(
            1,
            Math.ceil((_igRequestBlockedUntil - Date.now()) / 60000),
          );
          await patchState({
            backoffUntil: _igRequestBlockedUntil,
            nextRunAt: _igRequestBlockedUntil,
            discoveryNextRunAt: _igRequestBlockedUntil,
            lastActionLabel: `Instagram istek sınırı uyguladı — otomasyonlar ${cooldownMinutes} dk bekleyecek`,
            discoveryLastActionLabel: `Instagram istek sınırı uyguladı — keşif ${cooldownMinutes} dk bekleyecek`,
          }).catch(() => {});
          broadcastStatus();
          appendDebugLog('warn', 'Instagram istek sınırı sinyali verdi; ortak istek kuyruğu geçici olarak duraklatıldı', {
            ...diagnostic,
            cooldownMinutes,
            action: 'bekleme süresince yeni Instagram isteği gönderilmeyecek',
          }).catch(() => {});
        }
      }
      throw error;
    }
  });
  // Keep the queue usable after a failed request without swallowing the error
  // returned to the caller.
  _igRequestQueue = run.catch(() => {});
  return run;
}

function withInstagramRequestSlot(operation, task) {
  if (!isMutualFollowersOperation(operation)) {
    return enqueueInstagramRequest(operation, task);
  }

  // Keep the five-minute mutual endpoint wait outside the shared Instagram
  // request queue. This spaces mutual calls without pausing likes, stories,
  // relationship checks, or other unrelated API requests.
  const run = _igMutualRequestQueue.then(async () => {
    await _igRequestBlockReady;
    if (_igRequestBlockedUntil > Date.now()) throw makeRateLimitCooldownError();
    if (_igMutualFollowersBlockedUntil > Date.now()) {
      throw makeMutualFollowersCooldownError();
    }
    const mutualWaitMs = Math.max(
      0,
      IG_MUTUAL_FOLLOWERS_MIN_GAP_MS -
        (Date.now() - _lastMutualFollowersRequestStartedAt),
    );
    if (mutualWaitMs > 0) await sleep(mutualWaitMs);
    return enqueueInstagramRequest(operation, task);
  });
  // Serialize only mutual requests; the general request queue remains free
  // while this endpoint-specific timer is waiting.
  _igMutualRequestQueue = run.catch(() => {});
  return run;
}

function clearLocalRateLimitCooldown() {
  if (
    _igRequestBlockedUntil > Date.now() ||
    _igMutualFollowersBlockedUntil > Date.now()
  ) return Promise.resolve(false);
  return new Promise(resolve => {
    chrome.storage.local.remove(
      [IG_RATE_LIMIT_BLOCK_KEY, IG_MUTUAL_FOLLOWERS_BLOCK_KEY],
      () => {
        void chrome.runtime.lastError;
        _igRequestBlockedUntil = 0;
        _igMutualFollowersBlockedUntil = 0;
        resolve(true);
      },
    );
  });
}

function isRateLimitMessage(error) {
  const message = String(error?.message ?? error ?? '');
  // Only explicit server signals are classified as rate-limit errors.
  // Generic phrases such as "please wait" and "try again later" also occur in
  // Instagram HTML/error shells and previously caused false positives.
  return /(?:\b429\b|http(?:\s|_)?429\b|feedback_required|action[_\s-]*blocked|rate[_\s-]*limit(?:ed|_required)?|too many requests|çok fazla istek|geçici olarak kısıtlandı)/i.test(message);
}

function isSessionError(error) {
  const message = String(error?.message ?? error ?? '');
  // A bare 403 is also used for anti-abuse/access restrictions. Treating every
  // 403 as a logout causes needless login prompts and repeated auth attempts.
  return /(?:\b401\b|login_required|session(?:id)?[_\s-]*(?:expired|invalid|required)|oturum süresi dolmuş|oturum geçersiz)/i.test(message);
}

function isAccessBlockedMessage(error) {
  const message = String(error?.message ?? error ?? '');
  return /(?:\b403\b|forbidden|checkpoint[_\s]required|challenge[_\s]required|feedback_required)/i.test(message);
}

function isAutomationStopError(error) {
  return isRateLimitMessage(error) ||
    isRateLimitCooldownError(error) ||
    isMutualFollowersCooldownError(error) ||
    isSessionError(error) ||
    isAccessBlockedMessage(error) ||
    isInstagramCheckpointError(error) ||
    isTransientTabIssue(error);
}

async function hasInstagramSessionCookie() {
  try {
    const direct = await new Promise(resolve =>
      chrome.cookies.get({ url: 'https://www.instagram.com', name: 'sessionid' }, resolve)
    );
    if (direct?.value) return true;
    const all = await chrome.cookies.getAll({ domain: 'instagram.com' });
    return all.some(cookie => cookie.name === 'sessionid' && cookie.value);
  } catch {
    return false;
  }
}

// ds_user_id is the authoritative account identity. The profile object in
// storage can be stale while the user is browsing another Instagram profile.
// Rate-limit state must be bound to this cookie, otherwise one account can
// inherit another account's cooldown (or a stale legacy timestamp).
async function getInstagramSessionUserId() {
  try {
    const cookie = await new Promise(resolve =>
      chrome.cookies.get({ url: 'https://www.instagram.com/', name: 'ds_user_id' }, resolve)
    );
    const cookieId = String(cookie?.value || '').trim();
    if (cookieId) return cookieId;
  } catch {}
  // Some Chromium profiles expose the cookie only through the domain filter.
  // Never fall back to igUser here: that value may already be a viewed
  // follower profile, which would turn a stale identity into a false one.
  try {
    const cookies = await chrome.cookies.getAll({
      domain: 'instagram.com',
      name: 'ds_user_id',
    });
    return String(cookies.find(cookie => cookie?.value)?.value || '').trim();
  } catch {}
  return '';
}

// Instagram checkpoint/doğrulama hataları — kullanıcı arayüzünden onay gerektirir.
// Bu hatalar bir kod hatası değil; kullanıcı Instagram'da manuel olarak
// doğrulama yaparsa otomasyon kaldığı yerden devam eder.
function isInstagramCheckpointError(error) {
  const message = String(error?.message ?? error ?? '');
  return /checkpoint[_\s]required|challenge[_\s]required|doğrulama gerekti|verification[_\s]required/i.test(message);
}

function isRemovedInstagramFrameError(error) {
  const message = String(error?.message ?? error ?? '');
  return /(?:frame with id \d+\s+(?:was\s+)?removed|no frame with id \d+)/i.test(message);
}

// Sekme/oturum kaynaklı geçici arızalar: executeScript'in null döndürmesi
// ("Yanıt boş") veya Instagram'ın API uç noktası yerine SPA'nın HTML
// kabuğunu döndürmesi ("beklenmeyen HTML sayfası"). İkisi de genelde 1-2
// deneme içinde kendiliğinden düzelir — gerçek bir hata değil, debug
// panelinde 'warn' olarak işaretlenmeli, 'error' olarak değil.
function isTransientTabIssue(error) {
  const message = String(error?.message ?? error ?? '');
  return message.includes('Yanıt boş')
    || message.includes('beklenmeyen HTML sayfası')
    || message.includes('HTML yanıt')   // REST endpoint'i JSON yerine HTML döndürdü
    || isRemovedInstagramFrameError(error);
}

function canUsePageFetchFallback(endpoint, method = 'GET') {
  if (String(method || 'GET').toUpperCase() !== 'GET') return false;
  const path = String(endpoint || '').split('?')[0];
  return /^\/api\/v1\/(?:friendships\/\d+\/(?:followers|following|mutual_followers)\/?|feed\/user\/(?:\d+\/?|[a-z0-9._]+\/username\/?))$/i
    .test(path);
}


// ── OPFS Kalıcı Log Yazıcısı ─────────────────────────────────────────
// Tüm olaylar automation_log.ndjson dosyasına sürekli eklenir.
// Dosya 1 GB'ı aşarsa otomatik olarak silinip yeniden oluşturulur.
// DevTools → Uygulama → Depolama → OPFS bölümünden erişilebilir.
const OPFS_LOG_FILE    = 'automation_log.ndjson';
const OPFS_SIZE_LIMIT  = 1_000_000_000; // 1 GB

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function opfsWriteLog(kind, entry) {
  try {
    const root        = await navigator.storage.getDirectory();
    const fileHandle  = await root.getFileHandle(OPFS_LOG_FILE, { create: true });
    const file        = await fileHandle.getFile();
    const currentSize = file.size;

    const line = JSON.stringify({ kind, ...entry }) + '\n';

    if (currentSize >= OPFS_SIZE_LIMIT) {
      // 1 GB aşıldı — eski dosyayı sil ve yenisini başlat
      try { await root.removeEntry(OPFS_LOG_FILE); } catch {}
      const freshHandle  = await root.getFileHandle(OPFS_LOG_FILE, { create: true });
      const freshWritable = await freshHandle.createWritable();
      await freshWritable.write(line);
      await freshWritable.close();
    } else {
      // Mevcut dosyanın sonuna ekle
      const writable = await fileHandle.createWritable({ keepExistingData: true });
      await writable.seek(currentSize);
      await writable.write(line);
      await writable.close();
    }
  } catch {
    // OPFS yazma hatası — sessizce geç; storage.local yedek olarak çalışmaya devam eder
  }
}

const DEFAULT_STATE = {
  enabled: false,
  // Keşif, like otomasyonundan bağımsız açılıp kapanır; açıkken adayları
  // like bekleme aralarında tek tek toplar.
  discoveryEnabled: false,
  discoveryRotateSources: true,
  discoveryMaxPerDay: DISCOVERY_DEFAULT_PER_DAY,
  discoveryMaxPerHour: DISCOVERY_DEFAULT_PER_HOUR,
  discoveryQuotaPolicyVersion: 2,
  discoveryHourlyCount: 0,
  discoveryHourlyWindowStart: 0,
  discoverySourceId: '',
  discoverySourceUsername: '',
  discoveryRelation: 'followers',
  discoveryMinMutualCount: 2,
  // AI sınıflandırması sonucunda takip isteği gönderilecek hesap türü.
  // Eski sürümlerdeki davranışı korumak için varsayılan yalnızca kadındır.
  discoveryTargetGender: 'female',
  discoveryFlowVersion: 5,
  discoveryNextRunAt: 0,
  discoveryTodayCount: 0,
  discoveryLastActionLabel: '',
  timeFrom: 0,
  timeTo: 24,
  minDelaySec: 65,
  maxDelaySec: 200,
  maxPerDay: MAX_PER_DAY,
  maxPerHour: MAX_PER_HOUR, // saatlik güvenlik sınırı
  targetType: 'reels',
  todayCount: 0,
  todayDate: '',
  hourlyCount: 0,           // mevcut saat dilimindeki beğeni sayısı
  hourlyWindowStart: 0,     // mevcut saat diliminin başlangıç zamanı (ms)
  nextRunAt: 0,
  backoffUntil: 0,
  consecutiveErrors: 0,
  lastActionLabel: '',
  batchSize: 5,             // otomatik — her 5 beğenide 1 mola (kod belirler)
  batchPauseSec: 300,       // otomatik — 5 dk bekleme (kod belirler)
  enabledContentTypes: ['story', 'post', 'reel'], // kullanıcı seçer
  sessionValid: false,
  sessionReason: '',
  sessionUsername: '',
  sessionUserId: '',
  sessionCheckedAt: 0,
};

function normalizeAutomationState(state) {
  const normalized = { ...DEFAULT_STATE, ...(state ?? {}) };
  normalized.discoveryRotateSources = state?.discoveryRotateSources !== false;
  const hasSavedMutualThreshold = state?.discoveryMinMutualCount !== undefined
    && state?.discoveryMinMutualCount !== null
    && state?.discoveryMinMutualCount !== '';
  normalized.discoveryMinMutualCount = hasSavedMutualThreshold
    ? normalizeDiscoveryMinMutualCount(state.discoveryMinMutualCount)
    : state?.discoveryRequireMutuals === false
      ? 0
      : DEFAULT_STATE.discoveryMinMutualCount;
  delete normalized.discoveryRequireMutuals;
  // v5 checks the entered profile's Instagram mutual-followers count.
  // Older queue-based discovery settings are migrated to this flow.
  if (Number(state?.discoveryFlowVersion) !== 5) {
    normalized.discoveryFlowVersion = 5;
    normalized.discoveryRelation = 'followers';
  }
  // Move older saved discovery limits to the 35/hour × 24 = 840/day policy.
  // v1 capped daily follows at 50, so migrate that old ceiling once; after
  // migration, users can still choose a lower daily value intentionally.
  if (Number(state?.discoveryQuotaPolicyVersion) !== 2) {
    if (Number(state?.discoveryMaxPerHour) === 5 && Number(state?.discoveryMaxPerDay) === 30) {
      normalized.discoveryMaxPerHour = DISCOVERY_DEFAULT_PER_HOUR;
      normalized.discoveryMaxPerDay = DISCOVERY_DEFAULT_PER_DAY;
    } else if (
      Number(state?.discoveryMaxPerHour) === DISCOVERY_DEFAULT_PER_HOUR
      && Number(state?.discoveryMaxPerDay) === 50
    ) {
      normalized.discoveryMaxPerDay = DISCOVERY_DEFAULT_PER_DAY;
    }
    normalized.discoveryQuotaPolicyVersion = 2;
  }
  // Treat these as hard safety bounds, not UI suggestions. Older builds and
  // direct storage edits must not be able to bypass the rate-limit guard.
  normalized.minDelaySec = Math.max(65, Math.min(3600, Number(normalized.minDelaySec) || DEFAULT_STATE.minDelaySec));
  normalized.maxDelaySec = Math.max(
    normalized.minDelaySec,
    Math.min(3600, Number(normalized.maxDelaySec) || DEFAULT_STATE.maxDelaySec),
  );
  normalized.maxPerDay = Math.max(1, Math.min(MAX_PER_DAY, Number(normalized.maxPerDay) || DEFAULT_STATE.maxPerDay));
  normalized.maxPerHour = Math.max(1, Math.min(MAX_PER_HOUR, Number(normalized.maxPerHour) || DEFAULT_STATE.maxPerHour));
  normalized.batchSize = Math.max(1, Math.min(10, Number(normalized.batchSize) || DEFAULT_STATE.batchSize));
  normalized.batchPauseSec = Math.max(300, Math.min(3600, Number(normalized.batchPauseSec) || DEFAULT_STATE.batchPauseSec));
  normalized.discoveryRelation = normalized.discoveryRelation === 'followers' ? 'followers' : 'following';
  normalized.discoveryTargetGender = ['female', 'male', 'both'].includes(normalized.discoveryTargetGender)
    ? normalized.discoveryTargetGender
    : 'female';
  normalized.discoverySourceId = String(normalized.discoverySourceId || '');
  normalized.discoverySourceUsername = String(normalized.discoverySourceUsername || '');
  normalized.discoveryTodayCount = Math.max(0, Number(normalized.discoveryTodayCount) || 0);
  normalized.discoveryMaxPerDay = Math.max(1, Math.min(
    Math.min(DISCOVERY_MAX_PER_DAY_CAP, (Number(normalized.discoveryMaxPerHour) || DISCOVERY_DEFAULT_PER_HOUR) * 24),
    Number(normalized.discoveryMaxPerDay) || DISCOVERY_DEFAULT_PER_DAY,
  ));
  normalized.discoveryMaxPerHour = Math.max(1, Math.min(
    DISCOVERY_MAX_PER_HOUR_CAP,
    Number(normalized.discoveryMaxPerHour) || DISCOVERY_DEFAULT_PER_HOUR,
  ));
  normalized.discoveryHourlyCount = Math.max(0, Number(normalized.discoveryHourlyCount) || 0);
  normalized.discoveryHourlyWindowStart = Math.max(0, Number(normalized.discoveryHourlyWindowStart) || 0);
  return normalized;
}

function normalizeDiscoveryMinMutualCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_STATE.discoveryMinMutualCount;
  return Math.max(0, Math.min(10000, Math.floor(parsed)));
}

function getDiscoveryMinMutualCount(state) {
  const saved = state?.discoveryMinMutualCount;
  if (saved !== undefined && saved !== null && saved !== '') {
    return normalizeDiscoveryMinMutualCount(saved);
  }
  return state?.discoveryRequireMutuals === false
    ? 0
    : DEFAULT_STATE.discoveryMinMutualCount;
}

function matchesDiscoveryMutualCount(actual, configured) {
  const expected = normalizeDiscoveryMinMutualCount(configured);
  if (expected === 0) return true;
  const observed = Number(actual);
  return Number.isFinite(observed) && observed >= expected;
}

// ── "Zaten beğenilmiş" medya ID'leri (tekrar beğenmemek için) ─────────
// Instagram'ın "PolarisProfileLikeListQuery" döndüğü zaman bile nadiren
// yakın tarihli bir içeriği geri getirebiliyor + getFollowing() zaten
// büyük liste döndürüyor. Bu yüzden istemci tarafında da bir "beğenildi"
// set tutarız: önceden beğenilen medya ID'leri cache'lenir, autolikeTick
// döngüsünde aday seçerken bunlar filtrelenir.
// Set service worker yeniden başladığında storage'dan geri yüklenir.
const _likedCache = new Set();
let _likedLoaded = false;
let _likedPersistTimer = null;

async function loadLikedCache() {
  if (_likedLoaded) return;
  try {
    const stored = await new Promise(resolve => chrome.storage.local.get([LIKED_KEY], resolve));
    const arr = Array.isArray(stored[LIKED_KEY]) ? stored[LIKED_KEY] : [];
    for (const e of arr) {
      if (e && e.id) _likedCache.add(String(e.id));
    }
    _likedLoaded = true;
  } catch {
    _likedLoaded = true; // hata olsa bile sonsuza dek retry yapma
  }
}

function markLiked(mediaId) {
  if (!mediaId) return;
  const id = String(mediaId);
  if (_likedCache.has(id)) return;
  _likedCache.add(id);
  scheduleLikedPersist();
}

function scheduleLikedPersist() {
  if (_likedPersistTimer) return;
  _likedPersistTimer = setTimeout(() => {
    _likedPersistTimer = null;
    persistLikedCache().catch(() => {});
  }, 4000);
}

async function persistLikedCache() {
  try {
    const stored = await new Promise(resolve => chrome.storage.local.get([LIKED_KEY], resolve));
    const existing = Array.isArray(stored[LIKED_KEY]) ? stored[LIKED_KEY] : [];
    const now = Date.now();
    const existingIds = new Set(existing.map(e => e && e.id).filter(Boolean));
    const merged = existing.slice();
    for (const id of _likedCache) {
      if (!existingIds.has(id)) {
        merged.push({ id, ts: now });
        existingIds.add(id);
      }
    }
    merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const capped = merged.slice(0, LIKED_CAP);
    await chrome.storage.local.set({ [LIKED_KEY]: capped });
  } catch {
    // bir sonraki tick'te tekrar dener
  }
}

// Service worker yeniden başladığında cache'i geri yükle
chrome.runtime.onStartup?.addListener(() => {
  _likedCache.clear();
  _likedLoaded = false;
  loadLikedCache().catch(() => {});
});
chrome.runtime.onInstalled?.addListener(() => {
  loadLikedCache().catch(() => {});
});
// İlk mesajda da yüklemeyi tetikle (SW zaten ayakta olabilir)
loadLikedCache().catch(() => {});

// ── Storage yardımcıları ──────────────────────────────────────────────
function getState() {
  return new Promise(resolve =>
    chrome.storage.local.get([STATE_KEY], data => {
      const saved = data[STATE_KEY] ?? {};
      const state = normalizeAutomationState(saved);
      // Unconditionally enforce 24/7 — automation never has a time window.
      state.timeFrom = 0;
      state.timeTo = 24;
      // Clear any stale schedule-related label from older builds.
      if (state.lastActionLabel && (
        state.lastActionLabel.includes('izin verilen saatler') ||
        state.lastActionLabel.includes('Pencere dışı') ||
        state.lastActionLabel === 'Takip edilen adaylarda beğenilmemiş içerik bulunamadı'
      )) {
        state.lastActionLabel = 'Otomasyon 24 saat aktif — yeniden başlatıldı';
      }
      chrome.storage.local.set({ [STATE_KEY]: state });
      resolve(state);
    })
  );
}

function patchState(patch) {
  return new Promise(resolve =>
    chrome.storage.local.get([STATE_KEY], data => {
      const current = normalizeAutomationState(data[STATE_KEY]);
      chrome.storage.local.set({ [STATE_KEY]: normalizeAutomationState({ ...current, ...patch }) }, resolve);
    })
  );
}

async function appendLikeLog(type, username, label, thumbnailUrl = '', mediaId = '') {
  const entry = {
    ts: Date.now(),
    date: todayStr(),
    type,
    count: 1,
    username,
    label: `${label} (${username})`,
    thumbnailUrl,
    mediaId: mediaId ? String(mediaId) : '',
  };
  writeExtensionConsole('info', `${label}: @${username}`, {
    type,
    mediaId: mediaId ? String(mediaId) : '',
    action: 'beğeni gönderildi',
  });
  // Kalıcı OPFS dosyasına yaz
  opfsWriteLog('like', entry).catch(() => {});
  // Dashboard için storage.local kaydını koru
  const stored = await new Promise(resolve => chrome.storage.local.get([LOG_KEY], resolve));
  const log = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  const duplicate = log.some(item =>
    item?.label === entry.label && Math.abs(Number(item.ts) - entry.ts) < 10000
  );
  if (!duplicate) {
    await new Promise(resolve =>
      chrome.storage.local.set({ [LOG_KEY]: [entry, ...log].slice(0, 2000) }, resolve)
    );
  }
}

let _consoleLogSequence = 0;

function writeExtensionConsole(level, message, context = {}) {
  const sequence = ++_consoleLogSequence;
  const timestamp = new Date().toISOString();
  const prefix = `[Takipçi Paneli #${String(sequence).padStart(5, '0')}]`;
  const text = `${prefix} ${timestamp} ${String(message)}`;
  try {
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    if (context && Object.keys(context).length) {
      // Chromium collapses plain objects to "Object" in the console. Keep the
      // diagnostic visible even when the user does not expand the log entry.
      console[method](text, JSON.stringify(context));
    } else {
      console[method](text);
    }
  } catch {
    // Konsol logu otomasyonu hiçbir zaman durdurmamalı.
  }
}

async function appendDebugLog(level, message, context = {}) {
  const entry = {
    ts: Date.now(),
    date: todayStr(),
    level,
    message: String(message).slice(0, 500),
    context: JSON.parse(JSON.stringify(context, (_key, value) => {
      if (typeof value === 'string' && value.length > 300) return value.slice(0, 300) + '…';
      return value;
    })),
  };
  // Console kaydı storage/OPFS yazımını beklemeden alınır; paralel akışlarda
  // kullanıcıya çağrı sırasını bozmadan gösterilir.
  writeExtensionConsole(level, entry.message, entry.context);
  // Kalıcı OPFS dosyasına yaz
  opfsWriteLog('debug', entry).catch(() => {});
  // Dashboard için storage.local kaydını koru
  const stored = await new Promise(resolve => chrome.storage.local.get([DEBUG_LOG_KEY], resolve));
  const logs = Array.isArray(stored[DEBUG_LOG_KEY]) ? stored[DEBUG_LOG_KEY] : [];
  await new Promise(resolve => {
    chrome.storage.local.set({ [DEBUG_LOG_KEY]: [entry, ...logs].slice(0, 500) }, () => {
      // Chrome may expose a storage error through lastError in the callback.
      // Consume it so a diagnostic log can never break the service worker.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

// Keşif logları hem dashboard'daki kalıcı debug listesine hem de
// chrome://extensions > Service Worker > Console bölümüne düşer. Context
// nesnesi özellikle "nereye baktı / kaç sonuç buldu / neyi eledi" sorularını
// cevaplamak için bilerek düz ve okunabilir tutulur.
function appendDiscoveryLog(level, message, context = {}) {
  const { phase = 'discovery', ...details } = context || {};
  return appendDebugLog(level, `Keşif | ${message}`, { phase, ...details });
}

function isPortClosedError(error) {
  const msg = String(error?.message ?? error ?? '');
  return msg.includes('message port') || msg.includes('Receiving end') || msg.includes('No tab with id');
}

function sendTabMessageSilently(tabId, message) {
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      // A panel or content script may legitimately be gone while a tab is
      // navigating. Reading lastError in the callback prevents Chrome from
      // printing an "Unchecked runtime.lastError" warning.
      void chrome.runtime.lastError;
    });
  } catch {
    // The tab can close between query and send; this notification is best
    // effort and must not interrupt automation.
  }
}

async function runGraphQLMutationUnqueuedLegacy(
  docId,
  variables,
  friendlyName,
  endpointPath = '/api/graphql',
) {
  return runGraphQLMutationUnqueued(docId, variables, friendlyName, endpointPath);

  const storage = await new Promise(resolve =>
    chrome.storage.local.get(['igUser', 'igGqlTokens'], resolve)
  );
  const igUser      = storage.igUser;
  let igGqlTokens = storage.igGqlTokens?.fbDtsg &&
    storage.igGqlTokens?.lsd &&
    storage.igGqlTokens?.csrf &&
    storage.igGqlTokens?.ts &&
    Date.now() - Number(storage.igGqlTokens.ts) < IG_GQL_CONTEXT_TTL_MS
    ? storage.igGqlTokens
    : null;
  // Instagram web mutations use the Graph API actor ID (fbid_v2), not the
  // numeric media-owner PK. The HAR captured by the user sends the same
  // fbid_v2 value in both `av` and `input.actor_id`.
  const userId      = String(igUser?.fbid_v2 ?? igUser?.pk ?? igUser?.id ?? '');
  const userIdSource = igUser?.fbid_v2
    ? 'fbid_v2'
    : igUser?.pk
      ? 'pk'
      : igUser?.id
        ? 'id'
        : 'missing';

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tabId = await getInstagramTab();
    if (!igGqlTokens) {
      try {
        igGqlTokens = await refreshInstagramContext(tabId, true);
      } catch (contextError) {
        await appendDebugLog('warn', 'Instagram token bağlamı yenilenemedi', {
          operation: friendlyName,
          error: contextError?.message ?? String(contextError),
        });
      }
    }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (docId, variablesStr, friendlyNameArg, endpointPathArg, actorId, fbDtsg, lsd, csrf) => {
          const win = window;
          let dtsg = fbDtsg, lsdTok = lsd;
          try { dtsg   = win.require?.('DTSGInitData')?.token ?? fbDtsg; } catch {}
          try { lsdTok = win.require?.('LSD')?.token ?? lsd; } catch {}
          let csrfTok = csrf;
          try {
            const pageCsrf = document.cookie
              .split(';')
              .find(value => value.trim().startsWith('csrftoken='))
              ?.split('=')
              .slice(1)
              .join('=') ?? '';
            if (pageCsrf) csrfTok = decodeURIComponent(pageCsrf);
          } catch {}
          if (!dtsg || !lsdTok || !csrfTok) {
            return { ok: false, error: 'Instagram sayfa tokenları eksik — sekmeyi yenileyip tekrar dene' };
          }

          const jazoest   = '2' + String(Array.from(dtsg).reduce((a, c) => a + c.charCodeAt(0), 0));
          const variables = JSON.parse(variablesStr);
          if (variables.input && (!variables.input.actor_id || variables.input.actor_id === '__actor_id__')) {
            variables.input.actor_id = actorId;
          }

          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 20000);

          const resp = await fetch(`https://www.instagram.com${endpointPathArg}`, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'x-asbd-id': '359341',
              'x-csrftoken': csrfTok,
              'x-fb-lsd': lsdTok,
              'x-fb-friendly-name': friendlyNameArg,
              'x-ig-app-id': '936619743392459',
              'x-ig-max-touch-points': '0',
            },
            body: new URLSearchParams({
              av: actorId, __d: 'www', __user: '0', __a: '1',
              __req: '1', __comet_req: '7',
              fb_dtsg: dtsg, jazoest, lsd: lsdTok,
              variables: JSON.stringify(variables),
              doc_id: docId,
              fb_api_caller_class: 'RelayModern',
              fb_api_req_friendly_name: friendlyNameArg,
              server_timestamps: 'true',
            }).toString(),
            signal: ctrl.signal,
          });

          const text = await resp.text();
          const responseContentType = String(resp.headers.get('content-type') || '').slice(0, 120);
          const responseMeta = {
            status: resp.status,
            contentType: responseContentType,
          };
          if (!text || text.trimStart().startsWith('<')) {
            return {
              ok: false,
              error: resp.status === 429
                ? 'Instagram istek sınırı uyguladı (HTTP 429)'
                : `HTML yanıt (${resp.status})`,
              ...responseMeta,
            };
          }
          try {
            const json = JSON.parse(text.replace(/^for\s*\(;;\);\s*/, ''));
            if (!resp.ok) {
              return {
                ok: false,
                error: `HTTP ${resp.status}: ${json.errors?.[0]?.message ?? json.message ?? JSON.stringify(json).slice(0, 300)}`,
                ...responseMeta,
              };
            }
            const graphqlErrors = Array.isArray(json.errors) ? json.errors : [];
            if (graphqlErrors.length) {
              const isPostsOperation =
                /^PolarisProfilePosts(?:TabContentQuery(?:_connection)?|Query(?:_connection)?)$/.test(
                  String(friendlyNameArg || '').trim(),
                );
              const postEdges =
                json.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges;
              const hasUsablePostData =
                isPostsOperation &&
                Array.isArray(postEdges) &&
                postEdges.some(edge => {
                  const media = edge?.node;
                  return Boolean(
                    media &&
                    typeof media === 'object' &&
                    (media.pk != null || media.id != null) &&
                    (
                      media.media_type != null ||
                      media.image_versions2 != null ||
                      media.video_versions != null ||
                      media.caption != null ||
                      media.product_type != null ||
                      media.taken_at != null ||
                      media.carousel_media != null
                    )
                  );
                });
              const onlyOptionalLocationPhotoErrors = graphqlErrors.every(error => {
                const path = error?.path;
                return Array.isArray(path) &&
                  path.length >= 2 &&
                  path[path.length - 2] === 'location' &&
                  path[path.length - 1] === 'profile_pic_url';
              });
              if (hasUsablePostData && onlyOptionalLocationPhotoErrors) {
                return {
                  ok: true,
                  // The outer callGraphQLMutation validates `data.errors`
                  // before returning to fetchProfilePosts. Clear only this
                  // already-validated optional field error so valid media
                  // results are not rejected a second time. Keep the count
                  // separately for diagnostics above.
                  data: { ...json, errors: [] },
                  partialGraphQLErrorCount: graphqlErrors.length,
                  partialGraphQLErrorPath: 'location.profile_pic_url',
                  ...responseMeta,
                };
              }
              const firstError = graphqlErrors[0];
              const errorMessage = firstError?.message ?? JSON.stringify(graphqlErrors);
              const errorPath = Array.isArray(firstError?.path)
                ? firstError.path
                    .map(part => {
                      if (typeof part === 'number') return '[index]';
                      return typeof part === 'string' &&
                        /^[A-Za-z_][A-Za-z0-9_]*$/.test(part)
                        ? part
                        : '[segment]';
                    })
                    .join('.')
                    .slice(0, 180)
                : '';
              return {
                ok: false,
                error: `${errorMessage}${errorPath ? ` (GraphQL path: ${errorPath})` : ''}`,
                ...responseMeta,
              };
            }
            // Instagram checkpoint/doğrulama yanıtı: {"__ar":1,"error":NNNN,"errorSummary":"...","errorDescription":"..."}
            // Bu format json.data olmadan gelir; ham JSON yerine okunabilir mesaj döndür.
            if (json.__ar === 1 && json.error) {
              const summary = json.errorSummary ?? json.errorDescription ?? `Instagram hata kodu ${json.error}`;
              return {
                ok: false,
                error: `Instagram API hatası (${json.error}): ${summary}`,
                ...responseMeta,
              };
            }
            if (json.data == null) {
              return {
                ok: false,
                error: `GraphQL data boş: ${JSON.stringify(json).slice(0, 300)}`,
                ...responseMeta,
              };
            }
            return { ok: true, data: json, ...responseMeta };
          } catch {
            return {
              ok: false,
              error: `GraphQL yanıtı çözümlenemedi (${resp.status})`,
              ...responseMeta,
            };
          }
        },
        args: [docId, JSON.stringify(variables), friendlyName, endpointPath, userId,
               igGqlTokens?.fbDtsg ?? '', igGqlTokens?.lsd ?? '', igGqlTokens?.csrf ?? ''],
      });

      const executionResults = Array.isArray(results) ? results : [];
      const res = executionResults[0]?.result;
      if (res?.partialGraphQLErrorCount > 0) {
        await appendDebugLog('warn', 'Gönderi yanıtında isteğe bağlı profil fotoğrafı alanı hatalı; gönderi verisi korundu', {
          operation: friendlyName,
          partialErrorCount: res.partialGraphQLErrorCount,
          partialErrorPath: res.partialGraphQLErrorPath,
        });
      }
      if (!res?.ok) {
        const frameResults = executionResults.slice(0, 8).map(entry => {
          const frameId = Number(entry?.frameId);
          const status = Number(entry?.result?.status);
          return {
            frameId: Number.isFinite(frameId) ? frameId : null,
            resultPresent: entry?.result !== undefined,
            ok: typeof entry?.result?.ok === 'boolean' ? entry.result.ok : null,
            httpStatus: Number.isFinite(status) ? status : null,
            contentType: String(entry?.result?.contentType || '').slice(0, 120),
            hasExecutionError: Boolean(entry?.error),
            executionErrorName: String(entry?.error?.name || '').slice(0, 80),
          };
        });
        const errMsg = String(
          res?.error ||
          (executionResults.length
            ? 'GraphQL executeScript sonucu boş veya ok=false'
            : 'GraphQL executeScript sıfır sonuç döndürdü'),
        );
        const isRateLimitedResponse = isRateLimitMessage(errMsg);
        await appendDebugLog(
          isRateLimitedResponse ? 'warn' : 'error',
          isRateLimitedResponse
            ? 'Instagram istek sınırı nedeniyle GraphQL işlemini reddetti'
            : 'GraphQL executeScript sonucu eksik veya başarısız',
          {
          operation: friendlyName,
          docId,
          actorIdAvailable: Boolean(userId),
          actorIdSource: userIdSource,
          resultCount: executionResults.length,
          frameResults,
          error: errMsg.slice(0, 240),
          },
        );
        throw new Error(errMsg);
      }
      return res.data;
    } catch (error) {
      lastError = error;
      if (isPortClosedError(error) && attempt === 0) {
        await appendDebugLog('warn', 'GraphQL executeScript bağlantı hatası, yeniden deneniyor', {
          docId, friendlyName, error: error.message,
        });
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function runGraphQLMutationUnqueued(
  docId,
  variables,
  friendlyName,
  endpointPath = '/api/graphql',
) {
  const stored = await new Promise(resolve =>
    chrome.storage.local.get(['igUser', 'igGqlTokens'], resolve)
  );
  let tokens = stored.igGqlTokens;
  if (
    !tokens?.fbDtsg ||
    !tokens?.lsd ||
    Date.now() - Number(tokens.ts) >= IG_GQL_CONTEXT_TTL_MS
  ) {
    const tabId = await getInstagramTab();
    tokens = await refreshInstagramContext(tabId, true);
  }
  if (!tokens?.fbDtsg || !tokens?.lsd) {
    throw new Error('Instagram GraphQL sayfa tokenları alınamadı. Instagram sekmesini yenileyin.');
  }

  const actorId = String(
    stored.igUser?.fbid_v2 ?? stored.igUser?.pk ?? stored.igUser?.id ?? '',
  );
  if (!actorId) throw new Error('Instagram kullanıcı kimliği bulunamadı.');
  const gqlVariables = JSON.parse(JSON.stringify(variables || {}));
  if (
    gqlVariables.input &&
    (!gqlVariables.input.actor_id || gqlVariables.input.actor_id === '__actor_id__')
  ) {
    gqlVariables.input.actor_id = actorId;
  }
  const jazoest = `2${Array.from(String(tokens.fbDtsg))
    .reduce((sum, char) => sum + char.charCodeAt(0), 0)}`;
  const body = new URLSearchParams({
    av: actorId,
    __d: 'www',
    __user: '0',
    __a: '1',
    __req: '1',
    __comet_req: '7',
    fb_dtsg: String(tokens.fbDtsg),
    jazoest,
    lsd: String(tokens.lsd),
    variables: JSON.stringify(gqlVariables),
    doc_id: String(docId),
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: String(friendlyName || ''),
    server_timestamps: 'true',
  });
  return instagramServerRequest(
    endpointPath,
    {},
    'POST',
    body,
    {
      'content-type': 'application/x-www-form-urlencoded',
      'x-asbd-id': '359341',
      'x-fb-dtsg': String(tokens.fbDtsg),
      'x-fb-friendly-name': String(friendlyName || ''),
      'x-fb-lsd': String(tokens.lsd),
      'x-ig-app-id': '936619743392459',
      'x-ig-max-touch-points': '0',
    },
  );
}

async function runGraphQLMutation(
  docId,
  variables,
  friendlyName,
  endpointPath = '/api/graphql',
) {
  return withInstagramRequestSlot(
    `graphql:${endpointPath}:${friendlyName || docId}`,
    () => runGraphQLMutationUnqueued(docId, variables, friendlyName, endpointPath),
  );
}

async function callGraphQLMutation(
  docId,
  variables,
  friendlyName,
  endpointPath = '/api/graphql',
) {
  try {
    const data = await runGraphQLMutation(docId, variables, friendlyName, endpointPath);
    if (!data || typeof data !== 'object') throw new Error('GraphQL veri gövdesi boş');
    if (Array.isArray(data.errors) && data.errors.length) {
      throw new Error(data.errors.map(error => error?.message || JSON.stringify(error)).join(' | '));
    }
    return data;
  } catch (error) {
    const errorMessage = String(error?.message ?? error ?? '');
    // 1357004 is commonly caused by a stale page context/doc_id pair.
    // Refresh the page-owned tokens and retry once; never loop indefinitely.
    if (/\b1357004\b/.test(errorMessage)) {
      await new Promise(resolve => chrome.storage.local.remove(['igGqlTokens'], resolve));
      try {
        const tabId = await getInstagramTab();
        await refreshInstagramContext(tabId, true);
        const retried = await runGraphQLMutation(docId, variables, friendlyName, endpointPath);
        if (!retried || typeof retried !== 'object') {
          throw new Error('GraphQL yeniden denemesinde veri gövdesi boş');
        }
        return retried;
      } catch (retryError) {
        await appendDebugLog('warn', 'GraphQL bağlam yenileme sonrası tekrar başarısız', {
          operation: friendlyName,
          docId,
          error: retryError?.message ?? String(retryError),
        });
        error = retryError;
      }
    }
    // Rate-limit ve checkpoint hataları beklenen Instagram korumaları — 'warn' yeterli.
    const isSoftError = isRateLimitMessage(error) || isInstagramCheckpointError(error);
    await appendDebugLog(isSoftError ? 'warn' : 'error', error.message || error, {
      operation: friendlyName,
      docId,
      variables,
    });
    throw error;
  }
}

// ── REST v1 beğeni (doc_id bağımsız, daha kararlı) ───────────────────
// Instagram'ın GraphQL beğeni mutasyonları sabit (hardcoded) doc_id değerlerine
// bağlıdır. Instagram web uygulamasını güncellediğinde bu ID'ler değişir ve
// eski ID ile gelen her istek 1357004 ("Üzgünüz, bir hata oluştu") hatasıyla
// reddedilir — kullanıcı Instagram'da herhangi bir doğrulama ekranı GÖRMEZ
// çünkü bu bir challenge değil, "bilinmeyen sorgu" reddidir.
// Mobil uygulamaların kullandığı REST v1 endpoint'i doc_id gerektirmez ve
// bu yüzden çok daha kararlıdır.
async function likeMediaWithRESTUnqueuedLegacy(mediaId) {
  return likeMediaWithRESTUnqueued(mediaId);

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tabId = await getInstagramTab();
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (mediaId) => {
          const csrf = document.cookie.split(';')
            .find(c => c.trim().startsWith('csrftoken='))
            ?.split('=').slice(1).join('=') ?? '';
          if (!csrf) return { ok: false, error: 'CSRF token bulunamadı — instagram.com sekmesinde oturum açık mı?' };

          // Instagram'ın API'si için gerekli token'ları sayfadan al
          const win = window;
          let lsd = '';
          let wwwClaim = '0';
          try { lsd = win.require?.('LSD')?.token ?? ''; } catch {}
          try { wwwClaim = win.require?.('IGSCRP')?.claimValue ?? win.__wwwClaim ?? '0'; } catch {}

          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 20000);

          let resp;
          try {
            resp = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/like/`, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'x-csrftoken': csrf,
                'x-ig-app-id': '936619743392459',
                'x-requested-with': 'XMLHttpRequest',
                'content-type': 'application/x-www-form-urlencoded',
                'x-asbd-id': '359341',
                ...(lsd ? { 'x-fb-lsd': lsd } : {}),
                'x-ig-www-claim': wwwClaim,
              },
              body: new URLSearchParams({ d: '1' }).toString(),
              signal: ctrl.signal,
            });
          } catch (e) {
            return { ok: false, error: 'fetch hatası: ' + String(e?.message ?? e) };
          }

          const text = await resp.text();
          if (!text || text.trimStart().startsWith('<')) {
            return {
              ok: false,
              error: resp.status === 429
                ? 'Instagram istek sınırı uyguladı (HTTP 429)'
                : `HTML yanıt (${resp.status}) — Instagram sekmeye yönlendirdi`,
            };
          }
          try {
            const json = JSON.parse(text);
            if (json.status === 'ok') return { ok: true };
            const msg = json.message ?? json.error_title ?? JSON.stringify(json).slice(0, 200);
            return { ok: false, error: `REST beğeni reddedildi (${resp.status}): ${msg}`, status: resp.status };
          } catch {
            return { ok: false, error: text.slice(0, 200), status: resp.status };
          }
        },
        args: [String(mediaId)],
      });

      const res = results[0]?.result;
      if (!res) throw new Error('Yanıt boş');
      if (!res.ok) throw new Error(res.error ?? `REST beğeni başarısız (${res.status})`);
      return true;
    } catch (error) {
      lastError = error;
      if ((isPortClosedError(error) || isTransientTabIssue(error)) && attempt === 0) {
        await appendDebugLog('warn', 'REST beğeni bağlantı hatası, yeniden deneniyor', { mediaId, error: error.message });
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function likeMediaWithRESTUnqueued(mediaId) {
  const data = await instagramServerRequest(
    `/api/v1/media/${encodeURIComponent(mediaId)}/like/`,
    {},
    'POST',
    { d: '1' },
    {
      'content-type': 'application/x-www-form-urlencoded',
      'x-asbd-id': '359341',
      'x-ig-app-id': '936619743392459',
      'x-requested-with': 'XMLHttpRequest',
    },
  );
  if (data?.status !== 'ok') {
    throw new Error(String(data?.message || data?.error_title || 'Beğeni isteği Instagram tarafından reddedildi.'));
  }
  return true;
}

async function likeMediaWithREST(mediaId) {
  await requireActiveLicense();
  return withInstagramRequestSlot(
    `like:${mediaId}`,
    () => likeMediaWithRESTUnqueued(mediaId),
  );
}

async function likeMediaWithGraphQL(mediaId, type) {
  await requireActiveLicense();
  // Use the same first-party GraphQL mutations as the Instagram web client.
  // Prefer the doc_id captured from Instagram's own matching operation; the
  // HAR value is only a bootstrap fallback until that operation is observed.
  const isStory = type === 'story';
  const friendlyName = isStory
    ? 'usePolarisStoriesV4LikeMutationLikeMutation'
    : 'PolarisAPILikePostMutation';
  const operation = isStory
    ? null
    : await getCapturedGraphQLOperation('postLike', '28051398997871885');
  const docId = isStory ? '26938887309082050' : operation.docId;
  const variables = {
    input: {
      actor_id: '__actor_id__',
      client_mutation_id: String(Date.now()),
      media_id: String(mediaId),
    },
  };
  const data = await callGraphQLMutation(docId, variables, friendlyName);
  const serialized = JSON.stringify(data);
  if (/"errors"\s*:|\"error\"\s*:/i.test(serialized)) {
    throw new Error(`${type} beğeni GraphQL hata yanıtı: ${serialized.slice(0, 300)}`);
  }
  // Verify the like was actually registered by checking the mutation result.
  // Instagram response shape: { data: { [mutationName]: { media: { has_liked, id } } } }
  const dataEntries = data?.data ? Object.entries(data.data) : [];
  const mutationResult = dataEntries.find(([k, v]) => v && typeof v === 'object')?.[1] || null;
  const mediaResult = mutationResult?.media || mutationResult;
  // Instagram often returns has_liked: null or a payload that only carries a
  // __typename such as XIGSendStoryLikeResponsePayload. Accept any mutation
  // result object that has no errors and carries at least one success indicator
  // (has_liked, liked, status, client_mutation_id, a like-related __typename, or a
  // media object with an id — Instagram post/reel mutations sometimes return
  // has_liked:false even when the like was successfully registered; the presence
  // of a media.id with no errors is the reliable success signal).
  const hasMutationErrors = dataEntries.some(([k, v]) => v && typeof v === 'object' && Array.isArray(v.errors) && v.errors.length > 0);
  const payloadTypename = mutationResult?.__typename;
  const isSuccessTypename = payloadTypename && /like|sendstory/i.test(payloadTypename);
  const liked = !hasMutationErrors && (
    mediaResult?.has_liked === true ||
    mediaResult?.has_liked === null ||
    mediaResult?.id != null ||
    mutationResult?.liked === true ||
    mutationResult?.status === 'ok' ||
    typeof mutationResult?.client_mutation_id === 'string' ||
    typeof mutationResult?.client_mutation_id === 'number' ||
    isSuccessTypename
  );
  if (!liked) {
    const snippet = JSON.stringify(mutationResult).slice(0, 250);
    await appendDebugLog('error', `${type} beğeni mutation başarısız (onaylanmadı)`, {
      operation: friendlyName, mediaId: String(mediaId), response: snippet,
    });
    throw new Error(`${type} beğeni onaylanmadı: ${snippet}`);
  }
  // Keep the raw response in debug storage so a changed Instagram payload
  // can be diagnosed without losing the count.
  await appendDebugLog('info', `${type} beğeni mutation başarılı - onaylandı`, {
    operation: friendlyName,
    docId,
    mediaId: String(mediaId),
    responseKeys: Object.keys(data),
    mutationResultKeys: mutationResult ? Object.keys(mutationResult) : [],
    typename: payloadTypename,
    has_liked: mediaResult?.has_liked,
  });
  return data;
}

// ── Tarih / saat yardımcıları ─────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createContentStatus(enabled = true) {
  return {
    enabled,
    checked: false,
    found: false,
    unliked: false,
    error: '',
    reasonCode: enabled ? 'not_checked' : 'disabled',
    reason: enabled ? 'Kontrol henüz tamamlanmadı' : 'Bu içerik türü ayarlarda kapalı',
    source: '',
    responseCount: 0,
  };
}

function setContentStatus(status, patch) {
  Object.assign(status, patch);
  return status;
}

function markContentStatusFollowGuardSkip(status, contentType) {
  const labels = { story: 'Hikaye', post: 'Gönderi', reel: 'Reels' };
  return setContentStatus(status, {
    checked: true,
    reasonCode: 'follow_guard_skip',
    reason: `${labels[contentType] || 'İçerik'} bulundu, ancak Instagram'daki güncel takip ilişkisi doğrulanmadı; güvenlik için beğeni gönderilmedi`,
  });
}

function describeContentStatus(status) {
  if (!status?.enabled) return 'kapalı (ayarlarda seçilmemiş)';
  if (status.reasonCode === 'retry_pending') {
    return `geçici yanıt; kısa süre sonra yeniden denenecek: ${status.error || status.reason || 'Instagram isteği geçici olarak tamamlanmadı'}`;
  }
  if (status.error) {
    return `hata [${status.reasonCode || 'request_error'}]: ${status.error}`;
  }
  if (!status.checked) {
    return `kontrol edilmedi [${status.reasonCode || 'not_checked'}]: ${status.reason || 'Kontrol tamamlanmadı'}`;
  }
  if (status.reasonCode === 'empty_response') {
    return `içerik yok [empty_response]: ${status.reason || 'Instagram yanıtında bu tür içerik bulunmadı'}`;
  }
  if (status.reasonCode === 'invalid_response') {
    return `yanıt anlaşılamadı [invalid_response]: ${status.reason || 'Instagram beklenen medya alanlarını döndürmedi'}`;
  }
  if (status.reasonCode === 'follow_guard_skip') {
    return `beğeni güvenlik kontrolü nedeniyle atlandı: ${status.reason}`;
  }
  if (status.reasonCode === 'all_liked') return 'içerik var, hepsi zaten beğenilmiş';
  if (status.unliked) return 'beğenilebilir içerik var';
  if (!status.found) {
    return `içerik yok [${status.reasonCode || 'empty_response'}]: ${status.reason || 'Sonuç dönmedi'}`;
  }
  return `içerik bulundu, beğenilebilir değil [${status.reasonCode || 'no_unliked_media'}]`;
}

function normalizeMediaList(response) {
  const output = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (!value || depth > 10) return;
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    const media = value.media && typeof value.media === 'object' ? value.media : value;
    const id = media.pk ?? media.id ?? media.media_id ?? media.pk_id ?? media.strong_id__;
    const looksLikeMedia = id != null && (
      media.media_type != null || media.image_versions2 || media.video_versions ||
      media.caption != null || media.like_count != null || media.has_liked != null ||
      media.hasLiked != null || media.viewer_has_liked != null || media.code != null ||
      media.product_type != null || media.taken_at != null ||
      media.carousel_media != null || media.thumbnail_src != null ||
      media.display_url != null || media.is_video != null
    );
    if (looksLikeMedia) {
      const key = String(id);
      if (!seen.has(key)) {
        seen.add(key);
        output.push(media);
      }
    }
    // Instagram has returned items/feed_items, sections and nested data
    // under different keys across endpoints and account types.
    for (const [key, child] of Object.entries(value)) {
      if (['user', 'owner', 'caption', 'image_versions2', 'video_versions'].includes(key)) continue;
      if (Array.isArray(child) || (child && typeof child === 'object')) visit(child, depth + 1);
    }
  };
  visit(response);
  return output;
}

function isLikedValue(value) {
  return value === true || value === 1 || value === '1' ||
    (typeof value === 'string' && value.toLowerCase() === 'true');
}

function isUnlikedMedia(media) {
  return !isLikedValue(media?.has_liked ?? media?.hasLiked ?? media?.viewer_has_liked);
}

function getMediaId(media) {
  const raw = media?.pk ?? media?.id ?? media?.media_id ?? media?.pk_id ?? media?.strong_id__ ?? '';
  return String(raw).split('_')[0];
}

function getMediaThumbnail(media) {
  if (media?.image_versions2?.candidates?.length) {
    return media.image_versions2.candidates[0].url;
  }
  if (media?.thumbnail_src) return media.thumbnail_src;
  if (media?.display_url) return media.display_url;
  if (media?.video_versions?.length) {
    return media.video_versions[0].url;
  }
  return '';
}

async function fetchProfilePosts(userId, username) {
  const normalizedId = String(userId || '').trim();
  const normalizedUsername = String(username || '').replace(/^@/, '').trim();
  const hasNumericId = /^\d+$/.test(normalizedId);
  const idEndpoint = hasNumericId
    ? `/api/v1/feed/user/${encodeURIComponent(normalizedId)}/`
    : '';
  const usernameEndpoint = normalizedUsername
    ? `/api/v1/feed/user/${encodeURIComponent(normalizedUsername)}/username/`
    : '';
  if (!idEndpoint && !usernameEndpoint) {
    throw new Error('Instagram gönderileri için kullanıcı kimliği bulunamadı');
  }

  let restError = null;
  if (idEndpoint) {
    try {
      return await apiCall(idEndpoint, { count: '12' });
    } catch (error) {
      // Do not issue another route for an explicit auth, checkpoint, or
      // rate-limit response. Only a transient HTML/frame failure may fall back.
      if (!isTransientTabIssue(error)) throw error;
      restError = error;
      if (usernameEndpoint) {
        await appendDebugLog('warn', 'Sayısal gönderi adresi geçici yanıt verdi; kullanıcı adı adresi deneniyor', {
          username: normalizedUsername,
          endpoint: idEndpoint,
        });
      }
    }
  }

  if (usernameEndpoint) {
    try {
      const result = await apiCall(usernameEndpoint, { count: '12' });
      await appendDebugLog('info', 'Gönderiler kullanıcı adı adresinden alındı', {
        username: normalizedUsername,
      });
      return result;
    } catch (error) {
      if (!isTransientTabIssue(error)) throw error;
      restError = error;
      await appendDebugLog('warn', 'Gönderi kullanıcı adı adresi geçici yanıt verdi', {
        username: normalizedUsername,
        error: String(error?.message || error).slice(0, 240),
      });
    }
  }

  // Both REST routes can return the Instagram SPA shell (HTTP 200) instead of
  // media. In that case, use a supported Posts operation observed from
  // Instagram's own page, with its captured schema/doc_id and target username.
  // Never guess a stale doc_id or continue after an explicit server limit.
  const operation = await getCapturedGraphQLOperation('posts');
  if (
    !normalizedUsername ||
    !operation.isCaptured ||
    !isSupportedProfilePostsOperation(operation.friendlyName) ||
    !operation.variables ||
    typeof operation.variables.username !== 'string' ||
    !operation.variables.data ||
    typeof operation.variables.data !== 'object'
  ) {
    await appendDebugLog('warn', 'Gönderi GraphQL yedeği kullanılamadı; güncel Posts bağlantı işlemi yakalanmamış', {
      username: normalizedUsername,
      captured: operation.isCaptured,
      capturedOperation: operation.friendlyName || '',
      hasVariables: Boolean(operation.variables),
    });
    throw restError || new Error('Instagram gönderi uç noktaları yanıt vermedi');
  }

  const capturedVariables = operation.variables;
  const capturedPageSize = Number(capturedVariables.data.count ?? capturedVariables.first ?? 12);
  const pageSize = Number.isFinite(capturedPageSize) && capturedPageSize > 0
    ? Math.min(capturedPageSize, 50)
    : 12;
  const variables = {
    ...capturedVariables,
    after: null,
    before: null,
    first: pageSize,
    last: null,
    username: normalizedUsername,
    data: {
      ...capturedVariables.data,
      count: pageSize,
    },
  };

  await appendDebugLog('info', 'REST gönderi adresleri geçici yanıt verdi; yakalanan Instagram GraphQL Posts yedeği deneniyor', {
    username: normalizedUsername,
    operation: operation.friendlyName,
    pageSize,
  });
  try {
    const result = await callGraphQLMutation(
      operation.docId,
      variables,
      operation.friendlyName,
      '/graphql/query',
    );
    const found = normalizeMediaList(result).length;
    await appendDebugLog('info', 'Instagram GraphQL gönderi yedeği tamamlandı', {
      username: normalizedUsername,
      found,
      operation: operation.friendlyName,
    });
    return result;
  } catch (error) {
    await appendDebugLog(
      isRateLimitMessage(error) || isRateLimitCooldownError(error) ? 'warn' : 'error',
      'Instagram GraphQL gönderi yedeği başarısız',
      {
        username: normalizedUsername,
        operation: operation.friendlyName,
        rateLimited: isRateLimitMessage(error) || isRateLimitCooldownError(error),
        error: String(error?.message || error).slice(0, 240),
      },
    );
    throw error;
  }
}

async function fetchProfileReels(userId) {
  const friendlyName = 'PolarisProfileReelsTabContentQuery';
  const operation = await getCapturedGraphQLOperation('reels', '28217628591240469');
  const capturedVariables = operation.variables || {};
  const capturedPageSize = Number(capturedVariables.data?.page_size ?? 12);
  const pageSize = Number.isFinite(capturedPageSize) && capturedPageSize > 0
    ? Math.min(capturedPageSize, 50)
    : 12;
  const id = String(userId);
  const variables = {
    ...capturedVariables,
    after: null,
    before: null,
    data: {
      ...(capturedVariables.data || {}),
      include_feed_video: capturedVariables.data?.include_feed_video ?? true,
      page_size: pageSize,
      target_user_id: id,
    },
    user_id: id,
    __relay_internal__pv__PolarisShortDramaEnabledrelayprovider:
      capturedVariables.__relay_internal__pv__PolarisShortDramaEnabledrelayprovider ?? true,
  };
  return callGraphQLMutation(operation.docId, variables, friendlyName, '/graphql/query');
}

// Chrome rejects tab activation while the user is dragging/reordering tabs.
// Panel navigation is optional, so never let that transient state create an
// unhandled promise rejection or interrupt the automation.
function focusTabSafely(tab) {
  if (!tab?.id) return;
  Promise.resolve(chrome.tabs.update(tab.id, { active: true }))
    .catch(() => {});
  if (tab.windowId != null) {
    Promise.resolve(chrome.windows.update(tab.windowId, { focused: true }))
      .catch(() => {});
  }
}

// ── Takip listesi önbelleği (4 saat) ─────────────────────────────────
let _followingCache = [];
let _followingCacheTs = 0;
let _followingCacheUserId = '';

// Yanıt nesnesinden kullanıcı listesini çıkar — Instagram farklı şekillerde döndürebilir.
function extractFollowUsers(data) {
  // 1. Standart REST yanıtı: { users: [...] }
  if (Array.isArray(data?.users) && data.users.length > 0) return data.users;
  // 2. Alternatif REST sarmalayıcı: { data: { users: [...] } }
  if (Array.isArray(data?.data?.users) && data.data.users.length > 0) return data.data.users;
  // 3. GraphQL kenar listesi: { data: { user: { edge_follow: { edges: [{node}] } } } }
  const edges = data?.data?.user?.edge_follow?.edges;
  if (Array.isArray(edges) && edges.length > 0) return edges.map(e => e.node ?? e);
  // 4. Bazı GraphQL yanıtlarında doğrudan items/list alanı
  if (Array.isArray(data?.items) && data.items.length > 0) return data.items;
  return [];
}

function normalizeFollowEntry(u) {
  const id       = String(u.pk ?? u.id ?? u.fbid_v2 ?? '').trim();
  const username = String(u.username ?? '').trim();
  if (!username) return null;
  const photoUrls = [
    u.profile_pic_url_hd,
    u.hd_profile_pic_url_info?.url,
    u.profile_pic_url_info?.url,
    u.profile_pic_url,
  ]
    .map(value => String(value ?? '').trim())
    .filter(value => /^https?:\/\//i.test(value));
  const profilePhoto = photoUrls[0] || '';
  // pk yoksa username'i id olarak kabul et (otomasyon için yeterli)
  return {
    id: id || username,
    username,
    full_name: String(u.full_name ?? ''),
    biography: String(u.biography ?? ''),
    profile_pic_url: profilePhoto,
    profile_pic_url_hd: profilePhoto,
  };
}

// Chrome'un URL filtresi bazı durumlarda kök instagram.com sekmesini veya
// henüz URL'si yeni atanmış/yüklenmekte olan sekmeyi döndürmeyebilir. Sekmeleri
// alıp hostname'i kendimiz kontrol etmek daha güvenilir.
async function queryInstagramTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter(tab => {
    try {
      const hostname = new URL(tab.url ?? '').hostname.toLowerCase();
      return hostname === 'instagram.com' || hostname.endsWith('.instagram.com');
    } catch {
      return false;
    }
  });
}

function chooseInstagramTab(tabs, { preferNonAccountPage = true } = {}) {
  const candidates = tabs.filter(tab => tab?.id != null);
  const nonAccount = candidates.filter(tab => !String(tab.url ?? '').includes('/accounts/'));
  const preferred = preferNonAccountPage && nonAccount.length > 0 ? nonAccount : candidates;
  return preferred.find(tab => tab.status === 'complete')
    ?? preferred[0]
    ?? null;
}

// content-script'in requestJson'ına tabs.sendMessage ile istek gönderir.
// Sayfanın bulabildiği gerçek x-ig-www-claim değeri kullanılır; bulunamazsa
// sentetik bir '0' değeri eklenmez.
async function igFetchViaContentScriptLegacy(endpoint, params) {
  return withInstagramRequestSlot(
    `content:GET:${endpoint}`,
    async () => {
      const tabId = await getInstagramTab();
      await waitForInstagramContentScript(tabId);

      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await sendInstagramMessage(
            tabId,
            { type: 'IG_FETCH', endpoint, params },
            30000,
          );
          if (response?.ok) return response.data;
          const error = new Error(response?.error ?? 'IG_FETCH başarısız');
          Object.assign(error, {
            status: response?.status ?? null,
            statusText: response?.statusText ?? '',
            retryAfter: response?.retryAfter ?? '',
            responseContentType: response?.responseContentType ?? '',
            responseReason: response?.responseReason ?? '',
            endpoint: response?.endpoint || String(endpoint || '').split('?')[0],
          });
          throw error;
        } catch (error) {
          lastError = error;
          if (!isPortClosedError(error) || attempt === 1) throw error;
          await sleep(700);
          await waitForInstagramContentScript(tabId);
        }
      }
      throw lastError ?? new Error('IG_FETCH başarısız');
    },
  );
}

async function igFetchViaContentScript(endpoint, params) {
  return apiCall(endpoint, params, 'GET');
}

async function getSharedUserLimit() {
  const state = await getState();
  return Math.max(
    1,
    Math.min(
      DISCOVERY_MAX_PER_DAY_CAP,
      Number(state.discoveryMaxPerDay) || DISCOVERY_DEFAULT_PER_DAY,
    ),
  );
}

async function getFollowing(userId) {
  const normalizedUserId = String(userId ?? '');
  const userLimit = await getSharedUserLimit();
  if (_followingCache.length > 0 &&
      _followingCacheUserId === normalizedUserId &&
      Date.now() - _followingCacheTs < 4 * 3600000 &&
      (_followingCacheComplete || _followingCache.length >= userLimit)) {
    return _followingCache.slice(0, userLimit);
  }

  // KAT 1: Panel'in IG_API handler'ından doldurulan __cached_following deposu.
  // Kullanıcı liste sekmesini açmışsa bu veri zaten hazır olabilir.
  try {
    const stored = await new Promise(resolve =>
      chrome.storage.local.get(['__cached_following'], resolve)
    );
    const cached = stored.__cached_following;
    const cacheAge = cached?.ts ? Date.now() - cached.ts : Infinity;
    if (cached?.scope === 'current-user' &&
        cached?.userId && String(cached.userId) === normalizedUserId &&
        Array.isArray(cached.users) && cached.users.length > 0 &&
        cacheAge < 4 * 3600000) {
        const cachedUsers = cached.users
          .map(normalizeFollowEntry)
          .filter(Boolean)
          .slice(0, userLimit);
        const allUsers = await classifyGenderInBackground(cachedUsers);
      if (allUsers.length > 0) {
        _followingCache   = allUsers;
        _followingCacheTs = Date.now();
        _followingCacheUserId = normalizedUserId;
        _followingCacheComplete = cached.users.length < userLimit;
        await appendDebugLog('info', `getFollowing: storage cache'ten ${allUsers.length} kullanıcı yüklendi`);
        if (_followingCacheComplete || allUsers.length >= userLimit) {
          return _followingCache.slice(0, userLimit);
        }
      }
    }
  } catch {}

  // İki yöntemi sırayla dene; her ikisi de başarısızsa hatayı fırlat.
  let lastError = null;

  // KAT 2: tabs.sendMessage → content-script IG_FETCH (isolated world).
  // execRestInTab x-ig-www-claim: 0 gönderiyor ve bu friendship endpoint'ini
  // reddettiriyor; content-script o başlığı hiç göndermez.
  try {
    const allUsers = [];
    const seenUsers = new Set();
    let maxId = null;
    let pages = 0;
    const MAX_PAGES = IG_MAX_FOLLOWING_PAGES;
    do {
      if (pages > 0) await sleep(randInt(900, 1800));
      const params = {
        count: String(Math.min(IG_MAX_LIST_PAGE_SIZE, userLimit - allUsers.length)),
      };
      if (maxId) params.max_id = maxId;
      const data = await igFetchViaContentScript(
        `/api/v1/friendships/${userId}/following/`, params
      );
      const rawUsers = extractFollowUsers(data);
      for (const u of rawUsers) {
        const entry = normalizeFollowEntry(u);
        if (entry && !seenUsers.has(entry.id)) {
          seenUsers.add(entry.id);
          allUsers.push(entry);
          if (allUsers.length >= userLimit) break;
        }
      }
      await appendDebugLog('info', `getFollowing (CS): sayfa ${pages + 1} — ${rawUsers.length} ham, ${allUsers.length} toplam`, {
        responseKeys: Object.keys(data ?? {}).slice(0, 15),
        sampleUser: rawUsers[0] ? Object.keys(rawUsers[0]) : [],
      });
      maxId = data.next_max_id ?? null;
      pages++;
    } while (maxId && pages < MAX_PAGES && allUsers.length < userLimit);

    const labeledUsers = await classifyGenderInBackground(allUsers.slice(0, userLimit));
    _followingCache   = labeledUsers;
    _followingCacheTs = Date.now();
    _followingCacheUserId = normalizedUserId;
    _followingCacheComplete = allUsers.length < userLimit || !maxId || pages >= MAX_PAGES;
    if (allUsers.length > 0) {
      // Service worker yeniden başladığında bellek sıfırlanır; storage'a da yaz.
      chrome.storage.local.set({ __cached_following: {
        users: labeledUsers, userId: normalizedUserId, scope: 'current-user', ts: Date.now(),
      } });
      return _followingCache.slice(0, userLimit);
    }
    // Boş liste geçerli bir sonuçtur. Aynı listeyi ikinci bir istek yöntemiyle
    // tekrar çekmek, özellikle yeni/boş hesaplarda gereksiz trafik üretir.
    if (allUsers.length === 0) {
      _followingCache = [];
      _followingCacheTs = Date.now();
      _followingCacheUserId = normalizedUserId;
      _followingCacheComplete = true;
      return _followingCache;
    }
    lastError = new Error('Content-script isteği 0 kullanıcı döndürdü');
  } catch (err) {
    if (isAutomationStopError(err)) throw err;
    lastError = err;
    await appendDebugLog('warn', `getFollowing CS hata: ${String(err.message ?? err).slice(0, 200)}`);
  }

  // KAT 3: execRestInTab (executeScript tabanlı yedek).
  try {
    const allUsers = [];
    const seenUsers = new Set();
    let maxId = null;
    let pages = 0;
    const MAX_PAGES = IG_MAX_FOLLOWING_PAGES;
    do {
      if (pages > 0) await sleep(randInt(900, 1800));
      const params = {
        count: String(Math.min(IG_MAX_LIST_PAGE_SIZE, userLimit - allUsers.length)),
      };
      if (maxId) params.max_id = maxId;
      const data = await apiCall(`/api/v1/friendships/${userId}/following/`, params);
      const rawUsers = extractFollowUsers(data);
      for (const u of rawUsers) {
        const entry = normalizeFollowEntry(u);
        if (entry && !seenUsers.has(entry.id)) {
          seenUsers.add(entry.id);
          allUsers.push(entry);
          if (allUsers.length >= userLimit) break;
        }
      }
      await appendDebugLog('info', `getFollowing (exec): sayfa ${pages + 1} — ${rawUsers.length} ham, ${allUsers.length} toplam`, {
        responseKeys: Object.keys(data ?? {}).slice(0, 15),
        sampleUser: rawUsers[0] ? Object.keys(rawUsers[0]) : [],
      });
      maxId = data.next_max_id ?? null;
      pages++;
    } while (maxId && pages < MAX_PAGES && allUsers.length < userLimit);

    const labeledUsers = await classifyGenderInBackground(allUsers.slice(0, userLimit));
    _followingCache   = labeledUsers;
    _followingCacheTs = Date.now();
    _followingCacheUserId = normalizedUserId;
    _followingCacheComplete = allUsers.length < userLimit || !maxId || pages >= MAX_PAGES;
    if (allUsers.length > 0) {
      // Service worker yeniden başladığında bellek sıfırlanır; storage'a da yaz.
      chrome.storage.local.set({ __cached_following: {
        users: labeledUsers, userId: normalizedUserId, scope: 'current-user', ts: Date.now(),
      } });
    }
    lastError = null;
  } catch (error) {
    if (isAutomationStopError(error)) throw error;
    lastError = error;
    await appendDebugLog('error', `getFollowing exec hata: ${String(error.message ?? error).slice(0, 300)}`);
  }

  // Her iki kat da başarısız olduysa hatayı fırlat (caller mesaj üzerine yazar)
  if (_followingCache.length === 0 && lastError) {
    throw new Error(`Takip listesi alınamadı: ${String(lastError.message ?? lastError).slice(0, 150)}`);
  }

  return _followingCache;
}

// ── Instagram sekmesi bulma ───────────────────────────────────────────
const INSTAGRAM_HOME_URL = 'https://www.instagram.com/';
let _instagramTabOpenPromise = null;

function sendInstagramMessage(tabId, message, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Instagram içerik betiği yanıt zaman aşımına uğradı'));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, response => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Instagram sekmesine mesaj gönderilemedi'));
        return;
      }
      resolve(response);
    });
  });
}

async function waitForInstagramContentScript(tabId, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await sendInstagramMessage(tabId, { type: 'TP_CONTENT_PING' }, 1200);
      if (response?.ok) return true;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    lastError?.message || 'Instagram içerik betiği hazır değil; sekme yeniden yükleniyor olabilir',
  );
}

function waitForInstagramTabComplete(tabId, timeoutMs = 35000) {
  return new Promise(resolve => {
    let settled = false;
    const listener = (updatedTabId, info) => {
      if (updatedTabId !== tabId || info.status !== 'complete') return;
      finish(true);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const finish = value => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      resolve(value);
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError || !tab) {
        finish(false);
        return;
      }
      if (tab.status === 'complete') finish(true);
    });
  });
}

function refreshDelayMs() {
  return Math.floor(
    IG_REFRESH_MIN_MS + Math.random() * (IG_REFRESH_MAX_MS - IG_REFRESH_MIN_MS),
  );
}

function scheduleInstagramTabRefresh() {
  chrome.alarms.create(ALARM_REFRESH_INSTAGRAM, {
    when: Date.now() + refreshDelayMs(),
  });
}

async function refreshInstagramContext(tabId, force = false) {
  const stored = await new Promise(resolve =>
    chrome.storage.local.get(['igGqlTokens'], resolve)
  );
  const cached = stored?.igGqlTokens;
  if (!force &&
      cached?.fbDtsg &&
      cached?.lsd &&
      cached?.csrf &&
      Date.now() - Number(cached.ts) < IG_GQL_CONTEXT_TTL_MS) {
    return cached;
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const cookieValue = name => {
        try {
          const raw = document.cookie
            .split(';')
            .find(value => value.trim().startsWith(`${name}=`))
            ?.split('=')
            .slice(1)
            .join('=') ?? '';
          return decodeURIComponent(raw);
        } catch {
          return '';
        }
      };

      let fbDtsg = '';
      let lsd = '';
      let userId = cookieValue('ds_user_id');
      let profileDocId = '';
      let wwwClaim = '';
      const win = window;

      try { fbDtsg = String(win.require?.('DTSGInitData')?.token ?? ''); } catch {}
      try { lsd = String(win.require?.('LSD')?.token ?? ''); } catch {}
      try {
        const currentUser = win.require?.('CurrentUserInitialData');
        userId = String(currentUser?.USER_ID ?? currentUser?.userId ?? userId);
      } catch {}
      try {
        wwwClaim = String(
          win.require?.('IGSCRP')?.claimValue ??
          win.__wwwClaim ??
          '',
        );
      } catch {}

      for (const module of win.__bbox?.require ?? []) {
        try {
          if (!Array.isArray(module)) continue;
          const name = String(module[0] ?? '');
          const config = Array.isArray(module[3]) ? module[3][0] : module[3];
          if (!config || typeof config !== 'object') continue;
          if (!fbDtsg && name === 'DTSGInitData') fbDtsg = String(config.token ?? '');
          if (!lsd && name === 'LSD') lsd = String(config.token ?? '');
          if ((!userId || userId === '0') && name === 'CurrentUserInitialData') {
            userId = String(config.USER_ID ?? config.userId ?? '');
          }
          if (!profileDocId &&
              /^PolarisProfilePageContent(Content)?Query_instagramRelayOperation$/.test(name)) {
            const candidate = typeof config === 'string' ? config : config.id;
            if (/^\d{10,20}$/.test(String(candidate ?? ''))) {
              profileDocId = String(candidate);
            }
          }
        } catch {}
      }

      if (!fbDtsg || !lsd || !profileDocId || !userId || userId === '0') {
        for (const script of document.querySelectorAll('script')) {
          const text = script.textContent ?? '';
          if (!fbDtsg) {
            fbDtsg = text.match(
              /"DTSGInitData"[\s\S]{0,300}?"token"\s*:\s*"([^"]+)"/,
            )?.[1] ?? '';
          }
          if (!lsd) {
            lsd = text.match(
              /"LSD"[\s\S]{0,300}?"token"\s*:\s*"([^"]+)"/,
            )?.[1] ?? '';
          }
          if (!userId || userId === '0') {
            userId = text.match(/"USER_ID"\s*:\s*"(\d+)"/)?.[1] ?? userId;
          }
          if (!profileDocId) {
            profileDocId = text.match(
              /PolarisProfilePageContent(?:Content)?Query_instagramRelayOperation[\s\S]{0,240}?"id"\s*:\s*"(\d{10,20})"/,
            )?.[1] ?? '';
          }
          if (fbDtsg && lsd && userId && userId !== '0' && profileDocId) break;
        }
      }

      const csrf = cookieValue('csrftoken');
      if (!csrf || !fbDtsg || !lsd) {
        return {
          ok: false,
          error: `Instagram bağlamı eksik — csrf:${!!csrf} fb_dtsg:${!!fbDtsg} lsd:${!!lsd}`,
        };
      }

      return {
        ok: true,
        fbDtsg,
        lsd,
        csrf,
        userId: userId && userId !== '0' ? userId : '',
        profileDocId,
        wwwClaim,
      };
    },
  });

  const context = results?.[0]?.result;
  if (!context?.ok) {
    throw new Error(context?.error ?? 'Instagram bağlamı alınamadı');
  }

  const tokens = {
    fbDtsg: context.fbDtsg,
    lsd: context.lsd,
    csrf: context.csrf,
    userId: context.userId ?? '',
    profileDocId: context.profileDocId ?? '',
    wwwClaim: context.wwwClaim ?? '',
    ts: Date.now(),
  };
  await new Promise(resolve => chrome.storage.local.set({ igGqlTokens: tokens }, resolve));
  return tokens;
}

async function refreshInstagramTab() {
  if (_igRefreshInFlight) return _igRefreshInFlight;

  _igRefreshInFlight = (async () => {
    try {
      const tabs = await queryInstagramTabs();
      const tab = chooseInstagramTab(tabs);
      const tabUrl = String(tab?.url ?? '');

      if (!tab?.id ||
          /\/(?:accounts\/(?:login|challenge)|challenge)\b/i.test(tabUrl) ||
          tab.status === 'loading') {
        return;
      }

      const sessionPresent = await hasInstagramSessionCookie();
      if (!sessionPresent) return;

      // A reload invalidates page-owned values. Never let a mutation fall back
      // to the previous page's token pair while the new document is booting.
      await new Promise(resolve => chrome.storage.local.remove(['igGqlTokens'], resolve));
      await chrome.tabs.reload(tab.id);
      await waitForInstagramTabComplete(tab.id);
      await waitForInstagramContentScript(tab.id);
      // Wait for Instagram's bootstrap modules/cookies to be installed.
      await sleep(1500);
      await refreshInstagramContext(tab.id, true);
      sendTabMessageSilently(tab.id, { type: 'REFRESH_USER_DATA' });
      await appendDebugLog('info', 'Instagram sekmesi yenilendi ve bağlam yenilendi', {
        tabId: tab.id,
      });
    } catch (error) {
      await appendDebugLog('warn', 'Periyodik Instagram yenilemesi başarısız', {
        error: error?.message ?? String(error),
      });
    } finally {
      scheduleInstagramTabRefresh();
      _igRefreshInFlight = null;
    }
  })();

  return _igRefreshInFlight;
}

async function openInstagramTabIfMissing() {
  const tabs = await queryInstagramTabs();
  const usable = tab => tab?.id != null;
  const preferredTabs = tabs.filter(tab => !String(tab.url ?? '').includes('/accounts/'));
  const candidateTabs = preferredTabs.length > 0 ? preferredTabs : tabs;
  const existing = candidateTabs.find(usable);

  if (existing?.id != null) {
    if (existing.status !== 'complete') {
      await waitForInstagramTabComplete(existing.id);
    }
    const refreshed = chooseInstagramTab(await queryInstagramTabs());
    if (refreshed?.id != null) return refreshed.id;
    return existing.id;
  }

  if (_instagramTabOpenPromise) return _instagramTabOpenPromise;

  _instagramTabOpenPromise = new Promise((resolve, reject) => {
    chrome.tabs.create({ url: INSTAGRAM_HOME_URL }, async tab => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Instagram sekmesi açılamadı'));
        return;
      }
      if (!tab?.id) {
        reject(new Error('Instagram sekmesi açılamadı'));
        return;
      }
      const loaded = await waitForInstagramTabComplete(tab.id);
      if (!loaded) {
        reject(new Error('Instagram sekmesi zamanında yüklenmedi'));
        return;
      }
      resolve(tab.id);
    });
  }).finally(() => {
    _instagramTabOpenPromise = null;
  });

  return _instagramTabOpenPromise;
}

async function getInstagramTab() {
  const tabs = await queryInstagramTabs();
  const usable = tab => tab?.id != null;
  const preferredTabs = tabs.filter(tab => !String(tab.url ?? '').includes('/accounts/'));
  const candidateTabs = preferredTabs.length > 0 ? preferredTabs : tabs;
  const readyTab = candidateTabs.find(tab => usable(tab) && tab.status === 'complete');
  if (readyTab?.id != null) return readyTab.id;

  const loadingTab = candidateTabs.find(usable);
  if (loadingTab?.id != null) {
    // Panel timeout'undan kısa tutulur; sekme yüklenirken uzantı hemen "yok"
    // hatası vermek yerine onun tamamlanmasını bekler.
    await new Promise(resolve => {
      const id = loadingTab.id;
      const timeout = setTimeout(resolve, 35000);
      const listener = (tabId, info) => {
        if (tabId !== id || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    const refreshedTabs = await queryInstagramTabs();
    const refreshedCandidates = refreshedTabs.filter(tab => !String(tab.url ?? '').includes('/accounts/'));
    const refreshedPool = refreshedCandidates.length > 0 ? refreshedCandidates : refreshedTabs;
    const refreshed = refreshedPool.find(tab => usable(tab) && tab.status === 'complete');
    if (refreshed?.id != null) return refreshed.id;
  }

  return openInstagramTabIfMissing();
}

// ── Content script üzerinden REST API çağrısı ─────────────────────────
async function execRestInTab(tabId, url, method, bodyObj) {
  const targetUrl = new URL(url, 'https://www.instagram.com');
  if (targetUrl.origin !== 'https://www.instagram.com') {
    throw new Error('Yalnızca Instagram API isteklerine izin verilir.');
  }
  return instagramServerRequest(
    targetUrl.pathname,
    Object.fromEntries(targetUrl.searchParams.entries()),
    method,
    bodyObj,
  );

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (url, method, bodyStr) => {
      const csrf = document.cookie.split(';').find(c => c.trim().startsWith('csrftoken='))?.split('=')[1] ?? '';

      // www-claim başlığını bul — yanıt başlığından okumak Chrome tarafından
      // engellendiği için (unsafe header) sayfa içindeki kaynaklardan okunur.
      let wwwClaim = '0';
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const v = localStorage.getItem(localStorage.key(i) ?? '') ?? '';
          if (v.startsWith('hmac.')) { wwwClaim = v; break; }
        }
      } catch {}
      if (wwwClaim === '0') {
        for (const v of Object.values(window)) {
          if (typeof v === 'string' && v.startsWith('hmac.')) { wwwClaim = v; break; }
        }
      }
      if (wwwClaim === '0') {
        for (const el of document.querySelectorAll('script:not([src])')) {
          const m = (el.textContent ?? '').match(/hmac\.[A-Za-z0-9_\-+=/.]{20,}/);
          if (m) { wwwClaim = m[0]; break; }
        }
      }

      const headers = {
        'x-asbd-id': '359341',
        'x-csrftoken': csrf,
        'x-ig-app-id': '936619743392459',
        'x-ig-www-claim': wwwClaim,
        'x-ig-max-touch-points': '0',
        'x-requested-with': 'XMLHttpRequest',
        'accept': '*/*',
      };
      let requestBody = bodyStr ? JSON.parse(bodyStr) : null;

      // Instagram Web's current follow action is friendships/create/{id}, not
      // friendship/follow. The browser also includes fb_dtsg and jazoest in
      // this POST. Add those page-owned values here so automatic discovery
      // follows the same request shape as the supplied HAR.
      if (requestBody && /\/api\/v1\/friendships\/create\/\d+\/?$/i.test(url)) {
        let fbDtsg = '';
        try { fbDtsg = String(window.require?.('DTSGInitData')?.token ?? ''); } catch {}
        if (!fbDtsg) {
          for (const script of document.querySelectorAll('script')) {
            fbDtsg = script.textContent?.match(
              /"DTSGInitData"[\s\S]{0,300}?"token"\s*:\s*"([^"]+)"/,
            )?.[1] ?? '';
            if (fbDtsg) break;
          }
        }
        if (fbDtsg) {
          requestBody.fb_dtsg = requestBody.fb_dtsg || fbDtsg;
          requestBody.jazoest = requestBody.jazoest || `2${Array.from(fbDtsg).reduce((sum, character) => sum + character.charCodeAt(0), 0)}`;
        }
      }
      if (requestBody) headers['content-type'] = 'application/x-www-form-urlencoded';

      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 60000);

      const resp = await fetch(url, {
        method,
        credentials: 'include',
        headers,
        body: requestBody ? new URLSearchParams(requestBody).toString() : undefined,
        signal: ctrl.signal,
      });

      const text = await resp.text();
      if (resp.status === 429) {
        const responseContentType = resp.headers.get('content-type') || '';
        const cleanedText = text.replace(/^for\s*\(;;\);\s*/, '').trim();
        let responseReason = '';
        try {
          const errorPayload = JSON.parse(cleanedText);
          const rawReason = errorPayload?.message
            ?? errorPayload?.error?.message
            ?? errorPayload?.error_title
            ?? errorPayload?.error_type
            ?? errorPayload?.error;
          responseReason = rawReason == null
            ? ''
            : (typeof rawReason === 'string' ? rawReason : JSON.stringify(rawReason)).slice(0, 240);
        } catch {
          if (cleanedText.startsWith('<')) {
            const title = cleanedText.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
            responseReason = title
              ? `HTML yanıtı: ${title}`.slice(0, 240)
              : `HTML yanıtı (${cleanedText.length} karakter)`;
          } else {
            responseReason = cleanedText.slice(0, 240);
          }
        }
        let endpoint = String(url).split('?')[0];
        try { endpoint = new URL(url).pathname; } catch {}
        return {
          ok: false,
          body: '__RATE_LIMIT__',
          status: resp.status,
          statusText: resp.statusText || '',
          retryAfter: resp.headers.get('retry-after') || '',
          responseContentType,
          responseReason: responseReason || 'Sunucu yanıt gövdesi boş',
          endpoint,
        };
      }
      if (!text || text.trimStart().startsWith('<')) {
        const lower = text.toLowerCase();
        const finalPath = resp.redirected ? (() => { try { return new URL(resp.url).pathname; } catch { return ''; } })() : '';
        const redirectedAway = resp.redirected && finalPath.startsWith('/accounts/login');
        if (
          lower.includes('/accounts/login') ||
          lower.includes('login_required') ||
          lower.includes('checkpoint_required') ||
          redirectedAway
        ) {
          return { ok: false, body: '__SESSION_EXPIRED__', status: resp.status };
        }
        const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
        const diag = JSON.stringify({
          title: titleMatch?.[1] ?? null,
          respUrl: resp.url,
          redirected: resp.redirected,
          requestedUrl: url,
          currentPage: location.href,
          snippet: text.slice(0, 1500),
        });
        return { ok: false, body: `__HTML_RESPONSE__:${diag}`, status: resp.status };
      }

      try {
        const json = JSON.parse(text);
        if (json.message === 'feedback_required') {
          return { ok: false, body: JSON.stringify(json).slice(0, 200), status: resp.status };
        }
        // Instagram also uses status:"fail" for transient API errors,
        // throttling, stale page data, and malformed requests. Treating every
        // such response as a logout makes the extension ask for login again
        // while the session cookie is still valid.
        const explicitLoginRequired =
          json.message === 'login_required' ||
          json.error_type === 'login_required' ||
          json.require_login === true;
        if (explicitLoginRequired) {
          return {
            ok: false,
            body: '__SESSION_EXPIRED__',
            status: resp.status,
          };
        }
        if (!resp.ok) {
          return {
            ok: false,
            body: `HTTP ${resp.status}: ${String(json.message ?? json.error_title ?? JSON.stringify(json)).slice(0, 300)}`,
            status: resp.status,
          };
        }
        if (json.status === 'fail') {
          return {
            ok: false,
            body: String(json.message ?? json.error_title ?? 'Instagram geçici API hatası'),
            status: resp.status,
          };
        }
        return { ok: true, data: json };
      } catch {
        return { ok: false, body: text.slice(0, 200), status: resp.status };
      }
    },
    args: [url, method, bodyObj ? JSON.stringify(bodyObj) : null],
  });

  const result = results[0];
  if (result?.error) throw new Error('executeScript hatası: ' + result.error.message);
  const res = result?.result;
  if (!res) throw new Error('Yanıt boş');
  if (!res.ok) {
    const msg = String(res.body ?? '');
    if (msg === '__SESSION_EXPIRED__') throw new Error("Oturum süresi dolmuş — Instagram'a yeniden giriş yapın");
    if (msg === '__RATE_LIMIT__') {
      const error = new Error(
        `Instagram istek sınırı uyguladı (HTTP 429)`
          + (res.responseReason ? `: ${String(res.responseReason).slice(0, 240)}` : ''),
      );
      Object.assign(error, {
        status: res.status ?? 429,
        statusText: res.statusText || '',
        retryAfter: res.retryAfter || '',
        responseContentType: res.responseContentType || '',
        responseReason: res.responseReason || '',
        endpoint: res.endpoint || '',
      });
      throw error;
    }
    if (msg === '__API_REJECTED__') throw new Error('Instagram bu isteği reddetti — kısa süre bekleyip tekrar deneyin');
    if (msg.startsWith('__HTML_RESPONSE__')) {
      const raw = msg.slice('__HTML_RESPONSE__:'.length);
      throw new Error(`Instagram beklenmeyen HTML sayfası döndürdü (durum ${res.status}, geçici yönlendirme/throttle olabilir): ${raw}`);
    }
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return res.data;
}

// ── Ana API çağrısı (sekme hatalarında yeniden dener) ─────────────────
async function apiCallUnqueued(endpoint, params, method = 'GET', body) {
  return instagramServerRequest(endpoint, params, method, body);

  // Retained below only as historical context; all active API calls now use
  // the licensed server proxy above.
  const isTabError = e =>
    e instanceof Error &&
    (e.message.includes('No tab with id') ||
      e.message.includes('Cannot access') ||
      e.message.includes('No frame with id') ||
      isRemovedInstagramFrameError(e) ||
      /node cannot be found in the current page/i.test(e.message) ||
      (e.message.includes('tab') && e.message.includes('closed')));

  // Instagram'ın current_user web endpoint'i bazı oturumlarda her bağlamdan
  // "useragent mismatch" (HTTP 400) döndürüyor. Aynı isteği tekrar tekrar
  // denemek yerine, sayfada zaten doğrulanmış kullanıcıyı veya yakalanmış
  // profil GraphQL operasyonunu kullan.
  if (endpoint === '/api/v1/accounts/current_user/?edit=true' && method === 'GET') {
    const stored = await new Promise(resolve =>
      chrome.storage.local.get(['igUser'], resolve)
    );
    const storedUser = stored?.igUser;
    const storedId = String(
      storedUser?.pk ?? storedUser?.fbid_v2 ?? storedUser?.id ?? '',
    ).trim();
    const sessionId = await getInstagramSessionUserId(storedUser);

    // Never return cached profile fields during startup. A previous build
    // could have stored a viewed follower's name/counts together with the
    // session ID; trusting that record would make the panel mount the wrong
    // account before the authoritative refresh runs.
    if (sessionId) {
      return {
        user: {
          pk: sessionId,
          id: sessionId,
          username: '',
        },
      };
    }
    throw new Error('Instagram kullanıcı kimliği bulunamadı — instagram.com sekmesini yenileyin');
  }

  // REST API çağrıları: content-script'in o() fonksiyonu üzerinden yap
  // (executeScript yerine sendMessage → daha güvenilir, cookies otomatik)
  const igTabs = await queryInstagramTabs();
  const csTabId = chooseInstagramTab(igTabs)?.id ?? null;

  // Doğrudan execRestInTab — sendMessage yolu her seferinde başarısız olduğundan atlanır
  let tabId = csTabId ?? await getInstagramTab();
  let url = endpoint.startsWith('http') ? endpoint : `https://www.instagram.com${endpoint}`;
  if (params && Object.keys(params).length > 0) url += '?' + new URLSearchParams(params).toString();

  try {
    const data = await execRestInTab(tabId, url, method, body ?? null);
    await appendDebugLog('info', 'execRestInTab başarılı', { endpoint, method });
    return data;
  } catch (e) {
    // A direct executeScript fetch can be redirected to Instagram's HTML SPA
    // shell even while the page's own fetch context can still read the JSON.
    // Try that page-owned context once for safe, read-only endpoints before
    // treating the response as a transient automation error.
    if (isTransientTabIssue(e) && canUsePageFetchFallback(endpoint, method)) {
      try {
        await waitForInstagramContentScript(tabId);
        const pageResponse = await sendInstagramMessage(
          tabId,
          { type: 'IG_FETCH_PAGE', endpoint, params, method },
          30000,
        );
        if (pageResponse?.ok) {
          await appendDebugLog('info', 'Instagram sayfa fetch fallback başarılı', {
            endpoint,
            method,
          });
          return pageResponse.data;
        }
        await appendDebugLog(
          pageResponse?.status === 429 ? 'warn' : 'info',
          'Instagram sayfa fetch fallback sonuç vermedi',
          {
            endpoint,
            method,
            status: pageResponse?.status ?? null,
            statusText: pageResponse?.statusText || '',
            retryAfter: pageResponse?.retryAfter || '',
            responseContentType: pageResponse?.responseContentType || '',
            responseReason: pageResponse?.responseReason || '',
            error: String(pageResponse?.error || 'JSON yanıt alınamadı').slice(0, 240),
          },
        );
      } catch (pageError) {
        await appendDebugLog('info', 'Instagram sayfa fetch fallback kullanılamadı', {
          endpoint,
          method,
          error: String(pageError?.message || pageError).slice(0, 240),
        });
      }
    }

    // Site access can be temporarily unavailable to scripting.executeScript
    // while Instagram is navigating or when the browser has restricted page
    // access. The already injected content script can still make the same
    // request from the page context, so use it before reporting a permission
    // error to discovery.
    if (/Cannot access contents of the page|manifest must request permission/i.test(String(e?.message || e))) {
      try {
        await waitForInstagramContentScript(tabId);
        const response = await sendInstagramMessage(
          tabId,
          { type: 'IG_FETCH', endpoint, params },
          30000,
        );
        if (response?.ok) {
          await appendDebugLog('info', 'IG_FETCH içerik betiği fallback başarılı', { endpoint, method });
          return response.data;
        }
        throw new Error(response?.error || 'IG_FETCH fallback başarısız');
      } catch (contentScriptError) {
        await appendDebugLog('warn', 'Instagram sayfa erişimi fallback ile de alınamadı', {
          endpoint,
          method,
          error: contentScriptError?.message || String(contentScriptError),
        });
        throw contentScriptError;
      }
    }

    // Never retry a server-enforced limit or an authentication/challenge
    // response. Retrying these responses only increases pressure on the
    // account and can turn a temporary restriction into a longer one.
    if (
      isRateLimitMessage(e) ||
      isSessionError(e) ||
      isAccessBlockedMessage(e) ||
      isInstagramCheckpointError(e)
    ) {
      throw e;
    }
    if (isTabError(e)) {
      // "No tab with id": sekme kapatılmış — aynı ölü ID ile yeniden denemenin
      // hiçbir anlamı yok, direkt geçerli bir sekme al ve tek adımda retry yap.
      if (
        e.message.includes('No tab with id') ||
        isRemovedInstagramFrameError(e) ||
        /node cannot be found in the current page/i.test(e.message)
      ) {
        try {
          if (
            isRemovedInstagramFrameError(e) ||
            /node cannot be found in the current page/i.test(e.message)
          ) {
            // executeScript raced with an Instagram SPA navigation. Let the
            // document settle before selecting the current complete tab.
            await new Promise(resolve => setTimeout(resolve, 1800));
          }
          tabId = await getInstagramTab();
          const data = await execRestInTab(tabId, url, method, body ?? null);
          await appendDebugLog('info', 'execRestInTab başarılı (tab-geçişi retry)', { endpoint, method });
          return data;
        } catch (noTabRetryErr) {
          if (!isTransientTabIssue(noTabRetryErr)) {
            await appendDebugLog('error', noTabRetryErr.message || noTabRetryErr, { endpoint, method, retry: 'no-tab' });
          }
          throw noTabRetryErr;
        }
      }

      // Sekme kapanması/geçişi gibi istemci tarafı bir hata için yalnızca
      // bir kez, aynı sekmede ve aralık bırakarak dene. Yeni sekme açıp aynı
      // endpoint'i tekrar vurmak Instagram tarafında gereksiz trafik üretir.
      await new Promise(r => setTimeout(r, 2000));
      try {
        const data = await execRestInTab(tabId, url, method, body ?? null);
        await appendDebugLog('info', 'execRestInTab başarılı (retry-same)', { endpoint, method });
        return data;
      } catch (sameTabError) {
        if (
          isRateLimitMessage(sameTabError) ||
          isSessionError(sameTabError) ||
          isAccessBlockedMessage(sameTabError) ||
          isInstagramCheckpointError(sameTabError)
        ) {
          throw sameTabError;
        }
        const isStillEmpty = isTransientTabIssue(sameTabError);
        if (!isStillEmpty) {
          await appendDebugLog('error', sameTabError.message || sameTabError, { endpoint, method, retry: true });
        }
        throw sameTabError;
      }
    }
    const isTransientResponse = isTransientTabIssue(e);
    await appendDebugLog(
      isTransientResponse ? 'warn' : 'error',
      e.message || e,
      { endpoint, method, ...(isTransientResponse ? { transient: true } : {}) },
    );
    throw e;
  }
}

async function apiCall(endpoint, params, method = 'GET', body) {
  return withInstagramRequestSlot(
    `api:${method}:${endpoint}`,
    () => instagramServerRequest(endpoint, params, method, body),
  );
}

// ── GraphQL ile kullanıcı verisi çekme ───────────────────────────────
function profileCount(user, ...paths) {
  let zero = null;
  for (const path of paths) {
    let value = user;
    for (const key of path) value = value?.[key];
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) continue;
    // Instagram can include stale zero REST fields beside live GraphQL edge
    // counts. Keep scanning so a positive edge count wins over that zero.
    if (number > 0) return number;
    zero ??= number;
  }
  return zero ?? 0;
}

async function getUserViaGraphQL(tabId) {
  const storedDocIds = await new Promise(resolve =>
    chrome.storage.local.get([
      DOC_ID_PROFILE_LATEST_KEY,
      DOC_ID_PROFILE_CONTEXT_KEY,
    ], resolve)
  );
  const capturedProfileContext = storedDocIds?.[DOC_ID_PROFILE_CONTEXT_KEY];
  const capturedProfileFriendlyName = String(
    capturedProfileContext?.friendly_name || '',
  ).trim();
  const capturedProfileDocId = /PolarisProfilePageContentQuery/i.test(capturedProfileFriendlyName)
    ? String(
      capturedProfileContext?.doc_id
        || storedDocIds?.[DOC_ID_PROFILE_LATEST_KEY]?.doc_id
        || '',
    ).trim()
    : '';
  // executeScript(args) only accepts JSON-serializable values. The context is
  // optional (for example, before the first profile GraphQL request), so do
  // not pass `undefined` as args[1]. Keep it as a JSON string as an extra
  // guard against stale/non-cloneable values left by an older build.
  let capturedProfileVariablesJson = null;
  try {
    const capturedProfileVariables = storedDocIds?.[DOC_ID_PROFILE_CONTEXT_KEY]?.variables;
    if (capturedProfileVariables && typeof capturedProfileVariables === 'object') {
      capturedProfileVariablesJson = JSON.stringify(capturedProfileVariables);
    }
  } catch {
    capturedProfileVariablesJson = null;
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (capturedDocId, capturedVariablesJson) => {
      // executeScript serializes this function into the page context; helpers
      // declared in background.js are not in scope there. Keep the count
      // normalization helper local so both profile response paths can use it.
      const profileCount = (user, ...paths) => {
        let zero = null;
        for (const path of paths) {
          let value = user;
          for (const key of path) value = value?.[key];
          if (value === null || value === undefined || value === '') continue;
          const number = Number(value);
          if (!Number.isFinite(number) || number < 0) continue;
          if (number > 0) return number;
          zero ??= number;
        }
        return zero ?? 0;
      };
      let capturedVariables = null;
      try {
        capturedVariables = capturedVariablesJson
          ? JSON.parse(capturedVariablesJson)
          : null;
      } catch {
        capturedVariables = null;
      }
      const win = window;
      let fbDtsg = '', lsd = '', userId = '';

      // En güvenilir yöntem: ds_user_id çerezi login'deyken direk userId'yi taşır
      try {
        const dsCookie = document.cookie.match(/(?:^|;)\s*ds_user_id=(\d+)/);
        if (dsCookie?.[1]) userId = dsCookie[1];
      } catch {}

      try { fbDtsg = win.require?.('DTSGInitData')?.token ?? ''; } catch {}
      try { lsd    = win.require?.('LSD')?.token ?? ''; } catch {}
      // Sadece gerçek değer varsa userId'yi güncelle (boş string ile üzerine yazma)
      try {
        const u = win.require?.('CurrentUserInitialData');
        const cand = String(u?.USER_ID ?? u?.userId ?? '');
        if (cand && cand !== '0') userId = cand;
      } catch {}

      // __bbox modüllerini daha güvenli şekilde tara (her iterasyon ayrı try/catch)
      for (const c of win.__bbox?.require ?? []) {
        try {
          if (!Array.isArray(c)) continue;
          const name = c[0];
          const cfg  = Array.isArray(c[3]) ? c[3][0] : c[3];
          if (!cfg || typeof cfg !== 'object') continue;
          if (name === 'DTSGInitData' && cfg.token) fbDtsg = cfg.token;
          if (name === 'LSD' && cfg.token) lsd = cfg.token;
          if (name === 'CurrentUserInitialData' && !userId) {
            const cand = String(cfg.USER_ID ?? cfg.userId ?? '');
            if (cand && cand !== '0') userId = cand;
          }
        } catch {}
      }

      if (!fbDtsg || !lsd) {
        for (const script of document.querySelectorAll('script')) {
          const t = script.textContent ?? '';
          if (!t) continue;
          if (!fbDtsg) { const m = t.match(/"DTSGInitData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/); if (m) fbDtsg = m[1]; }
          if (!lsd)    { const m = t.match(/"LSD"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/); if (m) lsd = m[1]; }
          if (!userId || userId === '0') { const m = t.match(/"USER_ID"\s*:\s*"(\d+)"/); if (m) userId = m[1]; }
          if (fbDtsg && lsd && userId && userId !== '0') break;
        }
      }

      /*
       * A complete profile object can already be present in the page's
       * downloaded bootstrap data. Do not fail with USER_ID bulunamadı just
       * because one GraphQL token is hidden by an isolated-world boundary.
       */
      const downloadedUsers = [];
      const addDownloadedUser = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 8) return;
        const candidate = value.user_dict ?? value.user ?? value;
        if (candidate && typeof candidate === 'object') {
          const pk = String(candidate.pk ?? candidate.id ?? candidate.fbid_v2 ?? '').trim();
          if (pk || candidate.username || candidate.follower_count != null || candidate.following_count != null) {
            downloadedUsers.push(candidate);
          }
        }
        for (const child of Object.values(value)) {
          if (child && typeof child === 'object') addDownloadedUser(child, depth + 1);
        }
      };
      try {
        addDownloadedUser(win.__additionalDataCurrentUser?.data?.user);
        addDownloadedUser(win._sharedData?.config?.viewer);
        addDownloadedUser(win.__initialData);
        for (const script of document.querySelectorAll('script')) {
          const text = script.textContent ?? '';
          for (const raw of [text, text.replace(/^for\s*\(;;\);\s*/, '')]) {
            try { addDownloadedUser(JSON.parse(raw)); } catch {}
          }
        }
      } catch {}
      const downloadedUser = downloadedUsers
        .filter((candidate) => candidate.pk || candidate.id || candidate.fbid_v2)
        .sort((a, b) =>
          Number(b.follower_count != null) + Number(b.following_count != null) -
          Number(a.follower_count != null) - Number(a.following_count != null)
        )[0];
      if (downloadedUser && (!fbDtsg || !lsd ||
          (downloadedUser.follower_count != null && downloadedUser.following_count != null))) {
        const downloadedId = String(downloadedUser.pk ?? downloadedUser.id ?? downloadedUser.fbid_v2);
        return {
          ok: true,
          user: {
            ...downloadedUser,
            pk: downloadedId,
            follower_count: profileCount(
              downloadedUser,
              ['follower_count'],
              ['followers_count'],
              ['edge_followed_by', 'count'],
              ['edge_followed_by_v2', 'count'],
            ),
            following_count: profileCount(
              downloadedUser,
              ['following_count'],
              ['follows_count'],
              ['edge_follow', 'count'],
              ['edge_following', 'count'],
            ),
            media_count: profileCount(
              downloadedUser,
              ['media_count'],
              ['posts_count'],
              ['edge_owner_to_timeline_media', 'count'],
              ['edge_owner_to_timeline_media_v2', 'count'],
            ),
          },
          fbDtsg, lsd, csrf: document.cookie.split(';').find(c => c.trim().startsWith('csrftoken='))?.split('=')[1] ?? '',
        };
      }

      if (!fbDtsg || !lsd) return { ok: false, errors: [`Instagram sayfa verisi eksik — fb_dtsg:${!!fbDtsg} lsd:${!!lsd}`] };

      const csrf = document.cookie.split(';').find(c => c.trim().startsWith('csrftoken='))?.split('=')[1] ?? '';
      const jazoest = '2' + String(Array.from(fbDtsg).reduce((a, c) => a + c.charCodeAt(0), 0));

      const doGql = async (docId, variables, actorId = '0', friendlyName = '') => {
        // A single profile refresh can require two GraphQL calls. Keep the
        // same conservative spacing inside this executeScript as well as
        // between separate extension messages.
        await new Promise(resolve => setTimeout(resolve, 1500));
        const body = new URLSearchParams({
          av: actorId, __d: 'www', __user: '0', __a: '1', __req: 'g',
          __comet_req: '7', __spin_b: 'trunk', __spin_r: '1043716065', __spin_t: '0',
          fb_dtsg: fbDtsg, jazoest, lsd,
          variables: JSON.stringify(variables),
          doc_id: docId,
          server_timestamps: 'true',
          fb_api_caller_class: 'RelayModern',
        });
        if (friendlyName) body.set('fb_api_req_friendly_name', friendlyName);
        const proxyResponse = await chrome.runtime.sendMessage({
          type: 'LICENSED_INSTAGRAM_REQUEST',
          endpoint: '/api/graphql',
          params: {},
          method: 'POST',
          body: body.toString(),
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-asbd-id': '359341',
            'x-fb-dtsg': fbDtsg,
            'x-fb-friendly-name': friendlyName || 'PolarisProfilePageContentQuery',
            'x-fb-lsd': lsd,
            'x-ig-app-id': '936619743392459',
            'x-ig-max-touch-points': '1',
            'x-ig-www-claim': '0',
            'x-requested-with': 'XMLHttpRequest',
          },
        });
        if (!proxyResponse?.ok) {
          throw new Error(proxyResponse?.error || 'Lisanslı Instagram isteği başarısız oldu.');
        }
        const json = proxyResponse.data;
        if (!json || typeof json !== 'object') {
          throw new Error('Lisanslı Instagram isteği geçersiz yanıt döndürdü.');
        }
        if (json.errors?.length) throw new Error(JSON.stringify(json.errors).slice(0, 100));
        return json;
      };

      // Profile sorgusu için yardımcı vars
      const profileVars = (
        uid,
        useCapturedVariables = true,
        replaceEveryIdentity = false,
      ) => {
        const vars = useCapturedVariables && capturedVariables &&
          typeof capturedVariables === 'object'
          ? { ...capturedVariables }
          : {
              enable_integrity_filters: true,
              id: String(uid),
              __relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider: true,
              __relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider: false,
              __relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider: false,
              __relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider: true,
              __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
            };
        // A captured request can contain more than one identity alias. Updating
        // only the first one leaves a stale profile ID behind and can make
        // Instagram reject the request with missing_required_variable_value.
        const identityKeys = [
          'id',
          'userID',
          'user_id',
          'igid',
          'profile_id',
        ];
        const presentIdentityKeys = identityKeys.filter(key =>
          Object.prototype.hasOwnProperty.call(vars, key),
        );
        let replacedIdentity = false;
        for (const key of identityKeys) {
          if (presentIdentityKeys.length &&
              (replaceEveryIdentity || key === presentIdentityKeys[0])) {
            vars[key] = String(uid);
            replacedIdentity = true;
          }
        }
        if (!replacedIdentity) vars.id = String(uid);
        return vars;
      };

      // GraphQL ile user_dict + sayılar. current_user REST endpoint'i
      // useragent mismatch verdiği için burada tekrar denenmez.
      // doc_id runtime'da Polaris bundle'ından çekiliyor. Bulunamazsa service
      // worker'ın gerçek tarayıcı isteğinden yakaladığı başarılı profil
      // operasyonu kullanılır; sabit HAR değeri kullanılmaz.
      const resolveProfileDocId = () => {
        try {
          for (const mod of win.__bbox?.require ?? []) {
            if (!Array.isArray(mod)) continue;
            const [name] = mod;
            if (name && /^Polaris(?:ProfilePageContent(?:Content)?Query|ProfilePageQuery)(?:_instagramRelayOperation)?$/.test(name)) {
              const cfg = Array.isArray(mod[3]) ? mod[3][0] : mod[3];
              const id = typeof cfg === 'string' ? cfg : cfg?.id ?? cfg?.doc_id;
              if (id && /^\d{10,20}$/.test(String(id))) return String(id);
            }
          }
          const direct = win.require?.('PolarisProfilePageContentQuery_instagramRelayOperation');
          const directId = typeof direct === 'string'
            ? direct
            : direct?.id ?? direct?.doc_id;
          if (directId && /^\d{10,20}$/.test(String(directId))) return String(directId);
          for (const script of win.document?.querySelectorAll?.('script') ?? []) {
            const text = script.textContent ?? '';
            const match = text.match(
              /PolarisProfilePageContent(?:Content)?Query_instagramRelayOperation[\s\S]{0,240}?"id"\s*:\s*"(\d{10,20})"/,
            );
            if (match?.[1]) return match[1];
          }
        } catch {}
        // Service worker'ın tarayıcıdan yakaladığı son profil operasyonunu
        // kullan. Sabit bir HAR doc_id'siyle istek gönderme.
        return /^\d{10,20}$/.test(String(capturedDocId || ''))
          ? String(capturedDocId)
          : '';
      };
      const profileDocId = resolveProfileDocId();
      if (!profileDocId) {
        return { ok: false, errors: ['Instagram profil GraphQL operasyonu henüz yakalanmadı'] };
      }

      if (!userId || userId === '0') {
        try {
          const r = await doGql(profileDocId, profileVars('1'), '0', 'PolarisProfilePageContentQuery');
          userId = String(
            r.data?.viewer?.user?.pk ??
            r.data?.viewer?.user?.fbid_v2 ??
            r.data?.user?.pk ??
            r.data?.user?.id ??
            '',
          );
        } catch {}
      }
      if (!userId || userId === '0') return { ok: false, errors: ['USER_ID bulunamadı'] };

      const queryCandidates = [];
      // The captured variables belong to the profile currently open in the
      // tab, not necessarily to the authenticated viewer. Reuse the exact
      // captured shape first, changing only its primary identity field. Some
      // operations contain a second ID for a different purpose; overwriting
      // every ID can turn an otherwise valid request into a GraphQL
      // missing_required_variable_value error. If that shape is rejected,
      // retry with the defensive all-alias form and then canonical variables.
      queryCandidates.push(profileVars(userId, true, false));
      queryCandidates.push(profileVars(userId, true, true));
      if (capturedVariables) queryCandidates.push(profileVars(userId, false));
      const tried = new Set();
      let lastResponse = null;
      for (let index = 0; index < queryCandidates.length && index < 3; index += 1) {
        const variables = queryCandidates[index];
        const identity = JSON.stringify(variables);
        if (tried.has(identity)) continue;
        tried.add(identity);
        try {
          // The captured browser request uses av=0. Sending ds_user_id as the
          // actor can return only xig_user_by_igid_v2.id with no user_dict.
          const r = await doGql(
            profileDocId,
            variables,
            '0',
            'PolarisProfilePageContentQuery',
          );
          lastResponse = r;
          const responseUsers = [
            r.data?.xig_user_by_igid_v2?.user_dict,
            r.data?.user,
            r.data?.viewer?.user,
          ].filter(user => user && typeof user === 'object');
          const dict = responseUsers.find(user => {
            const responseUserId = String(
              user?.pk ?? user?.fbid_v2 ?? user?.id ?? '',
            ).trim();
            return responseUserId === userId;
          }) ?? null;
          const dictId = String(
            dict?.pk ?? dict?.fbid_v2 ?? dict?.id ?? '',
          ).trim();
          // Do not accept a profile dictionary merely because the request was
          // sent with the viewer ID. Some Instagram responses contain the
          // profile currently visible in the tab. Requiring the returned
          // object's own ID prevents a follower's name/counts being attached
          // to the authenticated account.
          if (!dict || (dictId && dictId !== userId) || !dictId) {
            continue;
          }
          const pk = dict.pk ?? dict.fbid_v2 ?? userId;
          return {
            ok: true,
            user: {
              pk: String(pk),
              username: dict.username,
              full_name: dict.full_name,
              profile_pic_url: dict.profile_pic_url ?? (dict.hd_profile_pic_url_info?.url ?? null),
              follower_count: profileCount(
                dict,
                ['follower_count'],
                ['followers_count'],
                ['edge_followed_by', 'count'],
                ['edge_followed_by_v2', 'count'],
              ),
              following_count: profileCount(
                dict,
                ['following_count'],
                ['follows_count'],
                ['edge_follow', 'count'],
                ['edge_following', 'count'],
              ),
              media_count: profileCount(
                dict,
                ['media_count'],
                ['posts_count'],
                ['edge_owner_to_timeline_media', 'count'],
                ['edge_owner_to_timeline_media_v2', 'count'],
              ),
              is_verified: !!dict.is_verified,
              is_private: !!dict.is_private,
              biography: dict.biography ?? null,
              fbid_v2: dict.fbid_v2,
            },
            fbDtsg, lsd, csrf,
          };
        } catch (error) {
          lastResponse = { error: error?.message || String(error) };
        }
      }
      return {
        ok: false,
        errors: ['user_dict boş — ' + JSON.stringify(lastResponse?.data ?? lastResponse).slice(0, 240)],
      };
    },
    args: [capturedProfileDocId, capturedProfileVariablesJson],
  });

  const result = results[0];
  if (result?.error) throw new Error('executeScript hatası: ' + result.error.message);
  const res = result?.result;
  if (!res) throw new Error('executeScript boş sonuç döndü');
  if (!res.ok) throw new Error(res.errors?.join(' | ') ?? 'bilinmeyen hata');

  // Tokenleri kaydet
  if (res.fbDtsg && res.lsd) {
    chrome.storage.local.set({ igGqlTokens: { fbDtsg: res.fbDtsg, lsd: res.lsd, csrf: res.csrf ?? '', ts: Date.now() } });
  }
  return res.user;
}

// ── Panel'e durum yayını ──────────────────────────────────────────────
function broadcastStatus() {
  const panelUrl = chrome.runtime.getURL('panel.html');
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      // startsWith kullan: React Router hash/path değiştiğinde URL panel.html#/... şeklinde olur,
      // tam eşleşme (===) bu durumda mesajı hiç göndermez.
      if (tab.url && tab.url.startsWith(panelUrl) && tab.id != null) {
        sendTabMessageSilently(tab.id, { type: 'IG_AUTO_STATUS' });
      }
    }
  });
}

function discoveryUserId(user) {
  return String(user?.id ?? user?.pk ?? user?.fbid_v2 ?? user?.username ?? '').trim();
}

function isDiscoveryRelationFlagSet(value) {
  return value === true || value === 1 || value === '1';
}

// A list response contains the relationship between the logged-in account
// and each returned user. Never send a create request for a user that is
// already followed or already has an outgoing request, even if the local
// following cache is stale or empty.
function hasExistingDiscoveryRelationship(user) {
  const friendship = user?.friendship_status ?? user?.friendshipStatus ?? {};
  return (
    isDiscoveryRelationFlagSet(user?.alreadyFollowing) ||
    isDiscoveryRelationFlagSet(user?.followRequestSent) ||
    isDiscoveryRelationFlagSet(friendship.following) ||
    isDiscoveryRelationFlagSet(friendship.is_following) ||
    isDiscoveryRelationFlagSet(friendship.outgoing_request) ||
    isDiscoveryRelationFlagSet(friendship.outgoingRequest)
  );
}

function normalizeDiscoveryUser(user) {
  const id = discoveryUserId(user);
  const username = String(user?.username ?? '').trim();
  const friendship = user?.friendship_status ?? user?.friendshipStatus ?? {};
  const photoUrls = [
    user?.profile_pic_url_hd,
    user?.hd_profile_pic_url_info?.url,
    user?.profile_pic_url_info?.url,
    user?.profile_pic_url,
  ]
    .map(value => String(value ?? '').trim())
    .filter(value => /^https?:\/\//i.test(value));
  const profilePhoto = photoUrls[0] || '';
  return id && username ? {
    id,
    username,
    full_name: String(user?.full_name ?? ''),
    biography: String(user?.biography ?? ''),
    profile_pic_url: profilePhoto,
    profile_pic_url_hd: profilePhoto,
    // Missing counts are not zero. A list item often has no profile totals;
    // displaying 0 would falsely suggest that Instagram returned an empty
    // profile.
    follower_count: user?.follower_count == null
      ? null
      : Number(user.follower_count),
    following_count: user?.following_count == null
      ? null
      : Number(user.following_count),
    follower_count_known: user?.follower_count != null,
    following_count_known: user?.following_count != null,
    gender: ['male', 'female', 'unknown'].includes(user?.gender) ? user.gender : '',
    gender_confidence: Number(user?.gender_confidence) || 0,
    alreadyFollowing: (
      isDiscoveryRelationFlagSet(friendship.following) ||
      isDiscoveryRelationFlagSet(friendship.is_following)
    ),
    followRequestSent: (
      isDiscoveryRelationFlagSet(friendship.outgoing_request) ||
      isDiscoveryRelationFlagSet(friendship.outgoingRequest)
    ),
    discoveryRelation: user?.discoveryRelation === 'following' ? 'following' : 'followers',
    discoverySeedId: String(user?.discoverySeedId ?? ''),
    discoverySeedUsername: String(user?.discoverySeedUsername ?? ''),
  } : null;
}

function uniqueDiscoveryUsers(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map(normalizeDiscoveryUser)
    .filter(user => user && !seen.has(user.id) && (seen.add(user.id), true));
}

function shuffleDiscoveryUsers(list) {
  const shuffled = Array.isArray(list) ? [...list] : [];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Reservoir sampling keeps one uniformly random eligible follower across
// every paginated result without retaining the entire follower list.
function updateRandomFollowedFollowerSample(queue, users, ownUserId, sourceId) {
  if (!ownUserId) return;
  const seenIds = new Set(
    Array.isArray(queue.randomFollowedSeenIds)
      ? queue.randomFollowedSeenIds.map(String)
      : [],
  );
  let eligibleCount = Math.max(0, Number(queue.randomFollowedCandidateCount) || 0);
  let selected = queue.randomFollowedCandidate || null;

  for (const user of Array.isArray(users) ? users : []) {
    const id = discoveryUserId(user);
    if (
      !id ||
      id === ownUserId ||
      id === String(sourceId) ||
      user?.alreadyFollowing !== true ||
      user?.followRequestSent === true ||
      seenIds.has(id)
    ) continue;

    seenIds.add(id);
    eligibleCount += 1;
    if (Math.random() < 1 / eligibleCount) selected = user;
  }

  queue.randomFollowedSeenIds = [...seenIds];
  queue.randomFollowedCandidateCount = eligibleCount;
  queue.randomFollowedCandidate = selected;
}

async function fetchDiscoveryRelationList(userId, relation, maxId = null) {
  const normalizedRelation = relation === 'following' ? 'following' : 'followers';
  const endpoint = `/api/v1/friendships/${encodeURIComponent(userId)}/${normalizedRelation}/`;
  // This is the request Instagram Web currently makes when the user opens
  // the followers/following dialog (see the supplied HAR):
  // count=12 + search_surface=follow_list_page. Despite count=12, Instagram
  // may return up to 50 users and mark the response has_more:false.
  const params = {
    count: String(IG_MAX_LIST_PAGE_SIZE),
    search_surface: 'follow_list_page',
  };
  if (maxId) params.max_id = String(maxId);
  const data = await apiCall(endpoint, params);
  const rawUsers = extractFollowUsers(data);
  await appendDiscoveryLog('info', 'Takip listesi çekildi', {
    userId: String(userId),
    relation: normalizedRelation,
    endpoint,
    rawCount: rawUsers.length,
    uniqueCount: uniqueDiscoveryUsers(rawUsers).length,
    action: `${normalizedRelation === 'following' ? 'takip edilenler' : 'takipçiler'} hazır`,
  });
  return {
    endpoint,
    rawCount: rawUsers.length,
    nextMaxId: data?.next_max_id ?? null,
    users: uniqueDiscoveryUsers(rawUsers),
  };
}

// Rotate completed direct-follower scans through the signed-in user's own
// following list. Page reads are bounded per pass; the pool and cursor persist
// across queue resets so large following lists continue without a burst.
async function chooseNextFollowedDiscoverySource(queue, ownUserId, currentSourceId) {
  const ownId = String(ownUserId || '').trim();
  if (!ownId) {
    return { candidate: null, reason: 'session-identity-unavailable', exhausted: false };
  }

  const previousOwnerId = String(queue.sourceRotationOwnerId || '').trim();
  if (previousOwnerId && previousOwnerId !== ownId) {
    queue.sourceRotationPool = [];
    queue.sourceRotationVisitedIds = [String(currentSourceId || '').trim()].filter(Boolean);
    queue.sourceRotationNextMaxId = null;
    queue.sourceRotationPageCount = 0;
    queue.sourceRotationSeenCursors = [];
    queue.sourceRotationComplete = false;
  }
  queue.sourceRotationOwnerId = ownId;
  if (!Array.isArray(queue.sourceRotationPool)) queue.sourceRotationPool = [];
  if (!Array.isArray(queue.sourceRotationVisitedIds)) queue.sourceRotationVisitedIds = [];
  if (!Array.isArray(queue.sourceRotationSeenCursors)) queue.sourceRotationSeenCursors = [];
  queue.sourceRotationVisitedIds = [...new Set(
    queue.sourceRotationVisitedIds.map(String).filter(Boolean).concat(
      String(currentSourceId || '').trim(),
    ).filter(Boolean),
  )];
  queue.sourceRotationPageCount = Math.max(0, Number(queue.sourceRotationPageCount) || 0);
  queue.sourceRotationComplete = queue.sourceRotationComplete === true;
  queue.sourceRotationNextMaxId = queue.sourceRotationNextMaxId
    ? String(queue.sourceRotationNextMaxId)
    : null;
  let pagesFetchedThisPass = 0;

  while (true) {
    const visited = new Set(queue.sourceRotationVisitedIds);
    const eligible = queue.sourceRotationPool.filter(user => {
      const id = discoveryUserId(user);
      return id && id !== ownId && !visited.has(id);
    });
    if (eligible.length) {
      const candidate = eligible[Math.floor(Math.random() * eligible.length)];
      queue.sourceRotationVisitedIds.push(discoveryUserId(candidate));
      return {
        candidate,
        reason: '',
        exhausted: false,
        pageCount: queue.sourceRotationPageCount,
      };
    }

    if (queue.sourceRotationComplete) {
      return {
        candidate: null,
        reason: 'all-followed-sources-visited',
        exhausted: true,
        pageCount: queue.sourceRotationPageCount,
      };
    }

    if (pagesFetchedThisPass >= IG_MAX_FOLLOWING_PAGES) {
      return {
        candidate: null,
        reason: 'source-list-page-batch-pending',
        exhausted: false,
        pageCount: queue.sourceRotationPageCount,
      };
    }

    const cursorKey = queue.sourceRotationNextMaxId || '__first-page__';
    if (queue.sourceRotationSeenCursors.includes(cursorKey)) {
      queue.sourceRotationComplete = true;
      return {
        candidate: null,
        reason: 'source-list-pagination-stalled',
        exhausted: true,
        pageCount: queue.sourceRotationPageCount,
      };
    }
    queue.sourceRotationSeenCursors.push(cursorKey);
    const page = await fetchDiscoveryRelationList(
      ownId,
      'following',
      queue.sourceRotationNextMaxId,
    );
    queue.sourceRotationPageCount += 1;
    pagesFetchedThisPass += 1;
    queue.sourceRotationPool = uniqueDiscoveryUsers([
      ...queue.sourceRotationPool,
      ...page.users,
    ]);
    queue.sourceRotationNextMaxId = page.nextMaxId
      ? String(page.nextMaxId)
      : null;
    queue.sourceRotationComplete = !queue.sourceRotationNextMaxId;

    await appendDiscoveryLog('info', 'Rastgele yeni kaynak için takip listesi alındı', {
      ownUserId: ownId,
      endpoint: page.endpoint,
      page: queue.sourceRotationPageCount,
      rawCount: page.rawCount,
      sourcePoolCount: queue.sourceRotationPool.length,
      nextPage: !!queue.sourceRotationNextMaxId,
      pagesFetchedThisPass,
      pageBatchLimit: IG_MAX_FOLLOWING_PAGES,
      action: 'daha önce taranmamış takip edilen hesaplar arasından kaynak seçilecek',
    });
  }
}

// Instagram profilinde "Senin takip ettiğin ... kişi tarafından takip
// ediliyor" şeklinde görünen ortak hesapları getirir. Bu, hedef hesabın
// takipçileri ile giriş yapan hesabın takip ettiklerinin kesişimidir.
async function fetchMutualFollowers(userId) {
  const endpoint = `/api/v1/friendships/${encodeURIComponent(userId)}/mutual_followers/`;
  const params = { count: '50' };
  const data = await apiCall(endpoint, params);
  const users = uniqueDiscoveryUsers(extractFollowUsers(data));
  const reportedCount = Number(
    data?.num_mutual_followers ??
    data?.mutual_followers_count ??
    data?.mutual_count ??
    data?.data?.num_mutual_followers ??
    data?.data?.mutual_followers_count ??
    0,
  );
  const mutualCount = Math.max(reportedCount, users.length);
  await appendDiscoveryLog('info', 'Ortak hesaplara bakıldı', {
    targetId: String(userId),
    endpoint,
    mutualCount,
    returnedUserCount: users.length,
    action: 'ortak hesap sayısı alındı',
  });
  return {
    endpoint,
    rawCount: users.length,
    count: mutualCount,
    users,
  };
}

// Beğeni ve keşif aynı anda açıksa keşif kaynağı panelde yazılan sabit hesap
// değil, az önce içeriği beğenilen hesaptır. Adaylar tek tek ilerletilir:
// mutual eşiği → canlı takip durumu → cinsiyet → gerekiyorsa takip isteği.
async function runLikeTriggeredMutualDiscovery(sourceUser) {
  const state = await getState();
  const minMutualCount = state.discoveryMinMutualCount;
  const targetGender = ['female', 'male', 'both'].includes(state.discoveryTargetGender)
    ? state.discoveryTargetGender
    : 'female';
  const targetGenderLabel = targetGender === 'male'
    ? 'erkek'
    : targetGender === 'both'
      ? 'kadın ve erkek'
      : 'kadın';
  if (!state.enabled || !state.discoveryEnabled || !sourceUser) return;
  await _igRequestBlockReady;
  if (_igMutualFollowersBlockedUntil > Date.now()) {
    if (_lastMutualCooldownLogUntil !== _igMutualFollowersBlockedUntil) {
      _lastMutualCooldownLogUntil = _igMutualFollowersBlockedUntil;
      await appendDiscoveryLog('warn', 'Ortak hesap keşfi beklemede', {
        cooldownMinutes: Math.max(
          1,
          Math.ceil((_igMutualFollowersBlockedUntil - Date.now()) / 60000),
        ),
        scope: 'mutual_followers',
        action: 'keşif adımı atlandı; beğeni otomasyonu ve diğer istekler devam edebilir',
      });
    }
    return;
  }
  if (state.discoveryTodayCount >= state.discoveryMaxPerDay) {
    await appendDiscoveryLog('info', 'Beğeni sonrası keşif kotası dolu', {
      sourceAccount: `@${sourceUser.username || sourceUser.id}`,
      action: 'yeni takip isteği gönderilmedi',
    });
    return;
  }

  const sourceId = discoveryUserId(sourceUser);
  const sourceUsername = String(sourceUser.username || sourceId).replace(/^@/, '');
  if (!sourceId) return;

  await appendDiscoveryLog('info', 'Beğeni atılan kullanıcıya girildi', {
    sourceAccount: `@${sourceUsername}`,
    sourceId,
    action: 'takip ettikleri listesi açılacak',
  });
  await appendDiscoveryLog('info', 'Beğeni sonrası takip edilenler taranıyor', {
    sourceAccount: `@${sourceUsername}`,
    sourceId,
    endpoint: `/api/v1/friendships/${sourceId}/following/`,
    action: 'takip edilen hesaplar alınacak ve cinsiyetleri sınıflandırılacak',
  });

  const relationResult = await fetchDiscoveryRelationList(sourceId, 'following');
  const excludedIds = await getDiscoveryExcludedIds(sourceId, []);
  const candidates = relationResult.users.filter(candidate => (
    !excludedIds.has(discoveryUserId(candidate)) &&
    candidate.alreadyFollowing !== true &&
    candidate.followRequestSent !== true
  ));
  if (!candidates.length) {
    await patchState({
      discoveryLastActionLabel: 'Beğeni yapılan hesabın takip listesinde uygun yeni aday bulunamadı',
    });
    await appendDiscoveryLog('info', 'Beğeni yapılan hesabın takip listesi boş', {
      sourceAccount: `@${sourceUsername}`,
      sourceId,
      action: 'takip isteği gönderilmedi',
    });
    return;
  }

  // Önce canlı takip ilişkisini doğrula; zaten takip edilen adaylar için
  // rate-limit'e daha hassas mutual_followers çağrısını boşa harcama.
  for (const candidate of shuffleDiscoveryUsers(candidates)) {
    const targetId = discoveryUserId(candidate);
    const relationship = await getLiveDiscoveryRelationship(targetId);
    if (!relationship.ok) {
      await appendDiscoveryLog('warn', 'Adayın canlı takip durumu doğrulanamadı', {
        sourceAccount: `@${sourceUsername}`,
        candidate: `@${candidate.username}`,
        candidateId: targetId,
        error: relationship.error,
        action: 'mutual ve cinsiyet kontrolü ile takip isteği yapılmadı; güvenli şekilde duruldu',
      });
      await patchState({
        discoveryLastActionLabel: 'Takip adayı doğrulanamadı; Instagram isteği gönderilmedi',
      });
      return;
    }
    if (relationship.following || relationship.outgoingRequest) {
      await recordDiscoveryHistory(candidate, {
        status: 'already-connected',
        sourceId,
        sourceUsername,
        relation: 'following',
        mutualCount: null,
        following: relationship.following,
        outgoingRequest: relationship.outgoingRequest,
        reason: 'already_following_or_requested',
        mutualCheckSkipped: true,
      });
      await appendDiscoveryLog('info', 'Aday zaten takip ediliyor veya bekleyen istek var', {
        sourceAccount: `@${sourceUsername}`,
        candidate: `@${candidate.username}`,
        candidateId: targetId,
        following: relationship.following,
        outgoingRequest: relationship.outgoingRequest,
        action: 'mutual ve cinsiyet kontrolü atlandı; sonraki aday kontrol edilecek',
      });
      continue;
    }

    await appendDiscoveryLog('info', 'Adayın takip edilmediği doğrulandı; ortak hesap kontrolü başlıyor', {
      sourceAccount: `@${sourceUsername}`,
      candidate: `@${candidate.username}`,
      candidateId: targetId,
      action: 'mutual eşiği geçerse cinsiyet kontrolü yapılacak',
    });

    let mutual;
    try {
      mutual = await fetchMutualFollowers(targetId);
    } catch (error) {
      await appendDiscoveryLog('warn', 'Beğeni sonrası adayın ortak hesap kontrolü tamamlanamadı', {
        sourceAccount: `@${sourceUsername}`,
        candidate: `@${candidate.username}`,
        candidateId: targetId,
        error: String(error?.message || error).slice(0, 250),
        action: 'cinsiyet ve takip kontrolü yapılmadı; mevcut bekleme süresi korunarak sonraki tur beklenecek',
      });
      await patchState({
        discoveryLastActionLabel: 'Ortak hesap kontrolü beklemede; bu aday için takip isteği gönderilmedi',
      });
      // Mutual uç noktası hata verdiyse aynı turda yeni isteklerle yük bindirme.
      return;
    }
    const mutualCount = Number(mutual.count) || 0;
    if (
      minMutualCount > 0 &&
      !matchesDiscoveryMutualCount(mutualCount, minMutualCount)
    ) {
      await recordDiscoveryHistory(candidate, {
        status: 'scanned-mutual-rejected',
        sourceId,
        sourceUsername,
        relation: 'following',
        mutualCount,
        reason: 'mutual_count_below_minimum',
        requiredMutualCount: minMutualCount,
        expectedMutualCount: minMutualCount,
      });
      await appendDiscoveryLog('info', 'Beğeni sonrası aday ortak hesap şartını geçemedi', {
        sourceAccount: `@${sourceUsername}`,
        candidate: `@${candidate.username}`,
        candidateId: targetId,
        mutualCount,
        expected: minMutualCount,
        action: 'profil/cinsiyet analizi ve takip isteği yapılmadı',
      });
      continue;
    }

    await appendDiscoveryLog('info', 'Aday ortak hesap sayısıyla eşleşti; cinsiyet kontrolü başlıyor', {
      sourceAccount: `@${sourceUsername}`,
      candidate: `@${candidate.username}`,
      candidateId: targetId,
      mutualCount,
      expected: minMutualCount,
      action: 'cinsiyet analizi tamamlanırsa hedef cinsiyete göre takip isteği değerlendirilecek',
    });

    const candidateForAnalysis = { ...candidate, mutualCount };
    const classified = (await classifyGenderInBackground([candidateForAnalysis]))[0]
      || candidateForAnalysis;
    const gender = ['male', 'female', 'unknown'].includes(classified.gender)
      ? classified.gender
      : 'unknown';
    const normalizedCandidate = { ...classified, gender, mutualCount };
    await recordDiscoveryHistory(normalizedCandidate, {
      status: 'scanned',
      sourceId,
      sourceUsername,
      relation: 'following',
      mutualCount,
      gender,
      gender_confidence: Number(classified.gender_confidence) || 0,
    });
    await updateDiscoveryGenderState({ gender }, targetGender);
    const matchesTargetGender = gender === 'female'
      ? targetGender === 'female' || targetGender === 'both'
      : gender === 'male'
        ? targetGender === 'male' || targetGender === 'both'
        : false;
    await appendDiscoveryLog('info', 'Adayın cinsiyet kontrolü tamamlandı', {
      sourceAccount: `@${sourceUsername}`,
      candidate: `@${candidate.username}`,
      candidateId: targetId,
      mutualCount,
      gender,
      targetGender,
      matchesTargetGender,
      action: matchesTargetGender
        ? 'takip isteği öncesi canlı takip durumu yeniden doğrulanacak'
        : `hedef cinsiyet (${targetGenderLabel}) eşleşmedi; sonraki aday kontrol edilecek`,
    });
    if (!matchesTargetGender) continue;

    let followResult;
    try {
      followResult = await sendAutomaticDiscoveryFollow(
        normalizedCandidate,
        sourceId,
        'following',
        gender,
      );
    } catch (error) {
      await appendDiscoveryLog('error', 'Eşik ve cinsiyet kontrolü geçen aday için takip isteği başarısız oldu', {
        sourceAccount: `@${sourceUsername}`,
        candidate: `@${candidate.username}`,
        candidateId: targetId,
        mutualCount,
        gender,
        error: String(error?.message || error).slice(0, 250),
        action: 'bu turda başka takip isteği denenmedi',
      });
      return;
    }

    if (
      followResult?.alreadySent ||
      (followResult?.skipped && [
        'already-following-or-requested',
        'excluded',
      ].includes(followResult.reason))
    ) {
      await appendDiscoveryLog('info', 'Aday için yeni takip isteği gerekmedi', {
        sourceAccount: `@${sourceUsername}`,
        candidate: `@${candidate.username}`,
        candidateId: targetId,
        mutualCount,
        gender,
        reason: followResult.reason || 'already-sent',
        action: 'sonraki aday kontrol edilecek',
      });
      continue;
    }

    if (!followResult?.ok || followResult?.skipped) {
      await appendDiscoveryLog('warn', 'Takip isteği güvenlik kontrolünde gönderilmedi', {
        sourceAccount: `@${sourceUsername}`,
        candidate: `@${candidate.username}`,
        candidateId: targetId,
        mutualCount,
        gender,
        reason: followResult?.reason || 'follow-not-confirmed',
        error: followResult?.error || '',
        action: 'durum doğrulanamadığı veya kota dolduğu için bu tur durduruldu',
      });
      return;
    }

    {
      await upsertDiscoveryAutoResult({
        ...normalizedCandidate,
        id: targetId,
        pk: targetId,
        sourceId,
        sourceUsername,
        relation: 'following',
        mutualCount,
        mutualFilterEnabled: minMutualCount > 0,
        requiredMutualCount: minMutualCount,
        gender,
        targetGender,
        followStatus: 'sent',
        following: followResult.status?.following === true,
        outgoingRequest: followResult.status?.outgoingRequest === true,
        followReason: followResult.status?.outgoingRequest
          ? 'Instagram giden takip isteğini doğruladı'
          : 'Instagram takip ilişkisini doğruladı',
        discoveryVersion: 6,
        ts: Date.now(),
      });
    }
    await appendDiscoveryLog('info', 'Beğeni sonrası ortak hesap akışı tamamlandı', {
      sourceAccount: `@${sourceUsername}`,
      candidate: `@${candidate.username}`,
      candidateId: targetId,
      mutualCount,
      gender,
      targetGender,
      followStatus: 'sent',
      action: followResult.status?.outgoingRequest
        ? 'Instagram giden takip isteğini doğruladı'
        : 'Instagram takip ilişkisini doğruladı',
    });
    return;
  }

  await appendDiscoveryLog('info', 'Beğeni sonrası uygun ortak hesap adayı bulunamadı', {
    sourceAccount: `@${sourceUsername}`,
    sourceId,
    targetGender,
    action: 'mutual, canlı takip durumu ve cinsiyet kontrollerinden geçen aday bulunamadı; takip isteği gönderilmedi',
  });
  await patchState({
    discoveryLastActionLabel: minMutualCount > 0
      ? `Beğeni sonrası takip taraması: en az ${minMutualCount} ortak hesap ve ${targetGenderLabel} filtresini geçen aday bulunamadı`
      : `Beğeni sonrası takip taraması: ${targetGenderLabel} filtresini geçen aday bulunamadı`,
  });
}

// Follow discovery runs separately from the like tick. A long candidate scan
// or the mutual-followers cooldown must not keep the like lock held. Retain at
// most the latest pending source so overlapping likes cannot create an
// unbounded discovery backlog.
function scheduleLikeTriggeredMutualDiscovery(sourceUser) {
  if (!sourceUser) return;
  _pendingLikeTriggeredDiscoverySource = sourceUser;
  if (_likeTriggeredDiscoveryInFlight) return;

  _likeTriggeredDiscoveryInFlight = true;
  void (async () => {
    try {
      while (_pendingLikeTriggeredDiscoverySource) {
        const nextSource = _pendingLikeTriggeredDiscoverySource;
        _pendingLikeTriggeredDiscoverySource = null;
        try {
          await runLikeTriggeredMutualDiscovery(nextSource);
        } catch (error) {
          await appendDiscoveryLog('error', 'Beğeni sonrası takip taraması başarısız oldu', {
            sourceAccount: `@${nextSource.username || nextSource.id || ''}`,
            error: String(error?.message || error).slice(0, 250),
            action: 'beğeni döngüsü beklemeden devam ediyor',
          }).catch(() => {});
        }
      }
    } finally {
      _likeTriggeredDiscoveryInFlight = false;
      if (_pendingLikeTriggeredDiscoverySource) {
        scheduleLikeTriggeredMutualDiscovery(_pendingLikeTriggeredDiscoverySource);
      }
    }
  })().catch(() => {
    _likeTriggeredDiscoveryInFlight = false;
  });
}

// A discovery target must not be one of the source account's direct contacts.
// For the requested self -> own follower -> follower flow this also excludes
// the current account's cached following list, when it is available.
async function getDiscoveryExcludedIds(sourceId, seedUsers) {
  const stored = await new Promise(resolve => chrome.storage.local.get([
    'igUser',
    '__cached_following',
    '__discovery_follow_status_v1',
    DISCOVERY_HISTORY_KEY,
  ], resolve));
  const excluded = new Set((Array.isArray(seedUsers) ? seedUsers : [])
    .map(discoveryUserId)
    .filter(Boolean));
  const ownId = discoveryUserId(stored.igUser);
  // Bir kaynak hesabın takipçileri arasında oturum açmış hesap da olabilir
  // (özellikle karşılıklı takipte). Kendi hesabına takip isteği gönderilmesini
  // kesin olarak engelle.
  if (ownId) excluded.add(ownId);
  // __cached_following may also contain a manually requested profile's
  // following list. Only treat it as the current account's following list
  // when its cached userId matches the logged-in account.
  const cachedFollowing = stored.__cached_following;
  if (ownId && String(cachedFollowing?.userId || '') === ownId) {
    for (const user of cachedFollowing?.users ?? []) {
      const id = discoveryUserId(user);
      if (id) excluded.add(id);
    }
  }
  for (const [id, status] of Object.entries(stored.__discovery_follow_status_v1 ?? {})) {
    if (status?.status === 'sent') excluded.add(String(id));
  }
  for (const [id, history] of Object.entries(stored[DISCOVERY_HISTORY_KEY] ?? {})) {
    if (id && (!ownId || !history?.accountId || String(history.accountId) === ownId)) {
      excluded.add(String(id));
    }
  }
  return excluded;
}

async function getLiveDiscoveryRelationship(userId) {
  const id = String(userId || '').trim();
  if (!id) return { ok: false, error: 'hedef hesap kimliği yok' };
  try {
    const response = await apiCall(
      `/api/v1/friendships/show/${encodeURIComponent(id)}/`,
    );
    const friendship = response?.friendship_status ??
      response?.data?.friendship_status ??
      response?.data ??
      response ??
      {};
    return {
      ok: true,
      following: isDiscoveryRelationFlagSet(friendship.following) ||
        isDiscoveryRelationFlagSet(friendship.is_following),
      outgoingRequest: isDiscoveryRelationFlagSet(friendship.outgoing_request) ||
        isDiscoveryRelationFlagSet(friendship.outgoingRequest),
    };
  } catch (error) {
    await appendDiscoveryLog('warn', 'Aday ilişki kontrolü yapılamadı; istek gönderilmedi', {
      phase: 'discovery-follow-guard',
      candidateId: id,
      error: String(error?.message || error).slice(0, 250),
      action: 'güvenli tarafta kalmak için Instagram POST isteği engellendi',
    });
    return { ok: false, error: String(error?.message || error) };
  }
}

function isCurrentUsersFollowList(payload, user) {
  const payloadOwnerId = String(payload?.ownerId || '').trim();
  const currentUserId = String(user?.pk ?? user?.fbid_v2 ?? user?.id ?? '').trim();
  if (payloadOwnerId) return Boolean(currentUserId) && payloadOwnerId === currentUserId;

  const payloadOwnerUsername = String(payload?.ownerUsername || '')
    .replace(/^@/, '').trim().toLowerCase();
  const currentUsername = String(user?.username || '')
    .replace(/^@/, '').trim().toLowerCase();
  return Boolean(payloadOwnerUsername && currentUsername) &&
    payloadOwnerUsername === currentUsername;
}

async function verifyAutolikeCandidateStillFollowed(candidate, contentType) {
  const candidateId = String(candidate?.id ?? candidate?.pk ?? '').trim();
  if (!candidateId || candidateId === String(candidate?.username || '').trim()) {
    await appendDebugLog('warn', 'Canlı takip kontrolü için güvenilir hesap kimliği yok; beğeni atlandı', {
      username: candidate?.username || '',
      contentType,
      action: 'beğeni gönderilmedi',
    });
    return false;
  }

  const relationship = await getLiveDiscoveryRelationship(candidateId);
  if (relationship.ok && relationship.following === true) {
    await appendDebugLog('info', 'Beğeni öncesi canlı takip kontrolü geçti', {
      username: candidate?.username || '',
      candidateId,
      contentType,
      action: 'takip edildiği doğrulandı',
    });
    return true;
  }

  await appendDebugLog('warn', 'Beğeni öncesi canlı takip kontrolü geçmedi; beğeni atlandı', {
    username: candidate?.username || '',
    candidateId,
    contentType,
    relationshipVerified: relationship.ok === true,
    currentlyFollowing: relationship.following === true,
    error: relationship.error || '',
    action: 'güvenlik için beğeni gönderilmedi',
  });
  return false;
}

function isRetryableDiscoveryFollowError(error) {
  if (isAutomationStopError(error)) return false;
  const message = String(error?.message || error || '');
  if (/(?:instagram.*(?:isteği|request).*(?:reddetti|reject)|action[_\s-]*blocked|feedback_required|checkpoint|challenge|login_required|please wait|try again later|kısa süre bekle|lütfen bekle|temporarily restricted|(?:\b|http(?:\s|_)?)(?:400|401|403|429)\b)/i.test(message)) {
    return false;
  }
  const messageStatus = message.match(/(?:\bHTTP\s*|status(?:\s*[:=]\s*|\s+))(\d{3})\b/i)?.[1];
  const status = Number(error?.status ?? messageStatus);
  if (status >= 400 && status < 500) return false;
  if (status >= 500 && status < 600) return true;
  return error?.retryable === true ||
    /(?:failed to fetch|fetch failed|network(?: request)? error|networkerror|load failed|connection reset|socket hang up|timed? out|timeout)/i.test(message);
}

function makeVerifiedFollowResponse(relationship) {
  return {
    status: 'ok',
    friendship_status: {
      following: relationship.following === true,
      outgoing_request: relationship.outgoingRequest === true,
    },
  };
}

async function sendDiscoveryFollowPostWithVerifiedRetry(id, username, body, phase) {
  await requireActiveLicense();
  const endpoint = `/api/v1/friendships/create/${encodeURIComponent(id)}/`;
  const sendAndValidate = async () => {
    const response = await apiCall(endpoint, undefined, 'POST', body);
    const friendshipStatus = response?.friendship_status;
    if (
      response?.status === 'ok' &&
      friendshipStatus &&
      (friendshipStatus.outgoing_request === true || friendshipStatus.following === true)
    ) {
      return response;
    }
    const error = new Error(
      `Instagram takip isteğini yanıtla doğrulamadı: ${JSON.stringify(response).slice(0, 500)}`,
    );
    error.retryable = true;
    error.status = Number(response?.http_status ?? response?.status_code) || undefined;
    throw error;
  };

  try {
    return await sendAndValidate();
  } catch (firstError) {
    if (!isRetryableDiscoveryFollowError(firstError)) throw firstError;

    await appendDiscoveryLog('warn', 'Takip isteği yanıtı belirsiz; yeniden deneme öncesi durum doğrulanıyor', {
      phase,
      candidate: username ? `@${username}` : id,
      candidateId: id,
      error: String(firstError?.message || firstError).slice(0, 300),
      action: 'önce canlı takip durumu okunacak; istek uygulanmışsa tekrar gönderilmeyecek',
    });
    const relationship = await getLiveDiscoveryRelationship(id);
    if (!relationship.ok) {
      await appendDiscoveryLog('warn', 'Takip isteği güvenle yeniden denenemedi', {
        phase,
        candidate: username ? `@${username}` : id,
        candidateId: id,
        reason: 'canlı takip durumu doğrulanamadı',
        action: 'ikinci POST gönderilmedi',
      });
      throw firstError;
    }
    if (relationship.following || relationship.outgoingRequest) {
      await appendDiscoveryLog('info', 'Takip isteği canlı kontrolde zaten uygulanmış', {
        phase,
        candidate: username ? `@${username}` : id,
        candidateId: id,
        following: relationship.following,
        outgoingRequest: relationship.outgoingRequest,
        action: 'yinelenen POST gönderilmedi; doğrulanmış başarı olarak kaydedilecek',
      });
      return makeVerifiedFollowResponse(relationship);
    }

    await appendDiscoveryLog('warn', 'Takip isteği uygulanmamış; bir kez yeniden deneniyor', {
      phase,
      candidate: username ? `@${username}` : id,
      candidateId: id,
      action: 'Instagram 429 veya doğrulama engeli değil; tek ek deneme yapılacak',
    });
    await sleep(1500);
    try {
      return await sendAndValidate();
    } catch (retryError) {
      if (!isRetryableDiscoveryFollowError(retryError)) throw retryError;
      const finalRelationship = await getLiveDiscoveryRelationship(id);
      if (
        finalRelationship.ok &&
        (finalRelationship.following || finalRelationship.outgoingRequest)
      ) {
        await appendDiscoveryLog('info', 'Yeniden deneme sonrası takip durumu doğrulandı', {
          phase,
          candidate: username ? `@${username}` : id,
          candidateId: id,
          following: finalRelationship.following,
          outgoingRequest: finalRelationship.outgoingRequest,
          action: 'başarılı durum kaydedilecek; başka POST gönderilmeyecek',
        });
        return makeVerifiedFollowResponse(finalRelationship);
      }
      await appendDiscoveryLog('error', 'Takip isteği tek yeniden denemede de doğrulanamadı', {
        phase,
        candidate: username ? `@${username}` : id,
        candidateId: id,
        error: String(retryError?.message || retryError).slice(0, 300),
        liveStatusVerified: finalRelationship.ok,
        action: 'başka deneme yapılmayacak',
      });
      throw retryError;
    }
  }
}

async function openRandomFollowerProfileAndInspect(candidate) {
  const username = String(candidate?.username || '').replace(/^@/, '').trim();
  const expectedId = discoveryUserId(candidate);
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(username) || !expectedId) {
    throw new Error('Rastgele profil için geçerli kullanıcı adı veya hesap kimliği yok');
  }

  const profileTab = await new Promise((resolve, reject) => {
    chrome.tabs.create({
      url: `https://www.instagram.com/${encodeURIComponent(username)}/`,
      active: true,
    }, tab => {
      if (chrome.runtime.lastError || !tab?.id) {
        reject(new Error(chrome.runtime.lastError?.message || 'Instagram profil sekmesi açılamadı'));
        return;
      }
      resolve(tab);
    });
  });

  let profile = null;
  let inspectionError = '';
  try {
    const loaded = await waitForInstagramTabComplete(profileTab.id, 35000);
    if (!loaded) throw new Error('Instagram profil sayfası zamanında yüklenmedi');
    await waitForInstagramContentScript(profileTab.id, 12000);

    // Read only the exact profile that was selected. The page remains open
    // for the user; no follow, like, or additional-list request is sent here.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await sendInstagramMessage(
        profileTab.id,
        { type: 'IG_PROFILE_LOOKUP', username },
        3000,
      ).catch(() => null);
      const foundUser = response?.ok ? response.user : null;
      const foundId = discoveryUserId(foundUser);
      const foundUsername = String(foundUser?.username || '').replace(/^@/, '').toLowerCase();
      if (
        foundUser &&
        foundId === expectedId &&
        foundUsername === username.toLowerCase()
      ) {
        profile = foundUser;
        break;
      }
      if (attempt < 9) await sleep(1500);
    }
    if (!profile) {
      inspectionError = 'Profil açıldı; sayfadan kimliği doğrulanmış temel bilgiler alınamadı';
    }
  } catch (error) {
    inspectionError = String(error?.message || error);
  }

  return {
    tabId: profileTab.id,
    username,
    expectedId,
    profile,
    error: inspectionError,
  };
}

async function inspectRandomFollowedFollowerAfterComplete(queue, sourceId, sourceUsername) {
  if (queue.randomProfileInspectionStatus) {
    return {
      status: queue.randomProfileInspectionStatus,
      candidate: queue.randomFollowedCandidate || null,
    };
  }

  const candidate = queue.randomFollowedCandidate || null;
  const candidateId = discoveryUserId(candidate);
  queue.randomProfileInspectionStatus = 'attempting';
  queue.randomProfileInspectionStartedAt = Date.now();
  queue.randomProfileCandidateId = candidateId;
  const saveQueue = () => new Promise(resolve =>
    chrome.storage.local.set({ [DISCOVERY_QUEUE_KEY]: queue }, resolve)
  );
  await saveQueue();

  let status = '';
  let reason = '';
  let inspection = null;
  const ownUserId = await getInstagramSessionUserId();

  if (!ownUserId) {
    status = 'skipped-session-identity-unavailable';
    reason = 'Giriş hesabı kimliği doğrulanamadı; profil açılmadı';
  } else if (!candidate || !candidateId) {
    status = 'skipped-no-followed-follower';
    reason = 'Tüm takipçi sayfalarında giriş hesabının takip ettiği uygun bir aday bulunamadı';
  } else if (candidateId === ownUserId || candidateId === String(sourceId)) {
    status = 'skipped-self-or-source';
    reason = 'Aday giriş hesabı veya kontrol edilen kaynak hesap olduğu için profil açılmadı';
  } else if (
    candidate.alreadyFollowing !== true ||
    candidate.followRequestSent === true
  ) {
    status = 'skipped-follow-status-unverified';
    reason = 'Adayın giriş hesabı tarafından takip edildiği doğrulanamadı';
  } else {
    await appendDiscoveryLog('info', 'Tamamlanan takipçi taramasından rastgele aday seçildi', {
      sourceId,
      sourceUsername: `@${sourceUsername}`,
      candidate: `@${candidate.username}`,
      candidateId,
      eligibleCandidateCount: Number(queue.randomFollowedCandidateCount) || 0,
      relationshipSource: 'takipçi listesindeki friendship_status.following=true',
      action: 'profil açılmadan önce canlı takip durumu doğrulanacak',
    });

    const relationship = await getLiveDiscoveryRelationship(candidateId);
    if (!relationship.ok) {
      status = 'skipped-live-follow-status-unverified';
      reason = 'Canlı takip durumu doğrulanamadı; profil açılmadı';
    } else if (!relationship.following || relationship.outgoingRequest) {
      status = 'skipped-no-longer-followed';
      reason = 'Canlı kontrolde giriş hesabının aktif takibi bulunmadı; profil açılmadı';
    } else {
      try {
        inspection = await openRandomFollowerProfileAndInspect(candidate);
        status = inspection.profile
          ? 'opened-and-inspected'
          : 'opened-profile-data-unavailable';
        reason = inspection.error || '';
      } catch (error) {
        status = 'profile-open-failed';
        reason = String(error?.message || error);
      }
    }
  }

  queue.randomProfileInspectionStatus = status;
  queue.randomProfileInspectionCompletedAt = Date.now();
  queue.randomProfileInspectionError = reason;
  delete queue.randomFollowedSeenIds;
  await saveQueue();

  const profile = inspection?.profile;
  await appendDiscoveryLog(
    status === 'opened-and-inspected' ? 'info' : 'warn',
    status === 'opened-and-inspected'
      ? 'Rastgele takip edilen takipçi profili açıldı ve temel bilgiler doğrulandı'
      : status.startsWith('opened-')
        ? 'Rastgele takip edilen takipçi profili açıldı; temel bilgiler doğrulanamadı'
        : 'Rastgele takip edilen takipçi profili güvenlik kontrolünde atlandı',
    {
      sourceId,
      sourceUsername: `@${sourceUsername}`,
      candidate: candidate?.username ? `@${candidate.username}` : '',
      candidateId,
      status,
      reason,
      eligibleCandidateCount: Number(queue.randomFollowedCandidateCount) || 0,
      tabId: inspection?.tabId ?? null,
      followerCount: profile?.follower_count ?? null,
      followingCount: profile?.following_count ?? null,
      mediaCount: profile?.media_count ?? null,
      isPrivate: profile?.is_private ?? null,
      isVerified: profile?.is_verified ?? null,
      action: status.startsWith('opened-')
        ? 'profil yeni görünür Instagram sekmesinde açık bırakıldı; takip veya beğeni gönderilmedi'
        : 'hesap takip durumu doğrulanmadığı için açılmadı',
    },
  );

  return {
    status,
    candidate,
    profile,
    reason,
    tabId: inspection?.tabId ?? null,
  };
}

async function recordDiscoveryHistory(candidate, details = {}) {
  const id = discoveryUserId(candidate);
  if (!id) return;
  const stored = await new Promise(resolve =>
    chrome.storage.local.get([DISCOVERY_HISTORY_KEY, 'igUser'], x =>
      resolve({
        history: x[DISCOVERY_HISTORY_KEY] || {},
        accountId: discoveryUserId(x.igUser),
      })
    )
  );
  const previous = stored.history[id] || {};
  const next = {
    ...previous,
    id,
    username: String(candidate?.username || previous.username || ''),
    accountId: stored.accountId || previous.accountId || '',
    ts: Date.now(),
    ...details,
  };
  const entries = Object.entries({ ...stored.history, [id]: next });
  const trimmed = Object.fromEntries(entries.slice(-5000));
  await new Promise(resolve =>
    chrome.storage.local.set({ [DISCOVERY_HISTORY_KEY]: trimmed }, resolve)
  );
}

async function upsertDiscoveryAutoResult(result) {
  const id = discoveryUserId(result);
  if (!id) return;
  const existing = await new Promise(resolve =>
    chrome.storage.local.get(['__discovery_auto_results'], stored =>
      resolve(Array.isArray(stored.__discovery_auto_results)
        ? stored.__discovery_auto_results
        : [])
    )
  );
  const next = [
    result,
    ...existing.filter(user => discoveryUserId(user) !== id),
  ].slice(0, 500);
  await new Promise(resolve =>
    chrome.storage.local.set({ __discovery_auto_results: next }, () => {
      void chrome.runtime.lastError;
      resolve();
    })
  );
}

async function sendAutomaticDiscoveryFollow(candidate, sourceId, relation, gender = 'female') {
  const id = String(candidate?.id ?? candidate?.pk ?? '').trim();
  const username = String(candidate?.username || '').replace(/^@/, '').trim();
  if (!id) throw new Error('Cinsiyet filtresinden geçen hesabın kimliği bulunamadı');
  const genderLabel = gender === 'male' ? 'Erkek' : 'Kadın';
  const normalizedGender = gender === 'male' ? 'male' : 'female';

  if (hasExistingDiscoveryRelationship(candidate)) {
    await appendDiscoveryLog('info', `${genderLabel} aday zaten takip ediliyor veya istek gönderilmiş`, {
      phase: 'discovery-follow-guard',
      candidate: username ? `@${username}` : id,
      candidateId: id,
      action: 'Instagram takip isteği gönderilmedi',
    });
    return { ok: true, skipped: true, reason: 'already-following-or-requested' };
  }

  const statusKey = '__discovery_follow_status_v1';
  const stored = await new Promise(resolve =>
    chrome.storage.local.get([statusKey], x => resolve(x[statusKey] || {})));
  if (stored[id]?.status === 'sent') {
    await recordDiscoveryHistory(candidate, {
      status: 'follow-sent',
      sourceId: String(sourceId),
      relation: relation === 'following' ? 'following' : 'followers',
      gender: normalizedGender,
    });
    return { ok: true, alreadySent: true, status: stored[id] };
  }

  const queueState = await new Promise(resolve =>
    chrome.storage.local.get([DISCOVERY_QUEUE_KEY], x => resolve(x[DISCOVERY_QUEUE_KEY] || null)));
  if (queueState?.sourceId === String(sourceId)) {
    const excludedIds = await getDiscoveryExcludedIds(sourceId, queueState.seedUsers);
    if (excludedIds.has(id)) {
      await appendDiscoveryLog('info', `${genderLabel} aday güvenlik kontrolünde elendi`, {
        phase: 'discovery-follow',
        candidate: username ? `@${username}` : id,
        candidateId: id,
        reason: 'hesap kaynak hesabın doğrudan listesinde veya mevcut bağlantılar arasında',
        action: 'Instagram takip isteği gönderilmedi',
      });
      return { ok: true, skipped: true, reason: 'excluded' };
    }
  }

  const liveRelationship = await getLiveDiscoveryRelationship(id);
  if (!liveRelationship.ok) {
    return {
      ok: false,
      skipped: true,
      reason: 'relationship-check-failed',
      error: 'Adayın mevcut takip durumu doğrulanamadı; takip isteği gönderilmedi',
    };
  }
  if (liveRelationship.following || liveRelationship.outgoingRequest) {
    await appendDiscoveryLog('info', `${genderLabel} aday canlı kontrolde zaten bağlı`, {
      phase: 'discovery-follow-guard',
      candidate: username ? `@${username}` : id,
      candidateId: id,
      following: liveRelationship.following,
      outgoingRequest: liveRelationship.outgoingRequest,
      action: 'Instagram takip isteği gönderilmedi',
    });
    return { ok: true, skipped: true, reason: 'already-following-or-requested' };
  }

  const quota = await consumeDiscoveryQuota();
  if (!quota.allowed) {
    await appendDiscoveryLog('warn', `${genderLabel} aday için takip isteği kotası dolu`, {
      phase: 'discovery-follow',
      candidate: username ? `@${username}` : id,
      candidateId: id,
      gender: normalizedGender,
      reason: quota.reason,
      dailyUsed: quota.count,
      dailyLimit: quota.dailyLimit,
      action: 'Instagram takip isteği gönderilmedi',
    });
    return {
      ok: false,
      skipped: true,
      reason: quota.reason,
      dailyLimit: quota.dailyLimit,
      dailyUsed: quota.count,
    };
  }

  await appendDiscoveryLog('info', `${genderLabel} aday için takip isteği gönderiliyor`, {
    phase: 'discovery-follow',
    gender: normalizedGender,
    candidate: username ? `@${username}` : id,
    candidateId: id,
    relation: relation === 'following' ? 'following' : 'followers',
    method: 'POST',
    endpoint: `/api/v1/friendships/create/${id}/`,
    quotaBeforeSend: quota.count - 1,
  });
  let response;
  try {
    response = await sendDiscoveryFollowPostWithVerifiedRetry(
      id,
      username,
      {
        container_module: 'profile',
        include_follow_friction_check: 'true',
        nav_chain: 'PolarisFeedRoot:feedPage:1:via_cold_start,PolarisStoriesV3Root:StoriesPage:2:reel_feed_timeline,PolarisProfilePostsTabRoot:profilePage:3:unexpected',
        user_id: id,
      },
      'automatic-discovery-follow',
    );
  } catch (error) {
    const details = String(error?.message || error);
    await appendDiscoveryLog('error', `Takip isteği sırasında hata oluştu: ${details}`, {
      phase: 'discovery-follow',
      candidate: username ? `@${username}` : id,
      candidateId: id,
      errorDetails: details,
      action: 'Instagram takip isteği başarısız oldu',
    });
    throw error;
  }
  const friendshipStatus = response?.friendship_status;
  if (
    response?.status !== 'ok' ||
    !friendshipStatus ||
    (friendshipStatus.outgoing_request !== true && friendshipStatus.following !== true)
  ) {
    const details = `Instagram yanıtı takip isteğini onaylamadı: ${JSON.stringify(response).slice(0, 500)}`;
    await appendDiscoveryLog('error', `Takip isteği sırasında hata oluştu: ${details}`, {
      phase: 'discovery-follow',
      candidate: username ? `@${username}` : id,
      candidateId: id,
      errorDetails: details,
      action: 'Instagram takip isteği onaylanmadı',
    });
    throw new Error(details);
  }

  const nextStatus = {
    status: 'sent',
    ts: Date.now(),
    username,
    gender: normalizedGender,
    automatic: true,
    following: friendshipStatus.following === true,
    outgoingRequest: friendshipStatus.outgoing_request === true,
  };
  await new Promise(resolve => chrome.storage.local.set({
    [statusKey]: { ...stored, [id]: nextStatus },
  }, resolve));
  await recordDiscoveryHistory(candidate, {
    status: 'follow-sent',
    sourceId: String(sourceId),
    relation: relation === 'following' ? 'following' : 'followers',
    gender: normalizedGender,
  });
  await patchState({
    discoveryTodayCount: quota.count,
    discoveryLastActionLabel: nextStatus.outgoingRequest
      ? `${genderLabel} aday için takip isteği gönderildi: @${username || id}`
      : `${genderLabel} aday takip ediliyor: @${username || id}`,
  });
  await appendDiscoveryLog(
    'info',
    nextStatus.outgoingRequest
      ? `${genderLabel} aday için takip isteği gönderildi: @${username || id}`
      : `${genderLabel} aday takip ediliyor: @${username || id}`,
    {
    phase: 'discovery-follow',
    gender: normalizedGender,
    candidateId: id,
    following: nextStatus.following,
    outgoingRequest: nextStatus.outgoingRequest,
    dailyUsed: quota.count,
    dailyRemaining: quota.dailyRemaining,
    action: nextStatus.outgoingRequest
      ? 'Instagram giden takip isteğini doğruladı; durum kaydedildi'
      : 'Instagram takip ilişkisini doğruladı; durum kaydedildi',
    },
  );
  return {
    ok: true,
    status: nextStatus,
    dailyLimit: quota.dailyLimit,
    dailyUsed: quota.count,
    dailyRemaining: quota.dailyRemaining,
  };
}

// ── Ana otomasyon tiki ────────────────────────────────────────────────
// Keşif otomasyonu: her turda en fazla bir liste isteği ve bir aday teslimi
// yapar. Böylece keşif, like bekleme süresini doldurur ama like akışını
// paralel isteklerle hızlandırmaz.
async function runDiscoveryTickImpl() {
  const state = await getState();
  if (!state.discoveryEnabled || !state.discoverySourceId) {
    const reason = !state.discoveryEnabled
        ? 'otomatik keşif kapalı'
        : 'kaynak hesap kimliği yok';
    const signature = `${reason}|${state.discoverySourceId || ''}`;
    // Her dakika aynı uyarıyı basmak yerine durum değiştiğinde bir kez yaz.
    if (signature !== _lastDiscoverySkipSignature) {
      _lastDiscoverySkipSignature = signature;
      await appendDiscoveryLog('warn', 'Tarama atlandı', {
        reason,
        discoveryEnabled: state.discoveryEnabled === true,
        sourceId: state.discoverySourceId || '',
        action: 'Keşif panelinde otomatik keşfi aç ve kaynak hesabı seç',
      });
    }
    return;
  }
  _lastDiscoverySkipSignature = '';

  const now = Date.now();
  if (state.discoveryNextRunAt > now) return;
  const key = DISCOVERY_QUEUE_KEY;
  const stored = await new Promise(resolve => chrome.storage.local.get([key], resolve));
  let queue = stored[key];
  const sourceId = String(state.discoverySourceId);
  const accountStorage = await new Promise(resolve => chrome.storage.local.get(['igUser'], resolve));
  const ownUserId = discoveryUserId(accountStorage.igUser);
  const isOwnNetwork = !!ownUserId && ownUserId === sourceId;
  const mode = isOwnNetwork ? 'network' : 'direct';
  const sourceRelation = isOwnNetwork ? 'following_and_followers' : 'direct';
  const configuredRelation = state.discoveryRelation === 'following' ? 'following' : 'followers';
  const targetRelation = isOwnNetwork ? 'following_and_followers' : configuredRelation;
  const sourceUsername = state.discoverySourceUsername ||
    (ownUserId === sourceId ? String(accountStorage.igUser?.username || '') : '');
  await appendDiscoveryLog('info', 'Tarama başladı', {
    sourceId,
    sourceUsername: sourceUsername || '(kullanıcı adı bilinmiyor)',
    sourceType: isOwnNetwork ? 'kendi ağım' : 'seçilen kaynak hesap',
    mode,
    sourceRelation,
    sourceRelationLabel: isOwnNetwork ? 'takip ettiklerin ve takipçilerin' : 'doğrudan takipçileri',
    targetRelation,
    targetRelationLabel: isOwnNetwork ? 'takip ve takipçileri' : 'takipçileri',
    flow: isOwnNetwork
      ? 'rastgele kendi takip ettiklerin/takipçilerin → onların takip ve takipçileri'
      : 'kullanıcı adı → doğrudan takipçileri',
    queueSeedCount: Array.isArray(queue?.seedUsers) ? queue.seedUsers.length : 0,
    queueCandidateCount: Array.isArray(queue?.candidates) ? queue.candidates.length : 0,
    queueDeliveryIndex: Number(queue?.deliveryIndex) || 0,
  });
  if (!queue || queue.sourceId !== sourceId || queue.mode !== mode ||
      queue.targetRelation !== targetRelation ||
      queue.sourceRelation !== sourceRelation) {
    queue = {
      sourceId, mode, sourceRelation, targetRelation,
      seedUsers: [], seedIndex: 0, plans: [], planIndex: 0,
      scannedRelations: {}, candidates: [], deliveryIndex: 0,
      directLoaded: false, createdAt: now,
    };
    await appendDiscoveryLog('info', 'Yeni keşif kuyruğu oluşturuldu', {
      sourceId, mode, sourceRelation, targetRelation,
      reason: 'kaynak hesap veya keşif akışı değişti',
    });
  }

  let excludedIds = new Set();
  // Önceden çekilmiş adayları önce ve sırayla teslim et.
  const nextCandidate = () => {
    const start = Math.max(0, Number(queue.deliveryIndex) || 0);
    for (let index = start; index < queue.candidates.length; index++) {
      const candidate = queue.candidates[index];
      if (
        candidate &&
        !excludedIds.has(discoveryUserId(candidate)) &&
        !hasExistingDiscoveryRelationship(candidate)
      ) {
        return { candidate, index };
      }
      // Do not leave stale/already-connected candidates at the head of the
      // queue after a following list has been refreshed.
      if (candidate) queue.deliveryIndex = index + 1;
    }
    return null;
  };
  let selected = null;
  let candidate = null;
  let candidateRelation = 'followers';
  if (mode === 'direct') {
    excludedIds = await getDiscoveryExcludedIds(sourceId, []);
    if (!queue.directLoaded) {
      const result = await fetchDiscoveryRelationList(sourceId, targetRelation);
      queue.candidates = result.users.filter(user =>
        !excludedIds.has(discoveryUserId(user)) &&
        !hasExistingDiscoveryRelationship(user)
      );
      queue.directLoaded = true;
      await appendDiscoveryLog('info', 'Kullanıcı adının takipçileri alındı', {
        endpoint: result.endpoint, rawCount: result.rawCount,
        uniqueCount: result.users.length, candidateCount: queue.candidates.length,
      });
    }
    selected = nextCandidate();
    candidate = selected?.candidate || null;
  } else {
    if (!queue.seedUsers.length) {
      const sourceLists = [];
      for (const relation of ['following', 'followers']) {
        const result = await fetchDiscoveryRelationList(sourceId, relation);
        sourceLists.push(...result.users);
        await appendDiscoveryLog('info', 'Kendi kaynak listesi alındı', {
          endpoint: result.endpoint, relation, rawCount: result.rawCount,
          uniqueCount: result.users.length,
        });
      }
      queue.seedUsers = shuffleDiscoveryUsers(uniqueDiscoveryUsers(sourceLists));
      queue.seedIndex = 0;
      queue.plans = shuffleDiscoveryUsers(queue.seedUsers.flatMap(seed => [
        { seed, relation: 'following' },
        { seed, relation: 'followers' },
      ]));
      queue.planIndex = 0;
      excludedIds = await getDiscoveryExcludedIds(sourceId, queue.seedUsers);
      await appendDiscoveryLog('info', 'Rastgele kaynak hesaplar hazırlandı', {
        sourceCount: queue.seedUsers.length, planCount: queue.plans.length,
        excludedCount: excludedIds.size,
      });
    } else {
      excludedIds = await getDiscoveryExcludedIds(sourceId, queue.seedUsers);
      // A queue created by the manual flow may not have automatic plans yet.
      if (!Array.isArray(queue.plans) || !queue.plans.length) {
        queue.plans = shuffleDiscoveryUsers(queue.seedUsers.flatMap(seed => [
          { seed, relation: 'following' },
          { seed, relation: 'followers' },
        ]));
      }
    }
    queue.planIndex = Math.max(0, Number(queue.planIndex) || 0);
    if (!queue.scannedRelations) queue.scannedRelations = {};
    selected = nextCandidate();
    if (!selected) {
      const plan = queue.plans[queue.planIndex++];
      if (plan?.seed) {
        const relationKey = `${plan.seed.id}:${plan.relation}`;
        if (!queue.scannedRelations[relationKey]) {
          queue.scannedRelations[relationKey] = true;
          const result = await fetchDiscoveryRelationList(plan.seed.id, plan.relation);
          const beforeCandidateCount = queue.candidates.length;
          const taggedUsers = result.users.map(user => ({
            ...user,
            discoveryRelation: plan.relation,
            discoverySeedId: plan.seed.id,
            discoverySeedUsername: plan.seed.username,
          }));
          queue.candidates = uniqueDiscoveryUsers([...queue.candidates, ...taggedUsers])
            .filter(user =>
              !excludedIds.has(discoveryUserId(user)) &&
              !hasExistingDiscoveryRelationship(user)
            );
          await appendDiscoveryLog('info', 'Rastgele kaynak hesabın listesi alındı', {
            endpoint: result.endpoint, sourceAccount: `@${plan.seed.username}`,
            sourceAccountId: plan.seed.id, relation: plan.relation,
            rawCount: result.rawCount, uniqueCount: result.users.length,
            newCandidateCount: Math.max(0, queue.candidates.length - beforeCandidateCount),
            totalCandidateCount: queue.candidates.length,
          });
        }
      }
      selected = nextCandidate();
    }
    queue.seedIndex = Math.min(queue.seedUsers.length, Math.ceil(queue.planIndex / 2));
    selected = nextCandidate();
    candidate = selected?.candidate || null;
  }

  if (candidate) {
    queue.deliveryIndex = (selected?.index ?? queue.deliveryIndex) + 1;
    candidateRelation = candidate.discoveryRelation === 'following' ? 'following' : 'followers';
    // A stale queue entry may not carry friendship_status anymore. Check the
    // live relationship before spending AI work on it, so an already-followed
    // account is reported as skipped instead of becoming an "unknown" target.
    const liveCandidateRelationship = await getLiveDiscoveryRelationship(
      discoveryUserId(candidate),
    );
    let relationshipSkip = null;
    if (!liveCandidateRelationship.ok) {
      relationshipSkip = {
        ok: false,
        skipped: true,
        reason: 'relationship-check-failed',
        error: 'Adayın mevcut takip durumu doğrulanamadı; takip isteği gönderilmedi',
      };
    } else if (
      liveCandidateRelationship.following ||
      liveCandidateRelationship.outgoingRequest
    ) {
      relationshipSkip = {
        ok: true,
        skipped: true,
        reason: 'already-following-or-requested',
      };
      candidate.alreadyFollowing = liveCandidateRelationship.following;
      candidate.followRequestSent = liveCandidateRelationship.outgoingRequest;
    }
    await setGenderState({
      enabled: true,
      running: true,
      error: false,
      message: `@${candidate.username} için AI cinsiyet analizi yapılıyor`,
    });
    const classified = (await classifyGenderInBackground([candidate]))[0] || candidate;
    const gender = ['male', 'female', 'unknown'].includes(classified.gender)
      ? classified.gender
      : 'unknown';
  const classificationUnavailable = classified.source === 'ai-unavailable' ||
    classified.source === 'no-provider';
    const genderConfidence = Number(classified.gender_confidence) || 0;
    const targetGender = ['female', 'male', 'both'].includes(state.discoveryTargetGender)
      ? state.discoveryTargetGender
      : 'female';
    const isTargetGender = gender === 'female'
      ? targetGender === 'female' || targetGender === 'both'
      : gender === 'male'
        ? targetGender === 'male' || targetGender === 'both'
        : false;
    await updateDiscoveryGenderState({ gender }, targetGender);

    let followResult = relationshipSkip;
    if (isTargetGender && !relationshipSkip) {
      try {
        followResult = await sendAutomaticDiscoveryFollow(classified, sourceId, candidateRelation, gender);
      } catch (error) {
        followResult = { ok: false, error: String(error?.message || error) };
        await appendDiscoveryLog('error', `${gender === 'female' ? 'Kadın' : 'Erkek'} adayın takip isteği gönderilemedi`, {
          phase: 'discovery-follow',
          candidate: `@${classified.username}`,
          candidateId: classified.id,
          gender,
          targetGender,
          error: followResult.error,
        });
      }
    } else {
      await appendDiscoveryLog('info', 'Aday cinsiyet filtresinden geçmedi', {
        phase: 'discovery-gender-filter',
        candidate: `@${classified.username}`,
        candidateId: classified.id,
        gender,
        confidence: genderConfidence,
        targetGender,
        action: 'takip isteği gönderilmedi',
      });
    }

    const existing = await new Promise(resolve =>
      chrome.storage.local.get(['__discovery_auto_results'], x => resolve(x.__discovery_auto_results || [])));
    const result = {
      ts: now,
      ...classified,
      sourceId,
      relation: candidateRelation,
      sourceRelation,
      targetRelation,
      gender,
      gender_confidence: genderConfidence,
      targetGender,
      followStatus: followResult?.status?.status ||
        (followResult?.skipped
          ? 'skipped'
          : (isTargetGender ? (followResult?.ok ? 'sent' : 'not-sent') : 'not-sent')),
       followReason: classificationUnavailable
         ? `AI analizi yapılamadı — takip isteği gönderilmedi${classified.classification_error ? ` (${classified.classification_error})` : ''}`
         : followResult?.skipped
        ? (followResult?.reason === 'already-following-or-requested'
          ? 'Hesap zaten takip ediliyor veya bekleyen takip isteği var — yeni istek gönderilmedi'
          : followResult?.error || 'Aday ilişki kontrolü yapılamadı — takip isteği gönderilmedi')
        : gender === 'unknown'
          ? 'Cinsiyet belirsiz — takip isteği gönderilmedi'
          : !isTargetGender
            ? `${gender === 'female' ? 'Kadın' : 'Erkek'} aday seçili hedef değil — takip isteği gönderilmedi`
            : followResult?.error || (followResult?.reason === 'daily' || followResult?.reason === 'hourly'
              ? 'Takip isteği kotası dolu'
              : ''),
      discoveryVersion: 4,
    };
    await new Promise(resolve => chrome.storage.local.set({
      __discovery_auto_results: [result, ...existing].slice(0, 500),
    }, resolve));
    await appendDebugLog('info', `Otomatik keşif adayı alındı: @${classified.username}`, {
      phase: 'discovery', sourceId, mode, sourceRelation, targetRelation, candidateId: classified.id,
      sourceUsername: sourceUsername || '',
      gender,
      confidence: genderConfidence,
      targetGender,
      followStatus: result.followStatus,
      action: isTargetGender
        ? (result.followStatus === 'skipped'
          ? `${gender === 'female' ? 'kadın' : 'erkek'} aday zaten bağlı; yeni takip isteği gönderilmedi`
          : `${gender === 'female' ? 'kadın' : 'erkek'} aday; takip isteği otomatik olarak işlendi`)
        : `${gender === 'unknown' ? 'belirsiz' : gender === 'female' ? 'kadın' : 'erkek'} aday seçili hedef değil; takip isteği gönderilmedi`,
    });
    await patchState({
      discoveryLastActionLabel: isTargetGender
        ? `${gender === 'female' ? 'Kadın' : 'Erkek'} aday işlendi: @${classified.username}`
        : `Aday elendi (${gender}): @${classified.username}`,
      discoveryNextRunAt: now + randInt(state.minDelaySec, state.maxDelaySec) * 1000,
    });
  } else {
    await appendDiscoveryLog('info', 'Uygun aday bulunamadı', {
      sourceId,
      mode,
      sourceRelation,
      targetRelation,
      scannedSourceCount: mode === 'direct' ? (queue.directLoaded ? 1 : 0) : queue.seedIndex,
      totalSourceCount: queue.seedUsers.length,
      planIndex: Number(queue.planIndex) || 0,
      planCount: Array.isArray(queue.plans) ? queue.plans.length : 0,
      queuedCandidateCount: queue.candidates.length,
      deliveryIndex: Number(queue.deliveryIndex) || 0,
      action: 'takip isteği gönderilmedi',
    });
    await patchState({
      discoveryLastActionLabel: 'Keşif kuyruğunda yeni kullanıcı bulunamadı',
      discoveryNextRunAt: now + randInt(state.minDelaySec, state.maxDelaySec) * 1000,
    });
  }
  await new Promise(resolve => chrome.storage.local.set({ [key]: queue }, resolve));
}

async function runDiscoveryTick() {
  if (!(await validateExtensionLicense()).active) return;
  try {
    const state = await getState();
    if (Number(state.discoveryFlowVersion) === 5) {
      return await runMutualDiscoveryTickImpl();
    }
    return await runDiscoveryTickImpl();
  } catch (error) {
    if (isMutualFollowersCooldownError(error)) {
      const blockedUntil = Math.max(Date.now(), _igMutualFollowersBlockedUntil);
      const remainingMinutes = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60000));
      await patchState({
        discoveryNextRunAt: blockedUntil,
        discoveryLastActionLabel: `Ortak hesap keşfi uç noktası beklemede — ${remainingMinutes} dk sonra devam edecek`,
      });
      await appendDiscoveryLog('warn', 'Ortak hesap keşfi uç noktası beklemede', {
        error: String(error?.message || error),
        cooldownMinutes: remainingMinutes,
        scope: 'mutual_followers',
        action: 'keşif bekleyecek; beğeni ve diğer istekler devam edebilir',
      });
      broadcastStatus();
      return;
    }
    if (isRateLimitMessage(error) || isRateLimitCooldownError(error)) {
      const blockedUntil = Math.max(
        Date.now(),
        _igRequestBlockedUntil || Date.now() + IG_RATE_LIMIT_COOLDOWN_MS,
      );
      const remainingMinutes = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60000));
      await patchState({
        discoveryNextRunAt: blockedUntil,
        discoveryLastActionLabel: `Instagram ortak beklemesi — keşif ${remainingMinutes} dk sonra devam edecek`,
      });
      await appendDiscoveryLog('warn', 'Keşif ortak Instagram beklemesine alındı', {
        error: String(error?.message || error),
        cooldownMinutes: remainingMinutes,
        action: 'bekleme süresince yeni keşif isteği gönderilmeyecek; ardından otomatik devam edilecek',
      });
      broadcastStatus();
      return;
    }
    await appendDiscoveryLog('error', 'Tarama başarısız oldu', {
      error: String(error?.message || error),
      action: 'bu tur durduruldu; sonraki planlı turda tekrar denenecek',
    });
    throw error;
  }
}

// Yeni keşif akışı:
// 1) Panelde yazılan hesap yalnızca keşif kaynağıdır.
// 2) Açıkken mutual_followers sayısı, ayarlanan minimum eşiğe ulaşmalıdır.
// 3) Eşleşen aday (veya filtre kapalıysa her uygun aday) sınıflandırılır.
// 4) Hedef cinsiyete uyan adaya takip isteği gönderilir.
// Direct discovery flow requested by the panel:
// target username -> target followers -> one follower at a time ->
// that follower's mutual count -> that follower's gender -> follow if eligible.
// The queue persists between alarm ticks so one large follower list is never
// classified in a single burst.
async function runDirectFollowerDiscoveryTick(state) {
  if (!state.discoveryEnabled || !state.discoverySourceId) return;

  const now = Date.now();
  if (state.discoveryNextRunAt > now) return;
  if (state.discoveryTodayCount >= state.discoveryMaxPerDay) {
    await patchState({
      discoveryLastActionLabel: `Takip isteği günlük limiti dolu (${state.discoveryMaxPerDay})`,
    });
    return;
  }

  const sourceId = String(state.discoverySourceId);
  const sourceUsername = String(state.discoverySourceUsername || sourceId).replace(/^@/, '');
  const queueKey = DISCOVERY_QUEUE_KEY;
  const stored = await new Promise(resolve =>
    chrome.storage.local.get([queueKey], resolve)
  );
  let queue = stored[queueKey];
  const ownUserId = await getInstagramSessionUserId();
  if (
    !queue ||
    queue.mode !== 'direct-followers-v7' ||
    String(queue.sourceId) !== sourceId
  ) {
    queue = {
      mode: 'direct-followers-v7',
      sourceId,
      sourceUsername,
      relation: 'followers',
      candidates: [],
      candidateIndex: 0,
      nextMaxId: null,
      pageCount: 0,
      processedCount: 0,
      listComplete: false,
      randomFollowedCandidateCount: 0,
      randomFollowedCandidate: null,
      randomFollowedSeenIds: [],
      randomProfileInspectionStatus: '',
      sourceRotationPool: [],
      sourceRotationVisitedIds: [sourceId],
      sourceRotationOwnerId: ownUserId,
      sourceRotationNextMaxId: null,
      sourceRotationSeenCursors: [],
      sourceRotationPageCount: 0,
      sourceRotationComplete: false,
      createdAt: now,
    };
    await appendDiscoveryLog('info', 'Takipçi keşif kuyruğu oluşturuldu', {
      sourceId,
      sourceUsername: `@${sourceUsername}`,
      flow: 'kullanıcı adı → takipçiler → aday başına ortak hesap → aday başına AI',
      action: 'takipçi listesi alınacak',
    });
  }

  const excludedIds = await getDiscoveryExcludedIds(sourceId, []);
  if (!Array.isArray(queue.randomFollowedSeenIds)) queue.randomFollowedSeenIds = [];
  queue.randomFollowedCandidateCount = Math.max(
    0,
    Number(queue.randomFollowedCandidateCount) || 0,
  );
  const saveQueue = () => new Promise(resolve =>
    chrome.storage.local.set({ [queueKey]: queue }, resolve)
  );
  let candidate = null;
  while (!candidate) {
    if (queue.candidateIndex >= queue.candidates.length) {
      if (queue.listComplete) break;
      const page = await fetchDiscoveryRelationList(
        sourceId,
        'followers',
        queue.nextMaxId,
      );
      queue.candidates = page.users
        .filter(user => discoveryUserId(user) !== sourceId)
        .filter(user => !excludedIds.has(discoveryUserId(user)));
      queue.candidateIndex = 0;
      queue.nextMaxId = page.nextMaxId;
      queue.pageCount += 1;
      if (!queue.nextMaxId) queue.listComplete = true;
      await appendDiscoveryLog('info', 'Takipçi listesi sayfası alındı', {
        sourceId,
        sourceUsername: `@${sourceUsername}`,
        endpoint: page.endpoint,
        page: queue.pageCount,
        rawCount: page.rawCount,
        candidateCount: queue.candidates.length,
        randomFollowedCandidateCount: queue.randomFollowedCandidateCount,
        nextPage: !!queue.nextMaxId,
        action: 'adaylar sırayla kontrol edilecek',
      });
      // Save the cursor and random sample before any per-candidate API call.
      // A later 429 can then resume from this exact page after its cooldown.
      await saveQueue();
      if (!queue.candidates.length && !queue.nextMaxId) break;
      if (!queue.candidates.length) continue;
    }
    candidate = queue.candidates[queue.candidateIndex++] || null;
    if (candidate) {
      queue.processedCount += 1;
      const candidateId = discoveryUserId(candidate);
      if (
        excludedIds.has(candidateId) ||
        candidate.alreadyFollowing === true ||
        candidate.followRequestSent === true
      ) {
        if (candidate.alreadyFollowing === true) {
          await recordDiscoveryHistory(candidate, {
            status: 'already-following',
            sourceId,
            relation: 'followers',
            reason: 'friendship_status.following=true',
          });
        } else if (candidate.followRequestSent === true) {
          await recordDiscoveryHistory(candidate, {
            status: 'follow-request-sent',
            sourceId,
            relation: 'followers',
            reason: 'friendship_status.outgoing_request=true',
          });
        }
        candidate = null;
      }
    }
  }

  if (!candidate) {
    const latestState = await getState();
    if (!latestState.discoveryEnabled) {
      await saveQueue();
      return;
    }
    if (!latestState.discoveryRotateSources) {
      await saveQueue();
      await patchState({
        discoveryEnabled: false,
        discoveryNextRunAt: 0,
        discoveryLastActionLabel: `@${sourceUsername} tamamlandı; rastgele kaynak geçişi kapalı olduğu için otomatik keşif durduruldu.`,
      });
      await appendDiscoveryLog('info', 'Mevcut kaynak taraması tamamlandı; rastgele kaynak geçişi kapalı', {
        sourceId,
        sourceUsername: `@${sourceUsername}`,
        pageCount: queue.pageCount,
        processedCount: queue.processedCount,
        action: 'otomatik keşif durduruldu; yeniden başlatıldığında ayar yeniden kontrol edilecek',
      });
      return;
    }

    const nextSource = await chooseNextFollowedDiscoverySource(
      queue,
      ownUserId,
      sourceId,
    );
    if (nextSource.candidate) {
      const nextSourceId = discoveryUserId(nextSource.candidate);
      const nextSourceUsername = String(nextSource.candidate.username || '').replace(/^@/, '');
      const nextQueue = {
        mode: 'direct-followers-v7',
        sourceId: nextSourceId,
        sourceUsername: nextSourceUsername,
        relation: 'followers',
        candidates: [],
        candidateIndex: 0,
        nextMaxId: null,
        pageCount: 0,
        processedCount: 0,
        listComplete: false,
        sourceRotationPool: queue.sourceRotationPool,
        sourceRotationVisitedIds: queue.sourceRotationVisitedIds,
        sourceRotationOwnerId: queue.sourceRotationOwnerId,
        sourceRotationNextMaxId: queue.sourceRotationNextMaxId,
        sourceRotationSeenCursors: queue.sourceRotationSeenCursors,
        sourceRotationPageCount: queue.sourceRotationPageCount,
        sourceRotationComplete: queue.sourceRotationComplete,
        createdAt: now,
      };
      await new Promise(resolve =>
        chrome.storage.local.set({ [queueKey]: nextQueue }, resolve)
      );
      await patchState({
        discoverySourceId: nextSourceId,
        discoverySourceUsername: nextSourceUsername,
        discoveryLastActionLabel: `@${sourceUsername} tamamlandı; rastgele yeni kaynak @${nextSourceUsername}`,
        discoveryNextRunAt: now + randInt(state.minDelaySec, state.maxDelaySec) * 1000,
      });
      await appendDiscoveryLog('info', 'Takipçi taraması tamamlandı; yeni kaynak seçildi', {
        sourceId,
        sourceUsername: `@${sourceUsername}`,
        pageCount: queue.pageCount,
        processedCount: queue.processedCount,
        nextSourceId,
        nextSourceUsername: `@${nextSourceUsername}`,
        sourceRotationPageCount: queue.sourceRotationPageCount,
        sourceRotationPoolCount: queue.sourceRotationPool.length,
        action: 'seçilen hesabın takipçileri, mevcut gecikme ve kota ayarlarıyla taranacak',
      });
      return;
    }

    if (nextSource.reason === 'source-list-page-batch-pending') {
      await saveQueue();
      await patchState({
        discoveryLastActionLabel: 'Takip edilenler listesi sayfalanıyor; sonraki kaynak seçimi sürecek',
        discoveryNextRunAt: now + randInt(state.minDelaySec, state.maxDelaySec) * 1000,
      });
      await appendDiscoveryLog('info', 'Kaynak listesi taraması kaldığı yerden sürecek', {
        sourceId,
        sourceUsername: `@${sourceUsername}`,
        sourceRotationPageCount: queue.sourceRotationPageCount,
        sourceRotationPoolCount: queue.sourceRotationPool.length,
        action: 'sayfa güvenlik sınırı bu turda doldu; sonraki turda cursor devam edecek',
      });
      return;
    }

    await saveQueue();
    const exhaustedLabel = nextSource.reason === 'all-followed-sources-visited'
      ? 'takip ettiğin kaynakların tamamı tarandı'
      : nextSource.reason === 'source-list-pagination-stalled'
        ? 'Instagram takip listesi sayfalanamadı'
        : 'giriş hesabı doğrulanamadığı için yeni kaynak seçilemedi';
    await patchState({
      discoveryEnabled: false,
      discoveryNextRunAt: 0,
      discoveryLastActionLabel: `@${sourceUsername} tamamlandı; ${exhaustedLabel}. Otomatik keşif durduruldu.`,
    });
    await appendDiscoveryLog('info', 'Takipçi keşfi tamamlandı; yeni kaynak bulunamadı', {
      sourceId,
      sourceUsername: `@${sourceUsername}`,
      pageCount: queue.pageCount,
      processedCount: queue.processedCount,
      sourceRotationPageCount: nextSource.pageCount ?? queue.sourceRotationPageCount,
      sourceRotationPoolCount: queue.sourceRotationPool.length,
      reason: nextSource.reason,
      action: 'sonsuz tekrar oluşturmamak için otomatik keşif durduruldu',
    });
    return;
  }

  const candidateId = discoveryUserId(candidate);
  const minMutualCount = state.discoveryMinMutualCount;
  const mutualFilterEnabled = minMutualCount > 0;
  await appendDiscoveryLog('info', 'Takipçi adayı kontrol ediliyor', {
    sourceId,
    sourceUsername: `@${sourceUsername}`,
    candidate: `@${candidate.username}`,
    candidateId,
    rule: mutualFilterEnabled
      ? `adayın mutual_followers sayısı en az ${minMutualCount} olmalı`
      : 'ortak hesap eşiği 0; filtre uygulanmıyor',
    action: mutualFilterEnabled
      ? 'bu adayın ortak hesap sayısı kontrol ediliyor'
      : 'ortak hesap isteği atlanıyor; cinsiyet analizi yapılacak',
  });
  const mutual = mutualFilterEnabled ? await fetchMutualFollowers(candidateId) : null;
  const mutualCount = mutual ? Number(mutual.count) || 0 : null;
  if (
    mutualFilterEnabled &&
    !matchesDiscoveryMutualCount(mutualCount, minMutualCount)
  ) {
    await recordDiscoveryHistory(candidate, {
      status: 'scanned-mutual-rejected',
      sourceId,
      sourceUsername,
      relation: 'followers',
      mutualCount,
      mutualFilterEnabled,
      requiredMutualCount: minMutualCount,
      expectedMutualCount: minMutualCount,
      reason: 'mutual_count_below_minimum',
    });
    await saveQueue();
    await patchState({
      discoveryLastActionLabel: `@${candidate.username} elendi — ${mutualCount} ortak hesap`,
      discoveryNextRunAt: now + randInt(state.minDelaySec, state.maxDelaySec) * 1000,
    });
    await appendDiscoveryLog('info', 'Takipçi adayı ortak hesap şartını geçemedi', {
      sourceId,
      sourceUsername: `@${sourceUsername}`,
      candidate: `@${candidate.username}`,
      candidateId,
      mutualCount,
      expected: minMutualCount,
      action: 'AI cinsiyet sorgusu ve takip isteği yapılmadı',
    });
    return;
  }

  const targetGender = ['female', 'male', 'both'].includes(state.discoveryTargetGender)
    ? state.discoveryTargetGender
    : 'female';
  await setGenderState({
    enabled: true,
    running: true,
    error: false,
    message: `@${candidate.username} için AI cinsiyet analizi yapılıyor`,
  });
  const classified = (await classifyGenderInBackground([candidate]))[0] || candidate;
  const gender = ['male', 'female', 'unknown'].includes(classified.gender)
    ? classified.gender
    : 'unknown';
  const classificationUnavailable = classified.source === 'ai-unavailable' ||
    classified.source === 'no-provider';
  const genderConfidence = Number(classified.gender_confidence) || 0;
  await updateDiscoveryGenderState({ gender }, targetGender);

  const matchesTargetGender =
    (gender === 'female' && (targetGender === 'female' || targetGender === 'both')) ||
    (gender === 'male' && (targetGender === 'male' || targetGender === 'both'));
  let followResult = null;
  if (matchesTargetGender) {
    try {
      followResult = await sendAutomaticDiscoveryFollow(
        classified,
        sourceId,
        'followers',
        gender,
      );
    } catch (error) {
      followResult = { ok: false, error: String(error?.message || error) };
    }
  }
  const wasSent = followResult?.ok === true &&
    !followResult?.alreadySent &&
    !followResult?.skipped;
  const existing = await new Promise(resolve =>
    chrome.storage.local.get(['__discovery_auto_results'], x =>
      resolve(x.__discovery_auto_results || [])
    )
  );
  const result = {
    ts: now,
    ...classified,
    sourceId,
    sourceUsername,
    relation: 'followers',
    mutualCount,
    mutualFilterEnabled,
    requiredMutualCount: minMutualCount,
    gender,
    gender_confidence: genderConfidence,
    targetGender,
    followStatus: followResult?.alreadySent
      ? 'already-sent'
      : followResult?.skipped
        ? 'skipped'
        : matchesTargetGender
          ? (followResult?.ok ? 'sent' : 'not-sent')
          : 'not-sent',
    followReason: classificationUnavailable
      ? `AI analizi yapılamadı — takip isteği gönderilmedi${classified.classification_error ? ` (${classified.classification_error})` : ''}`
      : gender === 'unknown'
        ? 'AI sonucu belirsiz — takip isteği gönderilmedi'
      : !matchesTargetGender
        ? `${gender === 'female' ? 'Kadın' : 'Erkek'} seçili hedef değil`
        : followResult?.skipped
          ? 'Hesap zaten takip ediliyor veya bekleyen takip isteği var — yeni istek gönderilmedi'
          : followResult?.error || '',
    discoveryVersion: 6,
  };
  await recordDiscoveryHistory(candidate, {
    status: wasSent || followResult?.alreadySent ? 'follow-sent' : 'scanned',
    sourceId,
    sourceUsername,
    relation: 'followers',
    mutualCount,
    mutualFilterEnabled,
    requiredMutualCount: minMutualCount,
    gender,
    followStatus: result.followStatus,
  });
  await new Promise(resolve =>
    chrome.storage.local.set({
      __discovery_auto_results: [result, ...existing].slice(0, 500),
      [queueKey]: queue,
    }, resolve)
  );
  await patchState({
    discoveryLastActionLabel: followResult?.alreadySent
      ? `@${candidate.username} için takip isteği zaten gönderilmiş`
      : followResult?.skipped
        ? `@${candidate.username} zaten bağlı; yeni takip isteği gönderilmedi`
      : wasSent
        ? `@${candidate.username} takip edildi${mutualFilterEnabled ? ` (${mutualCount} ortak)` : ''}`
      : `@${candidate.username} işlendi: ${
        classificationUnavailable ? 'AI analizi yapılamadı' : gender === 'unknown' ? 'belirsiz' : gender
      }`,
    discoveryNextRunAt: now + randInt(state.minDelaySec, state.maxDelaySec) * 1000,
  });
  await appendDiscoveryLog('info', 'Takipçi adayı akışı tamamlandı', {
    sourceId,
    sourceUsername: `@${sourceUsername}`,
    candidate: `@${candidate.username}`,
    candidateId,
    mutualCount,
    mutualFilterEnabled,
    requiredMutualCount: minMutualCount,
    gender,
    targetGender,
    followStatus: followResult?.alreadySent
      ? 'already_sent'
      : followResult?.skipped
        ? 'skipped'
        : wasSent ? 'sent' : 'not_sent',
    error: followResult?.error || '',
      action: classificationUnavailable
        ? 'AI analizi yapılamadı; takip isteği gönderilmedi'
        : wasSent
      ? 'takip isteği gönderildi; sonraki turda sonraki takipçi işlenecek'
      : 'takip isteği gönderilmedi; sonraki turda sonraki takipçi işlenecek',
  });
}

async function runMutualDiscoveryTickImpl() {
  const state = await getState();
  // Beğeni sistemi açıkken keşif, paneldeki sabit hedef yerine beğenilen
  // hesabın takip ettiklerine bağlanır. Bu alarm turu yalnızca bağımsız
  // keşif çalışırken paneldeki hedef hesabı işler.
  if (state.enabled) {
    return;
  }
  return runDirectFollowerDiscoveryTick(state);
  if (!state.discoveryEnabled || !state.discoverySourceId) {
    return;
  }

  const now = Date.now();
  if (state.discoveryNextRunAt > now) return;
  if (state.discoveryTodayCount >= state.discoveryMaxPerDay) {
    await patchState({
      discoveryLastActionLabel: `Takip isteği günlük limiti dolu (${state.discoveryMaxPerDay})`,
    });
    return;
  }

  const targetId = String(state.discoverySourceId);
  const targetUsername = String(state.discoverySourceUsername || targetId).replace(/^@/, '');
  const minMutualCount = state.discoveryMinMutualCount;
  await appendDiscoveryLog('info', 'Ortak hesap kontrolü başladı', {
    targetId,
    targetUsername: `@${targetUsername}`,
    rule: minMutualCount > 0
      ? `Instagram mutual_followers sayısı en az ${minMutualCount} olmalı`
      : 'Ortak hesap sayısı filtresi kapalı',
    action: 'ortak hesap sayısı kontrol ediliyor',
  });

  const mutual = await fetchMutualFollowers(targetId);
  const mutualCount = Number(mutual.count) || 0;
  if (
    minMutualCount > 0 &&
    !matchesDiscoveryMutualCount(mutualCount, minMutualCount)
  ) {
    await patchState({
      discoveryLastActionLabel: `@${targetUsername} için ${mutualCount} ortak hesap bulundu — en az ${minMutualCount} olmalı`,
      discoveryNextRunAt: now + randInt(state.minDelaySec, state.maxDelaySec) * 1000,
    });
    await appendDiscoveryLog('info', 'Ortak hesap şartı sağlanmadı', {
      targetId,
      targetUsername: `@${targetUsername}`,
      mutualCount,
      expected: minMutualCount,
      endpoint: mutual.endpoint,
      action: 'cinsiyet kontrolü ve takip isteği yapılmadı',
    });
    return;
  }

  // The configured account is only the discovery source. Never open or
  // classify that account here: classify the accounts returned by
  // mutual_followers instead.
  const excludedIds = await getDiscoveryExcludedIds(targetId, []);
  const candidates = uniqueDiscoveryUsers(mutual.users)
    .filter(user => discoveryUserId(user) !== targetId)
    .filter(user => !excludedIds.has(discoveryUserId(user)));
  if (!candidates.length) {
    await patchState({
      discoveryLastActionLabel: `@${targetUsername} için ortak aday dönmedi`,
      discoveryNextRunAt: now + randInt(state.minDelaySec, state.maxDelaySec) * 1000,
    });
    await appendDiscoveryLog('info', 'Keşif kaynağının ortak adayları boş', {
      targetId,
      targetUsername: `@${targetUsername}`,
      mutualCount,
      returnedUserCount: mutual.users.length,
      action: 'kaynak hesap sınıflandırılmadı; takip isteği gönderilmedi',
    });
    return;
  }

  const classifiedCandidates = await classifyGenderInBackground(candidates);
  const targetGender = ['female', 'male', 'both'].includes(state.discoveryTargetGender)
    ? state.discoveryTargetGender
    : 'female';
  for (const candidate of classifiedCandidates) {
    await updateDiscoveryGenderState(candidate, targetGender);
  }
  await appendDiscoveryLog('info', 'Keşif ortak adayları sınıflandırıldı', {
    targetId,
    targetUsername: `@${targetUsername}`,
    mutualCount,
    candidateCount: classifiedCandidates.length,
    candidates: classifiedCandidates.map(user => `@${user.username}`),
    targetGender,
    action: 'keşif kaynağı sınıflandırılmadı; uygun aday aranıyor',
  });

  const matchesTargetGender = user => (
    (user.gender === 'female' && (targetGender === 'female' || targetGender === 'both')) ||
    (user.gender === 'male' && (targetGender === 'male' || targetGender === 'both'))
  );
  const candidate = classifiedCandidates.find(matchesTargetGender);
  if (!candidate) {
    await patchState({
      discoveryLastActionLabel: `@${targetUsername} için uygun ortak aday bulunamadı`,
      discoveryNextRunAt: now + randInt(state.minDelaySec, state.maxDelaySec) * 1000,
    });
    await appendDiscoveryLog('info', 'Ortak adaylar cinsiyet filtresinden geçmedi', {
      targetId,
      targetUsername: `@${targetUsername}`,
      mutualCount,
      targetGender,
      femaleCount: classifiedCandidates.filter(user => user.gender === 'female').length,
      maleCount: classifiedCandidates.filter(user => user.gender === 'male').length,
      unknownCount: classifiedCandidates.filter(user => user.gender === 'unknown').length,
      action: 'takip isteği gönderilmedi',
    });
    return;
  }

  let followResult;
  try {
    followResult = await sendAutomaticDiscoveryFollow(
      candidate,
      targetId,
      'followers',
      candidate.gender,
    );
  } catch (error) {
    followResult = { ok: false, error: String(error?.message || error) };
  }
  const wasSent = followResult?.ok === true &&
    !followResult?.alreadySent &&
    !followResult?.skipped;
  const gender = candidate.gender;
  await patchState({
    discoveryLastActionLabel: followResult?.alreadySent
      ? `@${candidate.username} için takip isteği zaten gönderilmiş`
      : followResult?.skipped
        ? `@${candidate.username} zaten bağlı; yeni takip isteği gönderilmedi`
      : wasSent
        ? `@${candidate.username} takip edildi (${mutualCount} ortak)`
        : `@${candidate.username} için takip isteği gönderilemedi`,
    discoveryNextRunAt: now + randInt(state.minDelaySec, state.maxDelaySec) * 1000,
  });
  await appendDiscoveryLog('info', 'Ortak hesap akışı tamamlandı', {
    targetId,
    targetUsername: `@${targetUsername}`,
    mutualCount,
    candidate: `@${candidate.username}`,
    candidateId: discoveryUserId(candidate),
    gender,
    targetGender,
    followStatus: followResult?.alreadySent
      ? 'already_sent'
      : followResult?.skipped
        ? 'skipped'
        : wasSent ? 'sent' : 'not_sent',
    error: followResult?.error || '',
    action: wasSent
      ? 'takip isteği gönderildi'
      : 'yeni takip isteği gönderilmedi',
  });
}

async function runAutolikeTick() {
  if (!(await validateExtensionLicense()).active) return;
  const state = await getState();
  if (!state.enabled) return;

  // Beğeni cache'ini yükle (service worker restartından sonra da çalışsın)
  await loadLikedCache();
  const now = Date.now();
  if (state.backoffUntil > now) {
    const remainingMinutes = Math.ceil((state.backoffUntil - now) / 60000);
    await patchState({
      lastActionLabel: _igRequestBlockedUntil > now
        ? `Instagram ortak beklemesi — otomasyon ${remainingMinutes} dk sonra devam edecek`
        : `Otomasyon bekliyor: ${remainingMinutes} dk bekleme`,
    });
    broadcastStatus();
    return;
  }
  const today = todayStr();
  if (state.todayDate !== today) {
    await patchState({ todayCount: 0, todayDate: today });
    state.todayCount = 0;
  }

  if (state.todayCount >= state.maxPerDay) return;
  if (state.nextRunAt > now) return;

  // ── Saatlik güvenlik sınırı ─────────────────────────────────────────
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const hourlyWindowStart = state.hourlyWindowStart || 0;
  const hourlyElapsed = now - hourlyWindowStart;
  if (hourlyElapsed > ONE_HOUR_MS) {
    // Saat dilimi doldu — sayacı sıfırla
    await patchState({ hourlyCount: 0, hourlyWindowStart: now });
    state.hourlyCount = 0;
    state.hourlyWindowStart = now;
  }
  const maxPerHour = Number(state.maxPerHour) || 35;
  if ((state.hourlyCount || 0) >= maxPerHour) {
    const waitMs  = Math.max(ONE_HOUR_MS - hourlyElapsed, 60000);
    const waitMin = Math.ceil(waitMs / 60000);
    await patchState({
      nextRunAt: now + waitMs,
      lastActionLabel: `Saatlik limit (${maxPerHour}) aşıldı — ${waitMin} dk bekleniyor`,
    });
    broadcastStatus();
    return;
  }

  // Kullanıcı ve token bilgilerini al
  const storage = await new Promise(resolve =>
    chrome.storage.local.get(['igUser', 'igGqlTokens'], resolve)
  );
  const igUser      = storage.igUser;
  const igGqlTokens = storage.igGqlTokens;
  const userId = String(igUser?.pk ?? igUser?.fbid_v2 ?? '');
  if (!userId) {
    await patchState({ lastActionLabel: 'Otomasyon bekliyor: Instagram kullanıcı bilgisi yok' });
    broadcastStatus();
    return;
  }

  let following;
  try {
    following = await getFollowing(userId);
  } catch (error) {
    if (isAutomationStopError(error)) {
      const errCount = state.consecutiveErrors + 1;
      const isSessionExpired = isSessionError(error);
      const isChallenge = isInstagramCheckpointError(error);
      const isAccessBlocked = isAccessBlockedMessage(error);
      const isTransient = isTransientTabIssue(error);
      const backoffMs = isSessionExpired
        ? 30 * 60000
        : isChallenge || isAccessBlocked
        ? 60 * 60000
        : isTransient
        ? 30 * 60000
        : Math.min(
            30 * 60000 * (2 ** Math.max(0, errCount - 1)),
            6 * 60 * 60000,
          );
      const backoffMinutes = Math.max(1, Math.ceil(backoffMs / 60000));
      await patchState({
        consecutiveErrors: errCount,
        backoffUntil: now + backoffMs,
        nextRunAt: now + backoffMs,
        lastActionLabel: isSessionExpired
          ? 'Oturum geçersiz — yeniden giriş yapana kadar otomasyon duraklatıldı'
          : isChallenge || isAccessBlocked
          ? `Instagram erişimi/doğrulaması kısıtlandı — otomasyon ${backoffMinutes} dk duraklatıldı`
          : isTransient
          ? 'Instagram sekmesi geçici olarak hazır değil — otomasyon 30 dk duraklatıldı'
          : `Instagram istek sınırı uyguladı — otomasyon duraklatıldı, ${backoffMinutes} dk boyunca yeni istek gönderilmeyecek`,
      });
      await appendDebugLog('warn', error.message || error, {
        phase: 'following',
        rateLimit: isRateLimitMessage(error),
        sessionExpired: isSessionExpired,
        challenge: isChallenge,
        accessBlocked: isAccessBlocked,
        consecutiveErrors: errCount,
        backoffMinutes,
      });
    } else {
      // getFollowing() hata fırlattı (her iki kat da başarısız).
      // Gerçek hata mesajını göster; "bulunamadı" ile üzerine yazma.
      await patchState({
        lastActionLabel: String(error.message ?? error).slice(0, 200),
        nextRunAt: now + 60000,
      });
      await appendDebugLog('error', error.message || error, { phase: 'following' });
    }
    broadcastStatus();
    return;
  }
  // Kullanıcı tarama sırasında beğeniyi kapatmış olabilir. Bu kontrolden
  // sonra mevcut turda hiçbir beğeni isteği gönderilmemeli.
  if (!(await isAutolikeStillEnabled())) return;
  if (following.length === 0) {
    await patchState({
      // During the first start Instagram can briefly expose an empty
      // following response while the page/bootstrap data is still loading.
      // Retry shortly instead of making the user close and reopen the panel.
      lastActionLabel: 'Instagram takip listesi hazırlanıyor — kısa süre sonra tekrar denenecek',
      nextRunAt: now + 15000,
    });
    broadcastStatus();
    return;
  }

  // Her tick'te en fazla 2 farklı aday kullanıcı seç (rastgele karıştır).
  // Daha fazla aday gereksiz listeleme isteği üretir.
  const shuffled   = [...following].sort(() => Math.random() - 0.5);
  const candidates = shuffled.slice(0, 2);

  let candidateDataForPartialReport = null;
  let activeReportType = '';
  let activeReportUsername = '';
  try {
    let liked = false;
    let likedCandidate = null;
    let likeTriggeredDiscoveryCandidate = null;
    let retrySoon = false;
    let actionLabel = '';
    const candidateReports = [];

    // Kullanıcının seçtiği içerik türleri — sadece bunlar işlenir.
    // Sıra: Hikâye → Gönderi → Reels (öncelik korunur).
    const enabledAll = Array.isArray(state.enabledContentTypes)
      ? state.enabledContentTypes.filter(t => ['story', 'post', 'reel'].includes(t))
      : ['story', 'post', 'reel'];
    const enabled = enabledAll.length > 0 ? enabledAll : ['story', 'post', 'reel'];
    const hasStory = enabled.includes('story');
    const hasPost  = enabled.includes('post');
    const hasReel  = enabled.includes('reel');

    // Aday kullanıcı verilerini hazırla — rawUsername @ içermez, displayUsername gösterim için.
    // Her aday ve her içerik türü raporda mutlaka yer alır; kontrol edilmemiş alan
    // yanlışlıkla "içerik yok" olarak gösterilmez.
    const candidateData = candidates.map(candidate => ({
      candidate,
      targetId: candidate.id,
      rawUsername: candidate.username.replace(/^@/, ''),
      username: candidate.username.startsWith('@') ? candidate.username : `@${candidate.username}`,
      contentStatus: {
        story: createContentStatus(hasStory),
        post:  createContentStatus(hasPost),
        reel:  createContentStatus(hasReel),
      },
    }));
    candidateDataForPartialReport = candidateData;
    await appendDebugLog('info', 'Otomatik beğeni içerik türleri ve adaylar', {
      enabled,
      hasStory,
      hasPost,
      hasReel,
      candidates: candidateData.map(({ username }) => username),
    });

    // ═══════════════════════════════════════════════════════════════
    // 1. TUR — HİKAYELER (global öncelik)
    // Önce tüm adayların hikayelerine bak; biri beğenilene kadar posta geçme.
    // ═══════════════════════════════════════════════════════════════
    let _storyIdx = 0;
    if (hasStory) for (const cd of candidateData) {
      if (liked) break;
      if (_storyIdx++ > 0) await new Promise(r => setTimeout(r, randInt(1500, 4000)));
      const { candidate, targetId, username, rawUsername, contentStatus } = cd;
      activeReportType = 'story';
      activeReportUsername = username;
      let likeMutationStarted = false;
      try {
        const resp = await callGraphQLMutation(
          '28026812547006985',
          {
            initial_reel_id: targetId,
            reel_ids: [targetId],
            first: 50,
            last: 0,
            __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true,
          },
          'PolarisStoriesV3ReelPageGalleryQuery',
        );
        const items  = normalizeMediaList(resp);
        const unliked = items.filter(isUnlikedMedia).filter(item => {
          const id = getMediaId(item);
          return id && !_likedCache.has(String(id));
        });
        const storyStatus = setContentStatus(contentStatus.story, {
          checked: true,
          found: items.length > 0,
          unliked: unliked.length > 0,
          responseCount: items.length,
          source: 'PolarisStoriesV3ReelPageGalleryQuery',
          reasonCode: items.length > 0
            ? (unliked.length > 0 ? 'unliked_available' : 'all_liked')
            : 'empty_response',
          reason: items.length > 0
            ? (unliked.length > 0
              ? `${items.length} hikaye bulundu, ${unliked.length} tanesi beğenilebilir`
              : `${items.length} hikaye bulundu; tamamı daha önce beğenilmiş`)
            : 'Instagram hikaye yanıtı boş döndü; bu hesapta şu anda aktif hikaye bulunamadı',
        });
        await appendDebugLog('info', 'Hikaye kontrolü tamamlandı', {
          username: candidate.username, found: items.length, unliked: unliked.length,
          reasonCode: storyStatus.reasonCode, reason: storyStatus.reason,
        });
        if (unliked.length > 0 && !liked) {
          // En baştaki (en eski) hikayeden başlayarak sırayla dene. Önizleme
          // görseli olmayan medya nesneleri genelde eksik/geçersiz veridir
          // (silinmiş, süresi dolmuş ya da yarım yüklenmiş hikaye) — bu tür
          // medyaya beğeni denemesi Instagram'dan "başarılı" görünen ama
          // aslında hiçbir şeyi beğenmeyen bir yanıt döndürebiliyor. Bu yüzden
          // önizlemesi olan ilk hikayeyi seçiyoruz; hiçbirinde yoksa hiç
          // beğeni denemiyoruz ve sahte bir "beğenildi" kaydı oluşturmuyoruz.
          const sortedUnliked = [...unliked].sort((a, b) => (a.taken_at ?? 0) - (b.taken_at ?? 0));
          const media   = sortedUnliked.find(m => getMediaThumbnail(m)) || null;
          const mediaId = media ? getMediaId(media) : '';
          const thumbUrl = media ? getMediaThumbnail(media) : '';
          if (mediaId && thumbUrl) {
            if (!(await isAutolikeStillEnabled())) return;
            if (!(await verifyAutolikeCandidateStillFollowed(candidate, 'story'))) {
              markContentStatusFollowGuardSkip(contentStatus.story, 'story');
              continue;
            }
            likeMutationStarted = true;
            await likeMediaWithGraphQL(mediaId, 'story');
            liked = true;
            likedCandidate = candidate;
            actionLabel = `Hikaye beğenildi (${username})`;
            markLiked(mediaId);
            await appendLikeLog('story', rawUsername, 'Hikaye beğenildi', thumbUrl, mediaId);
          } else if (sortedUnliked.length > 0) {
            await appendDebugLog('warn', 'Hikayelerin hiçbirinde önizleme görseli yok — beğeni denenmedi', {
              username: candidate.username, count: sortedUnliked.length,
            });
          }
        }
      } catch (e) {
        // A blocked/authenticated response must stop the whole tick. Continuing
        // after a like mutation started is also unsafe because its result may
        // be ambiguous. A transient read failure before any like attempt is
        // content-specific, so allow the post/reel fallback to run.
        const isEmptyResponse = isTransientTabIssue(e) && !likeMutationStarted;
        if (isAutomationStopError(e) && !isEmptyResponse) throw e;
        if (isEmptyResponse) retrySoon = true;
        const errorMessage = e?.message || String(e);
        setContentStatus(contentStatus.story, {
          checked: !isEmptyResponse,
          error: errorMessage,
          reasonCode: isEmptyResponse ? 'retry_pending' : 'request_error',
          reason: `Hikaye isteği başarısız oldu: ${errorMessage}`,
          source: 'PolarisStoriesV3ReelPageGalleryQuery',
        });
        await appendDebugLog(isEmptyResponse ? 'warn' : 'error', errorMessage, {
          username: candidate.username, contentType: 'story', reasonCode: 'request_error',
        });
        if (isEmptyResponse) break;
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 2. TUR — GÖNDERİLER (hikaye bulunamadıysa)
    // ═══════════════════════════════════════════════════════════════
    if (hasPost && !liked) {
      // Bir önceki bölümden gelen istekler arasında insan gibi mola ver
      if (hasStory) await new Promise(r => setTimeout(r, randInt(2000, 5000)));
      let _postIdx = 0;
      for (const cd of candidateData) {
        if (liked) break;
        if (_postIdx++ > 0) await new Promise(r => setTimeout(r, randInt(1500, 4000)));
        const { candidate, targetId, username, rawUsername, contentStatus } = cd;
        activeReportType = 'post';
        activeReportUsername = username;
        let likeMutationStarted = false;
        try {
          const resp = await fetchProfilePosts(targetId, candidate.username);
          const postItems = normalizeMediaList(resp);
          const unliked = postItems.filter(isUnlikedMedia).filter(item => {
            const id = getMediaId(item);
            return id && !_likedCache.has(String(id));
          });
          const postStatus = setContentStatus(contentStatus.post, {
            checked: true,
            found: postItems.length > 0,
            unliked: unliked.length > 0,
            responseCount: postItems.length,
            source: 'PolarisProfilePostsTabContentQuery_connection',
            reasonCode: postItems.length > 0
              ? (unliked.length > 0 ? 'unliked_available' : 'all_liked')
              : 'empty_response',
            reason: postItems.length > 0
              ? (unliked.length > 0
                ? `${postItems.length} gönderi bulundu, ${unliked.length} tanesi beğenilebilir`
                : `${postItems.length} gönderi bulundu; tamamı daha önce beğenilmiş`)
              : 'Instagram gönderi yanıtı boş döndü; bu hesapta erişilebilir gönderi bulunamadı',
          });
          await appendDebugLog('info', 'Gönderi kontrolü tamamlandı', {
            username: candidate.username, found: postItems.length, unliked: unliked.length,
            reasonCode: postStatus.reasonCode, reason: postStatus.reason,
          });
          if (unliked.length > 0 && !liked) {
            const post    = unliked[Math.floor(Math.random() * unliked.length)];
            const mediaId = getMediaId(post);
            if (mediaId) {
              const thumbUrl = getMediaThumbnail(post);
              if (!(await isAutolikeStillEnabled())) return;
              if (!(await verifyAutolikeCandidateStillFollowed(candidate, 'post'))) {
                markContentStatusFollowGuardSkip(contentStatus.post, 'post');
                continue;
              }
              likeMutationStarted = true;
              await likeMediaWithGraphQL(mediaId, 'post');
              liked = true;
              likedCandidate = candidate;
              actionLabel = `Gönderi beğenildi (${username})`;
              markLiked(mediaId);
              await appendLikeLog('post', rawUsername, 'Gönderi beğenildi', thumbUrl, mediaId);
            }
          }
        } catch (e) {
          // Never fan out after a hard block or an ambiguous like mutation.
          // A transient content-read failure may still fall through to reels.
          const isEmptyResponse = isTransientTabIssue(e) && !likeMutationStarted;
          if (isAutomationStopError(e) && !isEmptyResponse) throw e;
          if (isEmptyResponse) {
            retrySoon = true;
            if (hasReel) {
              await appendDebugLog('info', 'Gönderi geçici hata verdi; Reels yedeğine geçiliyor', {
                username: candidate.username,
                error: String(e?.message || e).slice(0, 240),
              });
            }
          }
          const errorMessage = e?.message || String(e);
          setContentStatus(contentStatus.post, {
            checked: !isEmptyResponse,
            error: errorMessage,
            reasonCode: isEmptyResponse ? 'retry_pending' : 'request_error',
            reason: `Gönderi isteği başarısız oldu: ${errorMessage}`,
            source: 'PolarisProfilePostsTabContentQuery_connection',
          });
          await appendDebugLog(isEmptyResponse ? 'warn' : 'error', errorMessage, {
            username: candidate.username, contentType: 'post', reasonCode: 'request_error',
          });
          if (isEmptyResponse) break;
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 3. TUR — REELS (hikaye ve gönderi bulunamadıysa)
    // ═══════════════════════════════════════════════════════════════
    if (hasReel && !liked) {
      await appendDebugLog('info', 'Reels kontrol aşaması başladı', {
        candidates: candidateData.map(({ username }) => username),
        postRetryPending: retrySoon,
      });
      // Bir önceki bölümden gelen istekler arasında insan gibi mola ver
      if (hasStory || hasPost) await new Promise(r => setTimeout(r, randInt(2000, 5000)));
      let _reelIdx = 0;
      for (const cd of candidateData) {
        if (liked) break;
        if (_reelIdx++ > 0) await new Promise(r => setTimeout(r, randInt(1500, 4000)));
        const { candidate, targetId, username, rawUsername, contentStatus } = cd;
        activeReportType = 'reel';
        activeReportUsername = username;
        try {
          const resp = await fetchProfileReels(targetId);
          const reelItems = normalizeMediaList(resp);
          const unliked = reelItems
            .map(item => item.media ?? item)
            .filter(isUnlikedMedia)
            .filter(item => {
              const id = getMediaId(item);
              return id && !_likedCache.has(String(id));
            });
          const reelStatus = setContentStatus(contentStatus.reel, {
            checked: true,
            found: reelItems.length > 0,
            unliked: unliked.length > 0,
            responseCount: reelItems.length,
            source: 'PolarisProfileReelsTabContentQuery',
            reasonCode: reelItems.length > 0
              ? (unliked.length > 0 ? 'unliked_available' : 'all_liked')
              : 'empty_response',
            reason: reelItems.length > 0
              ? (unliked.length > 0
                ? `${reelItems.length} reels bulundu, ${unliked.length} tanesi beğenilebilir`
                : `${reelItems.length} reels bulundu; tamamı daha önce beğenilmiş`)
              : 'Instagram reels yanıtı boş döndü; bu hesapta erişilebilir reels bulunamadı',
          });
          await appendDebugLog('info', 'Reels kontrolü tamamlandı', {
            username: candidate.username, found: reelItems.length, unliked: unliked.length,
            reasonCode: reelStatus.reasonCode, reason: reelStatus.reason,
          });
          if (unliked.length > 0 && !liked) {
            const media   = unliked[Math.floor(Math.random() * unliked.length)];
            const mediaId = getMediaId(media);
            if (mediaId) {
              const thumbUrl = getMediaThumbnail(media);
              if (!(await isAutolikeStillEnabled())) return;
              if (!(await verifyAutolikeCandidateStillFollowed(candidate, 'reel'))) {
                markContentStatusFollowGuardSkip(contentStatus.reel, 'reel');
                continue;
              }
              await likeMediaWithGraphQL(mediaId, 'reel');
              liked = true;
              likedCandidate = candidate;
              actionLabel = `Reel beğenildi (${username})`;
              markLiked(mediaId);
              await appendLikeLog('reel', rawUsername, 'Reel beğenildi', thumbUrl, mediaId);
            }
          }
        } catch (e) {
          // Stop the tick on server enforcement instead of probing the
          // remaining candidates/content types.
          const isEmptyResponse = isTransientTabIssue(e);
          if (isAutomationStopError(e) && !isEmptyResponse) {
            await appendDebugLog('warn', 'Reels kontrolü Instagram koruması nedeniyle durdu', {
              username: candidate.username,
              contentType: 'reel',
              rateLimited: isRateLimitMessage(e) || isRateLimitCooldownError(e),
              sessionExpired: isSessionError(e),
              error: String(e?.message || e).slice(0, 240),
            });
            throw e;
          }
          if (isEmptyResponse) retrySoon = true;
          const errorMessage = e?.message || String(e);
          setContentStatus(contentStatus.reel, {
            checked: !isEmptyResponse,
            error: errorMessage,
            reasonCode: isEmptyResponse ? 'retry_pending' : 'request_error',
            reason: `Reels isteği başarısız oldu: ${errorMessage}`,
            source: 'PolarisProfileReelsTabContentQuery',
          });
          await appendDebugLog(isEmptyResponse ? 'warn' : 'error', errorMessage, {
            username: candidate.username, contentType: 'reel', reasonCode: 'request_error',
          });
        }
      }
    }

    if (liked && likedCandidate) {
      likeTriggeredDiscoveryCandidate = likedCandidate;
    }

    for (const cd of candidateData) {
      const { username, contentStatus } = cd;
      candidateReports.push(
        `${username} — Hikaye: ${describeContentStatus(contentStatus.story)}, ` +
        `Gönderi: ${describeContentStatus(contentStatus.post)}, ` +
        `Reels: ${describeContentStatus(contentStatus.reel)}`
      );
    }
    const candidateReportDetails = candidateData.map(({ username, contentStatus }) => ({
      username,
      story: { ...contentStatus.story, display: describeContentStatus(contentStatus.story) },
      post: { ...contentStatus.post, display: describeContentStatus(contentStatus.post) },
      reel: { ...contentStatus.reel, display: describeContentStatus(contentStatus.reel) },
    }));

    const newCount       = state.todayCount + (liked ? 1 : 0);
    const newHourlyCount = (state.hourlyCount || 0) + (liked ? 1 : 0);
    const batchSize      = Number(state.batchSize)      || 0;
    const batchPauseSec  = Number(state.batchPauseSec)  || 0;
    let   nextRunAt      = retrySoon
      ? now + randInt(10, 15) * 1000
      : now + randInt(state.minDelaySec, state.maxDelaySec) * 1000;
    let   batchNote      = '';
    if (liked && batchSize > 0 && batchPauseSec > 0 && newCount % batchSize === 0) {
      nextRunAt = now + batchPauseSec * 1000;
      const mins = Math.max(1, Math.round(batchPauseSec / 60));
      batchNote = ` · Batch tamamlandı (${newCount}/${state.maxPerDay}) → ${mins} dk bekleniyor`;
    }
    await patchState({
      todayCount: newCount,
      hourlyCount: newHourlyCount,
      todayDate: today,
      nextRunAt,
      consecutiveErrors: 0,
      lastCandidateReports: candidateReportDetails,
      lastScanAt: Date.now(),
      lastActionLabel: actionLabel
        ? `${actionLabel} · Kontrol edilen adaylar: ${candidateReports.join(' | ')}${batchNote}`
        : retrySoon
        ? `Instagram sekmesi hazırlanıyor — kısa süre sonra yeniden denenecek · ${candidateReports.join(' | ')}`
        : `İçerik durumu — ${candidateReports.join(' | ') || 'Kontrol edilecek aday bulunamadı'}`,
    });
    broadcastStatus();
    // Beğeniyi ve zamanlayıcısını önce kaydet. Takip keşfi ayrı çalışır; uzun
    // aday taraması veya mutual beklemesi yeni beğenileri kilitleyemez.
    if (
      likeTriggeredDiscoveryCandidate &&
      (await getState()).discoveryEnabled
    ) {
      scheduleLikeTriggeredMutualDiscovery(likeTriggeredDiscoveryCandidate);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (candidateDataForPartialReport?.length) {
      const activeCandidate = candidateDataForPartialReport.find(
        item => item.username === activeReportUsername,
      );
      const activeStatus = activeCandidate?.contentStatus?.[activeReportType];
      const stoppedByRateLimit = isRateLimitCooldownError(err) || isRateLimitMessage(msg);
      const stoppedByTransient = isTransientTabIssue(err);
      if (activeStatus && !activeStatus.checked && !activeStatus.error) {
        const typeLabel = { story: 'Hikaye', post: 'Gönderi', reel: 'Reels' }[activeReportType] || 'İçerik';
        activeStatus.reasonCode = 'not_checked';
        activeStatus.reason = stoppedByRateLimit
          ? `Instagram istek sınırı nedeniyle ${typeLabel} kontrolü durdu; güvenli bekleme etkin`
          : stoppedByTransient
          ? `Instagram geçici yanıtı nedeniyle ${typeLabel} kontrolü tamamlanmadı; yeniden denenecek`
          : `${typeLabel} kontrolü bu aşamada tamamlanmadı: ${msg}`;
      }
      const partialReports = candidateDataForPartialReport.map(({ username, contentStatus }) => ({
        username,
        story: { ...contentStatus.story, display: describeContentStatus(contentStatus.story) },
        post: { ...contentStatus.post, display: describeContentStatus(contentStatus.post) },
        reel: { ...contentStatus.reel, display: describeContentStatus(contentStatus.reel) },
      }));
      await patchState({
        lastCandidateReports: partialReports,
        lastScanAt: Date.now(),
      });
      await appendDebugLog('warn', 'Tarama içerik türü tamamlanmadan durdu', {
        phase: activeReportType || 'autolikeTick',
        username: activeReportUsername || '',
        rateLimited: stoppedByRateLimit,
        transient: stoppedByTransient,
        error: msg.slice(0, 240),
      });
    }
    if (isRateLimitCooldownError(err)) {
      const blockedUntil = Math.max(Date.now(), _igRequestBlockedUntil);
      const remainingMinutes = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60000));
      await patchState({
        backoffUntil: blockedUntil,
        nextRunAt: blockedUntil,
        lastActionLabel: `Instagram ortak beklemesi — otomasyon ${remainingMinutes} dk sonra devam edecek`,
      });
      broadcastStatus();
      return;
    }
    const isRateLimit = isRateLimitMessage(msg);
    // 1357004 = Instagram'ın eski/geçersiz doc_id'ye verdiği "bilinmeyen sorgu" yanıtı.
    // Bu bir reCAPTCHA/checkpoint DEĞİL — kullanıcı Instagram'a girdiğinde doğrulama görmez.
    // Gerçek challenge: checkpoint_required, challenge_required gibi anahtar kelimeler içerir
    // ve genellikle instagram.com/challenge/ adresinde görünür ekranla birlikte gelir.
    const isDocIdError = /\b1357004\b/.test(msg);
    const isChallenge = !isDocIdError && (isInstagramCheckpointError(msg) || /captcha|recaptcha/i.test(msg));
    const isAccessBlocked = isAccessBlockedMessage(msg);
    const isEmptyResponse = isTransientTabIssue(msg);
    // Oturumun kesin olarak süresi dolduğu doğrulandıysa (yönlendirme takibiyle
    // tespit edildi), her dakika aynı isteği tekrar tekrar deneyip aynı hatayı
    // loglamanın anlamı yok — kullanıcı tarayıcıdan yeniden giriş yapana kadar
    // otomasyonu tamamen duraklat (sessionid çerezi kontrolüyle aynı davranış).
    // An explicit auth response is authoritative. A sessionid cookie can be
    // stale or revoked, so it must never override a 401/403/login_required.
    const isSessionExpired = isSessionError(msg) || msg.includes('Oturum süresi dolmuş');
    // An empty response or HTML shell is a temporary page-readiness issue,
    // not a confirmed 429. Use a short retry window without disabling automation.
    if (isEmptyResponse && !isSessionExpired) {
      // A newly opened Instagram tab can briefly return an empty response or
      // HTML shell before its page data is ready. This is transient readiness,
      // not a confirmed rate limit; retry soon without disabling automation.
      const emptyErrCount  = state.consecutiveErrors + 1;
      const emptyBackoffMs = Math.min(
        5 * 60 * 1000,
        15 * 1000 * (2 ** Math.max(0, emptyErrCount - 1)),
      );
      await patchState({
        consecutiveErrors: emptyErrCount,
        backoffUntil: now + emptyBackoffMs,
        nextRunAt:    now + emptyBackoffMs,
        lastActionLabel: 'Instagram sekmesi hazırlanıyor — otomasyon kısa süre sonra tekrar deneyecek',
      });
      await appendDebugLog('warn', msg, {
        phase: 'autolikeTick',
        consecutiveErrors: emptyErrCount,
        htmlRedirect: true,
        retrySeconds: Math.ceil(emptyBackoffMs / 1000),
      });
      broadcastStatus();
      return;
    }
    const errCount = state.consecutiveErrors + 1;
    let backoffMs;
    if (isSessionExpired) {
      backoffMs = 30 * 60000;
    } else if (isChallenge || isAccessBlocked) {
      backoffMs = 60 * 60000;  // 1 saat — kullanıcı tarayıcıda challenge'ı çözsün
    } else if (isDocIdError) {
      backoffMs = 5 * 60000;   // 5 dk — geçici, doc_id hatası gerçek engel değil
    } else if (isRateLimit) {
      backoffMs = IG_RATE_LIMIT_COOLDOWN_MS;
    } else {
      backoffMs = Math.min(errCount * 5 * 60000, 60 * 60000);
    }
    const backoffMinutes = Math.max(1, Math.ceil(backoffMs / 60000));
    const statusLabel = isSessionExpired
      ? 'Oturum süresi dolmuş — instagram.com\'a tarayıcıdan yeniden giriş yapıp otomasyonu tekrar aç'
      : isChallenge || isAccessBlocked
      ? 'Instagram erişimi/doğrulaması kısıtlandı — instagram.com sekmesini kontrol et; otomasyon 60 dk duraklatıldı'
      : isDocIdError
      ? `Hikaye beğeni isteği reddedildi (geçici API sorunu) — ${backoffMinutes} dk sonra yeniden denecek`
      : isRateLimit
      ? `Instagram 429 yanıtı verdi — otomasyon ${backoffMinutes} dk bekleyecek ve sonra otomatik devam edecek`
      : `Hata: ${msg.slice(0, 80)}`;

    await patchState({
      consecutiveErrors: errCount,
      backoffUntil: now + backoffMs,
      nextRunAt: now + backoffMs,
      lastActionLabel: statusLabel,
      ...(isRateLimit ? { discoveryNextRunAt: now + backoffMs } : {}),
      ...((isSessionExpired || isChallenge || isAccessBlocked)
        ? { enabled: false }
        : {}),
    });
    await appendDebugLog(isRateLimit || isChallenge || isAccessBlocked || isEmptyResponse || isSessionExpired ? 'warn' : 'error', msg, {
      phase: 'autolikeTick',
      consecutiveErrors: errCount,
      rateLimit: isRateLimit,
      challenge: isChallenge,
      accessBlocked: isAccessBlocked,
      sessionExpired: isSessionExpired,
      backoffMinutes,
    });
    broadcastStatus();
  }
}

async function isAutolikeStillEnabled() {
  const current = await getState();
  return current.enabled === true;
}

// The one-minute alarm and the enable button can fire at the same time.
// Prevent overlapping scans and duplicate likes before counters are persisted.
let _autolikeInFlight = false;
async function autolikeTick() {
  if (_autolikeInFlight) return;
  _autolikeInFlight = true;
  try {
    await runAutolikeTick();
  } finally {
    _autolikeInFlight = false;
  }
}

// Beğeni ve takip isteği sistemleri ayrı kilitlerle çalışır. Aynı anda
// etkinleştirildiklerinde ikisi de kendi turunu başlatır; gerçek Instagram
// istekleri yine ortak güvenlik kuyruğundan sırayla geçer.
let _discoveryInFlight = false;
async function discoveryAlarmTick() {
  if (_discoveryInFlight) return;
  _discoveryInFlight = true;
  try {
    await runDiscoveryTick();
  } finally {
    _discoveryInFlight = false;
  }
}

// ── Instagram listelerini sayfa yönlendirme ile çekme ─────────────────
// Instagram, eklenti içinden yapılan fetch isteklerini (hem executeScript
// hem content-script isolated world) algılayıp login sayfasına yönlendiriyor.
// Tek güvenilir yol: Instagram'ın kendi sayfasını (followers/following)
// yüklemek, Instagram'ın kendi JS'inin API'yi çağırmasını beklemek ve
// page-data-bridge aracılığıyla yanıtı yakalamak.
async function fetchFollowListViaContentScript(endpoint, params, method, body, cacheKey, reply) {
  const storage = await new Promise(resolve => chrome.storage.local.get(['igUser'], resolve));
  const user = storage?.igUser;
  if (!user?.username) {
    return 'Kullanıcı adı bulunamadı — paneli yeniden aç';
  }

  // Yalnızca kullanıcının zaten açık tuttuğu Instagram sekmesini kullan.
  let tabs = await queryInstagramTabs();
  let tab = tabs.find(t => t.id != null && t.status === 'complete' && !t.url?.includes('/accounts/'));

  const kind = endpoint.includes('/followers') ? 'followers' : 'following';
  const targetUrl = 'https://www.instagram.com/' + user.username + '/' + kind + '/';

  // Kullanıcının açık bir Instagram sekmesi yoksa yeni sekme açma.
  if (!tab?.id) {
    return 'Açık Instagram sekmesi bulunamadı — instagram.com adresini manuel açıp tekrar deneyin';
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve('Instagram sayfası zaman aşımı. instagram.com sekmesini kontrol edip tekrar dene.');
    }, 45000);

    const listener = (msg) => {
      if (msg.type !== 'IG_FOLLOW_LIST') return;
      try {
        const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
        if (payload?.kind !== kind) return;
        if (!isCurrentUsersFollowList(payload, user)) return;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        const users = Array.isArray(payload.users) ? payload.users : [];
        if (users.length > 0) {
          chrome.storage.local.get(['igUser'], ({ igUser }) => {
            chrome.storage.local.set({
              [cacheKey]: {
                users,
                userId: String(igUser?.pk ?? igUser?.fbid_v2 ?? igUser?.id ?? ''),
                scope: 'current-user',
                next_max_id: payload.next_max_id ?? null,
                ts: Date.now(),
              },
            });
          });
        }
        reply({ ok: true, data: { users, next_max_id: payload.next_max_id ?? null } });
        resolve(null);
      } catch {}
    };
    chrome.runtime.onMessage.addListener(listener);

    // Sekmeyi takipçi/takip sayfasına yönlendir (yeni açıldıysa zaten orada)
    if (tab?.id) {
      chrome.tabs.update(tab.id, { url: targetUrl }).catch(() => {});
    }
    appendDebugLog('info', 'Liste yükleniyor — sayfa: ' + targetUrl).catch(() => {});
  });
}

function logProfileLoaded(user, fallbackUsername, action) {
  const username = String(user?.username || fallbackUsername || '').replace(/^@/, '').trim();
  const userId = String(user?.pk ?? user?.id ?? user?.fbid_v2 ?? '').trim();
  const key = userId || username.toLowerCase();
  if (!key) return;

  const now = Date.now();
  const lastLoggedAt = Number(_profileLogLastAt.get(key)) || 0;
  if (now - lastLoggedAt < DISCOVERY_PROFILE_CACHE_TTL_MS) return;
  _profileLogLastAt.set(key, now);
  appendDebugLog('info', 'Kullanıcı profiline girildi', {
    username: `@${username}`,
    userId,
    action,
  }).catch(() => {});
}

function saveDiscoveryProfileCache(user, fallbackUsername) {
  const username = String(user?.username || fallbackUsername || '').replace(/^@/, '').trim();
  const userId = String(user?.pk ?? user?.id ?? user?.fbid_v2 ?? '').trim();
  if (!username && !userId) return Promise.resolve();
  return new Promise(resolve => chrome.storage.local.set({
    [DISCOVERY_PROFILE_CACHE_KEY]: {
      user,
      userId,
      username,
      updatedAt: Date.now(),
    },
  }, resolve));
}

async function resolveDiscoveryProfile(targetId, targetUsername) {
  const id = String(targetId || '').trim();
  const username = String(targetUsername || '').replace(/^@/, '').trim();
  const key = `${id}:${username.toLowerCase()}`;
  const pending = _discoveryProfileInFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const stored = await new Promise(resolve =>
      chrome.storage.local.get([DISCOVERY_PROFILE_CACHE_KEY], resolve)
    );
    const cached = stored[DISCOVERY_PROFILE_CACHE_KEY];
    const cachedId = String(cached?.user?.pk ?? cached?.user?.id ?? cached?.userId ?? '').trim();
    const cachedUsername = String(cached?.user?.username ?? cached?.username ?? '')
      .replace(/^@/, '').toLowerCase();
    const isFresh = Number(cached?.updatedAt) > Date.now() - DISCOVERY_PROFILE_CACHE_TTL_MS;
    const sameTarget = (!id || !cachedId || cachedId === id)
      && (!username || !cachedUsername || cachedUsername === username.toLowerCase());
    if (isFresh && sameTarget && cached?.user && (cachedId || cachedUsername)) {
      return {
        ...cached.user,
        id: String(cached.user.pk ?? cached.user.id ?? cachedId).trim(),
        pk: String(cached.user.pk ?? cached.user.id ?? cachedId).trim(),
        username: String(cached.user.username || username).replace(/^@/, ''),
      };
    }

    const profile = await resolveInstagramProfileByUsername(username);
    await saveDiscoveryProfileCache(profile, username);
    return profile;
  })();

  _discoveryProfileInFlight.set(key, task);
  try {
    return await task;
  } finally {
    _discoveryProfileInFlight.delete(key);
  }
}

async function resolveInstagramProfileByUsername(username) {
  const normalizedUsername = String(username ?? '').replace(/^@/, '').trim();
  const key = normalizedUsername.toLowerCase();
  if (!key) throw new Error('Kaynak hesap kullanıcı adı gerekli');

  // Do not probe web_profile_info here. Instagram rate-limits this endpoint
  // aggressively for extension-originated requests, even when the browser
  // session is valid. Resolve the account from the real profile page instead.
  const tabs = await queryInstagramTabs();
  const tab = chooseInstagramTab(tabs);
  if (!tab?.id) {
    throw new Error('Açık Instagram sekmesi bulunamadı — instagram.com sekmesini açıp tekrar deneyin');
  }

  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _profileLookupWaiters.delete(key);
      reject(new Error('Instagram kullanıcı profili zamanında yüklenmedi. Profili Instagram sekmesinde açıp tekrar deneyin.'));
    }, PROFILE_LOOKUP_TIMEOUT_MS);
    _profileLookupWaiters.set(key, { tabId: tab.id, resolve, reject, timer });
  });

  // If the profile is already open and the bridge retained its response,
  // resolve without an unnecessary navigation.
  try {
    const existing = await sendInstagramMessage(
      tab.id,
      { type: 'IG_PROFILE_LOOKUP', username: normalizedUsername },
      2500,
    );
    if (existing?.ok && existing.user) {
      logProfileLoaded(
        existing.user,
        normalizedUsername,
        'profil verisi mevcut Instagram sekmesinden alındı',
      );
      const waiter = _profileLookupWaiters.get(key);
      if (waiter) {
        _profileLookupWaiters.delete(key);
        clearTimeout(waiter.timer);
        waiter.resolve({
          ...existing.user,
          id: String(existing.user.pk ?? existing.user.id ?? '').trim(),
          pk: String(existing.user.pk ?? existing.user.id ?? '').trim(),
          username: String(existing.user.username || normalizedUsername).replace(/^@/, ''),
        });
      }
      return result;
    }
  } catch {}

  const targetUrl = `https://www.instagram.com/${encodeURIComponent(normalizedUsername)}/`;
  try {
    await chrome.tabs.update(tab.id, { url: targetUrl });
  } catch (error) {
    const waiter = _profileLookupWaiters.get(key);
    if (waiter) {
      _profileLookupWaiters.delete(key);
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Instagram profili açılamadı: ${error?.message || error}`));
    }
  }
  appendDebugLog('info', 'Kullanıcı profili tarayıcı sekmesinde açılıyor', {
    username: normalizedUsername,
    targetUrl,
  }).catch(() => {});
  return result;
}




async function reanalyzeUnknownGenderRecords(options = {}) {
  const analyzeAllDashboardAccounts = options?.all === true;
  const apiSettings = await new Promise(resolve =>
    chrome.storage.local.get([LICENSE_API_URL_KEY], resolve)
  );
  const providerStatus = getGenderProviderStatus(apiSettings[LICENSE_API_URL_KEY]);
  if (!providerStatus.available) {
    await appendDiscoveryLog('info', 'Dashboard Belirsiz kayıt analizi atlandı', {
      provider: 'none',
      action: 'Lisans sunucusu adresi yok; kartlar Belirsiz bırakıldı',
    });
    return {
      ok: false,
      code: 'NO_GENDER_PROVIDER',
      message: 'Cinsiyet analizi için önce lisans sunucusu adresini kaydedip etkin bir lisansla bağlanın. Kartlar Belirsiz olarak bırakıldı.',
    };
  }
  const stored = await new Promise(resolve => chrome.storage.local.get([
    '__discovery_auto_results',
    '__discovery_manual_results_v1',
    '__cached_following',
    '__ai_gender_users_v1',
    '__ai_gender_labels_v1',
    '__discovery_follow_status_v1',
    'igAutoState',
  ], resolve));
  const autoResults = Array.isArray(stored.__discovery_auto_results)
    ? stored.__discovery_auto_results
    : [];
  const manualData = stored.__discovery_manual_results_v1 &&
    typeof stored.__discovery_manual_results_v1 === 'object'
    ? stored.__discovery_manual_results_v1
    : null;
  const manualUsers = Array.isArray(manualData?.users) ? manualData.users : [];
  const cachedFollowing = stored.__cached_following &&
    typeof stored.__cached_following === 'object'
    ? stored.__cached_following
    : null;
  const cachedUsers = Array.isArray(cachedFollowing?.users) ? cachedFollowing.users : [];
  const legacyUsers = Array.isArray(stored.__ai_gender_users_v1)
    ? stored.__ai_gender_users_v1
    : [];
  const labels = stored.__ai_gender_labels_v1 || {};
  const followStatuses = stored.__discovery_follow_status_v1 || {};
  const minMutualCount = getDiscoveryMinMutualCount(stored.igAutoState);
  const mutualFilterEnabled = minMutualCount > 0;
  const records = new Map();

  const addRecord = (user, bucket) => {
    if (
      mutualFilterEnabled &&
      !matchesDiscoveryMutualCount(user?.mutualCount, minMutualCount)
    ) return;
    const id = discoveryUserId(user);
    const username = String(user?.username || '').replace(/^@/, '').trim();
    if (!id || !username) return;
    const current = records.get(id) || { user: {}, buckets: new Set() };
    current.user = { ...current.user, ...user };
    current.buckets.add(bucket);
    records.set(id, current);
  };
  autoResults.forEach(user => addRecord(user, 'auto'));
  manualUsers.forEach(user => addRecord(user, 'manual'));
  // Bu düğme yalnızca dashboard kartlarında görünen otomatik/manuel keşif
  // kayıtlarını işler. Eski takip önbelleği veya legacy liste ayrı tutulur.

  const isUnknown = user => {
    const id = discoveryUserId(user);
    const username = String(user?.username || '').replace(/^@/, '').toLowerCase();
    const label = labels[id] || labels[username] || labels[`u:${username}`];
    return normalizeGender(label?.gender ?? user?.gender) === 'unknown';
  };
  const pendingRecords = [...records.values()].filter(item =>
    analyzeAllDashboardAccounts || isUnknown(item.user)
  );
  const batch = pendingRecords.slice(0, 100);
  if (!batch.length) {
    return { ok: true, total: 0, message: 'Yeniden analiz edilecek Belirsiz kayıt bulunamadı' };
  }

  await appendDiscoveryLog(
    'info',
    analyzeAllDashboardAccounts
      ? 'Dashboard hesapları manuel cinsiyet analizi için işleniyor'
      : 'Dashboard üzerinden Belirsiz kayıtlar yeniden analiz ediliyor',
    {
    candidateCount: batch.length,
    skippedBeyondLimit: Math.max(0, pendingRecords.length - batch.length),
    action: analyzeAllDashboardAccounts
      ? (mutualFilterEnabled
        ? `Dashboardda en az ${minMutualCount} ortak hesabı olan adaylar zorunlu sınıflandırılıyor`
        : 'Ortak hesap filtresi kapalı; Dashboard adayları zorunlu sınıflandırılıyor')
      : 'eski adaylar zorunlu yeniden sınıflandırılıyor',
    }
  );
  const classified = await classifyGenderInBackground(
    batch.map(item => item.user),
    { force: true },
  );
  const classifiedById = new Map(classified.map(user => [discoveryUserId(user), user]));
  let femaleCount = 0;
  let maleCount = 0;
  let unknownCount = 0;
  let sentCount = 0;
  let skippedCount = 0;
  const updates = new Map();

  for (const item of batch) {
    const id = discoveryUserId(item.user);
    const result = classifiedById.get(id);
    if (!result) continue;
    const gender = normalizeGender(result.gender);
    let next = {
      ...item.user,
      ...result,
      gender,
      gender_confidence: Number(result.gender_confidence) || 0,
      genderReanalyzedAt: Date.now(),
      mutualFilterEnabled,
      requiredMutualCount: minMutualCount,
    };
    if (gender === 'female') femaleCount += 1;
    else if (gender === 'male') maleCount += 1;
    else unknownCount += 1;

    const classificationUnavailable = result.source === 'ai-unavailable' ||
      result.source === 'no-provider';
    if (classificationUnavailable) {
      skippedCount += 1;
      next.followStatus = 'not-sent';
      next.followReason = `AI analizi yapılamadı — takip isteği gönderilmedi${
        result.classification_error ? ` (${result.classification_error})` : ''
      }`;
    } else if (gender === 'female') {
      const sourceId = String(next.sourceId || '').trim();
      const relation = next.relation === 'following' ? 'following' : 'followers';
      if (!sourceId) {
        skippedCount += 1;
        next.followReason = 'Kadın olarak sınıflandırıldı; kaynak hesap bilgisi bulunamadı';
      } else if (followStatuses[id]?.status === 'sent' || next.followStatus === 'sent') {
        next.followStatus = 'already-sent';
        next.followReason = 'Takip isteği daha önce gönderilmiş';
      } else {
        let mutualCount = next.mutualCount == null
          ? null
          : Number(next.mutualCount);
        if (
          mutualFilterEnabled &&
          !matchesDiscoveryMutualCount(mutualCount, minMutualCount)
        ) {
          try {
            mutualCount = Number((await fetchMutualFollowers(id)).count) || 0;
          } catch {
            mutualCount = 0;
          }
        }
        next.mutualCount = mutualCount;
        if (
          mutualFilterEnabled &&
          !matchesDiscoveryMutualCount(mutualCount, minMutualCount)
        ) {
          skippedCount += 1;
          next.followStatus = 'not-sent';
          next.followReason = `Kadın aday; ${mutualCount} ortak hesap bulundu (minimum ${minMutualCount} gerekli)`;
        } else {
          try {
            const followResult = await sendAutomaticDiscoveryFollow(next, sourceId, relation, 'female');
            if (followResult?.alreadySent) {
              next.followStatus = 'already-sent';
              next.followReason = 'Takip isteği daha önce gönderilmiş';
            } else if (followResult?.skipped) {
              skippedCount += 1;
              next.followStatus = 'skipped';
              next.followReason = 'Hesap zaten takip ediliyor veya bekleyen takip isteği var — yeni istek gönderilmedi';
            } else if (followResult?.ok) {
              sentCount += 1;
              next.followStatus = 'sent';
              next.followReason = 'Yeniden analiz sonrası kadın aday için takip isteği gönderildi';
            } else {
              skippedCount += 1;
              next.followStatus = 'not-sent';
              next.followReason = followResult?.reason === 'daily' || followResult?.reason === 'hourly'
                ? 'Takip isteği kotası dolu'
                : 'Takip isteği gönderilemedi';
            }
          } catch (error) {
            skippedCount += 1;
            next.followStatus = 'not-sent';
            next.followReason = String(error?.message || error).slice(0, 240);
          }
        }
      }
    } else if (gender === 'male') {
      next.followStatus = 'not-sent';
      next.followReason = 'Erkek aday; kadın hedef filtresinden geçmedi';
    } else {
      next.followStatus = 'not-sent';
      next.followReason = 'AI sonucu belirsiz — takip isteği gönderilmedi';
    }
    updates.set(id, next);
  }

  const mergeUsers = users => (Array.isArray(users) ? users : []).map(user => {
    const update = updates.get(discoveryUserId(user));
    return update ? { ...user, ...update } : user;
  });
  const storagePatch = {
    __discovery_auto_results: mergeUsers(autoResults),
  };
  if (manualData) {
    storagePatch.__discovery_manual_results_v1 = {
      ...manualData,
      users: mergeUsers(manualUsers),
      ts: Date.now(),
    };
  }
  if (cachedFollowing) {
    storagePatch.__cached_following = {
      ...cachedFollowing,
      users: mergeUsers(cachedUsers),
    };
  }
  if (Array.isArray(stored.__ai_gender_users_v1)) {
    storagePatch.__ai_gender_users_v1 = mergeUsers(legacyUsers);
  }
  await new Promise(resolve => chrome.storage.local.set(storagePatch, resolve));

  const currentGenderState = await getGenderState();
  await setGenderState({
    enabled: true,
    running: false,
    error: false,
    scanned: (Number(currentGenderState.scanned) || 0) + classified.length,
    female: (Number(currentGenderState.female) || 0) + femaleCount,
    male: (Number(currentGenderState.male) || 0) + maleCount,
    unknown: (Number(currentGenderState.unknown) || 0) + unknownCount,
    message: analyzeAllDashboardAccounts
      ? `${classified.length} Dashboard hesabı manuel analiz edildi`
      : `${classified.length} eski kayıt yeniden analiz edildi`,
  });
  const summary = {
    ok: true,
    total: batch.length,
    female: femaleCount,
    male: maleCount,
    unknown: unknownCount,
    sent: sentCount,
    skipped: skippedCount + Math.max(0, pendingRecords.length - batch.length),
    limited: Math.max(0, pendingRecords.length - batch.length),
  };
  await patchState({
    discoveryLastActionLabel: analyzeAllDashboardAccounts
      ? `${summary.total} Dashboard hesabı analiz edildi · ${summary.sent} kadın adaya istek gönderildi`
      : `${summary.total} eski kayıt analiz edildi · ${summary.sent} kadın adaya istek gönderildi`,
  });
  await appendDiscoveryLog(
    'info',
    analyzeAllDashboardAccounts
      ? 'Dashboard manuel cinsiyet analizi tamamlandı'
      : 'Dashboard Belirsiz kayıt analizi tamamlandı',
    {
    ...summary,
    action: 'kadın adaylarda ortak hesap ve takip güvenlik kontrolleri uygulandı',
    }
  );
  return summary;
}

async function storeVerifiedViewerUser(user) {
  const nextUserId = String(user?.pk ?? user?.fbid_v2 ?? user?.id ?? '').trim();
  if (!nextUserId) return false;
  const cookie = await new Promise(resolve =>
    chrome.cookies.get({ url: 'https://www.instagram.com', name: 'ds_user_id' }, resolve)
  );
  const sessionUserId = String(cookie?.value || '').trim();
  if (!sessionUserId || sessionUserId !== nextUserId) return false;

  const stored = await new Promise(resolve =>
    chrome.storage.local.get(['igUser'], resolve)
  );
  const previousUserId = String(
    stored?.igUser?.pk ?? stored?.igUser?.fbid_v2 ?? stored?.igUser?.id ?? '',
  ).trim();
  if (previousUserId && previousUserId !== nextUserId) {
    _followingCache = [];
    _followingCacheTs = 0;
    _followingCacheUserId = '';
    await new Promise(resolve =>
      chrome.storage.local.remove(['__cached_followers', '__cached_following'], resolve)
    );
  }
  await new Promise(resolve =>
    chrome.storage.local.set({ igUser: user, igUserTs: Date.now() }, resolve)
  );

  const panelUrl = chrome.runtime.getURL('panel.html');
  const tabs = await new Promise(resolve => chrome.tabs.query({}, resolve));
  for (const tab of tabs || []) {
    if (tab.url?.startsWith(panelUrl) && tab.id != null) {
      sendTabMessageSilently(tab.id, { type: 'IG_USER_UPDATED', user });
    }
  }
  return true;
}

function normalizeViewerProfileResponse(payload) {
  const user = payload?.data?.user
    ?? payload?.data?.user_info
    ?? payload?.user
    ?? payload?.user_info
    ?? payload;
  if (!user || typeof user !== 'object') return null;
  const pk = String(user.pk ?? user.id ?? user.fbid_v2 ?? '').trim();
  if (!pk) return null;
  return {
    ...user,
    pk,
    id: user.id != null ? String(user.id) : pk,
    username: String(user.username ?? '').trim(),
    follower_count: profileCount(
      user,
      ['follower_count'],
      ['followers_count'],
      ['edge_followed_by', 'count'],
      ['edge_followed_by_v2', 'count'],
    ),
    following_count: profileCount(
      user,
      ['following_count'],
      ['follows_count'],
      ['edge_follow', 'count'],
      ['edge_following', 'count'],
    ),
    media_count: profileCount(
      user,
      ['media_count'],
      ['posts_count'],
      ['edge_owner_to_timeline_media', 'count'],
      ['edge_owner_to_timeline_media_v2', 'count'],
    ),
  };
}

async function getViewerUsernameFromTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const excluded = new Set([
        'accounts', 'about', 'direct', 'directory', 'explore', 'reels',
        'stories', 'web', 'p', 'privacy', 'legal', 'settings',
      ]);
      const ranked = [...document.querySelectorAll('a[href]')]
        .map(anchor => {
          const path = anchor.getAttribute('href')?.match(/^\/([^/?#]+)\/?$/)?.[1] || '';
          if (!path || excluded.has(path.toLowerCase())) return null;
          const label = `${anchor.getAttribute('aria-label') || ''} ${anchor.getAttribute('title') || ''} ${anchor.getAttribute('data-testid') || ''}`;
          const alt = [...anchor.querySelectorAll('img[alt]')]
            .map(image => image.getAttribute('alt') || '').join(' ');
          let score = 1;
          if (/profile|profil/i.test(label)) score += 20;
          if (/profile|profil|avatar|picture|foto/i.test(alt)) score += 10;
          return { path, score };
        })
        .filter(Boolean)
        .sort((left, right) => right.score - left.score);
      return ranked[0]?.path || '';
    },
  });
  return String(results?.[0]?.result || '').trim();
}

async function getViewerProfileViaProfileTab(sourceTabId) {
  const username = await getViewerUsernameFromTab(sourceTabId);
  if (!username) throw new Error('Instagram profil sekmesi için kullanıcı adı bulunamadı');

  const profileTab = await new Promise((resolve, reject) => {
    chrome.tabs.create({
      url: `https://www.instagram.com/${encodeURIComponent(username)}/`,
      active: false,
    }, tab => {
      if (chrome.runtime.lastError || !tab?.id) {
        reject(new Error(chrome.runtime.lastError?.message || 'Profil sekmesi açılamadı'));
        return;
      }
      resolve(tab);
    });
  });

  try {
    await waitForInstagramTabComplete(profileTab.id, 35000);
    await waitForInstagramContentScript(profileTab.id, 12000);
    // The main-world bridge captures the profile operation at document_start;
    // allow Relay to finish its first request before reading the stored doc ID.
    await sleep(1800);

    let lastError = null;
    const sessionUserId = await getInstagramSessionUserId();
    // Prefer the profile payload Instagram already downloaded for this tab.
    // This is a local content-script lookup (no extra Instagram request) and
    // avoids rebuilding GraphQL variables when Instagram changes its schema.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const response = await sendInstagramMessage(
          profileTab.id,
          { type: 'IG_PROFILE_LOOKUP', username },
          5000,
        );
        const user = normalizeViewerProfileResponse(response?.user);
        const userId = String(user?.pk ?? user?.id ?? user?.fbid_v2 ?? '').trim();
        const hasCounts = [
          user?.follower_count,
          user?.following_count,
          user?.media_count,
        ].some(value => Number(value) > 0);
        if (userId && userId === String(sessionUserId) && hasCounts) return user;
      } catch (error) {
        lastError = error;
      }
      if (attempt < 7) await sleep(750);
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const user = await getUserViaGraphQL(profileTab.id);
        const hasCounts = [
          user?.follower_count,
          user?.following_count,
          user?.media_count,
        ].some(value => Number(value) > 0);
        if (user?.pk && hasCounts) return user;
        lastError = new Error('Profil sekmesi GraphQL yanıtı sayaç içermedi');
      } catch (error) {
        lastError = error;
      }
      await sleep(1000);
    }
    throw lastError || new Error('Profil sekmesi profil verisi döndürmedi');
  } finally {
    chrome.tabs.remove(profileTab.id, () => void chrome.runtime.lastError);
  }
}

// ── Mesaj dinleyicileri ───────────────────────────────────────────────
function isInstagramContentScriptSender(sender) {
  return sender?.id === chrome.runtime.id;
}

function dispatchExtensionMessage(msg, _sender, reply) {
  if (msg.type === 'LICENSED_INSTAGRAM_REQUEST') {
    if (!isInstagramContentScriptSender(_sender)) {
      reply({ ok: false, error: 'Instagram isteğinin kaynağı doğrulanamadı.' });
      return false;
    }
    instagramServerRequest(
      String(msg.endpoint || ''),
      msg.params || {},
      String(msg.method || 'GET').toUpperCase(),
      msg.body,
      msg.headers || {},
    )
      .then(data => reply({ ok: true, data }))
      .catch(error => reply({
        ok: false,
        error: error?.message || 'İstek için etkin lisans gerekli.',
        status: Number(error?.status) || null,
      }));
    return true;
  }

  if (msg.type === 'LICENSE_PUBLIC_CONFIG') {
    getLicensePublicConfig(msg.apiBaseUrl)
      .then(reply)
      .catch(error => reply({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (msg.type === 'LICENSE_GET_STATUS') {
    validateExtensionLicense(true)
      .then(status => reply({
        active: status.active,
        expired: Boolean(status.expired),
        trialExpired: Boolean(status.trialExpired),
        expiresAt: status.expiresAt ?? null,
        licenseType: status.licenseType || '',
        message: status.message || '',
      }))
      .catch(error => reply({ active: false, message: error?.message || String(error) }));
    return true;
  }
  if (msg.type === 'INSTAGRAM_SESSION_STATUS') {
    getInstagramSessionStatus()
      .then(reply)
      .catch(error => reply({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (msg.type === 'INSTAGRAM_SESSION_LINK') {
    linkInstagramSession()
      .then(reply)
      .catch(error => reply({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (msg.type === 'INSTAGRAM_SESSION_UNLINK') {
    unlinkInstagramSession()
      .then(reply)
      .catch(error => reply({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (msg.type === 'GENDER_CLASSIFY') {
    classifyGenderInBackground(msg.users, msg.options || {})
      .then(reply)
      .catch(error => reply({ ok: false, error: error?.message || String(error), results: [] }));
    return true;
  }
  if (msg.type === 'GENDER_REANALYZE_UNKNOWN') {
    reanalyzeUnknownGenderRecords()
      .then(reply)
      .catch(error => reply({
        ok: false,
        error: error?.message || String(error),
      }));
    return true;
  }
  if (msg.type === 'GENDER_ANALYZE_DASHBOARD') {
    reanalyzeUnknownGenderRecords({ all: true })
      .then(reply)
      .catch(error => reply({
        ok: false,
        error: error?.message || String(error),
      }));
    return true;
  }

  if (msg.type === 'IG_GRAPHQL_REQUEST_CAPTURED') {
    const payload = msg.payload && typeof msg.payload === 'object'
      ? msg.payload
      : {};
    const docId = String(payload.doc_id || '').trim();
    if (docId) {
      recordGraphQLDocId(
        docId,
        payload.friendly_name || payload.operation_name || '',
        payload.variables && typeof payload.variables === 'object'
          ? payload.variables
          : null,
        payload.is_profile === true,
      );
    }
    return false;
  }

  if (msg.type === 'IG_PROFILE_DATA') {
    const username = String(msg.username || '').replace(/^@/, '').trim();
    const key = username.toLowerCase();
    const user = msg.user;
    const normalizedUser = normalizeViewerProfileResponse(user);
    const id = String(normalizedUser?.pk ?? user?.pk ?? user?.id ?? user?.fbid_v2 ?? '').trim();
    const waiter = _profileLookupWaiters.get(key);
    if (key && id) {
      logProfileLoaded(user, username, 'profil verisi alındı');
      // A profile tab can contain the authenticated account's real totals even
      // when web_profile_info is rate-limited. Promote that payload to igUser
      // only when its identity matches ds_user_id and it has actual counts.
      const hasCounts = [
        normalizedUser?.follower_count,
        normalizedUser?.following_count,
        normalizedUser?.media_count,
      ].some(value => Number(value) > 0);
      if (hasCounts) {
        getInstagramSessionUserId()
          .then(sessionId => {
            if (String(sessionId) !== id) return;
            return storeVerifiedViewerUser(normalizedUser).then(stored => {
              if (stored) {
                return appendDebugLog('info', 'Profil sayfası verisi panel kullanıcısına aktarıldı', {
                  username,
                  userId: id,
                  followerCount: normalizedUser.follower_count,
                  followingCount: normalizedUser.following_count,
                  mediaCount: normalizedUser.media_count,
                });
              }
              return null;
            });
          })
          .catch(() => {});
      }
      // The page can publish the profile after the lookup timeout while it is
      // still finishing navigation. Keep that late result so the next
      // discovery tick can use it without navigating and fetching again.
      saveDiscoveryProfileCache(user, username).catch(() => {});
    }
    if (key && id && waiter && (!_sender?.tab?.id || _sender.tab.id === waiter.tabId)) {
      _profileLookupWaiters.delete(key);
      clearTimeout(waiter.timer);
      waiter.resolve({
        ...user,
        id,
        pk: id,
        username: String(user?.username || username).replace(/^@/, ''),
      });
    }
    return false;
  }

  if (msg.type === 'IG_DISCOVERY_SET') {
    const patch = {};
    const thresholdUpdated = 'minMutualCount' in msg || 'requireMutuals' in msg;
    if ('enabled' in msg) patch.discoveryEnabled = msg.enabled === true;
    if ('rotateSources' in msg) patch.discoveryRotateSources = msg.rotateSources === true;
    if ('sourceId' in msg) patch.discoverySourceId = String(msg.sourceId || '');
    if ('sourceUsername' in msg) patch.discoverySourceUsername = String(msg.sourceUsername || '').replace(/^@/, '');
    if ('relation' in msg) patch.discoveryRelation = msg.relation === 'followers' ? 'followers' : 'following';
    if ('minMutualCount' in msg) {
      patch.discoveryMinMutualCount = normalizeDiscoveryMinMutualCount(msg.minMutualCount);
    } else if ('requireMutuals' in msg) {
      // Compatibility with a settings card that has not been refreshed yet.
      patch.discoveryMinMutualCount = msg.requireMutuals === false ? 0 : 2;
    }
    if ('targetGender' in msg) {
      patch.discoveryTargetGender = ['female', 'male', 'both'].includes(msg.targetGender)
        ? msg.targetGender
        : 'female';
    }
    if (patch.discoveryEnabled === false) patch.discoveryNextRunAt = 0;
    _igRequestBlockReady.then(() => {
      if (patch.discoveryEnabled) {
        patch.discoveryNextRunAt = Math.max(
          Date.now(),
          _igRequestBlockedUntil,
          _igMutualFollowersBlockedUntil,
        );
      }
      return patchState(patch);
    }).then(async () => {
      if (patch.discoveryEnabled && msg.deferStart !== true) {
        // Takip isteği sistemi, beğeni sisteminden bağımsız çalışır.
        chrome.alarms.create(ALARM_DISCOVERY_START, { when: Date.now() + 1500 });
      } else if (patch.discoveryEnabled === false) {
        chrome.alarms.clear(ALARM_DISCOVERY_START);
      } else if (patch.discoveryEnabled === undefined && thresholdUpdated) {
        // Changing the filter must not pause an enabled follow queue. Keep its
        // current pacing/cooldowns and wake it at the next eligible run.
        const currentState = await getState();
        if (
          currentState.discoveryEnabled === true &&
          currentState.discoverySourceId &&
          !_discoveryInFlight
        ) {
          const continueAt = Math.max(
            Date.now() + 1500,
            Number(currentState.discoveryNextRunAt) || 0,
            _igRequestBlockedUntil,
            _igMutualFollowersBlockedUntil,
          );
          chrome.alarms.create(ALARM_DISCOVERY_START, { when: continueAt });
        }
      }
      if ('enabled' in msg) {
        appendDiscoveryLog('info', patch.discoveryEnabled ? 'Otomatik keşif açıldı' : 'Otomatik keşif kapatıldı', {
          sourceId: patch.discoverySourceId || '(değişmedi)',
          sourceUsername: patch.discoverySourceUsername || '(kullanıcı adı bilinmiyor)',
          relation: patch.discoveryRelation || '(değişmedi)',
          targetGender: patch.discoveryTargetGender || '(değişmedi)',
          nextRunInSeconds: patch.discoveryEnabled ? 7 : 0,
          action: patch.discoveryEnabled ? 'planlanan turda kaynak listesi taranacak' : 'yeni tarama yapılmayacak',
        }).catch(() => {});
      } else if (thresholdUpdated) {
        const requiredCount = patch.discoveryMinMutualCount;
        const currentState = await getState();
        const automaticContinuation = currentState.discoveryEnabled === true &&
          Boolean(currentState.discoverySourceId);
        appendDiscoveryLog('info', 'Minimum ortak hesap sayısı güncellendi', {
          scope: automaticContinuation ? 'automatic-discovery' : 'manual-discovery',
          requiredCount,
          discoveryEnabled: currentState.discoveryEnabled === true,
          nextRunAt: Number(currentState.discoveryNextRunAt) || 0,
          action: automaticContinuation
            ? 'Otomatik takip açık; mevcut bekleme ve güvenlik beklemeleri korunarak yeni minimum sayıyla devam edecek'
            : requiredCount > 0
              ? `Taramada ${requiredCount} veya daha fazla ortak hesabı olmayan adaylar elenecek`
              : 'Ortak hesap kontrolü atlanacak',
        }).catch(() => {});
      }
      if ('rotateSources' in msg) {
        appendDiscoveryLog(
          'info',
          patch.discoveryRotateSources
            ? 'Tamamlanan taramadan sonra rastgele kaynak geçişi açıldı'
            : 'Tamamlanan taramadan sonra rastgele kaynak geçişi kapatıldı',
          {
            rotateSources: patch.discoveryRotateSources,
            action: patch.discoveryRotateSources
              ? 'kaynak hesabın takipçileri bitince yeni takip edilen kaynak seçilecek'
              : 'mevcut kaynak tamamlanınca otomatik keşif duracak',
          },
        ).catch(() => {});
      }
      broadcastStatus();
      reply({ ok: true });
    });
    return true;
  }

  if (msg.type === 'IG_DISCOVERY_RESOLVE_PROFILE') {
    resolveDiscoveryProfile('', msg.username)
      .then(user => reply({ ok: true, data: user }))
      .catch(error => reply({ ok: false, error: error.message || String(error) }));
    return true;
  }

  // Manual discovery: fetch exactly the selected account's followers or
  // following list. When enabled in the panel, the same result is also handed
  // to the automatic AI-filtered follow queue.
  if (msg.type === 'IG_DISCOVERY_LIST') {
    (async () => {
      const sourceId = String(msg.sourceId || '').trim();
      const sourceUsername = String(msg.sourceUsername || '').replace(/^@/, '').trim();
      const relation = msg.relation === 'following' ? 'following' : 'followers';
      if (!sourceId) throw new Error('Kaynak hesap seçilmedi');
      if (!sourceUsername) throw new Error('Kaynak hesap kullanıcı adı gerekli');

      const result = await fetchDiscoveryRelationList(sourceId, relation);
      const scannedAt = Date.now();
      const state = await getState();
      const users = result.users.map(user => ({
        ...user,
        sourceId,
        sourceUsername,
        relation,
        discoveryRelation: relation,
        manual: true,
        automaticFollow: state.discoveryEnabled === true,
        targetGender: state.discoveryTargetGender,
        scannedAt,
      }));
      const data = {
        sourceId,
        sourceUsername,
        relation,
        targetGender: state.discoveryTargetGender,
        users,
        endpoint: result.endpoint,
        rawCount: result.rawCount,
        ts: scannedAt,
      };
      if (state.discoveryEnabled) {
        // The manual source selection is also the starting point for the
        // automatic queue. Avoid fetching the same list again on the first
        // scheduled tick and process one AI-filtered candidate per tick.
        const excludedIds = await getDiscoveryExcludedIds(sourceId, []);
        const safeCandidates = users.filter(user =>
          !excludedIds.has(discoveryUserId(user)) &&
          !hasExistingDiscoveryRelationship(user)
        );
        const queue = {
          sourceId,
          mode: 'direct',
          sourceRelation: 'direct',
          relation,
          targetRelation: relation,
          seedUsers: [],
          seedIndex: 0,
          plans: [],
          planIndex: 0,
          scannedRelations: {},
          candidates: safeCandidates,
          deliveryIndex: 0,
          directLoaded: true,
          createdAt: scannedAt,
        };
        await new Promise(resolve => chrome.storage.local.set({
          [DISCOVERY_QUEUE_KEY]: queue,
        }, resolve));
        await patchState({ discoveryNextRunAt: Date.now() + 1500 });
        chrome.alarms.create(ALARM_DISCOVERY_START, { when: Date.now() + 1500 });
      }
      await new Promise(resolve => chrome.storage.local.set({
        [DISCOVERY_MANUAL_RESULTS_KEY]: data,
      }, resolve));
      await appendDiscoveryLog('info', 'Manuel hesap listesi alındı', {
        sourceId,
        sourceUsername: `@${sourceUsername}`,
        relation,
        endpoint: result.endpoint,
        rawCount: result.rawCount,
        uniqueCount: users.length,
        action: state.discoveryEnabled
          ? `Liste otomatik keşif kuyruğuna alındı; AI filtresinden geçen ${state.discoveryTargetGender === 'male' ? 'erkek' : state.discoveryTargetGender === 'both' ? 'kadın ve erkek' : 'kadın'} adaylara takip isteği gönderilecek`
          : 'Yalnızca liste çekildi; otomatik takip isteği gönderilmedi',
      });
      reply({ ok: true, data });
    })().catch(error => reply({ ok: false, error: error.message || String(error) }));
    return true;
  }

  // Explicit user recovery for a stale local cooldown. This only removes the
  // extension's storage guard after it has expired. An active server cooldown
  // cannot be manually cleared to send requests sooner.
  if (msg.type === 'IG_RATE_LIMIT_RESET_LOCAL') {
    _igRequestBlockReady.then(async () => {
      const cleared = await clearLocalRateLimitCooldown();
      reply(cleared
        ? { ok: true }
        : {
            ok: false,
            error: _igMutualFollowersBlockedUntil > Date.now()
              ? makeMutualFollowersCooldownError().message
              : makeRateLimitCooldownError().message,
          });
    });
    return true;
  }

  // Keşif kuyruğu: her çağrıda tek aday döndürür.
  if (msg.type === 'IG_DISCOVERY_NEXT') {
    const KEY = DISCOVERY_QUEUE_KEY;
    const readQueue = () => new Promise(resolve => chrome.storage.local.get([KEY], x => resolve(x[KEY] || null)));
    const writeQueue = queue => new Promise(resolve => chrome.storage.local.set({ [KEY]: queue }, resolve));
    (async () => {
      let queue = await readQueue();
      const configuredState = await getState();
      const discoveryLimit = configuredState.discoveryMaxPerDay;
      const quotaBefore = await getDiscoveryQuota();
      const sourceId = String(msg.sourceId || '').trim();
      const sourceUsername = String(msg.sourceUsername || configuredState.discoverySourceUsername || '').replace(/^@/, '');
      const accountStorage = await new Promise(resolve => chrome.storage.local.get(['igUser'], resolve));
      const ownUserId = discoveryUserId(accountStorage.igUser);
      const isOwnNetwork = msg.explicitUsername !== true && !!ownUserId && ownUserId === sourceId;
      const mode = isOwnNetwork ? 'network' : 'direct';
      // A username means "that account's followers". With no username, use
      // random accounts from both of the logged-in user's lists and inspect
      // both relations of each selected account.
      const sourceRelation = isOwnNetwork ? 'following_and_followers' : 'direct';
      const configuredRelation = configuredState.discoveryRelation === 'following' ? 'following' : 'followers';
      const targetRelation = isOwnNetwork ? 'following_and_followers' : configuredRelation;
      if (!sourceId) throw new Error('Kaynak hesap seçilmedi');
      await appendDiscoveryLog('info', 'Manuel tarama istendi', {
        sourceId,
        sourceUsername: sourceUsername || '(kullanıcı adı bilinmiyor)',
        mode,
        sourceRelation,
        sourceRelationLabel: isOwnNetwork ? 'takip ettiklerin ve takipçilerin' : 'doğrudan takipçileri',
        targetRelation,
        targetRelationLabel: isOwnNetwork ? 'takip ve takipçileri' : 'takipçileri',
        flow: isOwnNetwork
          ? 'rastgele kendi takip ettiklerin/takipçilerin → onların takip ve takipçileri'
          : 'kullanıcı adı → doğrudan takipçileri',
        quotaUsed: quotaBefore.count,
        quotaRemaining: Math.max(0, discoveryLimit - quotaBefore.count),
      });
      if (!queue || queue.sourceId !== sourceId || queue.mode !== mode ||
          queue.targetRelation !== targetRelation || queue.sourceRelation !== sourceRelation) {
        queue = {
          sourceId, mode, sourceRelation, targetRelation,
          seedUsers: [], seedIndex: 0, scannedRelations: {},
          candidates: [], deliveryIndex: 0, directLoaded: false, createdAt: Date.now(),
        };
      }

      let excludedIds = new Set();
      // Adayı kuyruktan silmeden teslim imlecini ilerletir; böylece ilk aday
      // tekrar tekrar dönmez ve manuel durum saklamaya gerek kalmaz.
      const nextUnserved = () => {
        const start = Math.max(0, Number(queue.deliveryIndex) || 0);
        for (let i = start; i < queue.candidates.length; i++) {
          const user = queue.candidates[i];
          if (
            user &&
            !excludedIds.has(discoveryUserId(user)) &&
            !hasExistingDiscoveryRelationship(user)
          ) {
            return { user, index: i };
          }
          // Permanently advance past stale/already-connected candidates so
          // they cannot be returned again on the next alarm tick.
          if (user) queue.deliveryIndex = i + 1;
        }
        return null;
      };
      let selected = null;
      if (mode === 'direct') {
        // Do not turn a direct username search into a second-hop search.
        // The requested account's own followers are the candidates.
        excludedIds = await getDiscoveryExcludedIds(sourceId, []);
        if (!queue.directLoaded) {
          const sourceEndpoint = `/api/v1/friendships/${sourceId}/${targetRelation}/`;
          await appendDiscoveryLog('info', targetRelation === 'following'
            ? 'Kullanıcı adının takip ettikleri isteniyor'
            : 'Kullanıcı adının takipçileri isteniyor', {
            method: 'GET', endpoint: sourceEndpoint,
            target: sourceUsername ? `@${sourceUsername}` : sourceId, relation: targetRelation, limit: 50,
          });
          const result = await fetchDiscoveryRelationList(sourceId, targetRelation);
          queue.candidates = result.users.filter(user =>
            !excludedIds.has(discoveryUserId(user)) &&
            !hasExistingDiscoveryRelationship(user)
          );
          queue.directLoaded = true;
          await appendDiscoveryLog('info', targetRelation === 'following'
            ? 'Kullanıcı adının takip ettikleri alındı'
            : 'Kullanıcı adının takipçileri alındı', {
            endpoint: result.endpoint, rawCount: result.rawCount,
            uniqueCount: result.users.length, candidateCount: queue.candidates.length,
            excludedReason: 'kendi doğrudan bağlantıların ve daha önce istek gönderilenler atlandı',
          });
        }
        selected = nextUnserved();
      } else {
        // The own-account flow starts from both lists, then randomly visits
        // both relations of each random seed account.
        if (!queue.scannedRelations) queue.scannedRelations = {};
        if (!queue.seedUsers.length) {
          const sourceLists = [];
          for (const relation of ['following', 'followers']) {
            const result = await fetchDiscoveryRelationList(sourceId, relation);
            sourceLists.push(...result.users);
            await appendDiscoveryLog('info', 'Kendi kaynak listesi alındı', {
              endpoint: result.endpoint, relation, rawCount: result.rawCount,
              uniqueCount: result.users.length,
            });
          }
          queue.seedUsers = shuffleDiscoveryUsers(uniqueDiscoveryUsers(sourceLists));
          queue.seedIndex = 0;
          excludedIds = await getDiscoveryExcludedIds(sourceId, queue.seedUsers);
          await appendDiscoveryLog('info', 'Rastgele kaynak hesaplar hazırlandı', {
            sourceCount: queue.seedUsers.length,
            excludedCount: excludedIds.size,
            nextStep: 'kaynak hesapların takip ve takipçi listeleri taranacak',
          });
        } else {
          excludedIds = await getDiscoveryExcludedIds(sourceId, queue.seedUsers);
        }

        selected = nextUnserved();
        while (!selected && queue.seedIndex < queue.seedUsers.length) {
          const seed = queue.seedUsers[queue.seedIndex++];
          const relations = shuffleDiscoveryUsers([
            { relation: 'following' },
            { relation: 'followers' },
          ]);
          for (const plan of relations) {
            const relationKey = `${seed.id}:${plan.relation}`;
            if (queue.scannedRelations[relationKey]) continue;
            queue.scannedRelations[relationKey] = true;
            await appendDiscoveryLog('info', 'Rastgele kaynak hesabın listesi isteniyor', {
              method: 'GET',
              endpoint: `/api/v1/friendships/${seed.id}/${plan.relation}/`,
              sourceAccount: `@${seed.username}`, sourceAccountId: seed.id,
              relation: plan.relation, limit: 50,
              sourceProgress: `${queue.seedIndex}/${queue.seedUsers.length}`,
            });
            try {
              const result = await fetchDiscoveryRelationList(seed.id, plan.relation);
              const beforeCandidateCount = queue.candidates.length;
              const normalizedTargets = result.users;
              queue.candidates = uniqueDiscoveryUsers([...queue.candidates, ...normalizedTargets])
                .filter(user =>
                  !excludedIds.has(discoveryUserId(user)) &&
                  !hasExistingDiscoveryRelationship(user)
                );
              await appendDiscoveryLog('info', 'Rastgele kaynak hesabın listesi alındı', {
                endpoint: result.endpoint, sourceAccount: `@${seed.username}`,
                relation: plan.relation, rawCount: result.rawCount,
                uniqueCount: normalizedTargets.length,
                excludedFromThisList: normalizedTargets.filter(user => excludedIds.has(discoveryUserId(user))).length,
                newCandidateCount: Math.max(0, queue.candidates.length - beforeCandidateCount),
                totalCandidateCount: queue.candidates.length,
                excludedReason: 'kendi doğrudan bağlantıların ve daha önce istek gönderilenler atlandı',
              });
            } catch (error) {
              await appendDiscoveryLog('warn', `@${seed?.username || seed?.id} ${plan.relation} listesi alınamadı`, {
                sourceAccountId: seed?.id || '', relation: plan.relation, error: error.message,
              });
            }
            selected = nextUnserved();
            if (selected) break;
          }
        }
        if (!selected) selected = nextUnserved();
      }
      const candidate = selected?.user || null;
      const candidatePayload = candidate ? {
        ...candidate,
        sourceId,
        relation: candidate.discoveryRelation === 'following'
          ? 'following'
          : (targetRelation === 'following' ? 'following' : 'followers'),
        sourceRelation,
        targetRelation,
        discoveryVersion: 4,
      } : null;
      if (selected) queue.deliveryIndex = selected.index + 1;
      const quota = quotaBefore;
      await writeQueue(queue);
      await appendDiscoveryLog('info', candidate ? 'Aday bulundu ve gösteriliyor' : 'Uygun aday bulunamadı', {
        candidate: candidate ? `@${candidate.username}` : '',
        candidateId: candidate?.id || '',
        mode,
        sourceRelation,
        targetRelation,
        pending: Math.max(0, queue.candidates.length - queue.deliveryIndex),
        scannedSources: queue.seedIndex,
        totalSources: queue.seedUsers.length,
        action: candidate ? 'takip isteği henüz gönderilmedi; karar kullanıcıda' : 'takip isteği gönderilmedi',
      });
      reply({
        ok: true,
        candidate: candidatePayload,
        pending: Math.max(0, queue.candidates.length - queue.deliveryIndex),
        scannedSources: queue.seedIndex,
        exhausted: !candidate && queue.seedIndex >= queue.seedUsers.length,
        dailyLimit: discoveryLimit,
        dailyUsed: quota.count,
        dailyRemaining: Math.max(0, discoveryLimit - quota.count),
        sourceRelation,
        targetRelation,
      });
    })().catch(error => reply({ ok: false, error: error.message || String(error) }));
    return true;
  }

  // Keşif adayını takip et; günlük kota yalnızca başarılı takip isteği
  // denemelerinde tüketilir, aday taramalarında tüketilmez.
  if (msg.type === 'IG_DISCOVERY_FOLLOW') {
    (async () => {
      const id = String(msg.id || '').trim();
      const username = String(msg.username || '').replace(/^@/, '').trim();
      await appendDiscoveryLog('info', 'Takip isteği işlemi başladı', {
        phase: 'discovery-follow',
        candidate: username ? `@${username}` : id,
        candidateId: id,
        sourceId: String(msg.sourceId || ''),
        relation: msg.relation === 'following' ? 'following' : 'followers',
        action: 'önce tekrar güvenlik kontrolü yapılacak',
      });
      if (!id) throw new Error('Takip edilecek hesap kimliği bulunamadı');
      const statusKey = '__discovery_follow_status_v1';
      const stored = await new Promise(resolve =>
        chrome.storage.local.get([statusKey], x => resolve(x[statusKey] || {})));
      if (stored[id]?.status === 'sent') {
        await appendDiscoveryLog('info', 'Takip isteği daha önce gönderilmiş', {
          phase: 'discovery-follow',
          candidate: username ? `@${username}` : id,
          candidateId: id,
          action: 'Instagram isteği gönderilmedi',
        });
        reply({ ok: true, alreadySent: true, status: stored[id] });
        return;
      }
      if (hasExistingDiscoveryRelationship(msg)) {
        await appendDiscoveryLog('warn', 'Aday zaten takip ediliyor veya bekleyen istek var', {
          phase: 'discovery-follow-guard',
          candidate: username ? `@${username}` : id,
          candidateId: id,
          action: 'Instagram takip isteği gönderilmedi',
        });
        reply({
          ok: true,
          skipped: true,
          reason: 'already-following-or-requested',
          error: 'Bu hesap zaten takip ediliyor veya takip isteği zaten gönderilmiş',
        });
        return;
      }
      // Re-check the relationship before sending. This protects against a
      // stale card or a race with a refreshed source list.
      const sourceId = String(msg.sourceId || '').trim();
      const relation = msg.relation === 'following' ? 'following' : 'followers';
      if (sourceId) {
        const queueState = await new Promise(resolve =>
          chrome.storage.local.get([DISCOVERY_QUEUE_KEY], x => resolve(x[DISCOVERY_QUEUE_KEY] || null)));
        if (
          queueState?.sourceId === sourceId &&
          (queueState?.relation === relation || queueState?.targetRelation === relation)
        ) {
          const excludedIds = await getDiscoveryExcludedIds(sourceId, queueState.seedUsers);
          if (excludedIds.has(id)) {
            await appendDiscoveryLog('warn', 'Aday güvenlik kontrolünde elendi', {
              phase: 'discovery-follow',
              candidate: username ? `@${username}` : id,
              candidateId: id,
              reason: 'hesap kaynak hesabın doğrudan listesinde veya mevcut bağlantılar arasında',
              action: 'Instagram takip isteği gönderilmedi',
            });
            throw new Error('Bu hesap zaten kaynak hesabın listesinde; takip isteği gönderilmedi');
          }
        }
      }
      const liveRelationship = await getLiveDiscoveryRelationship(id);
      if (!liveRelationship.ok) {
        reply({
          ok: false,
          skipped: true,
          reason: 'relationship-check-failed',
          error: 'Adayın mevcut takip durumu doğrulanamadı; takip isteği gönderilmedi',
        });
        return;
      }
      if (liveRelationship.following || liveRelationship.outgoingRequest) {
        await appendDiscoveryLog('warn', 'Aday canlı kontrolde zaten bağlı', {
          phase: 'discovery-follow-guard',
          candidate: username ? `@${username}` : id,
          candidateId: id,
          following: liveRelationship.following,
          outgoingRequest: liveRelationship.outgoingRequest,
          action: 'Instagram takip isteği gönderilmedi',
        });
        reply({
          ok: true,
          skipped: true,
          reason: 'already-following-or-requested',
          error: 'Bu hesap zaten takip ediliyor veya takip isteği zaten gönderilmiş',
        });
        return;
      }
      const quota = await consumeDiscoveryQuota();
      if (!quota.allowed) {
        await appendDiscoveryLog('warn', 'Takip isteği kotası dolu', {
          phase: 'discovery-follow',
          candidate: username ? `@${username}` : id,
          candidateId: id,
          reason: quota.reason,
          dailyUsed: quota.count,
          dailyLimit: quota.dailyLimit,
          action: 'Instagram takip isteği gönderilmedi',
        });
        reply({ ok: false, reason: quota.reason, error: `Takip isteği limiti doldu (${quota.dailyLimit}/gün).`, dailyLimit: quota.dailyLimit, dailyUsed: quota.count });
        return;
      }
      await appendDiscoveryLog('info', 'Instagram takip isteği gönderiliyor', {
        phase: 'discovery-follow',
        method: 'POST',
        endpoint: `/api/v1/friendships/create/${id}/`,
        candidate: username ? `@${username}` : id,
        candidateId: id,
        quotaBeforeSend: quota.count - 1,
      });
      const response = await sendDiscoveryFollowPostWithVerifiedRetry(
        id,
        username,
        {
          container_module: 'profile',
          include_follow_friction_check: 'true',
          nav_chain: 'PolarisFeedRoot:feedPage:1:via_cold_start,PolarisStoriesV3Root:StoriesPage:2:reel_feed_timeline,PolarisProfilePostsTabRoot:profilePage:3:unexpected',
          user_id: id,
        },
        'manual-discovery-follow',
      );
      const friendshipStatus = response?.friendship_status;
      if (
        response?.status !== 'ok' ||
        !friendshipStatus ||
        (friendshipStatus.outgoing_request !== true && friendshipStatus.following !== true)
      ) {
        throw new Error('Instagram takip isteğini onaylamadı');
      }
      const nextStatus = { status: 'sent', ts: Date.now(), username };
      await new Promise(resolve => chrome.storage.local.set({
        [statusKey]: { ...stored, [id]: nextStatus },
      }, resolve));
      await patchState({
        discoveryTodayCount: quota.count,
        discoveryLastActionLabel: `Takip isteği gönderildi: @${username || id}`,
      });
      await appendDiscoveryLog('info', `Takip isteği gönderildi: @${username || id}`, {
        phase: 'discovery-follow',
        candidateId: id,
        dailyUsed: quota.count,
        dailyRemaining: quota.dailyRemaining,
        action: 'Instagram POST isteği başarılı; durum kaydedildi',
      });
      reply({ ok: true, status: nextStatus, dailyLimit: quota.dailyLimit, dailyUsed: quota.count, dailyRemaining: quota.dailyRemaining });
    })().catch(async error => {
      const failedId = String(msg.id || '').trim();
      const failedUsername = String(msg.username || '').replace(/^@/, '').trim();
      const errorDetails = error.message || String(error);
      await appendDiscoveryLog('error', `Takip isteği sırasında hata oluştu: ${errorDetails}`, {
        phase: 'discovery-follow',
        candidate: failedUsername ? `@${failedUsername}` : failedId,
        candidateId: failedId,
        errorDetails,
        action: 'Instagram takip isteğinin uygulanıp uygulanmadığı kontrol edilmeli',
      });
      reply({ ok: false, error: errorDetails });
    });
    return true;
  }

  if (msg.type === 'IG_USER_DATA') {
    // The message may describe the profile currently open in Instagram, so
    // store it only after matching its ID against the authenticated cookie.
    storeVerifiedViewerUser(msg.user).catch(() => {});
    return false;
  }

  // Panel "sayılar 0 — yenile" dediğinde içerik-script'e tarama tetikleyip
  // güncel kullanıcı verisini zorla çekmesini istiyoruz. Tüm IG sekmelerinde.
  if (msg.type === 'REFRESH_USER_DATA') {
    if (_refreshUserDataInFlight) {
      reply({ ok: true, queued: true, message: 'Profil yenilemesi zaten devam ediyor' });
      return false;
    }
    _refreshUserDataInFlight = (async () => {
      const tabs = await queryInstagramTabs();
      let published = false;
      for (const tab of tabs) {
        if (tab.id == null) continue;
        // This reader uses the live Instagram page context and the captured
        // GraphQL operation, avoiding the REST endpoint that returns 429.
        try {
          const user = await getUserViaGraphQL(tab.id);
          if (user?.pk && await storeVerifiedViewerUser(user)) {
            published = true;
            break;
          }
          await appendDebugLog('warn', 'Profil GraphQL yanıtı doğrulanamadı', {
            tabId: tab.id,
            hasUser: !!user?.pk,
            userId: String(user?.pk ?? user?.id ?? ''),
          });
        } catch (error) {
          await appendDebugLog('warn', 'Profil GraphQL yenilemesi başarısız', {
            tabId: tab.id,
            error: String(error?.message ?? error).slice(0, 300),
          });
        }
        // Do not retry current_user/web_profile_info here. Instagram returns
        // useragent mismatch/429 for these extension-originated REST calls
        // even while the page's own GraphQL response is valid. The next
        // fallback opens a profile tab and uses the browser's real GraphQL
        // request instead.
        if (!published) {
          try {
            const user = await getViewerProfileViaProfileTab(tab.id);
            if (await storeVerifiedViewerUser(user)) {
              published = true;
              await appendDebugLog('info', 'Profil sekmesi GraphQL fallback başarılı', {
                tabId: tab.id,
                userId: String(user.pk),
                username: user.username,
                followerCount: user.follower_count,
                followingCount: user.following_count,
                mediaCount: user.media_count,
              });
              break;
            }
          } catch (error) {
            await appendDebugLog('warn', 'Profil sekmesi GraphQL fallback başarısız', {
              tabId: tab.id,
              error: String(error?.message ?? error).slice(0, 300),
            });
          }
        }
      }
      // Keep the content-script fallback for pages where GraphQL has not yet
      // exposed its profile operation.
      if (!published) {
        await appendDebugLog('info', 'Profil içerik betiği fallback yenilemesi başlatıldı', {
          tabCount: tabs.length,
        });
        for (const tab of tabs) {
          if (tab.id == null) continue;
          try {
            const response = await sendInstagramMessage(
              tab.id,
              { type: 'REFRESH_USER_DATA' },
              30000,
            );
            await appendDebugLog('info', 'Profil içerik betiği fallback sonucu', {
              tabId: tab.id,
              ok: !!response?.ok,
              hasCounts: !!response?.hasCounts,
              userId: String(response?.userId || ''),
              error: response?.error || (
                response?.ok
                  ? ''
                  : 'İçerik betiği profil verisi döndürmedi'
              ),
            });
          } catch (error) {
            const missingContentScript =
              /Receiving end does not exist|Could not establish connection|content script/i
                .test(String(error?.message ?? error));
            if (missingContentScript) {
              try {
                // An extension reload does not inject manifest content scripts
                // into already-open Instagram tabs. Inject the isolated-world
                // reader on demand, then retry the same refresh message.
                await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  files: ['content-script.js'],
                });
                await sleep(250);
                const response = await sendInstagramMessage(
                  tab.id,
                  { type: 'REFRESH_USER_DATA' },
                  30000,
                );
                await appendDebugLog('info', 'Profil içerik betiği otomatik enjekte edildi', {
                  tabId: tab.id,
                  ok: !!response?.ok,
                  hasCounts: !!response?.hasCounts,
                  userId: String(response?.userId || ''),
                  error: response?.error || (
                    response?.ok
                      ? ''
                      : 'İçerik betiği profil verisi döndürmedi'
                  ),
                });
                continue;
              } catch (injectionError) {
                error = injectionError;
              }
            }
            await appendDebugLog('warn', 'Profil içerik betiği fallback başarısız', {
              tabId: tab.id,
              error: String(error?.message ?? error).slice(0, 300),
            });
          }
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        _refreshUserDataInFlight = null;
      });
    reply({ ok: true });
    return false;
  }

  if (msg.type === 'IG_GQL_MUTATION') {
    requireActiveLicense()
      .then(() => runGraphQLMutation(msg.docId, msg.variables, msg.friendlyName))
      .then(data => reply({ ok: true, data }))
      .catch(e => {
        appendDebugLog('error', e.message || e, {
          operation: msg.friendlyName, docId: msg.docId, variables: msg.variables,
        }).catch(() => {});
        reply({ ok: false, error: e.message });
      });
    return true;
  }

  if (msg.type === 'DOM_LIKE_STORY') {
    reply({
      ok: false,
      error: 'Doğrudan sayfa tıklaması kapalı; hikâye beğenisi lisanslı Instagram API isteğiyle yapılmalıdır.',
    });
    return false;
  }

  if (msg.type === 'IG_AUTO_GET') {
    getState().then(s => reply(s));
    return true;
  }

  if (msg.type === 'GENDER_GET') {
    getGenderState().then(reply);
    return true;
  }

  if (msg.type === 'IG_SESSION_PROBE') {
    if (_sessionProbeInFlight) {
      reply({ ok: false, reason: 'probe-in-flight', message: 'Oturum kontrolü zaten devam ediyor' });
      return false;
    }
    _sessionProbeInFlight = true;
    chrome.storage.local.get([IG_SESSION_PROBE_KEY], stored => {
      const lastProbeAt = Number(stored?.[IG_SESSION_PROBE_KEY]) || 0;
      const elapsed = Date.now() - lastProbeAt;
      if (elapsed < IG_SESSION_PROBE_MIN_GAP_MS) {
        _sessionProbeInFlight = false;
        reply({
          ok: false,
          reason: 'probe-cooldown',
          message: `Oturum kontrolü için ${Math.ceil((IG_SESSION_PROBE_MIN_GAP_MS - elapsed) / 1000)} sn bekleyin`,
        });
        return;
      }
      chrome.storage.local.set({ [IG_SESSION_PROBE_KEY]: Date.now() }, () => {
        void chrome.runtime.lastError;
        withInstagramRequestSlot(
          'session-probe',
          () => probeSession().then(result => {
            patchState({
              sessionValid: result.valid,
              sessionReason: result.reason,
              sessionUsername: result.username,
              sessionUserId: result.userId,
              sessionCheckedAt: result.checkedAt,
            }).catch(() => {});
            broadcastStatus();
            reply({ ok: true, ...result });
          }),
        ).catch(error => {
          reply({ ok: false, error: error.message || String(error) });
        }).finally(() => { _sessionProbeInFlight = false; });
      });
    });
    return true;
  }

  async function runSessionProbe(reply) {
    // Canlı oturum probe'u — SADECE açık bir instagram.com sekmesi varsa
    // o sekmenin içinden çalışır. Çerezler orada otomatik, istek normal
    // sayfa içi XHR gibi görünür → Instagram rate-limit/reCAPTCHA tetiklemez.
    // Yoksa kendi başına fetch atmaz, kullanıcının sekme açmasını ister.
    await new Promise(resolve => queryInstagramTabs().then((tabs) => {
      const usable = chooseInstagramTab(tabs);
      if (!usable?.id) {
        reply({
          ok: false,
          reason: 'no-ig-tab',
          message: 'instagram.com sekmesini aç ve tekrar dene — uzantı bu sekmenin içinden doğrulama yapacak',
          sessionCheckedAt: Date.now(),
        });
        patchState({
          sessionReason: 'IG sekmesi açık değil — instagram.com sekmesi aç',
          sessionCheckedAt: Date.now(),
        }).catch(() => {});
        broadcastStatus();
        resolve();
        return;
      }
      // IG sekmesinin içinden gerçek bir fetch — cookie'ler otomatik
      chrome.scripting.executeScript({
        target: { tabId: usable.id },
        func: async () => {
          const result = await chrome.runtime.sendMessage({
            type: 'LICENSED_INSTAGRAM_REQUEST',
            endpoint: '/api/v1/accounts/current_user/',
            params: { edit: 'true' },
            method: 'GET',
          });
          if (!result?.ok) {
            return {
              ok: true,
              status: Number(result?.status) || 403,
              ct: 'application/json',
              redirected: false,
              url: 'https://www.instagram.com/api/v1/accounts/current_user/',
              body: JSON.stringify({ message: result?.error || 'login_required' }).slice(0, 800),
            };
          }
          return {
            ok: true,
            status: 200,
            ct: 'application/json',
            redirected: false,
            url: 'https://www.instagram.com/api/v1/accounts/current_user/',
            body: JSON.stringify(result.data || {}).slice(0, 800),
          };
        },
      }).then(results => {
        const r = results?.[0]?.result;
        if (!r?.ok) throw new Error(r?.error || 'sekme içi probe başarısız');
        const lower = (r.body || '').toLowerCase();
        const probeRateLimited = r.status === 429 || lower.includes('feedback_required');
        if (probeRateLimited) {
          appendDebugLog('warn', 'Oturum kontrolü 429 döndürdü; otomasyon kilitlenmedi', {
            action: 'profil kontrolü başarısız oldu, diğer istekler devam edebilir',
          }).catch(() => {});
        }
        // Content-type html TEK BAŞINA yeterli değil — Instagram anti-bot olarak
        // JSON endpoint'e HTML dönebiliyor. Gerçek login yönlendirmesi için
        // body'de login/logout spesifik anahtar kelimeler de olmalı.
        const isRealLoginRedirect = lower.includes('/accounts/login')
          || lower.includes('login_required')
          || r.status === 401
          || r.status === 403;
        const looksLogin = isRealLoginRedirect;
        let valid = false, username = '', userId = '', reason = '';
        if (!looksLogin) {
          try {
            const j = JSON.parse(r.body);
            const u = j?.user ?? j?.data?.user;
            if (u?.username || u?.pk) {
              valid = true;
              username = u.username || '';
              userId = String(u.pk || '');
              reason = 'oturum geçerli (IG sekmesi yoluyla)';
            } else if (j?.status === 'fail' || j?.require_login || j?.message === 'login_required') {
              reason = 'API login_required döndü';
            } else {
              reason = 'tanımsız JSON — user alanı yok';
            }
          } catch {
            if (r.redirected && r.status >= 300 && r.status < 400) {
              reason = 'IG sekmesi login\'e yönlendirdi';
            } else {
              reason = 'JSON parse hatası';
            }
          }
        } else {
          if (r.status === 429) reason = 'rate-limit (429) — yavaşlat';
          else if (r.status === 401 || r.status === 403) reason = `HTTP ${r.status} reddedildi`;
          else reason = 'IG sekmesi login sayfası yükledi';
        }
        patchState({
          sessionValid: valid,
          sessionReason: reason,
          sessionUsername: username,
          sessionUserId: userId,
          sessionCheckedAt: Date.now(),
        }).catch(() => {});
        if (valid && username) {
          chrome.storage.local.get(['igUser'], ({ igUser }) => {
            const merged = { ...(igUser ?? {}), username, pk: userId || igUser?.pk };
            chrome.storage.local.set({ igUser: merged, igUserTs: Date.now() });
          });
        } else if (!valid && (isRealLoginRedirect || probeRateLimited)) {
          // Gerçek login yönlendirmesi → otomasyonu duraklat
          patchState({
            backoffUntil: Date.now() + (probeRateLimited ? 30 : 60) * 60000,
            enabled: false,
            lastActionLabel: probeRateLimited
              ? 'Instagram istek sınırı uyguladı — otomasyon 30 dk duraklatıldı'
              : 'Oturum geçersizleşti — instagram.com\'a tarayıcıdan giriş yap ve otomasyonu tekrar aç',
          }).catch(() => {});
        }
        // valid=false ama isRealLoginRedirect=false → geçici API sorunu, extension'ı kapatma
        broadcastStatus();
        hasInstagramSessionCookie().then(sessionidPresent => reply({
          ok: true,
          valid,
          reason,
          httpStatus: r.status,
          username,
          userId,
          sessionidPresent,
          probePath: 'ig-tab',
          tabUrl: r.url,
          checkedAt: Date.now(),
        }));
      }).catch(e => reply({ ok: false, error: e.message || String(e) }))
        .finally(resolve);
    }).catch(error => {
      reply({ ok: false, error: error.message || String(error) });
      resolve();
    }));
  }

  if (msg.type === 'IG_AUTO_SET') {
    const allowed = ['enabled', 'timeFrom', 'timeTo', 'minDelaySec', 'maxDelaySec', 'maxPerDay', 'maxPerHour', 'targetType', 'batchSize', 'batchPauseSec', 'enabledContentTypes', 'discoveryEnabled', 'discoveryMaxPerDay', 'discoveryMaxPerHour', 'discoverySourceId', 'discoverySourceUsername', 'discoveryRelation', 'discoveryTargetGender', 'discoveryNextRunAt'];
    const patch = {};
    for (const key of allowed) {
      if (key in msg.patch) patch[key] = msg.patch[key];
    }
    const enableAfterSessionCheck = patch.enabled === true
      ? hasInstagramSessionCookie()
      : Promise.resolve(true);
    enableAfterSessionCheck.then(async sessionPresent => {
      await _igRequestBlockReady;
      if (patch.enabled === true && !sessionPresent) {
        patch.enabled = false;
        patch.backoffUntil = Date.now() + 30 * 60000;
        patch.lastActionLabel = "sessionid çerezi yok — önce instagram.com'a giriş yapın";
      } else if (patch.enabled === true) {
        const requestedMinDelay = Math.max(
          65,
          Math.min(3600, Number(patch.minDelaySec) || DEFAULT_STATE.minDelaySec),
        );
        // The periodic alarm runs once per minute. Waiting for that alarm on
        // the first start creates a race with Instagram's page/bootstrap data:
        // the first scan can observe an empty response and the user only sees
        // a successful like after reopening the panel. Start one controlled
        // scan shortly after enabling; subsequent likes still use the normal
        // configured delay and request queue.
        patch.nextRunAt = Math.max(Date.now() + 7000, _igRequestBlockedUntil);
        patch.backoffUntil = Math.max(0, _igRequestBlockedUntil);
        if (_igRequestBlockedUntil > Date.now()) {
          patch.lastActionLabel = makeRateLimitCooldownError().message;
        }
      } else if (patch.enabled === false) {
        // Manuel kapatma, devam eden turun sonraki beğeni isteğini de keser
        // ve eski hata metninin "çalışıyor" gibi görünmesini engeller.
        patch.backoffUntil = 0;
        patch.lastActionLabel = 'Beğeni sistemi kapalı';
      }
      if (patch.discoveryEnabled === true) {
        patch.discoveryNextRunAt = Math.max(
          Date.now(),
          _igRequestBlockedUntil,
          _igMutualFollowersBlockedUntil,
        );
      } else if (patch.discoveryEnabled === false) {
        patch.discoveryNextRunAt = 0;
      }
      return patchState(patch);
    }).then(async () => {
      if (patch.discoveryEnabled === false) {
        chrome.alarms.clear(ALARM_DISCOVERY_START);
      }
      if (patch.enabled === true) {
        // A one-shot alarm is more reliable than a service-worker setTimeout
        // and lets the Instagram tab finish its initial page work first.
        chrome.alarms.create(ALARM_AUTOLIKE_START, { when: Date.now() + 7000 });
      }
      if (patch.discoveryEnabled === true) {
        const state = await getState();
        if (state.discoveryEnabled && state.discoverySourceId) {
          chrome.alarms.create(ALARM_DISCOVERY_START, { when: Date.now() + 1500 });
        }
      }
      broadcastStatus();
      reply({ ok: true });
      // The one-shot start alarm performs the first scan. The recurring alarm
      // remains the fallback for later runs and for a worker restart.
    });
    return true;
  }

  if (msg.type === 'IG_AUTO_CLEAR_CACHE') {
    _followingCache   = [];
    _followingCacheTs = 0;
    _followingCacheUserId = '';
    _followingCacheComplete = false;
    reply({ ok: true });
    return false;
  }

  if (msg.type === 'IG_FOLLOW_LIST') {
    // Instagram sayfasının kendi isteğinden yakalanan liste yalnızca destekleyici
    // bir önbellektir. Panelin sayfalama cursor'ını asla bununla değiştirme:
    // aksi halde ilk sayfa tekrar tekrar dönüyor ve "Daha Fazla Yükle" kilitleniyor.
    try {
      const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
      if (payload?.kind && Array.isArray(payload.users) && payload.users.length > 0) {
        const key = payload.kind === 'followers' ? '__cached_followers' : '__cached_following';
        chrome.storage.local.get([key, 'igUser'], existing => {
          if (!isCurrentUsersFollowList(payload, existing.igUser)) return;
          const currentUserId = String(
            existing.igUser?.pk ?? existing.igUser?.fbid_v2 ?? existing.igUser?.id ?? '',
          );
          const prev = existing[key]?.scope === 'current-user' &&
            existing[key]?.userId === currentUserId
            ? existing[key]
            : { users: [], next_max_id: null, ts: 0 };
          const merged = [...(Array.isArray(prev.users) ? prev.users : [])];
          const seen = new Set(merged.map(u => String(u?.pk ?? u?.id ?? '')));
          for (const u of payload.users) {
            const id = String(u?.pk ?? u?.id ?? '');
            if (id && !seen.has(id)) { merged.push(u); seen.add(id); }
          }
          chrome.storage.local.set({
            [key]: {
              users: merged,
              userId: currentUserId,
              scope: 'current-user',
              // Do not overwrite an API pagination cursor with an unsolicited
              // page response from Instagram's UI.
              next_max_id: prev.next_max_id ?? null,
              ts: Date.now(),
            },
          });
        });
      }
    } catch {}
    return false;
  }

  if (msg.type === 'IG_API') {
    const endpoint = String(msg.endpoint ?? '');
    const isFollowList = endpoint.includes('/friendships/') &&
      (endpoint.includes('/followers') || endpoint.includes('/following'));

    if (isFollowList) {
      const kind = endpoint.includes('/followers') ? 'followers' : 'following';
      const cacheKey = kind === 'followers' ? '__cached_followers' : '__cached_following';
      const endpointOwnerId = endpoint.match(
        /\/friendships\/(\d+)\/(?:followers|following)\/?/i,
      )?.[1] ?? '';

      (async () => {
        // 1. Cache'te veri varsa ve ilk sayfa isteniyorsa cache'ten döndür
        const stored = await new Promise(resolve =>
          chrome.storage.local.get([cacheKey, 'igUser'], resolve)
        );
        const cached = stored[cacheKey];
        const currentUserId = String(
          stored.igUser?.pk ?? stored.igUser?.fbid_v2 ?? stored.igUser?.id ?? '',
        );
        const isCurrentUserList = Boolean(currentUserId) &&
          endpointOwnerId === currentUserId;
        if (isCurrentUserList && cached?.scope === 'current-user' &&
            cached?.userId === currentUserId &&
            cached?.users?.length > 0 && !msg.params?.max_id) {
          reply({ ok: true, data: { users: cached.users, next_max_id: cached.next_max_id ?? null } });
          return;
        }

        // 2. execRestInTab üzerinden doğrudan API isteği yap
        //    (Sayfa-yönlendirme yaklaşımı Instagram SPA'sında çalışmıyor:
        //     SPA navigasyonu yeni bir ağ isteği tetiklemiyor, bu nedenle
        //     page-data-bridge hiçbir zaman yanıt yakalayamıyor.)
        try {
          const data = await apiCall(endpoint, msg.params, msg.method ?? 'GET', msg.body);
          const users = Array.isArray(data.users) ? data.users : [];
          if (isCurrentUserList && users.length > 0) {
            chrome.storage.local.set({
              [cacheKey]: {
                users,
                userId: currentUserId,
                scope: 'current-user',
                next_max_id: data.next_max_id ?? null,
                ts: Date.now(),
              },
            });
          }
          reply({ ok: true, data: { users, next_max_id: data.next_max_id ?? null } });
        } catch (e) {
          let errorMsg = e.message ?? String(e);
          if (errorMsg.includes('beklenmeyen HTML sayfası')) {
            errorMsg = 'Instagram liste erişimini geçici olarak kısıtladı. Birkaç dakika bekleyip tekrar deneyin.';
          } else if (errorMsg.includes('No tab with id')) {
            errorMsg = 'Instagram sekmesi açılamadı. Tarayıcı izinlerini kontrol edip tekrar deneyin.';
          } else if (errorMsg.includes('Oturum süresi dolmuş')) {
            errorMsg = 'Instagram oturumu sona ermiş. instagram.com\'a yeniden giriş yapın.';
          }
          reply({ ok: false, error: errorMsg });
        }
      })();
      return true;
    }

    // Username lookup is used only to resolve the manually entered source
    // account. Run it through the same page/content-script request path as
    // the HAR-observed follow-list request instead of the old injected fetch,
    // which can receive Instagram's generic HTML throttle page.
    const isProfileLookup = /\/api\/v1\/users\/web_profile_info\/?$/i.test(endpoint);
    if (isProfileLookup) {
      (async () => {
        try {
          const data = await igFetchViaContentScript(endpoint, msg.params);
          reply({ ok: true, data });
        } catch (error) {
          // An Instagram tab that was already open when the extension was
          // reloaded may not have the new content script yet. In that case
          // keep the manual flow usable through the direct in-tab request
          // rather than exposing "Receiving end does not exist" in the panel.
          const contentScriptUnavailable =
            /Receiving end does not exist|content script|No tab with id|Could not establish connection/i
              .test(String(error?.message ?? error));
          if (contentScriptUnavailable && !isAutomationStopError(error)) {
            try {
              const data = await apiCall(endpoint, msg.params, msg.method ?? 'GET', msg.body);
              reply({ ok: true, data });
              return;
            } catch (fallbackError) {
              error = fallbackError;
            }
          }

          let errorMsg = error.message ?? String(error);
          if (errorMsg.includes('HTML') || errorMsg.includes('geçersiz JSON')) {
            errorMsg = 'Instagram kullanıcı aramasına geçici yanıt vermedi. Birkaç dakika bekleyip tekrar deneyin.';
          } else if (errorMsg.includes('Oturum') || errorMsg.includes('login')) {
            errorMsg = 'Instagram oturumu sona ermiş. instagram.com\'a yeniden giriş yapın.';
          } else if (
            /Receiving end does not exist|Could not establish connection|node cannot be found in the current page/i
              .test(errorMsg)
          ) {
            errorMsg = 'Instagram sekmesi hazır değil. instagram.com sekmesini yenileyip tekrar deneyin.';
          }
          reply({ ok: false, error: errorMsg });
        }
      })();
      return true;
    }

    // Takipçi/takip listesi dışındaki IG_API çağrıları
    (async () => {
      const method = String(msg.method || 'GET').toUpperCase();
      if (method !== 'GET') await requireActiveLicense();
      return apiCall(endpoint || msg.endpoint, msg.params, method, msg.body);
    })()
      .then(data => reply({ ok: true, data }))
      .catch(e => {
        let errorMsg = e.message ?? String(e);
        if (errorMsg.includes('beklenmeyen HTML sayfası')) {
          errorMsg = 'Instagram bu işlemi geçici olarak kısıtladı. Birkaç dakika bekleyip tekrar deneyin.';
        } else if (errorMsg.includes('No tab with id')) {
          errorMsg = 'Instagram sekmesi açılamadı. Tarayıcı izinlerini kontrol edip tekrar deneyin.';
        } else if (errorMsg.includes('Oturum süresi dolmuş')) {
          errorMsg = 'Instagram oturumu sona ermiş. instagram.com\'a yeniden giriş yapın.';
        }
        reply({ ok: false, error: errorMsg });
      });
    return true;
  }

  if (msg.type === 'CLEAR_EXTENSION_DATA') {
    clearExtensionData()
      .then(() => reply({ ok: true }))
      .catch(e => reply({ ok: false, error: e.message || String(e) }));
    return true;
  }

  return false;
}

const LICENSE_REQUIRED_EXTENSION_MESSAGES = new Set([
  'LICENSED_INSTAGRAM_REQUEST',
  'DOM_LIKE_STORY',
  'INSTAGRAM_SESSION_STATUS',
  'INSTAGRAM_SESSION_LINK',
  'INSTAGRAM_SESSION_UNLINK',
  'GENDER_CLASSIFY',
  'GENDER_REANALYZE_UNKNOWN',
  'GENDER_ANALYZE_DASHBOARD',
  'GENDER_GET',
  'IG_API',
  'IG_AUTO_CLEAR_CACHE',
  'IG_AUTO_GET',
  'IG_AUTO_SET',
  'IG_DISCOVERY_FOLLOW',
  'IG_DISCOVERY_LIST',
  'IG_DISCOVERY_NEXT',
  'IG_DISCOVERY_RESOLVE_PROFILE',
  'IG_DISCOVERY_SET',
  'IG_FOLLOW_LIST',
  'IG_GQL_MUTATION',
  'IG_GRAPHQL_REQUEST_CAPTURED',
  'IG_PROFILE_DATA',
  'IG_RATE_LIMIT_RESET_LOCAL',
  'IG_SESSION_PROBE',
  'IG_USER_DATA',
  'REFRESH_USER_DATA',
]);

// Only license onboarding/status and local cleanup are intentionally available
// without an active license. All operational data, including passive page data,
// must be accepted only after a fresh server-side license validation.
const LICENSE_FREE_EXTENSION_MESSAGES = new Set([
  'LICENSE_PUBLIC_CONFIG',
  'LICENSE_GET_STATUS',
  'CLEAR_EXTENSION_DATA',
]);

const LICENSED_FIRE_AND_FORGET_MESSAGES = new Set([
  'IG_GRAPHQL_REQUEST_CAPTURED',
  'IG_PROFILE_DATA',
  'IG_USER_DATA',
]);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const type = String(msg?.type || '');
  if (LICENSE_FREE_EXTENSION_MESSAGES.has(type)) {
    return dispatchExtensionMessage(msg, sender, reply);
  }
  if (!LICENSE_REQUIRED_EXTENSION_MESSAGES.has(type)) return false;

  validateExtensionLicense(true)
    .then(status => {
      if (!status.active) {
        reply({
          ok: false,
          active: false,
          expired: Boolean(status.expired),
          code: status.expired ? 'LICENSE_EXPIRED' : 'LICENSE_REQUIRED',
          error: status.message || 'Bu işlem için etkin bir lisans gerekli.',
        });
        return;
      }
      const handled = dispatchExtensionMessage(msg, sender, reply);
      if (!handled) {
        reply(LICENSED_FIRE_AND_FORGET_MESSAGES.has(type)
          ? { ok: true }
          : { ok: false, error: 'İşlem tanınmadı.' });
      }
    })
    .catch(error => reply({
      ok: false,
      active: false,
      code: 'LICENSE_REQUIRED',
      error: error?.message || 'Lisans doğrulanamadı.',
    }));
  return true;
});

// ── Uzantı verilerini temizleme ───────────────────────────────────────
async function clearExtensionData() {
  // Instagram çerezlerine ve açık sekmelere dokunma; yalnızca uzantı verisini temizle.
  await chrome.storage.local.remove([
    'igUser',
    'igUserTs',
    'igGqlTokens',
    '__analytics_log',
    '__automation_debug_log',
    '__cached_followers',
    '__cached_following',
    DISCOVERY_PROFILE_CACHE_KEY,
  ]);
  _followingCache = [];
  _followingCacheTs = 0;
  _followingCacheUserId = '';
  await patchState({
    enabled: false,
    todayCount: 0,
    lastActionLabel: 'Uzantı verileri temizlendi',
  });
}

// ── Oturum probe'u — gerçekten geçerli mi, yoksa sadece çerez var mı? ─
// Çerez mevcut olsa bile Instagram sunucu tarafı expire/revoke etmiş
// olabilir (başka cihazdan çıkış, şifre değişikliği, şüpheli giriş reset'i).
// Bu fonksiyon /api/v1/accounts/current_user/ uç noktasına gidip JSON user
// mı yoksa HTML login sayfası mı geldiğini kontrol eder.
async function probeSession() {
  const result = {
    valid: false,
    reason: '',
    httpStatus: 0,
    username: '',
    userId: '',
    csrftoken: '',
    sessionidPresent: false,
    checkedAt: Date.now(),
  };
  // 1) Önce çerez mevcut mu?
  const cookie = await new Promise(resolve =>
    chrome.cookies.get({ url: 'https://www.instagram.com', name: 'sessionid' }, resolve)
  );
  // Tüm olası eşleşmeleri tara; bazı Chrome sürümleri domain'i farklı
  // kaydedebiliyor (.instagram.com vs instagram.com).
  let allIgs = [];
  try {
    allIgs = await chrome.cookies.getAll({ domain: 'instagram.com' });
  } catch {}
  const sessionidCookie = cookie?.value
    ? cookie
    : (allIgs.find(c => c.name === 'sessionid' && c.value) ?? null);
  result.sessionidPresent = !!sessionidCookie?.value;
  if (!result.sessionidPresent) {
    result.reason = 'sessionid çerezi yok — instagram.com\'a giriş yap';
    return result;
  }

  // Instagram'ın current_user web endpoint'i bu oturumda useragent mismatch
  // verdiği için artık canlı REST probe'u yapılmıyor. Cookie kimliği ve
  // aynı hesaba bağlı yerel kullanıcı kaydı yeterli bir oturum sinyalidir.
  const dsUserId = await getInstagramSessionUserId();
  const stored = await new Promise(resolve =>
    chrome.storage.local.get(['igUser'], resolve)
  );
  const user = stored?.igUser;
  const userId = String(user?.pk ?? user?.fbid_v2 ?? user?.id ?? '').trim();
  if (dsUserId && userId && dsUserId !== userId) {
    result.reason = 'Instagram oturumu değişmiş — panel kullanıcı verisi yenileniyor';
    return result;
  }
  result.valid = true;
  result.userId = dsUserId || userId;
  result.username = String(user?.username || '');
  result.reason = 'sessionid ve ds_user_id cookie mevcut; REST probe atlandı';
  return result;

  // 2) Çerez var → gerçek bir istekle doğrula
  let resp;
  try {
    resp = await fetch('https://www.instagram.com/api/v1/accounts/current_user/?edit=true', {
      method: 'GET',
      credentials: 'include',
      redirect: 'manual',
      headers: {
        'x-ig-app-id': '936619743392459',
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json',
      },
    });
  } catch (e) {
    result.reason = 'ağ hatası: ' + (e.message || String(e)).slice(0, 80);
    return result;
  }
  result.httpStatus = resp.status;
  const text = await resp.text();
  const lower = text.toLowerCase();

  // 3) Gerçek login yönlendirmesi → oturum ölmüş
  // NOT: text.startsWith('<') tek başına yeterli değil — Instagram anti-bot olarak
  // JSON endpoint'e HTML dönebiliyor ama bu gerçek oturum kaybı değil.
  // Sadece body'de login/logout spesifik kelimeler varsa ya da 401/403 gelirse geçersiz say.
  const isRealLoginPage = lower.includes('/accounts/login') || lower.includes('login_required');
  if (isRealLoginPage || resp.status === 401 || resp.status === 403 || resp.status === 429) {
    if (resp.status === 429) result.reason = 'Instagram rate-limit (429)';
    else if (resp.status === 401 || resp.status === 403) result.reason = `HTTP ${resp.status} — oturum reddedildi`;
    else result.reason = 'geçersiz oturum — Instagram login sayfası döndü';
    return result;
  }
  // HTML ama login sayfası değil → anti-bot geçici yanıt, sessionid çerezi mevcut
  // olduğu için oturumu geçerli sayıyoruz (gerçek doğrulama çereze dayanıyor).
  if (!text || text.trimStart().startsWith('<')) {
    result.valid = true;
    result.reason = 'sessionid çerezi mevcut (API geçici HTML döndürdü — anti-bot)';
    return result;
  }

  // 4) JSON parse → user içeriyor mu?
  try {
         const json = JSON.parse(text.replace(/^for\s*\(;;\);\s*/, '').trim());
    const u = json?.user ?? json?.data?.user;
    if (json?.status === 'fail' || json?.require_login || json?.message === 'login_required') {
      result.reason = 'API login_required döndü';
      return result;
    }
    if (u && (u.username || u.pk || u.id)) {
      result.valid = true;
      result.username = u.username ?? '';
      result.userId = String(u.pk ?? u.id ?? '');
      result.reason = 'oturum geçerli';
      return result;
    }
    result.reason = 'tanımsız JSON — beklenen user alanı yok';
    return result;
  } catch {
    result.reason = 'JSON parse hatası — yanıt beklenmedik formatta';
    return result;
  }
}

// ── Alarm kurulumu ────────────────────────────────────────────────────
function setupAlarms() {
  chrome.alarms.get(ALARM_KEEPALIVE, a => { if (!a) chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 5 }); });
  chrome.alarms.get(ALARM_AUTOLIKE,  a => { if (!a) chrome.alarms.create(ALARM_AUTOLIKE,  { periodInMinutes: 1 }); });
  chrome.alarms.get(ALARM_DISCOVERY, a => { if (!a) chrome.alarms.create(ALARM_DISCOVERY, { periodInMinutes: 1 }); });
  chrome.alarms.get(ALARM_REFRESH_INSTAGRAM, a => {
    if (!a) scheduleInstagramTabRefresh();
  });
}

setupAlarms();

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 5 });
  chrome.alarms.create(ALARM_AUTOLIKE,  { periodInMinutes: 1 });
  chrome.alarms.create(ALARM_DISCOVERY, { periodInMinutes: 1 });
  scheduleInstagramTabRefresh();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_DISCOVERY_START || alarm.name === ALARM_DISCOVERY) {
    hasInstagramSessionCookie().then(present => {
      if (present) {
        discoveryAlarmTick().catch(() => {});
        return;
      }
      appendDiscoveryLog('warn', 'Otomatik keşif başlatılamadı', {
        reason: 'Instagram sessionid çerezi bulunamadı',
        action: 'instagram.com hesabında oturum açıp Keşif anahtarını yeniden aç',
      }).catch(() => {});
    });
    return;
  }
  if (alarm.name === ALARM_AUTOLIKE_START) {
    hasInstagramSessionCookie().then(present => {
      if (present) {
        autolikeTick().catch(() => {});
        return;
      }
      patchState({
        enabled: false,
        backoffUntil: Date.now() + 30 * 60000,
        lastActionLabel: 'sessionid çerezi yok — otomasyon duraklatıldı',
      }).catch(() => {});
    });
    return;
  }
  if (alarm.name === ALARM_KEEPALIVE) {
    // Sessiz tutuldu — sadece çerez varlığını kaydet, FETCH atma.
    // background service worker'dan instagram.com'a periyodik fetch
    // atılması Instagram'ın rate-limit / reCAPTCHA tetikleme
    // eşiğini hızla dolduruyor. Sunucu canlı doğrulaması yalnızca
    // kullanıcı kart üzerinden "Şimdi kontrol et" e bastığında
    // ve AÇIK bir instagram.com sekmesinin içinden yapılıyor.
    chrome.cookies.get({ url: 'https://www.instagram.com', name: 'sessionid' }, cookie => {
      const present = !!cookie?.value;
      patchState({
        sessionCheckedAt: Date.now(),
        sessionValid: present,
        sessionReason: present
          ? 'Çerez mevcut (sunucu doğrulaması için "Şimdi kontrol et" kullanın)'
          : 'sessionid çerezi yok — instagram.com\'a giriş yapın',
      }).catch(() => {});
      if (!present) {
        // Çerez kayıp → otomasyonu güvenli şekilde duraklat
        patchState({
          backoffUntil: Date.now() + 30 * 60000,
          enabled: false,
          lastActionLabel: 'sessionid çerezi yok — instagram.com\'a tarayıcıdan giriş yapıp otomasyonu tekrar aç',
        }).catch(() => {});
        broadcastStatus();
      } else {
        broadcastStatus();
      }
    });
  }
  if (alarm.name === ALARM_REFRESH_INSTAGRAM) {
    refreshInstagramTab().catch(() => {
      // refreshInstagramTab schedules the next one-shot alarm in finally.
    });
    return;
  }
  if (alarm.name === ALARM_AUTOLIKE) {
    hasInstagramSessionCookie().then(present => {
      if (present) {
        autolikeTick().catch(() => {});
        return;
      }
      // Never use a stale igUser record as proof of a live Instagram session.
      patchState({
        enabled: false,
        backoffUntil: Date.now() + 30 * 60000,
        lastActionLabel: 'sessionid çerezi yok — otomasyon duraklatıldı',
      }).catch(() => {});
    });
  }
});

// ── Uzantı simgesine tıklama ──────────────────────────────────────────
chrome.action.onClicked.addListener(() => {
  const panelUrl = chrome.runtime.getURL('panel.html');
  chrome.tabs.query({}, tabs => {
    // startsWith: React Router panel.html#/... formatındaki mevcut sekmeyi de yakalar
    const existing = tabs.find(t => t.url && t.url.startsWith(panelUrl));
    if (existing?.id != null) {
      focusTabSafely(existing);   // zaten açık → sadece öne getir, yeni sekme açma
    } else {
      Promise.resolve(chrome.tabs.create({ url: panelUrl })).catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════
// ANALİTİK LOGGER — her yeni beğeni işlemini storage'a yazar
// ═══════════════════════════════════════════════════════
(function () {
  let _prevCount = -1;
  let _prevDate  = '';
  let _prevLabel = '';

  async function findCfg() {
    const all = await new Promise(r => chrome.storage.local.get(null, r));
    return Object.values(all).find(v => v && typeof v === 'object' && 'todayCount' in v) || null;
  }

  async function appendLog(entry) {
    const stored = await new Promise(r => chrome.storage.local.get([LOG_KEY], r));
    const log = stored[LOG_KEY] || [];
    const duplicate = log.some(item =>
      item?.label === entry.label && Math.abs(Number(item.ts) - Number(entry.ts)) < 60000
    );
    if (duplicate) return;
    log.unshift(entry);
    await new Promise(r => chrome.storage.local.set({ [LOG_KEY]: log.slice(0, 2000) }, r));
  }

  async function poll() {
    try {
      const cfg = await findCfg();
      if (!cfg) return;
      const date  = cfg.todayDate  || new Date().toISOString().split('T')[0];
      const count = cfg.todayCount || 0;
      const label = cfg.lastActionLabel || '';

      if (date !== _prevDate) { _prevCount = 0; _prevDate = date; }

      if (count > _prevCount) {
        _prevCount = count;
        _prevLabel = label;
      }
    } catch {}
  }

  chrome.alarms.onAlarm.addListener(() => { setTimeout(poll, 3500); });
  setTimeout(poll, 5000);

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type !== 'ANALYTICS_GET_STATE') return false;
    validateExtensionLicense(true)
      .then(status => {
        if (!status.active) {
          reply({
            ok: false,
            active: false,
            expired: Boolean(status.expired),
            error: status.message || 'Bu işlem için etkin bir lisans gerekli.',
          });
          return;
        }
        chrome.storage.local.get(null, all => reply({ ok: true, storage: all }));
      })
      .catch(error => reply({
        ok: false,
        active: false,
        error: error?.message || 'Lisans doğrulanamadı.',
      }));
    return true;
  });
})();
