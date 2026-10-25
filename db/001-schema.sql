-- Skema bot Simplified CS Bot: hanya dua tabel, bot.tickets dan bot.orders.
-- Pelanggan dikenali dari nomor WhatsApp (customer_phone) yang disimpan langsung di
-- kedua tabel. Riwayat chat, gaya owner, dan knowledge tidak disimpan di sini:
-- knowledge ada di Qdrant, keputusan balas/eskalasi dibuat model AI di workflow.
-- Aman dijalankan ulang (IF NOT EXISTS / CREATE OR REPLACE).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS bot;
CREATE SCHEMA IF NOT EXISTS bot_api;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n_bot') THEN
    CREATE ROLE n8n_bot NOLOGIN;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION bot.normalize_phone(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
$$;

CREATE TABLE IF NOT EXISTS bot.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  customer_phone text NOT NULL,
  customer_name text,
  status text NOT NULL DEFAULT 'baru',
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric(16,2) NOT NULL DEFAULT 0,
  shipping_cost numeric(16,2) NOT NULL DEFAULT 0,
  total numeric(16,2) GENERATED ALWAYS AS (subtotal + shipping_cost) STORED,
  shipping_address text,
  tracking_number text,
  notes text,
  ordered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_phone_updated_idx ON bot.orders (customer_phone, updated_at DESC);

CREATE TABLE IF NOT EXISTS bot.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE DEFAULT ('TKT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  customer_phone text NOT NULL,
  customer_name text,
  status text NOT NULL DEFAULT 'waiting_owner'
    CHECK (status IN ('waiting_owner', 'owner_replied', 'resolved', 'cancelled')),
  customer_question text NOT NULL,
  needs_summary text,
  owner_question text,
  owner_answer text,
  owner_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_replied_at timestamptz,
  resolved_at timestamptz
);
-- Satu tiket aktif per pelanggan; pertanyaan baru digabung ke tiket yang sama
CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_active_per_customer
  ON bot.tickets (customer_phone) WHERE status IN ('waiting_owner', 'owner_replied');

-- ---------------------------------------------------------------------------
-- API untuk PostgREST (role n8n_bot)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION bot_api.health()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = bot, public
AS $$
  SELECT jsonb_build_object('status', 'ok', 'service', 'simplified-cs-bot-db', 'time', now())
$$;

CREATE OR REPLACE FUNCTION bot.order_json(o bot.orders)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'order_id', o.id,
    'order_number', o.order_number,
    'customer_phone', o.customer_phone,
    'customer_name', coalesce(o.customer_name, 'Pelanggan'),
    'status', o.status,
    'items', o.items,
    'subtotal', o.subtotal,
    'shipping_cost', o.shipping_cost,
    'total', o.total,
    'shipping_address', o.shipping_address,
    'tracking_number', o.tracking_number,
    'notes', o.notes,
    'ordered_at', o.ordered_at,
    'updated_at', o.updated_at
  )
$$;

