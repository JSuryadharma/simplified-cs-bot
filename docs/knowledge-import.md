# Knowledge base: dataset, impor, dan aturan bot

Knowledge bot disimpan di Qdrant (`wa_knowledge`) dan ringkasannya di `bot.knowledge_items`.
Setiap point punya label sehingga bot bisa membedakan jenis informasi.

## Label

| content_type | Isi | Bot boleh menjawab sendiri? |
|---|---|---|
| `chat_qa` | Tanya jawab umum (bahan, ukuran, proses, pembayaran, pengiriman, jam buka, alamat) | Ya |
| `price_list` | Price list resmi (lanyard, tote bag kanvas, ID card) | Ya, dikutip apa adanya |
| `price_reference` | Harga deal pesanan sebelumnya | Tidak. Bot eskalasi dan menyertakan referensi ini di tiket owner |
| `image_asset` | Gambar yang bisa dikirim: `size_chart`, `katalog`, `price_list`, `contoh_produk`, `contoh_desain`, `referensi_*` | Ya, bila pelanggan meminta |

Kategori (`category`): profil_usaha, operasional, proses_order, desain, bahan, ukuran, minimal_order,
harga_resmi, harga_referensi, pembayaran, waktu_produksi, sample, pengiriman.

## Dataset kurasi

`knowledge/dataset/savior-knowledge.json` dibuat dari 5 ekspor chat di `knowledge/sources/`
dan gambar di `n8n_data/storage/` (nama file sama seperti di chat). Data pribadi pelanggan,
bukti transfer, invoice, dan nomor rekening tidak dimasukkan.

Impor ulang (ganti semua):

```bash
node scripts/import-knowledge.mjs --dataset knowledge/dataset/savior-knowledge.json --replace --db
# uji dulu ke collection lain:
node scripts/import-knowledge.mjs --dataset knowledge/dataset/savior-knowledge.json --collection wa_knowledge_test --replace
```

Embedding dibuat lebih dulu; data lama baru dihapus setelah semua embedding berhasil.
ID point deterministik, jadi impor ulang memperbarui entri yang sama.

## Impor dari dashboard

Tab **Knowledge** di dashboard (port 4000):

1. Tarik file ekspor chat (`.txt`), gambar lampirannya, dan/atau dataset `.json`.
2. Pilih **Tambah** atau **Ganti semua**, lalu **Pratinjau**: data dilabeli tanpa menulis apa pun, dan
   tabel menandai setiap entri sebagai Baru, Diperbarui, atau Dihapus (mode ganti semua).
3. **Simpan** mengirim dataset hasil pratinjau (chat tidak dilabeli ulang). Ganti semua butuh ketik `HAPUS`.
4. Kartu **Cek knowledge** menjalankan query Qdrant seperti bot (embedding `search_query:`) dan menandai
   hasil di bawah ambang skor yang tidak dipakai bot.
5. Gambar disimpan ke `n8n_data/storage` tanpa menimpa file yang sudah ada; chat/dataset dikirim
   ke webhook n8n `POST /webhook/admin/import-knowledge` (header `x-import-key`).
6. n8n memotong chat, melabeli tiap potongan dengan OpenRouter (jeda 3 detik, retry), menggabungkan
   dan menghapus duplikat, lalu embed dan menulis ke Qdrant + `bot.knowledge_items`.

Model gratis OpenRouter punya limit harian; potongan yang gagal dilaporkan di hasil impor dan bisa
diulang dengan mengimpor file yang sama (mode Tambah).

## Kode bersama

- `scripts/knowledge/wa-parse.snippet.js` — parser ekspor WhatsApp, redaksi data pribadi, pemotongan chat
- `scripts/knowledge/build.snippet.js` — label, pembangun dokumen/payload, prompt pelabelan

Keduanya dipakai CLI (`scripts/knowledge/index.mjs`) dan disisipkan ke Code node n8n oleh
`scripts/apply-knowledge-import.mjs`.

## Patch workflow

Urutan (semua idempoten, dijalankan pada hasil export workflow live):

```bash
node scripts/apply-asset-request-guard.mjs in.json out.json   # size chart/katalog/price list/contoh -> gambar yang cocok
node scripts/apply-knowledge-guard.mjs out.json out.json      # price_list vs price_reference, penjaga nominal
node scripts/apply-knowledge-import.mjs out.json out.json     # cabang impor knowledge v2
node scripts/apply-dashboard-send.mjs out.json out.json       # tetap pertahankan webhook kirim dari dashboard
```

Database: `db/006-knowledge-import.sql` (kolom baru + `bot_api.import_knowledge`).
Sandbox: `SANDBOX_FIX_SCRIPTS=...` dan `SANDBOX_QDRANT_COLLECTION=wa_knowledge_test`; sandbox tidak menulis
ke `bot.knowledge_items` (`KNOWLEDGE_DB_SYNC=false`).
