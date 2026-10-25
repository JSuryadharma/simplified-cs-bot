// Permintaan aset gambar (size chart, katalog warna, price list) dijawab dengan gambar yang cocok,
// bukan eskalasi. Diterapkan ke workflow "WA Admin - Sistem Lengkap" (file JSON hasil export n8n).
//   node scripts/apply-asset-request-guard.mjs <input.json> <output.json>
//
// 1. Siapkan Keputusan AI: knowledge membawa asset_kind/produk; kode mencocokkan permintaan pelanggan
//    (jenis aset + produk) dengan image_asset di knowledge_relevan dan mengirim hasilnya ke model sebagai
//    permintaan_aset; aturan prompt baru: aset yang cocok = jawaban, bukan alasan ESCALATE; size chart
//    tidak boleh diganti foto/mockup produk dan sebaliknya.
// 2. Parse Keputusan AI: kata "size chart", "tabel ukuran", "price list", dst. dihitung sebagai permintaan
//    gambar; aset pilihan model yang jenisnya salah dibuang; bila model eskalasi/gagal tetapi ada tepat
//    satu aset yang cocok dan pesan tidak menanyakan hal lain (harga, stok, jadwal), sistem membalas
//    otomatis dengan aset itu.
// Skrip idempoten.
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('pakai: node scripts/apply-asset-request-guard.mjs <input.json> <output.json>');
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const workflow = Array.isArray(raw) ? raw[0] : raw;
const must = (name) => { const n = workflow.nodes.find((x) => x.name === name); if (!n) throw new Error(`node "${name}" tidak ditemukan`); return n; };
const replaceOnce = (code, from, to, label) => {
  if (!code.includes(from)) throw new Error(`pola "${label}" tidak ditemukan`);
  return code.replace(from, to);
};

// ---------------------------------------------------------------- 1. Siapkan Keputusan AI
const MATCHER = `// Pencocokan permintaan aset (size chart / katalog / price list / contoh produk) dengan image_asset yang ditemukan
const normAset = (s) => String(s || '').toLowerCase()
  .replace(/t\\s*-?\\s*shirt|\\btee\\b/g, 'kaos').replace(/jacket/g, 'jaket').replace(/celemek/g, 'apron')
  .replace(/tote\\s*bag|goodie\\s*bag|\\btas\\b/g, 'tote').replace(/id\\s*card/g, 'idcard')
  .replace(/size\\s*-?\\s*chart|tabel\\s+ukuran|daftar\\s+ukuran|chart\\s+ukuran|panduan\\s+ukuran|ukuran\\s+badan/g, 'sizechart')
  .replace(/price\\s*-?\\s*list|daftar\\s+harga|list\\s+harga/g, 'pricelist')
  .replace(/pilihan\\s+warna|color\\s*chart|swatch|contoh\\s+warna|warna\\s+kain/g, 'katalog');
const PRODUK = ['jaket', 'kaos', 'hoodie', 'sweater', 'crewneck', 'boxy', 'oversize', 'polo', 'kemeja', 'seragam', 'batik', 'varsity', 'jersey', 'tote', 'spunbond', 'topi', 'lanyard', 'idcard', 'apron', 'label', 'drill'];
const PAKAIAN = ['jaket', 'kaos', 'hoodie', 'sweater', 'crewneck', 'boxy', 'oversize', 'polo', 'kemeja', 'varsity'];
const STRUKTUR = ['size_chart', 'katalog', 'price_list'];
const produkDari = (s) => PRODUK.filter((p) => s.includes(p));
// Kelas aset: size_chart / katalog / price_list, sisanya (contoh produk/desain/referensi) = foto
const jenisAset = (e) => {
  if (STRUKTUR.includes(e.asset_kind)) return e.asset_kind;
  if (e.asset_kind) return 'foto';
  const t = normAset([e.asset_description, e.asset_caption, e.text].join(' '));
  return t.includes('sizechart') ? 'size_chart' : t.includes('pricelist') ? 'price_list' : /katalog/.test(t) ? 'katalog' : 'foto';
};
// asset_detail = jenis asli (contoh_produk, referensi_detail, ...), asset_kind = kelas untuk pencocokan
knowledge.forEach((e) => { if (e.content_type === 'image_asset') { e.asset_detail = e.asset_detail || e.asset_kind || ''; e.asset_kind = jenisAset(e); } });
const teksPermintaan = normAset(((ctx.recent_messages || []).filter((m) => m.sender === 'customer').slice(-2).map((m) => m.text).join(' ')) + ' ' + ctx.message_text);
const pesanTerakhir = normAset(ctx.message_text);
const produkDiminta = produkDari(teksPermintaan);
const tanyaUkuran = /\\bukuran\\b|\\bsize\\b/.test(pesanTerakhir) && (PAKAIAN.some((p) => teksPermintaan.includes(p)) || /ada apa|apa aja|apa saja|tersedia|berapa aja/.test(pesanTerakhir));
const jenisDiminta = /sizechart/.test(pesanTerakhir) || tanyaUkuran ? 'size_chart'
  : /pricelist/.test(pesanTerakhir) ? 'price_list'
  : /katalog/.test(pesanTerakhir) ? 'katalog'
  : /contoh|foto|gambar|mock\\s*up|referensi|portofolio/.test(pesanTerakhir) && produkDiminta.length ? 'foto' : '';
const kandidatAset = jenisDiminta ? knowledge
  .filter((e) => e.content_type === 'image_asset' && e.asset_id && e.asset_path && String(e.mime_type).startsWith('image/') && jenisAset(e) === jenisDiminta)
  .map((e) => {
    const produkAset = produkDari(normAset([e.produk, e.asset_description, e.asset_caption, e.tags, e.text].join(' ')));
    const cocok = produkDiminta.filter((p) => produkAset.includes(p)).length;
    return { entry: e, skor: cocok * 10 - produkAset.length + Number(e.score || 0) + (String(e.asset_detail).startsWith('contoh') ? 5 : 0), cocok };
  })
  .filter((k) => produkDiminta.length ? k.cocok > 0 : true)
  .sort((a, b) => b.skor - a.skor) : [];
// Tanpa produk yang disebut dan lebih dari satu kandidat -> ambigu, biarkan model bertanya
const asetCocok = kandidatAset.length && (produkDiminta.length || kandidatAset.length === 1) ? kandidatAset[0].entry : null;
const assetRequest = { kind: jenisDiminta, produk: produkDiminta, match: asetCocok, kandidat: kandidatAset.map((k) => k.entry.asset_id),
  kandidat_produk: [...new Set(kandidatAset.map((k) => String(k.entry.produk || '').split('/')[0].trim()).filter(Boolean))] };
`;

