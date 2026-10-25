#!/usr/bin/env bash
# Siapkan instance n8n sandbox (port 5679) untuk tests/run-conversation-tests.mjs.
#   bash tests/sandbox/setup.sh        # salin data, buat workflow sandbox, jalankan
#   bash tests/sandbox/setup.sh down   # hentikan dan hapus salinan data
set -euo pipefail
cd "$(dirname "$0")/../.."

COMPOSE=(docker compose --env-file .env -f compose.yaml -f tests/sandbox/compose.test.yaml)
DATA=tests/sandbox/n8n_data

if [[ "${1:-}" == "down" ]]; then
  "${COMPOSE[@]}" rm -sf n8n-test
  rm -rf "$DATA"
  exit 0
fi

"${COMPOSE[@]}" rm -sf n8n-test >/dev/null 2>&1 || true
rm -rf "$DATA"
mkdir -p "$DATA"

# Salin data n8n live. SQLite disalin lewat backup API agar konsisten walau n8n live sedang menulis.
rsync -a --exclude 'database.sqlite*' --exclude '*.log' --exclude crash.journal n8n_data/ "$DATA/"
python3 - "$DATA" <<'PY'
import sqlite3, sys
src = sqlite3.connect('file:n8n_data/database.sqlite?mode=ro', uri=True)
dst = sqlite3.connect(f'{sys.argv[1]}/database.sqlite')
src.backup(dst)
dst.close(); src.close()
PY

node tests/sandbox/build-test-workflow.mjs
cp tests/sandbox/wa-admin-sandbox.json "$DATA/wa-admin-sandbox.json"

"${COMPOSE[@]}" up -d --no-deps --wait n8n-test
"${COMPOSE[@]}" exec -T n8n-test n8n import:workflow --input=/home/node/.n8n/wa-admin-sandbox.json
"${COMPOSE[@]}" exec -T n8n-test n8n publish:workflow --id=WaAdm1nLengkap26
"${COMPOSE[@]}" restart n8n-test
"${COMPOSE[@]}" up -d --no-deps --wait n8n-test
# Tunggu webhook terdaftar (GET = verifikasi Meta, tanpa efek samping)
for _ in $(seq 1 60); do
  [[ "$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:5679/webhook/whatsapp")" != "404" ]] && break
  sleep 2
done
echo "sandbox n8n siap di http://localhost:5679"
