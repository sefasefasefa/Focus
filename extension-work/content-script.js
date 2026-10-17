'use strict';

/*
 * Instagram changes the REST response and user-agent checks frequently.
 * The web page already has the profile payload that the browser downloaded,
 * so read that payload first and use the HAR-observed GraphQL request only
 * when the page data is incomplete.
 */
const INSTAGRAM_APP_ID = '936619743392459';
const DOC_ID_PROFILE_LATEST_KEY = 'latestInstagramProfileDocId';
const DOC_ID_PROFILE_CONTEXT_KEY = 'instagramProfileGraphQLContext';
let downloadedResponseUser = null;
let downloadedResponseUsers = [];
const IG_CONTENT_REQUEST_MIN_GAP_MS = 1500;
const IG_RATE_LIMIT_BLOCK_KEY = 'igRateLimitBlockedUntil';
const IG_PUBLISH_MIN_GAP_MS = 15000;
let contentRequestQueue = Promise.resolve();
let lastContentRequestStartedAt = 0;
let contentRateLimitBlockedUntil = 0;
let pageRequestSequence = 0;

function readContentRateLimitUntil() {
  // Do not let an old profile fallback lock all content-script requests.
  // Background startup removes the legacy persisted key as well.
  contentRateLimitBlockedUntil = 0;
  return Promise.resolve(0);
}

function persistContentRateLimit(until) {
  // A single endpoint can return 429 while the list endpoints still work.
  // Keep the error local to the current request instead of freezing the
  // entire extension for 30 minutes.
  contentRateLimitBlockedUntil = 0;
}

function withContentRequestSlot(task) {
  const run = contentRequestQueue.then(async () => {
    await readContentRateLimitUntil();
    const waitMs = Math.max(
      0,
      IG_CONTENT_REQUEST_MIN_GAP_MS - (Date.now() - lastContentRequestStartedAt),
    );
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastContentRequestStartedAt = Date.now();
    try {
      return await task();
    } catch (error) {
      if (/(?:\b429\b|http(?:\s|_)?429\b|feedback_required|action[_\s-]*blocked|rate[_\s-]*limit(?:ed|_required)?|too many requests|geçici olarak kısıtlandı|çok fazla istek)/i.test(String(error?.message ?? error))) {
        persistContentRateLimit(Date.now() + 30 * 60000);
      }
      throw error;
    }
  });
  contentRequestQueue = run.catch(() => {});
  return run;
}

function isThrottleOrSessionError(error) {
  const message = String(error?.message ?? error ?? '');
  return /(?:\b429\b|\b401\b|\b403\b|rate[\s_-]*limit|feedback_required|login_required|oturum süresi dolmuş|oturum geçersiz)/i.test(message);
}

function csrfToken() {
  return document.cookie
    .split(';')
    .find((value) => value.trim().startsWith('csrftoken='))
    ?.split('=')
    .slice(1)
    .join('=') ?? '';
}

function cookieUserId() {
  return document.cookie.match(/(?:^|;)\s*ds_user_id=(\d+)/)?.[1] ?? '';
}

function instagramWwwClaim() {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const value = localStorage.getItem(localStorage.key(index) ?? '') ?? '';
      if (value.startsWith('hmac.')) return value;
    }
  } catch {}
  try {
    for (const value of Object.values(window)) {
      if (typeof value === 'string' && value.startsWith('hmac.')) return value;
    }
  } catch {}
  try {
    for (const script of document.querySelectorAll('script:not([src])')) {
      const match = (script.textContent ?? '').match(/hmac\.[A-Za-z0-9_\-+=/.]{20,}/);
      if (match) return match[0];
    }
  } catch {}
  return '';
}

