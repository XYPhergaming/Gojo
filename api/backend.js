const express = require('express');
const cookieParser = require('cookie-parser');
const admin = require('firebase-admin');
const cors = require('./cors');
const { requireAuth, checkRate } = require('./utils');
const script = require('./script');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());
app.use(cors);

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error('[API ERROR]', req.method, req.path, err.message);
    const msg = err.message || 'Server error';
    const code = /banned/i.test(msg) ? 403
      : /auth|invalid credential|unauthorized|login/i.test(msg) ? 401
      : /rate/i.test(msg) ? 429
      : /not found/i.test(msg) ? 404
      : 400;
    res.status(code).json({ error: msg });
  });

const rawImage = (limit = '10mb') =>
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit });

// Health & public config
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config/public', wrap(async (req, res) => {
  const cfg = await script.getAppConfig();
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    appConfig: cfg,
  });
}));

// ---------- AUTH ----------
app.post('/api/auth/google', wrap(async (req, res) => {
  if (!checkRate(`g:${req.ip}`, 10, 60000)) throw new Error('Rate limit');
  const { idToken } = req.body || {};
  if (!idToken) throw new Error('Missing idToken');
  const { user, token } = await script.handleGoogleAuth(idToken);
  res.cookie('session', token, {
    httpOnly: true, secure: true, sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ user });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  if (!checkRate(`l:${req.ip}`, 10, 60000)) throw new Error('Rate limit');
  const { email, password } = req.body || {};
  if (!email || !password) throw new Error('Missing credentials');
  const { user, token } = await script.handleBackupLogin(email, password);
  res.cookie('session', token, {
    httpOnly: true, secure: true, sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ user });
}));

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, wrap(async (req, res) => {
  const user = await script.getUser(req.uid);
  res.json({ user });
}));

// ---------- USERS ----------
app.patch('/api/users/me', requireAuth, wrap(async (req, res) => {
  const user = await script.updateUserProfile(req.uid, req.body || {});
  res.json({ user });
}));

app.post('/api/users/me/setup', requireAuth, wrap(async (req, res) => {
  const user = await script.completeSetup(req.uid, req.body || {});
  res.json({ user });
}));

app.get('/api/users/search', requireAuth, wrap(async (req, res) => {
  const user = await script.searchUserByUid(req.query.uid || '');
  res.json({ user });
}));

app.get('/api/users/:uid', requireAuth, wrap(async (req, res) => {
  const user = await script.getPublicUser(req.params.uid);
  res.json({ user });
}));

app.post('/api/users/:uid/follow', requireAuth, wrap(async (req, res) => {
  if (!checkRate(`f:${req.uid}`, 20, 60000)) throw new Error('Rate limit');
  const user = await script.followUser(req.uid, req.params.uid);
  res.json({ user });
}));

// ---------- RANK ----------
app.get('/api/ranks/me', requireAuth, wrap(async (req, res) => {
  const info = await script.getRankInfo(req.uid);
  res.json(info);
}));

// ---------- ECONOMY ----------
app.post('/api/inbox/claim-daily', requireAuth, wrap(async (req, res) => {
  if (!checkRate(`d:${req.uid}`, 5, 60000)) throw new Error('Rate limit');
  const r = await script.claimDailyBonus(req.uid);
  res.json(r);
}));

