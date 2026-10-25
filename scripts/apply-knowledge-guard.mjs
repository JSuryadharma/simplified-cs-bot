// Sesuaikan keputusan AI dengan knowledge berlabel (knowledge/dataset, scripts/import-knowledge.mjs).
//   node scripts/apply-knowledge-guard.mjs <input.json> <output.json>
// Jalankan setelah scripts/apply-asset-request-guard.mjs.
//
// 1. Siapkan Keputusan AI: knowledge membawa category, auto_reply, valid_from; aturan prompt untuk
//    price_list (boleh dikutip) vs price_reference (harga deal lama, hanya untuk owner).
// 2. Parse Keputusan AI: penjaga nominal. Balasan otomatis yang menyebut nominal rupiah yang tidak ada
//    di knowledge yang boleh dijawab / data order dialihkan ke owner. Saat eskalasi pertanyaan harga,
//    referensi harga sebelumnya ditambahkan ke pertanyaan untuk owner.
// Skrip idempoten.
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('pakai: node scripts/apply-knowledge-guard.mjs <input.json> <output.json>');
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const workflow = Array.isArray(raw) ? raw[0] : raw;
const must = (name) => { const n = workflow.nodes.find((x) => x.name === name); if (!n) throw new Error(`node "${name}" tidak ditemukan`); return n; };
const replaceOnce = (code, from, to, label) => {
  if (!code.includes(from)) throw new Error(`pola "${label}" tidak ditemukan`);
  return code.replace(from, to);
};

// ---------------------------------------------------------------- 1. Siapkan Keputusan AI
const prep = must('Siapkan Keputusan AI');
let code = prep.parameters.jsCode;
if (!code.includes('auto_reply:')) {
  if (!code.includes('assetRequest')) throw new Error('jalankan scripts/apply-asset-request-guard.mjs lebih dulu');
  code = replaceOnce(code, "  content_type: p.payload?.content_type || 'chat_qa',\n",
    "  content_type: p.payload?.content_type || 'chat_qa',\n  category: p.payload?.category || '',\n  auto_reply: p.payload?.auto_reply !== false && p.payload?.content_type !== 'price_reference',\n  valid_from: p.payload?.valid_from || '',\n",
    'knowledge content_type');
  const m = code.match(/\n(\d+)\. Output wajib mengikuti JSON schema\./);
  if (!m) throw new Error('aturan "Output wajib" tidak ditemukan');
  const n = Number(m[1]);
  const rules = [
    `${n}. HARGA: knowledge content_type "price_list" adalah daftar harga resmi dan boleh dikutip apa adanya. Knowledge dengan auto_reply=false (content_type "price_reference") adalah harga deal pesanan lain: JANGAN dikutip ke pelanggan. Pertanyaan harga yang tidak tercakup price_list: pilih ESCALATE dan cantumkan referensi harga itu di owner_question agar owner cepat menjawab.`,
    `${n + 1}. Jangan menulis nominal rupiah apa pun di reply yang tidak tertulis di knowledge dengan auto_reply=true atau di data_order.`,
    `${n + 2}. Bila ada beberapa knowledge yang mirip, utamakan yang valid_from-nya paling baru.`,
    `${n + 3}. Output wajib mengikuti JSON schema.`,
  ].join('\n');
  code = code.replace(`${n}. Output wajib mengikuti JSON schema.`, rules);
  prep.parameters.jsCode = code;
}
// Model OpenRouter adalah model reasoning: 700 token habis untuk berpikir sehingga balasan terpotong
prep.parameters.jsCode = prep.parameters.jsCode.replace(/max_tokens: 700,/, 'max_tokens: 2500,');

// Pencarian: pesan terakhir saja + gabungan 2 pesan terakhir, digabung dengan RRF. Pertanyaan baru tidak
// tenggelam oleh topik pesan sebelumnya, dan "ada contoh gambarnya?" tetap mendapat konteks.
must('Embedding Pertanyaan').parameters.jsonBody =
  "={{ JSON.stringify({ model: $env.LM_STUDIO_EMBEDDING_MODEL, input: ['search_query: ' + $json.message_text, 'search_query: ' + (($json.recent_messages || []).filter((m) => m.sender === 'customer').slice(-2).map((m) => m.text).join('\\n') || $json.message_text)] }) }}";
must('Cari Knowledge Qdrant').parameters.jsonBody =
  "={{ JSON.stringify({ prefetch: ($json.data || []).map((d) => ({ query: d.embedding, limit: 10, score_threshold: Number($env.QDRANT_SCORE_THRESHOLD || 0.72) })), query: { fusion: 'rrf' }, limit: 12, with_payload: true }) }}";

