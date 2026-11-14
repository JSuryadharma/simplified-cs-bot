// Edit satu knowledge teks dari dashboard: validasi input, bangun ulang teks embedding +
// payload Qdrant persis seperti scripts/knowledge/build.snippet.js, dan perbarui item di
// dataset JSON (knowledge/dataset/*.json) tanpa mengubah format file lainnya.
// Dashboard hanya me-mount folder dashboard/, jadi daftar label disalin dari build.snippet.js.

export const KB_CATEGORIES = ['profil_usaha', 'operasional', 'proses_order', 'desain', 'bahan', 'ukuran', 'minimal_order',
  'harga_resmi', 'harga_referensi', 'pembayaran', 'waktu_produksi', 'sample', 'pengiriman', 'lainnya'];

// Deskripsi label bawaan; bila dataset dipasang, deskripsi dari dataset.categories dipakai.
export const KB_CATEGORY_LABELS = {
  profil_usaha: 'Siapa SaViOr, produk dan layanan',
  operasional: 'Alamat, jam buka, kunjungan toko',
  proses_order: 'Alur pemesanan, desain, revisi, SPK',
  desain: 'Bantuan desain, file desain, bordir vs sablon',
  bahan: 'Jenis kain dan karakteristiknya',
  ukuran: 'Size chart dan cara mengukur',
  minimal_order: 'Minimal order',
  harga_resmi: 'Price list resmi yang boleh dijawab bot',
  harga_referensi: 'Harga deal sebelumnya; bot tidak menjawab sendiri, eskalasi ke owner dengan referensi ini',
  pembayaran: 'DP, pelunasan, invoice',
  waktu_produksi: 'Estimasi pengerjaan',
  sample: 'Sample/proofing',
  pengiriman: 'Ambil di toko, ekspedisi, pengiriman luar pulau',
  lainnya: 'Di luar label lain',
};

export const KB_TEXT_TYPES = ['chat_qa', 'price_list', 'price_reference'];

export function toList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
}

// Sama dengan teks embedding di buildKnowledgeDocs (build.snippet.js).
export function knowledgeText({ question, answer, products, tags }) {
  return `Pertanyaan: ${question}\nJawaban: ${answer}` +
    (products.length ? `\nProduk: ${products.join(', ')}` : '') +
    (tags.length ? `\nTag: ${tags.join(', ')}` : '');
}

// body: { question, answer, category, content_type?, auto_reply?, products?, tags? }
// current: payload point Qdrant saat ini. Field yang tidak dikirim memakai nilai lama.
// Kembalikan { error } atau { fields, text, payload }.
export function buildEdit(body, current, now = new Date().toISOString()) {
  const cur = current || {};
  if (cur.content_type === 'image_asset') return { error: 'Aset gambar belum bisa diedit dari sini.' };
  const pick = (key) => (body && body[key] !== undefined ? body[key] : undefined);
  const question = String(pick('question') ?? cur.question ?? '').trim();
  const answer = String(pick('answer') ?? cur.answer ?? '').trim();
  if (!question) return { error: 'Pertanyaan tidak boleh kosong.' };
  if (!answer) return { error: 'Jawaban tidak boleh kosong.' };
  if (question.length > 1000 || answer.length > 6000) return { error: 'Pertanyaan/jawaban terlalu panjang.' };
  const category = String(pick('category') ?? cur.category ?? 'lainnya').trim();
  if (!KB_CATEGORIES.includes(category)) return { error: `Label "${category}" tidak dikenal.` };
  const contentType = String(pick('content_type') ?? cur.content_type ?? 'chat_qa').trim();
  if (!KB_TEXT_TYPES.includes(contentType)) return { error: `Jenis "${contentType}" tidak dikenal.` };
  const products = toList(pick('products') ?? cur.products);
  const tags = toList(pick('tags') ?? cur.tags);
  // price_reference = harga deal masa lalu: hanya untuk owner, bot tidak boleh menjawab sendiri
  const autoRaw = pick('auto_reply') ?? cur.auto_reply;
  const autoReply = contentType === 'price_reference' ? false : autoRaw !== false;
  const fields = { content_type: contentType, category, question, answer, products, tags, auto_reply: autoReply };
  const text = knowledgeText(fields);
  const payload = { ...cur, ...fields, tags: tags.join(', '), text, edited_at: now };
  return { fields, text, payload };
}

// Perbarui item dataset dengan id = kbId. Kembalikan true bila ditemukan.
export function applyEditToDataset(dataset, kbId, fields) {
  const item = (dataset?.items || []).find((it) => String(it.id || it.question || '').trim() === kbId);
  if (!item) return false;
  item.content_type = fields.content_type;
  item.category = fields.category;
  item.question = fields.question;
  item.answer = fields.answer;
  item.products = fields.products;
  item.tags = fields.tags;
  item.auto_reply = fields.auto_reply;
  return true;
}

// Format JSON seperti knowledge/dataset/savior-knowledge.json: indent 2, array nilai sederhana
// satu baris, baris "sources"/"image_assets" satu objek per baris. Membaca lalu menulis file
// tanpa edit menghasilkan file yang identik, jadi diff git hanya berisi item yang diedit.
const INLINE_ROWS = new Set(['sources', 'image_assets']);
const isPrim = (v) => v === null || typeof v !== 'object';
function inline(v) {
  if (isPrim(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(inline).join(', ') + ']';
  const e = Object.entries(v);
  return e.length ? '{ ' + e.map(([k, x]) => JSON.stringify(k) + ': ' + inline(x)).join(', ') + ' }' : '{}';
}
function block(v, depth, key) {
  if (isPrim(v)) return JSON.stringify(v);
  const pad = '  '.repeat(depth + 1);
  const end = '  '.repeat(depth);
  if (Array.isArray(v)) {
    if (!v.length || v.every(isPrim)) return inline(v);
    const rows = INLINE_ROWS.has(key) ? v.map((x) => pad + inline(x)) : v.map((x) => pad + block(x, depth + 1));
    return '[\n' + rows.join(',\n') + '\n' + end + ']';
  }
  const e = Object.entries(v);
  if (!e.length) return '{}';
  return '{\n' + e.map(([k, x]) => pad + JSON.stringify(k) + ': ' + block(x, depth + 1, k)).join(',\n') + '\n' + end + '}';
}
export function formatDataset(dataset) {
  return block(dataset, 0) + '\n';
}
