// worker/src/utils.js
// ✅ FINAL v84: Bengali to English Transliteration for SEO URLs

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

export function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

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

// ═══════════════════════════════════════════════════════════
// ✅ বাংলা থেকে ইংরেজি অক্ষরে রূপান্তরের ম্যাপ
// ═══════════════════════════════════════════════════════════
const BN_TO_EN_MAP = { 
  "অ":"o","আ":"a","ই":"i","ঈ":"i","উ":"u","ঊ":"u","ঋ":"ri","এ":"e","ঐ":"oi","ও":"o","ঔ":"ou",
  "ক":"k","খ":"kh","গ":"g","ঘ":"gh","ঙ":"ng","চ":"ch","ছ":"chh","জ":"j","ঝ":"jh","ঞ":"n",
  "ট":"t","ঠ":"th","ড":"d","ঢ":"dh","ণ":"n","ত":"t","থ":"th","দ":"d","ধ":"dh","ন":"n",
  "প":"p","ফ":"ph","ব":"b","ভ":"bh","ম":"m","য":"j","র":"r","ল":"l","শ":"sh","ষ":"sh",
  "স":"s","হ":"h","ড়":"r","ঢ়":"rh","য়":"y","ং":"ng","ঃ":"h","ঁ":"n",
  "া":"a","ি":"i","ী":"i","ু":"u","ূ":"u","ৃ":"ri","ে":"e","ৈ":"oi","ো":"o","ৌ":"ou"
};

export function toTransliterated(text) {
  if (!text) return "";
  let result = "";
  for (const char of String(text)) result += BN_TO_EN_MAP[char] || char;
  return result.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// ✅ নতুন ফাংশন: হেডলাইন থেকে SEO ফ্রেন্ডলি URL স্লাগ তৈরি করা
export function createSlug(text) {
  if (!text) return "";
  
  // ১. বাংলা অক্ষরকে ইংরেজিতে রূপান্তর
  let transliterated = "";
  for (const char of String(text)) {
    transliterated += BN_TO_EN_MAP[char] || char;
  }

  // ২. ক্লিন এবং হাইফেন তৈরি
  return transliterated
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // শুধু ইংরেজি অক্ষর, সংখ্যা এবং স্পেস রাখবে
    .trim()
    .replace(/\s+/g, "-") // স্পেসকে হাইফেনে রূপান্তর
    .substring(0, 65) // সর্বোচ্চ ৬৫ অক্ষর
    .replace(/-+$/, ""); // শেষের বাড়তি হাইফেন বাদ
}

// ✅ নতুন ফাংশন: URL-এর স্লাগ দিয়ে ডাটাবেস থেকে আসল ৩২-অক্ষরের ID বের করা
export async function getNewsIdBySlug(db, slug, isQuiz = false) {
  const typeCondition = isQuiz ? "AND type = 'quiz'" : "AND type = 'news'";
  const rows = await db.prepare(`SELECT id, headline, created_at FROM news WHERE status = 'published' ${typeCondition} ORDER BY created_at DESC LIMIT 500`).all();
  
  for (const row of (rows.results || [])) {
    let rowSlug = "";
    
    if (isQuiz) {
      // কুইজের ক্ষেত্রে: "28-oct-2026-2024-t20-world-cup"
      const d = new Date(row.created_at);
      const options = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' };
      const shortDate = d.toLocaleDateString('en-GB', options).replace(/\s+/g, '-').toLowerCase();
      const topic = row.headline.split("|")[0].trim(); 
      rowSlug = createSlug(`${shortDate}-${topic}`);
    } else {
      // নিউজের ক্ষেত্রে: "amedabade-rupo-ebong-chennai-o-joypure-sonar-dam"
      rowSlug = createSlug(row.headline);
    }

    if (rowSlug === slug) {
      return row.id; 
    }
  }
  return null;
}
