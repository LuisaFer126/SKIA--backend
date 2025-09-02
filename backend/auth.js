import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { query } from './db.js';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'dev'; // Use a strong secret in production

// Register user; optionally create an advanced profile in UserProfile
export async function register(email, password, name, profile = null) {
  const hash = await bcrypt.hash(password, 10);
  const res = await query('INSERT INTO "User" (email, name, password_hash) VALUES ($1,$2,$3) RETURNING userId,email,name,created_at', [email, name, hash]);
  const user = res.rows[0];
  // Create profile if advanced data provided
  if (profile && typeof profile === 'object') {
    const age = profile.age != null && String(profile.age).trim() !== '' ? Number(profile.age) : null;
    const occupation = profile.occupation ?? null;
    const sleepNotes = profile.sleepNotes ?? null;
    const stressors = profile.stressors ?? null;
    const goals = profile.goals ?? null;
    const boundaries = profile.boundaries ?? null;
    const data = profile.data ?? null;
    try {
      await query(
        `INSERT INTO "UserProfile" (userId, age, occupation, sleepNotes, stressors, goals, boundaries, data, createdAt, updatedAt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
         ON CONFLICT (userId) DO NOTHING`,
        [user.userid, age, occupation, sleepNotes, stressors, goals, boundaries, data]
      );
    } catch (e) {
      // Do not block registration on profile error
      console.warn('UserProfile insert failed', e.message);
    }
  }
  return user;
}

export async function login(email, password) {
  const res = await query('SELECT * FROM "User" WHERE email=$1', [email]);
  if (!res.rowCount) throw new Error('User not found');
  const user = res.rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new Error('Invalid password');
  const token = jwt.sign({ userId: user.userid }, JWT_SECRET, { expiresIn: '7d' });
  return { token, user: { userId: user.userid, email: user.email, name: user.name } };
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Missing auth header' });
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
