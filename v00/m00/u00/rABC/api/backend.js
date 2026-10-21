import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { OAuth2Client } from 'google-auth-library';

import { corsMiddleware } from './cors.js';
import { auth as adminAuth, db } from './firebase.js';
import { uploadToImgBB } from './imgbb.js';
import { scanWithGemini } from './gemini.js';
import {
  anilistQuery,
  getTrendingAnime,
  searchAnime,
  getAnimeDetails,
  getAiringSchedule,
  getSeasonal,
  searchManga,
  trendingManga,
  getMangaDetails,
  getEpisodeTitle,
  getRadioStations,
  getCelebrationGif,
  traceMoeSearch
} from './api.js';
import {
  DEFAULT_CONFIG,
  getConfig,
  getActiveUser,
  createUserRecord,
  maybeUpdateRank,
  addUpcoming,
  removeUpcoming,
  incrementEpisode,
  claimDaily,
  purchaseItem,
  togglePrime,
  toggleFavourite,
  toggleFollow,
  answerPoll,
  linkBackupEmail,
  findUserByBackupEmail,
  reportPoll,
  deletePoll,
  updateProfile,
  completeSetup,
  getLeaderboard,
  publicUserData,
  verifyPassword
} from './script.js';

const app = express();
app.use(corsMiddleware);
app.use(express.json({ limit: '6mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function fail(res, code, message, extra) {
  return res.status(code).json({ error: message, ...(extra || {}) });
}

async function exchangeCustomToken(customToken) {
  if (!WEB_API_KEY) throw new Error('FIREBASE_WEB_API_KEY missing on server');
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(WEB_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true })
  });
  const json = await res.json();
  if (!res.ok) throw new Error((json && json.error && json.error.message) || 'Token exchange failed');
  return { idToken: json.idToken, refreshToken: json.refreshToken, uid: json.localId };
}

async function verifyGoogleIdToken(idToken) {
  if (!googleClient) throw new Error('GOOGLE_CLIENT_ID not configured');
  const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  return ticket.getPayload();
}

async function ensureFirebaseUserForEmail({ email, name, picture }) {
  let userRecord;
  try {
    userRecord = await adminAuth.getUserByEmail(email);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      userRecord = await adminAuth.createUser({
        email,
        displayName: name || undefined,
        photoURL: picture || undefined,
        emailVerified: true
      });
    } else {
      throw err;
    }
  }
  return userRecord;
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return fail(res, 401, 'Missing auth token');
    const decoded = await adminAuth.verifyIdToken(token);
    req.uid = decoded.uid;
    req.token = decoded;
    next();
  } catch (err) {
    return fail(res, 401, 'Invalid or expired token');
  }
}

async function maybeAdmin(uid) {
  const snap = await db.doc(`admins/${uid}`).get();
  return snap.exists;
}

// ================= PUBLIC =================

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config/public', (req, res) => {
  res.json({
    firebaseWebApiKey: WEB_API_KEY || '',
    googleClientId: GOOGLE_CLIENT_ID || ''
  });
});

app.get('/api/config', async (req, res) => {
  try {
    const cfg = await getConfig();
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load config' });
  }
});

// ================= AUTH =================