function normalizeUser(value) {
  if (!value || typeof value !== 'object') return null;
  const user = value.user_dict ?? value.user ?? value;
  if (!user || typeof user !== 'object') return null;

  const toCount = (...candidates) => {
    let zero = undefined;
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined || candidate === '') continue;
      const number = Number(candidate);
      if (!Number.isFinite(number) || number < 0) continue;
      // Instagram sometimes sends a stale REST zero next to the live
      // edge_* count. Prefer the live positive value when both are present.
      if (number > 0) return number;
      zero ??= number;
    }
    return zero;
  };
  // REST returns follower_count/following_count/media_count, while the
  // current Instagram GraphQL profile payload exposes the same values as
  // edge_* .count. Normalize both shapes before the profile reaches storage.
  const followerCount = toCount(
    user.follower_count,
    user.followers_count,
    user.edge_followed_by?.count,
    user.edge_followed_by_v2?.count,
  );
  const followingCount = toCount(
    user.following_count,
    user.follows_count,
    user.edge_follow?.count,
    user.edge_following?.count,
  );
  const mediaCount = toCount(
    user.media_count,
    user.posts_count,
    user.edge_owner_to_timeline_media?.count,
    user.edge_owner_to_timeline_media_v2?.count,
  );

  const pk = String(user.pk ?? user.id ?? user.fbid_v2 ?? '').trim();
  const username = String(user.username ?? '').trim();
  const hasProfileFields =
    followerCount != null ||
    followingCount != null ||
    mediaCount != null ||
    user.profile_pic_url != null;

  if (!pk && !username) return null;
  if (!pk && !hasProfileFields) return null;

  return {
    ...user,
    pk: pk || undefined,
    id: user.id != null ? String(user.id) : undefined,
    fbid_v2: user.fbid_v2 != null ? String(user.fbid_v2) : undefined,
    username: username || undefined,
    follower_count: followerCount,
    following_count: followingCount,
    media_count: mediaCount,
  };
}

function mergeUsers(...values) {
  const users = values.map(normalizeUser).filter(Boolean);
  if (!users.length) return null;

  const merged = {};
  for (const user of users) {
    for (const [key, value] of Object.entries(user)) {
      // Do not replace a real zero with undefined or an older partial value.
      if (value !== undefined && value !== null && value !== '') merged[key] = value;
    }
  }
  if (!merged.pk) merged.pk = String(merged.id ?? merged.fbid_v2 ?? '').trim();
  return merged.pk || merged.username ? merged : null;
}

function walkForUsers(value, output, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 9) return;
  const candidate = normalizeUser(value);
  if (candidate) output.push(candidate);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') walkForUsers(child, output, depth + 1);
  }
}

function parseJsonText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed || trimmed.length > 8_000_000) return null;
  const candidates = [trimmed, trimmed.replace(/^for\s*\(;;\);\s*/, '')];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Most script tags are JavaScript, not standalone JSON.
    }
  }
  return null;
}

function readStorageObjects(storage) {
  const values = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;
      const value = storage.getItem(key);
      const parsed = parseJsonText(value);
      if (parsed) values.push(parsed);
    }
  } catch {
    // Storage can be unavailable in a private or restricted frame.
  }
  return values;
}

function readDownloadedProfileData() {
  const candidates = [];
  if (downloadedResponseUser) candidates.push(downloadedResponseUser);
  try {
    const retained = document.documentElement?.getAttribute('data-takipci-panel-user');
    if (retained) {
      const parsed = JSON.parse(retained);
      for (const user of parsed?.users ?? []) candidates.push(user);
    }
  } catch {}

  // These are the shapes used by Instagram's current page bootstrap data.
  try {
    candidates.push(window.__additionalDataCurrentUser?.data?.user);
    candidates.push(window._sharedData?.config?.viewer);
    candidates.push(window.__initialData?.viewer?.user);
  } catch {
    // A missing page global is expected on newer Instagram builds.
  }

  for (const value of readStorageObjects(window.localStorage)) candidates.push(value);
  for (const value of readStorageObjects(window.sessionStorage)) candidates.push(value);

  // The HAR response shape is often embedded in a bootstrap script or
  // retained by the page as JSON: data.xig_user_by_igid_v2.user_dict and
  // data.viewer.user. Parse standalone JSON scripts and walk both branches.
  for (const script of document.querySelectorAll('script')) {
    const parsed = parseJsonText(script.textContent);
    if (parsed) candidates.push(parsed);
  }

  const found = [];
  for (const candidate of candidates) walkForUsers(candidate, found);

  // A page can expose the viewer ID separately from the profile dictionary.
  // Keep it as a useful identity fallback and merge it with profile data.
  const pageUserId = cookieUserId();
  const userIdOf = (user) => String(
    user?.pk ?? user?.fbid_v2 ?? user?.id ?? '',
  ).trim();
  const sessionUsers = pageUserId
    ? found.filter((user) => userIdOf(user) === pageUserId)
    : [];
  const rankedPool = sessionUsers.length ? sessionUsers : found;
  const best = rankedPool
    .filter((user) => user.pk || user.username)
    .sort((left, right) => {
      const leftScore = Number(left.follower_count != null) * 4 +
        Number(left.following_count != null) * 4 +
        Number(left.media_count != null) * 2 +
        Number(Boolean(left.username));
      const rightScore = Number(right.follower_count != null) * 4 +
        Number(right.following_count != null) * 4 +
        Number(right.media_count != null) * 2 +
        Number(Boolean(right.username));
      return rightScore - leftScore;
    })[0];

  // Never merge a viewed profile's name/counts with the signed-in user's ID.
  // That creates a synthetic record which passes the cookie check while
  // displaying the follower currently open in the Instagram tab. If the page
  // did not expose the signed-in account, return identity only and let the
  // GraphQL/profile fallback resolve its real totals.
  if (pageUserId && !sessionUsers.length) return { pk: pageUserId };
  return mergeUsers(best);
}

