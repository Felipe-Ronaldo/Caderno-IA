/* Cria (ou atualiza a senha/créditos d)o usuário administrador inicial,
   usando os valores definidos no arquivo .env:
   ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_CREDITS.

   Rode uma vez, depois de configurar o .env:
     npm run seed:admin
*/
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { db, initDb } from './db.js';

async function main() {
  await initDb();

  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const credits = Number.isFinite(Number(process.env.ADMIN_CREDITS))
    ? Number(process.env.ADMIN_CREDITS)
    : 999999;

  if (!username || !password) {
    console.error('Defina ADMIN_USERNAME e ADMIN_PASSWORD no arquivo .env antes de rodar o seed.');
    process.exit(1);
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const existing = await db.execute({
    sql: 'SELECT id FROM users WHERE username = ?',
    args: [username]
  });

  if (existing.rows.length) {
    const id = existing.rows[0].id;
    await db.execute({
      sql: 'UPDATE users SET password_hash = ?, is_admin = 1, credits = ? WHERE id = ?',
      args: [passwordHash, credits, id]
    });
    console.log(`Administrador "${username}" atualizado (senha redefinida, créditos = ${credits}).`);
  } else {
    await db.execute({
      sql: 'INSERT INTO users (username, password_hash, is_admin, credits) VALUES (?, ?, 1, ?)',
      args: [username, passwordHash, credits]
    });
    console.log(`Administrador "${username}" criado com ${credits} créditos.`);
  }

  console.log('Pronto. Você já pode fazer login em /caderno-ia.html com esse usuário.');
  process.exit(0);
}

main().catch(err => {
  console.error('Erro ao rodar o seed:', err);
  process.exit(1);
});