app.post('/api/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) return fail(res, 400, 'idToken required');
    const payload = await verifyGoogleIdToken(idToken);
    if (!payload || !payload.email) return fail(res, 400, 'Google account has no email');
    const userRecord = await ensureFirebaseUserForEmail({
      email: payload.email,
      name: payload.name,
      picture: payload.picture
    });
    const snap = await db.doc(`users/${userRecord.uid}`).get();
    if (!snap.exists) {
      await createUserRecord({
        uid: userRecord.uid,
        email: payload.email,
        name: payload.name || 'Gojo Hunter',
        avatar: payload.picture || ''
      });
    }
    const customToken = await adminAuth.createCustomToken(userRecord.uid);
    const exchanged = await exchangeCustomToken(customToken);
    const fresh = await db.doc(`users/${userRecord.uid}`).get();
    res.json({ ...exchanged, user: fresh.exists ? { id: fresh.id, ...fresh.data() } : null });
  } catch (err) {
    console.error('[google auth]', err);
    fail(res, 400, 'Google sign-in failed');
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return fail(res, 400, 'email and password required');
    const user = await findUserByBackupEmail(email);
    if (!user) return fail(res, 401, 'Invalid email or password');
    if (user.isBanned) return fail(res, 403, 'Account banned');
    if (!user.backupEmailHash || !user.backupEmailSalt) return fail(res, 401, 'Backup email not set up');
    if (!verifyPassword(password, user.backupEmailHash, user.backupEmailSalt)) {
      return fail(res, 401, 'Invalid email or password');
    }
    const customToken = await adminAuth.createCustomToken(user.id);
    const exchanged = await exchangeCustomToken(customToken);
    const fresh = await db.doc(`users/${user.id}`).get();
    res.json({ ...exchanged, user: { id: fresh.id, ...fresh.data() } });
  } catch (err) {
    console.error('[email login]', err);
    fail(res, 401, 'Login failed');
  }
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return fail(res, 400, 'refreshToken required');
    if (!WEB_API_KEY) return fail(res, 500, 'Server misconfigured');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
    const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(WEB_API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const json = await r.json();
    if (!r.ok) return fail(res, 401, (json && json.error && json.error.message) || 'Refresh failed');
    res.json({ idToken: json.id_token, refreshToken: json.refresh_token, uid: json.user_id });
  } catch (err) {
    console.error('[refresh]', err);
    fail(res, 500, 'Refresh failed');
  }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const user = await getActiveUser(req.uid);
    const cfg = await getConfig();
    res.json({ user, config: cfg });
  } catch (err) {
    fail(res, err.status || 400, err.message || 'Failed to load user');
  }
});

app.post('/api/auth/link-backup', authenticate, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const r = await linkBackupEmail({ uid: req.uid, email, password });
    res.json(r);
  } catch (err) {
    fail(res, 400, err.message || 'Failed to link backup email');
  }
});

// ================= PROFILE =================

app.post('/api/user/setup', authenticate, async (req, res) => {
  try {
    const { name, avatar } = req.body || {};
    const updated = await completeSetup({ uid: req.uid, name, avatar });
    res.json({ ok: true, ...updated });
  } catch (err) {
    fail(res, 400, err.message || 'Setup failed');
  }
});

app.post('/api/user/profile', authenticate, async (req, res) => {
  try {
    const { name, avatar } = req.body || {};
    const updated = await updateProfile({ uid: req.uid, name, avatar });
    res.json({ ok: true, ...updated });
  } catch (err) {
    fail(res, 400, err.message || 'Update failed');
  }
});

app.get('/api/user/:uid', async (req, res) => {
  try {
    const data = await publicUserData(req.params.uid);
    res.json(data);
  } catch (err) {
    fail(res, 404, err.message || 'Not found');
  }
});

app.get('/api/user/:uid/collection', async (req, res) => {
  try {
    const snap = await db.doc(`users/${req.params.uid}`).get();
    if (!snap.exists) return fail(res, 404, 'User not found');
    const u = snap.data();
    res.json({ collection: u.collection || [] });
  } catch {
    fail(res, 500, 'Failed to load collection');
  }
});

app.post('/api/user/follow/:uid', authenticate, async (req, res) => {
  try {
    const r = await toggleFollow({ uid: req.uid, targetUid: req.params.uid });
    res.json(r);
  } catch (err) {
    fail(res, 400, err.message || 'Follow failed');
  }
});

app.get('/api/user/me/followers', authenticate, async (req, res) => {
  try {
    const snap = await db.doc(`users/${req.uid}`).get();
    if (!snap.exists) return fail(res, 404, 'Not found');
    const u = snap.data();
    const ids = u.followers || [];
    const results = [];
    for (const id of ids) {
      const r = await db.doc(`users/${id}`).get();
      if (r.exists) {
        const d = r.data();
        results.push({ uid: id, name: d.name, avatar: d.avatar, rank: d.rank });
      }
    }
    res.json({ followers: results });
  } catch {
    fail(res, 500, 'Failed to load followers');
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const list = await getLeaderboard();
    res.json({ leaderboard: list });
  } catch {
    fail(res, 500, 'Failed to load leaderboard');
  }
});

