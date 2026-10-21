const cors = require('cors');
const config = require('./api');

const allowlist = config.corsOrigins;

const options = {
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (allowlist.includes('*')) return cb(null, true);
    if (allowlist.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: [],
  credentials: false,
  maxAge: 86400
};

module.exports = cors(options);