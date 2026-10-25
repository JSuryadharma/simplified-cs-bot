# Panduan operasional

## State tiket

| State | Arti | Perilaku bot |
|---|---|---|
| tidak ada tiket aktif | Boleh melakukan RAG | Auto-reply atau eskalasi |
| `waiting_owner` | Owner belum menjawab | Catat pesan pelanggan, jangan balas |
| `owner_replied` | Jawaban sedang diteruskan | Tetap jangan auto-reply |
| `resolved` | Jawaban berhasil diteruskan | Pesan berikutnya boleh diproses normal |

Database memiliki unique partial index agar satu pelanggan tidak mempunyai dua tiket
aktif. Webhook message ID juga unik untuk mencegah pemrosesan event Meta yang dikirim ulang.

## Kontrak sinkronisasi order

Endpoint:

```text
POST /webhook/admin/orders/upsert
X-Import-Key: <IMPORT_API_KEY>
Content-Type: application/json
```

Payload:

```json
{
  "order_number": "INV-2026-001",
  "customer_phone": "628111111111",
  "customer_name": "Budi",
  "status": "dikirim",
  "items": [{ "name": "Produk A", "qty": 2, "price": 50000 }],
  "subtotal": 100000,
  "shipping_cost": 15000,
  "shipping_address": "Jakarta",
  "tracking_number": "JX123",
  "notes": null,
  "ordered_at": "2026-07-18T09:00:00+07:00"
}
```

`order_number` adalah idempotency key. Payload dengan nomor sama memperbarui order lama.
Hubungkan endpoint ini dari Shopify, WooCommerce, ERP, Google Sheets, atau workflow n8n
lain sesuai sumber order yang sebenarnya.

## Aturan keputusan AI

- `AUTO_REPLY` memerlukan minimal satu hasil Qdrant di atas threshold atau data order
  pelanggan yang relevan.
- Output kosong/tidak valid dipaksa menjadi `ESCALATE`.
- Prompt melarang model mengarang stok, harga, kebijakan, resi, dan janji.
- Jawaban owner menjadi knowledge di PostgreSQL dan Qdrant setelah berhasil diteruskan.

Mulai dengan `QDRANT_SCORE_THRESHOLD=0.72`. Naikkan apabila jawaban terlalu berani;
turunkan perlahan apabila terlalu sering eskalasi. Uji dengan kumpulan pertanyaan nyata
sebelum mengubah threshold produksi.

## Qdrant dan aset gambar

Qdrant dapat diperiksa dari host melalui:

```text
http://localhost:6333/dashboard
```

Collection `wa_knowledge` memuat dua tipe payload:

- `chat_qa`: pertanyaan dan jawaban dari histori chat atau balasan owner;
- `image_asset`: deskripsi, tag, MIME type, `asset_id`, dan path file referensi.

File gambar asli tidak dimasukkan ke payload Qdrant. File disimpan pada
`/home/node/.n8n/assets` di dalam volume `n8n_data`, agar tetap tersedia setelah
container n8n direstart. Saat aset dipilih, workflow membaca file tersebut, meng-upload
media ke WhatsApp Cloud API, lalu mengirim pesan gambar menggunakan media ID.

Form upload produksi berada di `/form/admin-upload-knowledge` dan memakai autentikasi
akun n8n. Integrasi mesin dapat memakai `POST /webhook/admin/upload-knowledge` dalam
format multipart dengan header `x-import-key`. Untuk gambar, gunakan deskripsi yang
spesifik mengenai produk, warna, bahan, model, dan konteks penggunaan. Hindari tag
terlalu umum karena dapat menurunkan akurasi pemilihan aset.

## Retensi dan privasi

- Chat export bisa memuat PII. Minimalkan isi, hapus percakapan yang tidak relevan, dan
  dapatkan dasar pemrosesan/izin yang sesuai.
- File chat mentah dari form tidak dipertahankan oleh workflow. Aset gambar disimpan
  sampai dihapus secara administratif dari volume dan point Qdrant terkait.
- Success execution n8n dimatikan pada workflow, tetapi error execution disimpan untuk
  debugging. Atur pruning dan akses editor karena error dapat membawa teks pelanggan.
- Backup volume PostgreSQL dan Qdrant secara terenkripsi. Uji pemulihan berkala.
- Putar `IMPORT_API_KEY`, access token Meta, password database, dan `N8N_ENCRYPTION_KEY`
  dengan prosedur yang terdokumentasi.
- PostgREST hanya berada di jaringan Docker internal dan role anonim hanya memperoleh
  hak execute pada fungsi `bot_api`.

## Monitoring minimum

- Pantau execution error alur 02, 03, dan 05.
- Alert bila LM Studio, Qdrant, atau PostgreSQL tidak sehat.
- Pantau tiket `waiting_owner` yang terlalu lama:

  ```bash
  docker compose --env-file .env exec -T postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
    "select code, created_at, customer_question from bot.support_tickets where status='waiting_owner' order by created_at;"
  ```

- Jalankan `node scripts/doctor.mjs` setelah restart host atau pergantian model.

## Batasan versi awal

- Satu nomor owner.
- Satu bahasa utama: Bahasa Indonesia.
- Chat export diproses sampai 700 entri terakhir dan 100 pasangan FAQ per impor.
- Aset gambar dicari berdasarkan deskripsi/tag dari admin; workflow belum membuat
  caption visual otomatis dari isi pixel.
- Perubahan model embedding yang mengubah dimensi memerlukan collection Qdrant baru
  atau re-index penuh; jangan menimpa collection lama dengan dimensi berbeda.