// ================= UPCOMING / COLLECTION =================

app.post('/api/upcoming/add', authenticate, async (req, res) => {
  try {
    const { malId, anilistId, title, img, totalEps } = req.body || {};
    const item = await addUpcoming({ uid: req.uid, malId, anilistId, title, img, totalEps });
    res.json({ ok: true, item });
  } catch (err) {
    fail(res, 400, err.message || 'Failed to add');
  }
});

app.delete('/api/upcoming/:malId', authenticate, async (req, res) => {
  try {
    await removeUpcoming({ uid: req.uid, malId: req.params.malId });
    res.json({ ok: true });
  } catch (err) {
    fail(res, 400, err.message || 'Failed to remove');
  }
});

app.post('/api/upcoming/:malId/increment', authenticate, async (req, res) => {
  try {
    const r = await incrementEpisode({ uid: req.uid, malId: req.params.malId });
    res.json(r);
  } catch (err) {
    fail(res, 400, err.message || 'Failed to increment');
  }
});

app.get('/api/upcoming/:malId/ep-title', authenticate, async (req, res) => {
  try {
    const title = req.query.title || '';
    const ep = parseInt(req.query.ep, 10) || 1;
    const name = await getEpisodeTitle(req.params.malId, title, ep);
    res.json({ title: name });
  } catch {
    fail(res, 400, 'Failed to load episode title');
  }
});

app.post('/api/collection/prime/:malId', authenticate, async (req, res) => {
  try {
    const prime = await togglePrime({ uid: req.uid, malId: req.params.malId });
    res.json({ ok: true, prime });
  } catch (err) {
    fail(res, 400, err.message || 'Failed');
  }
});

app.post('/api/collection/favourite/:malId', authenticate, async (req, res) => {
  try {
    const favourite = await toggleFavourite({ uid: req.uid, malId: req.params.malId });
    res.json({ ok: true, favourite });
  } catch (err) {
    fail(res, 400, err.message || 'Failed');
  }
});

// ================= COINS / STORE =================

app.post('/api/coins/daily', authenticate, async (req, res) => {
  try {
    const r = await claimDaily({ uid: req.uid });
    res.json(r);
  } catch (err) {
    fail(res, 400, err.message || 'Claim failed');
  }
});

app.get('/api/store/items', async (req, res) => {
  try {
    const snap = await db.collection('storeItems').where('active', '==', true).get();
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ items });
  } catch {
    fail(res, 500, 'Failed to load store');
  }
});

app.post('/api/store/buy/:itemId', authenticate, async (req, res) => {
  try {
    const r = await purchaseItem({ uid: req.uid, itemId: req.params.itemId });
    res.json(r);
  } catch (err) {
    fail(res, 400, err.message || 'Purchase failed');
  }
});

// ================= POLLS =================

app.get('/api/polls', authenticate, async (req, res) => {
  try {
    const snap = await db.collection('polls').get();
    const list = snap.docs
      .map((d) => {
        const p = d.data();
        return {
          id: d.id,
          animeTitle: p.animeTitle,
          question: p.question,
          options: p.options,
          creatorName: p.creatorName,
          creatorId: p.creatorId,
          voters: p.voters || [],
          flags: p.flags || []
        };
      })
      .filter((p) => p.creatorId !== req.uid);
    res.json({ polls: list });
  } catch {
    fail(res, 500, 'Failed to load polls');
  }
});

app.get('/api/polls/mine', authenticate, async (req, res) => {
  try {
    const snap = await db.collection('polls').where('creatorId', '==', req.uid).get();
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ polls: list });
  } catch {
    fail(res, 500, 'Failed to load polls');
  }
});

