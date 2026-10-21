// api/backend.js — Express server, routing, authentication middleware

import express from 'express';
import cors from './cors.js';
import { adminAuth, firebaseWebConfig } from './api.js';
import {
  fetchTrendingAnime, searchAnime, fetchAnimeDetails,
  fetchSchedule, fetchSeasonal, fetchMangaTrending, searchManga,
  fetchMangaDetails, fetchAnimeNews, fetchRadioStations, fetchCelebrationGif
} from './api.js';
import * as script from './script.js';
import { getFriendlyError, safeString, toNumber } from './utils.js';

const app = express();
app.use(cors);
app.use(express.json({ limit: '15mb' }));

// ---- Auth middleware ----
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    req.uid = decoded.uid;
    req.authUser = { email: decoded.email, name: decoded.name, picture: decoded.picture };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token', code: 'UNAUTHENTICATED' });
  }
}

// ---- Error wrapper ----
const ah = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    console.error('[API]', e.message);
    res.status(400).json({ error: getFriendlyError(e), code: e.code || '' });
  }
};

// =================== PUBLIC CONFIG ===================
app.get('/api/config/public', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(firebaseWebConfig);
});

app.get('/api/config/app', ah(async (req, res) => {
  const cfg = await script.loadAppConfig();
  res.json(cfg);
}));

// =================== USER ===================
app.get('/api/user/me', authenticate, ah(async (req, res) => {
  let userData = await script.getUser(req.uid);
  if (!userData) {
    userData = await script.createUser(req.uid, req.authUser);
  }
  if (userData.isBanned) return res.status(403).json({ banned: true, reason: userData.banReason || 'Violation' });
  res.json({ userData: script.sanitizeForSelf(userData) });
}));

app.post('/api/user/setup', authenticate, ah(async (req, res) => {
  const userData = await script.completeSetup(req.uid, {
    name: safeString(req.body.name, 60),
    avatar: safeString(req.body.avatar, 500)
  });
  res.json({ userData: script.sanitizeForSelf(userData) });
}));

app.post('/api/user/profile', authenticate, ah(async (req, res) => {
  const userData = await script.updateProfile(req.uid, {
    name: safeString(req.body.name, 60),
    avatar: safeString(req.body.avatar, 500)
  });
  res.json({ userData: script.sanitizeForSelf(userData) });
}));

app.post('/api/user/backup-email/precheck', authenticate, ah(async (req, res) => {
  await script.precheckBackupEmail(req.body.email, req.uid);
  res.json({ ok: true });
}));

app.post('/api/user/backup-email', authenticate, ah(async (req, res) => {
  const userData = await script.saveBackupEmail(req.uid, req.body.email);
  res.json({ userData: script.sanitizeForSelf(userData) });
}));

app.get('/api/user/public/:uid', ah(async (req, res) => {
  const u = await script.getUser(req.params.uid);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ user: script.sanitizeForPublic(u) });
}));

app.get('/api/user/find/:customId', ah(async (req, res) => {
  const u = await script.findUserByCustomId(req.params.customId);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ user: u });
}));

app.get('/api/user/followers', authenticate, ah(async (req, res) => {
  const followers = await script.getFollowersData(req.uid);
  res.json({ followers });
}));

app.get('/api/user/rank-breakdown', authenticate, ah(async (req, res) => {
  const breakdown = await script.getRankBreakdown(req.uid);
  res.json({ breakdown });
}));

app.post('/api/user/follow/:uid', authenticate, ah(async (req, res) => {
  const result = await script.toggleFollow(req.uid, req.params.uid);
  const userData = await script.getUser(req.uid);
  res.json({ ...result, userData: script.sanitizeForSelf(userData) });
}));

// =================== LEADERBOARD ===================
app.get('/api/leaderboard', ah(async (req, res) => {
  const list = await script.getLeaderboard(10);
  res.json({ leaderboard: list });
}));

// =================== ANIME ===================
app.get('/api/anime/trending', ah(async (req, res) => {
  const page = toNumber(req.query.page, 1);
  const list = await fetchTrendingAnime(page);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({ list });
}));

app.get('/api/anime/search', ah(async (req, res) => {
  const filters = {
    q: safeString(req.query.q, 100),
    genre: safeString(req.query.genre, 50),
    year: req.query.year ? toNumber(req.query.year) : null,
    format: safeString(req.query.format, 20),
    status: safeString(req.query.status, 30),
    score: req.query.score ? toNumber(req.query.score) : null
  };
  const list = await searchAnime(filters);
  res.setHeader('Cache-Control', 'public, max-age=180');
  res.json({ list });
}));

app.get('/api/anime/details', ah(async (req, res) => {
  const anime = await fetchAnimeDetails(req.query.id, req.query.malId);
  if (!anime) return res.status(404).json({ error: 'Anime not found' });
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ anime });
}));

app.get('/api/schedule', ah(async (req, res) => {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const list = await fetchSchedule(Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000));
  res.setHeader('Cache-Control', 'public, max-age=1800');
  res.json({ list });
}));

app.get('/api/seasonal', ah(async (req, res) => {
  const year = toNumber(req.query.year, new Date().getFullYear());
  const season = safeString(req.query.season, 'WINTER');
  const list = await fetchSeasonal(season, year);
  res.setHeader('Cache-Control', 'public, max-age=1800');
  res.json({ list });
}));

app.get('/api/anime/episode-title', authenticate, ah(async (req, res) => {
  const title = safeString(req.query.title, 200);
  const ep = toNumber(req.query.ep, 1);
  const episodeTitle = await script.getEpisodeTitle(title, ep);
  res.json({ episodeTitle });
}));

