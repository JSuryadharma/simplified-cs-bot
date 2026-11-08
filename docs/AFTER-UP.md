# Simplified CS Bot: step by step from `docker compose up` to a working bot

Simplified CS Bot is the support app for SaViOr. SaViOr (web + Postgres) runs from its own
compose, and the bot keeps its two tables (`bot.tickets`, `bot.orders`) in SaViOr's database.
All AI (chat and embeddings) goes through OpenRouter; nothing runs locally. Steps marked
**(first time)** are only for a fresh machine; on the current Mac they are already done.

## 0. Before `make up`

1. Start SaViOr, which provides the database:

   ```bash
   cd ~/Documents/GitHub/savior-app && docker compose up -d
   ```

   Check: http://localhost:3500 opens the SaViOr login page.
2. **(first time)** `cp .env.example .env` and fill in every `ganti_...` value, plus
   `OWNER_PHONE` and `OPENROUTER_API_KEY`. WhatsApp tokens are not in `.env`: enter them
   in n8n (credential `WhatsApp account`). Add `NGROK_AUTHTOKEN`/`NGROK_DOMAIN` only if
   you use the ngrok tunnel. Keep
   `N8N_ENCRYPTION_KEY` the same as the old machine if you copy `n8n_data/`.
3. Make sure `OPENROUTER_API_KEY` is valid and has credit. Defaults: chat
   `nvidia/nemotron-3-super-120b-a12b`, embeddings `openai/text-embedding-3-small`.
4. **(first time)** Create the bot tables (`bot.tickets`, `bot.orders`) in the SaViOr database:

   ```bash
   cd ~/Documents/N8N && make db-init
   ```

## 1. Start the stack

```bash
cd ~/Documents/N8N && make up
make ps          # every simplified-cs-bot-* service should say "healthy"
make doctor      # n8n, Qdrant, mock WhatsApp and the OpenRouter key
```

Quick checks:

| Check | Expected |
|---|---|
| http://localhost:5678 | n8n login page |
| http://localhost:4000 | ticket & order dashboard |
| `curl localhost:3002/rpc/dashboard_tickets -X POST -H 'content-type: application/json' -d '{}'` | JSON list of tickets |
| http://localhost:6333/dashboard | Qdrant UI with collection `wa_knowledge_openrouter` |
| http://localhost:4040 | ngrok inspector (only with `COMPOSE_PROFILES=tunnel`) |

## 2. n8n setup (first time)

1. Open http://localhost:5678 and create the owner account. If you copied `n8n_data/`,
   just log in; the workflow and credential come along and you can skip to step 4.
2. Import the workflow **only on an empty n8n**: `make import`. On the current Mac,
   never run it, since it overwrites the live workflow `WaAdm1nLengkap26`.
3. Open **Credentials** and create `WhatsApp account` (WhatsApp Business Cloud): Meta access
   token + WhatsApp Business Account ID. See `docs/SETUP-META.md`. This is the only
   credential; OpenRouter is read from `.env`.
4. Open the workflow **WA Admin - Sistem Lengkap** and make sure it is published/active.
5. If Qdrant has no `wa_knowledge_openrouter` collection yet, run the manual part
   **00 — Inisialisasi Qdrant** once from the canvas.

## 3. Load knowledge (first time)

Knowledge lives only in Qdrant:

```bash
node scripts/import-knowledge.mjs --dataset knowledge/dataset/savior-knowledge.json
```

More knowledge later: upload chat exports or images through the dashboard's Knowledge tab
or the n8n form `/form/admin-upload-knowledge`. Every owner answer to a ticket is also
added to Qdrant automatically.

## 4. Connect WhatsApp (first time, or when the domain changes)

1. Public URL: either the `tunnel` service (`COMPOSE_PROFILES=tunnel`, stop ngrok on the host
   first) or your own HTTPS domain. `WEBHOOK_URL` in `.env` must be that URL.
2. In Meta for Developers → WhatsApp → Configuration:
   - Callback URL: `https://<your-domain>/webhook/whatsapp`
   - Verify token: the token you chose for the webhook in n8n
   - Subscribe to the `messages` field.

## 5. Test end to end

1. Send a question that is in the knowledge from a test customer number to the business
   number. The AI answers directly; nothing is written to the database.
2. Send a question that is not in the knowledge. The AI escalates: a row appears in
   `bot.tickets`, the owner gets a `#TKT-XXXXXXXX` code, and the ticket shows up at
   http://localhost:4000.