app.post('/api/polls', authenticate, async (req, res) => {
  try {
    const { animeTitle, question, options, correctIndex } = req.body || {};
    if (!animeTitle || !question || !Array.isArray(options) || options.length !== 4) {
      return fail(res, 400, 'Invalid poll payload');
    }
    const userSnap = await db.doc(`users/${req.uid}`).get();
    if (!userSnap.exists) return fail(res, 404, 'User not found');
    const user = userSnap.data();
    const ref = await db.collection('polls').add({
      animeTitle: String(animeTitle).slice(0, 100),
      question: String(question).slice(0, 300),
      options: options.map((o) => String(o).slice(0, 150)),
      correctIndex: Math.max(0, Math.min(3, parseInt(correctIndex, 10) || 0)),
      creatorId: req.uid,
      creatorName: user.name || '',
      voters: [],
      flags: [],
      createdAt: new Date().toISOString()
    });
    res.json({ ok: true, id: ref.id });
  } catch {
    fail(res, 400, 'Failed to create poll');
  }
});

app.post('/api/polls/:id/answer', authenticate, async (req, res) => {
  try {
    const { optionIndex } = req.body || {};
    const r = await answerPoll({ uid: req.uid, pollId: req.params.id, optionIndex: parseInt(optionIndex, 10) });
    res.json(r);
  } catch (err) {
    fail(res, 400, err.message || 'Failed');
  }
});

app.post('/api/polls/:id/report', authenticate, async (req, res) => {
  try {
    await reportPoll({ uid: req.uid, pollId: req.params.id });
    res.json({ ok: true });
  } catch {
    fail(res, 400, 'Failed');
  }
});

app.delete('/api/polls/:id', authenticate, async (req, res) => {
  try {
    const isAdmin = await maybeAdmin(req.uid);
    await deletePoll({ uid: req.uid, pollId: req.params.id, isAdmin });
    res.json({ ok: true });
  } catch (err) {
    fail(res, 400, err.message || 'Failed');
  }
});

// ================= UPLOAD / SCANNER =================

app.post('/api/upload/avatar', authenticate, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return fail(res, 400, 'No image');
    const url = await uploadToImgBB(req.file.buffer, req.file.mimetype);
    res.json({ url });
  } catch (err) {
    fail(res, 400, err.message || 'Upload failed');
  }
});

app.post('/api/scanner/identify', authenticate, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return fail(res, 400, 'No image');
    let match = null;
    let matchConfidence = 0;
    let identifiedTitle = null;
    let anilistId = null;

    try {
      const td = await traceMoeSearch(req.file.buffer, req.file.mimetype);
      if (td && Array.isArray(td.result) && td.result.length && td.result[0].similarity >= 0.87) {
        const best = td.result[0];
        matchConfidence = parseFloat((best.similarity * 100).toFixed(1));
        identifiedTitle = (best.anilist && best.anilist.title && (best.anilist.title.english || best.anilist.title.romaji)) || null;
        anilistId = (best.anilist && best.anilist.id) || null;
        match = {
          episode: best.episode,
          from: best.from,
          video: best.video || null
        };
      }
    } catch {}

    if (!identifiedTitle) {
      const base64 = req.file.buffer.toString('base64');
      const gem = await scanWithGemini(base64);
      if (!gem || !gem.isAnime || !gem.animeTitle || (gem.confidence && gem.confidence < 85)) {
        return res.json({
          identified: false,
          reason: (gem && gem.rejectionReason) || 'No anime detected'
        });
      }
      identifiedTitle = gem.animeTitle;
      matchConfidence = gem.confidence ? parseFloat(gem.confidence) : 95.0;
      match = { character: gem.character || null };
    }

    let media = null;
    if (anilistId) {
      const d = await getAnimeDetails({ id: anilistId });
      media = d;
    }
    if (!media && identifiedTitle) {
      const s = await searchAnime({ search: identifiedTitle });
      const list = (s && s.data && s.data.Page && s.data.Page.media) || [];
      media = list[0] || null;
    }

    res.json({
      identified: true,
      confidence: matchConfidence,
      traceMatch: match,
      title: (media && (media.title.english || media.title.romaji)) || identifiedTitle,
      media
    });
  } catch (err) {
    console.error('[scanner]', err);
    fail(res, 500, 'Scanner failed');
  }
});

