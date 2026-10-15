---
name: Self-hosted credentials
description: Product boundary for credential storage and extension distribution.
---

API-provider keys, license-signing/data secrets, and payment/webhook credentials must stay on the owner's self-hosted API server. The customer distribution contains the browser extension separately; it must not include those credentials or the API server.

Instagram sessions are linked only after explicit user consent, synchronized from the user's browser, encrypted and isolated by license order and device on the server, and used by the server-side Instagram proxy. Do not download raw session cookies from the server back into the extension.

**Why:** The user chose the server-proxy architecture so follow/like actions use each user's own isolated session without copying raw cookies back to the extension.

**How to apply:** Route provider requests through `self-hosted-api`; never put provider or payment secrets in extension files. Preserve explicit consent, per-order/device isolation, encryption, and server-side Instagram request execution.