-- Pesan pelanggan masuk: kembalikan konteks untuk model AI (order + tiket terbuka).
CREATE OR REPLACE FUNCTION bot_api.receive_customer(
  p_message_id text,
  p_phone text,
  p_name text,
  p_text text,
  p_timestamp timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bot, public
AS $$
DECLARE
  v_phone text := bot.normalize_phone(p_phone);
  v_ticket bot.tickets%ROWTYPE;
  v_orders jsonb;
BEGIN
  IF v_phone = '' OR coalesce(trim(p_text), '') = '' THEN
    RETURN jsonb_build_object('action', 'ignore', 'reason', 'empty_phone_or_text');
  END IF;

  SELECT * INTO v_ticket FROM bot.tickets
  WHERE customer_phone = v_phone AND status IN ('waiting_owner', 'owner_replied')
  ORDER BY created_at DESC LIMIT 1;

  SELECT coalesce(jsonb_agg(bot.order_json(o) ORDER BY o.updated_at DESC), '[]'::jsonb) INTO v_orders
  FROM (SELECT * FROM bot.orders WHERE customer_phone = v_phone ORDER BY updated_at DESC LIMIT 20) o;

  RETURN jsonb_build_object(
    'action', 'classify',
    'customer_id', v_phone,
    'customer_phone', v_phone,
    'customer_name', coalesce(nullif(trim(p_name), ''), 'Pelanggan'),
    'message_id', p_message_id,
    'message_text', trim(p_text),
    'recent_messages', '[]'::jsonb,
    'orders', v_orders,
    'open_ticket_id', v_ticket.id,
    'open_ticket_code', v_ticket.code,
    'open_ticket_question', v_ticket.customer_question,
    'open_ticket_owner_question', v_ticket.owner_question
  );
END
$$;

-- Model AI memutuskan ESCALATE: buka tiket, atau tambahkan pertanyaan ke tiket aktif.
CREATE OR REPLACE FUNCTION bot_api.open_ticket(
  p_phone text,
  p_name text,
  p_question text,
  p_summary text DEFAULT NULL,
  p_owner_question text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bot, public
AS $$
DECLARE
  v_phone text := bot.normalize_phone(p_phone);
  v_question text := coalesce(nullif(trim(p_question), ''), nullif(trim(p_summary), ''), 'Pertanyaan pelanggan');
  v_ticket bot.tickets%ROWTYPE;
  v_previous text;
BEGIN
  SELECT * INTO v_ticket FROM bot.tickets
  WHERE customer_phone = v_phone AND status IN ('waiting_owner', 'owner_replied')
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

  IF v_ticket.id IS NOT NULL THEN
    v_previous := v_ticket.customer_question;
    UPDATE bot.tickets
    SET customer_question = concat_ws(E'\n', customer_question, v_question),
        needs_summary = concat_ws(E'\n', needs_summary, nullif(trim(p_summary), '')),
        owner_question = concat_ws(E'\n', owner_question, nullif(trim(p_owner_question), '')),
        customer_name = coalesce(nullif(trim(p_name), ''), customer_name)
    WHERE id = v_ticket.id
    RETURNING * INTO v_ticket;
  ELSE
    INSERT INTO bot.tickets(customer_phone, customer_name, customer_question, needs_summary, owner_question)
    VALUES (v_phone, nullif(trim(p_name), ''), v_question, nullif(trim(p_summary), ''), nullif(trim(p_owner_question), ''))
    RETURNING * INTO v_ticket;
  END IF;

  RETURN jsonb_build_object(
    'ticket_id', v_ticket.id,
    'ticket_code', v_ticket.code,
    'customer_phone', v_ticket.customer_phone,
    'customer_name', coalesce(v_ticket.customer_name, 'Pelanggan'),
    'new_question', v_question,
    'previous_question', v_previous
  );
END
$$;

CREATE OR REPLACE FUNCTION bot.owner_orders(p_filter text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = bot, public
AS $$
  WITH picked AS (
    SELECT o.* FROM bot.orders o
    WHERE CASE
      WHEN p_filter = 'hari ini' THEN o.ordered_at >= date_trunc('day', now())
      WHEN p_filter = 'semua' THEN true
      ELSE o.customer_phone = p_filter
    END
    ORDER BY o.ordered_at DESC
    LIMIT 100
  )
  SELECT jsonb_build_object(
    'action', 'summarize_orders',
    'filter', p_filter,
    'order_count', (SELECT count(*) FROM picked),
    'grand_total', (SELECT coalesce(sum(total), 0) FROM picked),
    'orders', (SELECT coalesce(jsonb_agg(bot.order_json(p) ORDER BY p.ordered_at DESC), '[]'::jsonb) FROM picked p)
  )
$$;

-- Pesan dari owner: /pesanan ..., #TKT-XXXXXXXX jawaban, atau bantuan.
CREATE OR REPLACE FUNCTION bot_api.receive_owner(
  p_message_id text,
  p_phone text,
  p_text text,
  p_timestamp timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bot, public
AS $_$
DECLARE
  v_text text := trim(coalesce(p_text, ''));
  v_arg text;
  v_match text[];
  v_ticket bot.tickets%ROWTYPE;
BEGIN
  IF v_text ~* '^/pesanan([[:space:]]|$)' THEN
    v_arg := trim(regexp_replace(v_text, '^/pesanan[[:space:]]*', '', 'i'));
    IF v_arg = '' OR lower(v_arg) IN ('hari_ini', 'hari ini') THEN
      v_arg := 'hari ini';
    ELSIF lower(v_arg) = 'semua' THEN
      v_arg := 'semua';
    ELSE
      v_arg := bot.normalize_phone(v_arg);
    END IF;
    RETURN bot.owner_orders(v_arg);
  END IF;

  v_match := regexp_match(v_text, '^#?(TKT-[A-Za-z0-9]{8})[[:space:]]+(.+)$', 'i');
  IF v_match IS NOT NULL THEN
    SELECT * INTO v_ticket FROM bot.tickets
    WHERE upper(code) = upper(v_match[1]) AND status IN ('waiting_owner', 'owner_replied')
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

    IF v_ticket.id IS NULL THEN
      RETURN jsonb_build_object(
        'action', 'help',
        'text', 'Tiket tidak ditemukan atau sudah selesai. Cek kode tiket lalu kirim: #TKT-XXXXXXXX jawaban'
      );
    END IF;

    UPDATE bot.tickets
    SET status = 'owner_replied', owner_answer = trim(v_match[2]),
        owner_message_id = p_message_id, owner_replied_at = p_timestamp
    WHERE id = v_ticket.id
    RETURNING * INTO v_ticket;

    RETURN jsonb_build_object(
      'action', 'forward_customer',
      'ticket_id', v_ticket.id,
      'ticket_code', v_ticket.code,
      'customer_phone', v_ticket.customer_phone,
      'customer_question', v_ticket.customer_question,
      'owner_answer', v_ticket.owner_answer
    );
  END IF;

  RETURN jsonb_build_object(
    'action', 'help',
    'text', concat(
      'Perintah admin:', E'\n',
      '/pesanan — ringkasan order hari ini', E'\n',
      '/pesanan 628xxx — order pelanggan tertentu', E'\n',
      '/pesanan semua — maksimal 100 order terbaru', E'\n',
      '#TKT-XXXXXXXX jawaban — teruskan jawaban ke pelanggan'
    )
  );
END
$_$;

-- Jawaban owner sudah terkirim ke pelanggan: tutup tiket.
CREATE OR REPLACE FUNCTION bot_api.complete_owner_reply(p_ticket_id uuid, p_provider_message_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bot, public
AS $$
DECLARE
  v_ticket bot.tickets%ROWTYPE;
BEGIN
  UPDATE bot.tickets
  SET status = 'resolved', resolved_at = coalesce(resolved_at, now())
  WHERE id = p_ticket_id
  RETURNING * INTO v_ticket;

  IF v_ticket.id IS NULL THEN
    RAISE EXCEPTION 'ticket_not_found';
  END IF;

  RETURN jsonb_build_object(
    'ticket_id', v_ticket.id,
    'ticket_code', v_ticket.code,
    'customer_phone', v_ticket.customer_phone,
    'question', v_ticket.customer_question,
    'answer', coalesce(v_ticket.owner_answer, ''),
    'source', 'owner_escalation'
  );
END
$$;

CREATE OR REPLACE FUNCTION bot_api.upsert_order(
  p_order_number text,
  p_customer_phone text,
  p_customer_name text,
  p_status text,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_subtotal numeric DEFAULT 0,
  p_shipping_cost numeric DEFAULT 0,
  p_shipping_address text DEFAULT NULL,
  p_tracking_number text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_ordered_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bot, public
AS $$
DECLARE
  v_phone text := bot.normalize_phone(p_customer_phone);
  v_order bot.orders%ROWTYPE;
BEGIN
  IF trim(coalesce(p_order_number, '')) = '' OR v_phone = '' THEN
    RAISE EXCEPTION 'order_number_and_customer_phone_required';
  END IF;

  INSERT INTO bot.orders(order_number, customer_phone, customer_name, status, items, subtotal, shipping_cost,
                         shipping_address, tracking_number, notes, ordered_at, updated_at)
  VALUES (trim(p_order_number), v_phone, nullif(trim(p_customer_name), ''), coalesce(nullif(trim(p_status), ''), 'baru'),
          coalesce(p_items, '[]'::jsonb), coalesce(p_subtotal, 0), coalesce(p_shipping_cost, 0),
          p_shipping_address, p_tracking_number, p_notes, coalesce(p_ordered_at, now()), now())
  ON CONFLICT (order_number) DO UPDATE SET
    customer_phone = EXCLUDED.customer_phone,
    customer_name = coalesce(EXCLUDED.customer_name, bot.orders.customer_name),
    status = EXCLUDED.status,
    items = EXCLUDED.items,
    subtotal = EXCLUDED.subtotal,
    shipping_cost = EXCLUDED.shipping_cost,
    shipping_address = EXCLUDED.shipping_address,
    tracking_number = EXCLUDED.tracking_number,
    notes = EXCLUDED.notes,
    ordered_at = EXCLUDED.ordered_at,
    updated_at = now()
  RETURNING * INTO v_order;

  RETURN jsonb_build_object(
    'saved', true,
    'order_number', v_order.order_number,
    'customer_phone', v_order.customer_phone,
    'status', v_order.status,
    'total', v_order.total,
    'updated_at', v_order.updated_at
  );
END
$$;

-- ---------------------------------------------------------------------------
-- Dashboard tiket & order (port 4000)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION bot_api.dashboard_tickets()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = bot, public
AS $$
  SELECT coalesce(jsonb_agg(item ORDER BY created_at DESC), '[]'::jsonb)
  FROM (
    SELECT t.created_at, jsonb_build_object(
      'ticket_id', t.id,
      'code', t.code,
      'status', t.status,
      'customer_id', t.customer_phone,
      'customer_name', coalesce(t.customer_name, 'Pelanggan'),
      'customer_phone', t.customer_phone,
      'question', t.customer_question,
      'needs_summary', t.needs_summary,
      'owner_question', t.owner_question,
      'owner_answer', t.owner_answer,
      'created_at', t.created_at,
      'owner_replied_at', t.owner_replied_at,
      'resolved_at', t.resolved_at
    ) AS item
    FROM bot.tickets t
    ORDER BY t.created_at DESC
    LIMIT 200
  ) x
$$;

CREATE OR REPLACE FUNCTION bot_api.dashboard_update_ticket_summary(p_ticket_id uuid, p_summary text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bot, public
AS $$
DECLARE
  v_summary text := nullif(trim(coalesce(p_summary, '')), '');
BEGIN
  UPDATE bot.tickets SET needs_summary = v_summary WHERE id = p_ticket_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ticket_not_found';
  END IF;
  RETURN jsonb_build_object('updated', true, 'ticket_id', p_ticket_id, 'needs_summary', v_summary);
END
$$;

CREATE OR REPLACE FUNCTION bot_api.dashboard_orders_range(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = bot, public
AS $$
  SELECT coalesce(jsonb_agg(bot.order_json(o) ORDER BY o.ordered_at DESC), '[]'::jsonb)
  FROM bot.orders o
  WHERE o.ordered_at >= p_from AND o.ordered_at < p_to
$$;

-- "confirmed" = order yang statusnya sudah lewat dari 'baru'
CREATE OR REPLACE FUNCTION bot_api.dashboard_month_orders(p_month date)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = bot, public
AS $$
  WITH day_stats AS (
    SELECT d.day,
           count(o.id) AS order_count,
           coalesce(sum(o.total), 0) AS total_value,
           count(o.id) FILTER (WHERE o.status <> 'baru') AS confirmed_count
    FROM generate_series(
      date_trunc('month', p_month)::date,
      (date_trunc('month', p_month) + interval '1 month - 1 day')::date,
      interval '1 day'
    ) AS d(day)
    LEFT JOIN bot.orders o ON o.ordered_at::date = d.day::date
    GROUP BY d.day
  )
  SELECT jsonb_build_object(
    'month', p_month,
    'total_orders', coalesce(sum(order_count), 0),
    'total_value', coalesce(sum(total_value), 0),
    'confirmed_orders', coalesce(sum(confirmed_count), 0),
    'days', coalesce(jsonb_agg(jsonb_build_object(
      'date', day::date, 'orders', order_count, 'confirmed', confirmed_count, 'value', total_value
    ) ORDER BY day), '[]'::jsonb)
  )
  FROM day_stats
$$;

GRANT USAGE ON SCHEMA bot_api TO n8n_bot;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA bot_api TO n8n_bot;
ALTER DEFAULT PRIVILEGES IN SCHEMA bot_api GRANT EXECUTE ON FUNCTIONS TO n8n_bot;

NOTIFY pgrst, 'reload schema';
