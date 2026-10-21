require('dotenv').config();
const express = require('express');
const axios = require('axios');
const config = require('./api');
const corsMiddleware = require('./cors');
const { db, auth, admin } = require('./firebase');
const logic = require('./script');
const { uploadImage } = require('./imgbb');
const { identifyAnime } = require('./gemini');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(corsMiddleware);

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = logic.verifyToken(header.slice(7));
    req.uid = decoded.uid;
    req.email = decoded.email;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function ensureNotBanned(req, res, next) {
  try {
    const snap = await db.doc(`users/${req.uid}`).get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found' });
    const u = snap.data();
    if (u.isBanned) return res.status(403).json({ error: 'Account banned', reason: u.banReason || 'Violation of terms' });
    req.user = { id: snap.id, ...u };
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ---------- CONFIG ----------
app.get('/api/config', async (req, res) => {
  try {
    const cfg = await logic.getAppConfig();
    res.json({
      config: cfg,
      googleClientId: config.googleClientId,
      firebaseWebConfig: config.firebase
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- AUTH ----------
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password, avatar } = req.body || {};
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: 'Email and password (min 6 chars) required' });
    }
    let userRecord;
    try {
      userRecord = await auth.createUser({ email, password, displayName: name || '' });
    } catch (e) {
      if (e.code === 'auth/email-already-exists') return res.status(409).json({ error: 'Email already registered' });
      throw e;
    }
    await logic.createUserRecord(userRecord.uid, email, name, avatar);
    const token = logic.signToken(userRecord.uid, email);
    const user = await logic.getUser(userRecord.uid);
    res.json({ token, user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const data = await logic.signInWithPassword(email, password);
    const user = await logic.getUser(data.localId);
    if (user.isBanned) return res.status(403).json({ error: 'Account banned', reason: user.banReason || 'Violation of terms' });
    const token = logic.signToken(data.localId, email);
    res.json({ token, user });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    res.status(401).json({ error: msg });
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'idToken required' });
    const g = await logic.verifyGoogleToken(idToken);
    const fbUser = await logic.findOrCreateFirebaseUserByEmail(g.email, g.name, g.picture);
    let user;
    try {
      user = await logic.getUser(fbUser.uid);
    } catch (e) {
      user = await logic.createUserRecord(fbUser.uid, g.email, g.name, g.picture);
    }
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });
    const token = logic.signToken(fbUser.uid, g.email);
    res.json({ token, user });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const user = await logic.getUser(req.uid);
    res.json({ user });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.put('/api/auth/setup', authenticate, async (req, res) => {
  try {
    const { name, avatar } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Name required' });
    await logic.updateUser(req.uid, { name, avatar: avatar || '', setupCompleted: true });
    const user = await logic.getUser(req.uid);
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/user/profile', authenticate, ensureNotBanned, async (req, res) => {
  try {
    const { name, avatar } = req.body || {};
    const updates = {};
    if (name) updates.name = name;
    if (avatar) updates.avatar = avatar;
    await logic.updateUser(req.uid, updates);
    const user = await logic.getUser(req.uid);
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- ANIME / MANGA ----------
app.get('/api/anime/trending', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const q = `query($page:Int){Page(page:$page,perPage:20){media(sort:POPULARITY_DESC,type:ANIME){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
    const r = await axios.post(config.endpoints.anilist, { query: q, variables: { page } });
    res.json({ media: r.data.data.Page.media });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/anime/search', async (req, res) => {
  try {
    const { q, genre, year, format, status, score } = req.query;
    const vars = {};
    const parts = ['type:ANIME', 'sort:POPULARITY_DESC'];
    const defs = [];
    if (q) { defs.push('$search:String'); parts.push('search:$search'); vars.search = q; }
    if (genre) { defs.push('$genre:String'); parts.push('genre:$genre'); vars.genre = genre; }
    if (year) { defs.push('$year:Int'); parts.push('seasonYear:$year'); vars.year = parseInt(year, 10); }
    if (format) { defs.push('$format:MediaFormat'); parts.push('format:$format'); vars.format = format; }
    if (status) { defs.push('$status:MediaStatus'); parts.push('status:$status'); vars.status = status; }
    if (score) { defs.push('$score:Int'); parts.push('averageScore_greater:$score'); vars.score = parseInt(score, 10); }
    const queryDef = defs.length ? `query(${defs.join(',')})` : '';
    const q2 = `${queryDef}{Page(page:1,perPage:50){media(${parts.join(',')}){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
    const r = await axios.post(config.endpoints.anilist, { query: q2, variables: vars });
    res.json({ media: r.data.data.Page.media });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/anime/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const q = `query($id:Int){Media(id:$id,type:ANIME){id idMal title{romaji english} coverImage{extraLarge large} bannerImage averageScore episodes description genres externalLinks{site url type}}}`;
    const r = await axios.post(config.endpoints.anilist, { query: q, variables: { id } });
    res.json({ media: r.data.data.Media });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/anime/schedule', async (req, res) => {
  try {
    const now = new Date();
    const from = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
    const to = from + 7 * 24 * 3600;
    const q = `query($from:Int,$to:Int){Page(page:1,perPage:50){airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){airingAt episode media{id idMal title{romaji english} coverImage{large}}}}}`;
    const r = await axios.post(config.endpoints.anilist, { query: q, variables: { from, to } });
    res.json({ schedules: r.data.data.Page.airingSchedules });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/anime/seasonal', async (req, res) => {
  try {
    const { year, season } = req.query;
    const q = `query($season:MediaSeason,$year:Int){Page(page:1,perPage:50){media(season:$season,seasonYear:$year,type:ANIME,sort:POPULARITY_DESC){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
    const r = await axios.post(config.endpoints.anilist, { query: q, variables: { season: season || 'WINTER', year: parseInt(year, 10) || new Date().getFullYear() } });
    res.json({ media: r.data.data.Page.media });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/manga/trending', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const r = await axios.get(`${config.endpoints.mangadex}/manga`, {
      params: { limit: 20, offset: (page - 1) * 20, 'includes[]': 'cover_art', 'order[followedCount]': 'desc' }
    });
    res.json({ manga: r.data.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/manga/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ manga: [] });
    const r = await axios.get(`${config.endpoints.mangadex}/manga`, {
      params: { title: q, limit: 20, 'includes[]': 'cover_art', 'order[relevance]': 'desc' }
    });
    res.json({ manga: r.data.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/manga/:id', async (req, res) => {
  try {
    const r = await axios.get(`${config.endpoints.mangadex}/manga/${encodeURIComponent(req.params.id)}`);
    res.json({ manga: r.data.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- USER / PROGRESS ----------
app.post('/api/progress/upcoming', authenticate, ensureNotBanned, async (req, res) => {
  try {
    const { anime } = req.body || {};
    if (!anime || !anime.malId) return res.status(400).json({ error: 'Anime data required' });
    const user = req.user;
    const upcoming = user.upcoming || [];
    if (upcoming.some(u => String(u.malId) === String(anime.malId))) return res.status(400).json({ error: 'Already in upcoming' });
    const cfg = await logic.getAppConfig();
    if (upcoming.length >= cfg.maxUpcoming) return res.status(400).json({ error: `Upcoming full (max ${cfg.maxUpcoming})` });
    const item = {
      malId: String(anime.malId), anilistId: anime.anilistId || null,
      title: anime.title, img: anime.img, currentEp: 0,
      totalEps: anime.episodes || 12, lastWatchedDate: ''
    };
    await logic.updateUser(req.uid, { upcoming: [...upcoming, item] });
    res.json({ ok: true, upcoming: [...upcoming, item] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/progress/remove', authenticate, async (req, res) => {
  try {
    const { malId } = req.body || {};
    const user = await logic.getUser(req.uid);
    const upcoming = (user.upcoming || []).filter(u => String(u.malId) !== String(malId));
    await logic.updateUser(req.uid, { upcoming });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/progress/increment', authenticate, ensureNotBanned, async (req, res) => {
  try {
    const { malId } = req.body || {};
    const result = await logic.incrementEpisode(req.uid, malId);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/progress/prime', authenticate, ensureNotBanned, async (req, res) => {
  try {
    const { malId } = req.body || {};
    const prime = await logic.togglePrime(req.uid, malId);
    res.json({ prime });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/progress/favourite', authenticate, ensureNotBanned, async (req, res) => {
  try {
    const { malId } = req.body || {};
    const favourite = await logic.toggleFavourite(req.uid, malId);
    res.json({ favourite });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/user/leaderboard', async (req, res) => {
  try {
    const snap = await db.collection('users').orderBy('totalExp', 'desc').limit(10).get();
    const users = snap.docs.map(d => {
      const u = d.data();
      return { uid: d.id, name: u.name, avatar: u.avatar, rank: u.rank, totalExp: u.totalExp || 0 };
    });
    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/search', authenticate, async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid || !/^\d{10}$/.test(uid)) return res.status(400).json({ error: 'Invalid UID' });
    const snap = await db.collection('users').where('customId', '==', uid).limit(1).get();
    if (snap.empty) return res.json({ user: null });
    const d = snap.docs[0];
    const u = d.data();
    res.json({ user: { uid: d.id, name: u.name, avatar: u.avatar, customId: u.customId, rank: u.rank } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/:uid', authenticate, async (req, res) => {
  try {
    const user = await logic.getUser(req.params.uid);
    const safe = {
      uid: user.uid, customId: user.customId, name: user.name, avatar: user.avatar,
      activeBorder: user.activeBorder, isVerified: user.isVerified, rank: user.rank,
      totalExp: user.totalExp, coins: user.coins,
      followers: user.followers || [], following: user.following || [],
      collection: user.collection || [], prime: user.prime || [],
      favourite: user.favourite || [], upcoming: user.upcoming || [],
      ownedItems: user.ownedItems || []
    };
    res.json({ user: safe });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.post('/api/user/:uid/follow', authenticate, ensureNotBanned, async (req, res) => {
  try {
    const result = await logic.toggleFollow(req.uid, req.params.uid);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- ECONOMY ----------
app.post('/api/economy/daily-claim', authenticate, ensureNotBanned, async (req, res) => {
  try {
    const result = await logic.claimDaily(req.uid);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/economy/store', async (req, res) => {
  try {
    const snap = await db.collection('storeItems').where('active', '==', true).get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/economy/buy', authenticate, ensureNotBanned, async (req, res) => {
  try {
    const { itemId } = req.body || {};
    const result = await logic.buyItem(req.uid, itemId);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- POLLS ----------
app.get('/api/polls', authenticate, async (req, res) => {
  try {
    const snap = await db.collection('polls').get();
    const polls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ polls });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/polls', authenticate, ensureNotBanned, async (req, res) => {
  try {
    const { animeTitle, question, options, correctIndex } = req.body || {};
    if (!animeTitle || !question || !Array.isArray(options) || options.length < 2) return res.status(400).json({ error: 'Invalid poll data' });
    const ref = await db.collection('polls').add({
      animeId: '', animeTitle, question, options,
      correctIndex: parseInt(correctIndex, 10) || 0,
      creatorId: req.uid, creatorName: req.user.name,
      voters: [], flags: [], createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ id: ref.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/polls/:id/answer', authenticate, ensureNotBanned, async (req, res) => {
  try {
    const { optionIndex } = req.body || {};
    const result = await logic.answerPoll(req.uid, req.params.id, parseInt(optionIndex, 10));
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/polls/:id/report', authenticate, async (req, res) => {
  try {
    await db.doc(`polls/${req.params.id}`).update({ flags: admin.firestore.FieldValue.arrayUnion(req.uid) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- SCANNER ----------
app.post('/api/scanner/scan', authenticate, async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'Image required' });
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    let identifiedTitle = null, matchConfidence = 0, anilistId = null, meta = {};

    try {
      const tmRes = await axios.post(`${config.endpoints.traceMoe}/search?anilistInfo`,
        Buffer.from(cleanBase64, 'base64'),
        { headers: { 'Content-Type': 'application/octet-stream' }, timeout: 15000 }
      );
      const results = tmRes.data?.result || [];
      if (results[0] && results[0].similarity >= 0.87) {
        const m = results[0];
        identifiedTitle = m.anilist?.title?.english || m.anilist?.title?.romaji;
        anilistId = m.anilist?.id || null;
        matchConfidence = (m.similarity * 100).toFixed(1);
        meta = {
          source: 'Official Episode Scene',
          episode: m.episode !== null ? `Episode ${m.episode}` : 'Movie / Special',
          timestamp: `${Math.floor(m.from / 60)}m ${Math.floor(m.from % 60)}s`,
          video: m.video
        };
      }
    } catch (e) { /* fall through */ }

    if (!identifiedTitle) {
      const g = await identifyAnime(cleanBase64);
      const confidence = Number(g.confidence);
      if (!g.isAnime || !g.animeTitle || !Number.isFinite(confidence) || confidence < 85) {
        return res.json({ rejected: true, reason: g.rejectionReason || 'Not an anime image.' });
      }
      identifiedTitle = g.animeTitle;
      matchConfidence = confidence.toFixed(1);
      meta = { source: g.character ? `Character: ${g.character}` : 'Anime Artwork' };
    }

    let animeDetails = null;
    try {
      const q = anilistId
        ? `query($id:Int){Media(id:$id,type:ANIME){id idMal title{romaji english} coverImage{large} averageScore episodes description genres}}`
        : `query($search:String){Media(search:$search,type:ANIME){id idMal title{romaji english} coverImage{large} averageScore episodes description genres}}`;
      const vars = anilistId ? { id: anilistId } : { search: identifiedTitle };
      const r = await axios.post(config.endpoints.anilist, { query: q, variables: vars });
      animeDetails = r.data.data.Media;
    } catch (e) { /* ignore */ }

    res.json({
      matched: true,
      confidence: matchConfidence,
      title: identifiedTitle,
      meta,
      details: animeDetails
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- UPLOAD ----------
app.post('/api/upload/avatar', authenticate, async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'Image required' });
    const url = await uploadImage(imageBase64);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- NEWS ----------
app.get('/api/news', async (req, res) => {
  try {
    const target = config.endpoints.animeNewsRss;
    const proxies = [config.endpoints.allorigins, config.endpoints.codetabs, config.endpoints.corsproxy];
    let xml = null;
    for (const p of proxies) {
      try {
        const r = await axios.get(p + encodeURIComponent(target), { timeout: 15000 });
        if (r.data && (r.data.includes('<rss') || r.data.includes('<channel'))) { xml = r.data; break; }
      } catch (e) { continue; }
    }
    if (!xml) return res.status(502).json({ error: 'Could not fetch news' });
    res.type('application/xml').send(xml);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- MUSIC ----------
app.get('/api/music/stations', async (req, res) => {
  try {
    const r = await axios.get(`${config.endpoints.radioBrowser}/json/stations/bytag/anime?limit=40&hidebroken=true&is_https=true&lastcheckok=1`);
    res.json({ stations: r.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- ADMIN ----------
async function ensureAdmin(req, res, next) {
  try {
    const snap = await db.doc(`admins/${req.uid}`).get();
    if (!snap.exists) return res.status(403).json({ error: 'Admin only' });
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

app.post('/api/admin/ban/:uid', authenticate, ensureAdmin, async (req, res) => {
  try {
    const { reason } = req.body || {};
    await db.doc(`users/${req.params.uid}`).update({ isBanned: true, banReason: reason || 'Violation of terms' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/unban/:uid', authenticate, ensureAdmin, async (req, res) => {
  try {
    await db.doc(`users/${req.params.uid}`).update({ isBanned: false, banReason: '' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/store', authenticate, ensureAdmin, async (req, res) => {
  try {
    const { name, price, cssClass, type, durationDays, category } = req.body || {};
    if (!name || !price) return res.status(400).json({ error: 'Name and price required' });
    const ref = await db.collection('storeItems').add({
      name, price: parseInt(price, 10), cssClass: cssClass || '',
      type: type || 'border', durationDays: parseInt(durationDays, 10) || 30,
      category: category || 'General', active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ id: ref.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/poll/:id', authenticate, ensureAdmin, async (req, res) => {
  try {
    await db.doc(`polls/${req.params.id}`).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/bank', authenticate, ensureAdmin, async (req, res) => {
  try {
    const snap = await db.doc('meta/bank').get();
    res.json({ bank: snap.exists ? snap.data() : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- HEALTH ----------
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Listening on ${PORT}`));
}

module.exports = app;