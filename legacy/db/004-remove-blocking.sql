-- 004-remove-blocking.sql
-- Remove the blocking mechanism: customers can always get AI responses
-- even when a ticket is open. Tickets are still tracked for the owner.

BEGIN;

-- ====================================================================
-- 1) Modified receive_customer: always allow AI classification
--    - Still tracks tickets for owner visibility
--    - Returns action: 'classify' always (except duplicates/empty)
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

  -- Find any open ticket (for context, but don't block)
  SELECT * INTO v_ticket
  FROM bot.support_tickets
  WHERE customer_id = v_contact.id
    AND status IN ('waiting_owner', 'owner_replied')
  ORDER BY created_at DESC
  LIMIT 1;

  -- Always attach message to existing ticket if present (for tracking)
  IF v_ticket.id IS NOT NULL THEN
    UPDATE bot.messages SET ticket_id = v_ticket.id WHERE id = v_message_id;
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

  -- ALWAYS return classify action (no blocking)
  RETURN jsonb_build_object(
    'action', 'classify',
    'customer_id', v_contact.id,
    'customer_phone', v_contact.phone,
    'customer_name', coalesce(v_contact.display_name, 'Pelanggan'),
    'message_id', v_message_id,
    'message_text', trim(p_text),
    'recent_messages', v_recent,
    'orders', v_orders,
    'style_profile', v_style,
    'open_ticket_id', v_ticket.id,
    'open_ticket_code', v_ticket.code
  );
END
$function$;

-- ====================================================================
-- 2) Modified apply_decision: uncomment ticket creation
-- ====================================================================
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
 SET search_path TO 'bot', 'public'
AS $function$
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

  -- Find existing open ticket
  SELECT * INTO v_ticket
  FROM bot.support_tickets
  WHERE customer_id = v_contact.id
    AND status IN ('waiting_owner', 'owner_replied')
  ORDER BY created_at DESC
  LIMIT 1;

  -- Create new ticket if none exists
  IF v_ticket.id IS NULL THEN
    BEGIN
      INSERT INTO bot.support_tickets(
        customer_id,
        customer_question,
        needs_summary,
        owner_question,
        ai_context
      ) VALUES (
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
$function$;

COMMIT;
