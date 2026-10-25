CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS n8n_internal;
CREATE SCHEMA IF NOT EXISTS bot;
CREATE SCHEMA IF NOT EXISTS bot_api;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n_bot') THEN
    CREATE ROLE n8n_bot NOLOGIN;
  END IF;
END
$$;

GRANT n8n_bot TO CURRENT_USER;
GRANT ALL ON SCHEMA n8n_internal TO CURRENT_USER;

CREATE OR REPLACE FUNCTION bot.normalize_phone(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
$$;

CREATE TABLE IF NOT EXISTS bot.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL UNIQUE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES bot.contacts(id),
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

CREATE INDEX IF NOT EXISTS orders_customer_updated_idx
  ON bot.orders(customer_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS bot.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE DEFAULT ('TKT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  customer_id uuid NOT NULL REFERENCES bot.contacts(id),
  status text NOT NULL DEFAULT 'waiting_owner'
    CHECK (status IN ('waiting_owner', 'owner_replied', 'resolved', 'cancelled')),
  customer_question text NOT NULL,
  needs_summary text,
  owner_question text,
  owner_answer text,
  owner_message_id text,
  ai_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_replied_at timestamptz,
  resolved_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_one_active_per_customer
  ON bot.support_tickets(customer_id)
  WHERE status IN ('waiting_owner', 'owner_replied');

CREATE INDEX IF NOT EXISTS support_tickets_code_status_idx
  ON bot.support_tickets(code, status);

CREATE TABLE IF NOT EXISTS bot.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_message_id text UNIQUE,
  contact_id uuid REFERENCES bot.contacts(id),
  ticket_id uuid REFERENCES bot.support_tickets(id),
  direction text NOT NULL CHECK (direction IN (
    'customer_to_bot',
    'assistant_to_customer',
    'owner_to_bot',
    'owner_to_customer',
    'bot_to_owner',
    'internal'
  )),
  kind text NOT NULL DEFAULT 'text',
  text text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_contact_created_idx
  ON bot.messages(contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bot.delivery_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  kind text NOT NULL,
  text text NOT NULL,
  ticket_code text,
  provider_message_id text,
  delivered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot.style_profile (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  profile text NOT NULL,
  source_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bot.style_profile(id, profile)
VALUES (
  1,
  'Gunakan Bahasa Indonesia yang ramah, ringkas, natural, tidak kaku, dan tidak mengarang informasi.'
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS bot.knowledge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_hash text NOT NULL UNIQUE,
  question text NOT NULL,
  answer text NOT NULL,
  source text NOT NULL,
  ticket_id uuid REFERENCES bot.support_tickets(id),
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION bot_api.health()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = bot, public
AS $$
  SELECT jsonb_build_object(
    'status', 'ok',
    'service', 'whatsapp-admin-db',
    'time', now()
  )
$$;

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
  v_contact bot.contacts%ROWTYPE;
  v_message_id uuid;
  v_ticket bot.support_tickets%ROWTYPE;
  v_recent jsonb := '[]'::jsonb;
  v_orders jsonb := '[]'::jsonb;
  v_style text;
BEGIN
  IF v_phone = '' OR coalesce(trim(p_text), '') = '' THEN
    RETURN jsonb_build_object('action', 'ignore', 'reason', 'empty_phone_or_text');
  END IF;

  INSERT INTO bot.contacts(phone, display_name, last_seen_at)
  VALUES (v_phone, nullif(trim(p_name), ''), p_timestamp)
  ON CONFLICT (phone) DO UPDATE SET
    display_name = coalesce(nullif(EXCLUDED.display_name, ''), bot.contacts.display_name),
    last_seen_at = greatest(bot.contacts.last_seen_at, EXCLUDED.last_seen_at)
  RETURNING * INTO v_contact;

  INSERT INTO bot.messages(wa_message_id, contact_id, direction, text, created_at)
  VALUES (p_message_id, v_contact.id, 'customer_to_bot', trim(p_text), p_timestamp)
  ON CONFLICT (wa_message_id) DO NOTHING
  RETURNING id INTO v_message_id;

  IF v_message_id IS NULL THEN
    RETURN jsonb_build_object('action', 'duplicate', 'message_id', p_message_id);
  END IF;

  SELECT * INTO v_ticket
  FROM bot.support_tickets
  WHERE customer_id = v_contact.id
    AND status IN ('waiting_owner', 'owner_replied')
  ORDER BY created_at DESC
  LIMIT 1;

  SELECT coalesce(jsonb_agg(x.payload ORDER BY x.created_at), '[]'::jsonb)
  INTO v_recent
  FROM (
    SELECT m.created_at, jsonb_build_object(
      'direction', m.direction,
      'text', m.text,
      'at', m.created_at
    ) AS payload
    FROM bot.messages m
    WHERE m.contact_id = v_contact.id
    ORDER BY m.created_at DESC
    LIMIT 16
  ) x;

  SELECT coalesce(jsonb_agg(x.payload ORDER BY x.updated_at DESC), '[]'::jsonb)
  INTO v_orders
  FROM (
    SELECT o.updated_at, jsonb_build_object(
      'order_number', o.order_number,
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
    ) AS payload
    FROM bot.orders o
    WHERE o.customer_id = v_contact.id
    ORDER BY o.updated_at DESC
    LIMIT 20
  ) x;

  SELECT profile INTO v_style FROM bot.style_profile WHERE id = 1;

  IF v_ticket.id IS NOT NULL THEN
    UPDATE bot.messages SET ticket_id = v_ticket.id WHERE id = v_message_id;
    RETURN jsonb_build_object(
      'action', 'waiting_owner',
      'customer_id', v_contact.id,
      'customer_phone', v_contact.phone,
      'customer_name', v_contact.display_name,
      'ticket_id', v_ticket.id,
      'ticket_code', v_ticket.code,
      'note', 'Pesan dicatat tanpa balasan otomatis karena tiket masih menunggu owner.'
    );
  END IF;

  RETURN jsonb_build_object(
    'action', 'classify',
    'customer_id', v_contact.id,
    'customer_phone', v_contact.phone,
    'customer_name', coalesce(v_contact.display_name, 'Pelanggan'),
    'message_id', v_message_id,
    'message_text', trim(p_text),
    'recent_messages', v_recent,
    'orders', v_orders,
    'style_profile', v_style
  );
END
$$;

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
AS $$
DECLARE
  v_text text := trim(coalesce(p_text, ''));
  v_message_id uuid;
  v_arg text;
  v_match text[];
  v_ticket bot.support_tickets%ROWTYPE;
  v_orders jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_total numeric := 0;
BEGIN
  INSERT INTO bot.messages(wa_message_id, direction, text, created_at)
  VALUES (p_message_id, 'owner_to_bot', v_text, p_timestamp)
  ON CONFLICT (wa_message_id) DO NOTHING
  RETURNING id INTO v_message_id;

  IF v_message_id IS NULL THEN
    RETURN jsonb_build_object('action', 'duplicate', 'message_id', p_message_id);
  END IF;

  IF v_text ~* '^/pesanan([[:space:]]|$)' THEN
    v_arg := trim(regexp_replace(v_text, '^/pesanan[[:space:]]*', '', 'i'));

    IF v_arg = '' OR lower(v_arg) IN ('hari_ini', 'hari ini') THEN
      SELECT
        coalesce(jsonb_agg(x.payload ORDER BY x.ordered_at DESC), '[]'::jsonb),
        count(*),
        coalesce(sum(x.total), 0)
      INTO v_orders, v_count, v_total
      FROM (
        SELECT o.ordered_at, o.total, jsonb_build_object(
          'order_number', o.order_number,
          'customer_phone', c.phone,
          'customer_name', c.display_name,
          'status', o.status,
          'items', o.items,
          'total', o.total,
          'tracking_number', o.tracking_number,
          'ordered_at', o.ordered_at,
          'notes', o.notes
        ) AS payload
        FROM bot.orders o
        JOIN bot.contacts c ON c.id = o.customer_id
        WHERE o.ordered_at >= date_trunc('day', now())
        ORDER BY o.ordered_at DESC
        LIMIT 100
      ) x;
      v_arg := 'hari ini';
    ELSIF lower(v_arg) = 'semua' THEN
      SELECT
        coalesce(jsonb_agg(x.payload ORDER BY x.ordered_at DESC), '[]'::jsonb),
        count(*),
        coalesce(sum(x.total), 0)
      INTO v_orders, v_count, v_total
      FROM (
        SELECT o.ordered_at, o.total, jsonb_build_object(
          'order_number', o.order_number,
          'customer_phone', c.phone,
          'customer_name', c.display_name,
          'status', o.status,
          'items', o.items,
          'total', o.total,
          'tracking_number', o.tracking_number,
          'ordered_at', o.ordered_at,
          'notes', o.notes
        ) AS payload
        FROM bot.orders o
        JOIN bot.contacts c ON c.id = o.customer_id
        ORDER BY o.ordered_at DESC
        LIMIT 100
      ) x;
    ELSE
      v_arg := bot.normalize_phone(v_arg);
      SELECT
        coalesce(jsonb_agg(x.payload ORDER BY x.ordered_at DESC), '[]'::jsonb),
        count(*),
        coalesce(sum(x.total), 0)
      INTO v_orders, v_count, v_total
      FROM (
        SELECT o.ordered_at, o.total, jsonb_build_object(
          'order_number', o.order_number,
          'customer_phone', c.phone,
          'customer_name', c.display_name,
          'status', o.status,
          'items', o.items,
          'total', o.total,
          'tracking_number', o.tracking_number,
          'ordered_at', o.ordered_at,
          'notes', o.notes
        ) AS payload
        FROM bot.orders o
        JOIN bot.contacts c ON c.id = o.customer_id
        WHERE c.phone = v_arg
        ORDER BY o.ordered_at DESC
        LIMIT 100
      ) x;
    END IF;

    RETURN jsonb_build_object(
      'action', 'summarize_orders',
      'filter', v_arg,
      'order_count', v_count,
      'grand_total', v_total,
      'orders', v_orders
    );
  END IF;

  v_match := regexp_match(v_text, '^#?(TKT-[A-Za-z0-9]{8})[[:space:]]+(.+)$', 'i');
  IF v_match IS NOT NULL THEN
    SELECT * INTO v_ticket
    FROM bot.support_tickets
    WHERE upper(code) = upper(v_match[1])
      AND status IN ('waiting_owner', 'owner_replied')
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF v_ticket.id IS NULL THEN
      RETURN jsonb_build_object(
        'action', 'help',
        'text', 'Tiket tidak ditemukan atau sudah selesai. Cek kode tiket lalu kirim: #TKT-XXXXXXXX jawaban'
      );
    END IF;

    UPDATE bot.support_tickets
    SET status = 'owner_replied',
        owner_answer = trim(v_match[2]),
        owner_message_id = p_message_id,
        owner_replied_at = p_timestamp
    WHERE id = v_ticket.id
    RETURNING * INTO v_ticket;

    UPDATE bot.messages SET ticket_id = v_ticket.id WHERE id = v_message_id;

    RETURN jsonb_build_object(
      'action', 'forward_customer',
      'ticket_id', v_ticket.id,
      'ticket_code', v_ticket.code,
      'customer_phone', (SELECT phone FROM bot.contacts WHERE id = v_ticket.customer_id),
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
$$;

CREATE OR REPLACE FUNCTION bot_api.apply_decision(
  p_customer_id uuid,
  p_action text,
  p_reply text,
  p_summary text,
  p_owner_question text,
  p_confidence numeric DEFAULT 0,
  p_source_context jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bot, public
AS $$
DECLARE
  v_contact bot.contacts%ROWTYPE;
  v_ticket bot.support_tickets%ROWTYPE;
  v_action text := upper(coalesce(p_action, 'ESCALATE'));
BEGIN
  SELECT * INTO v_contact FROM bot.contacts WHERE id = p_customer_id;
  IF v_contact.id IS NULL THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;

  IF v_action = 'AUTO_REPLY' AND coalesce(trim(p_reply), '') <> '' THEN
    INSERT INTO bot.messages(contact_id, direction, text, metadata)
    VALUES (
      v_contact.id,
      'assistant_to_customer',
      trim(p_reply),
      jsonb_build_object('confidence', p_confidence, 'source_context', p_source_context)
    );

    RETURN jsonb_build_object(
      'action', 'auto_reply',
      'customer_phone', v_contact.phone,
      'reply', trim(p_reply)
    );
  END IF;

  SELECT * INTO v_ticket
  FROM bot.support_tickets
  WHERE customer_id = v_contact.id
    AND status IN ('waiting_owner', 'owner_replied')
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_ticket.id IS NULL THEN
    BEGIN
      INSERT INTO bot.support_tickets(
        customer_id,
        customer_question,
        needs_summary,
        owner_question,
        ai_context
      )
      VALUES (
        v_contact.id,
        coalesce(p_source_context->>'customer_message', p_summary, 'Pertanyaan pelanggan'),
        nullif(trim(p_summary), ''),
        nullif(trim(p_owner_question), ''),
        coalesce(p_source_context, '{}'::jsonb)
      )
      RETURNING * INTO v_ticket;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_ticket
      FROM bot.support_tickets
      WHERE customer_id = v_contact.id
        AND status IN ('waiting_owner', 'owner_replied')
      ORDER BY created_at DESC
      LIMIT 1;
    END;
  END IF;

  UPDATE bot.messages
  SET ticket_id = v_ticket.id
  WHERE id = (
    SELECT id FROM bot.messages
    WHERE contact_id = v_contact.id AND direction = 'customer_to_bot' AND ticket_id IS NULL
    ORDER BY created_at DESC LIMIT 1
  );

  INSERT INTO bot.messages(contact_id, ticket_id, direction, text, metadata)
  VALUES (
    v_contact.id,
    v_ticket.id,
    'bot_to_owner',
    coalesce(p_summary, ''),
    jsonb_build_object('confidence', p_confidence)
  );

  RETURN jsonb_build_object(
    'action', 'escalate',
    'ticket_id', v_ticket.id,
    'ticket_code', v_ticket.code,
    'owner_message', concat(
      '🚨 *Butuh jawaban owner*', E'\n',
      'Tiket: #', v_ticket.code, E'\n',
      'Pelanggan: ', coalesce(v_contact.display_name, 'Pelanggan'), ' (', v_contact.phone, ')', E'\n\n',
      '*Pesan asli:*', E'\n', v_ticket.customer_question, E'\n\n',
      '*Ringkasan kebutuhan:*', E'\n', coalesce(v_ticket.needs_summary, '-'), E'\n\n',
      '*Yang perlu dijawab:*', E'\n', coalesce(v_ticket.owner_question, '-'), E'\n\n',
      'Balas dengan format:', E'\n', '#', v_ticket.code, ' <jawaban untuk pelanggan>'
    )
  );
END
$$;

CREATE OR REPLACE FUNCTION bot_api.complete_owner_reply(
  p_ticket_id uuid,
  p_provider_message_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bot, public
AS $$
DECLARE
  v_ticket bot.support_tickets%ROWTYPE;
  v_contact bot.contacts%ROWTYPE;
  v_hash text;
BEGIN
  SELECT * INTO v_ticket
  FROM bot.support_tickets
  WHERE id = p_ticket_id
  FOR UPDATE;

  IF v_ticket.id IS NULL THEN
    RAISE EXCEPTION 'ticket_not_found';
  END IF;

  SELECT * INTO v_contact FROM bot.contacts WHERE id = v_ticket.customer_id;

  IF v_ticket.status <> 'resolved' THEN
    UPDATE bot.support_tickets
    SET status = 'resolved', resolved_at = now()
    WHERE id = v_ticket.id;

    INSERT INTO bot.messages(
      wa_message_id,
      contact_id,
      ticket_id,
      direction,
      text,
      metadata
    )
    VALUES (
      p_provider_message_id,
      v_contact.id,
      v_ticket.id,
      'owner_to_customer',
      coalesce(v_ticket.owner_answer, ''),
      jsonb_build_object('forwarded_verbatim', true)
    )
    ON CONFLICT (wa_message_id) DO NOTHING;
  END IF;

  v_hash := encode(digest(lower(trim(v_ticket.customer_question)) || E'\n' || lower(trim(coalesce(v_ticket.owner_answer, ''))), 'sha256'), 'hex');
  INSERT INTO bot.knowledge_items(content_hash, question, answer, source, ticket_id, tags)
  VALUES (
    v_hash,
    v_ticket.customer_question,
    coalesce(v_ticket.owner_answer, ''),
    'owner_escalation',
    v_ticket.id,
    jsonb_build_array('jawaban-owner', v_ticket.code)
  )
  ON CONFLICT (content_hash) DO UPDATE SET updated_at = now();

  RETURN jsonb_build_object(
    'ticket_id', v_ticket.id,
    'ticket_code', v_ticket.code,
    'customer_phone', v_contact.phone,
    'question', v_ticket.customer_question,
    'answer', coalesce(v_ticket.owner_answer, ''),
    'source', 'owner_escalation'
  );
END
$$;

CREATE OR REPLACE FUNCTION bot_api.log_delivery(
  p_phone text,
  p_text text,
  p_kind text,
  p_ticket_code text DEFAULT NULL,
  p_provider_message_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bot, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO bot.delivery_logs(phone, text, kind, ticket_code, provider_message_id)
  VALUES (bot.normalize_phone(p_phone), coalesce(p_text, ''), p_kind, p_ticket_code, p_provider_message_id)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('logged', true, 'delivery_id', v_id);
END
$$;

CREATE OR REPLACE FUNCTION bot_api.save_style_and_knowledge(
  p_style_profile text,
  p_pairs jsonb,
  p_source_stats jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bot, public
AS $$
DECLARE
  v_pair jsonb;
  v_hash text;
  v_saved integer := 0;
BEGIN
  INSERT INTO bot.style_profile(id, profile, source_stats, updated_at)
  VALUES (1, coalesce(nullif(trim(p_style_profile), ''), 'Ramah, ringkas, dan natural.'), coalesce(p_source_stats, '{}'::jsonb), now())
  ON CONFLICT (id) DO UPDATE SET
    profile = EXCLUDED.profile,
    source_stats = EXCLUDED.source_stats,
    updated_at = now();

  FOR v_pair IN SELECT value FROM jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb))
  LOOP
    IF coalesce(trim(v_pair->>'question'), '') = '' OR coalesce(trim(v_pair->>'answer'), '') = '' THEN
      CONTINUE;
    END IF;
    v_hash := encode(digest(lower(trim(v_pair->>'question')) || E'\n' || lower(trim(v_pair->>'answer')), 'sha256'), 'hex');
    INSERT INTO bot.knowledge_items(content_hash, question, answer, source, tags)
    VALUES (
      v_hash,
      trim(v_pair->>'question'),
      trim(v_pair->>'answer'),
      'whatsapp_chat_export',
      coalesce(v_pair->'tags', '[]'::jsonb)
    )
    ON CONFLICT (content_hash) DO UPDATE SET
      answer = EXCLUDED.answer,
      tags = EXCLUDED.tags,
      updated_at = now();
    v_saved := v_saved + 1;
  END LOOP;

  RETURN jsonb_build_object('saved', true, 'knowledge_count', v_saved);
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
  v_contact bot.contacts%ROWTYPE;
  v_order bot.orders%ROWTYPE;
  v_phone text := bot.normalize_phone(p_customer_phone);
BEGIN
  IF trim(coalesce(p_order_number, '')) = '' OR v_phone = '' THEN
    RAISE EXCEPTION 'order_number_and_customer_phone_required';
  END IF;

  INSERT INTO bot.contacts(phone, display_name, last_seen_at)
  VALUES (v_phone, nullif(trim(p_customer_name), ''), now())
  ON CONFLICT (phone) DO UPDATE SET
    display_name = coalesce(nullif(EXCLUDED.display_name, ''), bot.contacts.display_name),
    last_seen_at = now()
  RETURNING * INTO v_contact;

  INSERT INTO bot.orders(
    order_number, customer_id, status, items, subtotal, shipping_cost,
    shipping_address, tracking_number, notes, ordered_at, updated_at
  )
  VALUES (
    trim(p_order_number), v_contact.id, coalesce(nullif(trim(p_status), ''), 'baru'),
    coalesce(p_items, '[]'::jsonb), coalesce(p_subtotal, 0), coalesce(p_shipping_cost, 0),
    p_shipping_address, p_tracking_number, p_notes, coalesce(p_ordered_at, now()), now()
  )
  ON CONFLICT (order_number) DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
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
    'customer_phone', v_contact.phone,
    'status', v_order.status,
    'total', v_order.total,
    'updated_at', v_order.updated_at
  );
END
$$;

REVOKE ALL ON SCHEMA bot FROM PUBLIC;
REVOKE ALL ON SCHEMA bot_api FROM PUBLIC;
GRANT USAGE ON SCHEMA bot_api TO n8n_bot;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA bot_api TO n8n_bot;
ALTER DEFAULT PRIVILEGES IN SCHEMA bot_api GRANT EXECUTE ON FUNCTIONS TO n8n_bot;
