require('dotenv').config();

module.exports = {
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  jwtSecret: process.env.JWT_SECRET,
  imgbbKey: process.env.IMGBB_KEY,
  geminiKey: process.env.GEMINI_KEY,
  allowedOrigin: process.env.ALLOWED_ORIGIN || '*',
  apis: {
    anilist: process.env.ANILIST_GRAPHQL || 'https://graphql.anilist.co',
    mangadex: process.env.MANGADEX_API || 'https://api.mangadex.org',
    mangadexCovers: process.env.MANGADEX_COVERS || 'https://uploads.mangadex.org',
    traceMoe: process.env.TRACEMOE_API || 'https://api.trace.moe',
    kitsu: process.env.KITSU_API || 'https://kitsu.io/api/edge',
    radioBrowser: process.env.RADIO_BROWSER_API || 'https://de1.api.radio-browser.info',
    nekosBest: process.env.NEKOS_BEST_API || 'https://nekos.best/api/v2',
    animeNewsRss: process.env.ANIME_NEWS_RSS || 'https://www.animenewsnetwork.com/all/rss.xml',
    allorigins: process.env.ALLORIGINS_PROXY || 'https://api.allorigins.win/raw?url=',
    codetabs: process.env.CODETABS_PROXY || 'https://api.codetabs.com/v1/proxy?quest=',
    corsproxy: process.env.CORSPROXY || 'https://corsproxy.io/?url=',
  }
};
