import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT || 3000);
const CREDITS_PER_100_CHARS = Number(process.env.CREDITS_PER_100_CHARS || 1);
const CREDITS_PER_PAGE_EXPORT = Number(process.env.CREDITS_PER_PAGE_EXPORT || 5);
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const app = express();
app.use(cors());
/* limite maior que o padrão porque o admin envia fontes (.ttf/.otf/.woff)
   e imagens de modelo de caderno como base64 no corpo da requisição */
app.use(express.json({ limit: '25mb' }));
app.use(express.static(PUBLIC_DIR));

function sha256hex(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function toPublicUser(row) {
  return {
    id: row.id,
    username: row.username,
    isAdmin: !!row.is_admin,
    credits: row.credits
  };
}

function parseLineYs(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter(n => Number.isFinite(n)) : [];
  } catch (e) {
    return [];
  }
}

/* Configuração de caderno atribuída pelo admin: fonte, modelo de folha,
   margens e linhas. Enviada ao próprio usuário (para montar a página sem
   precisar escolher nada disso) e ao admin (para editar). */
function toNotebookConfig(row) {
  return {
    fontDataUrl: row.assigned_font_data || null,
    fontName: row.assigned_font_name || null,
    notebookImageDataUrl: row.notebook_image_data || null,
    notebookWidth: row.notebook_width || null,
    notebookHeight: row.notebook_height || null,
    marginLeft: row.margin_left || 0,
    marginRight: row.margin_right || 0,
    lineYs: parseLineYs(row.line_ys)
  };
}

/* =====================================================================
   AUTENTICAÇÃO
===================================================================== */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }
  const token = header.slice(7).trim();
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });
  const tokenHash = sha256hex(token);
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE session_token_hash = ?',
    args: [tokenHash]
  });
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login novamente.' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  }
  next();
}

app.post('/api/login', async (req, res) => {
  const { username, password, deviceId } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Informe usuário e senha.' });
  }
  if (!deviceId) {
    return res.status(400).json({ error: 'Dispositivo não identificado. Recarregue a página e tente novamente.' });
  }

  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE username = ?',
    args: [String(username).trim()]
  });
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });

  const passwordOk = bcrypt.compareSync(String(password), user.password_hash);
  if (!passwordOk) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });

  const deviceHash = sha256hex(deviceId);
  if (user.device_id_hash) {
    if (user.device_id_hash !== deviceHash) {
      return res.status(403).json({
        error: 'Esta conta já está em uso em outro dispositivo. Peça ao administrador para liberar o acesso no painel admin.',
        code: 'DEVICE_MISMATCH'
      });
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256hex(token);

  await db.execute({
    sql: 'UPDATE users SET device_id_hash = ?, session_token_hash = ? WHERE id = ?',
    args: [deviceHash, tokenHash, user.id]
  });

  res.json({ token, user: toPublicUser({ ...user, device_id_hash: deviceHash }) });
});

app.post('/api/logout', requireAuth, async (req, res) => {
  await db.execute({
    sql: 'UPDATE users SET session_token_hash = NULL WHERE id = ?',
    args: [req.user.id]
  });
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json(toPublicUser(req.user));
});

/* Configuração de caderno atribuída pelo admin ao usuário logado: fonte,
   modelo de folha, margens e linhas — o usuário não escolhe nada disso,
   só usa o que foi enviado (e ajusta tamanho da letra, cor e espaçamento). */
app.get('/api/me/config', requireAuth, (req, res) => {
  res.json(toNotebookConfig(req.user));
});

/* =====================================================================
   IA — geração de respostas (créditos proporcionais ao texto gerado)
===================================================================== */
const LENGTH_MAP = {
  curta: 'curta e direta (1 a 2 frases)',
  media: 'de tamanho médio (um parágrafo curto)',
  longa: 'completa e detalhada (dois ou mais parágrafos, se necessário)'
};

/* Estimativa "pessimista" de tamanho de resposta por categoria, usada
   apenas para bloquear ANTES de gastar uma chamada de IA se já é certo
   que o usuário não teria créditos nem para o caso mais curto possível.
   O débito real (depois) sempre usa o tamanho de verdade da resposta. */
const ESTIMATED_MAX_CHARS = { curta: 220, media: 650, longa: 1400 };

async function callGroq(systemPrompt, userPrompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey.includes('cole_sua_chave')) {
    throw new Error('GROQ_API_KEY não configurada no servidor (veja o .env).');
  }
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 1000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Falha na API de IA (${response.status}): ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Resposta vazia da IA.');
  return content.trim();
}

