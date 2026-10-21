// api/script.js — All business logic, Firestore operations, atomic transactions

import {
  adminDb, adminAuth, FieldValue,
  fetchAnimeDetails, traceMoe, geminiDetect, imgbbUpload,
  fetchKitsuEpisodeTitle
} from './api.js';
import {
  validImageUrl, safeString, getTodayKey, toNumber, clamp, getFriendlyError
} from './utils.js';

const DEFAULT_CONFIG = {
  dailyBonus: 50, maxUpcoming: 3, maxPrime: 3, maxFavourite: 4,
  rankThresholds: { D: 250, C: 500, B: 750, A: 1000 }
};

export async function loadAppConfig() {
  try {
    const snap = await adminDb.doc('meta/config').get();
    if (!snap.exists) return { ...DEFAULT_CONFIG };
    const data = snap.data();
    return {
      ...DEFAULT_CONFIG, ...data,
      rankThresholds: { ...DEFAULT_CONFIG.rankThresholds, ...(data.rankThresholds || {}) }
    };
  } catch (e) {
    console.warn('Config load failed:', e.message);
    return { ...DEFAULT_CONFIG };
  }
}

// ---- Rank calculation ----
export function calculateRank(exp, thresholds) {
  const th = thresholds || DEFAULT_CONFIG.rankThresholds;
  if (exp >= th.A) return { rank: 'A', target: th.A };
  if (exp >= th.B) return { rank: 'B', target: th.A };
  if (exp >= th.C) return { rank: 'C', target: th.B };
  if (exp >= th.D) return { rank: 'D', target: th.C };
  return { rank: 'E', target: th.D };
}

// ---- Dedupe anime by malId ----
function dedupeList(arr) {
  if (!Array.isArray(arr)) return [];
  const m = new Map();
  arr.forEach(it => {
    if (it && it.malId && String(it.malId).trim() !== '' && String(it.malId) !== 'undefined') {
      m.set(String(it.malId), it);
    }
  });
  return Array.from(m.values());
}

// ---- Bank helper (in transaction) ----
async function getBankAndAdmin(tx) {
  const bankRef = adminDb.doc('meta/bank');
  const bankSnap = await tx.get(bankRef);
  if (!bankSnap.exists) throw new Error('Bank not initialized.');
  const bank = bankSnap.data();
  const adminRef = adminDb.doc('admins/' + bank.treasuryAdminUid);
  const adminSnap = await tx.get(adminRef);
  if (!adminSnap.exists) throw new Error('Treasury admin missing.');
  return { bankRef, bank, adminRef, admin: adminSnap.data() };
}

// ---- Generate UID ----
async function generateNextUID() {
  const counterRef = adminDb.doc('meta/uidCounter');
  return await adminDb.runTransaction(async tx => {
    const snap = await tx.get(counterRef);
    let n = 1000000000;
    if (snap.exists && snap.data().current) n = snap.data().current + 1;
    tx.set(counterRef, { current: n }, { merge: true });
    return String(n);
  });
}

// ---- Create user ----
export async function createUser(uid, authData = {}) {
  const customId = await generateNextUID();
  const nu = {
    uid, customId,
    email: authData.email || '',
    backupEmail: '',
    name: safeString(authData.name || 'Gojo Hunter', 60),
    avatar: validImageUrl(authData.picture),
    totalExp: 0, rank: 'E', coins: 0, lastClaim: '',
    activeBorder: '', isVerified: false, isBanned: false,
    ownedItems: [], upcoming: [], collection: [], prime: [], favourite: [],
    followers: [], following: [], expHistory: [],
    setupCompleted: false,
    createdAt: FieldValue.serverTimestamp()
  };
  await adminDb.doc('users/' + uid).set(nu);
  return nu;
}

