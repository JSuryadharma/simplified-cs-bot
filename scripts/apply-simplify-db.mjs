// Sesuaikan workflow dengan skema bot sederhana (db/001-schema.sql: hanya tickets + orders).
//   node scripts/apply-simplify-db.mjs <in.json> <out.json>
// - apply_decision dihapus: keputusan AUTO_REPLY/ESCALATE dari model AI dipakai langsung;
//   DB hanya dipanggil (rpc/open_ticket) bila model memilih ESCALATE, pesan owner disusun di workflow.
// - Node log_delivery dan sinkron knowledge ke Postgres dihapus (knowledge cukup di Qdrant).
// - Profil gaya owner tidak lagi dari tabel style_profile, tetapi konstanta di prompt.
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('pakai: node scripts/apply-simplify-db.mjs <in.json> <out.json>');
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const wf = Array.isArray(raw) ? raw[0] : raw;
const byName = (name) => {
  const node = wf.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`node tidak ditemukan: ${name}`);
  return node;
};

function removeNode(name) {
  wf.nodes = wf.nodes.filter((n) => n.name !== name);
  delete wf.connections[name];
  for (const value of Object.values(wf.connections)) {
    for (const branch of value.main || []) {
      for (let i = branch.length - 1; i >= 0; i -= 1) if (branch[i].node === name) branch.splice(i, 1);
    }
  }
}
const link = (from, to, branch = 0) => {
  const main = (wf.connections[from] ||= { main: [] }).main;
  while (main.length <= branch) main.push([]);
  main[branch].push({ node: to, type: 'main', index: 0 });
};

// 1. Log pengiriman (leaf node) dan sinkron knowledge ke Postgres
for (const name of ['Log Balasan Otomatis', 'Log Aset Gambar', 'Log Eskalasi', 'Simpan Knowledge DB', 'Sinkron DB Knowledge?']) removeNode(name);
link('Upsert Knowledge v2', 'Ringkasan Impor Knowledge');

// 2. apply_decision -> IF ESCALATE -> rpc/open_ticket
const save = byName('Simpan Keputusan');
const [x, y] = save.position;
removeNode('Simpan Keputusan');
wf.nodes.push(
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{
          id: '00000000-0000-4000-8000-0000000f0001',
          leftValue: '={{ $json.action }}',
          rightValue: 'ESCALATE',
          operator: { type: 'string', operation: 'equals' },
        }],
        combinator: 'and',
      },
      options: {},
    },
    id: '00000000-0000-4000-8000-0000000f0002',
    name: 'Perlu Tiket?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [x, y],
  },
  {
    parameters: {
      method: 'POST',
      url: '={{$env.DB_API_URL + "/rpc/open_ticket"}}',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({
        p_phone: $('Hasil Customer').first().json.customer_phone,
        p_name: $('Hasil Customer').first().json.customer_name,
        p_question: $json.customer_message,
        p_summary: $json.needs_summary,
        p_owner_question: $json.owner_question
      }) }}`,
      options: {},
    },
    id: '00000000-0000-4000-8000-0000000f0003',
    name: 'Buka Tiket',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.4,
    position: [x + 220, y - 120],
  },
);
link('Parse Keputusan AI', 'Perlu Tiket?');
link('Perlu Tiket?', 'Buka Tiket', 0);
link('Perlu Tiket?', 'Hasil Keputusan DB', 1);
link('Buka Tiket', 'Hasil Keputusan DB');

byName('Hasil Keputusan DB').parameters.jsCode = `// Bentuk hasil keputusan untuk cabang berikutnya (balas otomatis / eskalasi ke owner).
const decision = $('Parse Keputusan AI').first().json;
const ctx = $('Hasil Customer').first().json;
if (decision.action !== 'ESCALATE') {
  return [{ json: { action: 'auto_reply', customer_phone: ctx.customer_phone, reply: decision.reply } }];
}
const raw = $input.first().json;
const t = Array.isArray(raw) ? (raw[0] ?? {}) : (raw?.result && Object.keys(raw).length === 1 ? raw.result : raw);
const summary = String(decision.needs_summary || '').trim() || '-';
const ask = String(decision.owner_question || '').trim() || '-';
const lines = [
  '🚨 *Butuh jawaban owner*',
  'Tiket: #' + t.ticket_code,
  'Pelanggan: ' + (t.customer_name || 'Pelanggan') + ' (' + t.customer_phone + ')',
  '',
  ...(t.previous_question ? ['*Pertanyaan baru* (tiket ini masih terbuka)', ''] : []),
  '*Pesan pelanggan:*', t.new_question, '',
  '*Ringkasan kebutuhan:*', summary, '',
  '*Yang perlu dijawab:*', ask, '',
  ...(t.previous_question ? ['*Pertanyaan sebelumnya di tiket ini:*', t.previous_question, ''] : []),
  'Balas dengan format:', '#' + t.ticket_code + ' <jawaban untuk pelanggan>',
  ...(t.previous_question ? ['(satu jawaban untuk semua pertanyaan di tiket ini)'] : []),
];
return [{ json: { action: 'escalate', ticket_id: t.ticket_id, ticket_code: t.ticket_code, owner_message: lines.join('\\n') } }];`;

// 3. Profil gaya owner sebagai konstanta (tabel style_profile dihapus)
const STYLE = 'Owner (Bu Debi / admin SaViOr) membalas singkat, hangat, dan santai. Sapaan sesuai waktu: "pagi..", "siang kak..", "sore bu.."; panggil "kak" untuk pelanggan muda/umum, "bu"/"pak" untuk pelanggan yang lebih tua. Sering membuka dengan "baik.." atau "iya bisa kak.." lalu langsung ke inti. Kalimat pendek, sering diakhiri titik dua (..), memakai singkatan chat (y, yg, bs, dl, brp, ny, sdh) tetapi tetap jelas. Emoji secukupnya: 🤗 🙏🏻. Harga ditulis berbentuk daftar per ukuran ("uk S, M : 65rb"). Bila belum pasti, owner berkata akan mengecek/menghitungkan dulu, bukan menebak. Selalu menanyakan detail yang dibutuhkan untuk produksi: model, jenis kain, warna, sablon/bordir, jumlah per ukuran, dan tanggal dibutuhkan. Tidak menyebut AI atau sistem.';
const prep = byName('Siapkan Keputusan AI');
if (!prep.parameters.jsCode.includes('profil_gaya_owner: ctx.style_profile,')) throw new Error('profil_gaya_owner tidak ditemukan');
prep.parameters.jsCode = prep.parameters.jsCode.replace('profil_gaya_owner: ctx.style_profile,', `profil_gaya_owner: ${JSON.stringify(STYLE)},`);

const leftover = JSON.stringify(wf.nodes).match(/rpc\/(apply_decision|log_delivery|import_knowledge|save_style_and_knowledge)/g);
if (leftover) throw new Error(`masih ada pemanggilan RPC lama: ${leftover.join(', ')}`);
fs.writeFileSync(output, JSON.stringify(Array.isArray(raw) ? [wf] : wf));
process.stdout.write(`${wf.nodes.length} node -> ${output}\n`);
