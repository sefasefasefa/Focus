---
name: Instagram request session diagnostics
description: Diagnose the current browser session and transient Instagram API request flow.
---

The license center reports whether the extension can read the current browser session; it does not report a saved server session. The extension sends fresh cookies with each licensed Instagram operation. The API neither persists those cookies nor searches for an earlier session. An Instagram redirect or login error should be diagnosed against the current browser cookies and upstream response.

**Why:** The user chose a request-scoped session flow so the API receives all operation data from the extension and has no stored Instagram session to look up.

**How to apply:** Separate local cookie-read failures from upstream Instagram responses. Do not suggest unlinking a server session; no server-side session exists. A redirect alone does not prove the browser is logged out, so check the current browser login and report the actual upstream status.
