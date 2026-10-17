---
name: Instagram session diagnostics
description: Distinguish a saved server-side Instagram session from the upstream response to an API probe.
---

A session shown as linked in the license center means the server has a saved session snapshot; it does not guarantee every Instagram API endpoint will accept a server-side request or that the browser still exposes a current sessionid cookie. The extension reads cookies through Chrome's cookies API and syncs them to the server; it must never download raw cookies back from the server. A 302 from an API probe alone is not evidence that the saved session should be deleted and linked again.

**Why:** The user showed a successful linked-session status while an Instagram current-user request returned HTTP 302 to the homepage. Advising unlink/relink contradicted the UI and could disrupt an otherwise saved session.

**How to apply:** Explain whether the failure is local cookie access, session storage, or an upstream Instagram request. Distinguish a genuinely absent sessionid from a Chrome cookie-read error. Do not recommend deleting/relinking a session solely because a current-user probe redirects to `/`; say clearly when the server still reports the session as linked.
