const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const { firebase, googleClientId, imgbbKey, geminiKey, apis } = require('./api');
const {
  isValidEmail, safeString, validImageUrl, signSession
} = require('./utils');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: firebase.projectId,
      clientEmail: firebase.clientEmail,
      privateKey: firebase.privateKey,
    }),
  });
}
const db = admin.firestore();
const googleClient = new OAuth2Client(googleClientId);

const DEFAULT_CONFIG = {
  dailyBonus: 50, maxUpcoming: 3, maxPrime: 3, maxFavourite: 4,
  rankThresholds: { D: 250, C: 500, B: 750, A: 1000 }
};

async function getAppConfig() {
  try {
    const snap = await db.doc('meta/config').get();
    if (snap.exists) {
      const data = snap.data();
      return {
        ...DEFAULT_CONFIG, ...data,
        rankThresholds: { ...DEFAULT_CONFIG.rankThresholds, ...(data.rankThresholds || {}) }
      };
    }
  } catch (e) { }
  return { ...DEFAULT_CONFIG };
}

function computeRank(exp, thresholds) {
  const th = thresholds || DEFAULT_CONFIG.rankThresholds;
  if (exp >= th.A) return 'A';
  if (exp >= th.B) return 'B';
  if (exp >= th.C) return 'C';
  if (exp >= th.D) return 'D';
  return 'E';
}

async function generateNextUID() {
  const ref = db.doc('meta/uidCounter');
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let n = 1000000000;
    if (snap.exists && snap.data().current) n = snap.data().current + 1;
    tx.set(ref, { current: n }, { merge: true });
    return String(n);
  });
}

// ---------- GOOGLE AUTH ----------
async function handleGoogleAuth(idToken) {
  const ticket = await googleClient.verifyIdToken({ idToken, audience: googleClientId });
  const payload = ticket.getPayload();
  const uid = payload.sub;
  const userRef = db.collection('users').doc(uid);
  let snap = await userRef.get();

  if (!snap.exists) {
    // Check if a user with this email already exists (backup email conflict)
    const emailCheck = await db.collection('users').where('backupEmail', '==', (payload.email || '').toLowerCase()).limit(1).get();
    if (!emailCheck.empty) throw new Error('This email is already used as a backup email on another account');

    const customId = await generateNextUID();
    const newUser = {
      uid, customId, email: (payload.email || '').toLowerCase(), backupEmail: '',
      name: safeString(payload.name || 'Hunter', 60),
      avatar: validImageUrl(payload.picture),
      totalExp: 0, rank: 'E', coins: 0, lastClaim: '', activeBorder: '',
      isVerified: false, isBanned: false, ownedItems: [], upcoming: [], collection: [],
      prime: [], favourite: [], followers: [], following: [], setupCompleted: false,
      expHistory: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await userRef.set(newUser);
    snap = await userRef.get();
  }
  const user = snap.data();
  if (user.isBanned) throw new Error('Account banned: ' + (user.banReason || 'Violation'));
  return { user: { id: snap.id, ...user }, token: signSession(uid) };
}

// ---------- BACKUP EMAIL AUTH ----------
async function handleBackupLogin(email, password) {
  const q = db.collection('users').where('backupEmail', '==', (email || '').toLowerCase()).limit(1);
  const snap = await q.get();
  if (snap.empty) throw new Error('Invalid credentials');
  const doc = snap.docs[0];
  const user = doc.data();
  const privSnap = await doc.ref.collection('private').doc('auth').get();
  if (!privSnap.exists) throw new Error('No password set for this account');
  const ok = await bcrypt.compare(password || '', privSnap.data().passwordHash);
  if (!ok) throw new Error('Invalid credentials');
  if (user.isBanned) throw new Error('Account banned');
  return { user: { id: doc.id, ...user }, token: signSession(doc.id) };
}

async function linkBackupEmail(uid, email, password) {
  email = (email || '').toLowerCase();
  if (!isValidEmail(email)) throw new Error('Invalid email');
  if (!password || password.length < 6) throw new Error('Password must be 6+ characters');

  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) throw new Error('User not found');
  if ((snap.data().backupEmail || '').trim()) throw new Error('Backup email already set and cannot be changed');

  const existing = await db.collection('users').where('backupEmail', '==', email).limit(1).get();
  if (!existing.empty) throw new Error('Email already used as backup');

  if ((snap.data().email || '').toLowerCase() === email) throw new Error('Cannot use your Google email as backup');

  const hash = await bcrypt.hash(password, 10);
  await userRef.update({ backupEmail: email });
  await userRef.collection('private').doc('auth').set({ passwordHash: hash });
}

