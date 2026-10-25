// Membangun dokumen knowledge (teks embedding + payload Qdrant) dari dataset berlabel.
// Seperti wa-parse.snippet.js, file ini tanpa import/export agar bisa disisipkan ke Code node n8n.
// Dipakai oleh scripts/import-knowledge.mjs dan node "Gabungkan Knowledge Impor".

const KB_STORAGE = '/home/node/.n8n/storage/';
const KB_CONTENT_TYPES = ['chat_qa', 'price_list', 'price_reference', 'image_asset'];
const KB_CATEGORIES = ['profil_usaha', 'operasional', 'proses_order', 'desain', 'bahan', 'ukuran', 'minimal_order',
  'harga_resmi', 'harga_referensi', 'pembayaran', 'waktu_produksi', 'sample', 'pengiriman', 'lainnya'];
const KB_ASSET_KINDS = ['size_chart', 'katalog', 'price_list', 'contoh_produk', 'contoh_desain', 'referensi_model', 'referensi_ukuran', 'referensi_detail'];
const KB_KIND_LABEL = {
  size_chart: 'Size chart / tabel ukuran', katalog: 'Katalog warna/kain', price_list: 'Price list / daftar harga',
  contoh_produk: 'Foto contoh produk', contoh_desain: 'Contoh desain / mock up', referensi_model: 'Referensi model',
  referensi_ukuran: 'Referensi ukuran', referensi_detail: 'Referensi detail',
};

// UUID deterministik dari teks (hashHex = fungsi sha1/sha256 hex) supaya impor ulang menimpa, bukan menggandakan.
function kbUuid(hashHex, key) {
  const h = hashHex(String(key));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function kbList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
}

function kbMime(file) {
  return /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg';
}

// dataset: { items: [...], image_assets: [...] } (format knowledge/dataset/*.json atau hasil label LLM)
// opts: { hashHex, source, availableFiles?: Set|array (nama file gambar yang ada di storage), now }
// Kembalikan { docs: [{ id, text, payload }], skipped: [{ id, reason }] }
function buildKnowledgeDocs(dataset, opts) {
  const options = opts || {};
  const now = options.now || new Date().toISOString();
  const source = options.source || 'knowledge_dataset';
  const available = options.availableFiles ? new Set(options.availableFiles) : null;
  const docs = [];
  const skipped = [];
  const seen = new Set();
  const push = (key, text, payload) => {
    const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(norm)) { skipped.push({ id: payload.kb_id, reason: 'duplikat' }); return; }
    seen.add(norm);
    docs.push({ id: kbUuid(options.hashHex, key), text, payload: { ...payload, text, source, imported_at: now } });
  };

  for (const item of (dataset && dataset.items) || []) {
    const question = String(item.question || '').trim();
    const answer = String(item.answer || '').trim();
    if (!question || !answer) { skipped.push({ id: item.id, reason: 'pertanyaan/jawaban kosong' }); continue; }
    const contentType = KB_CONTENT_TYPES.includes(item.content_type) ? item.content_type : 'chat_qa';
    const category = KB_CATEGORIES.includes(item.category) ? item.category : 'lainnya';
    const products = kbList(item.products);
    const tags = kbList(item.tags);
    // price_reference = harga deal masa lalu: hanya untuk owner, bot tidak boleh menjawab sendiri
    const autoReply = contentType === 'price_reference' ? false : item.auto_reply !== false;
    const kbId = String(item.id || question).trim();
    const text = `Pertanyaan: ${question}\nJawaban: ${answer}` +
      (products.length ? `\nProduk: ${products.join(', ')}` : '') +
      (tags.length ? `\nTag: ${tags.join(', ')}` : '');
    push(`kb:${kbId}`, text, {
      content_type: contentType, category, kb_id: kbId, question, answer, products, tags: tags.join(', '),
      auto_reply: autoReply, valid_from: item.valid_from || '', source_chats: kbList(item.sources),
    });
  }

  for (const asset of (dataset && dataset.image_assets) || []) {
    const file = String(asset.file || '').trim();
    const assetId = String(asset.asset_id || '').trim();
    const description = String(asset.description || '').trim();
    if (!file || !assetId || description.length < 8) { skipped.push({ id: assetId || file, reason: 'file/asset_id/deskripsi kosong' }); continue; }
    if (!/\.(jpe?g|png|webp)$/i.test(file)) { skipped.push({ id: assetId, reason: 'bukan gambar' }); continue; }
    if (available && !available.has(file)) { skipped.push({ id: assetId, reason: `file ${file} tidak ada di storage` }); continue; }
    const kind = KB_ASSET_KINDS.includes(asset.kind) ? asset.kind : 'contoh_produk';
    const products = kbList(asset.products);
    const tags = kbList(asset.tags);
    const caption = String(asset.caption || description).trim().slice(0, 900);
    const text = `${KB_KIND_LABEL[kind]}: ${description}\nCaption: ${caption}` +
      (products.length ? `\nProduk: ${products.join(', ')}` : '') +
      (tags.length ? `\nTag: ${tags.join(', ')}` : '');
    push(`asset:${assetId}`, text, {
      content_type: 'image_asset', category: kind === 'price_list' ? 'harga_resmi' : kind === 'size_chart' ? 'ukuran' : kind === 'katalog' ? 'bahan' : 'contoh',
      kb_id: assetId, asset_id: assetId, asset_kind: kind, produk: products.join(' / '), products,
      asset_description: description, asset_caption: caption, asset_path: KB_STORAGE + file,
      original_file_name: file, mime_type: kbMime(file), tags: tags.join(', '), auto_reply: true,
      source_chats: kbList(asset.sources),
    });
  }
  return { docs, skipped };
}

