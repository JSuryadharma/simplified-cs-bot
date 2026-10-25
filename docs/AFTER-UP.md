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
   `OWNER_PHONE`, `OPENROUTER_API_KEY`, `NGROK_AUTHTOKEN` and `NGROK_DOMAIN`. Keep
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
   - Verify token: the value of `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to the `messages` field.

## 5. Test end to end

1. Send a question that is in the knowledge from a test customer number to the business
   number. The AI answers directly; nothing is written to the database.
2. Send a question that is not in the knowledge. The AI escalates: a row appears in
   `bot.tickets`, the owner gets a `#TKT-XXXXXXXX` code, and the ticket shows up at
   http://localhost:4000.
3. Answer from the dashboard, or from the owner's WhatsApp with `#TKT-XXXXXXXX answer`.
   The customer receives exactly that answer and the ticket becomes resolved.
4. From the owner's WhatsApp, `/pesanan` lists today's orders from `bot.orders`.

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
