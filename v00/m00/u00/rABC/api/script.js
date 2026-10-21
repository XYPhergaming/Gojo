const { db, auth, admin } = require('./firebase');
const config = require('./api');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const DEFAULT_CONFIG = {
  dailyBonus: 50,
  maxUpcoming: 3,
  maxPrime: 3,
  maxFavourite: 4,
  rankThresholds: { D: 250, C: 500, B: 750, A: 1000 }
};

function signToken(uid, email) {
  return jwt.sign({ uid, email }, config.jwtSecret, { expiresIn: '7d' });
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

function calculateRank(exp) {
  const th = DEFAULT_CONFIG.rankThresholds;
  if (exp >= th.A) return 'A';
  if (exp >= th.B) return 'B';
  if (exp >= th.C) return 'C';
  if (exp >= th.D) return 'D';
  return 'E';
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getAppConfig() {
  try {
    const snap = await db.doc('meta/config').get();
    if (snap.exists) {
      return { ...DEFAULT_CONFIG, ...snap.data(), rankThresholds: { ...DEFAULT_CONFIG.rankThresholds, ...(snap.data().rankThresholds || {}) } };
    }
  } catch (e) { /* noop */ }
  return { ...DEFAULT_CONFIG };
}

async function generateCustomId() {
  const ref = db.doc('meta/uidCounter');
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let n = 1000000000;
    if (snap.exists && snap.data().current) n = snap.data().current + 1;
    tx.set(ref, { current: n }, { merge: true });
    return String(n);
  });
}

async function createUserRecord(uid, email, name, avatar) {
  const customId = await generateCustomId();
  const record = {
    uid, customId, email: email || '', backupEmail: '',
    name: name || 'Gojo Hunter',
    avatar: avatar || 'https://upload.wikimedia.org/wikipedia/commons/7/7c/Profile_avatar_placeholder_large.png',
    totalExp: 0, rank: 'E', coins: 0, lastClaim: '', activeBorder: '',
    isVerified: false, isBanned: false, ownedItems: [],
    upcoming: [], collection: [], prime: [], favourite: [],
    followers: [], following: [], setupCompleted: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await db.doc(`users/${uid}`).set(record);
  return record;
}

async function getUser(uid) {
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) throw new Error('User not found');
  return { id: snap.id, ...snap.data() };
}

async function updateUser(uid, updates) {
  await db.doc(`users/${uid}`).update(updates);
}

async function verifyGoogleToken(idToken) {
  const res = await axios.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!res.data || !res.data.email) throw new Error('Invalid Google token');
  return res.data;
}

async function findOrCreateFirebaseUserByEmail(email, name, picture) {
  try {
    return await auth.getUserByEmail(email);
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      return await auth.createUser({ email, displayName: name, photoURL: picture });
    }
    throw e;
  }
}

