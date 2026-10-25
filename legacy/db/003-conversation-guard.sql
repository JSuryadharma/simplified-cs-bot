-- 003-conversation-guard.sql
-- 1) Persist customer messages + build riwayat_terbaru di receive_customer
-- 2) Kunci percakapan (hanya satu AI decision in-flight per chat)
-- 3) Jendela debounce untuk menggabungkan pesan beruntun

BEGIN;

-- ====================================================================
-- 1) receive_customer: simpan pesan pelanggan, deteksi duplikat,
--    dan kembalikan riwayat_terbaru (pesan pelanggan + balasan bot)
-- ====================================================================
CREATE OR REPLACE FUNCTION bot_api.receive_customer(
  p_message_id text,
  p_phone text,
  p_name text,
  p_text text,
  p_timestamp timestamp with time zone DEFAULT now()
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'bot', 'public'
AS $function$
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

  -- Simpan pesan pelanggan ke riwayat (dedupe berdasar wa_message_id)
  INSERT INTO bot.messages(wa_message_id, contact_id, direction, text, created_at)
  VALUES (p_message_id, v_contact.id, 'customer_to_bot', trim(p_text), p_timestamp)
  ON CONFLICT (wa_message_id) DO NOTHING
  RETURNING id INTO v_message_id;

  IF v_message_id IS NULL THEN
    RETURN jsonb_build_object('action', 'duplicate', 'message_id', p_message_id);
  END IF;

  -- Pesan pada percakapan yang masih menunggu owner: catat tanpa AI
  SELECT * INTO v_ticket
  FROM bot.support_tickets
  WHERE customer_id = v_contact.id
    AND status IN ('waiting_owner', 'owner_replied')
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_ticket.id IS NOT NULL THEN
    UPDATE bot.messages SET ticket_id = v_ticket.id WHERE id = v_message_id;
    RETURN jsonb_build_object(
      'action', 'waiting_owner',
      'customer_id', v_contact.id,
      'customer_phone', v_contact.phone,
      'customer_name', coalesce(v_contact.display_name, 'Pelanggan'),
      'ticket_id', v_ticket.id,
      'ticket_code', v_ticket.code,
      'note', 'Pesan dicatat tanpa balasan otomatis karena tiket masih menunggu owner.'
    );
  END IF;

  -- Riwayat 16 pesan terakhir (pelanggan + bot), kronologis, berlabel pengirim
  SELECT coalesce(jsonb_agg(x.payload ORDER BY x.created_at), '[]'::jsonb)
  INTO v_recent
  FROM (
    SELECT m.created_at,
           jsonb_build_object(
             'sender', CASE WHEN m.direction = 'customer_to_bot' THEN 'customer' ELSE 'bot' END,
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
    SELECT o.updated_at,
           jsonb_build_object(
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
$function$;

-- ====================================================================
-- 2) Kunci percakapan: maksimal satu run in-flight per chat
-- ====================================================================
CREATE TABLE IF NOT EXISTS bot.conversation_locks (
  chat_id     text        PRIMARY KEY,
  run_id      uuid        NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION bot_api.acquire_conversation_lock(
  p_chat_id text,
  p_ttl_seconds integer DEFAULT 45
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'bot', 'public'
AS $function$
DECLARE
  v_run uuid := gen_random_uuid();
  v_expires timestamptz;
BEGIN
  DELETE FROM bot.conversation_locks
  WHERE chat_id = p_chat_id AND expires_at < now();

  v_expires := now() + make_interval(secs => p_ttl_seconds);
  INSERT INTO bot.conversation_locks(chat_id, run_id, expires_at)
  VALUES (p_chat_id, v_run, v_expires)
  ON CONFLICT (chat_id) DO NOTHING
  RETURNING run_id INTO v_run;

  IF v_run IS NULL THEN
    RETURN jsonb_build_object('acquired', false, 'chat_id', p_chat_id);
  END IF;

  RETURN jsonb_build_object(
    'acquired', true,
    'chat_id', p_chat_id,
    'run_id', v_run,
    'expires_at', v_expires
  );
END
$function$;

CREATE OR REPLACE FUNCTION bot_api.release_conversation_lock(
  p_chat_id text,
  p_run_id text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'bot', 'public'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM bot.conversation_locks
  WHERE chat_id = p_chat_id
    AND (p_run_id IS NULL OR run_id::text = p_run_id);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('released', v_deleted > 0, 'chat_id', p_chat_id);
END
$function$;

-- ====================================================================
-- 3) Jendela debounce: pesan-pesan yang datang setelah p_since_message_id
-- ====================================================================
CREATE OR REPLACE FUNCTION bot_api.conversation_window(
  p_chat_id text,
  p_since_message_id uuid,
  p_max_messages integer DEFAULT 20
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'bot', 'public'
AS $function$
DECLARE
  v_contact_id uuid;
  v_since timestamp with time zone;
  v_own_text text;
  v_items jsonb := '[]'::jsonb;
  v_count integer;
  v_combined text;
BEGIN
  SELECT id INTO v_contact_id FROM bot.contacts WHERE phone = bot.normalize_phone(p_chat_id);
  IF v_contact_id IS NULL THEN
    RETURN jsonb_build_object('newer_count', 0, 'messages', '[]'::jsonb, 'combined_text', '');
  END IF;

  SELECT created_at, text INTO v_since, v_own_text
  FROM bot.messages WHERE id = p_since_message_id;

  IF v_since IS NULL THEN
    RETURN jsonb_build_object('newer_count', 0, 'messages', '[]'::jsonb, 'combined_text', coalesce(v_own_text, ''));
  END IF;

  SELECT coalesce(jsonb_agg(x.payload ORDER BY x.created_at), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT m.created_at,
           jsonb_build_object(
             'message_id', m.id,
             'text', m.text,
             'sender', CASE WHEN m.direction = 'customer_to_bot' THEN 'customer' ELSE 'bot' END
           ) AS payload
    FROM bot.messages m
    WHERE m.contact_id = v_contact_id
      AND m.direction = 'customer_to_bot'
      AND (m.created_at > v_since OR (m.created_at = v_since AND m.id <> p_since_message_id))
    ORDER BY m.created_at
    LIMIT p_max_messages
  ) x;

  v_count := jsonb_array_length(v_items);

  -- Gabungkan pesan sendiri + pesan baru menjadi satu pesan_pelanggan
  SELECT trim(concat_ws(' | ', v_own_text, string_agg(e.elem ->> 'text', ' | ' ORDER BY e.ord)))
  INTO v_combined
  FROM (
    SELECT elem, row_number() OVER () AS ord
    FROM jsonb_array_elements(v_items) AS elem
  ) e;

  RETURN jsonb_build_object(
    'newer_count', v_count,
    'messages', v_items,
    'combined_text', coalesce(v_combined, v_own_text)
  );
END
$function$;

GRANT EXECUTE ON FUNCTION bot_api.receive_customer(text, text, text, text, timestamp with time zone) TO n8n_bot;
GRANT EXECUTE ON FUNCTION bot_api.acquire_conversation_lock(text, integer) TO n8n_bot;
GRANT EXECUTE ON FUNCTION bot_api.release_conversation_lock(text, text) TO n8n_bot;
GRANT EXECUTE ON FUNCTION bot_api.conversation_window(text, uuid, integer) TO n8n_bot;

COMMIT;
