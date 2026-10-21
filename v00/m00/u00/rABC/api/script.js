import crypto from 'crypto';
import { db, auth, FieldValue } from './firebase.js';

export const DEFAULT_CONFIG = {
  dailyBonus: 50,
  maxUpcoming: 3,
  maxPrime: 3,
  maxFavourite: 4,
  rankThresholds: { D: 250, C: 500, B: 750, A: 1000 }
};

export function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(password, s, 64).toString('hex');
  return { hash: h, salt: s };
}

export function verifyPassword(password, hash, salt) {
  try {
    const h = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(h, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function calcRank(exp, thresholds) {
  const t = thresholds || DEFAULT_CONFIG.rankThresholds;
  if (exp >= t.A) return { rank: 'A', target: t.A };
  if (exp >= t.B) return { rank: 'B', target: t.A };
  if (exp >= t.C) return { rank: 'C', target: t.B };
  if (exp >= t.D) return { rank: 'D', target: t.C };
  return { rank: 'E', target: t.D };
}

export async function getConfig() {
  const snap = await db.doc('meta/config').get();
  if (!snap.exists) return { ...DEFAULT_CONFIG };
  const data = snap.data() || {};
  return {
    ...DEFAULT_CONFIG,
    ...data,
    rankThresholds: { ...DEFAULT_CONFIG.rankThresholds, ...(data.rankThresholds || {}) }
  };
}

export async function getActiveUser(uid) {
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) throw Object.assign(new Error('User not found'), { status: 404 });
  const data = snap.data();
  if (data.isBanned) throw Object.assign(new Error('Account banned'), { status: 403 });
  return { id: snap.id, ...data };
}

async function readBankAndAdmin(tx) {
  const bankSnap = await tx.get(db.doc('meta/bank'));
  if (!bankSnap.exists) throw new Error('Bank not initialized');
  const bank = bankSnap.data() || {};
  if (!bank.treasuryAdminUid) throw new Error('Treasury admin missing');
  const adminRef = db.doc(`admins/${bank.treasuryAdminUid}`);
  const adminSnap = await tx.get(adminRef);
  if (!adminSnap.exists) throw new Error('Treasury admin doc missing');
  return { bank, adminRef, admin: adminSnap.data() || {} };
}

export async function generateCustomId(tx) {
  const ref = db.doc('meta/uidCounter');
  const snap = await tx.get(ref);
  let n = 1000000000;
  if (snap.exists && snap.data().current) n = Number(snap.data().current) + 1;
  tx.set(ref, { current: n }, { merge: true });
  return String(n);
}

export async function createUserRecord({ uid, email, name, avatar }) {
  return db.runTransaction(async (tx) => {
    const uidSnap = await tx.get(db.doc(`users/${uid}`));
    if (uidSnap.exists) return { id: uidSnap.id, ...uidSnap.data() };
    const customId = await generateCustomId(tx);
    const doc = {
      uid,
      customId,
      email: email || '',
      backupEmail: '',
      backupEmailHash: '',
      backupEmailSalt: '',
      name: name || 'Gojo Hunter',
      avatar: avatar || 'https://upload.wikimedia.org/wikipedia/commons/7/7c/Profile_avatar_placeholder_large.png',
      totalExp: 0,
      rank: 'E',
      coins: 0,
      lastClaim: '',
      activeBorder: '',
      isVerified: false,
      isBanned: false,
      ownedItems: [],
      upcoming: [],
      collection: [],
      prime: [],
      favourite: [],
      followers: [],
      following: [],
      expHistory: [],
      setupCompleted: false,
      createdAt: FieldValue.serverTimestamp()
    };
    tx.set(db.doc(`users/${uid}`), doc);
    return { id: uid, ...doc };
  });
}

export async function maybeUpdateRank({ uid, previousExp, newExp }) {
  const config = await getConfig();
  const newRank = calcRank(newExp, config.rankThresholds).rank;
  const oldRank = calcRank(previousExp, config.rankThresholds).rank;
  if (newRank !== oldRank) {
    await db.doc(`users/${uid}`).update({ rank: newRank });
    return { rankChanged: true, oldRank, newRank };
  }
  return { rankChanged: false, oldRank, newRank };
}

export async function addUpcoming({ uid, malId, anilistId, title, img, totalEps }) {
  const config = await getConfig();
  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const user = snap.data();
    if (user.isBanned) throw new Error('Account banned');
    const upcoming = Array.isArray(user.upcoming) ? [...user.upcoming] : [];
    if (upcoming.some((u) => String(u.malId) === String(malId))) throw new Error('Already in upcoming');
    if (upcoming.length >= config.maxUpcoming) throw new Error(`Upcoming is full (max ${config.maxUpcoming})`);
    const item = {
      malId: String(malId),
      anilistId: anilistId || null,
      title: String(title || 'Unknown').slice(0, 200),
      img: String(img || ''),
      currentEp: 0,
      totalEps: parseInt(totalEps, 10) || 12,
      lastWatchedDate: ''
    };
    upcoming.push(item);
    tx.update(userRef, { upcoming });
    return item;
  });
}

