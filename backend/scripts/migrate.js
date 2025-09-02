import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrate() {
  console.log('Using DATABASE_URL =', process.env.DATABASE_URL?.replace(/:(?:[^:@/]{4,})(?=@)/, ':****'));
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations.sql'), 'utf8');
  await query(sql);
  console.log('Migration completed');
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