// ================= ANIME / MANGA / NEWS / RADIO =================

app.get('/api/anime/trending', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const r = await getTrendingAnime(page);
    res.json(r);
  } catch {
    fail(res, 500, 'Failed');
  }
});

app.get('/api/anime/search', async (req, res) => {
  try {
    const r = await searchAnime(req.query || {});
    res.json(r);
  } catch {
    fail(res, 500, 'Failed');
  }
});

app.get('/api/anime/details', async (req, res) => {
  try {
    const r = await getAnimeDetails(req.query || {});
    if (!r) return fail(res, 404, 'Not found');
    res.json(r);
  } catch {
    fail(res, 500, 'Failed');
  }
});

app.get('/api/anime/schedule', async (req, res) => {
  try {
    const r = await getAiringSchedule();
    res.json(r);
  } catch {
    fail(res, 500, 'Failed');
  }
});

app.get('/api/anime/seasonal', async (req, res) => {
  try {
    const { season, year } = req.query;
    if (!season || !year) return fail(res, 400, 'season and year required');
    const r = await getSeasonal(season, year);
    res.json(r);
  } catch {
    fail(res, 500, 'Failed');
  }
});

app.get('/api/manga/trending', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const r = await trendingManga(page);
    res.json(r);
  } catch {
    fail(res, 500, 'Failed');
  }
});

app.get('/api/manga/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q) return fail(res, 400, 'q required');
    const r = await searchManga(q);
    res.json(r);
  } catch {
    fail(res, 500, 'Failed');
  }
});

app.get('/api/manga/:id', async (req, res) => {
  try {
    const r = await getMangaDetails(req.params.id);
    res.json(r);
  } catch {
    fail(res, 500, 'Failed');
  }
});

app.get('/api/music/stations', async (req, res) => {
  try {
    const list = await getRadioStations();
    const safe = (Array.isArray(list) ? list : [])
      .filter((s) => s && /^https?:\/\//i.test(s.url_resolved || ''))
      .map((s) => ({ name: s.name, country: s.country, bitrate: s.bitrate, url: s.url_resolved }));
    res.json({ stations: safe });
  } catch {
    fail(res, 500, 'Failed');
  }
});

app.get('/api/neko/celebrate', async (req, res) => {
  try {
    const r = await getCelebrationGif();
    const url = (r && r.results && r.results[0] && r.results[0].url) || '';
    res.json({ url });
  } catch {
    res.json({ url: '' });
  }
});

app.get('/api/news', async (req, res) => {
  try {
    const target = 'https://www.animenewsnetwork.com/all/rss.xml';
    const proxies = [
      'https://api.allorigins.win/raw?url=',
      'https://api.codetabs.com/v1/proxy?quest='
    ];
    let xml = '';
    for (const p of proxies) {
      try {
        const r = await fetch(p + encodeURIComponent(target));
        if (!r.ok) continue;
        const text = await r.text();
        if (text && (text.includes('<rss') || text.includes('<channel'))) { xml = text; break; }
      } catch {}
    }
    if (!xml) return res.json({ items: [] });
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) && items.length < 25) {
      const block = m[1];
      const pick = (tag) => {
        const x = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
        return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      };
      items.push({
        title: pick('title'),
        link: pick('link'),
        description: pick('description'),
        pubDate: pick('pubDate')
      });
    }
    res.json({ items });
  } catch {
    res.json({ items: [] });
  }
});

// ================= RANK =================

app.get('/api/rank/history', authenticate, async (req, res) => {
  try {
    const user = await getActiveUser(req.uid);
    const history = Array.isArray(user.expHistory) ? [...user.expHistory] : [];
    history.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ history, totalExp: user.totalExp || 0, rank: user.rank || 'E' });
  } catch {
    fail(res, 500, 'Failed');
  }
});

export default app;