app.post('/api/ai/generate', requireAuth, async (req, res) => {
  const { question, extraInstructions } = req.body || {};
  const lengthKey = LENGTH_MAP[req.body?.lengthKey] ? req.body.lengthKey : 'media';
  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: 'Informe a pergunta.' });
  }

  const estimatedChars = ESTIMATED_MAX_CHARS[lengthKey];
  const estimatedCost = Math.max(1, Math.ceil(estimatedChars / 100) * CREDITS_PER_100_CHARS);
  if (req.user.credits < estimatedCost) {
    return res.status(402).json({
      error: `Créditos insuficientes. Uma resposta ${lengthKey} pode custar até ${estimatedCost} créditos e seu saldo é ${req.user.credits}.`,
      code: 'INSUFFICIENT_CREDITS'
    });
  }

  const extra = (extraInstructions || '').trim();
  const systemPrompt = `Você ajuda a preencher respostas em um caderno escolar. Responda de forma ${LENGTH_MAP[lengthKey]}, clara e correta, em português do Brasil. Use palavras simples e fáceis, como um aluno do 8º ano escreveria — nunca use palavras difíceis, rebuscadas ou que soem como texto gerado por IA. IMPORTANTE sobre caracteres: não use letras acentuadas nem cedilha (nada de ã, õ, ê, ç, á, é, í, ó, ú, â, ô, à, etc.) — escreva todas as palavras sem nenhum acento. Use pontuação apenas com vírgula (,), ponto (.), exclamação (!) e interrogação (?) — nunca use ponto e vírgula (;), dois pontos (:), parênteses, aspas ou travessão. Não use markdown nem introduções como "claro" ou "aqui está a resposta" — escreva apenas o texto da resposta, pronto para copiar no caderno.${extra ? ' Instrução adicional: ' + extra : ''}`;

  let answer;
  try {
    answer = await callGroq(systemPrompt, String(question).trim());
  } catch (err) {
    console.error('Erro na IA:', err.message);
    return res.status(502).json({ error: 'Falha ao gerar resposta pela IA. Tente novamente em instantes.' });
  }

  const realCost = Math.max(1, Math.ceil(answer.length / 100) * CREDITS_PER_100_CHARS);
  const newCredits = Math.max(0, req.user.credits - realCost);
  await db.execute({ sql: 'UPDATE users SET credits = ? WHERE id = ?', args: [newCredits, req.user.id] });

  res.json({ answer, creditsCharged: realCost, creditsRemaining: newCredits });
});

/* =====================================================================
   EXPORTAÇÃO — custo fixo por página gerada
===================================================================== */
app.post('/api/export/debit', requireAuth, async (req, res) => {
  const pageCount = Number(req.body?.pageCount);
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return res.status(400).json({ error: 'Número de páginas inválido.' });
  }
  const cost = pageCount * CREDITS_PER_PAGE_EXPORT;
  if (req.user.credits < cost) {
    return res.status(402).json({
      error: `Créditos insuficientes para gerar ${pageCount} página(s). Necessário ${cost}, disponível ${req.user.credits}.`,
      code: 'INSUFFICIENT_CREDITS'
    });
  }
  const newCredits = req.user.credits - cost;
  await db.execute({ sql: 'UPDATE users SET credits = ? WHERE id = ?', args: [newCredits, req.user.id] });
  res.json({ creditsCharged: cost, creditsRemaining: newCredits });
});

/* =====================================================================
   PAINEL ADMIN
===================================================================== */
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const result = await db.execute('SELECT id, username, is_admin, credits, device_id_hash FROM users ORDER BY username');
  const users = result.rows.map(u => ({
    id: u.id,
    username: u.username,
    isAdmin: !!u.is_admin,
    credits: u.credits,
    deviceBound: !!u.device_id_hash
  }));
  res.json({ users });
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, isAdmin } = req.body || {};
  const credits = Number.isInteger(req.body?.credits) ? req.body.credits : 0;
  if (!username || !String(username).trim() || !password) {
    return res.status(400).json({ error: 'Informe usuário e senha.' });
  }
  const existing = await db.execute({
    sql: 'SELECT id FROM users WHERE username = ?',
    args: [String(username).trim()]
  });
  if (existing.rows.length) {
    return res.status(409).json({ error: 'Já existe um usuário com esse nome.' });
  }
  const passwordHash = bcrypt.hashSync(String(password), 10);
  await db.execute({
    sql: 'INSERT INTO users (username, password_hash, is_admin, credits) VALUES (?, ?, ?, ?)',
    args: [String(username).trim(), passwordHash, isAdmin ? 1 : 0, Math.max(0, credits)]
  });
  res.status(201).json({ ok: true });
});

