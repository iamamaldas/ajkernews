// worker/src/facts.js
// ═══════════════════════════════════════════════════════════
// 🔄 UPDATE RULES:
// নতুন তথ্য যোগ করতে হলে:
//   ১. CURRENT_FACTS এ নতুন block যোগ করুন (নিচে template আছে)
//   ২. FORBIDDEN_PATTERNS এ নতুন regex যোগ করুন (নিচে template আছে)
// ═══════════════════════════════════════════════════════════


// ───────────────────────────────────────────────────────────
// ১. CURRENT FACTS (সঠিক তথ্য — prompt এ যাবে)
// ───────────────────────────────────────────────────────────
// টেমপ্লেট:
// "Position Name": {
//   correct: "English Name",
//   bengali: "বাংলা নাম",
//   wrong: ["পুরনো নাম ১", "পুরনো নাম ২"],
//   since: "২০২৬"
// },
// ───────────────────────────────────────────────────────────

export const CURRENT_FACTS = {

  // ─── পশ্চিমবঙ্গ ───
  "West Bengal Chief Minister": {
    correct: "Suvendu Adhikari",
    bengali: "শুভেন্দু অধিকারী",
    wrong: ["Mamata Banerjee", "মমতা বন্দ্যোপাধ্যায়"],
    since: "2026"
  },

  // ─── ভারত ───
  "India Prime Minister": {
    correct: "Narendra Modi",
    bengali: "নরেন্দ্র মোদী",
    wrong: [],
    since: "2014"
  },
  "India President": {
    correct: "Droupadi Murmu",
    bengali: "দ্রৌপদী মুর্মু",
    wrong: ["Ram Nath Kovind", "রামনাথ কোবিন্দ"],
    since: "2022"
  },

  // ─── এখানে নতুন entry যোগ করুন ───
  // "নতুন পদ": {
  //   correct: "English Name",
  //   bengali: "বাংলা নাম",
  //   wrong: ["পুরনো নাম"],
  //   since: "2026"
  // },

};


// ───────────────────────────────────────────────────────────
// ২. FORBIDDEN PATTERNS (ভুল combination — reject হবে)
// ───────────────────────────────────────────────────────────
// টেমপ্লেট:
// /ভুল\s*নাম.{0,30}পদবি/i,
// /পদবি.{0,30}ভুল\s*নাম/i,
// ───────────────────────────────────────────────────────────

export const FORBIDDEN_PATTERNS = [

  // ─── পশ্চিমবঙ্গ CM (পুরনো নাম + মুখ্যমন্ত্রী) ───
  /মমতা\s*বন্দ্যোপাধ্যায়.{0,30}মুখ্যমন্ত্রী/i,
  /মুখ্যমন্ত্রী.{0,30}মমতা\s*বন্দ্যোপাধ্যায়/i,
  /Mamata\s*Banerjee.{0,30}Chief\s*Minister/i,
  /Chief\s*Minister.{0,30}Mamata\s*Banerjee/i,

  // ─── এখানে নতুন pattern যোগ করুন ───
  // /ভুল\s*নাম.{0,30}পদবি/i,
  // /পদবি.{0,30}ভুল\s*নাম/i,

];


// ───────────────────────────────────────────────────────────
// ৩. PROMPT BUILDER (এটাতে হাত দেবেন না)
// ───────────────────────────────────────────────────────────
export function buildFactsPromptBlock() {
  const lines = [];
  lines.push("⚠️ CRITICAL — CURRENT FACTS (as of 2026):");
  lines.push("Your training data may be OUTDATED. NEVER trust your own knowledge about office holders.");
  lines.push("");

  for (const [position, info] of Object.entries(CURRENT_FACTS)) {
    if (!info.correct) continue;
    lines.push(`• ${position}: ${info.correct} (${info.bengali})`);
    if (info.wrong?.length) {
      lines.push(`  ❌ WRONG / OUTDATED: ${info.wrong.join(", ")}`);
      lines.push(`  ⛔ NEVER write any of these as the current ${position}.`);
    }
  }

  lines.push("");
  lines.push("RULES:");
  lines.push("1. If a source article contradicts the above facts, PREFER THE SOURCE.");
  lines.push("2. If a source is silent about a position, DO NOT name anyone from your own memory.");
  lines.push("3. If unsure, write only the position title without a name.");
  lines.push("4. NEVER use your pretrained knowledge about current politicians.");
  return lines.join("\n");
}


// ───────────────────────────────────────────────────────────
// ৪. FORBIDDEN CHECK (এটাতে হাত দেবেন না)
// ───────────────────────────────────────────────────────────
export function hasForbiddenContent(text) {
  if (!text) return false;
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) {
      console.warn(`[FACTS] Forbidden pattern matched: ${pattern}`);
      return true;
    }
  }
  return false;
}
