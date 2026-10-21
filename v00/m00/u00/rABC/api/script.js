const axios = require('axios');
const adminSdk = require('./firebase');
const config = require('./api');
const imgbb = require('./imgbb');
const gemini = require('./gemini');

const DEFAULT_CONFIG = {
  dailyBonus: 50,
  maxUpcoming: 3,
  maxPrime: 3,
  maxFavourite: 4,
  rankThresholds: { D: 250, C: 500, B: 750, A: 1000 }
};

function db() { return adminSdk.db(); }
function FV() { return adminSdk.FieldValue(); }

function rankFor(exp, thresholds) {
  const th = thresholds || DEFAULT_CONFIG.rankThresholds;
  if (exp >= th.A) return 'A';
  if (exp >= th.B) return 'B';
  if (exp >= th.C) return 'C';
  if (exp >= th.D) return 'D';
  return 'E';
}

async function loadConfig() {
  try {
    const snap = await db().doc('meta/config').get();
    if (!snap.exists) return { ...DEFAULT_CONFIG };
    const d = snap.data() || {};
    return {
      ...DEFAULT_CONFIG,
      ...d,
      rankThresholds: { ...DEFAULT_CONFIG.rankThresholds, ...(d.rankThresholds || {}) }
    };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

async function getBankSnapshot() {
  const snap = await db().doc('meta/bank').get();
  if (!snap.exists) throw new Error('Bank not initialized');
  return snap.data();
}

async function generateNextUid(tx) {
  const ref = db().doc('meta/uidCounter');
  const snap = await tx.get(ref);
  let next = 1000000000;
  if (snap.exists && snap.data().current) next = Number(snap.data().current) + 1;
  tx.set(ref, { current: next }, { merge: true });
  return String(next);
}

async function createUserRecord(uid, email, name, avatar) {
  const existing = await db().doc('users/' + uid).get();
  if (existing.exists) return existing.data();
  const record = await db().runTransaction(async (tx) => {
    const customId = await generateNextUid(tx);
    const doc = {
      uid,
      customId,
      email: email || '',
      backupEmail: '',
      name: name || 'Gojo Hunter',
      avatar: avatar || 'https://upload.wikimedia.org/wikipedia/commons/7/7c/Profile_avatar_placeholder_large.png',
      totalExp: 0,
      rank: 'E',
      coins: 0,
      lastClaim: '',
      activeBorder: '',
      isVerified: false,
      isBanned: false,
      banReason: '',
      ownedItems: [],
      upcoming: [],
      collection: [],
      prime: [],
      favourite: [],
      followers: [],
      following: [],
      expHistory: [],
      setupCompleted: !!(name && name !== 'Gojo Hunter')
    };
    tx.set(db().doc('users/' + uid), doc);
    return doc;
  });
  return record;
}

async function getMe(uid) {
  const snap = await db().doc('users/' + uid).get();
  if (!snap.exists) throw new Error('User not found');
  return snap.data();
}

async function getPublicUser(uid) {
  const snap = await db().doc('users/' + uid).get();
  if (!snap.exists) return null;
  const d = snap.data();
  return {
    uid,
    customId: d.customId,
    name: d.name,
    avatar: d.avatar,
    rank: d.rank,
    totalExp: d.totalExp,
    collection: d.collection || [],
    prime: d.prime || [],
    favourite: d.favourite || [],
    upcoming: d.upcoming || [],
    activeBorder: d.activeBorder || '',
    isVerified: !!d.isVerified,
    followers: d.followers || [],
    following: d.following || []
  };
}

async function updateProfile(uid, updates) {
  const allowed = {};
  if (typeof updates.name === 'string' && updates.name.trim()) allowed.name = updates.name.trim().slice(0, 60);
  if (typeof updates.avatar === 'string' && /^https?:\/\//i.test(updates.avatar)) allowed.avatar = updates.avatar;
  if (updates.setupCompleted === true) allowed.setupCompleted = true;
  if (Object.keys(allowed).length === 0) throw new Error('No valid fields');
  await db().doc('users/' + uid).update(allowed);
  return { ok: true };
}

async function claimDaily(uid) {
  const cfg = await loadConfig();
  const bonus = Number(cfg.dailyBonus) || 50;
  const today = new Date().toDateString();
  return db().runTransaction(async (tx) => {
    const userRef = db().doc('users/' + uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();
    if (user.isBanned) throw new Error('Account banned');
    if (user.lastClaim === today) throw new Error('Already claimed today');

    const bank = await getBankSnapshot();
    const adminRef = db().doc('admins/' + bank.treasuryAdminUid);
    const adminSnap = await tx.get(adminRef);
    if (!adminSnap.exists) throw new Error('Treasury admin missing');
    const admin = adminSnap.data();
    if ((Number(admin.coins) || 0) < bonus) throw new Error('Admin has no coins');

    tx.update(adminRef, { coins: (Number(admin.coins) || 0) - bonus });
    tx.update(userRef, { coins: (Number(user.coins) || 0) + bonus, lastClaim: today });
    tx.set(db().collection('coinTransactions').doc(), {
      type: 'DAILY_CLAIM', from: 'admin', to: uid, amount: bonus,
      meta: {}, userBalanceAfter: (Number(user.coins) || 0) + bonus,
      timestamp: FV().serverTimestamp()
    });
    return { coins: (Number(user.coins) || 0) + bonus, bonus };
  });
}

async function completeEpisode(uid, malId) {
  const cfg = await loadConfig();
  const today = new Date().toDateString();
  return db().runTransaction(async (tx) => {
    const userRef = db().doc('users/' + uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();
    if (user.isBanned) throw new Error('Account banned');

    const upcoming = [...(user.upcoming || [])];
    const idx = upcoming.findIndex(u => String(u.malId) === String(malId));
    if (idx === -1) throw new Error('Anime not in upcoming');
    const item = { ...upcoming[idx] };
    if (item.lastWatchedDate === today) throw new Error('Only one episode per day');
    item.currentEp = (item.currentEp || 0) + 1;
    item.lastWatchedDate = today;
    upcoming[idx] = item;

    const isComplete = item.currentEp >= (item.totalEps || 12);
    if (!isComplete) {
      tx.update(userRef, { upcoming });
      return { completed: false, currentEp: item.currentEp, totalEps: item.totalEps };
    }

    const bank = await getBankSnapshot();
    const adminRef = db().doc('admins/' + bank.treasuryAdminUid);
    const adminSnap = await tx.get(adminRef);
    if (!adminSnap.exists) throw new Error('Treasury admin missing');
    const admin = adminSnap.data();
    const rewardCoins = 10;
    const canPay = (Number(admin.coins) || 0) >= rewardCoins;

    const filtered = upcoming.filter(u => String(u.malId) !== String(malId));
    const collection = [...(user.collection || [])];
    if (!collection.some(c => String(c.malId) === String(malId))) {
      collection.push({
        malId: String(item.malId),
        anilistId: item.anilistId || null,
        title: item.title,
        img: item.img
      });
    }

    const newTotalExp = (Number(user.totalExp) || 0) + 50;
    const newRank = rankFor(newTotalExp, cfg.rankThresholds);
    const userUpdate = {
      upcoming: filtered,
      collection,
      totalExp: newTotalExp,
      rank: newRank,
      expHistory: FV().arrayUnion({
        amount: 50, reason: 'Completed ' + item.title, date: new Date().toISOString()
      })
    };

    let newCoins = Number(user.coins) || 0;
    if (canPay) {
      newCoins += rewardCoins;
      userUpdate.coins = newCoins;
      tx.update(adminRef, { coins: (Number(admin.coins) || 0) - rewardCoins });
      tx.set(db().collection('coinTransactions').doc(), {
        type: 'ANIME_COMPLETE', from: 'admin', to: uid, amount: rewardCoins,
        meta: { animeId: item.malId, animeTitle: item.title },
        userBalanceAfter: newCoins, timestamp: FV().serverTimestamp()
      });
    }

    tx.update(userRef, userUpdate);
    return {
      completed: true,
      title: item.title,
      newCoins,
      newTotalExp,
      newRank,
      coinsPaid: canPay
    };
  });
}

async function buyItem(uid, itemId) {
  const itemSnap = await db().doc('storeItems/' + itemId).get();
  if (!itemSnap.exists) throw new Error('Item not found');
  const item = itemSnap.data();
  if (!item.active) throw new Error('Item unavailable');
  const price = Number(item.price) || 0;
  if (price < 1) throw new Error('Invalid price');
  const durationDays = Number(item.durationDays) || 30;
  const expiresAt = Date.now() + durationDays * 24 * 60 * 60 * 1000;

  return db().runTransaction(async (tx) => {
    const userRef = db().doc('users/' + uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();
    if (user.isBanned) throw new Error('Account banned');
    if ((Number(user.coins) || 0) < price) throw new Error('Insufficient coins');

    const bank = await getBankSnapshot();
    const adminRef = db().doc('admins/' + bank.treasuryAdminUid);
    const adminSnap = await tx.get(adminRef);
    if (!adminSnap.exists) throw new Error('Treasury admin missing');
    const admin = adminSnap.data();

    const newCoins = (Number(user.coins) || 0) - price;
    const newAdminCoins = (Number(admin.coins) || 0) + price;

    const now = Date.now();
    const owned = (user.ownedItems || []).filter(o => {
      if (typeof o === 'string') return true;
      return o.expiresAt > now && o.id !== itemId;
    });
    owned.push({ id: itemId, expiresAt });

    const upd = { coins: newCoins, ownedItems: owned };
    if ((item.type || 'border') === 'border') upd.activeBorder = item.cssClass || '';

    tx.update(userRef, upd);
    tx.update(adminRef, { coins: newAdminCoins });
    tx.set(db().collection('coinTransactions').doc(), {
      type: 'PURCHASE', from: uid, to: 'admin', amount: price,
      meta: { itemId, itemName: item.name, durationDays },
      userBalanceAfter: newCoins, timestamp: FV().serverTimestamp()
    });
    return { newCoins, activeBorder: upd.activeBorder || user.activeBorder || '' };
  });
}

async function answerPoll(uid, pollId, optionIndex) {
  const pr = db().doc('polls/' + pollId);
  const ur = db().doc('users/' + uid);
  return db().runTransaction(async (tx) => {
    const pollSnap = await tx.get(pr);
    if (!pollSnap.exists) throw new Error('Poll not found');
    const poll = pollSnap.data();
    if (poll.creatorId === uid) throw new Error('Cannot answer own poll');
    if ((poll.voters || []).includes(uid)) throw new Error('Already answered');
    const opts = poll.options || [];
    if (optionIndex < 0 || optionIndex >= opts.length) throw new Error('Invalid option');
    const correct = Number(optionIndex) === Number(poll.correctIndex);

    const userSnap = await tx.get(ur);
    if (!userSnap.exists) throw new Error('User not found');
    const user = userSnap.data();

    const cfg = await loadConfig();
    let awarded = { exp: 0, coins: 0 };

    tx.update(pr, { voters: FV().arrayUnion(uid) });

    if (poll.creatorId) {
      const creatorRef = db().doc('users/' + poll.creatorId);
      const creatorSnap = await tx.get(creatorRef);
      if (creatorSnap.exists) {
        const cExp = (Number(creatorSnap.data().totalExp) || 0) + 15;
        tx.update(creatorRef, {
          totalExp: cExp,
          rank: rankFor(cExp, cfg.rankThresholds)
        });
      }
    }

    if (correct) {
      const bank = await getBankSnapshot();
      const adminRef = db().doc('admins/' + bank.treasuryAdminUid);
      const adminSnap = await tx.get(adminRef);
      if (adminSnap.exists) {
        const admin = adminSnap.data();
        if ((Number(admin.coins) || 0) >= 5) {
          const newExp = (Number(user.totalExp) || 0) + 10;
          const newCoins = (Number(user.coins) || 0) + 5;
          tx.update(adminRef, { coins: (Number(admin.coins) || 0) - 5 });
          tx.update(ur, {
            totalExp: newExp,
            coins: newCoins,
            rank: rankFor(newExp, cfg.rankThresholds),
            expHistory: FV().arrayUnion({ amount: 10, reason: 'Correct poll answer', date: new Date().toISOString() })
          });
          tx.set(db().collection('coinTransactions').doc(), {
            type: 'POLL_REWARD', from: 'admin', to: uid, amount: 5,
            meta: { pollId }, userBalanceAfter: newCoins, timestamp: FV().serverTimestamp()
          });
          awarded = { exp: 10, coins: 5 };
        }
      }
    }

    return { correct, awarded };
  });
}

async function reportPoll(uid, pollId) {
  await db().doc('polls/' + pollId).update({ flags: FV().arrayUnion(uid) });
  return { ok: true };
}

async function createPoll(uid, payload) {
  const user = await getMe(uid);
  if (user.isBanned) throw new Error('Account banned');
  const animeTitle = String(payload.animeTitle || '').trim().slice(0, 100);
  const question = String(payload.question || '').trim().slice(0, 300);
  const options = (payload.options || []).map(o => String(o || '').trim().slice(0, 150));
  const correctIndex = Number(payload.correctIndex);
  if (!animeTitle) throw new Error('Anime name required');
  if (!question) throw new Error('Question required');
  if (options.length < 2 || options.some(o => !o)) throw new Error('Options required');
  if (isNaN(correctIndex) || correctIndex < 0 || correctIndex >= options.length) throw new Error('Invalid correct index');
  const ref = db().collection('polls').doc();
  await ref.set({
    animeId: '',
    animeTitle,
    question,
    options,
    correctIndex,
    creatorId: uid,
    creatorName: user.name || 'Hunter',
    voters: [],
    flags: [],
    createdAt: FV().serverTimestamp()
  });
  return { id: ref.id };
}

async function deletePoll(uid, pollId) {
  const snap = await db().doc('polls/' + pollId).get();
  if (!snap.exists) throw new Error('Not found');
  if (snap.data().creatorId !== uid) throw new Error('Not your poll');
  await snap.ref.delete();
  return { ok: true };
}

async function toggleFollow(uid, targetUid) {
  if (uid === targetUid) throw new Error('Cannot follow yourself');
  return db().runTransaction(async (tx) => {
    const mr = db().doc('users/' + uid);
    const tr = db().doc('users/' + targetUid);
    const ms = await tx.get(mr);
    const ts = await tx.get(tr);
    if (!ms.exists || !ts.exists) throw new Error('User not found');
    const following = ms.data().following || [];
    const isFollowing = following.includes(targetUid);
    if (isFollowing) {
      tx.update(mr, { following: FV().arrayRemove(targetUid) });
      tx.update(tr, { followers: FV().arrayRemove(uid) });
      return { following: false };
    }
    tx.update(mr, { following: FV().arrayUnion(targetUid) });
    tx.update(tr, { followers: FV().arrayUnion(uid) });
    return { following: true };
  });
}

async function setCollectionSlot(uid, malId, kind, action) {
  const cfg = await loadConfig();
  const user = await getMe(uid);
  const list = [...(user[kind] || [])];
  const id = String(malId);
  const exists = list.findIndex(x => String(x.malId) === id);
  if (action === 'remove') {
    if (exists > -1) list.splice(exists, 1);
    await db().doc('users/' + uid).update({ [kind]: list });
    return { ok: true, count: list.length };
  }
  if (exists > -1) return { ok: true, count: list.length };
  const cap = kind === 'prime' ? cfg.maxPrime : cfg.maxFavourite;
  if (list.length >= cap) throw new Error('Limit reached (' + cap + ')');
  const anime = (user.collection || []).find(c => String(c.malId) === id);
  if (!anime) throw new Error('Anime not in collection');
  list.push({ malId: id, anilistId: anime.anilistId || null, title: anime.title, img: anime.img });
  await db().doc('users/' + uid).update({ [kind]: list });
  return { ok: true, count: list.length };
}

async function listStore() {
  const snap = await db().collection('storeItems').where('active', '==', true).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function listPolls(uid) {
  const snap = await db().collection('polls').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function listAnnouncements() {
  const snap = await db().collection('announcements').get();
  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  items.sort((a, b) => {
    const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return tb - ta;
  });
  return items;
}

async function listLeaderboard() {
  const snap = await db().collection('users').orderBy('totalExp', 'desc').limit(50).get();
  return snap.docs.map((d, i) => {
    const u = d.data();
    return {
      position: i + 1,
      uid: d.id,
      name: u.name,
      avatar: u.avatar,
      rank: u.rank,
      totalExp: u.totalExp || 0
    };
  });
}

async function getBankPublic() {
  const snap = await db().doc('meta/bank').get();
  if (!snap.exists) return { totalSupply: 0, currentBalance: 0 };
  const d = snap.data();
  return {
    totalSupply: d.totalSupply || 0,
    currentBalance: d.currentBalance || 0
  };
}

async function uploadAvatar(uid, base64) {
  if (!base64) throw new Error('No image');
  const url = await imgbb.uploadImage(base64, 'avatar_' + uid);
  await db().doc('users/' + uid).update({ avatar: url });
  return { avatar: url };
}

async function scanImage(base64Jpeg) {
  let identifiedTitle = null;
  let matchConfidence = 0;
  let anilistId = null;
  let sceneInfo = null;

  try {
    const form = new FormData();
    form.append('image', Buffer.from(base64Jpeg, 'base64'), { filename: 'scan.jpg' });
    const r = await axios.post(config.apis.traceMoe + '/search?anilistInfo', form, {
      headers: form.getHeaders ? form.getHeaders() : undefined,
      timeout: 20000
    });
    const results = r.data && r.data.result ? r.data.result : [];
    if (results.length > 0 && results[0].similarity >= 0.87) {
      const m = results[0];
      matchConfidence = Number((m.similarity * 100).toFixed(1));
      identifiedTitle = m.anilist?.title?.english || m.anilist?.title?.romaji || null;
      anilistId = m.anilist?.id || null;
      sceneInfo = {
        episode: m.episode !== null && m.episode !== undefined ? m.episode : null,
        from: m.from || 0,
        video: m.video || null
      };
    }
  } catch (e) {
    // Trace.moe failure ignored; fall through to Gemini
  }

  if (!identifiedTitle) {
    const g = await gemini.recognizeAnime(base64Jpeg);
    if (!g.isAnime || !g.animeTitle || (g.confidence && g.confidence < 85)) {
      return {
        detected: false,
        rejectionReason: g.rejectionReason || 'This image does not appear to be an anime.'
      };
    }
    identifiedTitle = g.animeTitle;
    matchConfidence = g.confidence ? Number(g.confidence) : 95;
    sceneInfo = { character: g.character || null };
  }

  let metadata = null;
  try {
    const gql = anilistId
      ? 'query($id:Int){Media(id:$id,type:ANIME){id idMal title{romaji english} coverImage{large} averageScore episodes description genres}}'
      : 'query($search:String){Media(search:$search,type:ANIME){id idMal title{romaji english} coverImage{large} averageScore episodes description genres}}';
    const variables = anilistId ? { id: parseInt(anilistId, 10) } : { search: identifiedTitle };
    const r = await axios.post(config.apis.anilist, { query: gql, variables }, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 15000
    });
    metadata = r.data && r.data.data ? r.data.data.Media : null;
  } catch (e) {
    metadata = null;
  }

  return {
    detected: true,
    matchConfidence,
    identifiedTitle,
    anilistId,
    sceneInfo,
    metadata
  };
}

async function changePassword(uid, currentPassword, newPassword) {
  if (!newPassword || newPassword.length < 6) throw new Error('Password must be at least 6 chars');
  const user = await adminSdk.auth().getUser(uid);
  const hasPassword = user.providerData.some(p => p.providerId === 'password');
  if (!hasPassword) throw new Error('No password set on this account');
  const email = user.providerData.find(p => p.providerId === 'password').email;
  const verifyUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${config.firebase.apiKey}`;
  try {
    await axios.post(verifyUrl, { email, password: currentPassword, returnSecureToken: true });
  } catch (e) {
    throw new Error('Current password incorrect');
  }
  await adminSdk.auth().updateUser(uid, { password: newPassword });
  return { ok: true };
}

async function setBackupEmail(uid, email, password) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 chars');
  const userSnap = await db().doc('users/' + uid).get();
  if (userSnap.exists && (userSnap.data().backupEmail || '').trim()) {
    throw new Error('Backup email is permanent and cannot be changed');
  }
  const authUser = await adminSdk.auth().getUser(uid);
  if (authUser.providerData.some(p => p.providerId === 'password')) {
    throw new Error('A password provider is already linked');
  }
  const ownEmail = (authUser.email || '').toLowerCase();
  if (email.toLowerCase() === ownEmail) throw new Error('Cannot use your primary email');
  try {
    await adminSdk.auth().updateUser(uid, { email, password });
  } catch (e) {
    if (e.code === 'auth/email-already-exists') throw new Error('Email already in use');
    throw new Error(e.message || 'Failed to link backup email');
  }
  await db().doc('users/' + uid).update({ backupEmail: email });
  return { ok: true, email };
}

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  rankFor,
  createUserRecord,
  getMe,
  getPublicUser,
  updateProfile,
  claimDaily,
  completeEpisode,
  buyItem,
  answerPoll,
  reportPoll,
  createPoll,
  deletePoll,
  toggleFollow,
  setCollectionSlot,
  listStore,
  listPolls,
  listAnnouncements,
  listLeaderboard,
  getBankPublic,
  uploadAvatar,
  scanImage,
  changePassword,
  setBackupEmail
};