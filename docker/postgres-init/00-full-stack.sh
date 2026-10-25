#!/bin/sh
# Inisialisasi satu server PostgreSQL untuk seluruh stack (compose.yaml).
# Hanya dijalankan oleh image postgres saat volume data masih kosong.
#   - $POSTGRES_DB : skema bot WhatsApp (db/*.sql, dibaca PostgREST)
#   - savior       : database dashboard SaViOr konveksi
set -eu

psql_as() {
  user="$1"; db="$2"; shift 2
  psql -v ON_ERROR_STOP=1 --username "$user" --dbname "$db" "$@"
}

echo "[full-stack] skema bot -> $POSTGRES_DB"
for f in /initdb/bot/*.sql; do
  echo "  - $(basename "$f")"
  psql_as "$POSTGRES_USER" "$POSTGRES_DB" -f "$f"
done

create_owned_db() {
  role="$1"; password="$2"; db="$3"
  echo "[full-stack] role & database '$db'"
  psql_as "$POSTGRES_USER" postgres -v role="$role" -v pw="$password" -v db="$db" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL
}

create_owned_db "$SAVIOR_DB_USER" "$SAVIOR_DB_PASSWORD" "$SAVIOR_DB_NAME"

# pgcrypto adalah trusted extension (PG13+), jadi owner database boleh membuatnya.
# Migrasi lanjutan dijalankan service savior-migrate (scripts/migrate.mjs).
echo "[full-stack] skema savior -> $SAVIOR_DB_NAME"
psql_as "$SAVIOR_DB_USER" "$SAVIOR_DB_NAME" -f /initdb/savior/init.sql
