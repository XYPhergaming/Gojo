const axios = require('axios');
const config = require('./api');

async function identifyAnime(base64Image) {
  const prompt = `You are a strict Japanese Anime & Manga verification system.
RULES:
1. Is this genuinely a Japanese anime, manga, anime-style art, fan-art, or cosplay?
2. If it's a real photo or Western cartoon, set isAnime: false.
3. If it IS anime, identify exact title with 85%+ confidence. If unsure, set false.
4. Return JSON: {"isAnime":bool,"confidence":number,"animeTitle":string|null,"character":string|null,"rejectionReason":string|null}`;

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${config.gemini}`,
    {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: base64Image } }
        ]
      }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );

  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    return { isAnime: false, confidence: 0, rejectionReason: 'Could not parse response.' };
  }
}

module.exports = { identifyAnime };