// Prompt + JSON schema untuk melabeli satu potongan chat (impor otomatis dari dashboard).
const KB_LABEL_SYSTEM = `Anda menyusun knowledge base chatbot WhatsApp sebuah konveksi custom dari potongan chat owner dengan pelanggan (Bahasa Indonesia).
Tugas: ekstrak informasi yang BERLAKU UMUM dan bisa dipakai menjawab pelanggan lain.
- items: fakta/kebijakan yang dinyatakan OWNER (bahan, ukuran, minimal order, proses order, pembayaran, waktu produksi, pengiriman, jam buka, alamat toko, layanan). Tulis "question" sebagai pertanyaan umum pelanggan dan "answer" sebagai jawaban owner yang dirapikan, tanpa nama pelanggan.
- Harga yang disebut owner untuk pesanan tertentu: content_type "price_reference", category "harga_referensi", sertakan spesifikasi (bahan, sablon/bordir, ukuran, jumlah) dan bulan-tahun di answer.
- Price list resmi (tabel harga per jumlah yang berlaku untuk semua): content_type "price_list", category "harga_resmi".
- image_labels: hanya untuk [GAMBAR nama.jpg] yang dikirim OWNER dan berguna untuk pelanggan lain (size chart, katalog warna/kain, price list, contoh produk/desain). Deskripsikan dari konteks chat; reusable=false bila gambar adalah invoice, bukti transfer, resi, foto paket, screenshot chat, atau desain yang hanya berlaku untuk satu pelanggan.
- JANGAN memasukkan: nama/alamat/nomor HP pelanggan, nomor rekening, nominal tagihan/DP pelanggan tertentu, obrolan pribadi, janji tanggal untuk pesanan tertentu.
- Jangan mengarang. Jika potongan tidak berisi informasi umum, kembalikan array kosong.`;

const KB_LABEL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    items: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: {
        content_type: { type: 'string', enum: ['chat_qa', 'price_list', 'price_reference'] },
        category: { type: 'string', enum: KB_CATEGORIES },
        products: { type: 'array', items: { type: 'string' } },
        question: { type: 'string' }, answer: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        valid_from: { type: 'string' },
      },
      required: ['content_type', 'category', 'products', 'question', 'answer', 'tags', 'valid_from'] } },
    image_labels: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: {
        file: { type: 'string' }, kind: { type: 'string', enum: KB_ASSET_KINDS },
        products: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' }, caption: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }, reusable: { type: 'boolean' },
      },
      required: ['file', 'kind', 'products', 'description', 'caption', 'tags', 'reusable'] } },
    style_notes: { type: 'string' },
  },
  required: ['items', 'image_labels', 'style_notes'],
};

// Ubah hasil label LLM (beberapa potongan) menjadi dataset { items, image_assets, style_notes }.
function labelsToDataset(labelResults, opts) {
  const options = opts || {};
  const items = [];
  const assets = new Map();
  const notes = [];
  labelResults.forEach((r, i) => {
    if (!r) return;
    (r.items || []).forEach((raw, j) => {
      if (!raw || !raw.question || !raw.answer) return;
      const it = { ...raw };
      // Model gratis sering melanggar schema: rapikan produk, dan price_reference wajib berisi nominal
      it.products = kbList(it.products).filter((p) => /[a-z]{3,}/i.test(p) && !/[\/\\]|^products?$/i.test(p)).map((p) => p.toLowerCase());
      const hasAmount = /\d+\s*(rb|ribu|k|jt|juta)\b|\d{1,3}(?:[.,]\d{3})+/i.test(it.answer);
      if (it.content_type === 'price_reference' && !hasAmount) {
        it.content_type = 'chat_qa';
        if (/^harga/.test(it.category)) it.category = /minim|moq/i.test(it.question + it.answer) ? 'minimal_order' : 'lainnya';
      }
      if (it.content_type === 'chat_qa' && hasAmount && /harga|biaya|rb\b|ribu/i.test(it.question + it.answer)) {
        it.content_type = 'price_reference';
        it.category = 'harga_referensi';
      }
      items.push({ ...it, id: `${options.prefix || 'impor'}-${i}-${j}-${String(it.question).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`, sources: options.chat ? [options.chat] : [] });
    });
    (r.image_labels || []).filter((l) => l.reusable && l.file).forEach((l) => {
      const id = 'img-' + l.file.replace(/\.[a-z]+$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (!assets.has(id)) assets.set(id, { asset_id: id, file: l.file, kind: l.kind, products: l.products, description: l.description, caption: l.caption, tags: l.tags, sources: options.chat ? [options.chat] : [] });
    });
    if (r.style_notes) notes.push(r.style_notes);
  });
  return { items, image_assets: [...assets.values()], style_notes: notes.join('\n') };
}
