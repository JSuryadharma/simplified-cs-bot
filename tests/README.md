# Uji percakapan chatbot

Kasus ada di `conversations/cases.json` (pelanggan dengan/tanpa gambar, dan perintah owner).
Tes berjalan di instance n8n sandbox (port 5679) dengan salinan data n8n; node WhatsApp
diganti HTTP ke `mock-whatsapp`, jadi tidak ada pesan yang keluar ke Meta dan workflow live
tidak disentuh. Data uji (kontak 62899…, order TEST-…) tetap masuk ke database bot.

```bash
bash tests/sandbox/setup.sh                 # salin data + jalankan sandbox
node tests/run-conversation-tests.mjs       # semua kasus (atau: C09,C10)
bash tests/sandbox/setup.sh down            # hentikan sandbox + hapus salinan data
```

Uji dengan perbaikan akses file aset:
`SANDBOX_BLOCK_N8N_FILES=false SANDBOX_RESTRICT_FILE_ACCESS_TO=/home/node/.n8n/storage bash tests/sandbox/setup.sh`

Hasil tersimpan di `results/` (JSON per run + `report.html`).

## Tes pemecah balasan

Node **Pecah Balasan** (balasan panjang dipecah jadi beberapa chat WhatsApp per kalimat) punya
tes sendiri yang tidak butuh n8n:

```bash
node tests/split-reply.test.mjs
```

Kode node ada di `workflows/snippets/pecah-balasan.js`; kalau file itu diubah, tempel ulang ke
node "Pecah Balasan" di `workflows/wa-admin-lengkap.json` (atau di editor n8n).