export async function removeUpcoming({ uid, malId }) {
  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const user = snap.data();
    const upcoming = (user.upcoming || []).filter((u) => String(u.malId) !== String(malId));
    tx.update(userRef, { upcoming });
    return { ok: true };
  });
}

export async function incrementEpisode({ uid, malId }) {
  const today = new Date().toDateString();
  const config = await getConfig();
  const result = await db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();
    if (user.isBanned) throw new Error('Account banned');
    const upcoming = Array.isArray(user.upcoming) ? [...user.upcoming] : [];
    const idx = upcoming.findIndex((u) => String(u.malId) === String(malId));
    if (idx === -1) throw new Error('Anime not in upcoming');
    const item = { ...upcoming[idx] };
    if (item.lastWatchedDate === today) throw new Error('Only one episode per day');
    item.currentEp = (item.currentEp || 0) + 1;
    item.lastWatchedDate = today;
    upcoming[idx] = item;
    const isComplete = item.currentEp >= (item.totalEps || 12);

    if (!isComplete) {
      tx.update(userRef, { upcoming });
      return { completed: false, item };
    }

    const rewardCoins = 10;
    let bank;
    try {
      bank = await readBankAndAdmin(tx);
    } catch {
      bank = null;
    }
    const canPay = !!bank && (Number(bank.admin.coins) || 0) >= rewardCoins;

    const filtered = upcoming.filter((u) => String(u.malId) !== String(malId));
    const collection = Array.isArray(user.collection) ? [...user.collection] : [];
    if (!collection.some((c) => String(c.malId) === String(malId))) {
      collection.push({
        malId: String(item.malId),
        anilistId: item.anilistId || null,
        title: item.title,
        img: item.img
      });
    }

    const prevExp = Number(user.totalExp) || 0;
    const newExp = prevExp + 50;
    const update = {
      upcoming: filtered,
      collection,
      totalExp: FieldValue.increment(50),
      expHistory: FieldValue.arrayUnion({
        amount: 50,
        reason: `Completed ${item.title}`,
        date: new Date().toISOString()
      })
    };
    if (canPay) update.coins = FieldValue.increment(rewardCoins);
    tx.update(userRef, update);

    if (canPay) {
      tx.update(bank.adminRef, { coins: (Number(bank.admin.coins) || 0) - rewardCoins });
      tx.set(db.collection('coinTransactions').doc(), {
        type: 'ANIME_COMPLETE',
        from: 'admin',
        to: uid,
        amount: rewardCoins,
        meta: { animeId: item.malId, animeTitle: item.title },
        userBalanceAfter: (Number(user.coins) || 0) + rewardCoins,
        timestamp: FieldValue.serverTimestamp()
      });
    }

    return {
      completed: true,
      title: item.title,
      newCoins: (Number(user.coins) || 0) + (canPay ? rewardCoins : 0),
      newTotalExp: newExp,
      coinsPaid: canPay
    };
  });

  if (result.completed) {
    const rank = await maybeUpdateRank({ uid, previousExp: result.newTotalExp - 50, newExp: result.newTotalExp });
    return { ...result, rank };
  }
  return result;
}

export async function claimDaily({ uid }) {
  const today = new Date().toDateString();
  const config = await getConfig();
  const bonus = Number(config.dailyBonus) || 50;
  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();
    if (user.isBanned) throw new Error('Account banned');
    if (user.lastClaim === today) throw new Error('Already claimed today');
    const { adminRef, admin } = await readBankAndAdmin(tx);
    if ((Number(admin.coins) || 0) < bonus) throw new Error('Treasury is empty, wait for admin top-up');
    tx.update(adminRef, { coins: (Number(admin.coins) || 0) - bonus });
    tx.update(userRef, {
      coins: FieldValue.increment(bonus),
      lastClaim: today
    });
    tx.set(db.collection('coinTransactions').doc(), {
      type: 'DAILY_CLAIM',
      from: 'admin',
      to: uid,
      amount: bonus,
      meta: {},
      userBalanceAfter: (Number(user.coins) || 0) + bonus,
      timestamp: FieldValue.serverTimestamp()
    });
    return { coins: (Number(user.coins) || 0) + bonus };
  });
}

