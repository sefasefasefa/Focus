---
name: Self-hosted credentials
description: Product boundary for credential storage and extension distribution.
---

API-provider keys, license-signing/data secrets, and payment/webhook credentials must stay on the owner's self-hosted API server. The customer distribution contains the browser extension separately; it must not include those credentials or the API server.

Every extension operation and operational data-ingestion message must require a fresh server-side license check; the server validates the signed device token, revocation/payment status, and license expiry on each protected API request. Only public plan/status reads and local logout/cleanup are exempt.

Instagram cookies are read from the current browser session and sent with each licensed operation. The API uses them only for that request and never stores or looks up a server-side Instagram session.

**Why:** The user explicitly chose request-scoped browser session data so the API does not search for or retain an Instagram session.

**How to apply:** Keep Instagram cookies out of persistent storage and logs. Read the current browser cookies for each Instagram API request and include them in that request body. Continue enforcing license, revocation/payment, device, and expiry checks server-side. Keep provider and payment secrets on the API server.

The extension must not ask users for a Shopier order number during account registration or license activation. Use the paid order recorded by the signed webhook and verify mailbox access for its buyer email.

**Why:** The user explicitly said customers should not have to enter the Shopier order number during registration or similar flows.

**How to apply:** Keep order IDs as server-side payment-record keys only; identify eligible purchases through the webhook-recorded buyer email and require proof of mailbox access before creating an account or issuing a device license.

Each email account receives one 7-day free trial after email verification. After expiry, block licensed extension operations and direct the user to a configured monthly Shopier plan; do not accept non-monthly products for paid access.

**Why:** The user wants anyone to create an account and use the product free for one week, then require a monthly purchase to continue.

**How to apply:** Start the trial when verified signup creates the account, enforce expiry server-side on every protected operation, and show only a valid 30-day checkout option after expiry.

The 7-day trial is tied only to a verified email address. Do not read, send, or store MAC addresses, and do not use hardware/device history or device counts to control trial eligibility. Preserve account sessions and active licenses while removing legacy MAC/trial-history data and obsolete stored Instagram cookies.

**Why:** The user chose verified-email-only trial eligibility and later changed Instagram credentials to request-scoped data that the API must not retain.

**How to apply:** Start one 7-day trial after verifying an email. Remove native hardware-identity collection, MAC consent, device-history checks, and trial device caps. Purge legacy MAC/trial-history records and old persisted Instagram cookies without clearing account sessions or active license-device records; retain existing account session IDs and use random per-install IDs for new sessions.

Account access uses a normal email-and-password login; purchases happen on a separate monthly checkout page. The buyer must use the account email so the signed payment webhook can grant the paid entitlement to that account. After payment, refresh the account entitlement instead of asking for a purchase email code or order number.

**Why:** The user wants ordinary account credentials, a distinct purchase page, and paid access to replace the trial restriction automatically.

**How to apply:** Keep login and registration in the account flow, keep Shopier checkout separate, match paid orders to the verified account email, and refresh the device license from the authenticated account session after webhook confirmation.

Paid monthly access unlocks all licensed extension operations without a device-count cap; the 30-day subscription term and Instagram/platform request limits still apply. Free trials also have no device-count cap.

**Why:** The user wants no device-based controls and trial eligibility based only on verified email.

**How to apply:** Do not enforce device-count limits for trial or paid access. Continue checking trial/subscription expiry and upstream/platform safety limits.
