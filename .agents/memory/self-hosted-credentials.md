---
name: Self-hosted credentials
description: Product boundary for credential storage and extension distribution.
---

API-provider keys, license-signing/data secrets, and payment/webhook credentials must stay on the owner's self-hosted API server. The customer distribution contains the browser extension separately; it must not include those credentials or the API server.

Every extension operation and operational data-ingestion message must require a fresh server-side license check; the server validates the signed device token, revocation/payment status, and license expiry on each protected API request. Only public plan/status reads and local logout/cleanup are exempt.

Instagram sessions are linked only after explicit user consent, synchronized from the user's browser, encrypted and isolated by license order and device on the server, and used by the server-side Instagram proxy. Do not download raw session cookies from the server back into the extension.

**Why:** The user requires every operation to pass license validation, with licenses assigned through tokens and enforced expiration; the server-proxy architecture also ensures follow/like actions use each user's own isolated session without copying raw cookies back to the extension.

**How to apply:** Gate every extension message that reads, writes, or acts on operational data through a fresh server license check; protect every business API route with token, revocation/payment, device, and expiry validation. Keep only public plan/status reads and local logout/cleanup outside the gate. Route provider requests through `self-hosted-api`; never put provider or payment secrets in extension files. Preserve explicit consent, per-order/device isolation, encryption, and server-side Instagram request execution.

The extension must not ask users for a Shopier order number during account registration or license activation. Use the paid order recorded by the signed webhook and verify mailbox access for its buyer email.

**Why:** The user explicitly said customers should not have to enter the Shopier order number during registration or similar flows.

**How to apply:** Keep order IDs as server-side payment-record keys only; identify eligible purchases through the webhook-recorded buyer email and require proof of mailbox access before creating an account or issuing a device license.

Each email account receives one 7-day free trial after email verification. After expiry, block licensed extension operations and direct the user to a configured monthly Shopier plan; do not accept non-monthly products for paid access.

**Why:** The user wants anyone to create an account and use the product free for one week, then require a monthly purchase to continue.

**How to apply:** Start the trial when verified signup creates the account, enforce expiry server-side on every protected operation, and show only a valid 30-day checkout option after expiry.

Account access uses a normal email-and-password login; purchases happen on a separate monthly checkout page. The buyer must use the account email so the signed payment webhook can grant the paid entitlement to that account. After payment, refresh the account entitlement instead of asking for a purchase email code or order number.

**Why:** The user wants ordinary account credentials, a distinct purchase page, and paid access to replace the trial restriction automatically.

**How to apply:** Keep login and registration in the account flow, keep Shopier checkout separate, match paid orders to the verified account email, and refresh the device license from the authenticated account session after webhook confirmation.

Paid monthly access unlocks all licensed extension operations without a device-count cap; the 30-day subscription term and Instagram/platform request limits still apply.

**Why:** The user wants usage limits removed after a successful monthly purchase.

**How to apply:** Enforce the trial device cap only for trial entitlements. Continue checking subscription expiry and upstream/platform safety limits for paid accounts.