function consumeDownloadedResponse(serialized) {
  try {
    const event = JSON.parse(String(serialized ?? ''));
    const found = Array.isArray(event?.users) ? event.users.map(normalizeUser).filter(Boolean) : [];
    if (found.length) {
      downloadedResponseUsers = found;
      const best = found.sort((left, right) => {
        const leftScore = Number(left.follower_count != null) * 4 +
          Number(left.following_count != null) * 4 +
          Number(left.media_count != null) * 2 +
          Number(Boolean(left.username));
        const rightScore = Number(right.follower_count != null) * 4 +
          Number(right.following_count != null) * 4 +
          Number(right.media_count != null) * 2 +
          Number(Boolean(right.username));
        return rightScore - leftScore;
      })[0];
      downloadedResponseUser = mergeUsers(downloadedResponseUser, best);
      publishUser().catch(() => {});
    }
  } catch {
    // A response may be streamed or not be JSON; ignore that response.
  }
}

function findPageUserByUsername(username) {
  const wanted = String(username ?? '').replace(/^@/, '').trim().toLowerCase();
  if (!wanted) return null;
  const candidates = [...downloadedResponseUsers];
  try {
    const retained = document.documentElement?.getAttribute('data-takipci-panel-user');
    if (retained) {
      const parsed = JSON.parse(retained);
      candidates.push(...(Array.isArray(parsed?.users) ? parsed.users : []));
    }
  } catch {}
  // Some profile responses arrive before the bridge/content-script handoff.
  // Instagram also keeps the initial profile payload in inline JSON scripts,
  // so inspect those as a late-listener fallback.
  try {
    const collect = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 12) return;
      if (Array.isArray(value)) {
        for (const child of value) collect(child, depth + 1);
        return;
      }
      if (String(value.username ?? '').toLowerCase() === wanted) candidates.push(value);
      for (const child of Object.values(value)) {
        if (child && typeof child === 'object') collect(child, depth + 1);
      }
    };
    for (const script of document.scripts) {
      const text = script.textContent ?? '';
      if (text.length > 5000000 || !text.toLowerCase().includes(`"username":"${wanted}"`)) continue;
      try { collect(JSON.parse(text)); } catch {}
    }
  } catch {}
  const exact = candidates
    .map(normalizeUser)
    .filter(Boolean)
    .find(user => String(user.username ?? '').toLowerCase() === wanted);
  return exact ?? null;
}

function findLiveProfileGraphQLDocId() {
  try {
    for (const mod of window.__bbox?.require ?? []) {
      if (!Array.isArray(mod)) continue;
      const name = String(mod[0] || '');
      if (!/^Polaris(?:ProfilePageContent(?:Content)?Query|ProfilePageQuery)(?:_instagramRelayOperation)?$/.test(name)) {
        continue;
      }
      const cfg = Array.isArray(mod[3]) ? mod[3][0] : mod[3];
      const id = typeof cfg === 'string' ? cfg : cfg?.id ?? cfg?.doc_id;
      if (/^\d{10,20}$/.test(String(id || ''))) return String(id);
    }
    const direct = window.require?.('PolarisProfilePageContentQuery_instagramRelayOperation');
    const directId = typeof direct === 'string' ? direct : direct?.id ?? direct?.doc_id;
    if (/^\d{10,20}$/.test(String(directId || ''))) return String(directId);
  } catch {}
  return '';
}

