const express = require('express');
const axios = require('axios');
const corsMw = require('./cors');
const config = require('./api');
const adminSdk = require('./firebase');
const script = require('./script');
const imgbb = require('./imgbb');
const gemini = require('./gemini');

const app = express();
app.disable('x-powered-by');
app.use(corsMw);
app.use(express.json({ limit: '8mb' }));

// Normalize the URL regardless of how Vercel forwards the request.
app.use((req, res, next) => {
  const fnPath = '/v00/m00/u00/rABC/api/backend';
  if (req.url.startsWith(fnPath)) req.url = req.url.slice(fnPath.length) || '/';
  if (req.url.startsWith('/api/')) req.url = req.url.slice(4);
  next();
});

const router = express.Router();

function wrap(fn) {
  return function (req, res) {
    Promise.resolve(fn(req, res)).catch(err => {
      const code = err.status || 400;
      res.status(code).json({ error: err.message || 'Request failed' });
    });
  };
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const decoded = await adminSdk.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid, email: decoded.email || '' };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

router.get('/health', (req, res) => res.json({ ok: true }));

// ---- Auth ----
router.post('/auth/register', wrap(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) throw Object.assign(new Error('Email and password required'), { status: 400 });
  if (password.length < 6) throw Object.assign(new Error('Password must be at least 6 chars'), { status: 400 });
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${config.firebase.apiKey}`;
  let r;
  try {
    r = await axios.post(url, { email, password, returnSecureToken: true });
  } catch (e) {
    const msg = e.response && e.response.data && e.response.data.error && e.response.data.error.message;
    if (msg === 'EMAIL_EXISTS') throw Object.assign(new Error('Email already registered'), { status: 409 });
    throw Object.assign(new Error('Registration failed'), { status: 400 });
  }
  const { idToken, refreshToken, localId } = r.data;
  await script.createUserRecord(localId, email, name || 'Gojo Hunter');
  const me = await script.getMe(localId);
  res.json({ idToken, refreshToken, uid: localId, user: me });
}));

router.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw Object.assign(new Error('Email and password required'), { status: 400 });
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${config.firebase.apiKey}`;
  let r;
  try {
    r = await axios.post(url, { email, password, returnSecureToken: true });
  } catch (e) {
    throw Object.assign(new Error('Invalid email or password'), { status: 401 });
  }
  const { idToken, refreshToken, localId } = r.data;
  const userSnap = await adminSdk.db().doc('users/' + localId).get();
  if (!userSnap.exists) {
    await script.createUserRecord(localId, email, 'Gojo Hunter');
  } else if (userSnap.data().isBanned) {
    throw Object.assign(new Error('Account banned: ' + (userSnap.data().banReason || 'Policy violation')), { status: 403 });
  }
  const me = await script.getMe(localId);
  res.json({ idToken, refreshToken, uid: localId, user: me });
}));

router.post('/auth/google', wrap(async (req, res) => {
  const { googleIdToken } = req.body || {};
  if (!googleIdToken) throw Object.assign(new Error('Google ID token required'), { status: 400 });
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${config.firebase.apiKey}`;
  const body = {
    postBody: `id_token=${googleIdToken}&providerId=google.com`,
    requestUri: req.headers.origin || 'https://localhost',
    returnSecureToken: true
  };
  let r;
  try {
    r = await axios.post(url, body);
  } catch (e) {
    throw Object.assign(new Error('Google sign-in failed'), { status: 401 });
  }
  const { idToken, refreshToken, localId, email, displayName, photoUrl } = r.data;
  const userSnap = await adminSdk.db().doc('users/' + localId).get();
  if (!userSnap.exists) {
    await script.createUserRecord(localId, email || '', displayName || 'Gojo Hunter', photoUrl || '');
  } else if (userSnap.data().isBanned) {
    throw Object.assign(new Error('Account banned'), { status: 403 });
  }
  const me = await script.getMe(localId);
  res.json({ idToken, refreshToken, uid: localId, user: me });
}));

router.post('/auth/refresh', wrap(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) throw Object.assign(new Error('Refresh token required'), { status: 400 });
  const url = `https://securetoken.googleapis.com/v1/token?key=${config.firebase.apiKey}`;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  let r;
  try {
    r = await axios.post(url, body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  } catch (e) {
    throw Object.assign(new Error('Session expired'), { status: 401 });
  }
  res.json({ idToken: r.data.id_token, refreshToken: r.data.refresh_token, uid: r.data.user_id });
}));

// ---- Public ----
router.get('/config', wrap(async (req, res) => {
  res.json(await script.loadConfig());
}));

router.get('/bank', wrap(async (req, res) => {
  res.json(await script.getBankPublic());
}));

router.get('/store', wrap(async (req, res) => {
  res.json({ items: await script.listStore() });
}));

router.get('/announcements', wrap(async (req, res) => {
  res.json({ items: await script.listAnnouncements() });
}));

// ---- User (auth required) ----
router.get('/me', authenticate, wrap(async (req, res) => {
  const me = await script.getMe(req.user.uid);
  res.json({ user: me });
}));

router.patch('/me', authenticate, wrap(async (req, res) => {
  const result = await script.updateProfile(req.user.uid, req.body || {});
  res.json(result);
}));

router.post('/me/claim-daily', authenticate, wrap(async (req, res) => {
  const result = await script.claimDaily(req.user.uid);
  res.json(result);
}));

router.post('/me/complete-episode', authenticate, wrap(async (req, res) => {
  const { malId } = req.body || {};
  if (!malId) throw Object.assign(new Error('malId required'), { status: 400 });
  const result = await script.completeEpisode(req.user.uid, malId);
  res.json(result);
}));

router.post('/me/buy-item', authenticate, wrap(async (req, res) => {
  const { itemId } = req.body || {};
  if (!itemId) throw Object.assign(new Error('itemId required'), { status: 400 });
  const result = await script.buyItem(req.user.uid, itemId);
  res.json(result);
}));

router.post('/me/collection/prime', authenticate, wrap(async (req, res) => {
  const { malId, action } = req.body || {};
  const result = await script.setCollectionSlot(req.user.uid, malId, 'prime', action || 'add');
  res.json(result);
}));

router.post('/me/collection/favourite', authenticate, wrap(async (req, res) => {
  const { malId, action } = req.body || {};
  const result = await script.setCollectionSlot(req.user.uid, malId, 'favourite', action || 'add');
  res.json(result);
}));

router.post('/me/upload-avatar', authenticate, wrap(async (req, res) => {
  const { base64 } = req.body || {};
  const result = await script.uploadAvatar(req.user.uid, base64);
  res.json(result);
}));

router.post('/me/backup-email', authenticate, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const result = await script.setBackupEmail(req.user.uid, email, password);
  res.json(result);
}));

