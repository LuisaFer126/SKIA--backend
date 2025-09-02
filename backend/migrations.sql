-- Schema creation
CREATE TABLE IF NOT EXISTS "User" (
  userId SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "ChatSession" (
  sessionId SERIAL PRIMARY KEY,
  userId INT REFERENCES "User"(userId) ON DELETE CASCADE,
  startDate TIMESTAMP DEFAULT NOW(),
  endDate TIMESTAMP
);

-- Optional metadata for sessions
ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS title TEXT;

CREATE TABLE IF NOT EXISTS "Message" (
  messageId SERIAL PRIMARY KEY,
  sessionId INT REFERENCES "ChatSession"(sessionId) ON DELETE CASCADE,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  createdAt TIMESTAMP DEFAULT NOW(),
  emotionType TEXT
);

CREATE TABLE IF NOT EXISTS "UserHistory" (
  historyId SERIAL PRIMARY KEY,
  userId INT REFERENCES "User"(userId) ON DELETE CASCADE,
  summary TEXT,
  updatedAt TIMESTAMP DEFAULT NOW()
);

-- User profile: datos opcionales y estructurados para personalización
CREATE TABLE IF NOT EXISTS "UserProfile" (
  profileId SERIAL PRIMARY KEY,
  userId INT UNIQUE REFERENCES "User"(userId) ON DELETE CASCADE,
  age INT,
  occupation TEXT,
  sleepNotes TEXT,
  stressors TEXT,
  goals TEXT,
  boundaries TEXT,
  data JSONB,
  createdAt TIMESTAMP DEFAULT NOW(),
  updatedAt TIMESTAMP DEFAULT NOW()
);

-- Helpful indexes (column names become lowercase in PG)
CREATE INDEX IF NOT EXISTS idx_message_session_created ON "Message" (sessionid, createdat);
CREATE INDEX IF NOT EXISTS idx_chatsession_user_start ON "ChatSession" (userid, startdate);

-- Drop deprecated profile fields if present
ALTER TABLE "UserProfile" DROP COLUMN IF EXISTS tonePref;
ALTER TABLE "UserProfile" DROP COLUMN IF EXISTS energyNotes;