app.patch('/api/admin/users/:id/credits', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const delta = Number(req.body?.delta);
  if (!Number.isInteger(delta)) return res.status(400).json({ error: 'Valor de ajuste inválido.' });
  const result = await db.execute({ sql: 'SELECT credits FROM users WHERE id = ?', args: [id] });
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const newCredits = Math.max(0, row.credits + delta);
  await db.execute({ sql: 'UPDATE users SET credits = ? WHERE id = ?', args: [newCredits, id] });
  res.json({ credits: newCredits });
});

app.post('/api/admin/users/:id/reset-device', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await db.execute({
    sql: 'UPDATE users SET device_id_hash = NULL, session_token_hash = NULL WHERE id = ?',
    args: [id]
  });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    return res.status(400).json({ error: 'Você não pode remover sua própria conta.' });
  }
  await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [id] });
  res.json({ ok: true });
});

/* =====================================================================
   PAINEL ADMIN — configuração do caderno por usuário
   (fonte, modelo de folha, margens e linhas). O usuário comum só
   configura tamanho da letra, cor e espaçamento — o resto é definido
   aqui pelo admin, por conta.
===================================================================== */
async function getUserOr404(id, res) {
  const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
  const row = result.rows[0];
  if (!row) { res.status(404).json({ error: 'Usuário não encontrado.' }); return null; }
  return row;
}

app.get('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const row = await getUserOr404(id, res);
  if (!row) return;
  res.json({ user: toPublicUser(row), notebookConfig: toNotebookConfig(row) });
});

app.post('/api/admin/users/:id/font', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { fontDataUrl, fontName } = req.body || {};
  if (!fontDataUrl || !String(fontDataUrl).startsWith('data:')) {
    return res.status(400).json({ error: 'Envie o arquivo de fonte (.ttf, .otf, .woff, .woff2).' });
  }
  const row = await getUserOr404(id, res);
  if (!row) return;
  await db.execute({
    sql: 'UPDATE users SET assigned_font_data = ?, assigned_font_name = ? WHERE id = ?',
    args: [String(fontDataUrl), String(fontName || 'fonte-personalizada'), id]
  });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id/font', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const row = await getUserOr404(id, res);
  if (!row) return;
  await db.execute({
    sql: 'UPDATE users SET assigned_font_data = NULL, assigned_font_name = NULL WHERE id = ?',
    args: [id]
  });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/notebook', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { imageDataUrl, width, height } = req.body || {};
  if (!imageDataUrl || !String(imageDataUrl).startsWith('data:image/')) {
    return res.status(400).json({ error: 'Envie uma imagem (PNG ou JPG) para o modelo de caderno.' });
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return res.status(400).json({ error: 'Dimensões da imagem inválidas.' });
  }
  const row = await getUserOr404(id, res);
  if (!row) return;
  /* nova folha: reseta margens e linhas, já que a folha antiga pode ter
     dimensões e pautas diferentes — o admin recalibra na sequência */
  await db.execute({
    sql: `UPDATE users SET notebook_image_data = ?, notebook_width = ?, notebook_height = ?,
          margin_left = 0, margin_right = 0, line_ys = '[]' WHERE id = ?`,
    args: [String(imageDataUrl), width, height, id]
  });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id/notebook', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const row = await getUserOr404(id, res);
  if (!row) return;
  await db.execute({
    sql: `UPDATE users SET notebook_image_data = NULL, notebook_width = NULL, notebook_height = NULL,
          margin_left = 0, margin_right = 0, line_ys = '[]' WHERE id = ?`,
    args: [id]
  });
  res.json({ ok: true });
});

app.patch('/api/admin/users/:id/layout', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const marginLeft = Number(req.body?.marginLeft);
  const marginRight = Number(req.body?.marginRight);
  const lineYs = req.body?.lineYs;
  if (!Number.isFinite(marginLeft) || !Number.isFinite(marginRight)) {
    return res.status(400).json({ error: 'Margens inválidas.' });
  }
  if (!Array.isArray(lineYs) || !lineYs.every(n => Number.isFinite(n))) {
    return res.status(400).json({ error: 'Lista de linhas inválida.' });
  }
  const row = await getUserOr404(id, res);
  if (!row) return;
  await db.execute({
    sql: 'UPDATE users SET margin_left = ?, margin_right = ?, line_ys = ? WHERE id = ?',
    args: [Math.max(0, Math.round(marginLeft)), Math.max(0, Math.round(marginRight)), JSON.stringify(lineYs), id]
  });
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/', (req, res) => res.redirect('/caderno-ia.html'));

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Caderno IA backend rodando em http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Falha ao iniciar o banco de dados:', err);
    process.exit(1);
  });
