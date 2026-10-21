const ANILIST_URL = 'https://graphql.anilist.co';
const MANGADEX_URL = 'https://api.mangadex.org';
const KITSU_URL = 'https://kitsu.io/api/edge';
const RADIO_URL = 'https://de1.api.radio-browser.info';
const NEKOS_URL = 'https://nekos.best/api/v2';
const TRACEMOE_URL = 'https://api.trace.moe';

const CACHE_TTL_MS = 20 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  if (cache.size > 500) cache.clear();
  cache.set(key, { data, ts: Date.now() });
}

export async function anilistQuery(query, variables) {
  const key = 'al:' + query + JSON.stringify(variables || {});
  const hit = cacheGet(key);
  if (hit) return hit;
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (!json.errors) cacheSet(key, json);
  return json;
}

export async function getTrendingAnime(page = 1) {
  const q = `query($page:Int){Page(page:$page,perPage:20){media(sort:POPULARITY_DESC,type:ANIME){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
  return anilistQuery(q, { page });
}

export async function searchAnime({ search, genre, year, format, status, score, page = 1 }) {
  const vars = {};
  const defs = [];
  const args = ['type:ANIME', 'sort:POPULARITY_DESC'];
  if (search) { defs.push('$search:String'); args.push('search:$search'); vars.search = search; }
  if (genre) { defs.push('$genre:String'); args.push('genre:$genre'); vars.genre = genre; }
  if (year) { defs.push('$year:Int'); args.push('seasonYear:$year'); vars.year = parseInt(year, 10); }
  if (format) { defs.push('$format:MediaFormat'); args.push('format:$format'); vars.format = format; }
  if (status) { defs.push('$status:MediaStatus'); args.push('status:$status'); vars.status = status; }
  if (score) { defs.push('$score:Int'); args.push('averageScore_greater:$score'); vars.score = parseInt(score, 10); }
  const q = `query(${defs.join(',')}){Page(page:${parseInt(page, 10)},perPage:50){media(${args.join(',')}){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
  return anilistQuery(q, vars);
}

export async function getAnimeDetails({ id, malId }) {
  const numeric = (v) => v && /^\d+$/.test(String(v));
  let q, v;
  if (numeric(id)) {
    q = `query($id:Int){Media(id:$id,type:ANIME){id idMal title{romaji english} coverImage{extraLarge large} bannerImage averageScore episodes description genres externalLinks{site url type}}}`;
    v = { id: parseInt(id, 10) };
  } else if (numeric(malId)) {
    q = `query($malId:Int){Media(idMal:$malId,type:ANIME){id idMal title{romaji english} coverImage{extraLarge large} bannerImage averageScore episodes description genres externalLinks{site url type}}}`;
    v = { malId: parseInt(malId, 10) };
  } else {
    return null;
  }
  const data = await anilistQuery(q, v);
  return (data && data.data && data.data.Media) || null;
}

export async function getAiringSchedule() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const from = Math.floor(start.getTime() / 1000);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const to = Math.floor(end.getTime() / 1000);
  const q = `query($from:Int,$to:Int){Page(page:1,perPage:50){airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){airingAt episode media{id idMal title{romaji english} coverImage{large}}}}}`;
  return anilistQuery(q, { from, to });
}

export async function getSeasonal(season, year) {
  const q = `query($season:MediaSeason,$year:Int){Page(page:1,perPage:50){media(season:$season,seasonYear:$year,type:ANIME,sort:POPULARITY_DESC){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
  return anilistQuery(q, { season, year: parseInt(year, 10) });
}

export async function searchManga(query, limit = 20) {
  const url = `${MANGADEX_URL}/manga?title=${encodeURIComponent(query)}&limit=${limit}&includes[]=cover_art&order[relevance]=desc`;
  const res = await fetch(url);
  return res.json();
}

export async function trendingManga(page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  const url = `${MANGADEX_URL}/manga?limit=${limit}&offset=${offset}&includes[]=cover_art&order[followedCount]=desc`;
  const res = await fetch(url);
  return res.json();
}

export async function getMangaDetails(id) {
  const res = await fetch(`${MANGADEX_URL}/manga/${encodeURIComponent(id)}`);
  return res.json();
}

export async function getEpisodeTitle(malId, title, episodeNumber) {
  if (!title) return `Episode ${episodeNumber}`;
  const key = `kitsu:${title}:${episodeNumber}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  try {
    const sr = await fetch(`${KITSU_URL}/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`);
    const sd = await sr.json();
    if (sd && sd.data && sd.data.length) {
      const id = sd.data[0].id;
      const er = await fetch(`${KITSU_URL}/anime/${id}/episodes?filter[number]=${episodeNumber}`);
      const ed = await er.json();
      let name = `Episode ${episodeNumber}`;
      if (ed && ed.data && ed.data.length && ed.data[0].attributes && ed.data[0].attributes.canonicalTitle) {
        name = ed.data[0].attributes.canonicalTitle;
      }
      cacheSet(key, name);
      return name;
    }
  } catch {}
  return `Episode ${episodeNumber}`;
}

export async function getRadioStations() {
  const res = await fetch(`${RADIO_URL}/json/stations/bytag/anime?limit=40&hidebroken=true&is_https=true&lastcheckok=1`);
  return res.json();
}

export async function getCelebrationGif() {
  const res = await fetch(`${NEKOS_URL}/celebrate`);
  return res.json();
}

export async function traceMoeSearch(buffer, mimeType) {
  const form = new FormData();
  const blob = new Blob([buffer], { type: mimeType || 'image/jpeg' });
  form.append('image', blob);
  const res = await fetch(`${TRACEMOE_URL}/search?anilistInfo`, { method: 'POST', body: form });
  return res.json();
}