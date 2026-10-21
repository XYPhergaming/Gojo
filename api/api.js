// api/api.js — Firebase Admin + all third-party API wrappers

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// ---- Firebase Admin init (once per cold start) ----
let serviceAccount = {};
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
} catch (e) {
  console.error('FIREBASE_SERVICE_ACCOUNT_JSON parse error:', e.message);
}

const adminApp = getApps().length ? getApps()[0] : initializeApp({
  credential: cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

export const adminDb = getFirestore(adminApp);
export const adminAuth = getAuth(adminApp);
export { FieldValue };

// ---- Public Firebase Web Config (safe to expose) ----
export const firebaseWebConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

// ---- Env accessors (secrets never leak to frontend) ----
const ENV = {
  IMGBB_KEY: process.env.IMGBB_KEY || '',
  GEMINI_KEY: process.env.GEMINI_KEY || '',
  ANILIST: process.env.ANILIST_GRAPHQL || 'https://graphql.anilist.co',
  MANGADEX: process.env.MANGADEX_API || 'https://api.mangadex.org',
  MANGADEX_COVERS: process.env.MANGADEX_COVERS || 'https://uploads.mangadex.org',
  TRACEMOE: process.env.TRACEMOE_API || 'https://api.trace.moe',
  KITSU: process.env.KITSU_API || 'https://kitsu.io/api/edge',
  RADIO: process.env.RADIO_BROWSER_API || 'https://de1.api.radio-browser.info',
  NEKOS: process.env.NEKOS_BEST_API || 'https://nekos.best/api/v2',
  NEWS_RSS: process.env.ANIME_NEWS_RSS || 'https://www.animenewsnetwork.com/all/rss.xml',
  PROXIES: [
    process.env.ALLORIGINS_PROXY || 'https://api.allorigins.win/raw?url=',
    process.env.CODETABS_PROXY || 'https://api.codetabs.com/v1/proxy?quest=',
    process.env.CORSPROXY || 'https://corsproxy.io/?url='
  ]
};

// ---- In-memory cache (Vercel warm instances) ----
const memCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function getCached(key) {
  const e = memCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { memCache.delete(key); return null; }
  return e.data;
}
function setCached(key, data) {
  if (memCache.size > 500) {
    const oldest = [...memCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 100);
    oldest.forEach(([k]) => memCache.delete(k));
  }
  memCache.set(key, { data, ts: Date.now() });
}

// ---- AniList ----
const MEDIA_FIELDS = `id idMal title{romaji english} coverImage{extraLarge large} bannerImage averageScore episodes description genres externalLinks{site url type}`;

async function anilistRaw(query, variables) {
  const r = await fetch(ENV.ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return r.json();
}

export async function anilistQuery(query, variables) {
  const key = 'al:' + JSON.stringify({ query, variables });
  const cached = getCached(key);
  if (cached) return cached;
  const data = await anilistRaw(query, variables);
  if (!data.errors) setCached(key, data);
  return data;
}

export async function fetchAnimeDetails(anilistId, malId) {
  const valid = (id) => id && /^\d+$/.test(String(id)) && String(id) !== '0';
  let q, v;
  if (valid(anilistId)) {
    q = `query($id:Int){Media(id:$id,type:ANIME){${MEDIA_FIELDS}}}`;
    v = { id: parseInt(anilistId, 10) };
  } else if (valid(malId)) {
    q = `query($malId:Int){Media(idMal:$malId,type:ANIME){${MEDIA_FIELDS}}}`;
    v = { malId: parseInt(malId, 10) };
  } else return null;
  const d = await anilistQuery(q, v);
  return d?.data?.Media || null;
}

export async function fetchTrendingAnime(page = 1) {
  const q = `query($page:Int){Page(page:$page,perPage:20){media(sort:POPULARITY_DESC,type:ANIME){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
  const d = await anilistQuery(q, { page });
  return d?.data?.Page?.media || [];
}

export async function searchAnime(filters) {
  const vars = {};
  const parts = ['type:ANIME', 'sort:POPULARITY_DESC'];
  const defs = [];
  if (filters.q) { defs.push('$search:String'); parts.push('search:$search'); vars.search = filters.q; }
  if (filters.genre) { defs.push('$genre:String'); parts.push('genre:$genre'); vars.genre = filters.genre; }
  if (filters.year) { defs.push('$year:Int'); parts.push('seasonYear:$year'); vars.year = filters.year; }
  if (filters.format) { defs.push('$format:MediaFormat'); parts.push('format:$format'); vars.format = filters.format; }
  if (filters.status) { defs.push('$status:MediaStatus'); parts.push('status:$status'); vars.status = filters.status; }
  if (filters.score) { defs.push('$score:Int'); parts.push('averageScore_greater:$score'); vars.score = filters.score; }
  const queryDef = defs.length ? `query(${defs.join(',')})` : '';
  const q = `${queryDef}{Page(page:1,perPage:50){media(${parts.join(',')}){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
  const d = await anilistQuery(q, vars);
  if (d?.errors) throw new Error('Search failed');
  return d?.data?.Page?.media || [];
}

export async function fetchSchedule(from, to) {
  const q = `query($from:Int,$to:Int){Page(page:1,perPage:50){airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){airingAt episode media{id idMal title{romaji english} coverImage{large}}}}}`;
  const d = await anilistQuery(q, { from, to });
  return d?.data?.Page?.airingSchedules || [];
}

export async function fetchSeasonal(season, year) {
  const q = `query($season:MediaSeason,$year:Int){Page(page:1,perPage:50){media(season:$season,seasonYear:$year,type:ANIME,sort:POPULARITY_DESC){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
  const d = await anilistQuery(q, { season, year });
  return d?.data?.Page?.media || [];
}

// ---- MangaDex ----
export async function fetchMangaTrending(page = 1) {
  const r = await fetch(`${ENV.MANGADEX}/manga?limit=20&offset=${(page - 1) * 20}&includes[]=cover_art&order[followedCount]=desc`);
  const d = await r.json();
  return d?.data || [];
}

export async function searchManga(q) {
  const r = await fetch(`${ENV.MANGADEX}/manga?title=${encodeURIComponent(q)}&limit=20&includes[]=cover_art&order[relevance]=desc`);
  const d = await r.json();
  return d?.data || [];
}

export async function fetchMangaDetails(id) {
  const r = await fetch(`${ENV.MANGADEX}/manga/${encodeURIComponent(id)}`);
  const d = await r.json();
  return d?.data || null;
}

// ---- trace.moe ----
export async function traceMoe(base64Image) {
  const buf = Buffer.from(base64Image, 'base64');
  const blob = new Blob([buf], { type: 'image/jpeg' });
  const fd = new FormData();
  fd.append('image', blob, 'upload.jpg');
  const r = await fetch(`${ENV.TRACEMOE}/search?anilistInfo`, { method: 'POST', body: fd });
  return r.json();
}

// ---- Gemini Vision ----
export async function geminiDetect(base64Image) {
  const prompt = `You are a strict Japanese Anime and Manga verification system.
RULES:
1. Is this genuinely a Japanese anime, manga, anime-style art, fan-art, or cosplay?
2. If it is a real photo or Western cartoon, set isAnime: false.
3. If it IS anime, identify exact title with 85%+ confidence. If unsure, set false.
4. Return JSON only: {"isAnime":bool,"confidence":number,"animeTitle":string|null,"character":string|null,"rejectionReason":string|null}`;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${ENV.GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: base64Image } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      })
    }
  );
  const j = await r.json();
  const txt = j.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return JSON.parse(txt.replace(/```json|```/g, '').trim());
}

// ---- ImgBB ----
export async function imgbbUpload(base64Image, name = 'avatar') {
  const fd = new FormData();
  fd.append('image', base64Image);
  fd.append('name', name);
  const r = await fetch(`https://api.imgbb.com/1/upload?key=${ENV.IMGBB_KEY}`, { method: 'POST', body: fd });
  const j = await r.json();
  if (!j.success) throw new Error('ImgBB upload failed');
  return j.data.url;
}

// ---- Kitsu episode title ----
export async function fetchKitsuEpisodeTitle(title, epNumber) {
  const key = `kitsu:${title}:${epNumber}`;
  const cached = getCached(key);
  if (cached) return cached;
  const sr = await fetch(`${ENV.KITSU}/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`);
  const sd = await sr.json();
  if (!sd.data?.length) return `Episode ${epNumber}`;
  const ki = sd.data[0].id;
  const er = await fetch(`${ENV.KITSU}/anime/${ki}/episodes?filter[number]=${epNumber}`);
  const ed = await er.json();
  const et = ed.data?.[0]?.attributes?.canonicalTitle || `Episode ${epNumber}`;
  setCached(key, et);
  return et;
}

// ---- Radio Browser ----
export async function fetchRadioStations() {
  const cached = getCached('radio:anime');
  if (cached) return cached;
  const r = await fetch(`${ENV.RADIO}/json/stations/bytag/anime?limit=40&hidebroken=true&is_https=true&lastcheckok=1`);
  const data = await r.json();
  const valid = (Array.isArray(data) ? data : []).filter(s => s.url_resolved && /^https?:\/\//i.test(s.url_resolved));
  setCached('radio:anime', valid);
  return valid;
}

// ---- Nekos ----
export async function fetchCelebrationGif() {
  try {
    const r = await fetch(`${ENV.NEKOS}/celebrate`);
    const d = await r.json();
    return d.results?.[0]?.url || '';
  } catch { return ''; }
}

// ---- Anime News RSS ----
export async function fetchAnimeNews() {
  const cached = getCached('news:ann');
  if (cached) return cached;
  let xml = null;
  for (const p of ENV.PROXIES) {
    try {
      const r = await fetch(p + encodeURIComponent(ENV.NEWS_RSS));
      if (!r.ok) continue;
      const t = await r.text();
      if (t && (t.includes('<rss') || t.includes('<feed') || t.includes('<channel'))) { xml = t; break; }
    } catch { continue; }
  }
  if (!xml) throw new Error('News fetch failed');
  setCached('news:ann', xml);
  return xml;
}