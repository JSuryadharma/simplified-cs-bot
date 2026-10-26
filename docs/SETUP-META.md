# Setup WhatsApp Cloud API

## 1. Siapkan aplikasi Meta

1. Buat aplikasi di Meta for Developers dan tambahkan produk WhatsApp.
2. Catat `Phone Number ID`, access token, WhatsApp Business Account ID, dan App Secret.
3. Buat verify token acak milik sendiri.
4. Untuk produksi, gunakan system-user/permanent access token dengan izin minimum yang
   diperlukan; token sementara hanya cocok untuk pengujian.

Di n8n, buka **Credentials**, lalu buat credential bertipe **WhatsApp Business Cloud**
dengan nama `WhatsApp account`:

- Access Token: token dari Meta.
- Business Account ID: WhatsApp Business Account ID dari Meta.

Workflow memakai node native `WhatsApp Business Cloud` versi 1.1. Phone Number ID
sender test yang sedang dipilih adalah `1233522196505651`. Untuk mengganti sender,
ubah Phone Number ID pada node pengiriman WhatsApp di editor n8n.

Environment hanya dipakai untuk tanda tangan webhook (opsional) dan identitas owner:

```dotenv
WHATSAPP_APP_SECRET=...
OWNER_PHONE=628...
```

Access token WhatsApp tidak lagi ditulis pada node HTTP atau environment workflow;
token dikelola oleh credential n8n.

## 2. Publikasikan webhook HTTPS

Meta membutuhkan callback HTTPS publik. Pasang reverse proxy dengan TLS di depan n8n
atau gunakan tunnel hanya untuk tahap pengembangan. Set:

```dotenv
N8N_HOST=bot.example.com
N8N_PROTOCOL=https
WEBHOOK_URL=https://bot.example.com/
```

Restart n8n setelah mengubah environment:

```bash
docker compose --env-file .env up -d
```

Pastikan workflow 01 dan 02 sudah dipublish. Callback URL:

```text
https://bot.example.com/webhook/whatsapp
```

Masukkan verify token yang Anda pilih di n8n sebagai verify token di Meta, lalu subscribe ke
field `messages` untuk WhatsApp Business Account.

Workflow 02 memverifikasi `X-Hub-Signature-256` terhadap raw request body jika
`WHATSAPP_APP_SECRET` terisi. Event tanpa signature yang valid dihentikan sebelum
menyentuh database.

## 3. Uji aman

1. Pastikan keenam node pengiriman menampilkan credential `WhatsApp account`.
2. Kirim pesan dari nomor pelanggan uji ke nomor bisnis.
3. Periksa execution workflow 02.
4. Pastikan pesan yang punya knowledge mendapat jawaban.
5. Kirim pertanyaan baru dan pastikan owner menerima kode tiket.
6. Sebelum owner menjawab, kirim pesan pelanggan kedua dan pastikan tidak ada balasan.
7. Jawab dari nomor `OWNER_PHONE` memakai `#TKT-XXXXXXXX jawaban`.
8. Pastikan hanya bagian jawaban yang diteruskan dan tiket menjadi `resolved`.

## Catatan WhatsApp

- Balasan bebas biasanya tunduk pada customer-service window WhatsApp. Jika owner baru
  menjawab setelah window berakhir, pengiriman dapat ditolak dan perlu approved template.
- Workflow ini menangani text, button, dan interactive reply. Media dicatat sebagai
  deskripsi tipe pesan dan akan cenderung dieskalasi; pengunduhan/transkripsi media belum
  diaktifkan.
- Jangan gunakan nomor bisnis yang sama sebagai `OWNER_PHONE`; gunakan nomor pribadi
  owner yang mengirim pesan ke nomor bisnis.
