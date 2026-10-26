.PHONY: validate config up down restart ps logs import doctor db-migrate db-init backup fix-perms

COMPOSE = docker compose --env-file .env

validate:
	docker compose --env-file .env.example config --quiet

config:
	$(COMPOSE) config --quiet

# Build + jalankan seluruh stack, tunggu sampai semua service healthy
# n8n_data dibuat lebih dulu oleh user ini; kalau dibuat Docker, folder itu milik root dan n8n gagal (EACCES)
up:
	mkdir -p n8n_data/storage
	$(COMPOSE) up -d --build --wait

# Perbaiki pemilik n8n_data untuk user node (uid 1000) di container n8n, tanpa sudo
fix-perms:
	mkdir -p n8n_data/storage
	docker run --rm -v "$(CURDIR)/n8n_data:/data" node:22-alpine chown -R 1000:1000 /data

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f --tail=100

# Impor + publish ulang workflow gabungan ke n8n, lalu restart agar aktif
import:
	$(COMPOSE) exec n8n n8n import:workflow --input=/workflows/wa-admin-lengkap.json
	$(COMPOSE) exec n8n n8n publish:workflow --id=WaAdm1nLengkap26
	$(COMPOSE) restart n8n

doctor:
	node scripts/doctor.mjs

# Database bot ada di Postgres milik SaViOr (container savior-postgres, ../GitHub/savior-app)
SAVIOR_PG = docker exec -i savior-postgres psql -U savior -d savior -v ON_ERROR_STOP=1

# Sekali untuk database SaViOr baru: buat role n8n_bot (+ POSTGRES_USER bila belum ada) + skema bot dari db/*.sql
db-init:
	sh scripts/db-init.sh

# Terapkan satu file SQL bot ke database yang sudah ada: make db-migrate FILE=db/00x-....sql
db-migrate:
	u=$$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-); { echo "SET ROLE $${u:-wa_admin};"; cat $(FILE); } | $(SAVIOR_PG)
	$(COMPOSE) restart db-api

# Backup database SaViOr (termasuk skema bot), snapshot Qdrant, dan n8n_data ke backups/stack_<waktu>/
backup:
	sh scripts/backup-stack.sh