async function signInWithPassword(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${config.firebase.apiKey}`;
  const res = await axios.post(url, { email, password, returnSecureToken: true });
  return res.data;
}

async function getBankAndAdmin(tx) {
  const bankRef = db.doc('meta/bank');
  const bankSnap = await tx.get(bankRef);
  if (!bankSnap.exists) throw new Error('Bank not initialized');
  const bank = bankSnap.data();
  const adminRef = db.doc(`admins/${bank.treasuryAdminUid}`);
  const adminSnap = await tx.get(adminRef);
  if (!adminSnap.exists) throw new Error('Treasury admin missing');
  return { bankRef, bank, adminRef, admin: adminSnap.data() };
}

async function claimDaily(uid) {
  const today = todayKey();
  return await db.runTransaction(async (tx) => {
    const { adminRef, admin: adminData } = await getBankAndAdmin(tx);
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();
    if (user.isBanned) throw new Error('Account banned');
    if (user.lastClaim === today) throw new Error('Already claimed today');
    const cfg = await getAppConfig();
    const bonus = Number(cfg.dailyBonus) || 50;
    if ((Number(adminData.coins) || 0) < bonus) throw new Error('Admin treasury empty');

    tx.update(adminRef, { coins: (Number(adminData.coins) || 0) - bonus });
    tx.update(userRef, { coins: (Number(user.coins) || 0) + bonus, lastClaim: today });
    tx.set(db.collection('coinTransactions').doc(), {
      type: 'DAILY_CLAIM', from: 'admin', to: uid, amount: bonus,
      userBalanceAfter: (Number(user.coins) || 0) + bonus,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    return { newCoins: (Number(user.coins) || 0) + bonus, amount: bonus };
  });
}

async function incrementEpisode(uid, malId) {
  const today = todayKey();
  return await db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();
    if (user.isBanned) throw new Error('Account banned');

    const upcoming = [...(user.upcoming || [])];
    const idx = upcoming.findIndex(u => String(u.malId) === String(malId));
    if (idx === -1) throw new Error('Item not in upcoming');
    const item = { ...upcoming[idx] };
    if (item.lastWatchedDate === today) throw new Error('Only 1 episode per day');

    item.currentEp = (item.currentEp || 0) + 1;
    item.lastWatchedDate = today;
    upcoming[idx] = item;

    const completed = item.currentEp >= (item.totalEps || 12);
    if (!completed) {
      tx.update(userRef, { upcoming });
      return { completed: false, newEp: item.currentEp };
    }

    const { adminRef, admin: adminData } = await getBankAndAdmin(tx);
    const rewardCoins = 10;
    const canPay = (Number(adminData.coins) || 0) >= rewardCoins;

    const filtered = upcoming.filter(u => String(u.malId) !== String(malId));
    const collection = [...(user.collection || [])];
    if (!collection.some(c => String(c.malId) === String(malId))) {
      collection.push({ malId: String(item.malId), anilistId: item.anilistId || null, title: item.title, img: item.img });
    }

    const userUpdate = {
      upcoming: filtered,
      collection,
      totalExp: admin.firestore.FieldValue.increment(50),
      expHistory: admin.firestore.FieldValue.arrayUnion({ amount: 50, reason: `Completed ${item.title}`, date: new Date().toISOString() })
    };
    if (canPay) userUpdate.coins = admin.firestore.FieldValue.increment(rewardCoins);
    tx.update(userRef, userUpdate);

    if (canPay) {
      tx.update(adminRef, { coins: (Number(adminData.coins) || 0) - rewardCoins });
      tx.set(db.collection('coinTransactions').doc(), {
        type: 'ANIME_COMPLETE', from: 'admin', to: uid, amount: rewardCoins,
        meta: { animeId: item.malId, animeTitle: item.title },
        userBalanceAfter: (Number(user.coins) || 0) + rewardCoins,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    const newExp = (Number(user.totalExp) || 0) + 50;
    const newRank = calculateRank(newExp);
    if (newRank !== user.rank) tx.update(userRef, { rank: newRank });

    return { completed: true, newCoins: canPay ? (Number(user.coins) || 0) + rewardCoins : (Number(user.coins) || 0), newExp, newRank };
  });
}

async function buyItem(uid, itemId) {
  return await db.runTransaction(async (tx) => {
    const { adminRef, admin: adminData } = await getBankAndAdmin(tx);
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();
    if (user.isBanned) throw new Error('Account banned');

    const itemSnap = await tx.get(db.doc(`storeItems/${itemId}`));
    if (!itemSnap.exists) throw new Error('Item not found');
    const item = itemSnap.data();
    if (!item.active) throw new Error('Item unavailable');

    if ((Number(user.coins) || 0) < item.price) throw new Error('Insufficient coins');

    const newUserCoins = (Number(user.coins) || 0) - item.price;
    const newAdminCoins = (Number(adminData.coins) || 0) + item.price;

    const ownedItems = (user.ownedItems || []).filter(o => {
      if (typeof o === 'string') return true;
      return o.expiresAt > Date.now() && o.id !== itemId;
    });
    const expiresAt = Date.now() + ((item.durationDays || 30) * 24 * 60 * 60 * 1000);
    ownedItems.push({ id: itemId, expiresAt });

    const upd = { coins: newUserCoins, ownedItems };
    if ((item.type || 'border') === 'border') upd.activeBorder = item.cssClass;

    tx.update(userRef, upd);
    tx.update(adminRef, { coins: newAdminCoins });
    tx.set(db.collection('coinTransactions').doc(), {
      type: 'PURCHASE', from: uid, to: 'admin', amount: item.price,
      meta: { itemId, itemName: item.name, durationDays: item.durationDays || 30 },
      userBalanceAfter: newUserCoins,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    return { newCoins: newUserCoins };
  });
}

async function answerPoll(uid, pollId, optionIndex) {
  return await db.runTransaction(async (tx) => {
    const pollRef = db.doc(`polls/${pollId}`);
    const userRef = db.doc(`users/${uid}`);
    const pollSnap = await tx.get(pollRef);
    if (!pollSnap.exists) throw new Error('Poll not found');
    const poll = pollSnap.data();
    if (poll.creatorId === uid) throw new Error('Cannot answer own poll');
    if ((poll.voters || []).includes(uid)) throw new Error('Already answered');
    if (optionIndex < 0 || optionIndex >= (poll.options || []).length) throw new Error('Invalid option');

    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();

    const correct = Number(optionIndex) === Number(poll.correctIndex);
    tx.update(pollRef, { voters: admin.firestore.FieldValue.arrayUnion(uid) });

    if (poll.creatorId) {
      tx.update(db.doc(`users/${poll.creatorId}`), { totalExp: admin.firestore.FieldValue.increment(15) });
    }

    let awarded = { exp: 0, coins: 0 };
    if (correct) {
      const { adminRef, admin: adminData } = await getBankAndAdmin(tx);
      const coins = 5;
      if ((Number(adminData.coins) || 0) >= coins) {
        tx.update(adminRef, { coins: (Number(adminData.coins) || 0) - coins });
        tx.update(userRef, {
          totalExp: admin.firestore.FieldValue.increment(10),
          coins: admin.firestore.FieldValue.increment(coins),
          expHistory: admin.firestore.FieldValue.arrayUnion({ amount: 10, reason: 'Correct poll answer', date: new Date().toISOString() })
        });
        awarded = { exp: 10, coins };
      }
    }

    const newExp = (Number(user.totalExp) || 0) + awarded.exp;
    const newRank = calculateRank(newExp);
    if (newRank !== user.rank) tx.update(userRef, { rank: newRank });

    return { correct, awarded };
  });
}

async function toggleFollow(uid, targetUid) {
  if (uid === targetUid) throw new Error('Cannot follow yourself');
  return await db.runTransaction(async (tx) => {
    const meRef = db.doc(`users/${uid}`);
    const targetRef = db.doc(`users/${targetUid}`);
    const [me, target] = await Promise.all([tx.get(meRef), tx.get(targetRef)]);
    if (!me.exists || !target.exists) throw new Error('User not found');
    const following = (me.data().following || []).includes(targetUid);
    if (following) {
      tx.update(meRef, { following: admin.firestore.FieldValue.arrayRemove(targetUid) });
      tx.update(targetRef, { followers: admin.firestore.FieldValue.arrayRemove(uid) });
      return { following: false };
    }
    tx.update(meRef, { following: admin.firestore.FieldValue.arrayUnion(targetUid) });
    tx.update(targetRef, { followers: admin.firestore.FieldValue.arrayUnion(uid) });
    return { following: true };
  });
}

async function togglePrime(uid, malId) {
  const snap = await db.doc(`users/${uid}`).get();
  const user = snap.data();
  const collection = user.collection || [];
  const anime = collection.find(c => String(c.malId) === String(malId));
  if (!anime) throw new Error('Anime not in collection');
  let prime = [...(user.prime || [])];
  const idx = prime.findIndex(p => String(p.malId) === String(malId));
  const cfg = await getAppConfig();
  if (idx > -1) prime.splice(idx, 1);
  else {
    if (prime.length >= cfg.maxPrime) throw new Error(`Max ${cfg.maxPrime} prime slots`);
    prime.push({ malId: String(malId), anilistId: anime.anilistId || null, title: anime.title, img: anime.img });
  }
  await db.doc(`users/${uid}`).update({ prime });
  return prime;
}

async function toggleFavourite(uid, malId) {
  const snap = await db.doc(`users/${uid}`).get();
  const user = snap.data();
  const collection = user.collection || [];
  const anime = collection.find(c => String(c.malId) === String(malId));
  if (!anime) throw new Error('Anime not in collection');
  let fav = [...(user.favourite || [])];
  const idx = fav.findIndex(p => String(p.malId) === String(malId));
  const cfg = await getAppConfig();
  if (idx > -1) fav.splice(idx, 1);
  else {
    if (fav.length >= cfg.maxFavourite) throw new Error(`Max ${cfg.maxFavourite} favourite slots`);
    fav.push({ malId: String(malId), anilistId: anime.anilistId || null, title: anime.title, img: anime.img });
  }
  await db.doc(`users/${uid}`).update({ favourite: fav });
  return fav;
}

module.exports = {
  signToken, verifyToken, calculateRank, getAppConfig,
  createUserRecord, getUser, updateUser,
  verifyGoogleToken, findOrCreateFirebaseUserByEmail, signInWithPassword,
  claimDaily, incrementEpisode, buyItem, answerPoll, toggleFollow,
  togglePrime, toggleFavourite
};