async function getProfileGraphQLDocId() {
  const live = findLiveProfileGraphQLDocId();
  if (live) return live;
  try {
    const stored = await new Promise(resolve =>
      chrome.storage.local.get([DOC_ID_PROFILE_LATEST_KEY], resolve)
    );
    const captured = String(stored?.[DOC_ID_PROFILE_LATEST_KEY]?.doc_id || '').trim();
    return /^\d{10,20}$/.test(captured) ? captured : '';
  } catch {
    return '';
  }
}

async function getProfileGraphQLVariables() {
  try {
    const stored = await new Promise(resolve =>
      chrome.storage.local.get([DOC_ID_PROFILE_CONTEXT_KEY], resolve)
    );
    const context = stored?.[DOC_ID_PROFILE_CONTEXT_KEY];
    const friendlyName = String(context?.friendly_name || '');
    if (!/PolarisProfilePageContentQuery/i.test(friendlyName)) return null;
    const variables = context?.variables;
    return variables && typeof variables === 'object' && !Array.isArray(variables)
      ? variables
      : null;
  } catch {
    return null;
  }
}

function publishPageProfile() {
  try {
    const pathUsername = location.pathname.match(/^\/([^/?#]+)/)?.[1] ?? '';
    if (!pathUsername || /^(accounts|explore|direct|reels?|stories|p|about)$/i.test(pathUsername)) return;
    const user = findPageUserByUsername(pathUsername);
    if (!user?.pk && !user?.id) return;
    chrome.runtime.sendMessage({
      type: 'IG_PROFILE_DATA',
      username: pathUsername,
      user,
    });
  } catch {}
}

function getPageTokens() {
  let fbDtsg = '';
  let lsd = '';
  try {
    fbDtsg = String(window.require?.('DTSGInitData')?.token ?? '');
    lsd = String(window.require?.('LSD')?.token ?? '');
  } catch {}

  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent ?? '';
    if (!fbDtsg) {
      fbDtsg = text.match(/"DTSGInitData"[\s\S]{0,300}?"token"\s*:\s*"([^"]+)"/)?.[1] ?? '';
    }
    if (!lsd) {
      lsd = text.match(/"LSD"[\s\S]{0,300}?"token"\s*:\s*"([^"]+)"/)?.[1] ?? '';
    }
    if (fbDtsg && lsd) break;
  }
  return { fbDtsg, lsd };
}

function instagramResponseReason(text, contentType = '') {
  const cleaned = String(text || '').replace(/^for\s*\(;;\);\s*/, '').trim();
  if (!cleaned) return 'Sunucu yanıt gövdesi boş';
  if (cleaned.startsWith('<') || /text\/html/i.test(contentType)) {
    const title = cleaned.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
    return title
      ? `HTML yanıtı: ${title}`.slice(0, 240)
      : `HTML yanıtı (${cleaned.length} karakter)`;
  }
  try {
    const payload = JSON.parse(cleaned);
    const rawReason = payload?.message
      ?? payload?.error?.message
      ?? payload?.error_title
      ?? payload?.error_type
      ?? payload?.error;
    if (rawReason != null) {
      return (typeof rawReason === 'string' ? rawReason : JSON.stringify(rawReason))
        .slice(0, 240);
    }
  } catch {
    // Fall back to a bounded text excerpt for non-JSON API errors.
  }
  return cleaned.slice(0, 240);
}

function createInstagramRateLimitError(response, text, requestUrl) {
  const responseContentType = response?.headers?.get?.('content-type') || '';
  const responseReason = instagramResponseReason(text, responseContentType);
  let endpoint = String(requestUrl || '').split('?')[0].slice(0, 500);
  try {
    endpoint = new URL(String(requestUrl), location.href).pathname;
  } catch {
    // Keep the query-free request URL if it cannot be parsed.
  }
  const error = new Error(
    `Instagram istek sınırı uyguladı (HTTP ${response?.status || 429})`
      + (responseReason ? `: ${responseReason}` : ''),
  );
  Object.assign(error, {
    status: response?.status ?? 429,
    statusText: response?.statusText || '',
    retryAfter: response?.headers?.get?.('retry-after') || '',
    responseContentType,
    responseReason,
    endpoint,
  });
  return error;
}