export async function purchaseItem({ uid, itemId }) {
  const itemSnap = await db.doc(`storeItems/${itemId}`).get();
  if (!itemSnap.exists) throw new Error('Item not found');
  const item = itemSnap.data();
  if (!item.active) throw new Error('Item is not available');
  const price = Number(item.price);
  const durationDays = Number(item.durationDays) || 30;
  const expiresAt = Date.now() + durationDays * 24 * 60 * 60 * 1000;

  return db.runTransaction(async (tx) => {
    const { adminRef, admin } = await readBankAndAdmin(tx);
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();
    if (user.isBanned) throw new Error('Account banned');
    if ((Number(user.coins) || 0) < price) throw new Error('Insufficient coins');

    const newCoins = (Number(user.coins) || 0) - price;
    const newAdminCoins = (Number(admin.coins) || 0) + price;

    const owned = (user.ownedItems || []).filter((o) => {
      if (typeof o === 'string') return true;
      return o.expiresAt > Date.now() && o.id !== itemId;
    });
    owned.push({ id: itemId, expiresAt });

    const upd = { coins: newCoins, ownedItems: owned };
    if ((item.type || 'border') === 'border') upd.activeBorder = item.cssClass || '';

    tx.update(userRef, upd);
    tx.update(adminRef, { coins: newAdminCoins });
    tx.set(db.collection('coinTransactions').doc(), {
      type: 'PURCHASE',
      from: uid,
      to: 'admin',
      amount: price,
      meta: { itemId, itemName: item.name, durationDays },
      userBalanceAfter: newCoins,
      timestamp: FieldValue.serverTimestamp()
    });
    return { newCoins, ownedItems: owned, activeBorder: upd.activeBorder };
  });
}

export async function togglePrime({ uid, malId }) {
  const config = await getConfig();
  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const user = snap.data();
    const collection = user.collection || [];
    const prime = Array.isArray(user.prime) ? [...user.prime] : [];
    const anime = collection.find((c) => String(c.malId) === String(malId));
    if (!anime) throw new Error('Anime not in collection');
    const idx = prime.findIndex((p) => String(p.malId) === String(malId));
    if (idx > -1) prime.splice(idx, 1);
    else {
      if (prime.length >= config.maxPrime) throw new Error(`Max ${config.maxPrime} prime slots`);
      prime.push({ malId: String(anime.malId), anilistId: anime.anilistId || null, title: anime.title, img: anime.img });
    }
    tx.update(userRef, { prime });
    return prime;
  });
}

export async function toggleFavourite({ uid, malId }) {
  const config = await getConfig();
  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const user = snap.data();
    const collection = user.collection || [];
    const fav = Array.isArray(user.favourite) ? [...user.favourite] : [];
    const anime = collection.find((c) => String(c.malId) === String(malId));
    if (!anime) throw new Error('Anime not in collection');
    const idx = fav.findIndex((p) => String(p.malId) === String(malId));
    if (idx > -1) fav.splice(idx, 1);
    else {
      if (fav.length >= config.maxFavourite) throw new Error(`Max ${config.maxFavourite} favourite slots`);
      fav.push({ malId: String(anime.malId), anilistId: anime.anilistId || null, title: anime.title, img: anime.img });
    }
    tx.update(userRef, { favourite: fav });
    return fav;
  });
}

export async function toggleFollow({ uid, targetUid }) {
  if (uid === targetUid) throw new Error('Cannot follow yourself');
  return db.runTransaction(async (tx) => {
    const meRef = db.doc(`users/${uid}`);
    const themRef = db.doc(`users/${targetUid}`);
    const [meSnap, themSnap] = await Promise.all([tx.get(meRef), tx.get(themRef)]);
    if (!meSnap.exists || !themSnap.exists) throw new Error('User not found');
    const me = meSnap.data();
    const following = me.following || [];
    const isFollowing = following.includes(targetUid);
    if (isFollowing) {
      tx.update(meRef, { following: FieldValue.arrayRemove(targetUid) });
      tx.update(themRef, { followers: FieldValue.arrayRemove(uid) });
      return { following: false };
    }
    tx.update(meRef, { following: FieldValue.arrayUnion(targetUid) });
    tx.update(themRef, { followers: FieldValue.arrayUnion(uid) });
    return { following: true };
  });
}