router.post('/me/password', authenticate, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const result = await script.changePassword(req.user.uid, currentPassword, newPassword);
  res.json(result);
}));

// ---- Polls ----
router.get('/polls', authenticate, wrap(async (req, res) => {
  res.json({ items: await script.listPolls(req.user.uid) });
}));

router.post('/me/polls', authenticate, wrap(async (req, res) => {
  const result = await script.createPoll(req.user.uid, req.body || {});
  res.json(result);
}));

router.post('/polls/:id/answer', authenticate, wrap(async (req, res) => {
  const { optionIndex } = req.body || {};
  const result = await script.answerPoll(req.user.uid, req.params.id, Number(optionIndex));
  res.json(result);
}));

router.post('/polls/:id/report', authenticate, wrap(async (req, res) => {
  const result = await script.reportPoll(req.user.uid, req.params.id);
  res.json(result);
}));

router.delete('/polls/:id', authenticate, wrap(async (req, res) => {
  const result = await script.deletePoll(req.user.uid, req.params.id);
  res.json(result);
}));

// ---- Users ----
router.get('/users/:uid', authenticate, wrap(async (req, res) => {
  const u = await script.getPublicUser(req.params.uid);
  if (!u) throw Object.assign(new Error('Not found'), { status: 404 });
  res.json({ user: u });
}));

router.post('/users/:uid/follow', authenticate, wrap(async (req, res) => {
  const result = await script.toggleFollow(req.user.uid, req.params.uid);
  res.json(result);
}));

router.get('/leaderboard', authenticate, wrap(async (req, res) => {
  res.json({ items: await script.listLeaderboard() });
}));

// ---- Scanner ----
router.post('/scan', authenticate, wrap(async (req, res) => {
  const { base64 } = req.body || {};
  if (!base64) throw Object.assign(new Error('Image data required'), { status: 400 });
  const result = await script.scanImage(base64);
  res.json(result);
}));

// ---- Proxies (backend-only third-party calls) ----
router.post('/anilist', wrap(async (req, res) => {
  const { query, variables } = req.body || {};
  if (!query) throw Object.assign(new Error('query required'), { status: 400 });
  const r = await axios.post(config.apis.anilist, { query, variables }, {
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    timeout: 20000
  });
  res.json(r.data);
}));

router.get('/mangadex/manga', wrap(async (req, res) => {
  const params = { ...req.query };
  const r = await axios.get(config.apis.mangadex + '/manga', { params, timeout: 20000 });
  res.json(r.data);
}));

router.get('/mangadex/manga/:id', wrap(async (req, res) => {
  const r = await axios.get(config.apis.mangadex + '/manga/' + encodeURIComponent(req.params.id), { timeout: 20000 });
  res.json(r.data);
}));

router.get('/kitsu/anime', wrap(async (req, res) => {
  const r = await axios.get(config.apis.kitsu + '/anime', { params: req.query, timeout: 20000 });
  res.json(r.data);
}));

router.get('/kitsu/anime/:id/episodes', wrap(async (req, res) => {
  const r = await axios.get(config.apis.kitsu + '/anime/' + encodeURIComponent(req.params.id) + '/episodes', {
    params: req.query, timeout: 20000
  });
  res.json(r.data);
}));

router.get('/radio/stations', wrap(async (req, res) => {
  const r = await axios.get(config.apis.radioBrowser + '/json/stations/bytag/anime', {
    params: { limit: 40, hidebroken: true, is_https: true, lastcheckok: 1 },
    timeout: 20000
  });
  res.json(r.data);
}));

router.get('/nekos/celebrate', wrap(async (req, res) => {
  const r = await axios.get(config.apis.nekos + '/celebrate', { timeout: 15000 });
  res.json(r.data);
}));

router.get('/news', wrap(async (req, res) => {
  const target = config.apis.animeNewsRss;
  const proxies = [config.apis.allorigins, config.apis.codetabs, config.apis.corsproxy];
  let xml = null;
  for (const p of proxies) {
    try {
      const url = p + encodeURIComponent(target);
      const r = await axios.get(url, { timeout: 15000, responseType: 'text' });
      if (r.data && (r.data.includes('<rss') || r.data.includes('<channel'))) {
        xml = r.data;
        break;
      }
    } catch (e) { /* try next */ }
  }
  if (!xml) throw Object.assign(new Error('Could not load news feed'), { status: 502 });
  res.type('application/xml').send(xml);
}));

app.use('/api', router);
app.use('/', router);

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Gojo Goojoo API listening on ' + port));
}