app.post('/api/anime/upcoming/add', authenticate, ah(async (req, res) => {
  const userData = await script.addToUpcoming(req.uid, {
    malId: req.body.malId, anilistId: req.body.anilistId,
    title: req.body.title, img: req.body.img, totalEps: req.body.totalEps
  });
  res.json({ userData: script.sanitizeForSelf(userData) });
}));

app.post('/api/anime/upcoming/increment', authenticate, ah(async (req, res) => {
  const result = await script.incrementEpisode(req.uid, req.body.malId);
  const userData = await script.getUser(req.uid);
  res.json({ ...result, userData: script.sanitizeForSelf(userData) });
}));

app.post('/api/anime/upcoming/remove', authenticate, ah(async (req, res) => {
  const userData = await script.removeFromUpcoming(req.uid, req.body.malId);
  res.json({ userData: script.sanitizeForSelf(userData) });
}));

app.post('/api/collection/toggle-prime', authenticate, ah(async (req, res) => {
  const userData = await script.togglePrime(req.uid, req.body.malId);
  res.json({ userData: script.sanitizeForSelf(userData) });
}));

app.post('/api/collection/toggle-favourite', authenticate, ah(async (req, res) => {
  const userData = await script.toggleFavourite(req.uid, req.body.malId);
  res.json({ userData: script.sanitizeForSelf(userData) });
}));

// =================== MANGA ===================
app.get('/api/manga/trending', ah(async (req, res) => {
  const page = toNumber(req.query.page, 1);
  const list = await fetchMangaTrending(page);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({ list });
}));

app.get('/api/manga/search', ah(async (req, res) => {
  const q = safeString(req.query.q, 100);
  if (!q) return res.json({ list: [] });
  const list = await searchManga(q);
  res.json({ list });
}));

app.get('/api/manga/details', ah(async (req, res) => {
  const m = await fetchMangaDetails(req.query.id);
  if (!m) return res.status(404).json({ error: 'Manga not found' });
  res.json({ manga: m });
}));

// =================== DAILY / STORE ===================
app.get('/api/daily/status', authenticate, ah(async (req, res) => {
  const userData = await script.getUser(req.uid);
  if (!userData) return res.status(404).json({ error: 'User not found' });
  const today = new Date().toDateString();
  const config = await script.loadAppConfig();
  res.json({
    claimed: userData.lastClaim === today,
    bonus: config.dailyBonus
  });
}));

app.post('/api/daily/claim', authenticate, ah(async (req, res) => {
  const result = await script.claimDaily(req.uid);
  const userData = await script.getUser(req.uid);
  res.json({ ...result, userData: script.sanitizeForSelf(userData) });
}));

app.get('/api/store/items', ah(async (req, res) => {
  const items = await script.getStoreItems();
  res.json({ items });
}));

app.post('/api/store/buy', authenticate, ah(async (req, res) => {
  const result = await script.buyItem(req.uid, req.body.itemId);
  const userData = await script.getUser(req.uid);
  res.json({ ...result, userData: script.sanitizeForSelf(userData) });
}));

// =================== POLLS ===================
app.get('/api/polls/list', authenticate, ah(async (req, res) => {
  const polls = await script.listPolls(req.uid);
  res.json({ polls });
}));

app.get('/api/polls/mine', authenticate, ah(async (req, res) => {
  const polls = await script.listMyPolls(req.uid);
  res.json({ polls });
}));

app.post('/api/polls/create', authenticate, ah(async (req, res) => {
  const opts = (req.body.options || []).map(o => safeString(o, 150));
  if (opts.length !== 4 || opts.some(o => !o)) throw new Error('All 4 options required');
  const result = await script.createPoll(req.uid, {
    animeName: safeString(req.body.animeName, 100),
    question: safeString(req.body.question, 300),
    options: opts,
    correctIndex: toNumber(req.body.correctIndex)
  });
  res.json(result);
}));

app.post('/api/polls/answer', authenticate, ah(async (req, res) => {
  const result = await script.answerPoll(req.uid, req.body.pollId, req.body.selectedIndex);
  const userData = await script.getUser(req.uid);
  res.json({ ...result, userData: script.sanitizeForSelf(userData) });
}));

app.post('/api/polls/report', authenticate, ah(async (req, res) => {
  await script.reportPoll(req.uid, req.body.pollId);
  res.json({ ok: true });
}));

// =================== SCANNER / UPLOAD ===================
app.post('/api/scanner/scan', authenticate, ah(async (req, res) => {
  const b64 = safeString(req.body.imageBase64, 12 * 1024 * 1024);
  if (!b64) throw new Error('Image required');
  const result = await script.scanImage(b64);
  res.json(result);
}));

app.post('/api/upload/image', authenticate, ah(async (req, res) => {
  const b64 = safeString(req.body.imageBase64, 8 * 1024 * 1024);
  if (!b64) throw new Error('Image required');
  const url = await script.uploadImage(b64, safeString(req.body.name, 40) || 'upload');
  res.json({ url });
}));

// =================== NEWS / MUSIC / CELEBRATION ===================
app.get('/api/news', ah(async (req, res) => {
  const xml = await fetchAnimeNews();
  res.json({ xml });
}));

app.get('/api/music/stations', ah(async (req, res) => {
  const stations = await fetchRadioStations();
  res.json({ stations: stations.slice(0, 40) });
}));

app.get('/api/celebration', ah(async (req, res) => {
  const url = await fetchCelebrationGif();
  res.json({ url });
}));

// =================== 404 / ERROR ===================
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: getFriendlyError(err) });
});

export default app;