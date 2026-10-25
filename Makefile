.PHONY: validate config up down restart ps logs import doctor db-migrate db-init backup

COMPOSE = docker compose --env-file .env

validate:
	docker compose --env-file .env.example config --quiet

config:
	$(COMPOSE) config --quiet

# Build + jalankan seluruh stack, tunggu sampai semua service healthy
up:
	$(COMPOSE) up -d --build --wait

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

# Sekali untuk database SaViOr baru: buat role wa_admin/n8n_bot + skema bot dari db/*.sql
db-init:
	sh scripts/db-init.sh

# Terapkan satu file SQL bot ke database yang sudah ada: make db-migrate FILE=db/00x-....sql
db-migrate:
	{ echo 'SET ROLE wa_admin;'; cat $(FILE); } | $(SAVIOR_PG)
	$(COMPOSE) restart db-api

# Backup database SaViOr (termasuk skema bot), snapshot Qdrant, dan n8n_data ke backups/stack_<waktu>/
backup:
	sh scripts/backup-stack.sh
