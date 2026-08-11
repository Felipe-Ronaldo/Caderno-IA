# Caderno IA — backend (auth + créditos)

Backend simples em **Node.js + Express + SQLite (via libSQL)** que adiciona:

- login por usuário/senha (sem cadastro aberto — só o admin cria contas);
- vínculo de cada conta a **um único dispositivo**, pra evitar compartilhamento;
- sistema de **créditos**: debita ao gerar resposta com IA (proporcional ao
  tamanho do texto) e ao exportar páginas do caderno (custo fixo por página);
- **painel admin** (`/admin.html`) pra criar usuários, ajustar créditos,
  liberar um dispositivo vinculado ou remover um acesso;
- proxy para a **API de IA**, com a chave guardada só no servidor — o
  navegador do usuário nunca vê a chave.

O front-end (`caderno-ia.html` e `admin.html`, na pasta `../public`) é servido
pelo próprio Express, então tudo roda como um único serviço.

---

## 1. Qual API de IA gratuita usar

Recomendo **[Groq](https://console.groq.com)**: é gratuita, não pede cartão,
tem um limite diário de requisições bem alto (dezenas de milhares de
tokens/minuto, milhares de requisições/dia dependendo do modelo — confira os
números atuais no [console da Groq](https://console.groq.com/settings/limits),
eles mudam de tempos em tempos) e responde muito rápido. A API é compatível
com o formato da OpenAI, então a integração é simples (é o que já está
implementado em `server.js`).

Alternativas, caso prefira:
- **Google Gemini** (plano gratuito no Google AI Studio) — ótimo em
  português, também generoso, mas formato de API diferente (exigiria trocar
  a função `callGroq` em `server.js`).
- **OpenRouter** com modelos gratuitos — agrega vários modelos, mas os
  limites dos modelos gratuitos costumam ser mais apertados que os da Groq.

Para usar a Groq:
1. Crie uma conta grátis em https://console.groq.com
2. Gere uma chave em **API Keys**
3. Cole a chave em `GROQ_API_KEY` no seu `.env`

---

## 2. Rodando localmente

```bash
cd backend
cp .env.example .env
# edite o .env: GROQ_API_KEY, ADMIN_USERNAME, ADMIN_PASSWORD, etc.

npm install
npm run seed:admin   # cria o usuário admin definido no .env
npm start            # sobe o servidor em http://localhost:3000
```

Abra `http://localhost:3000` — vai redirecionar para o Caderno IA. Faça
login com o admin criado no seed, e crie os demais usuários pelo painel em
`http://localhost:3000/admin.html`.

Rodando local, o banco fica em `backend/data.db` (arquivo SQLite comum).

---

## 3. Colocando no ar de graça (hospedagem)

O jeito mais simples e gratuito para um grupo pequeno (<50 pessoas):

### Passo A — banco de dados persistente: Turso (grátis)

A maioria das hospedagens gratuitas (Render free, por exemplo) **apaga o
disco a cada deploy/reinício**, o que faria o `data.db` local perder todos os
créditos e usuários cadastrados. Para evitar isso sem sair do "modo SQLite"
(mantendo o código idêntico), use o **Turso** — um SQLite hospedado, com
plano gratuito persistente:

1. Crie uma conta em https://turso.tech
2. Crie um banco (`turso db create caderno-ia`)
3. Pegue a URL (`turso db show caderno-ia --url`) e um token
   (`turso db tokens create caderno-ia`)
4. No `.env` de produção, preencha:
   ```
   DATABASE_URL=libsql://caderno-ia-SEU-USUARIO.turso.io
   DATABASE_AUTH_TOKEN=o_token_gerado
   ```

Nenhuma linha de código muda — o `db.js` já usa essas variáveis.

### Passo B — hospedar o servidor: Render (grátis)

1. Suba a pasta `backend/` (com o `public/` do lado, um nível acima) para um
   repositório no GitHub.
2. Em https://render.com, crie um **Web Service** novo apontando pro repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Em **Environment**, cole as mesmas variáveis do `.env` (a
   `GROQ_API_KEY`, `DATABASE_URL`/`DATABASE_AUTH_TOKEN` do Turso,
   `CREDITS_PER_100_CHARS`, `CREDITS_PER_PAGE_EXPORT`).
5. Depois do primeiro deploy, rode o seed do admin uma vez (Render tem um
   "Shell" no painel do serviço): `npm run seed:admin`.

Pronto: `https://SEU-SERVICO.onrender.com` serve o Caderno IA + o painel
admin, com banco persistente e chave de IA protegida no servidor.

> Alternativas ao Render: Railway, Fly.io ou qualquer VPS simples também
> funcionam — o único cuidado é sempre o mesmo: se o sistema de arquivos não
> for persistente, use o Turso (ou um Postgres gerenciado) em vez do arquivo
> SQLite local.

---

## 4. Como funciona o vínculo de dispositivo

No primeiro login de cada usuário, o navegador gera um identificador
aleatório (guardado no `localStorage`) e o servidor grava um hash dele.
Nos logins seguintes, se o identificador não bater (outro navegador/aparelho
tentando entrar), o acesso é recusado com uma mensagem clara. Se o usuário
trocar de aparelho legitimamente, o **admin** clica em "Liberar" ao lado do
nome dele no painel — isso libera o próximo login para vincular o novo
dispositivo.

Isso não é uma trava perfeita contra compartilhamento deliberado (dá pra
limpar o `localStorage`), mas evita o caso comum de várias pessoas usando o
mesmo login ao mesmo tempo em aparelhos diferentes.

---

## 5. Ajustando as regras de crédito

No `.env`:

- `CREDITS_PER_100_CHARS` — quantos créditos custam cada 100 caracteres de
  resposta gerada pela IA (mínimo cobrado: 1 crédito por resposta).
- `CREDITS_PER_PAGE_EXPORT` — quantos créditos custa cada página exportada
  do caderno (cobrado uma vez, na hora de "Gerar páginas do caderno").

O saldo de cada usuário é ajustado manualmente pelo admin no painel
(`+` para adicionar, `-` para descontar).

---

## 6. Endpoints da API

| Método | Rota | Quem acessa | O que faz |
|---|---|---|---|
| POST | `/api/login` | público | login (usuário+senha+deviceId) |
| POST | `/api/logout` | logado | encerra a sessão |
| GET | `/api/me` | logado | dados do usuário logado |
| POST | `/api/ai/generate` | logado | gera resposta com IA e debita créditos |
| POST | `/api/export/debit` | logado | debita créditos pela exportação de N páginas |
| GET | `/api/admin/users` | admin | lista usuários e saldos |
| POST | `/api/admin/users` | admin | cria usuário |
| PATCH | `/api/admin/users/:id/credits` | admin | ajusta créditos (`{ delta }`) |
| POST | `/api/admin/users/:id/reset-device` | admin | libera o dispositivo vinculado |
| DELETE | `/api/admin/users/:id` | admin | remove um usuário |
