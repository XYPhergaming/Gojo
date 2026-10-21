const axios = require('axios');
const config = require('./api');

async function recognizeAnime(base64Jpeg) {
  if (!config.gemini.key) throw new Error('GEMINI_KEY is not configured');
  if (!base64Jpeg) throw new Error('No image data');

  const prompt = [
    'You are a strict Japanese Anime and Manga verification system.',
    'RULES:',
    '1. Determine whether the image is genuinely a Japanese anime, manga, anime-style artwork, fan art, or cosplay.',
    '2. If it is a real-world photo, a car, an animal, a food item, or a Western cartoon, set isAnime to false.',
    '3. If it is anime, identify the exact title with at least 85 percent confidence. If confidence is lower, set isAnime to false.',
    '4. Respond with strict JSON only:',
    '{"isAnime":boolean,"confidence":number,"animeTitle":string|null,"character":string|null,"rejectionReason":string|null}'
  ].join('\n');

  const url = `${config.gemini.endpoint}?key=${config.gemini.key}`;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/jpeg', data: base64Jpeg } }
      ]
    }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
  };

  const res = await axios.post(url, body, { timeout: 60000 });
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    return { isAnime: false, confidence: 0, animeTitle: null, rejectionReason: 'Parse error' };
  }
}

module.exports = { recognizeAnime };