function serializeInstagramError(error) {
  return {
    ok: false,
    error: String(error?.message ?? error ?? 'Instagram isteği başarısız'),
    status: error?.status ?? null,
    statusText: String(error?.statusText || '').slice(0, 120),
    retryAfter: String(error?.retryAfter || '').slice(0, 120),
    responseContentType: String(error?.responseContentType || '').slice(0, 160),
    responseReason: String(error?.responseReason || '').slice(0, 300),
    endpoint: String(error?.endpoint || '').slice(0, 500),
  };
}

function licensedInstagramRequest(endpoint, params, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'LICENSED_INSTAGRAM_REQUEST',
      endpoint,
      params: params || {},
      method,
      body: body ?? '',
      headers,
    }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'Lisans sunucusuna ulaşılamadı.'));
        return;
      }
      if (!response?.ok) {
        const error = new Error(response?.error || 'İstek için etkin lisans gerekli.');
        Object.assign(error, {
          status: response?.status ?? null,
          endpoint,
        });
        reject(error);
        return;
      }
      resolve(response.data);
    });
  });
}

function requestPageJson(endpoint, params, method = 'GET') {
  const url = new URL(endpoint, location.href);
  if (url.protocol !== 'https:' || !/(^|\.)instagram\.com$/i.test(url.hostname)) {
    throw new Error('Yalnızca Instagram API isteklerine izin verilir.');
  }
  const mergedParams = Object.fromEntries(url.searchParams.entries());
  Object.assign(mergedParams, params || {});
  return licensedInstagramRequest(url.pathname, mergedParams, method);
}

async function requestJson(endpoint, params, method = 'GET', body) {
  return withContentRequestSlot(async () => {
    const url = new URL(endpoint, 'https://www.instagram.com');
    if (url.protocol !== 'https:' || !/(^|\.)instagram\.com$/i.test(url.hostname)) {
      throw new Error('Yalnızca Instagram API isteklerine izin verilir.');
    }
    const mergedParams = Object.fromEntries(url.searchParams.entries());
    Object.assign(mergedParams, params || {});
    const headers = {
      'X-IG-App-ID': INSTAGRAM_APP_ID,
      'X-ASBD-ID': '359341',
      'X-IG-Max-Touch-Points': String(navigator.maxTouchPoints || 0),
      'X-Requested-With': 'XMLHttpRequest',
    };
    const wwwClaim = instagramWwwClaim();
    if (wwwClaim) headers['X-IG-WWW-Claim'] = wwwClaim;
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const json = await licensedInstagramRequest(url.pathname, mergedParams, method, body, headers);
    if (!json || typeof json !== 'object') {
      throw new Error('Instagram API geçersiz JSON yanıtı döndürdü.');
    }
    if (json?.status === 'fail' || json?.require_login ||
        json?.message === 'login_required' || json?.message === 'feedback_required') {
      throw new Error(`Instagram API reddetti: ${json?.message ?? 'geçici API hatası'}`);
    }
    return json;
  });
}