// ---- Get user ----
export async function getUser(uid) {
  const snap = await adminDb.doc('users/' + uid).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

// ---- Sanitize user data (called on read) ----
export function sanitizeForPublic(userData) {
  if (!userData) return null;
  return {
    uid: userData.uid,
    customId: userData.customId,
    name: userData.name,
    avatar: userData.avatar,
    rank: userData.rank,
    totalExp: toNumber(userData.totalExp),
    isVerified: !!userData.isVerified,
    activeBorder: userData.activeBorder || '',
    collection: Array.isArray(userData.collection) ? userData.collection : [],
    prime: Array.isArray(userData.prime) ? userData.prime : [],
    favourite: Array.isArray(userData.favourite) ? userData.favourite : [],
    upcoming: Array.isArray(userData.upcoming) ? userData.upcoming : [],
    followers: Array.isArray(userData.followers) ? userData.followers : []
  };
}

// ---- Sanitize full user data (for self) ----
export function sanitizeForSelf(userData) {
  if (!userData) return null;
  return {
    ...userData,
    coins: toNumber(userData.coins),
    totalExp: toNumber(userData.totalExp),
    collection: dedupeList(userData.collection),
    upcoming: dedupeList(userData.upcoming),
    prime: dedupeList(userData.prime),
    favourite: dedupeList(userData.favourite),
    expHistory: Array.isArray(userData.expHistory) ? userData.expHistory.slice(-100) : []
  };
}

// ---- Update profile ----
export async function updateProfile(uid, { name, avatar }) {
  const updates = {};
  if (name) updates.name = safeString(name, 60);
  if (avatar) updates.avatar = validImageUrl(avatar);
  if (Object.keys(updates).length === 0) throw new Error('Nothing to update');
  await adminDb.doc('users/' + uid).update(updates);
  return getUser(uid);
}

// ---- Complete setup ----
export async function completeSetup(uid, { name, avatar }) {
  const n = safeString(name, 60);
  if (!n) throw new Error('Name is required');
  await adminDb.doc('users/' + uid).update({
    name: n,
    avatar: validImageUrl(avatar),
    setupCompleted: true
  });
  return getUser(uid);
}

// ---- Backup email precheck ----
export async function precheckBackupEmail(email, ownUid) {
  const e = String(email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Invalid email format');

  // Firebase Auth check
  try {
    const u = await adminAuth.getUserByEmail(e);
    if (u.uid !== ownUid) throw new Error('Email already in use by another account');
  } catch (err) {
    if (err.code !== 'auth/user-not-found') {
      if (err.message && err.message.includes('already in use')) throw err;
    }
  }

  // Firestore check
  const usersRef = adminDb.collection('users');
  const [emailSnap, backupSnap] = await Promise.all([
    usersRef.where('email', '==', e).limit(1).get(),
    usersRef.where('backupEmail', '==', e).limit(1).get()
  ]);
  if (!emailSnap.empty && emailSnap.docs[0].id !== ownUid) throw new Error('Email already in use');
  if (!backupSnap.empty && backupSnap.docs[0].id !== ownUid) throw new Error('Email already linked as backup');

  return true;
}

// ---- Save backup email ----
export async function saveBackupEmail(uid, email) {
  const e = String(email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Invalid email');
  const snap = await adminDb.doc('users/' + uid).get();
  if (!snap.exists) throw new Error('User not found');
  if ((snap.data().backupEmail || '').trim()) throw new Error('Backup email cannot be changed once set');
  await adminDb.doc('users/' + uid).update({ backupEmail: e });
  return getUser(uid);
}

// ---- Add to upcoming ----
export async function addToUpcoming(uid, { malId, anilistId, title, img, totalEps }) {
  const config = await loadAppConfig();
  return await adminDb.runTransaction(async tx => {
    const userRef = adminDb.doc('users/' + uid);
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const userData = snap.data();
    const up = Array.isArray(userData.upcoming) ? userData.upcoming : [];
    const mi = String(malId);
    if (up.some(u => String(u.malId) === mi)) throw new Error('Already in Upcoming');
    if (up.length >= config.maxUpcoming) throw new Error(`Upcoming full (max ${config.maxUpcoming})`);
    const newItem = {
      malId: mi,
      anilistId: String(anilistId || ''),
      title: safeString(title, 200),
      img: validImageUrl(img),
      currentEp: 0,
      totalEps: toNumber(totalEps, 12),
      lastWatchedDate: ''
    };
    tx.update(userRef, { upcoming: [...up, newItem] });
    return { ...userData, upcoming: [...up, newItem] };
  });
}

// ---- Remove from upcoming ----
export async function removeFromUpcoming(uid, malId) {
  const userRef = adminDb.doc('users/' + uid);
  const snap = await userRef.get();
  if (!snap.exists) throw new Error('User not found');
  const up = (snap.data().upcoming || []).filter(u => String(u.malId) !== String(malId));
  await userRef.update({ upcoming: up });
  return getUser(uid);
}

// ---- Increment episode ----
export async function incrementEpisode(uid, malId) {
  const today = getTodayKey();
  return await adminDb.runTransaction(async tx => {
    const userRef = adminDb.doc('users/' + uid);
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const userData = snap.data();
    if (userData.isBanned) throw new Error('Account banned');

    const liveUpcoming = [...(userData.upcoming || [])];
    const idx = liveUpcoming.findIndex(u => String(u.malId) === String(malId));
    if (idx === -1) throw new Error('Item not in upcoming');
    const item = { ...liveUpcoming[idx] };
    if (item.lastWatchedDate === today) throw new Error('Only 1 episode per day');
    item.currentEp = toNumber(item.currentEp) + 1;
    item.lastWatchedDate = today;
    liveUpcoming[idx] = item;

    const isComplete = item.currentEp >= toNumber(item.totalEps, 12);
    if (!isComplete) {
      tx.update(userRef, { upcoming: liveUpcoming });
      return { completed: false, userData: { ...userData, upcoming: liveUpcoming } };
    }

    // Completion path: award 50 EXP + 10 coins (from admin bank)
    const { adminRef, admin } = await getBankAndAdmin(tx);
    const rewardCoins = 10;
    const canPay = toNumber(admin.coins) >= rewardCoins;

    const remaining = liveUpcoming.filter(u => String(u.malId) !== String(malId));
    const collection = [...(userData.collection || [])];
    if (!collection.some(x => String(x.malId) === String(malId))) {
      collection.push({ malId: String(item.malId), anilistId: item.anilistId || null, title: item.title, img: item.img });
    }

    const newExpHistory = [...(userData.expHistory || []), {
      amount: 50, reason: `Completed ${item.title}`, date: new Date().toISOString()
    }].slice(-100);

    const userUpdate = {
      upcoming: remaining,
      collection,
      totalExp: FieldValue.increment(50),
      expHistory: newExpHistory
    };
    if (canPay) userUpdate.coins = FieldValue.increment(rewardCoins);
    tx.update(userRef, userUpdate);

    if (canPay) {
      tx.update(adminRef, { coins: toNumber(admin.coins) - rewardCoins });
      tx.set(adminDb.collection('coinTransactions').doc(), {
        type: 'ANIME_COMPLETE', from: 'admin', to: uid, amount: rewardCoins,
        meta: { animeId: item.malId, animeTitle: item.title },
        userBalanceAfter: toNumber(userData.coins) + rewardCoins,
        timestamp: FieldValue.serverTimestamp()
      });
    }

    return {
      completed: true, title: item.title,
      newCoins: canPay ? toNumber(userData.coins) + rewardCoins : toNumber(userData.coins),
      newTotalExp: toNumber(userData.totalExp) + 50,
      coinsPaid: canPay
    };
  });
}

// ---- Toggle prime ----
export async function togglePrime(uid, malId) {
  const config = await loadAppConfig();
  const userRef = adminDb.doc('users/' + uid);
  const snap = await userRef.get();
  if (!snap.exists) throw new Error('User not found');
  const userData = snap.data();
  const prime = [...(userData.prime || [])];
  const mi = String(malId);
  const anime = (userData.collection || []).find(c => String(c.malId) === mi);
  if (!anime) throw new Error('Anime not in collection');
  const idx = prime.findIndex(p => String(p.malId) === mi);
  if (idx > -1) prime.splice(idx, 1);
  else {
    if (prime.length >= config.maxPrime) throw new Error(`Max ${config.maxPrime} Prime slots`);
    prime.push({ malId: mi, anilistId: anime.anilistId || null, title: anime.title, img: anime.img });
  }
  await userRef.update({ prime });
  return getUser(uid);
}

// ---- Toggle favourite ----
export async function toggleFavourite(uid, malId) {
  const config = await loadAppConfig();
  const userRef = adminDb.doc('users/' + uid);
  const snap = await userRef.get();
  if (!snap.exists) throw new Error('User not found');
  const userData = snap.data();
  const fav = [...(userData.favourite || [])];
  const mi = String(malId);
  const anime = (userData.collection || []).find(c => String(c.malId) === mi);
  if (!anime) throw new Error('Anime not in collection');
  const idx = fav.findIndex(f => String(f.malId) === mi);
  if (idx > -1) fav.splice(idx, 1);
  else {
    if (fav.length >= config.maxFavourite) throw new Error(`Max ${config.maxFavourite} Favourite slots`);
    fav.push({ malId: mi, anilistId: anime.anilistId || null, title: anime.title, img: anime.img });
  }
  await userRef.update({ favourite: fav });
  return getUser(uid);
}

// ---- Follow / unfollow ----
export async function toggleFollow(uid, targetUid) {
  if (uid === targetUid) throw new Error('Cannot follow yourself');
  return await adminDb.runTransaction(async tx => {
    const myRef = adminDb.doc('users/' + uid);
    const targetRef = adminDb.doc('users/' + targetUid);
    const [mySnap, targetSnap] = await Promise.all([tx.get(myRef), tx.get(targetRef)]);
    if (!mySnap.exists || !targetSnap.exists) throw new Error('User not found');
    const myFollowing = mySnap.data().following || [];
    const isFollowing = myFollowing.includes(targetUid);
    if (isFollowing) {
      tx.update(myRef, { following: FieldValue.arrayRemove(targetUid) });
      tx.update(targetRef, { followers: FieldValue.arrayRemove(uid) });
    } else {
      tx.update(myRef, { following: FieldValue.arrayUnion(targetUid) });
      tx.update(targetRef, { followers: FieldValue.arrayUnion(uid) });
    }
    return { following: !isFollowing };
  });
}

// ---- Daily claim ----
export async function claimDaily(uid) {
  const config = await loadAppConfig();
  const today = getTodayKey();
  const bonus = toNumber(config.dailyBonus, 50);

  return await adminDb.runTransaction(async tx => {
    const { adminRef, admin } = await getBankAndAdmin(tx);
    const userRef = adminDb.doc('users/' + uid);
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const userData = snap.data();
    if (userData.isBanned) throw new Error('Account banned');
    if (userData.lastClaim === today) throw new Error('Already claimed today');
    if (toNumber(admin.coins) < bonus) throw new Error('Treasury empty. Try later.');

    tx.update(adminRef, { coins: toNumber(admin.coins) - bonus });
    tx.update(userRef, { coins: toNumber(userData.coins) + bonus, lastClaim: today });
    tx.set(adminDb.collection('coinTransactions').doc(), {
      type: 'DAILY_CLAIM', from: 'admin', to: uid, amount: bonus,
      userBalanceAfter: toNumber(userData.coins) + bonus,
      timestamp: FieldValue.serverTimestamp()
    });
    return { newCoins: toNumber(userData.coins) + bonus, lastClaim: today };
  });
}

// ---- Store ----
export async function getStoreItems() {
  const snap = await adminDb.collection('storeItems').where('active', '==', true).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function buyItem(uid, itemId) {
  const itemSnap = await adminDb.doc('storeItems/' + itemId).get();
  if (!itemSnap.exists) throw new Error('Item not found');
  const item = { id: itemSnap.id, ...itemSnap.data() };
  if (!item.active) throw new Error('Item not available');
  const price = toNumber(item.price);
  const durationDays = toNumber(item.durationDays, 30);
  const expiresAt = Date.now() + durationDays * 24 * 60 * 60 * 1000;

  return await adminDb.runTransaction(async tx => {
    const { adminRef, admin } = await getBankAndAdmin(tx);
    const userRef = adminDb.doc('users/' + uid);
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const userData = snap.data();
    if (userData.isBanned) throw new Error('Account banned');
    if (toNumber(userData.coins) < price) throw new Error('Insufficient coins');

    const newCoins = toNumber(userData.coins) - price;
    let newOwned = (userData.ownedItems || []).filter(o => {
      if (typeof o === 'string') return true;
      return o.expiresAt > Date.now() && o.id !== item.id;
    });
    newOwned.push({ id: item.id, expiresAt });

    const upd = { coins: newCoins, ownedItems: newOwned };
    if ((item.type || 'border') === 'border') upd.activeBorder = item.cssClass;

    tx.update(userRef, upd);
    tx.update(adminRef, { coins: toNumber(admin.coins) + price });
    tx.set(adminDb.collection('coinTransactions').doc(), {
      type: 'PURCHASE', from: uid, to: 'admin', amount: price,
      meta: { itemId: item.id, itemName: item.name, durationDays },
      userBalanceAfter: newCoins, timestamp: FieldValue.serverTimestamp()
    });
    return { newCoins, newOwnedItems: newOwned, activeBorder: upd.activeBorder || userData.activeBorder };
  });
}

// ---- Polls ----
export async function createPoll(uid, { animeName, question, options, correctIndex }) {
  const userSnap = await adminDb.doc('users/' + uid).get();
  if (!userSnap.exists) throw new Error('User not found');
  const creatorName = userSnap.data().name || 'User';

  const doc = await adminDb.collection('polls').add({
    animeTitle: safeString(animeName, 100),
    question: safeString(question, 300),
    options: options.map(o => safeString(o, 150)),
    correctIndex: toNumber(correctIndex),
    creatorId: uid, creatorName,
    voters: [], flags: [],
    createdAt: FieldValue.serverTimestamp()
  });
  return { pollId: doc.id };
}

export async function listPolls(uid) {
  const snap = await adminDb.collection('polls').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(p => p.creatorId !== uid);
}

export async function listMyPolls(uid) {
  const snap = await adminDb.collection('polls').where('creatorId', '==', uid).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function answerPoll(uid, pollId, selectedIndex) {
  return await adminDb.runTransaction(async tx => {
    const pollRef = adminDb.doc('polls/' + pollId);
    const userRef = adminDb.doc('users/' + uid);
    const [pollSnap, userSnap] = await Promise.all([tx.get(pollRef), tx.get(userRef)]);
    if (!pollSnap.exists) throw new Error('Poll not found');
    if (!userSnap.exists) throw new Error('User not found');
    const poll = pollSnap.data();
    const userData = userSnap.data();
    if (poll.creatorId === uid) throw new Error('Cannot answer your own poll');
    if ((poll.voters || []).includes(uid)) throw new Error('Already answered');
    const idx = toNumber(selectedIndex);
    if (idx < 0 || idx >= (poll.options || []).length) throw new Error('Invalid option');

    const isCorrect = idx === toNumber(poll.correctIndex);
    tx.update(pollRef, { voters: FieldValue.arrayUnion(uid) });

    if (poll.creatorId && poll.creatorId !== uid) {
      tx.update(adminDb.doc('users/' + poll.creatorId), { totalExp: FieldValue.increment(15) });
    }

    let awarded = { exp: 0, coins: 0 };
    if (isCorrect) {
      const { adminRef, admin } = await getBankAndAdmin(tx);
      const newExpHistory = [...(userData.expHistory || []), {
        amount: 10, reason: 'Correct poll answer', date: new Date().toISOString()
      }].slice(-100);

      const userUpd = {
        totalExp: FieldValue.increment(10),
        expHistory: newExpHistory
      };

      if (toNumber(admin.coins) >= 5) {
        tx.update(adminRef, { coins: toNumber(admin.coins) - 5 });
        userUpd.coins = FieldValue.increment(5);
        tx.set(adminDb.collection('coinTransactions').doc(), {
          type: 'POLL_REWARD', from: 'admin', to: uid, amount: 5, meta: { pollId },
          userBalanceAfter: toNumber(userData.coins) + 5,
          timestamp: FieldValue.serverTimestamp()
        });
        awarded.coins = 5;
      }
      tx.update(userRef, userUpd);
      awarded.exp = 10;
    }
    return { isCorrect, awarded };
  });
}

export async function reportPoll(uid, pollId) {
  await adminDb.doc('polls/' + pollId).update({ flags: FieldValue.arrayUnion(uid) });
  return true;
}

// ---- Leaderboard ----
export async function getLeaderboard(limitCount = 10) {
  const snap = await adminDb.collection('users').orderBy('totalExp', 'desc').limit(limitCount).get();
  return snap.docs.map(d => {
    const u = d.data();
    return {
      uid: d.id, name: u.name || 'User',
      avatar: validImageUrl(u.avatar), rank: u.rank || 'E',
      totalExp: toNumber(u.totalExp)
    };
  });
}

// ---- Followers data ----
export async function getFollowersData(uid) {
  const snap = await adminDb.doc('users/' + uid).get();
  if (!snap.exists) throw new Error('User not found');
  const followerUids = snap.data().followers || [];
  if (!followerUids.length) return [];
  const results = [];
  for (let i = 0; i < followerUids.length; i += 10) {
    const chunk = followerUids.slice(i, i + 10);
    const q = await adminDb.collection('users').where('__name__', 'in', chunk).get();
    q.docs.forEach(d => {
      const u = d.data();
      results.push({ uid: d.id, name: u.name || 'User', avatar: validImageUrl(u.avatar), rank: u.rank || 'E' });
    });
  }
  return results;
}

// ---- Rank breakdown ----
export async function getRankBreakdown(uid) {
  const snap = await adminDb.doc('users/' + uid).get();
  if (!snap.exists) throw new Error('User not found');
  const userData = snap.data();
  const history = Array.isArray(userData.expHistory) ? userData.expHistory : [];
  const totalExp = toNumber(userData.totalExp) || 1;
  const grouped = {};
  history.forEach(h => {
    const r = String(h.reason || 'Other');
    grouped[r] = (grouped[r] || 0) + toNumber(h.amount);
  });
  const sorted = Object.entries(grouped).sort((a, b) => b[1] - a[1]);
  return sorted.map(([reason, amount]) => ({
    reason, amount, percentage: ((amount / totalExp) * 100).toFixed(1)
  }));
}

// ---- User search by UID ----
export async function findUserByCustomId(customId) {
  const snap = await adminDb.collection('users').where('customId', '==', String(customId)).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  return sanitizeForPublic({ id: d.id, ...d.data() });
}

// ---- Image upload (ImgBB) ----
export async function uploadImage(base64, name = 'upload') {
  return await imgbbUpload(base64, name);
}

// ---- Scanner ----
export async function scanImage(base64) {
  let identifiedTitle = null, confidence = 0, anilistId = null;
  let episode = null, timestamp = null, videoUrl = null, source = '';

  // Try trace.moe first
  try {
    const td = await traceMoe(base64);
    if (td.result && td.result.length > 0 && td.result[0].similarity >= 0.87) {
      const m = td.result[0];
      confidence = (m.similarity * 100).toFixed(1);
      identifiedTitle = m.anilist?.title?.english || m.anilist?.title?.romaji;
      anilistId = m.anilist?.id || null;
      episode = m.episode !== null ? `Episode ${m.episode}` : 'Movie / Special';
      const min = Math.floor(m.from / 60);
      const sec = Math.floor(m.from % 60);
      timestamp = `${min}m ${sec < 10 ? '0' : ''}${sec}s`;
      videoUrl = m.video || null;
      source = 'Official Episode Scene (Exact Match)';
    }
  } catch (e) { /* trace.moe failed */ }

  // Fallback: Gemini
  if (!identifiedTitle) {
    try {
      const g = await geminiDetect(base64);
      if (!g.isAnime || !g.animeTitle || (g.confidence && g.confidence < 85)) {
        return {
          ok: false,
          rejectionReason: g.rejectionReason || 'This image does not appear to be an anime.',
          rejectionHeading: 'No Anime Detected'
        };
      }
      identifiedTitle = g.animeTitle;
      confidence = g.confidence ? Number(g.confidence).toFixed(1) : '95.0';
      source = g.character ? `Character: ${g.character}` : 'Official Anime Artwork';
    } catch (e) {
      return {
        ok: false,
        rejectionHeading: 'Recognition Failed',
        rejectionReason: 'Could not verify this image. Try a clear anime screenshot.'
      };
    }
  }

  // Enrich with AniList
  let meta = null;
  try {
    meta = await fetchAnimeDetails(anilistId, null);
    if (!meta && identifiedTitle) {
      const q = `query($search:String){Media(search:$search,type:ANIME){id idMal title{romaji english} coverImage{large} averageScore episodes description genres}}`;
      const { anilistQuery } = await import('./api.js');
      const d = await anilistQuery(q, { search: identifiedTitle });
      meta = d?.data?.Media || null;
    }
  } catch (e) { /* metadata failed */ }

  return {
    ok: true,
    title: (meta?.title?.english || meta?.title?.romaji) || identifiedTitle,
    confidence,
    episode, timestamp, videoUrl, source,
    poster: meta?.coverImage?.large || '',
    score: meta?.averageScore || '8.0',
    totalEpisodes: meta?.episodes || 'Unknown',
    synopsis: meta?.description || 'No description.',
    genres: meta?.genres || []
  };
}

// ---- Episode title ----
export async function getEpisodeTitle(title, epNumber) {
  return await fetchKitsuEpisodeTitle(title, epNumber);
}