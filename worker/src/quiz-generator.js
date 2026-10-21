// worker/src/quiz-generator.js

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TIMEOUT_MS = 20000;

const QUIZ_PROMPT = `You are a quiz master for a Bengali news website. Create 15 multiple-choice questions for today's daily quiz.

TOPIC: Based on Google Trends and recent news from India and West Bengal (Politics, Sports, Entertainment, Business, Technology).

REQUIREMENTS:
- Each question must have 4 options.
- Only 1 option is correct.
- Provide a short explanation for the correct answer.
- Language: Bengali (বাংলা).
- Return JSON array with this exact structure:
[
  {
    "id": 1,
    "question": "প্রশ্ন...",
    "options": ["অপশন A", "অপশন B", "অপশন C", "অপশন D"],
    "correct": 0,
    "explanation": "ব্যাখ্যা..."
  }
]
- 'correct' is the index (0-3) of the correct option.
- Do NOT include any markdown or extra text. Return ONLY valid JSON.
`;

export async function generateDailyQuiz(apiKey) {
  if (!apiKey) {
    console.warn("[QUIZ] No Gemini API Key");
    return null;
  }

  const models = ["gemini-2.0-flash", "gemini-1.5-flash"];
  
  for (const model of models) {
    try {
      const result = await callGemini(model, apiKey);
      if (result && Array.isArray(result) && result.length === 15) {
        return result;
      }
    } catch (error) {
      console.warn(`[QUIZ] Model ${model} failed:`, error.message);
    }
  }
  return null;
}

async function callGemini(model, apiKey) {
  const endpoint = `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: QUIZ_PROMPT }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`API ${response.status}`);

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Empty response");

    let parsed;
    try { parsed = JSON.parse(text); } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error("JSON parse failed");
    }
    return parsed;
  } finally {
    clearTimeout(timeoutId);
  }
}