3. Answer from the dashboard. The customer receives exactly that answer and the ticket
   becomes resolved. Owner commands sent over WhatsApp (`#TKT-…`, `/pesanan`) are ignored.
4. In the dashboard's Order tab, *Ringkasan order oleh AI* summarises orders from
   `bot.orders` (this replaces the old WhatsApp `/pesanan` command).

The bot does not store chat history, so each message is answered on its own (with the
customer's orders and open ticket as context).

Without Meta, use the mock gateway: `node scripts/simulate-inbound.mjs customer 628111111111 "..."`
and read the replies with `curl http://localhost:8080/messages`.

## 6. Day to day

- `make logs`: follow the logs of every service.
- `make backup`: back up the SaViOr database (including the bot tables), Qdrant and `n8n_data`.
- `make db-migrate FILE=...sql`: apply a new bot SQL file; the full schema is `db/001-schema.sql`.
- Open tickets waiting for the owner:

  ```bash
  docker exec savior-postgres psql -U savior -d savior -c \
    "select code, created_at, customer_question from bot.tickets where status='waiting_owner';"
  ```

- After a reboot: start SaViOr's compose first, then `make up`.
- n8n crashes with `EACCES: permission denied, open '/home/node/.n8n/config'` (Linux,
  when Docker created `n8n_data/` as root): `make fix-perms`, then `make up`.

## 7. Reverse proxy (nginx) and public URLs

Every service's host port, bind address and public URL comes from `.env`; the defaults
keep the local setup above (n8n 5678, dashboard 4000, PostgREST 3002, Qdrant 6333,
mock WhatsApp 8080, ngrok inspector 4040). A full nginx example with subpaths is in
[`docs/nginx.example.conf`](nginx.example.conf).

| Service | Port / bind | Public URL / subpath |
|---|---|---|
| n8n | `N8N_PORT`, `N8N_BIND` | `N8N_HOST`, `N8N_PROTOCOL`, `N8N_PATH`, `WEBHOOK_URL`, `N8N_EDITOR_BASE_URL`, `N8N_PROXY_HOPS`, `N8N_SECURE_COOKIE` |
| wa-dashboard | `DASHBOARD_PORT`, `DASHBOARD_BIND` | `DASHBOARD_BASE_PATH` |
| PostgREST | `DB_API_PORT`, `DB_API_BIND` | `DB_API_PUBLIC_URL` (OpenAPI only) |
| Qdrant | `QDRANT_PORT`, `QDRANT_BIND` | none |
| mock WhatsApp | `MOCK_WHATSAPP_PORT`, `MOCK_WHATSAPP_BIND` | none |
| ngrok inspector | `NGROK_INSPECTOR_PORT` | none |

Containers keep talking to each other over the compose network (`http://n8n:5678`,
`http://db-api:3000`, ...), so changing a public URL or host port never breaks the bot's
internal calls.

Hosting n8n under a subpath, for example `https://bot.example.com/n8n/`:

```dotenv
N8N_HOST=bot.example.com
N8N_PROTOCOL=https
N8N_PATH=/n8n/
WEBHOOK_URL=https://bot.example.com/n8n/
N8N_EDITOR_BASE_URL=https://bot.example.com/n8n/
N8N_PROXY_HOPS=1
N8N_SECURE_COOKIE=true
N8N_BIND=127.0.0.1
COMPOSE_PROFILES=
```

- n8n always serves from `/` on port 5678; `N8N_PATH` only changes the URLs it generates.
  nginx must strip the prefix: `location /n8n/ { proxy_pass http://127.0.0.1:5678/; }`
  (both end in `/`). Without the trailing slash the editor loads blank and webhooks 404.
- Meta's callback URL becomes `https://bot.example.com/n8n/webhook/whatsapp`; update it in
  Meta for Developers after switching.
- Set `N8N_PUBLIC_URL` too if you run the host scripts (`simulate-inbound`, `upsert-order`)
  against the proxied URL.

Hosting the dashboard under a subpath: set `DASHBOARD_BASE_PATH=/wa-dashboard/` and proxy
`location /wa-dashboard/` to `http://127.0.0.1:4000/`. The dashboard accepts the prefix
stripped or kept. It has no login of its own, so put basic auth or an IP allowlist on it
in nginx. Never proxy PostgREST or Qdrant to the internet: neither has authentication.

Apply changes with `make up` (recreates n8n and the dashboard, which pauses the bot for
a moment).
