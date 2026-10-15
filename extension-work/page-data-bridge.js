/*
 * Runs in Instagram's MAIN world so it can observe the same network
 * responses the page receives. No cookies, headers, or credentials are
 * forwarded to the extension. GraphQL requests emit operation, doc_id and
 * variables only.
 */
'use strict';

(function installInstagramResponseBridge() {
  if (window.__takipciPanelResponseBridgeInstalled) return;
  window.__takipciPanelResponseBridgeInstalled = true;

  const isGraphQLUrl = (url) =>
    /\/(?:api\/graphql|graphql\/query)(?:\/|\?|$)/i.test(String(url || ''));

  const interestingUrl = (url) =>
    isGraphQLUrl(url) ||
    /\/api\/v1\/(?:accounts\/current_user|users\/web_profile_info|users\/\d+\/info)/i.test(url);

  const isTrackedDocIdOperation = (friendlyName) =>
    /^(?:PolarisProfilePosts(?:TabContentQuery(?:_connection)?|Query(?:_connection)?)|PolarisProfileReelsTabContentQuery(?:_connection)?|PolarisAPILikePostMutation)$/.test(
      String(friendlyName || '').trim(),
    );

  const isFollowListUrl = (url) =>
    /\/api\/v1\/friendships\/\d+\/(followers|following)\//i.test(url);

  const requestBodyText = (body) => {
    try {
      if (typeof body === 'string') return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof FormData) {
        return new URLSearchParams([...body.entries()]).toString();
      }
      return body?.toString?.() ?? '';
    } catch {
      return '';
    }
  };

  const parseRequestFields = (text) => {
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      const object = Array.isArray(parsed) ? (parsed[0] || {}) : (parsed || {});
      return object && typeof object === 'object' ? object : {};
    } catch {
      try {
        const params = new URLSearchParams(text);
        const fields = {};
        for (const key of [
          'doc_id',
          'docId',
          'query_id',
          'queryId',
          'friendly_name',
          'fb_api_req_friendly_name',
          'operationName',
          'variables',
        ]) {
          const value = params.get(key);
          if (value != null) fields[key] = value;
        }
        return fields;
      } catch {
        return {};
      }
    }
  };

  const parseGraphQLRequest = (url, body) => {
    if (!isGraphQLUrl(url)) return null;
    const text = requestBodyText(body);
    const fields = parseRequestFields(text);
    try {
      const urlParams = new URL(url, window.location.href).searchParams;
      for (const key of [
        'doc_id',
        'docId',
        'query_id',
        'queryId',
        'friendly_name',
        'fb_api_req_friendly_name',
        'operationName',
        'variables',
      ]) {
        if (fields[key] == null) {
          const value = urlParams.get(key);
          if (value != null) fields[key] = value;
        }
      }
    } catch {}
    let variables = fields.variables;
    if (typeof variables === 'string') {
      try { variables = JSON.parse(variables); } catch { variables = null; }
    }
    const docId = String(
      fields.doc_id
        ?? fields.docId
        ?? fields.query_id
        ?? fields.queryId
        ?? '',
    ).trim();
    const friendlyName = String(
      fields.fb_api_req_friendly_name
        ?? fields.friendly_name
        ?? fields.operationName
        ?? '',
    ).trim();
    if (!docId) return null;
    const source = [
      url,
      friendlyName,
      variables ? JSON.stringify(variables) : '',
      window.location.pathname,
    ].join(' ');
    const hasProfileIdentity = variables &&
      ['id', 'userID', 'user_id', 'igid', 'profile_id']
        .some(key => Object.prototype.hasOwnProperty.call(variables, key));
    const isListOperation = /followers|following|edge_followed_by|edge_follow/i.test(source);
    const isProfileHelperOperation = /Polaris(?:ProfileNoteBubble|ProfileStoryHighlights|ProfileSuggestedUsers|SchoolPartnerProfileBadge|ProfilePosts|ProfileDirectOrPartnershipInbox|QuickPromotion)/i.test(friendlyName);
    const isProfilePath = /^\/[^/?#]+\/?$/.test(window.location.pathname) &&
      !/^(accounts|explore|direct|reels?|stories|p|about)$/i.test(
        window.location.pathname.replace(/^\/|\/$/g, ''),
      );
    const isProfileOperation = !isProfileHelperOperation &&
      /PolarisProfilePageContent|profile.?page.?content|profile.?query|user.?info|user.?profile/i.test(source);
    const isProfile = !isListOperation && (
      isProfileOperation ||
      Boolean(hasProfileIdentity && (isProfilePath || /profile|user.?info/i.test(source)))
    );
    return {
      doc_id: docId,
      friendly_name: friendlyName,
      variables: variables && typeof variables === 'object' && !Array.isArray(variables)
        ? variables
        : null,
      is_profile: isProfile,
    };
  };

  const emitGraphQLRequest = (url, body) => {
    try {
      const request = parseGraphQLRequest(url, body);
      if (!request) return;
      const detail = JSON.stringify(request);
      if (request.is_profile || isTrackedDocIdOperation(request.friendly_name)) {
        document.documentElement?.setAttribute(
          'data-takipci-panel-graphql-request',
          detail.slice(0, 300000),
        );
      }
      document.dispatchEvent(new CustomEvent('takipci-panel:graphql-request', {
        detail,
      }));
    } catch {
      // Never interfere with Instagram's own request handling.
    }
  };

  const normalizeFollowUser = (value) => {
    if (!value || typeof value !== 'object') return null;
    const user = value.user_dict ?? value.user ?? value.node ?? value;
    const pk = String(user.pk ?? user.id ?? user.fbid_v2 ?? '').trim();
    const username = String(user.username ?? '').trim();
    if (!pk || !username) return null;
    const profilePhoto = [
      user.profile_pic_url_hd,
      user.hd_profile_pic_url_info?.url,
      user.hd_profile_pic_info?.url,
      user.profile_pic_url,
    ]
      .map(photo => String(photo ?? '').trim())
      .find(photo => /^https?:\/\//i.test(photo)) || '';
    return {
      pk,
      username,
      full_name: user.full_name ?? '',
      biography: user.biography ?? user.bio ?? '',
      profile_pic_url: profilePhoto,
      profile_pic_url_hd: profilePhoto,
      is_private: user.is_private ?? false,
      is_verified: user.is_verified ?? false,
      follower_count: user.follower_count,
      following_count: user.following_count,
    };
  };

  const dedupeFollowUsers = (values) => {
    const users = [];
    const seen = new Set();
    for (const value of values) {
      const user = normalizeFollowUser(value);
      if (!user || seen.has(user.pk)) continue;
      seen.add(user.pk);
      users.push(user);
    }
    return users;
  };

  const isUserLike = (value) =>
    value && typeof value === 'object' &&
    (value.pk != null || value.id != null || value.fbid_v2 != null) &&
    (value.username != null || value.follower_count != null ||
      value.following_count != null || value.profile_pic_url != null);

  const collectUsers = (value, users, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 10) return;
    const candidate = value.user_dict ?? value.user ?? value.node ?? value;
    if (isUserLike(candidate)) users.push(candidate);
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') collectUsers(child, users, depth + 1);
    }
  };

  const findLegacyCursor = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 10) return null;
    if (Array.isArray(value)) {
      for (const child of value) {
        const cursor = findLegacyCursor(child, depth + 1);
        if (cursor) return cursor;
      }
      return null;
    }
    for (const key of ['next_max_id', 'nextMaxId', 'max_id']) {
      if (value[key] != null && String(value[key])) return String(value[key]);
    }
    for (const child of Object.values(value)) {
      const cursor = findLegacyCursor(child, depth + 1);
      if (cursor) return cursor;
    }
    return null;
  };

  const inferFollowKind = (url, requestText, payload) => {
    const pathKind = String(window.location.pathname)
      .match(/\/(followers|following)\/?/i)?.[1];
    if (pathKind) return pathKind.toLowerCase();
    const source = `${url} ${requestText} ${JSON.stringify(payload).slice(0, 50000)}`.toLowerCase();
    if (/followers|follower|edge_followed_by|followed_by/.test(source)) return 'followers';
    if (/following|edge_follow(?:["'_:]|$)/.test(source)) return 'following';
    return '';
  };

  function emitFollowList(url, payload, requestText = '') {
    try {
      if (!payload) return;

      const directUsers = Array.isArray(payload.users) ? payload.users : [];
      const nestedUsers = [];
      if (!directUsers.length) collectUsers(payload, nestedUsers);
      const users = dedupeFollowUsers(directUsers.length ? directUsers : nestedUsers);

      // A profile response can contain one or two users. Require multiple
      // users so profile/bootstrap responses are not mistaken for a list.
      if (users.length < 2) return;

      const kind = inferFollowKind(url, requestText, payload);
      if (!kind) return;
      const endpointOwner = String(url || '').match(
        /\/api\/v1\/friendships\/(\d+)\/(?:followers|following)\//i,
      )?.[1] ?? '';
      const routeOwner = String(window.location.pathname || '').match(
        /^\/([^/?#]+)\/(?:followers|following)\/?$/i,
      )?.[1] ?? '';

      const detail = JSON.stringify({
        kind,
        users,
        next_max_id: isFollowListUrl(url) ? findLegacyCursor(payload) : null,
        ownerId: endpointOwner,
        ownerUsername: routeOwner,
      });

      // The page bridge runs at document_start while the isolated content
      // script runs at document_idle. Keep a DOM handoff for late listeners.
      document.documentElement?.setAttribute(
        'data-takipci-panel-follow-list',
        detail.slice(0, 300000),
      );
      document.dispatchEvent(new CustomEvent('takipci-panel:follow-list', {
        detail,
      }));
    } catch {
      // Never interfere with Instagram's own request handling.
    }
  }

  const emit = (url, payload) => {
    try {
      if (!interestingUrl(url) || !payload) return;
      const users = [];
      collectUsers(payload, users);
      if (!users.length) return;
      const serialized = JSON.stringify({ url, users });
      document.documentElement?.setAttribute('data-takipci-panel-user', serialized);
      document.dispatchEvent(new CustomEvent('takipci-panel:instagram-response', {
        detail: serialized,
      }));
    } catch {
      // Never interfere with Instagram's own request handling.
    }
  };

  const nativeFetch = window.fetch;
  const readCookie = (name) => {
    try {
      return document.cookie
        .split(';')
        .map(value => value.trim())
        .find(value => value.startsWith(`${name}=`))
        ?.slice(name.length + 1) ?? '';
    } catch {
      return '';
    }
  };
  const readWwwClaim = () => {
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
  };

  // Requests made by the isolated extension world can be rejected by
  // Instagram with "useragent mismatch". Reuse the page's original fetch for
  // the viewer endpoint so the browser supplies the same page request context
  // as Instagram's own code.
  document.addEventListener('takipci-panel:page-fetch', (event) => {
    let request;
    try {
      request = JSON.parse(String(event.detail ?? ''));
    } catch {
      return;
    }
    let requestPath = '';
    try {
      requestPath = new URL(request.endpoint, window.location.href).pathname;
    } catch {
      return;
    }
    const allowedPath =
      /\/api\/v1\/accounts\/current_user\/?$/i.test(requestPath) ||
      /^\/api\/v1\/(?:friendships\/\d+\/(?:followers|following|mutual_followers)\/?|feed\/user\/(?:\d+\/?|[a-z0-9._]+\/username\/?))$/i
        .test(requestPath);
    if (!request?.id || !allowedPath ||
        String(request.method || 'GET').toUpperCase() !== 'GET') {
      return;
    }

    const respond = (payload) => {
      document.dispatchEvent(new CustomEvent('takipci-panel:page-fetch-response', {
        detail: JSON.stringify({ id: request.id, ...payload }),
      }));
    };

    (async () => {
      try {
        const url = new URL(request.endpoint, window.location.href);
        for (const [key, value] of Object.entries(request.params || {})) {
          if (value != null) url.searchParams.set(key, String(value));
        }
        const wwwClaim = readWwwClaim();
        const response = await nativeFetch(url.href, {
          method: request.method || 'GET',
          credentials: 'include',
          headers: {
            Accept: '*/*',
            'X-Requested-With': 'XMLHttpRequest',
            'X-IG-App-ID': '936619743392459',
            'X-ASBD-ID': '359341',
            'X-IG-Max-Touch-Points': String(navigator.maxTouchPoints || 0),
            'X-CSRFToken': readCookie('csrftoken'),
            'Referer': 'https://www.instagram.com/',
            ...(wwwClaim ? { 'X-IG-WWW-Claim': wwwClaim } : {}),
          },
        });
        const text = await response.text();
        const cleaned = text.replace(/^for\s*\(;;\);\s*/, '').trim();
        let data = null;
        try { data = JSON.parse(cleaned); } catch {}
        if (!response.ok || !data) {
          const responseContentType = response.headers.get('content-type') || '';
          const rawReason = data?.message
            ?? data?.error?.message
            ?? data?.error_title
            ?? data?.error_type
            ?? data?.error;
          const htmlTitle = cleaned.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
          const responseReason = rawReason != null
            ? (typeof rawReason === 'string' ? rawReason : JSON.stringify(rawReason)).slice(0, 240)
            : cleaned.startsWith('<')
              ? (htmlTitle ? `HTML yanıtı: ${htmlTitle}` : `HTML yanıtı (${cleaned.length} karakter)`)
              : cleaned.slice(0, 240);
          respond({
            ok: false,
            status: response.status,
            statusText: response.statusText || '',
            retryAfter: response.headers.get('retry-after') || '',
            responseContentType,
            responseReason: responseReason || 'Sunucu yanıt gövdesi boş',
            endpoint: url.pathname,
            error: response.status === 429
              ? `Instagram istek sınırı uyguladı (HTTP 429): ${responseReason || 'neden belirtilmemiş'}`
              : `HTTP ${response.status}: ${responseReason || 'yanıt ayrıntısı yok'}`,
          });
          return;
        }
        respond({ ok: true, status: response.status, data });
      } catch (error) {
        respond({ ok: false, error: error?.message || String(error) });
      }
    })();
  });

  if (typeof nativeFetch === 'function') {
    window.fetch = function takipciPanelFetch(...args) {
      const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
      const requestObject = args[0] instanceof Request ? args[0] : null;
      const requestText = (() => {
        try {
          const requestBody = args[1]?.body;
          return typeof requestBody === 'string'
            ? requestBody
            : requestBody?.toString?.() ?? '';
        } catch {
          return '';
        }
      })();

      emitGraphQLRequest(requestUrl, args[1]?.body);
      // Relay sometimes calls fetch(new Request(url, { body })). The body is
      // not present in the second fetch argument, so inspect a clone without
      // consuming the Request that Instagram is about to send.
      if (requestObject && isGraphQLUrl(requestUrl)) {
        try {
          requestObject.clone().text().then(text => {
            emitGraphQLRequest(requestUrl, text);
          }).catch(() => {});
        } catch {}
      }
      const requestResult = nativeFetch.apply(this, args);
      requestResult.then((response) => {
        const responseUrl = requestUrl || response.url;
        if (isFollowListUrl(responseUrl) || isGraphQLUrl(responseUrl)) {
          response.clone().text().then((text) => {
            try {
              const payload = JSON.parse(text.replace(/^for\s*\(;;\);\s*/, ''));
              emitFollowList(responseUrl, payload, requestText);
            } catch {}
          });
        }
        if (!interestingUrl(responseUrl)) return;
        response.clone().text().then((text) => {
          try {
            emit(responseUrl, JSON.parse(text.replace(/^for\s*\(;;\);\s*/, '')));
          } catch {}
        });
      }).catch(() => {});
      return requestResult;
    };
  }

  const NativeXHR = window.XMLHttpRequest;
  if (typeof NativeXHR === 'function') {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function takipciPanelOpen(method, url, ...rest) {
      this.__takipciPanelUrl = String(url ?? '');
      return nativeOpen.call(this, method, url, ...rest);
    };
    NativeXHR.prototype.send = function takipciPanelSend(...args) {
      try {
        this.__takipciPanelBody = typeof args[0] === 'string'
          ? args[0]
          : args[0]?.toString?.() ?? '';
      } catch {
        this.__takipciPanelBody = '';
      }
      emitGraphQLRequest(this.__takipciPanelUrl, args[0]);
      this.addEventListener('load', () => {
        const url = this.__takipciPanelUrl || this.responseURL || '';
        if (isFollowListUrl(url) || /\/(?:api\/graphql|graphql\/query)(?:\?|$)/i.test(url)) {
          try {
            emitFollowList(
              url,
              JSON.parse(String(this.responseText).replace(/^for\s*\(;;\);\s*/, '')),
              this.__takipciPanelBody,
            );
          } catch {}
        }
        if (!interestingUrl(url)) return;
        try {
          emit(url, JSON.parse(String(this.responseText).replace(/^for\s*\(;;\);\s*/, '')));
        } catch {}
      });
      return nativeSend.apply(this, args);
    };
  }
})();