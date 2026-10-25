-- Impor knowledge berlabel (dataset kurasi / impor chat dari dashboard).
-- Aditif: kolom baru nullable + fungsi baru. Jalankan:
--   docker compose --env-file .env exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < db/006-knowledge-import.sql
--   docker compose --env-file .env restart db-api   (agar PostgREST memuat fungsi baru)

ALTER TABLE bot.knowledge_items ADD COLUMN IF NOT EXISTS kb_id text;
ALTER TABLE bot.knowledge_items ADD COLUMN IF NOT EXISTS content_type text;
ALTER TABLE bot.knowledge_items ADD COLUMN IF NOT EXISTS category text;

CREATE OR REPLACE FUNCTION bot_api.import_knowledge(
  p_items jsonb,
  p_style_profile text DEFAULT NULL,
  p_replace boolean DEFAULT false,
  p_source text DEFAULT 'knowledge_import',
  p_source_stats jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bot, public
AS $$
DECLARE
  v_item jsonb;
  v_hash text;
  v_saved integer := 0;
  v_deleted integer := 0;
BEGIN
  IF p_replace THEN
    DELETE FROM bot.knowledge_items;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;

  IF coalesce(trim(p_style_profile), '') <> '' THEN
    INSERT INTO bot.style_profile(id, profile, source_stats, updated_at)
    VALUES (1, trim(p_style_profile), coalesce(p_source_stats, '{}'::jsonb), now())
    ON CONFLICT (id) DO UPDATE SET profile = EXCLUDED.profile, source_stats = EXCLUDED.source_stats, updated_at = now();
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  LOOP
    IF coalesce(trim(v_item->>'question'), '') = '' OR coalesce(trim(v_item->>'answer'), '') = '' THEN
      CONTINUE;
    END IF;
    v_hash := encode(digest(coalesce(v_item->>'kb_id', '') || E'\n' || lower(trim(v_item->>'question')), 'sha256'), 'hex');
    INSERT INTO bot.knowledge_items(content_hash, kb_id, content_type, category, question, answer, source, tags)
    VALUES (v_hash, v_item->>'kb_id', v_item->>'content_type', v_item->>'category',
      trim(v_item->>'question'), trim(v_item->>'answer'), p_source, coalesce(v_item->'tags', '[]'::jsonb))
    ON CONFLICT (content_hash) DO UPDATE SET
      answer = EXCLUDED.answer, content_type = EXCLUDED.content_type, category = EXCLUDED.category,
      tags = EXCLUDED.tags, source = EXCLUDED.source, updated_at = now();
    v_saved := v_saved + 1;
  END LOOP;

  RETURN jsonb_build_object('saved', v_saved, 'deleted', v_deleted, 'replace', p_replace);
END
$$;

GRANT EXECUTE ON FUNCTION bot_api.import_knowledge(jsonb, text, boolean, text, jsonb) TO n8n_bot;
