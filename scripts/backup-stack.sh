#!/bin/sh
# Backup seluruh data stack tanpa menghentikan service:
#   - PostgreSQL SaViOr (savior-postgres, termasuk skema bot) -> postgres-all.sql.gz
#   - Qdrant collection              -> qdrant-<collection>.snapshot
#   - n8n_data (workflow, credential, aset upload) -> n8n_data.tar.gz
# Hasil: backups/stack_<waktu>/
set -eu

cd "$(dirname "$0")/.."
COLLECTION="$(grep -E '^QDRANT_COLLECTION=' .env | cut -d= -f2- || true)"
COLLECTION="${COLLECTION:-wa_knowledge_openrouter}"
OUT="backups/stack_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$OUT"

echo "PostgreSQL ..."
docker exec "${PG_CONTAINER:-savior-postgres}" pg_dumpall -U "${PG_SUPERUSER:-savior}" | gzip > "$OUT/postgres-all.sql.gz"

echo "Qdrant ($COLLECTION) ..."
SNAP="$(curl -fsS -X POST "http://127.0.0.1:6333/collections/$COLLECTION/snapshots" \
  | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')"
curl -fsS -o "$OUT/qdrant-$COLLECTION.snapshot" \
  "http://127.0.0.1:6333/collections/$COLLECTION/snapshots/$SNAP"
curl -fsS -X DELETE "http://127.0.0.1:6333/collections/$COLLECTION/snapshots/$SNAP" >/dev/null

echo "n8n_data ..."
tar -czf "$OUT/n8n_data.tar.gz" n8n_data

ls -lh "$OUT"
