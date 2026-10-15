import {
  classifyGenderUsers,
  getStoredGenderLabel,
  normalizeGender,
} from './gender-logic.js';

async function getGenderLabel(user) {
  const stored = await new Promise(resolve =>
    chrome.storage.local.get(['__ai_gender_labels_v1'], resolve)
  );
  return getStoredGenderLabel(stored.__ai_gender_labels_v1, user) || {
    gender: 'unknown', confidence: 0, source: 'unknown',
  };
}

globalThis.classifyGenderUsers = classifyGenderUsers;
globalThis.getGenderLabel = getGenderLabel;