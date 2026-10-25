-- Dashboard admin untuk bot WhatsApp.
-- Menyediakan RPC read/write untuk:
--   1. Follow-up tiket (daftar tiket + simpan ringkasan pertanyaan pelanggan).
--   2. Ringkasan order per rentang tanggal (termasuk perbandingan tanggal sebelumnya).
--   3. Ringkasan bulanan order dengan konfirmasi pelanggan per tanggal.

CREATE OR REPLACE FUNCTION bot_api.dashboard_tickets()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = bot, public
AS $$
  WITH tickets AS (
    SELECT jsonb_build_object(
      'ticket_id', t.id,
      'code', t.code,
      'status', t.status,
      'customer_id', c.id,
      'customer_name', coalesce(c.display_name, 'Pelanggan'),
      'customer_phone', c.phone,
      'question', t.customer_question,
      'needs_summary', t.needs_summary,
      'owner_question', t.owner_question,
      'owner_answer', t.owner_answer,
      'created_at', t.created_at,
      'owner_replied_at', t.owner_replied_at,
      'resolved_at', t.resolved_at
    ) AS item
    FROM bot.support_tickets t
    JOIN bot.contacts c ON c.id = t.customer_id
    ORDER BY t.created_at DESC
    LIMIT 200
  )
  SELECT coalesce(jsonb_agg(item), '[]'::jsonb) FROM tickets;
$$;

CREATE OR REPLACE FUNCTION bot_api.dashboard_update_ticket_summary(
  p_ticket_id uuid,
  p_summary text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bot, public
AS $$
DECLARE
  v_summary text := nullif(trim(coalesce(p_summary, '')), '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bot.support_tickets WHERE id = p_ticket_id) THEN
    RAISE EXCEPTION 'ticket_not_found';
  END IF;

  UPDATE bot.support_tickets
  SET needs_summary = v_summary
  WHERE id = p_ticket_id;

  RETURN jsonb_build_object(
    'updated', true,
    'ticket_id', p_ticket_id,
    'needs_summary', v_summary
  );
END
$$;

CREATE OR REPLACE FUNCTION bot_api.dashboard_orders_range(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = bot, public
AS $$
  WITH orders AS (
    SELECT jsonb_build_object(
      'order_id', o.id,
      'order_number', o.order_number,
      'status', o.status,
      'customer_name', coalesce(c.display_name, 'Pelanggan'),
      'customer_phone', c.phone,
      'items', o.items,
      'subtotal', o.subtotal,
      'shipping_cost', o.shipping_cost,
      'total', o.total,
      'tracking_number', o.tracking_number,
      'ordered_at', o.ordered_at
    ) AS item
    FROM bot.orders o
    JOIN bot.contacts c ON c.id = o.customer_id
    WHERE o.ordered_at >= p_from
      AND o.ordered_at < p_to
    ORDER BY o.ordered_at DESC
  )
  SELECT coalesce(jsonb_agg(item), '[]'::jsonb) FROM orders;
$$;

CREATE OR REPLACE FUNCTION bot_api.dashboard_month_orders(
  p_month date
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = bot, public
AS $$
  WITH day_series AS (
    SELECT generate_series(
      date_trunc('month', p_month)::date,
      (date_trunc('month', p_month) + interval '1 month - 1 day')::date,
      interval '1 day'
    )::date AS day
  ),
  day_stats AS (
    SELECT
      d.day,
      count(o.id) AS order_count,
      coalesce(sum(o.total), 0) AS total_value,
      count(*) FILTER (
        WHERE EXISTS (
          SELECT 1
          FROM bot.messages m
          WHERE m.contact_id = o.customer_id
            AND m.direction = 'customer_to_bot'
            AND m.created_at >= o.ordered_at
        )
      ) AS confirmed_count
    FROM day_series d
    LEFT JOIN bot.orders o ON o.ordered_at::date = d.day
    GROUP BY d.day
  )
  SELECT jsonb_build_object(
    'month', p_month,
    'total_orders', coalesce((SELECT sum(order_count) FROM day_stats), 0),
    'total_value', coalesce((SELECT sum(total_value) FROM day_stats), 0),
    'confirmed_orders', coalesce((SELECT sum(confirmed_count) FROM day_stats), 0),
    'days', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'date', day,
          'orders', order_count,
          'confirmed', confirmed_count,
          'value', total_value
        )
        ORDER BY day
      ),
      '[]'::jsonb
    )
  )
  FROM day_stats;
$$;

GRANT EXECUTE ON FUNCTION bot_api.dashboard_tickets() TO n8n_bot;
GRANT EXECUTE ON FUNCTION bot_api.dashboard_update_ticket_summary(uuid, text) TO n8n_bot;
GRANT EXECUTE ON FUNCTION bot_api.dashboard_orders_range(timestamptz, timestamptz) TO n8n_bot;
GRANT EXECUTE ON FUNCTION bot_api.dashboard_month_orders(date) TO n8n_bot;