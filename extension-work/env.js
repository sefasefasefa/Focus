/*
 * Extension configuration.
 * Add your own Gemini API key below. Keep this file private: extension files
 * contain the key in plain text and anyone who receives them can read it.
 */
globalThis.__TAKIPCI_ENV__ = Object.freeze({
  GENDER_PROVIDER: 'gemini',
  GEMINI_API_KEY: '',
  GEMINI_MODEL: 'gemini-3.5-flash-lite',
  GEMINI_BATCH_SIZE: 5,
  GEMINI_MIN_REQUEST_INTERVAL_MS: 5000,
  // Optional endpoint for Genderize mode; not used by Gemini.
  AI_API_URL: '',
  MISTRAL_API_KEY: '',
  GENDERIZE_COUNTRY_ID: 'TR',
  GENDERIZE_BATCH_SIZE: 10,
  GENDERIZE_MIN_REQUEST_INTERVAL_MS: 300,
  MISTRAL_VISION_MODEL: 'mistral-small-2603',
  // Provider-specific limits override this shared fallback.
  AI_MIN_REQUEST_INTERVAL_MS: 1100,
  GENDER_CONFIDENCE_THRESHOLD: 0.75,
});