// worker/src/utils.js
// ✅ FIXED: cleanText, escapeHtml, base64url যোগ করা হয়েছে
// ❌ REMOVED: jsonResponse, errorResponse, getCronSlot (unused)

export function makeId() {
  return crypto.randomUUID();
}

export function getDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function normalizeText(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ✅ SHARED: cleanText — gemini.js, news-selector.js, index.js থেকে duplicate সরানো
export function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ✅ SHARED: escapeHtml — index.js থেকে duplicate সরানো
export function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ✅ FIXED: UTF-8 safe base64url (btoa Unicode bug fix)
export function base64url(input) {
  const str = typeof input === "string" ? input : JSON.stringify(input);
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