const prep = must('Siapkan Keputusan AI');
let code = prep.parameters.jsCode;
if (!code.includes('assetRequest')) {
  code = replaceOnce(code, "  mime_type: p.payload?.mime_type || ''\n}));",
    "  mime_type: p.payload?.mime_type || '',\n  asset_kind: p.payload?.asset_kind || '',\n  produk: p.payload?.produk || '',\n  tags: Array.isArray(p.payload?.tags) ? p.payload.tags.join(', ') : (p.payload?.tags || '')\n}));\n\n" + MATCHER,
    'knowledge map');

  const m = code.match(/\n(\d+)\. Output wajib mengikuti JSON schema\./);
  if (!m) throw new Error('aturan "Output wajib" tidak ditemukan');
  const n = Number(m[1]);
  const rules = [
    `${n}. PERMINTAAN ASET (size chart/tabel ukuran, katalog warna, price list, contoh foto/desain): image_asset yang jenis dan produknya cocok dengan permintaan ADALAH jawaban. Pilih AUTO_REPLY, isi asset_id persis, dan tulis reply pengantar singkat (mis. "Baik kak, berikut size chart jaket kami ya 🙏"). Jangan ESCALATE hanya karena tidak ada chat_qa; gambar itu sudah menjawab.`,
    `${n + 1}. permintaan_aset.aset_cocok adalah hasil pencocokan sistem (jenis aset + produk). Jika terisi, pakai asset_id itu kecuali pesan jelas meminta hal lain.`,
    `${n + 2}. Size chart, katalog warna, dan price list BUKAN foto/mockup produk. Untuk permintaan size chart jangan kirim foto/mockup produk (mis. desain jaket varsity), dan untuk permintaan contoh desain/foto jangan kirim size chart.`,
    `${n + 3}. Untuk permintaan gambar, ESCALATE hanya jika tidak ada satu pun image_asset yang cocok jenis dan produknya. Jika pesan juga menanyakan hal lain yang tidak ada di knowledge (mis. harga), tetap ESCALATE.`,
    `${n + 4}. Output wajib mengikuti JSON schema.`,
  ].join('\n');
  code = code.replace(`${n}. Output wajib mengikuti JSON schema.`, rules);

  code = replaceOnce(code, '  knowledge_relevan: knowledge\n};',
    "  knowledge_relevan: knowledge,\n  permintaan_aset: assetRequest.kind ? { jenis: assetRequest.kind, produk: assetRequest.produk, aset_cocok: asetCocok ? asetCocok.asset_id : '', kandidat: assetRequest.kandidat } : null\n};",
    'payload');
  code = replaceOnce(code, '  context: ctx,\n  knowledge,', '  context: ctx,\n  knowledge,\n  assetRequest,', 'return json');
  prep.parameters.jsCode = code;
}