async function changePassword(uid, currentPassword, newPassword) {
  if (!newPassword || newPassword.length < 6) throw new Error('Password must be 6+ characters');
  const ref = db.collection('users').doc(uid).collection('private').doc('auth');
  const snap = await ref.get();
  if (!snap.exists) throw new Error('No password set');
  const ok = await bcrypt.compare(currentPassword || '', snap.data().passwordHash);
  if (!ok) throw new Error('Current password incorrect');
  await ref.set({ passwordHash: await bcrypt.hash(newPassword, 10) });
}

// ---------- USER ----------
async function getUser(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw new Error('User not found');
  return { id: snap.id, ...snap.data() };
}

async function getPublicUser(uid) {
  const u = await getUser(uid);
  const { email, backupEmail, ...pub } = u;
  return pub;
}

async function updateUserProfile(uid, { name, avatar }) {
  const updates = {};
  if (name) updates.name = safeString(String(name).trim(), 60);
  if (avatar && validImageUrl(avatar)) updates.avatar = avatar;
  if (Object.keys(updates).length === 0) throw new Error('No valid fields to update');
  await db.collection('users').doc(uid).update(updates);
  return await getUser(uid);
}

async function completeSetup(uid, { name, avatar }) {
  if (!name || !String(name).trim()) throw new Error('Name required');
  const updates = {
    name: safeString(String(name).trim(), 60),
    avatar: avatar ? validImageUrl(avatar) : undefined,
    setupCompleted: true,
  };
  if (!updates.avatar) delete updates.avatar;
  await db.collection('users').doc(uid).update(updates);
  return await getUser(uid);
}

async function searchUserByUid(customId) {
  if (!/^\d{10}$/.test(String(customId || ''))) throw new Error('UID must be 10 digits');
  const snap = await db.collection('users').where('customId', '==', String(customId)).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  const u = d.data();
  return { uid: d.id, customId: u.customId, name: u.name, avatar: u.avatar, rank: u.rank || 'E' };
}

async function followUser(myUid, targetUid) {
  if (myUid === targetUid) throw new Error('Cannot follow yourself');
  await db.runTransaction(async (tx) => {
    const meRef = db.collection('users').doc(myUid);
    const tgRef = db.collection('users').doc(targetUid);
    const meSnap = await tx.get(meRef);
    const tgSnap = await tx.get(tgRef);
    if (!meSnap.exists || !tgSnap.exists) throw new Error('User not found');
    const following = meSnap.data().following || [];
    const isFollowing = following.includes(targetUid);
    tx.update(meRef, {
      following: isFollowing
        ? admin.firestore.FieldValue.arrayRemove(targetUid)
        : admin.firestore.FieldValue.arrayUnion(targetUid)
    });
    tx.update(tgRef, {
      followers: isFollowing
        ? admin.firestore.FieldValue.arrayRemove(myUid)
        : admin.firestore.FieldValue.arrayUnion(myUid)
    });
  });
  return await getPublicUser(myUid);
}

async function getRankInfo(uid) {
  const user = await getUser(uid);
  const cfg = await getAppConfig();
  const th = cfg.rankThresholds;
  const exp = user.totalExp || 0;
  const rank = computeRank(exp, th);
  let target = th.D;
  if (exp >= th.A) target = th.A;
  else if (exp >= th.B) target = th.A;
  else if (exp >= th.C) target = th.B;
  else if (exp >= th.D) target = th.C;
  // Persist if changed
  if (user.rank !== rank) {
    try { await db.collection('users').doc(uid).update({ rank }); } catch (e) { }
  }
  return { rank, exp, target, thresholds: th };
}