async function requestProfileGraphQL() {
  const { fbDtsg, lsd } = getPageTokens();
  if (!fbDtsg || !lsd) return null;
  const [profileDocId, capturedVariables] = await Promise.all([
    getProfileGraphQLDocId(),
    getProfileGraphQLVariables(),
  ]);
  if (!profileDocId) return null;
  const jazoest = `2${Array.from(fbDtsg).reduce((sum, character) => sum + character.charCodeAt(0), 0)}`;
  const profileVariables = (userID, useCapturedVariables = true) => {
    const variables = useCapturedVariables && capturedVariables
      ? { ...capturedVariables }
      : {
          enable_integrity_filters: true,
          id: String(userID),
          __relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider: true,
          __relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider: false,
          __relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider: false,
          __relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider: true,
          __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
        };
    const identityKeys = [
      'id',
      'userID',
      'user_id',
      'igid',
      'profile_id',
    ];
    let replacedIdentity = false;
    for (const key of identityKeys) {
      if (Object.prototype.hasOwnProperty.call(variables, key)) {
        variables[key] = String(userID);
        replacedIdentity = true;
      }
    }
    if (!replacedIdentity) variables.id = String(userID);
    return variables;
  };

  const call = async (userID, actorId = '0', useCapturedVariables = true) => {
    return withContentRequestSlot(async () => {
      const body = new URLSearchParams({
        av: actorId,
        __d: 'www',
        __user: '0',
        __a: '1',
        __req: 'g',
        __comet_req: '7',
        fb_dtsg: fbDtsg,
        jazoest,
        lsd,
        variables: JSON.stringify(profileVariables(userID, useCapturedVariables)),
        doc_id: profileDocId,
        server_timestamps: 'true',
        fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: 'PolarisProfilePageContentQuery',
      });
      const headers = {
        'content-type': 'application/x-www-form-urlencoded',
        'x-asbd-id': '359341',
        'x-fb-dtsg': fbDtsg,
        'x-fb-lsd': lsd,
        'x-fb-friendly-name': 'PolarisProfilePageContentQuery',
        'x-ig-app-id': INSTAGRAM_APP_ID,
        'x-ig-max-touch-points': String(navigator.maxTouchPoints || 0),
        'x-requested-with': 'XMLHttpRequest',
      };
      const wwwClaim = instagramWwwClaim();
      if (wwwClaim) headers['x-ig-www-claim'] = wwwClaim;
      const json = await licensedInstagramRequest(
        '/api/graphql',
        {},
        'POST',
        body.toString(),
        headers,
      );
      if (json.errors?.length) throw new Error(JSON.stringify(json.errors).slice(0, 200));
      return json;
    });
  };

  const viewer = null;
  const userId = String(cookieUserId()).trim();
  if (!userId || userId === '0') return null;

  let profileResponse;
  try {
    profileResponse = await call(userId, userId, true);
  } catch (error) {
    // A stale/incomplete captured request can be rejected after an Instagram
    // bundle update. Retry once with the canonical variable set, not the same
    // malformed payload.
    if (!capturedVariables) throw error;
    profileResponse = await call(userId, userId, false);
  }
  const userDict = profileResponse?.data?.xig_user_by_igid_v2?.user_dict
    ?? profileResponse?.data?.user;
  const candidates = [
    normalizeUser(userDict),
    normalizeUser(profileResponse?.data?.viewer?.user),
    normalizeUser(viewer),
  ].filter(Boolean);
  // A profile query can contain both the requested profile and a viewer
  // object. Only publish the object whose identity is exactly ds_user_id;
  // otherwise a viewed follower can win the merge and poison igUser.
  const matching = candidates.filter((candidate) => {
    const candidateId = String(
      candidate.pk ?? candidate.fbid_v2 ?? candidate.id ?? '',
    ).trim();
    return candidateId === userId;
  });
  return matching.length ? mergeUsers(...matching, { pk: userId }) : null;
}

