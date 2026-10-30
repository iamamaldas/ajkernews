// worker/src/utils.js
// ✅ FINAL v88: Deterministic Quiz Slug (date-stripped, Worker+Browser consistent)

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

export function createSlug(text) {
  if (!text) return "";
  let transliterated = "";
  for (const char of String(text)) {
    transliterated += BN_TO_EN_MAP[char] || char;
  }
  return transliterated
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .substring(0, 65)
    .replace(/-+$/, "");
}

// ✅ হেডলাইন থেকে অপ্রয়োজনীয় তারিখ/প্রিফিক্স বাদ দেওয়ার ফাংশন
// নতুন ফরম্যাট সাপোর্ট করে: "২২ অক্টোবর ২০২৬ কারেন্ট অ্যাফেয়ার্স: <keyword> | সাধারণ জ্ঞান ২০২৬"
export function removeDatesFromTitle(title) {
  if (!title) return "";
  let clean = String(title).trim();
  // পুরনো ফরম্যাট "আজকের কুইজ:" বাদ
  clean = clean.replace(/আজকের কুইজ:?/gi, "").trim();
  // শুরুর ইংরেজি তারিখ বাদ (30 October 2026 / 30-Oct-2026)
  clean = clean.replace(/^[\d০-৯]{1,2}[\s-]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s-,]*[\d০-৯]{4}\s*/i, "");
  // শুরুর বাংলা তারিখ বাদ (৩০ অক্টোবর ২০২৬)
  clean = clean.replace(/^[\d০-৯]{1,2}[\s-]+(জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর)[\s-]*[\d০-৯]{4}\s*/i, "");
  // শুধু সংখ্যা তারিখ (30-10-2026)
  clean = clean.replace(/^[\d০-৯]{2}-[\d০-৯]{2}-[\d০-৯]{4}\s*/i, "");
  // "কারেন্ট অ্যাফেয়ার্স:" প্রিফিক্স বাদ
  clean = clean.replace(/^কারেন্ট\s*অ্যাফেয়ার্স:?\s*/i, "").trim();
  // "|" এর পরে সব বাদ (যেমন "| সাধারণ জ্ঞান ২০২৬")
  clean = clean.split("|")[0].trim();
  return clean.replace(/\s+/g, " ").trim();
}

// ✅ কুইজ স্লাগের জন্য ডিটারমিনিস্টিক short date (Worker ও Browser একই ফল দেবে)
export function getShortDate(createdAt) {
  const d = new Date(createdAt || Date.now());
  if (isNaN(d.getTime())) return "";
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

// ✅ কুইজের সম্পূর্ণ স্লাগ (তারিখ-বাদ দেওয়া টপিক সহ)
export function getQuizSlug(headline, createdAt) {
  const shortDate = getShortDate(createdAt);
  const cleanTopic = removeDatesFromTitle(headline || "");
  return createSlug(`${shortDate}-${cleanTopic}`);
}

export async function getNewsIdBySlug(db, slug, isQuiz = false) {
  const typeCondition = isQuiz ? "AND type = 'quiz'" : "AND type = 'news'";
  const rows = await db.prepare(`SELECT id, headline, created_at FROM news WHERE status = 'published' ${typeCondition} ORDER BY created_at DESC LIMIT 500`).all();
  
  for (const row of (rows.results || [])) {
    let rowSlug = "";
    
    if (isQuiz) {
      rowSlug = getQuizSlug(row.headline, row.created_at);
    } else {
      rowSlug = createSlug(row.headline);
    }

    if (rowSlug === slug) {
      return row.id; 
    }
  }
  return null;
}