// ---------- ECONOMY ----------
async function claimDailyBonus(uid) {
  const today = new Date().toDateString();
  const cfg = await getAppConfig();
  const bonus = Number(cfg.dailyBonus) || 50;

  return await db.runTransaction(async (tx) => {
    const bankSnap = await tx.get(db.doc('meta/bank'));
    if (!bankSnap.exists) throw new Error('Bank not initialized');
    const bank = bankSnap.data();
    const adminRef = db.collection('admins').doc(bank.treasuryAdminUid);
    const adminSnap = await tx.get(adminRef);
    if (!adminSnap.exists) throw new Error('Treasury admin missing');
    const adminData = adminSnap.data();

    const userRef = db.collection('users').doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();

    if (user.isBanned) throw new Error('Account banned');
    if (user.lastClaim === today) throw new Error('Already claimed today');
    if ((adminData.coins || 0) < bonus) throw new Error('Treasury has no coins. Contact admin.');

    const newCoins = (user.coins || 0) + bonus;
    tx.update(adminRef, { coins: (adminData.coins || 0) - bonus });
    tx.update(userRef, { coins: newCoins, lastClaim: today });
    tx.set(db.collection('coinTransactions').doc(), {
      type: 'DAILY_CLAIM', from: 'admin', to: uid, amount: bonus,
      userBalanceAfter: newCoins, timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    return { coins: newCoins };
  });
}

async function buyStoreItem(uid, itemId) {
  const itemSnap = await db.collection('storeItems').doc(itemId).get();
  if (!itemSnap.exists) throw new Error('Item not found');
  const item = itemSnap.data();
  if (!item.active) throw new Error('Item not available');

  const durationDays = item.durationDays || 30;
  const expiresAt = Date.now() + (durationDays * 24 * 60 * 60 * 1000);

  return await db.runTransaction(async (tx) => {
    const bankSnap = await tx.get(db.doc('meta/bank'));
    const bank = bankSnap.data();
    const adminRef = db.collection('admins').doc(bank.treasuryAdminUid);
    const adminSnap = await tx.get(adminRef);
    const adminData = adminSnap.data();

    const userRef = db.collection('users').doc(uid);
    const userSnap = await tx.get(userRef);
    const user = userSnap.data();
    if (user.isBanned) throw new Error('Account banned');
    if ((user.coins || 0) < item.price) throw new Error('Insufficient coins');

    const newCoins = (user.coins || 0) - item.price;
    let owned = (user.ownedItems || []).filter(o => {
      if (typeof o === 'string') return true;
      return o.expiresAt > Date.now() && o.id !== itemId;
    });
    owned.push({ id: itemId, expiresAt });
    const updates = { coins: newCoins, ownedItems: owned };
    if ((item.type || 'border') === 'border') updates.activeBorder = item.cssClass;

    tx.update(userRef, updates);
    tx.update(adminRef, { coins: (adminData.coins || 0) + item.price });
    tx.set(db.collection('coinTransactions').doc(), {
      type: 'PURCHASE', from: uid, to: 'admin', amount: item.price,
      meta: { itemId, itemName: item.name, durationDays },
      userBalanceAfter: newCoins, timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    return { coins: newCoins, owned, activeBorder: updates.activeBorder };
  });
}

// ---------- UPCOMING ----------
async function addToUpcoming(uid, anime) {
  const cfg = await getAppConfig();
  const malId = String(anime.malId || '');
  if (!malId) throw new Error('Missing malId');

  return await db.runTransaction(async (tx) => {
    const userRef = db.collection('users').doc(uid);
    const snap = await tx.get(userRef);
    const user = snap.data();
    if (user.isBanned) throw new Error('Account banned');
    const upcoming = [...(user.upcoming || [])];
    if (upcoming.some(u => String(u.malId) === malId)) throw new Error('Already in upcoming');
    if (upcoming.length >= cfg.maxUpcoming) throw new Error(`Upcoming full (max ${cfg.maxUpcoming})`);
    const item = {
      malId,
      anilistId: anime.anilistId || null,
      title: safeString(anime.title || '', 200),
      img: validImageUrl(anime.img),
      currentEp: 0,
      totalEps: anime.totalEps || 12,
      lastWatchedDate: ''
    };
    upcoming.push(item);
    tx.update(userRef, { upcoming });
    return { upcoming };
  });
}

async function removeFromUpcoming(uid, malId) {
  return await db.runTransaction(async (tx) => {
    const userRef = db.collection('users').doc(uid);
    const snap = await tx.get(userRef);
    const upcoming = (snap.data().upcoming || []).filter(u => String(u.malId) !== String(malId));
    tx.update(userRef, { upcoming });
    return { upcoming };
  });
}

async function incrementWatchingEpisode(uid, malId) {
  const today = new Date().toDateString();
  const cfg = await getAppConfig();

  return await db.runTransaction(async (tx) => {
    const userRef = db.collection('users').doc(uid);
    const snap = await tx.get(userRef);
    const user = snap.data();
    if (user.isBanned) throw new Error('Account banned');

    const upcoming = [...(user.upcoming || [])];
    const idx = upcoming.findIndex(u => String(u.malId) === String(malId));
    if (idx === -1) throw new Error('Not in upcoming');
    const item = { ...upcoming[idx] };
    if (item.lastWatchedDate === today) throw new Error('Only 1 episode per day allowed');
    item.currentEp = (item.currentEp || 0) + 1;
    item.lastWatchedDate = today;
    upcoming[idx] = item;

    const complete = item.currentEp >= (item.totalEps || 12);
    if (!complete) {
      tx.update(userRef, { upcoming });
      return { complete: false, upcoming };
    }

    // Completion rewards
    const bankSnap = await tx.get(db.doc('meta/bank'));
    const bank = bankSnap.data();
    const adminRef = db.collection('admins').doc(bank.treasuryAdminUid);
    const adminSnap = await tx.get(adminRef);
    const adminData = adminSnap.data();
    const rewardCoins = 10;
    const canPay = (adminData.coins || 0) >= rewardCoins;

    const filtered = upcoming.filter(u => String(u.malId) !== String(malId));
    const collection = [...(user.collection || [])];
    if (!collection.some(c => String(c.malId) === String(malId))) {
      collection.push({ malId: String(item.malId), anilistId: item.anilistId || null, title: item.title, img: item.img });
    }

    const newExp = (user.totalExp || 0) + 50;
    const newRank = computeRank(newExp, cfg.rankThresholds);
    const updates = {
      upcoming: filtered,
      collection,
      totalExp: newExp,
      rank: newRank,
      expHistory: admin.firestore.FieldValue.arrayUnion({
        amount: 50, reason: `Completed ${item.title}`, date: new Date().toISOString()
      }),
    };
    if (canPay) updates.coins = admin.firestore.FieldValue.increment(rewardCoins);
    tx.update(userRef, updates);

    if (canPay) {
      tx.update(adminRef, { coins: (adminData.coins || 0) - rewardCoins });
      tx.set(db.collection('coinTransactions').doc(), {
        type: 'ANIME_COMPLETE', from: 'admin', to: uid, amount: rewardCoins,
        meta: { animeId: item.malId, animeTitle: item.title },
        userBalanceAfter: (user.coins || 0) + rewardCoins,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return { complete: true, title: item.title, coinsPaid: canPay, newRank };
  });
}

// ---------- COLLECTION ----------
async function togglePrime(uid, malId) {
  const cfg = await getAppConfig();
  return await db.runTransaction(async (tx) => {
    const ref = db.collection('users').doc(uid);
    const snap = await tx.get(ref);
    const user = snap.data();
    const anime = (user.collection || []).find(c => String(c.malId) === String(malId));
    if (!anime) throw new Error('Not in collection');
    const prime = [...(user.prime || [])];
    const idx = prime.findIndex(p => String(p.malId) === String(malId));
    if (idx > -1) prime.splice(idx, 1);
    else {
      if (prime.length >= cfg.maxPrime) throw new Error(`Max ${cfg.maxPrime} prime`);
      prime.push({ malId: String(malId), anilistId: anime.anilistId || null, title: anime.title, img: anime.img });
    }
    tx.update(ref, { prime });
    return { prime };
  });
}

async function toggleFavorite(uid, malId) {
  const cfg = await getAppConfig();
  return await db.runTransaction(async (tx) => {
    const ref = db.collection('users').doc(uid);
    const snap = await tx.get(ref);
    const user = snap.data();
    const anime = (user.collection || []).find(c => String(c.malId) === String(malId));
    if (!anime) throw new Error('Not in collection');
    const fav = [...(user.favourite || [])];
    const idx = fav.findIndex(f => String(f.malId) === String(malId));
    if (idx > -1) fav.splice(idx, 1);
    else {
      if (fav.length >= cfg.maxFavourite) throw new Error(`Max ${cfg.maxFavourite} favourites`);
      fav.push({ malId: String(malId), anilistId: anime.anilistId || null, title: anime.title, img: anime.img });
    }
    tx.update(ref, { favourite: fav });
    return { favourite: fav };
  });
}

// ---------- POLLS ----------
async function createPoll(uid, data) {
  const user = await getUser(uid);
  const { animeTitle, question, options, correctIndex } = data || {};
  const opts = (options || []).map(o => safeString(o, 150)).filter(Boolean);
  if (!animeTitle || !question || opts.length !== 4) throw new Error('Invalid poll data');
  if (correctIndex < 0 || correctIndex > 3) throw new Error('Invalid correct answer');
  const ref = await db.collection('polls').add({
    animeTitle: safeString(animeTitle, 100),
    question: safeString(question, 300),
    options: opts,
    correctIndex: Number(correctIndex),
    creatorId: uid,
    creatorName: user.name,
    voters: [],
    flags: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { id: ref.id };
}

async function listPolls(uid) {
  const snap = await db.collection('polls').orderBy('createdAt', 'desc').limit(50).get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => p.creatorId !== uid)
    .map(p => {
      const { correctIndex, ...safe } = p;
      return safe;
    });
}

async function listMyPolls(uid) {
  const snap = await db.collection('polls').where('creatorId', '==', uid).get();
  return snap.docs.map(d => {
    const { correctIndex, ...safe } = { id: d.id, ...d.data() };
    return safe;
  });
}

async function answerPoll(uid, pollId, optionIndex) {
  const cfg = await getAppConfig();
  return await db.runTransaction(async (tx) => {
    const pollRef = db.collection('polls').doc(pollId);
    const pollSnap = await tx.get(pollRef);
    if (!pollSnap.exists) throw new Error('Poll not found');
    const poll = pollSnap.data();
    if (poll.creatorId === uid) throw new Error('Cannot answer own poll');
    if ((poll.voters || []).includes(uid)) throw new Error('Already answered');
    if (optionIndex < 0 || optionIndex >= (poll.options || []).length) throw new Error('Invalid option');
    const correct = Number(optionIndex) === Number(poll.correctIndex);

    const userRef = db.collection('users').doc(uid);
    const userSnap = await tx.get(userRef);
    const user = userSnap.data();

    tx.update(pollRef, { voters: admin.firestore.FieldValue.arrayUnion(uid) });
    if (poll.creatorId) {
      tx.update(db.collection('users').doc(poll.creatorId), {
        totalExp: admin.firestore.FieldValue.increment(15)
      });
    }

    let awarded = { exp: 0, coins: 0 };
    if (correct) {
      const bankSnap = await tx.get(db.doc('meta/bank'));
      const bank = bankSnap.data();
      const adminRef = db.collection('admins').doc(bank.treasuryAdminUid);
      const adminSnap = await tx.get(adminRef);
      const adminData = adminSnap.data();
      if ((adminData.coins || 0) >= 5) {
        const newExp = (user.totalExp || 0) + 10;
        tx.update(adminRef, { coins: (adminData.coins || 0) - 5 });
        tx.update(userRef, {
          totalExp: newExp,
          rank: computeRank(newExp, cfg.rankThresholds),
          coins: admin.firestore.FieldValue.increment(5),
          expHistory: admin.firestore.FieldValue.arrayUnion({
            amount: 10, reason: 'Correct poll answer', date: new Date().toISOString()
          }),
        });
        tx.set(db.collection('coinTransactions').doc(), {
          type: 'POLL_REWARD', from: 'admin', to: uid, amount: 5,
          meta: { pollId }, userBalanceAfter: (user.coins || 0) + 5,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        awarded = { exp: 10, coins: 5 };
      }
    }
    return { correct, awarded };
  });
}

async function reportPoll(uid, pollId) {
  await db.collection('polls').doc(pollId).update({
    flags: admin.firestore.FieldValue.arrayUnion(uid)
  });
}

// ---------- LEADERBOARD ----------
async function getLeaderboard() {
  const snap = await db.collection('users').orderBy('totalExp', 'desc').limit(10).get();
  return snap.docs.map((d, i) => {
    const u = d.data();
    return {
      rank: i + 1, uid: d.id, name: u.name, avatar: u.avatar,
      rankLabel: u.rank || 'E', totalExp: u.totalExp || 0
    };
  });
}

// ---------- ANILIST ----------
async function anilistQuery(query, variables) {
  const r = await fetch(apis.anilist, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const data = await r.json();
  if (data.errors) throw new Error('AniList error: ' + data.errors[0]?.message);
  return data.data;
}

async function getTrendingAnime(page = 1) {
  const q = `query($page:Int){Page(page:$page,perPage:20){media(sort:POPULARITY_DESC,type:ANIME){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
  const data = await anilistQuery(q, { page });
  return data.Page.media.map(a => ({
    id: a.id, malId: a.idMal || `ali_${a.id}`,
    title: a.title.english || a.title.romaji || 'Unknown',
    img: a.coverImage?.large || '',
    score: a.averageScore || null,
    episodes: a.episodes || null,
  }));
}

async function searchAnime(params) {
  const { text, genre, year, format, status, score } = params;
  const argParts = ['type:ANIME', 'sort:POPULARITY_DESC'];
  const vars = {};
  const types = { search: 'String', genre: 'String', year: 'Int', format: 'MediaFormat', status: 'MediaStatus', score: 'Int' };
  if (text) { argParts.push('search:$search'); vars.search = text; }
  if (genre) { argParts.push('genre:$genre'); vars.genre = genre; }
  if (year) { argParts.push('seasonYear:$year'); vars.year = parseInt(year); }
  if (format) { argParts.push('format:$format'); vars.format = format; }
  if (status) { argParts.push('status:$status'); vars.status = status; }
  if (score) { argParts.push('averageScore_greater:$score'); vars.score = parseInt(score); }
  const varDefs = Object.keys(vars).map(k => `$${k}:${types[k]}`).join(',');
  const q = varDefs
    ? `query(${varDefs}){Page(page:1,perPage:50){media(${argParts.join(',')}){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`
    : `{Page(page:1,perPage:50){media(${argParts.join(',')}){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
  const data = await anilistQuery(q, vars);
  return data.Page.media.map(a => ({
    id: a.id, malId: a.idMal || `ali_${a.id}`,
    title: a.title.english || a.title.romaji || 'Unknown',
    img: a.coverImage?.large || '', score: a.averageScore || null,
  }));
}

async function getAnimeDetails(anilistId, malId) {
  const FIELDS = `id idMal title{romaji english} coverImage{extraLarge large} bannerImage averageScore episodes description genres externalLinks{site url type}`;
  let q, v;
  if (anilistId && /^\d+$/.test(String(anilistId))) {
    q = `query($id:Int){Media(id:$id,type:ANIME){${FIELDS}}}`;
    v = { id: parseInt(anilistId) };
  } else if (malId && /^\d+$/.test(String(malId))) {
    q = `query($malId:Int){Media(idMal:$malId,type:ANIME){${FIELDS}}}`;
    v = { malId: parseInt(malId) };
  } else throw new Error('Invalid anime id');
  const data = await anilistQuery(q, v);
  if (!data.Media) throw new Error('Anime not found');
  return data.Media;
}

// ---------- MANGADEX ----------
async function getTrendingManga(page = 1) {
  const offset = (page - 1) * 20;
  const r = await fetch(`${apis.mangadex}/manga?limit=20&offset=${offset}&includes[]=cover_art&order[followedCount]=desc`);
  const d = await r.json();
  return (d.data || []).map(m => {
    const title = m.attributes?.title?.en || Object.values(m.attributes?.title || {})[0] || 'Unknown';
    const cover = (m.relationships || []).find(x => x.type === 'cover_art');
    const img = cover?.attributes?.fileName
      ? `${apis.mangadexCovers}/covers/${m.id}/${cover.attributes.fileName}.256.jpg`
      : '';
    return { id: m.id, title, img };
  });
}

async function searchManga(text) {
  const r = await fetch(`${apis.mangadex}/manga?title=${encodeURIComponent(text || '')}&limit=20&includes[]=cover_art&order[relevance]=desc`);
  const d = await r.json();
  return (d.data || []).map(m => {
    const title = m.attributes?.title?.en || Object.values(m.attributes?.title || {})[0] || 'Unknown';
    const cover = (m.relationships || []).find(x => x.type === 'cover_art');
    const img = cover?.attributes?.fileName
      ? `${apis.mangadexCovers}/covers/${m.id}/${cover.attributes.fileName}.256.jpg`
      : '';
    return { id: m.id, title, img };
  });
}

async function getMangaDetails(id) {
  const r = await fetch(`${apis.mangadex}/manga/${encodeURIComponent(id)}`);
  const d = await r.json();
  if (!d.data) throw new Error('Manga not found');
  const m = d.data;
  const desc = m.attributes?.description?.en || Object.values(m.attributes?.description || {})[0] || 'No description';
  const genres = (m.attributes?.tags || [])
    .filter(t => t.attributes?.group === 'genre')
    .map(t => t.attributes?.name?.en).filter(Boolean).slice(0, 5);
  return {
    id: m.id,
    title: m.attributes?.title?.en || Object.values(m.attributes?.title || {})[0] || 'Manga',
    description: desc,
    status: m.attributes?.status,
    genres,
  };
}

// ---------- SCHEDULE ----------
async function getAiringSchedule() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const from = Math.floor(now.getTime() / 1000);
  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const to = Math.floor(weekEnd.getTime() / 1000);

  const all = [];
  let page = 1;
  let hasNext = true;
  while (hasNext && page <= 20) {
    const q = `query($from:Int,$to:Int,$page:Int){Page(page:$page,perPage:50){pageInfo{hasNextPage}airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){airingAt episode media{id idMal title{romaji english} coverImage{large}}}}}`;
    const data = await anilistQuery(q, { from, to, page });
    const p = data.Page;
    all.push(...(p.airingSchedules || []));
    hasNext = !!p.pageInfo?.hasNextPage && (p.airingSchedules || []).length === 50;
    page++;
  }

  const groups = {};
  all.forEach(a => {
    const dt = new Date(a.airingAt * 1000);
    const key = dt.toDateString();
    if (!groups[key]) groups[key] = { date: dt.toISOString(), items: [] };
    groups[key].items.push({
      airingAt: a.airingAt,
      episode: a.episode,
      media: {
        id: a.media?.id,
        malId: a.media?.idMal || `ali_${a.media?.id}`,
        title: a.media?.title?.english || a.media?.title?.romaji || 'Unknown',
        img: a.media?.coverImage?.large || '',
      }
    });
  });

  return Object.entries(groups).map(([key, g]) => ({
    date: key,
    label: new Date(g.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
    items: g.items,
  }));
}

async function getSeasonal(season, year) {
  const q = `query($season:MediaSeason,$year:Int){Page(page:1,perPage:50){media(season:$season,seasonYear:$year,type:ANIME,sort:POPULARITY_DESC){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
  const data = await anilistQuery(q, { season, year: parseInt(year) });
  return data.Page.media.map(a => ({
    id: a.id, malId: a.idMal || `ali_${a.id}`,
    title: a.title.english || a.title.romaji || 'Unknown',
    img: a.coverImage?.large || '', score: a.averageScore,
  }));
}

// ---------- SCANNER ----------
async function scanAnime(imageBuffer, mimeType) {
  let identifiedTitle = null, confidence = 0, anilistId = null, episode = null, timestamp = null, video = null;

  try {
    const form = new FormData();
    form.append('image', new Blob([imageBuffer], { type: mimeType }), 'image.jpg');
    const r = await fetch(`${apis.traceMoe}/search?anilistInfo`, { method: 'POST', body: form });
    const d = await r.json();
    if (d.result && d.result.length > 0 && d.result[0].similarity >= 0.87) {
      const m = d.result[0];
      confidence = +(m.similarity * 100).toFixed(1);
      identifiedTitle = m.anilist?.title?.english || m.anilist?.title?.romaji;
      anilistId = m.anilist?.id || null;
      episode = m.episode;
      timestamp = m.from;
      video = m.video;
    }
  } catch (e) { console.warn('trace.moe failed:', e.message); }

  if (!identifiedTitle) {
    try {
      const prompt = 'You are a strict Japanese Anime & Manga verification system. Return JSON only: {"isAnime":bool,"confidence":number,"animeTitle":string|null,"character":string|null,"rejectionReason":string|null}';
      const payload = {
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: imageBuffer.toString('base64') } }
          ]
        }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      };
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );
      const g = await r.json();
      const txt = g.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const clean = JSON.parse(txt.replace(/```json|```/g, '').trim());
      if (!clean.isAnime || !clean.animeTitle || (clean.confidence && clean.confidence < 85)) {
        return { isAnime: false, reason: clean.rejectionReason || 'This image is not anime' };
      }
      identifiedTitle = clean.animeTitle;
      confidence = clean.confidence || 95;
    } catch (e) {
      return { isAnime: false, reason: 'Could not verify image' };
    }
  }

  let details = null;
  if (anilistId) {
    try { details = await getAnimeDetails(anilistId); } catch (e) { }
  }
  if (!details && identifiedTitle) {
    try {
      const results = await searchAnime({ text: identifiedTitle });
      if (results[0]) details = await getAnimeDetails(results[0].id);
    } catch (e) { }
  }

  return {
    isAnime: true,
    title: details?.title?.english || details?.title?.romaji || identifiedTitle,
    confidence,
    episode, timestamp, video,
    details,
  };
}

// ---------- MUSIC ----------
async function getMusicStations() {
  const r = await fetch(`${apis.radioBrowser}/json/stations/bytag/anime?limit=40&hidebroken=true&is_https=true&lastcheckok=1`);
  const d = await r.json();
  return (d || [])
    .filter(s => s.url_resolved && /^https?:\/\//i.test(s.url_resolved))
    .map(s => ({ name: s.name || 'Unknown', country: s.country || '', bitrate: s.bitrate || 0, url: s.url_resolved }));
}

// ---------- NEWS ----------
async function getNews() {
  const target = apis.animeNewsRss;
  const proxies = [apis.allorigins, apis.codetabs, apis.corsproxy];
  for (const p of proxies) {
    try {
      const r = await fetch(p + encodeURIComponent(target));
      if (!r.ok) continue;
      const text = await r.text();
      if (!text.includes('<rss') && !text.includes('<channel')) continue;
      const items = [];
      const re = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const chunk = m[1];
        const get = (tag) => {
          const mm = chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
          return mm ? mm[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
        };
        items.push({
          title: get('title'),
          link: get('link'),
          description: get('description'),
          pubDate: get('pubDate'),
        });
      }
      return items.slice(0, 25);
    } catch (e) { continue; }
  }
  throw new Error('Could not fetch news');
}

// ---------- CELEBRATION GIF ----------
async function getCelebrationGif() {
  const r = await fetch(`${apis.nekosBest}/celebrate`);
  const d = await r.json();
  return d.results?.[0]?.url || '';
}

// ---------- AVATAR UPLOAD ----------
async function uploadAvatar(buffer, mimeType) {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: mimeType }), 'avatar.jpg');
  const r = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, { method: 'POST', body: form });
  const d = await r.json();
  if (!d.success) throw new Error('Upload failed');
  return d.data.url;
}

module.exports = {
  getAppConfig, computeRank,
  handleGoogleAuth, handleBackupLogin, linkBackupEmail, changePassword,
  getUser, getPublicUser, updateUserProfile, completeSetup, searchUserByUid, followUser, getRankInfo,
  claimDailyBonus, buyStoreItem,
  addToUpcoming, removeFromUpcoming, incrementWatchingEpisode,
  togglePrime, toggleFavorite,
  createPoll, listPolls, listMyPolls, answerPoll, reportPoll,
  getLeaderboard,
  getTrendingAnime, searchAnime, getAnimeDetails,
  getTrendingManga, searchManga, getMangaDetails,
  getAiringSchedule, getSeasonal,
  scanAnime, getMusicStations, getNews, getCelebrationGif,
  uploadAvatar,
};