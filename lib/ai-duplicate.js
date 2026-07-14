import { getCachedPosts } from "./post-cache.js";

/** 用于比对是否重复发帖 */
export function normalizePostTextForCompare(text) {
  return String(text || "")
    .replace(/\$[A-Z0-9]{2,10}\b/gi, "")
    .replace(/#[^\s#]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isDuplicatePostText(candidate, existingTexts = []) {
  const norm = normalizePostTextForCompare(candidate);
  if (!norm || norm.length < 16) return false;
  for (const existing of existingTexts) {
    const other = normalizePostTextForCompare(existing);
    if (!other) continue;
    if (norm === other) return true;
    const minLen = Math.min(norm.length, other.length);
    if (minLen >= 40) {
      const headA = norm.slice(0, 80);
      const headB = other.slice(0, 80);
      if (norm.includes(headB) || other.includes(headA)) return true;
    }
  }
  return false;
}

export function getAccountPublishedTexts(accountId, limit = 40) {
  if (!accountId) return [];
  return getCachedPosts(accountId, { limit }).map((p) => p.text).filter(Boolean);
}
