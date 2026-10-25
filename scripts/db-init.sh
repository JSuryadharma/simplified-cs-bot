#!/bin/sh
# Siapkan skema bot WhatsApp di database SaViOr yang masih baru (mesin baru).
# Untuk database yang sudah berisi skema bot, pakai `make db-migrate`.
#
#   make db-init
#
# Membuat role POSTGRES_USER (default wa_admin; password = POSTGRES_PASSWORD) dan n8n_bot, lalu
# menjalankan db/*.sql sebagai role itu sehingga role itu menjadi pemilik skema bot.
set -eu

cd "$(dirname "$0")/.."
DST_CONTAINER="${DST_CONTAINER:-savior-postgres}"
DST_DB="${DST_DB:-savior}"
DST_SUPERUSER="${DST_SUPERUSER:-savior}"
BOT_USER="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- || true)"; BOT_USER="${BOT_USER:-wa_admin}"
BOT_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
PSQL="docker exec -i $DST_CONTAINER psql -U $DST_SUPERUSER -d $DST_DB -v ON_ERROR_STOP=1 -q"

if $PSQL -Atc "select 1 from pg_namespace where nspname='bot'" | grep -q 1; then
  echo "Skema bot sudah ada di $DST_CONTAINER/$DST_DB. Pakai 'make db-migrate' untuk file SQL baru."
  exit 1
fi

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
GRANT n8n_bot TO "$BOT_USER" WITH ADMIN OPTION;
GRANT CONNECT, CREATE ON DATABASE "$DST_DB" TO "$BOT_USER";
SET ROLE "$BOT_USER";
SQL
  for f in db/*.sql; do echo "\\echo $f"; cat "$f"; echo; done
} | $PSQL -1
echo "Skema bot siap di $DST_CONTAINER/$DST_DB."