// ---------------------------------------------------------------- 2. Parse Keputusan AI
const parse = must('Parse Keputusan AI');
let pcode = parse.parameters.jsCode;
if (!pcode.includes('PENJAGA_NOMINAL')) {
  const guard = `// PENJAGA_NOMINAL: nominal rupiah di balasan otomatis harus berasal dari knowledge yang boleh dijawab atau data order
const toRupiah = (raw) => {
  const s = String(raw).toLowerCase().replace(/\\s+/g, '');
  const unit = /jt|juta/.test(s) ? 1e6 : /rb|ribu|k$/.test(s) ? 1e3 : 1;
  const num = s.replace(/[^\\d.,]/g, '');
  const value = unit > 1 ? Number(num.replace(',', '.')) : Number(num.replace(/[.,]/g, ''));
  return Math.round(value * unit);
};
const nominalDari = (s) => (String(s || '').match(/\\d{1,3}(?:[.,]\\d{3})+|\\d+(?:[.,]\\d+)?\\s*(?:rb|ribu|jt|juta|k)\\b/gi) || []).map(toRupiah).filter((v) => v >= 1000);
const nominalBoleh = new Set([
  ...prep.knowledge.filter((e) => e.auto_reply !== false && e.content_type !== 'price_reference').flatMap((e) => nominalDari(e.answer + ' ' + e.text)),
  ...nominalDari(JSON.stringify(ctx.orders || [])),
  ...nominalDari(ctx.message_text),
]);
// Total = harga satuan yang diizinkan x jumlah pcs/lusin yang disebut pelanggan juga boleh
const jumlah = (String(ctx.message_text).match(/(\\d+)\\s*(pcs|pc|buah|biji|lusin)/gi) || [])
  .map((m) => { const n = parseInt(m, 10); return /lusin/i.test(m) ? n * 12 : n; });
for (const harga of [...nominalBoleh]) for (const q of jumlah) nominalBoleh.add(harga * q);
const nominalAsing = action === 'AUTO_REPLY' ? nominalDari(reply).filter((v) => !nominalBoleh.has(v)) : [];
if (nominalAsing.length) {
  action = 'ESCALATE';
  parsed.needs_summary = 'Pelanggan menanyakan: ' + ctx.message_text;
  parsed.owner_question = 'Mohon konfirmasi harga/nominal untuk pertanyaan pelanggan ini (balasan otomatis ditahan karena nominalnya tidak ada di knowledge).';
}
// Saat eskalasi pertanyaan harga, sertakan referensi harga sebelumnya untuk owner
if (action !== 'AUTO_REPLY' && /harga|biaya|berapa|price|ongkir/i.test(ctx.message_text)) {
  // Hanya referensi yang topiknya sama dengan pertanyaan (kata >= 4 huruf yang sama)
  const kata = new Set(String(ctx.message_text).toLowerCase().match(/[a-z]{4,}/g) || []);
  const refs = prep.knowledge.filter((e) => e.content_type === 'price_reference')
    .filter((e) => (String(e.question + ' ' + e.answer).toLowerCase().match(/[a-z]{4,}/g) || []).some((w) => kata.has(w) && !['harga', 'berapa', 'untuk', 'kalau', 'pesan'].includes(w)))
    .slice(0, 2).map((e) => '- ' + e.answer);
  if (refs.length) parsed.owner_question = String(parsed.owner_question || 'Mohon berikan harga untuk pertanyaan pelanggan ini.').trim() + '\\nReferensi harga sebelumnya:\\n' + refs.join('\\n');
}

`;
  pcode = replaceOnce(pcode, 'return [{ json: {\n  action,', guard + 'return [{ json: {\n  action,', 'return');
  // Jawaban terpotong (finish_reason=length) dianggap gagal, bukan dikirim setengah
  pcode = replaceOnce(pcode, 'try { parsed = JSON.parse(content); } catch { parsed = {}; }',
    "try { parsed = JSON.parse(content); } catch { parsed = {}; }\nif ($json.choices?.[0]?.finish_reason === 'length') parsed = {};", 'parse json');
  parse.parameters.jsCode = pcode;
}

fs.writeFileSync(output, JSON.stringify(Array.isArray(raw) ? [workflow] : workflow, null, 2));
process.stdout.write(`penjaga knowledge diterapkan: ${output}\n`);
