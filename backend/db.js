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

  /* ---------------------------------------------------------------
     Migração: colunas de configuração do caderno atribuídas pelo
     admin a cada usuário (fonte, modelo de folha, margens e linhas).
     SQLite/libSQL não suportam "ADD COLUMN IF NOT EXISTS", então cada
     ALTER TABLE roda dentro de um try/catch — falha silenciosamente
     quando a coluna já existe (banco já migrado antes).
  --------------------------------------------------------------- */
  const migrations = [
    `ALTER TABLE users ADD COLUMN assigned_font_data TEXT`,
    `ALTER TABLE users ADD COLUMN assigned_font_name TEXT`,
    `ALTER TABLE users ADD COLUMN notebook_image_data TEXT`,
    `ALTER TABLE users ADD COLUMN notebook_width INTEGER`,
    `ALTER TABLE users ADD COLUMN notebook_height INTEGER`,
    `ALTER TABLE users ADD COLUMN margin_left INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN margin_right INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN line_ys TEXT NOT NULL DEFAULT '[]'`
  ];
  for (const sql of migrations) {
    try { await db.execute(sql); } catch (e) { /* coluna já existe — ignora */ }
  }
}
