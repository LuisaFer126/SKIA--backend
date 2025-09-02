import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { query } from './db.js';
import { authMiddleware, login, register } from './auth.js';
import { generateBotReply } from './gemini.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => res.json({ status: 'ok' }));

// Auth endpoints
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name, profile } = req.body;
    const user = await register(email, password, name, profile);
    res.json(user);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const data = await login(email, password);
    res.json(data);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Chat sessions: create or resume
app.post('/api/chat/session', authMiddleware, async (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) {
    const existing = await query('SELECT * FROM "ChatSession" WHERE sessionId=$1 AND userId=$2', [sessionId, req.user.userId]);
    if (!existing.rowCount) return res.status(404).json({ error: 'Session not found' });
    const messages = await query('SELECT * FROM "Message" WHERE sessionId=$1 ORDER BY createdAt ASC', [sessionId]);
    return res.json({ sessionId, messages: messages.rows });
  }
  const created = await query('INSERT INTO "ChatSession" (userId) VALUES ($1) RETURNING sessionId,startDate', [req.user.userId]);
  res.json(created.rows[0]);
});

// Messaging: persist user message, call Gemini, persist bot reply (with emotion)
app.post('/api/chat/message', authMiddleware, async (req, res) => {
  try {
    let { sessionId, content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'content required' });
    content = content.trim();
    // Auto crear sesión si no se envía
    if (!sessionId) {
      const created = await query('INSERT INTO "ChatSession" (userId) VALUES ($1) RETURNING sessionId', [req.user.userId]);
      sessionId = created.rows[0].sessionid;
    }
    const session = await query('SELECT * FROM "ChatSession" WHERE sessionId=$1 AND userId=$2', [sessionId, req.user.userId]);
    if (!session.rowCount) return res.status(404).json({ error: 'Session not found' });

    const userMsg = await query('INSERT INTO "Message" (sessionId, author, content) VALUES ($1,$2,$3) RETURNING *', [sessionId, 'user', content]);

    const previous = await query('SELECT author, content FROM "Message" WHERE sessionId=$1 ORDER BY createdAt ASC LIMIT 15', [sessionId]);
    let botText = '';
    let botEmotion = null;
    let crisis = false;
    try {
      const r = await generateBotReply(previous.rows.concat([{ author: 'user', content } ]));
      botText = typeof r === 'string' ? r : (r?.text || '');
      botEmotion = typeof r === 'object' ? (r?.emotion || null) : null;
      crisis = typeof r === 'object' ? Boolean(r?.crisis) : false;
    } catch (modelErr) {
      console.error('Gemini error', modelErr);
      botText = 'Lo siento, ahora mismo no puedo generar respuesta.';
    }
    const botMsg = await query('INSERT INTO "Message" (sessionId, author, content, emotionType) VALUES ($1,$2,$3,$4) RETURNING *', [sessionId, 'bot', botText, botEmotion]);
    const help = crisis ? getColombiaHelpResources() : null;
    res.json({ sessionId, user: userMsg.rows[0], bot: botMsg.rows[0], crisis, help });
  } catch (e) { console.error('chat/message error', e); res.status(500).json({ error: e.message }); }
});

// Sessions list for current user
app.get('/api/chat/sessions', authMiddleware, async (req, res) => {
  const sessions = await query('SELECT sessionId, startDate, endDate FROM "ChatSession" WHERE userId=$1 ORDER BY startDate DESC', [req.user.userId]);
  res.json(sessions.rows);
});

// Messages of a session (user-owned)
app.get('/api/chat/session/:id/messages', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const check = await query('SELECT * FROM "ChatSession" WHERE sessionId=$1 AND userId=$2', [id, req.user.userId]);
  if (!check.rowCount) return res.status(404).json({ error: 'Session not found' });
  const messages = await query('SELECT * FROM "Message" WHERE sessionId=$1 ORDER BY createdAt ASC', [id]);
  res.json(messages.rows);
});

// UserHistory demo: store freeform summary text
app.post('/api/user/history/summarize', authMiddleware, async (req, res) => {
  const { text } = req.body;
  const existing = await query('SELECT * FROM "UserHistory" WHERE userId=$1', [req.user.userId]);
  if (existing.rowCount) {
    const upd = await query('UPDATE "UserHistory" SET summary=$1, updatedAt=NOW() WHERE userId=$2 RETURNING *', [text, req.user.userId]);
    return res.json(upd.rows[0]);
  } else {
    const ins = await query('INSERT INTO "UserHistory" (userId, summary) VALUES ($1,$2) RETURNING *', [req.user.userId, text]);
    return res.json(ins.rows[0]);
  }
});

