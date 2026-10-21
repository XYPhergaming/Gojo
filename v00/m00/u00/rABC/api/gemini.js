const PROMPT = `You are a strict Japanese Anime and Manga verification system.
Rules:
1. Decide if the image is genuinely Japanese anime, manga, anime-style art, fan-art, or cosplay.
2. If the image is a real-world photo, cars, pets, Western cartoon, logos, memes, or anything not anime-related, set isAnime to false.
3. If it is anime-related, only accept when you can identify the exact title with at least 85 percent confidence. Otherwise set isAnime to false.
4. Return JSON only: {"isAnime": bool, "confidence": number, "animeTitle": string or null, "character": string or null, "rejectionReason": string or null}`;

export async function scanWithGemini(base64Image) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [
      {
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: 'image/jpeg', data: base64Image } }
        ]
      }
    ],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  const text = (json && json.candidates && json.candidates[0] &&
    json.candidates[0].content && json.candidates[0].content.parts &&
    json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text) || '{}';
  const clean = String(text).replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    return {};
  }
}