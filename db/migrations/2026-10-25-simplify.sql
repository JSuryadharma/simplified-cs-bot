-- Satu kali, untuk database yang masih memakai skema lama (contacts, messages, dst.).
-- Memindahkan nomor & nama pelanggan ke bot.orders dan bot.tickets, lalu menghapus
-- tabel dan fungsi lama, lalu memuat db/001-schema.sql. Jalankan (sudah dilakukan di Mac ini):
--   { echo "SET ROLE wa_admin;"; cat db/migrations/2026-10-25-simplify.sql db/001-schema.sql; } \
--     | docker exec -i savior-postgres psql -U savior -d savior -v ON_ERROR_STOP=1 -1

-- orders: customer_id -> customer_phone + customer_name
ALTER TABLE bot.orders ADD COLUMN IF NOT EXISTS customer_phone text;
ALTER TABLE bot.orders ADD COLUMN IF NOT EXISTS customer_name text;
UPDATE bot.orders o SET customer_phone = c.phone, customer_name = c.display_name
FROM bot.contacts c WHERE c.id = o.customer_id;
ALTER TABLE bot.orders ALTER COLUMN customer_phone SET NOT NULL;
ALTER TABLE bot.orders DROP COLUMN customer_id;

-- support_tickets -> tickets
ALTER TABLE bot.support_tickets ADD COLUMN IF NOT EXISTS customer_phone text;
ALTER TABLE bot.support_tickets ADD COLUMN IF NOT EXISTS customer_name text;
UPDATE bot.support_tickets t SET customer_phone = c.phone, customer_name = c.display_name
FROM bot.contacts c WHERE c.id = t.customer_id;
ALTER TABLE bot.support_tickets ALTER COLUMN customer_phone SET NOT NULL;
ALTER TABLE bot.support_tickets DROP COLUMN customer_id CASCADE;   -- ikut menghapus index & FK lama
ALTER TABLE bot.support_tickets DROP COLUMN ai_context;
ALTER TABLE bot.support_tickets RENAME TO tickets;

-- Fungsi lama yang memakai tabel yang dihapus
DROP FUNCTION IF EXISTS bot_api.apply_decision(uuid, text, text, text, text, numeric, jsonb);
DROP FUNCTION IF EXISTS bot_api.log_delivery(text, text, text, text, text);
DROP FUNCTION IF EXISTS bot_api.conversation_window(text, uuid, integer);
DROP FUNCTION IF EXISTS bot_api.acquire_conversation_lock(text, integer);
DROP FUNCTION IF EXISTS bot_api.release_conversation_lock(text, text);
DROP FUNCTION IF EXISTS bot_api.save_style_and_knowledge(text, jsonb, jsonb);
DROP FUNCTION IF EXISTS bot_api.import_knowledge(jsonb, text, boolean, text, jsonb);
DROP FUNCTION IF EXISTS bot_api.receive_customer(text, text, text, text, timestamptz);
DROP FUNCTION IF EXISTS bot_api.receive_owner(text, text, text, timestamptz);
DROP FUNCTION IF EXISTS bot_api.complete_owner_reply(uuid, text);
DROP FUNCTION IF EXISTS bot_api.upsert_order(text, text, text, text, jsonb, numeric, numeric, text, text, text, timestamptz);
DROP FUNCTION IF EXISTS bot_api.dashboard_tickets();
DROP FUNCTION IF EXISTS bot_api.dashboard_update_ticket_summary(uuid, text);
DROP FUNCTION IF EXISTS bot_api.dashboard_orders_range(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS bot_api.dashboard_month_orders(date);

-- Tabel yang tidak dipakai lagi
DROP TABLE bot.knowledge_items, bot.messages, bot.delivery_logs, bot.style_profile,
           bot.conversation_locks, bot.contacts;
DROP SCHEMA IF EXISTS n8n_internal;