export async function answerPoll({ uid, pollId, optionIndex }) {
  const pollRef = db.doc(`polls/${pollId}`);
  const userRef = db.doc(`users/${uid}`);
  return db.runTransaction(async (tx) => {
    const pollSnap = await tx.get(pollRef);
    if (!pollSnap.exists) throw new Error('Poll not found');
    const poll = pollSnap.data();
    if (poll.creatorId === uid) throw new Error('Cannot answer your own poll');
    if ((poll.voters || []).includes(uid)) throw new Error('Already answered');
    if (optionIndex < 0 || optionIndex >= (poll.options || []).length) throw new Error('Invalid option');
    const correct = Number(optionIndex) === Number(poll.correctIndex);

    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();

    let admin = null;
    let adminRef = null;
    if (correct) {
      const bank = await readBankAndAdmin(tx);
      adminRef = bank.adminRef;
      admin = bank.admin;
    }

    tx.update(pollRef, { voters: FieldValue.arrayUnion(uid) });
    if (poll.creatorId && poll.creatorId !== uid) {
      tx.update(db.doc(`users/${poll.creatorId}`), { totalExp: FieldValue.increment(15) });
    }

    let awarded = { exp: 0, coins: 0 };
    if (correct && admin && (Number(admin.coins) || 0) >= 5) {
      tx.update(adminRef, { coins: (Number(admin.coins) || 0) - 5 });
      tx.update(userRef, {
        totalExp: FieldValue.increment(10),
        coins: FieldValue.increment(5),
        expHistory: FieldValue.arrayUnion({
          amount: 10,
          reason: 'Correct poll answer',
          date: new Date().toISOString()
        })
      });
      tx.set(db.collection('coinTransactions').doc(), {
        type: 'POLL_REWARD',
        from: 'admin',
        to: uid,
        amount: 5,
        meta: { pollId },
        userBalanceAfter: (Number(user.coins) || 0) + 5,
        timestamp: FieldValue.serverTimestamp()
      });
      awarded = { exp: 10, coins: 5 };
    }

    return { correct, awarded, newTotalExp: (Number(user.totalExp) || 0) + awarded.exp };
  }).then(async (r) => {
    if (r.awarded.exp) {
      const rank = await maybeUpdateRank({ uid, previousExp: r.newTotalExp - r.awarded.exp, newExp: r.newTotalExp });
      return { ...r, rank };
    }
    return r;
  });
}

export async function linkBackupEmail({ uid, email, password }) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');
  const { hash, salt } = hashPassword(password);
  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();
    if (user.backupEmail) throw new Error('Backup email is permanent and cannot be changed');
    if (user.backupEmailHash) throw new Error('Backup email is permanent and cannot be changed');
    const dup = await db.collection('users').where('backupEmail', '==', email.toLowerCase()).limit(1).get();
    if (!dup.empty) throw new Error('This backup email is already in use');
    tx.update(userRef, {
      backupEmail: email.toLowerCase(),
      backupEmailHash: hash,
      backupEmailSalt: salt
    });
    return { ok: true, email: email.toLowerCase() };
  });
}

export async function findUserByBackupEmail(email) {
  const q = await db.collection('users').where('backupEmail', '==', email.toLowerCase()).limit(1).get();
  if (q.empty) return null;
  return { id: q.docs[0].id, ...q.docs[0].data() };
}

export async function deletePoll({ uid, pollId, isAdmin }) {
  const pollRef = db.doc(`polls/${pollId}`);
  const snap = await pollRef.get();
  if (!snap.exists) throw new Error('Poll not found');
  const poll = snap.data();
  if (!isAdmin && poll.creatorId !== uid) throw new Error('Not authorized');
  await pollRef.delete();
  return { ok: true };
}

export async function reportPoll({ uid, pollId }) {
  await db.doc(`polls/${pollId}`).update({ flags: FieldValue.arrayUnion(uid) });
  return { ok: true };
}

export async function updateProfile({ uid, name, avatar }) {
  const update = {};
  if (name && name.trim()) update.name = name.trim().slice(0, 60);
  if (avatar && /^https?:\/\//i.test(avatar)) update.avatar = avatar;
  if (!Object.keys(update).length) throw new Error('Nothing to update');
  await db.doc(`users/${uid}`).update(update);
  return update;
}

export async function completeSetup({ uid, name, avatar }) {
  if (!name || !name.trim()) throw new Error('Name is required');
  const update = {
    name: name.trim().slice(0, 60),
    avatar: avatar && /^https?:\/\//i.test(avatar)
      ? avatar
      : 'https://upload.wikimedia.org/wikipedia/commons/7/7c/Profile_avatar_placeholder_large.png',
    setupCompleted: true
  };
  await db.doc(`users/${uid}`).update(update);
  return update;
}

export async function getLeaderboard() {
  const snap = await db.collection('users').orderBy('totalExp', 'desc').limit(10).get();
  return snap.docs.map((d) => {
    const u = d.data();
    return { uid: d.id, name: u.name, avatar: u.avatar, rank: u.rank, totalExp: u.totalExp || 0 };
  });
}

export async function publicUserData(uid) {
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) throw new Error('User not found');
  const u = snap.data();
  return {
    uid: snap.id,
    customId: u.customId,
    name: u.name,
    avatar: u.avatar,
    rank: u.rank,
    totalExp: u.totalExp || 0,
    isVerified: u.isVerified || false,
    activeBorder: u.activeBorder || '',
    collection: u.collection || [],
    prime: u.prime || [],
    favourite: u.favourite || [],
    upcoming: u.upcoming || [],
    followers: (u.followers || []).length
  };
}