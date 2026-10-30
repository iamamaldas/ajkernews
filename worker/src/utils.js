// worker/src/utils.js

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

// ✅ নতুন ফাংশন: হেডলাইন থেকে SEO ফ্রেন্ডলি URL স্লাগ তৈরি করা
export function createSlug(text) {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/[^\u0980-\u09FFa-z0-9\s-]/g, "") // বাংলা/ইংরেজি অক্ষর, সংখ্যা ও স্পেস ছাড়া বাকি সব বাদ
    .trim()
    .replace(/\s+/g, "-") // স্পেসকে হাইফেনে রূপান্তর
    .substring(0, 65) // সর্বোচ্চ ৬৫ অক্ষর
    .replace(/-+$/, ""); // শেষের অতিরিক্ত হাইফেন বাদ
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
      const topic = row.headline.split("|")[0].trim(); // হেডলাইনের প্রথম অংশ
      rowSlug = createSlug(`${shortDate}-${topic}`);
    } else {
      // নিউজের ক্ষেত্রে: "amdedabade-rupo-chennai-sona"
      rowSlug = createSlug(row.headline);
    }

    if (rowSlug === slug) {
      return row.id; 
    }
  }
  return null;
}