// UserProfile: get or upsert structured/advanced profile
app.get('/api/user/profile', authMiddleware, async (req, res) => {
  const r = await query('SELECT * FROM "UserProfile" WHERE userId=$1', [req.user.userId]);
  if (!r.rowCount) return res.json(null);
  res.json(r.rows[0]);
});

app.put('/api/user/profile', authMiddleware, async (req, res) => {
  const { age = null, occupation = null, sleepNotes = null, stressors = null, goals = null, boundaries = null, data = {} } = req.body || {};
  const up = await query(
    `INSERT INTO "UserProfile" (userId, age, occupation, sleepNotes, stressors, goals, boundaries, data, createdAt, updatedAt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
     ON CONFLICT (userId)
     DO UPDATE SET age=EXCLUDED.age, occupation=EXCLUDED.occupation, sleepNotes=EXCLUDED.sleepNotes, stressors=EXCLUDED.stressors,
                   goals=EXCLUDED.goals, boundaries=EXCLUDED.boundaries, data=EXCLUDED.data, updatedAt=NOW()
     RETURNING *`,
    [req.user.userId, age, occupation, sleepNotes, stressors, goals, boundaries, data]
  );
  res.json(up.rows[0]);
});

// Heuristic suggestions derived from DB usage (length, exclamations, hours)
app.get('/api/user/profile/suggestions', authMiddleware, async (req, res) => {
  const uid = req.user.userId;
  const avgLen = await query(
    `SELECT COALESCE(AVG(LENGTH(content)),0)::float AS avg_len
     FROM "Message" m JOIN "ChatSession" s ON s.sessionid=m.sessionid
     WHERE s.userid=$1 AND m.author='user'`, [uid]
  );
  const exAvg = await query(
    `SELECT COALESCE(AVG((LENGTH(content) - LENGTH(REPLACE(content,'!','')))),0)::float AS exclam_avg
     FROM "Message" m JOIN "ChatSession" s ON s.sessionid=m.sessionid
     WHERE s.userid=$1 AND m.author='user'`, [uid]
  );
  const hours = await query(
    `SELECT CAST(date_part('hour', m.createdat) AS int) AS h, COUNT(*)::int c
     FROM "Message" m JOIN "ChatSession" s ON s.sessionid=m.sessionid
     WHERE s.userid=$1 AND m.author='user'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 3`, [uid]
  );
  const hourCounts = await query(
    `SELECT CAST(h AS int) AS h, COALESCE(cnt,0)::int c FROM (
       SELECT generate_series(0,23) AS h) g
       LEFT JOIN (
         SELECT date_part('hour', m.createdat) AS h, COUNT(*) AS cnt
         FROM "Message" m JOIN "ChatSession" s ON s.sessionid=m.sessionid
         WHERE s.userid=$1 AND m.author='user'
         GROUP BY 1
       ) x USING(h)
     ORDER BY c ASC, h ASC LIMIT 1`, [uid]
  );

  const avg_len = Number(avgLen.rows[0]?.avg_len || 0);
  const exclam_avg = Number(exAvg.rows[0]?.exclam_avg || 0);
  const topHours = hours.rows.map(r => r.h);
  const quietStart = hourCounts.rowCount ? Number(hourCounts.rows[0].h) : 0;

  let responseLength = 'medium';
  if (avg_len < 60) responseLength = 'short';
  else if (avg_len > 180) responseLength = 'long';

  let tone = 'neutral';
  if (exclam_avg >= 0.6 && avg_len < 160) tone = 'casual';
  if (exclam_avg < 0.15 && avg_len > 200) tone = 'formal';

  const suggestions = {
    responseLength,
    tone,
    topHours,
    quietHours: { start: quietStart, duration: 6 },
    typingIndicators: true,
  };

  res.json({ suggestions, metrics: { avg_len, exclam_avg, topHours, quietStart } });
});

