/**
 * طبقة قاعدة البيانات — Postgres حقيقي.
 *
 * • DATABASE_URL موجود  → Postgres عادي عبر حزمة pg (الإنتاج)
 * • غير موجود            → PGlite: نفس Postgres لكن مُجمَّع إلى WASM داخل العملية (تطوير/تجربة)
 *
 * نفس الـSQL يعمل في الحالتين، ولهذا الانتقال للإنتاج لا يحتاج تغيير كود.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.join(__dirname, 'schema.sql');

let impl = null;

export async function initDb() {
  if (impl) return impl;

  if (ENV.databaseUrl) {
    const { default: pg } = await import('pg');
    /* Neon / Render / Supabase تفرض TLS — نفعّله تلقائيًا لأي مضيف غير محلي */
    const local = /(^|\/\/)(localhost|127\.0\.0\.1)/.test(ENV.databaseUrl);
    const pool = new pg.Pool({
      connectionString: ENV.databaseUrl,
      max: 10,
      ...(local ? {} : { ssl: { rejectUnauthorized: false } }),
    });
    impl = {
      kind: 'postgres',
      query: (text, params) => pool.query(text, params),
      exec: (sql) => pool.query(sql),
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({ query: (t, p) => client.query(t, p) });
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = ENV.pgliteDir;
    fs.mkdirSync(dir, { recursive: true });
    const db = new PGlite(dir);
    await db.waitReady;
    impl = {
      kind: 'pglite',
      query: (text, params) => db.query(text, params),
      exec: (sql) => db.exec(sql),
      tx: (fn) => db.transaction(fn),
      close: () => db.close(),
    };
  }

  await migrate();
  return impl;
}

async function migrate() {
  const sql = fs.readFileSync(SCHEMA, 'utf8');
  await impl.exec(sql);
}

export function db() {
  if (!impl) throw new Error('قاعدة البيانات غير مهيّأة — نادِ initDb() أولًا');
  return impl;
}

export const dbInfo = () => (impl ? { kind: impl.kind } : { kind: 'none' });
