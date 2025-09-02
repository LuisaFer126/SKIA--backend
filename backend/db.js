import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;

// Configuración robusta para Supabase (evita error SELF_SIGNED_CERT_IN_CHAIN)
let connection;
if (process.env.DATABASE_URL) {
  try {
    const url = new URL(process.env.DATABASE_URL);
    connection = {
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname?.slice(1) || 'postgres',
      ssl: { rejectUnauthorized: false },
    };
  } catch {
    // Fallback a connectionString (sigue forzando SSL no verificado)
    connection = {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    };
  }
} else {
  connection = {
    host: process.env.PGHOST || 'aws-1-us-east-2.pooler.supabase.com',
    user: process.env.PGUSER || 'postgres.pmaqxvlphtlcnveqnvcu',
    password: process.env.PGPASSWORD || 'confident-skia', // ⚠️ evitar hardcodear en prod
    database: process.env.PGDATABASE || 'postgres',
    port: Number(process.env.PGPORT || 6543),
    ssl: { rejectUnauthorized: false },
  };
}

// Ajustes de pool optimizados para entornos serverless (Vercel, etc.)
const poolOptions = {
  ...connection,
  max: Number(process.env.PGPOOL_MAX || (process.env.VERCEL ? 3 : 10)),
  idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_TIMEOUT_MS || (process.env.VERCEL ? 10000 : 30000)),
  connectionTimeoutMillis: Number(process.env.PGPOOL_CONN_TIMEOUT_MS || 5000),
  allowExitOnIdle: true,
};

export const pool = new Pool(poolOptions);

export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.DEBUG_SQL) {
    console.log('executed query', { text, duration, rows: res.rowCount });
  }
  return res;
}
