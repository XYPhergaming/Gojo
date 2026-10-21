// api/utils.js — Pure helper functions, no dependencies

export const escapeHtml = (v = '') =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const safeString = (v, maxLen = 2000) =>
  typeof v === 'string' ? v.slice(0, maxLen) : '';

export const getTodayKey = () => new Date().toDateString();

export const validImageUrl = (
  url,
  fb = 'https://upload.wikimedia.org/wikipedia/commons/7/7c/Profile_avatar_placeholder_large.png'
) => {
  if (typeof url !== 'string') return fb;
  if (!/^https?:\/\//i.test(url)) return fb;
  return url;
};

export const safeUrl = (url, fb = '#') => {
  if (typeof url !== 'string') return fb;
  if (!/^https?:\/\//i.test(url)) return fb;
  return url;
};

export const toNumber = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export const sanitizeCSS = (css, maxLen = 4000) => {
  if (typeof css !== 'string') return '';
  if (css.length > maxLen) css = css.slice(0, maxLen);
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  css = css.replace(/@import[^;]*;?/gi, '');
  css = css.replace(/@charset[^;]*;?/gi, '');
  css = css.replace(/@namespace[^;]*;?/gi, '');
  css = css.replace(/<\/?style[^>]*>/gi, '');
  css = css.replace(/url\(\s*(['"]?)(?!data:)[^)]*\)/gi, '');
  if (/expression\s*\(/i.test(css)) return '';
  if (/javascript\s*:/i.test(css)) return '';
  if (/behavior\s*:/i.test(css)) return '';
  if (/-moz-binding/i.test(css)) return '';
  if (/<script/i.test(css)) return '';
  return css;
};

export const getFriendlyError = (error) => {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code || '';
  const map = {
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/user-not-found': 'No account found with this email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/too-many-requests': 'Too many attempts. Wait a moment.',
    'auth/email-already-in-use': 'Email already in use by another account.',
    'auth/credential-already-in-use': 'This credential is already used by another account.',
    'auth/account-exists-with-different-credential': 'An account with this email exists using a different sign-in method.',
    'auth/weak-password': 'Password too weak. Use 6+ characters.',
    'auth/network-request-failed': 'Network error.',
    'auth/popup-closed-by-user': 'You closed the login window.',
    'auth/popup-blocked': 'Browser blocked popup.',
    'auth/requires-recent-login': 'Please sign in again to change this.',
    'auth/operation-not-supported-in-this-environment': 'This browser does not support popup sign-in.',
    'auth/provider-already-linked': 'This sign-in method is already linked to your account.',
    'auth/no-such-provider': 'No such provider linked.',
    'permission-denied': 'Permission denied.',
    'not-found': 'Data not found.',
    'unavailable': 'Server temporarily unavailable.',
    'deadline-exceeded': 'Server not responding.',
    'unauthenticated': 'Please sign in again.'
  };
  if (code && map[code]) return map[code];
  if (error.message && /cannot be changed/i.test(error.message)) return error.message;
  if (error.message && /already/i.test(error.message)) return error.message;
  if (error.message && error.message.length < 200) return error.message;
  return 'Something went wrong. Please try again.';
};