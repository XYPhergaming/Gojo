const admin = require('firebase-admin');
const config = require('./api');

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(config.serviceAccount);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: config.firebase.projectId
    });
  } catch (e) {
    console.error('Firebase Admin init failed:', e.message);
  }
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };