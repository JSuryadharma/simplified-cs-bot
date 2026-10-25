#!/bin/sh
set -eu

container_name="${N8N_CONTAINER_NAME:-n8n}"
data_volume="${N8N_DATA_VOLUME:-n8n_data}"
n8n_image="${N8N_IMAGE:-docker.n8n.io/n8nio/n8n}"
project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
backup_dir="$project_dir/backups"
backup_name="n8n_data_before_import_$(date +%Y%m%d_%H%M%S).tar.gz"

if ! docker inspect "$container_name" >/dev/null 2>&1; then
  echo "Container n8n existing '$container_name' tidak ditemukan." >&2
  exit 2
fi

was_running="$(docker inspect --format '{{.State.Running}}' "$container_name")"

restart_n8n() {
  if [ "$was_running" = "true" ]; then
    docker start "$container_name" >/dev/null
  fi
}

trap restart_n8n EXIT INT TERM

if [ "$was_running" = "true" ]; then
  docker stop "$container_name" >/dev/null
fi

mkdir -p "$backup_dir"
docker run --rm \
  -v "$data_volume:/source:ro" \
  -v "$backup_dir:/backup" \
  alpine:3.22 \
  tar -czf "/backup/$backup_name" -C /source .

docker run --rm \
  -v "$data_volume:/data" \
  alpine:3.22 \
  sh -lc 'mkdir -p /data/assets && chown 1000:1000 /data/assets && chmod 750 /data/assets'

docker run --rm \
  -v "$data_volume:/home/node/.n8n" \
  --entrypoint sh \
  "$n8n_image" \
  -lc 'for id in HDbUNeUhlOyK3CGI ocD7e6nuJ0YQ8nRQ Q3uCUsnXOh85Rb0b RrB96aJmTndgiwP8 vijuE6PoFM6NvHeF; do
         n8n unpublish:workflow --id="$id" >/dev/null 2>&1 || true
       done'

docker run --rm \
  -v "$data_volume:/home/node/.n8n" \
  -v "$project_dir/workflows/wa-admin-lengkap.json:/workflow.json:ro" \
  "$n8n_image" \
  import:workflow --input=/workflow.json

docker run --rm \
  -v "$data_volume:/home/node/.n8n" \
  "$n8n_image" \
  publish:workflow --id=WaAdm1nLengkap26

trap - EXIT INT TERM
restart_n8n

echo "Workflow gabungan terimpor dan dipublish ke '$container_name'."
echo "Backup sebelum impor: $backup_dir/$backup_name"