app.get('/api/store/items', requireAuth, wrap(async (req, res) => {
  const db = admin.firestore();
  const snap = await db.collection('storeItems').where('active', '==', true).get();
  res.json({ items: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
}));

app.post('/api/store/buy/:itemId', requireAuth, wrap(async (req, res) => {
  if (!checkRate(`b:${req.uid}`, 5, 60000)) throw new Error('Rate limit');
  const r = await script.buyStoreItem(req.uid, req.params.itemId);
  res.json(r);
}));

// ---------- UPCOMING ----------
app.post('/api/upcoming', requireAuth, wrap(async (req, res) => {
  if (!checkRate(`u:${req.uid}`, 20, 60000)) throw new Error('Rate limit');
  const r = await script.addToUpcoming(req.uid, req.body || {});
  res.json(r);
}));

app.delete('/api/upcoming/:malId', requireAuth, wrap(async (req, res) => {
  const r = await script.removeFromUpcoming(req.uid, req.params.malId);
  res.json(r);
}));

app.post('/api/upcoming/:malId/increment', requireAuth, wrap(async (req, res) => {
  if (!checkRate(`i:${req.uid}`, 10, 60000)) throw new Error('Rate limit');
  const r = await script.incrementWatchingEpisode(req.uid, req.params.malId);
  res.json(r);
}));

// ---------- COLLECTION ----------
app.post('/api/collection/:malId/toggle-prime', requireAuth, wrap(async (req, res) => {
  const r = await script.togglePrime(req.uid, req.params.malId);
  res.json(r);
}));

app.post('/api/collection/:malId/toggle-favorite', requireAuth, wrap(async (req, res) => {
  const r = await script.toggleFavorite(req.uid, req.params.malId);
  res.json(r);
}));

// ---------- POLLS ----------
app.get('/api/polls', requireAuth, wrap(async (req, res) => {
  res.json({ polls: await script.listPolls(req.uid) });
}));

app.get('/api/polls/mine', requireAuth, wrap(async (req, res) => {
  res.json({ polls: await script.listMyPolls(req.uid) });
}));

app.post('/api/polls', requireAuth, wrap(async (req, res) => {
  if (!checkRate(`p:${req.uid}`, 5, 300000)) throw new Error('Rate limit');
  res.json(await script.createPoll(req.uid, req.body || {}));
}));

app.post('/api/polls/:id/answer', requireAuth, wrap(async (req, res) => {
  if (!checkRate(`a:${req.uid}`, 20, 60000)) throw new Error('Rate limit');
  res.json(await script.answerPoll(req.uid, req.params.id, parseInt(req.body.optionIndex)));
}));

app.post('/api/polls/:id/report', requireAuth, wrap(async (req, res) => {
  await script.reportPoll(req.uid, req.params.id);
  res.json({ ok: true });
}));

// ---------- LEADERBOARD ----------
app.get('/api/leaderboard', requireAuth, wrap(async (req, res) => {
  res.json({ leaderboard: await script.getLeaderboard() });
}));

// ---------- ANIME / MANGA (public) ----------
app.get('/api/anime/trending', wrap(async (req, res) => {
  res.json({ results: await script.getTrendingAnime(parseInt(req.query.page) || 1) });
}));

app.get('/api/anime/search', wrap(async (req, res) => {
  res.json({ results: await script.searchAnime(req.query) });
}));

app.get('/api/anime/:anilistId', wrap(async (req, res) => {
  res.json({ anime: await script.getAnimeDetails(req.params.anilistId, req.query.malId) });
}));

app.get('/api/manga/trending', wrap(async (req, res) => {
  res.json({ results: await script.getTrendingManga(parseInt(req.query.page) || 1) });
}));

app.get('/api/manga/search', wrap(async (req, res) => {
  res.json({ results: await script.searchManga(req.query.q || '') });
}));

app.get('/api/manga/:id', wrap(async (req, res) => {
  res.json({ manga: await script.getMangaDetails(req.params.id) });
}));

// ---------- SCHEDULE / SEASONAL ----------
app.get('/api/schedule', wrap(async (req, res) => {
  res.json({ schedule: await script.getAiringSchedule() });
}));

app.get('/api/seasonal', wrap(async (req, res) => {
  res.json({ results: await script.getSeasonal(req.query.season, req.query.year) });
}));

// ---------- SCANNER ----------
app.post('/api/scanner/scan', requireAuth, rawImage('10mb'), wrap(async (req, res) => {
  if (!checkRate(`s:${req.uid}`, 10, 60000)) throw new Error('Rate limit');
  if (!req.body || !req.body.length) throw new Error('No image data');
  const r = await script.scanAnime(req.body, req.headers['content-type'] || 'image/jpeg');
  res.json(r);
}));

// ---------- MUSIC / NEWS / GIF ----------
app.get('/api/music/stations', wrap(async (req, res) => {
  res.json({ stations: await script.getMusicStations() });
}));

app.get('/api/news', wrap(async (req, res) => {
  res.json({ news: await script.getNews() });
}));

app.get('/api/celebrate', wrap(async (req, res) => {
  res.json({ url: await script.getCelebrationGif() });
}));

// ---------- AVATAR UPLOAD ----------
app.post('/api/upload/avatar', requireAuth, rawImage('5mb'), wrap(async (req, res) => {
  if (!checkRate(`u:${req.uid}`, 5, 300000)) throw new Error('Rate limit');
  if (!req.body || !req.body.length) throw new Error('No image data');
  const url = await script.uploadAvatar(req.body, req.headers['content-type'] || 'image/jpeg');
  res.json({ url });
}));

// ---------- ACCOUNT ----------
app.post('/api/account/backup-email', requireAuth, wrap(async (req, res) => {
  if (!checkRate(`be:${req.uid}`, 3, 300000)) throw new Error('Rate limit');
  await script.linkBackupEmail(req.uid, req.body.email, req.body.password);
  res.json({ ok: true });
}));

app.post('/api/account/change-password', requireAuth, wrap(async (req, res) => {
  if (!checkRate(`cp:${req.uid}`, 3, 300000)) throw new Error('Rate limit');
  await script.changePassword(req.uid, req.body.currentPassword, req.body.newPassword);
  res.json({ ok: true });
}));

module.exports = app;