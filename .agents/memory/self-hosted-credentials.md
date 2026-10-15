---
name: Self-hosted credentials
description: Product boundary for credential storage and extension distribution.
---

API-provider keys, license-signing/data secrets, and payment/webhook credentials must stay on the owner's self-hosted API server. The customer distribution contains the browser extension separately; it must not include those credentials or the API server.

**Why:** The user explicitly requires the API, licensing, and paid-access operations to run on their own computer, with only the browser extension distributed to customers.

**How to apply:** Route provider requests through `self-hosted-api`; never put provider or payment secrets in extension files. Keep Instagram browser-session operations in the user's browser.