function findAuthenticatedUsername() {
  const candidates = [];
  try {
    const current = window.require?.('CurrentUserInitialData');
    candidates.push(
      current?.USERNAME,
      current?.username,
      current?.user?.username,
    );
  } catch {}
  try {
    candidates.push(
      window._sharedData?.config?.viewer?.username,
      window.__additionalDataCurrentUser?.data?.user?.username,
      window.__initialData?.viewer?.user?.username,
    );
  } catch {}

  // On the home/feed page Instagram commonly exposes the signed-in profile
  // only as the navigation profile link, not in a JSON bootstrap object.
  try {
    const excluded = new Set([
      'accounts', 'about', 'direct', 'directory', 'explore', 'reels',
      'stories', 'web', 'p', 'privacy', 'legal', 'settings',
    ]);
    const links = [...document.querySelectorAll('a[href]')];
    const ranked = links.map((anchor) => {
      const href = anchor.getAttribute('href') || '';
      const pathPart = href.match(/^\/([^/?#]+)\/?$/)?.[1] || '';
      if (!pathPart || excluded.has(pathPart.toLowerCase())) return null;
      const label = `${anchor.getAttribute('aria-label') || ''} ${anchor.getAttribute('title') || ''} ${anchor.getAttribute('data-testid') || ''}`;
      const imageAlt = [...anchor.querySelectorAll('img[alt]')]
        .map((image) => image.getAttribute('alt') || '')
        .join(' ');
      let score = 1;
      if (/profile|profil/i.test(label)) score += 20;
      if (/profile|profil|avatar|picture|foto/i.test(imageAlt)) score += 10;
      return { pathPart, score };
    }).filter(Boolean).sort((left, right) => right.score - left.score);
    if (ranked[0]?.pathPart) candidates.push(ranked[0].pathPart);
  } catch {}

  const excluded = new Set([
    'accounts', 'about', 'direct', 'directory', 'explore', 'reels',
    'stories', 'web', 'p', 'privacy', 'legal',
  ]);
  return candidates
    .map((value) => String(value ?? '').replace(/^@/, '').trim())
    .find((value) => value && !excluded.has(value.toLowerCase()) && /^[a-zA-Z0-9._]+$/.test(value)) || '';
}

async function fetchFullUser() {
  // This function publishes the authenticated viewer, not the profile open
  // in the current tab. Reading downloaded page data first caused a follower's
  // profile to be stored as igUser when that profile happened to be open.
  try {
    const viewer = await requestProfileGraphQL();
    if (viewer?.pk) return viewer;
  } catch (error) {
    if (isThrottleOrSessionError(error)) return null;
  }

  // If the profile GraphQL operation is not available yet, ask the page's
  // native fetch for current_user. This endpoint is account-scoped and is
  // safe here; unlike the profile bootstrap it cannot represent a viewed
  // follower. The bridge only permits this exact endpoint.
  let partialCurrentUser = null;
  try {
    const current = await requestPageJson(
      '/api/v1/accounts/current_user/?edit=true',
      {},
      'GET',
    );
    const user = normalizeUser(current?.user ?? current);
    const currentUserId = String(
      user?.pk ?? user?.fbid_v2 ?? user?.id ?? '',
    ).trim();
    if (user?.pk && currentUserId === cookieUserId()) {
      const hasCounts = user.follower_count != null ||
        user.following_count != null ||
        user.media_count != null;
      if (hasCounts) return user;
      // current_user often contains the authenticated username but omits
      // profile totals. Keep the verified identity and continue with the
      // page bootstrap fallback; do not call the rate-limited profile REST
      // endpoint.
      partialCurrentUser = user;
    }
  } catch {}

  // Instagram currently rejects the web current_user endpoint with
  // "useragent mismatch" even when the browser session is valid. Use page
  // bootstrap data only when its identity matches ds_user_id; never turn the
  // profile currently open in the tab into the authenticated viewer.
  const sessionUserId = cookieUserId();
  const pageUser = normalizeUser(readDownloadedProfileData());
  const pageUserId = String(pageUser?.pk ?? pageUser?.id ?? pageUser?.fbid_v2 ?? '').trim();
  const pageUserHasCounts = pageUser?.follower_count != null ||
    pageUser?.following_count != null ||
    pageUser?.media_count != null;
  if (pageUser?.pk && pageUserHasCounts && sessionUserId && pageUserId === sessionUserId) {
    return pageUser;
  }
  return null;
}

let publishInFlight = null;
let lastPublishedAt = 0;

async function publishUser(force = false) {
  const now = Date.now();
  if (publishInFlight) return publishInFlight;
  // A UI refresh must not turn the profile fallback chain into a request
  // flood. "force" bypasses the normal stale-data decision, not this
  // anti-burst guard.
  // A panel-triggered refresh is an explicit recovery action. Allow it to
  // retry after an initial profile lookup failed, while keeping the normal
  // page-driven publishing path rate-limited.
  if (!force && now - lastPublishedAt < IG_PUBLISH_MIN_GAP_MS) return null;

  lastPublishedAt = now;
  publishInFlight = (async () => {
    const user = await fetchFullUser();
    if (user?.pk) {
      chrome.runtime.sendMessage({
        type: 'IG_USER_DATA',
        user,
        viewerId: cookieUserId(),
      });
    }
    return user ?? null;
  })();
  try {
    return await publishInFlight;
  } finally {
    publishInFlight = null;
  }
}

function publishCapturedGraphQLRequest(serialized) {
  try {
    const payload = JSON.parse(String(serialized ?? ''));
    const friendlyName = String(payload?.friendly_name || '').trim();
    const isTrackedDocIdOperation =
      /^(?:PolarisProfilePosts(?:TabContentQuery(?:_connection)?|Query(?:_connection)?)|PolarisProfileReelsTabContentQuery(?:_connection)?|PolarisAPILikePostMutation)$/.test(friendlyName);
    if (!payload?.doc_id || (!payload?.is_profile && !isTrackedDocIdOperation)) return;
    chrome.runtime.sendMessage({
      type: 'IG_GRAPHQL_REQUEST_CAPTURED',
      payload: {
        doc_id: String(payload.doc_id),
        friendly_name: friendlyName,
        variables: payload.variables && typeof payload.variables === 'object'
          ? payload.variables
          : null,
        is_profile: payload.is_profile === true,
      },
    });
  } catch {}
}

document.addEventListener('takipci-panel:graphql-request', (event) => {
  publishCapturedGraphQLRequest(event.detail);
});

// The bridge starts at document_start, while this isolated script starts at
// document_idle. Replay the last profile request if it happened earlier.
try {
  const retainedGraphQLRequest = document.documentElement?.getAttribute(
    'data-takipci-panel-graphql-request',
  );
  if (retainedGraphQLRequest) publishCapturedGraphQLRequest(retainedGraphQLRequest);
} catch {}

document.addEventListener('takipci-panel:instagram-response', (event) => {
  consumeDownloadedResponse(event.detail);
  publishPageProfile();
});

// Instagram'ın kendi sayfa fetch'inden yakalanan takipçi/takip listesi
document.addEventListener('takipci-panel:follow-list', (event) => {
  try {
    chrome.runtime.sendMessage({ type: 'IG_FOLLOW_LIST', payload: event.detail });
  } catch {}
});

// page-data-bridge runs at document_start while this script runs at
// document_idle. If Instagram answered before this listener existed, consume
// the DOM handoff written by the bridge.
try {
  const retainedFollowList = document.documentElement?.getAttribute(
    'data-takipci-panel-follow-list',
  );
  if (retainedFollowList) {
    chrome.runtime.sendMessage({
      type: 'IG_FOLLOW_LIST',
      payload: retainedFollowList,
    });
  }
} catch {}

setTimeout(() => publishUser().catch(() => {}), 800);
setTimeout(() => publishUser().catch(() => {}), 5000);
setTimeout(publishPageProfile, 1200);
setTimeout(publishPageProfile, 6000);
// Do not poll Instagram every two minutes. If page data is incomplete,
// publishUser() can fan out into GraphQL + REST fallbacks and create a
// needless background request stream. Refreshes are event/user driven.

function clickLike(like) {
  return false;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'TP_CONTENT_PING') {
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'DOM_LIKE_STORY') {
    sendResponse({
      ok: false,
      error: 'Doğrudan Instagram sayfası tıklaması kapalı; bu işlem lisanslı sunucu API’sinden yapılmalıdır.',
    });
    return false;
  }
  if (message.type === 'REFRESH_USER_DATA') {
    publishUser(true)
      .then((user) => {
        const hasCounts = !!(
          user?.follower_count != null ||
          user?.following_count != null ||
          user?.media_count != null
        );
        sendResponse({
          ok: !!user?.pk,
          userId: String(user?.pk ?? user?.id ?? ''),
          hasCounts,
          error: user?.pk
            ? ''
            : 'Instagram sayfa verisinden doğrulanmış profil bulunamadı',
        });
      })
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message ?? error),
      }));
    // If the first request is still resolving or the Instagram page has not
    // exposed its profile operation yet, give the page one quiet retry after
    // the normal publish interval instead of leaving the panel at zero.
    setTimeout(() => publishUser(true).catch(() => {}), IG_PUBLISH_MIN_GAP_MS + 250);
    return true;
  }
  if (message.type === 'IG_FETCH_PAGE') {
    requestPageJson(message.endpoint, message.params, message.method ?? 'GET')
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse(serializeInstagramError(error)));
    return true;
  }
  if (message.type === 'IG_PROFILE_LOOKUP') {
    const user = findPageUserByUsername(message.username);
    sendResponse({ ok: !!user, user });
    return false;
  }
  if (message.type !== 'IG_FETCH') return false;

  requestJson(message.endpoint, message.params, message.method ?? 'GET', message.body)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse(serializeInstagramError(error)));
  return true;
});