// ---------------------------------------------------------------- 2. Parse Keputusan AI
const parse = must('Parse Keputusan AI');
let pcode = parse.parameters.jsCode;
if (!pcode.includes('assetRequest')) {
  const oldGuard = pcode.slice(pcode.indexOf('// Gambar hanya dikirim bila pelanggan'), pcode.indexOf('return [{ json: {'));
  if (!oldGuard.includes('askedForImage')) throw new Error('blok penjaga gambar tidak ditemukan');
  const newGuard = `// Gambar hanya dikirim bila pelanggan meminta contoh/gambar/size chart pada pesan terakhirnya
const assetRequest = prep.assetRequest || {};
const recentCustomerText = (ctx.recent_messages || []).filter((m) => m.sender === 'customer').slice(-2).map((m) => m.text).join(' ') || ctx.message_text;
const askedForImage = Boolean(assetRequest.kind) ||
  /gambar|foto|contoh|katalog|referensi|lihat|desain|model|pic|photo|size\\s*-?\\s*chart|tabel\\s+ukuran|price\\s*-?\\s*list|daftar\\s+harga|mockup/i.test(recentCustomerText);
const isImageEntry = (entry) => entry.content_type === 'image_asset' && entry.asset_id && entry.asset_path && String(entry.mime_type).startsWith('image/');
const requestedAssetId = String(parsed.asset_id || '').trim();
let selectedAsset = askedForImage ? (prep.knowledge.find((entry) => isImageEntry(entry) && entry.asset_id === requestedAssetId) || null) : null;
// Aset pilihan model yang jenisnya beda dengan permintaan (mis. mockup jaket untuk "size chart jaket") dibuang
const matched = assetRequest.match || null;
let wrongKind = false;
if (selectedAsset && matched && selectedAsset.asset_id !== matched.asset_id && selectedAsset.asset_kind !== matched.asset_kind) { selectedAsset = null; wrongKind = true; }
// Untuk permintaan contoh produk, aset pilihan model harus produk yang sama (mis. bukan seragam untuk "contoh topi")
if (selectedAsset && matched && assetRequest.kind === 'foto' && !(assetRequest.kandidat || []).includes(selectedAsset.asset_id)) { selectedAsset = null; wrongKind = true; }
// Gambar referensi (detail/ukuran/model) bukan jawaban untuk "minta contoh" bila ada contoh produk/desain yang cocok
if (selectedAsset && matched && assetRequest.kind === 'foto' && String(selectedAsset.asset_detail).startsWith('referensi') && String(matched.asset_detail).startsWith('contoh')) { selectedAsset = null; wrongKind = true; }
// Pesan yang juga menanyakan hal yang butuh owner (harga, stok, jadwal, pesanan) tidak dijawab otomatis oleh sistem
const asksOther = /harga|biaya|ongkir|diskon|\\bstok\\b|kapan|deadline|tanggal|resi|pesanan saya|order saya|nego/i.test(ctx.message_text);
let assetOverride = false;
if (!selectedAsset && matched && (action === 'AUTO_REPLY' || !asksOther)) {
  // Ada aset yang cocok tetapi model eskalasi/gagal/lupa asset_id/memilih aset yang salah: kirim aset itu
  selectedAsset = matched;
  if (action !== 'AUTO_REPLY' || !reply || isGreeting || wrongKind || requestedAssetId) {
    const produk = String(matched.produk || '').split('/')[0].trim();
    const label = matched.asset_kind === 'size_chart' ? 'size chart ' + produk + ' kami'
      : matched.asset_kind === 'price_list' ? 'price list ' + produk + ' kami'
      : matched.asset_kind === 'katalog' ? 'katalog warna ' + produk + ' kami' : 'contoh ' + produk + ' kami';
    reply = 'Baik kak, berikut ' + label.replace(/\\s+/g, ' ').trim() + ' ya 🙏';
    assetOverride = true;
  }
  action = 'AUTO_REPLY';
} else if (!selectedAsset && !matched && action !== 'AUTO_REPLY' && !asksOther && (assetRequest.kandidat_produk || []).length > 1) {
  // Minta size chart/katalog tanpa menyebut produk: tanyakan produknya, jangan eskalasi
  const daftar = assetRequest.kandidat_produk;
  reply = 'Boleh tahu untuk produk apa kak? Kami punya ' + (assetRequest.kind === 'size_chart' ? 'size chart ' : assetRequest.kind === 'katalog' ? 'katalog ' : assetRequest.kind === 'price_list' ? 'price list ' : '') +
    daftar.slice(0, -1).join(', ') + ' dan ' + daftar[daftar.length - 1] + ' 🙏';
  action = 'AUTO_REPLY';
  assetOverride = true;
}

`;
  pcode = pcode.replace(oldGuard, newGuard);
  pcode = replaceOnce(pcode, '  selected_asset: action === \'AUTO_REPLY\' ? selectedAsset : null\n',
    "  selected_asset: action === 'AUTO_REPLY' ? selectedAsset : null,\n  asset_override: assetOverride\n", 'selected_asset');
  parse.parameters.jsCode = pcode;
}

fs.writeFileSync(output, JSON.stringify(Array.isArray(raw) ? [workflow] : workflow, null, 2));
process.stdout.write(`penjaga permintaan aset diterapkan: ${output}\n`);