app.post('/api/user/profile/apply-suggestions', authMiddleware, async (req, res) => {
  const uid = req.user.userId;
  const avgLen = await query(
    `SELECT COALESCE(AVG(LENGTH(content)),0)::float AS avg_len
     FROM "Message" m JOIN "ChatSession" s ON s.sessionid=m.sessionid
     WHERE s.userid=$1 AND m.author='user'`, [uid]
  );
  const exAvg = await query(
    `SELECT COALESCE(AVG((LENGTH(content) - LENGTH(REPLACE(content,'!','')))),0)::float AS exclam_avg
     FROM "Message" m JOIN "ChatSession" s ON s.sessionid=m.sessionid
     WHERE s.userid=$1 AND m.author='user'`, [uid]
  );
  const hours = await query(
    `SELECT CAST(date_part('hour', m.createdat) AS int) AS h, COUNT(*)::int c
     FROM "Message" m JOIN "ChatSession" s ON s.sessionid=m.sessionid
     WHERE s.userid=$1 AND m.author='user'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 3`, [uid]
  );
  const hourCounts = await query(
    `SELECT CAST(h AS int) AS h, COALESCE(cnt,0)::int c FROM (
       SELECT generate_series(0,23) AS h) g
       LEFT JOIN (
         SELECT date_part('hour', m.createdat) AS h, COUNT(*) AS cnt
         FROM "Message" m JOIN "ChatSession" s ON s.sessionid=m.sessionid
         WHERE s.userid=$1 AND m.author='user'
         GROUP BY 1
       ) x USING(h)
     ORDER BY c ASC, h ASC LIMIT 1`, [uid]
  );
  const avg_len = Number(avgLen.rows[0]?.avg_len || 0);
  const exclam_avg = Number(exAvg.rows[0]?.exclam_avg || 0);
  const topHours = hours.rows.map(r => r.h);
  const quietStart = hourCounts.rowCount ? Number(hourCounts.rows[0].h) : 0;
  let responseLength = 'medium';
  if (avg_len < 60) responseLength = 'short';
  else if (avg_len > 180) responseLength = 'long';
  let tone = 'neutral';
  if (exclam_avg >= 0.6 && avg_len < 160) tone = 'casual';
  if (exclam_avg < 0.15 && avg_len > 200) tone = 'formal';
  const suggestions = { responseLength, tone, topHours, quietHours: { start: quietStart, duration: 6 }, typingIndicators: true };
  const current = await query('SELECT data FROM "UserProfile" WHERE userId=$1', [req.user.userId]);
  const existing = current.rowCount ? (current.rows[0].data || {}) : {};
  const merged = { ...existing, ...suggestions };
  const up = await query(
    `INSERT INTO "UserProfile" (userId, data, createdAt, updatedAt)
     VALUES ($1,$2,NOW(),NOW())
     ON CONFLICT (userId)
     DO UPDATE SET data=EXCLUDED.data, updatedAt=NOW()
     RETURNING *`,
    [req.user.userId, merged]
  );
  res.json({ profile: up.rows[0], suggestions });
});

function getColombiaHelpResources() {
  return {
    country: 'CO',
    disclaimer: 'Si estás en peligro inmediato, llama a emergencias locales. Estos recursos son confidenciales y gratuitos según el operador indicado.',
    items: [
      { name: 'Línea de la Vida (nacional)', contact: '(605) 339 9999', hours: '24/7' },
      { name: 'Línea de Salud Mental Distrital (Barranquilla)', contact: '315 300 2003', hours: '24/7' },
      { name: 'Línea Charlemos (WhatsApp)', contact: '318 804 4000', hours: '24/7' },
      { name: 'Línea 106 Bogotá (y WhatsApp)', contact: '106 / 300 754 8933', hours: '24/7' },
      { name: 'Línea Púrpura (violencia contra mujeres)', contact: '018000 112 137 / WhatsApp 300 755 1846 / ipurpura@sdmujer.gov.co', hours: '24/7' },
      { name: 'Línea Psicoactiva (Bogotá) – Prevención consumo de SPA', contact: '01 8000 112 439', hours: 'Horarios institucionales' },
      { name: 'Línea de Apoyo Emocional (Policía Nacional)', contact: '018000‑910588 (Subsistema de Salud)', hours: '24/7' },
      { name: 'Meta – Línea Amiga', contact: '312 575 1135', hours: 'Todos los días, 9 a.m. – 9 p.m.' },
    ],
    sources: ['iasp.info', 'Ministerio de Salud', 'Bogotá.gov.co', 'Policía Nacional de Colombia']
  };
}

export default app;

