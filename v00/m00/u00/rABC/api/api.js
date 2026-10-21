require('dotenv').config();

module.exports = {
  firebase: {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
  },
  imgbb: process.env.IMGBB_KEY,
  gemini: process.env.GEMINI_KEY,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  jwtSecret: process.env.JWT_SECRET,
  serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
  endpoints: {
    anilist: process.env.ANILIST_GRAPHQL,
    mangadex: process.env.MANGADEX_API,
    mangadexCovers: process.env.MANGADEX_COVERS,
    traceMoe: process.env.TRACEMOE_API,
    kitsu: process.env.KITSU_API,
    radioBrowser: process.env.RADIO_BROWSER_API,
    nekosBest: process.env.NEKOS_BEST_API,
    animeNewsRss: process.env.ANIME_NEWS_RSS,
    allorigins: process.env.ALLORIGINS_PROXY,
    codetabs: process.env.CODETABS_PROXY,
    corsproxy: process.env.CORSPROXY
  }
};