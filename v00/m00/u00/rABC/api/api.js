require('dotenv').config();

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim().length > 0) {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (clientEmail && privateKey && process.env.FIREBASE_PROJECT_ID) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail,
      privateKey
    };
  }
  return null;
}

module.exports = {
  firebase: {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    databaseURL: process.env.FIREBASE_DATABASE_URL || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || '',
    serviceAccount: parseServiceAccount()
  },
  imgbb: {
    key: process.env.IMGBB_KEY || '',
    endpoint: 'https://api.imgbb.com/1/upload'
  },
  gemini: {
    key: process.env.GEMINI_KEY || '',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent'
  },
  apis: {
    anilist: process.env.ANILIST_GRAPHQL || 'https://graphql.anilist.co',
    mangadex: process.env.MANGADEX_API || 'https://api.mangadex.org',
    mangadexCovers: process.env.MANGADEX_COVERS || 'https://uploads.mangadex.org',
    traceMoe: process.env.TRACEMOE_API || 'https://api.trace.moe',
    kitsu: process.env.KITSU_API || 'https://kitsu.io/api/edge',
    radioBrowser: process.env.RADIO_BROWSER_API || 'https://de1.api.radio-browser.info',
    nekos: process.env.NEKOS_BEST_API || 'https://nekos.best/api/v2',
    animeNewsRss: process.env.ANIME_NEWS_RSS || 'https://www.animenewsnetwork.com/all/rss.xml',
    allorigins: process.env.ALLORIGINS_PROXY || 'https://api.allorigins.win/raw?url=',
    codetabs: process.env.CODETABS_PROXY || 'https://api.codetabs.com/v1/proxy?quest=',
    corsproxy: process.env.CORSPROXY || 'https://corsproxy.io/?url='
  },
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean)
};