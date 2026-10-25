// Tambahkan size chart (jaket, kaos, hoodie, boxy) ke knowledge Qdrant sebagai image_asset,
// plus satu chat_qa per produk berisi angka ukurannya agar pertanyaan teks ("lebar jaket L berapa?")
// juga bisa dijawab. File gambar sudah ada di n8n_data/storage (dipasang di /home/node/.n8n/storage).
//   node scripts/add-size-chart-assets.mjs [collection]   (default: QDRANT_COLLECTION / wa_knowledge)
// Idempoten: id point tetap, menjalankan ulang hanya menimpa.
import { embedTexts, loadEnv } from './lib.mjs';

loadEnv();
const QDRANT = process.env.QDRANT_HOST_URL || 'http://localhost:6333';
const collection = process.argv[2] || process.env.QDRANT_COLLECTION || 'wa_knowledge';
const STORAGE = '/home/node/.n8n/storage/';

const charts = [
  {
    id: 1011, qaId: 1012, asset_id: 'size-chart-jaket', file: 'size-chart-jaket.jpg', produk: 'jaket',
    description: 'Size chart jaket Savior (lebar x panjang badan, cm). Dewasa: XS 50x60, S 53x63, M 56x66, L 59x69, XL 62x72. Big Size: 2XL 66x74, 3XL 69x76, 4XL 72x78, 5XL 75x80, 6XL 80x82. Toleransi jahit +/- 1-2 cm.',
    caption: 'Size chart jaket Savior (Dewasa XS-XL & Big Size 2XL-6XL). Toleransi jahit +/- 1-2 cm.',
    tags: 'size chart jaket, tabel ukuran jaket, ukuran jaket, jacket size chart, jaket varsity, jaket bomber, jaket angkatan',
  },
  {
    id: 1013, qaId: 1014, asset_id: 'size-chart-kaos', file: 'size-chart-kaos.jpg', produk: 'kaos / t-shirt',
    description: 'Size chart kaos / t-shirt Savior (lebar x panjang badan, cm). Dewasa: XS 44x63, S 47x66, M 50x69, L 53x72, XL 56x74. Big Size: 2XL 59x76, 3XL 62x80, 4XL 65x80; di atas 4XL masuk hitungan jumbo. Toleransi jahit +/- 1-2 cm.',
    caption: 'Size chart kaos/t-shirt Savior (Dewasa XS-XL & Big Size 2XL-4XL). Toleransi jahit +/- 1-2 cm.',
    tags: 'size chart kaos, size chart t-shirt, tabel ukuran kaos, ukuran kaos, tshirt size chart, baju, kaos sablon',
  },
  {
    id: 1015, qaId: 1016, asset_id: 'size-chart-hoodie', file: 'IMG-20250709-WA0041.jpg', produk: 'hoodie',
    description: 'Size chart hoodie dewasa Savior (lebar x panjang badan, cm): M 52x66, L 55x69, XL 58x72, 2XL 62x75, 3XL 66x80. Toleransi jahit +/- 1-2 cm.',
    caption: 'Size chart hoodie dewasa Savior (M-3XL). Toleransi jahit +/- 1-2 cm.',
    tags: 'size chart hoodie, tabel ukuran hoodie, ukuran hoodie, hoodie size chart, sweater hoodie',
  },
  {
    id: 1017, qaId: 1018, asset_id: 'size-chart-boxy', file: 'IMG-20250610-WA0018.jpg', produk: 'kaos boxy / oversize',
    description: 'Size chart kaos boxy / oversize Savior (lebar x panjang badan x panjang lengan, cm): 2XL 66x74x26, 3XL 69x76x27, 4XL 72x80x27. Toleransi jahit +/- 1-2 cm.',
    caption: 'Size chart kaos boxy/oversize Savior (2XL-4XL). Toleransi jahit +/- 1-2 cm.',
    tags: 'size chart boxy, size chart oversize, tabel ukuran kaos boxy, ukuran boxy, kaos oversize',
  },
];

async function call(url, method, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const docs = [];
for (const c of charts) {
  const assetText = `${c.description} Caption: ${c.caption} Tags: ${c.tags}`;
  docs.push({ id: c.id, text: assetText, payload: {
    content_type: 'image_asset', asset_id: c.asset_id, asset_kind: 'size_chart', produk: c.produk,
    asset_description: c.description, asset_caption: c.caption,
    asset_path: STORAGE + c.file, original_file_name: c.file, mime_type: 'image/jpeg',
    tags: c.tags, text: assetText, source: 'size_chart_storage',
  } });
  const question = `Size chart / tabel ukuran ${c.produk} Savior seperti apa?`;
  const answer = `${c.description} Gambar size chart-nya bisa langsung dikirim.`;
  docs.push({ id: c.qaId, text: `Pertanyaan: ${question}\nJawaban: ${answer}`, payload: {
    content_type: 'chat_qa', question, answer, text: `Pertanyaan: ${question}\nJawaban: ${answer}`, source: 'size_chart_storage',
  } });
}

const vectors = await embedTexts(docs.map((d) => d.text));
const points = docs.map((d, i) => ({ id: d.id, vector: vectors[i], payload: { ...d.payload, imported_at: new Date().toISOString() } }));
await call(`${QDRANT}/collections/${collection}/points?wait=true`, 'PUT', { points });
process.stdout.write(`${points.length} point size chart ditulis ke ${collection}\n`);
