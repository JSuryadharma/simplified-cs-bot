#!/bin/sh
# Pindahkan skema bot WhatsApp (bot, bot_api, n8n_internal) dari postgres lama stack
# ini ke database SaViOr (container savior-postgres dari ../GitHub/savior-app).
# Container dan volume lama TIDAK dihapus.
#
#   make db-move             # cek + backup saja
#   make db-move CONFIRM=ya  # hentikan n8n/db-api/wa-dashboard, salin data, lalu jalankan lagi
#
# Role yang dibuat di server SaViOr (bila belum ada):
#   wa_admin  LOGIN, password = POSTGRES_PASSWORD di .env, pemilik skema bot
#   n8n_bot   NOLOGIN, role anonim PostgREST
set -eu

cd "$(dirname "$0")/.."
SRC_CONTAINER="${SRC_CONTAINER:-savior-whatsapp-stack-postgres-1}"
SRC_DB="${SRC_DB:-wa_admin}"
SRC_USER="${SRC_USER:-wa_admin}"
DST_CONTAINER="${DST_CONTAINER:-savior-postgres}"
DST_DB="${DST_DB:-savior}"
DST_SUPERUSER="${DST_SUPERUSER:-savior}"
BOT_USER="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- || true)"; BOT_USER="${BOT_USER:-wa_admin}"
BOT_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
COMPOSE="docker compose --env-file .env"
OUT="backups/db_move_$(date +%Y%m%d_%H%M%S)"

running() { docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -q true; }
running "$SRC_CONTAINER" || { echo "Container sumber $SRC_CONTAINER tidak berjalan"; exit 1; }
running "$DST_CONTAINER" || { echo "Container $DST_CONTAINER tidak berjalan: (cd ../GitHub/savior-app && docker compose up -d postgres)"; exit 1; }

DST_PSQL="docker exec -i $DST_CONTAINER psql -U $DST_SUPERUSER -d $DST_DB -v ON_ERROR_STOP=1"

if $DST_PSQL -Atc "select 1 from pg_namespace where nspname='bot'" | grep -q 1; then
  echo "Skema bot sudah ada di $DST_CONTAINER/$DST_DB. Tidak ada yang diubah."
  exit 1
fi

mkdir -p "$OUT"
echo "Backup -> $OUT"
docker exec "$DST_CONTAINER" pg_dumpall -U "$DST_SUPERUSER" > "$OUT/savior-postgres-all.sql"
docker exec "$SRC_CONTAINER" pg_dump -U "$SRC_USER" -d "$SRC_DB" > "$OUT/wa_admin-full.sql"
ls -lh "$OUT"

if [ "${CONFIRM:-}" != "ya" ]; then
  echo
  echo "Belum ada yang diubah. Jalankan 'make db-move CONFIRM=ya' untuk memindahkan data."
  exit 0
fi

echo "Menghentikan service yang menulis ke database bot ..."
$COMPOSE stop n8n wa-dashboard db-api

echo "Menyalin skema bot ..."
docker exec "$SRC_CONTAINER" pg_dump -U "$SRC_USER" -d "$SRC_DB" \
  --schema=bot --schema=bot_api --schema=n8n_internal > "$OUT/bot-schemas.sql"
{
  cat <<SQL
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n_bot') THEN
    CREATE ROLE n8n_bot NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$BOT_USER') THEN
    CREATE ROLE "$BOT_USER" LOGIN;
  END IF;
END
\$\$;
ALTER ROLE "$BOT_USER" LOGIN PASSWORD '$BOT_PASSWORD';
GRANT n8n_bot TO "$BOT_USER";
GRANT CONNECT, CREATE ON DATABASE "$DST_DB" TO "$BOT_USER";
SQL
  cat "$OUT/bot-schemas.sql"
} | $DST_PSQL -1 -q

echo "Jumlah baris (lama | baru):"
for t in $(docker exec "$SRC_CONTAINER" psql -U "$SRC_USER" -d "$SRC_DB" -Atc \
    "select schemaname||'.'||relname from pg_stat_user_tables where schemaname='bot' order by 1"); do
  a="$(docker exec "$SRC_CONTAINER" psql -U "$SRC_USER" -d "$SRC_DB" -Atc "select count(*) from $t")"
  b="$($DST_PSQL -Atc "select count(*) from $t")"
  echo "  $t: $a | $b"
done

echo "Menjalankan service dengan database SaViOr ..."
$COMPOSE up -d --wait db-api n8n wa-dashboard
echo "Selesai. Postgres lama ($SRC_CONTAINER) masih berjalan dan tidak dihapus."
