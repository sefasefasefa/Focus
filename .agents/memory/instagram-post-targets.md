---
name: Dynamic Instagram targets
description: The extension's target Instagram account changes frequently and post retrieval must remain account-dynamic.
---

The target account changes frequently; post retrieval must use the current target username rather than a fixed account.

**Why:** the user explicitly stated this requirement.

**How to apply:** when changing Instagram post retrieval or selection, derive the username from the current candidate for every request; do not pin it to the logged-in profile or a single target.
