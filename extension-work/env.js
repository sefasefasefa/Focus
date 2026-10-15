/*
 * Public, non-secret extension settings only.
 * Provider keys, model selection, license signing secrets, and payment
 * credentials belong in self-hosted-api/.env and must never be placed here.
 */
globalThis.__TAKIPCI_ENV__ = Object.freeze({
  LICENSE_API_BASE_URL: "http://127.0.0.1:8787",
  GENDER_CONFIDENCE_THRESHOLD: 0.75,
});