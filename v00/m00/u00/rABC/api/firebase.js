const admin = require('firebase-admin');
const config = require('./api');

let initialized = false;

function init() {
  if (initialized && admin.apps.length) return admin;
  if (admin.apps.length) { initialized = true; return admin; }
  const sa = config.firebase.serviceAccount;
  if (!sa) {
    throw new Error('Firebase service account not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON in .env');
  }
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: config.firebase.projectId || sa.projectId
  });
  initialized = true;
  return admin;
}

function auth() { return init().auth(); }
function db() { return init().firestore(); }
function FieldValue() { init(); return admin.firestore.FieldValue; }
function Timestamp() { init(); return admin.firestore.Timestamp; }

module.exports = { init, auth, db, FieldValue, Timestamp };