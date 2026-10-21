const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./api');

const escapeHtml = (v = '') => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
const isValidUrl = (u) => /^https?:\/\//i.test(String(u || ''));
const safeString = (v, max = 2000) => typeof v === 'string' ? v.slice(0, max) : '';
const safeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');

const DEFAULT_AVATAR = 'https://upload.wikimedia.org/wikipedia/commons/7/7c/Profile_avatar_placeholder_large.png';
const validImageUrl = (url, fb = DEFAULT_AVATAR) => {
  if (typeof url !== 'string') return fb;
  if (!/^https?:\/\//i.test(url)) return fb;
  return url;
};

function signSession(uid) {
  return jwt.sign({ uid }, jwtSecret, { expiresIn: '30d' });
}

function verifySession(token) {
  return jwt.verify(token, jwtSecret);
}

function requireAuth(req, res, next) {
  const cookieToken = req.cookies?.session;
  const bearer = (req.headers.authorization || '').replace('Bearer ', '');
  const token = cookieToken || bearer;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.uid = verifySession(token).uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired' });
  }
}

const _limits = new Map();
function checkRate(key, max, windowMs) {
  const now = Date.now();
  let entry = _limits.get(key);
  if (!entry || now > entry.reset) entry = { count: 0, reset: now + windowMs };
  entry.count++;
  _limits.set(key, entry);
  return entry.count <= max;
}

function friendlyError(error) {
  if (!error) return 'Something went wrong';
  const map = {
    'auth/invalid-credential': 'Invalid credentials',
    'permission-denied': 'Permission denied',
    'not-found': 'Not found',
    'unavailable': 'Service unavailable',
  };
  return map[error.code] || error.message || 'Something went wrong';
}

module.exports = {
  escapeHtml, isValidEmail, isValidUrl, safeString, safeId, validImageUrl,
  signSession, verifySession, requireAuth, checkRate, friendlyError, DEFAULT_AVATAR,
};