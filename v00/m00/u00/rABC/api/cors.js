import cors from 'cors';

const raw = (process.env.ALLOWED_ORIGIN || '*').trim();
const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);

export const corsMiddleware = cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
});

export default corsMiddleware;