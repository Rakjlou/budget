import argon2 from 'argon2';
import { db } from './db.js';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function unauthorized(res, message = 'Authentication required') {
  res.set('WWW-Authenticate', 'Basic realm="budget-tracker"');
  res.status(401).json({ error: 'unauthorized', message });
}

export async function basicAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) {
    return unauthorized(res);
  }

  const now = Date.now();
  const cachedExp = cache.get(header);
  if (cachedExp && cachedExp > now) {
    cache.set(header, now + TTL_MS);
    return next();
  }

  let username, password;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return unauthorized(res);
    username = decoded.slice(0, idx);
    password = decoded.slice(idx + 1);
  } catch {
    return unauthorized(res);
  }

  const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username);
  if (!row) return unauthorized(res);

  let ok = false;
  try {
    ok = await argon2.verify(row.password_hash, password);
  } catch {
    return unauthorized(res);
  }
  if (!ok) return unauthorized(res);

  cache.set(header, now + TTL_MS);
  next();
}
