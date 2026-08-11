import 'dotenv/config';
import { createClient } from '@libsql/client';

/* O mesmo cliente libSQL funciona tanto com um arquivo SQLite local
   (file:./data.db, ótimo para desenvolvimento) quanto com um banco
   Turso hospedado (libsql://SEU-BANCO.turso.io + auth token), que é a
   opção recomendada para produção porque garante persistência mesmo em
   hospedagens "free tier" com sistema de arquivos temporário (ex.: Render
   free). Veja o README.md para o passo a passo de cada opção. */
const url = process.env.DATABASE_URL || 'file:./data.db';
const authToken = process.env.DATABASE_AUTH_TOKEN || undefined;

export const db = createClient(authToken ? { url, authToken } : { url });

export async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      credits INTEGER NOT NULL DEFAULT 0,
      device_id_hash TEXT,
      session_token_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}
