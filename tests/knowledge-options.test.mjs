// Tes untuk cabang "Opsi Knowledge" (pesan interaktif WhatsApp berisi pertanyaan lain dari knowledge):
// - node "Siapkan Opsi Knowledge" (workflows/snippets/opsi-knowledge.js, harus sama dengan isi node),
// - node "Normalisasi dan Verifikasi" untuk opsi yang diketuk pelanggan,
// - wiring workflow: cabang hanya tambahan, alur lama tetap.
// Jalankan: node tests/knowledge-options.test.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const snippet = readFileSync(new URL('../workflows/snippets/opsi-knowledge.js', import.meta.url), 'utf8');
const [workflow] = JSON.parse(readFileSync(new URL('../workflows/wa-admin-lengkap.json', import.meta.url), 'utf8'));
const node = (name) => {
  const found = workflow.nodes.find((n) => n.name === name);
  assert.ok(found, `node "${name}" ada`);
  return found;
};
const targets = (name, output = 0) => (workflow.connections[name]?.main?.[output] || []).map((c) => c.node);

const kb = (question, answer, extra = {}) => ({ content_type: 'chat_qa', auto_reply: true, question, answer, ...extra });
const KNOWLEDGE = [
  kb('Berapa minimal order kaos?', 'Minimal order kaos 24 pcs ya kak, boleh campur ukuran.'),
  kb('Berapa lama proses produksi?', 'Produksi sekitar 14 hari kerja setelah desain final dan DP masuk.'),
  kb('Bisa sablon dan bordir?', 'Bisa kak, tersedia sablon plastisol, DTF, dan bordir komputer.'),
  kb('Harga kaos cotton combed 30s', 'Rp 85.000', { content_type: 'price_reference', auto_reply: false }),
  kb('Contoh jaket', '', { content_type: 'image_asset' }),
  kb('Apakah bisa kirim ke luar kota?', 'Bisa kak, pengiriman via ekspedisi ke seluruh Indonesia.'),
  kb('Bisa minta sampel dulu?', 'Untuk sampel mohon tunggu konfirmasi dari owner ya kak.'),
  kb('Cara order bagaimana?', 'Kirim desain, jumlah per ukuran, lalu kami kirim penawaran dan mockup.')
];

const run = (decision = {}, env = {}, ctx = {}) => {
  const nodes = {
    'Parse Keputusan AI': {
      action: 'AUTO_REPLY',
      reply: 'Minimal order kaos 24 pcs ya kak, boleh campur ukuran 🙏',
      customer_message: 'min order kaos brp kak',
      knowledge_used: KNOWLEDGE,
      is_greeting: false,
      ticket_followup: false,
      ...decision
    },
    'Hasil Customer': { customer_phone: '6281200000001', message_text: 'min order kaos brp kak', ...ctx }
  };
  const $ = (name) => ({ first: () => ({ json: nodes[name] }) });
  const out = new Function('$', '$env', snippet)($, env);
  assert.equal(out.length, 1);
  return out[0].json;
};

const normalize = (message, env = {}) => {
  const body = { entry: [{ changes: [{ value: { contacts: [{ wa_id: message.from, profile: { name: 'Pelanggan 1' } }], messages: [message] } }] }] };
  const $input = { first: () => ({ json: { body, headers: {} } }) };
  return new Function('require', '$input', '$env', node('Normalisasi dan Verifikasi').parameters.jsCode)(require, $input, env).map((i) => i.json);
};

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('isi node "Siapkan Opsi Knowledge" sama dengan snippet', () => {
  assert.equal(node('Siapkan Opsi Knowledge').parameters.jsCode, snippet);
});

test('opsi diambil dari knowledge lain yang boleh dijawab otomatis', () => {
  const r = run();
  assert.equal(r.send_options, true);
  assert.deepEqual(r.options, ['Berapa lama proses produksi?', 'Bisa sablon dan bordir?', 'Apakah bisa kirim ke luar kota?']);
  for (const q of r.options) assert.ok(!/minimal order|Harga|Contoh|sampel/i.test(q), `opsi tidak boleh: ${q}`);
});

test('payload list message valid untuk WhatsApp Cloud API', () => {
  const p = run().whatsapp_payload;
  assert.equal(p.messaging_product, 'whatsapp');
  assert.equal(p.to, '6281200000001');
  assert.equal(p.type, 'interactive');
  assert.equal(p.interactive.type, 'list');
  assert.ok(p.interactive.body.text.length <= 1024);
  assert.ok(p.interactive.action.button.length <= 20);
  assert.ok(p.interactive.footer.text.length <= 60);
  const rows = p.interactive.action.sections[0].rows;
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(row.id.startsWith('kb:') && row.id.length <= 200);
    assert.ok(row.title.length <= 24, `title terlalu panjang: ${row.title}`);
    if (row.description) assert.ok(row.description.length <= 72);
  }
  assert.equal(rows[0].id, 'kb:Berapa lama proses produksi?');
});

test('pertanyaan pendek (<= 20 huruf, maks 3) dikirim sebagai tombol', () => {
  const r = run({ knowledge_used: [kb('Min order?', 'x 24 pcs'), kb('Lama produksi?', '14 hari kerja'), kb('Bisa bordir?', 'Bisa kak')] });
  const i = r.whatsapp_payload.interactive;
  assert.equal(i.type, 'button');
  assert.deepEqual(i.action.buttons.map((b) => b.reply), [
    { id: 'kb:Lama produksi?', title: 'Lama produksi?' },
    { id: 'kb:Bisa bordir?', title: 'Bisa bordir?' }
  ]);
});

test('jumlah opsi mengikuti WA_KNOWLEDGE_OPTIONS_MAX', () => {
  assert.equal(run({}, { WA_KNOWLEDGE_OPTIONS_MAX: '1' }).options.length, 1);
  assert.equal(run({}, { WA_KNOWLEDGE_OPTIONS_MAX: '10' }).options.length, 4);
});

test('tidak dikirim saat dimatikan, eskalasi, sapaan, tiket menunggu owner, atau bot bertanya balik', () => {
  assert.equal(run({}, { WA_KNOWLEDGE_OPTIONS: 'false' }).send_options, false);
  assert.equal(run({ action: 'ESCALATE', reply: '' }).send_options, false);
  assert.equal(run({ is_greeting: true }).send_options, false);
  assert.equal(run({ ticket_followup: true }).send_options, false);
  assert.equal(run({ reply: 'Boleh tahu untuk produk apa kak? 🙏' }).send_options, false);
});

test('tanpa knowledge lain yang relevan tidak dikirim', () => {
  assert.equal(run({ knowledge_used: [KNOWLEDGE[0]] }).send_options, false);
  assert.equal(run({ knowledge_used: [] }).send_options, false);
  assert.equal(run({ knowledge_used: undefined }).send_options, false);
});

test('opsi yang jawabannya sama dengan balasan barusan dibuang', () => {
  const r = run({ reply: 'Produksi sekitar 14 hari kerja setelah desain final dan DP masuk ya kak.', customer_message: 'berapa lama jadinya' });
  assert.ok(!r.options.includes('Berapa lama proses produksi?'));
});

test('pertanyaan yang hampir sama hanya muncul sekali', () => {
  const r = run({ knowledge_used: [KNOWLEDGE[0], kb('Saya mau order / pesan, bisa?', 'Bisa kak, kirim desainnya.'), kb('Saya mau order jaket, bisa?', 'Bisa kak, jaket juga.'), KNOWLEDGE[2]] });
  assert.deepEqual(r.options, ['Saya mau order / pesan, bisa?', 'Bisa sablon dan bordir?']);
  assert.equal(r.whatsapp_payload.interactive.action.sections[0].rows[0].title, 'Saya mau order…');
});

test('opsi yang diketuk (list) jadi teks pertanyaan lengkap', () => {
  const [m] = normalize({ from: '6281200000001', id: 'wamid.1', timestamp: '1764300000', type: 'interactive',
    interactive: { type: 'list_reply', list_reply: { id: 'kb:Apakah bisa kirim ke luar kota?', title: 'Apakah bisa kirim ke…' } } });
  assert.equal(m.kind, 'message');
  assert.equal(m.text, 'Apakah bisa kirim ke luar kota?');
  assert.equal(m.knowledge_option, true);
  assert.equal(m.message_type, 'interactive');
});

test('opsi yang diketuk (tombol) jadi teks pertanyaan', () => {
  const [m] = normalize({ from: '6281200000001', id: 'wamid.2', type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'kb:Bisa bordir?', title: 'Bisa bordir?' } } });
  assert.equal(m.text, 'Bisa bordir?');
});

test('pesan teks dan interaktif lain tetap seperti sebelumnya', () => {
  const [t] = normalize({ from: '6281200000001', id: 'wamid.3', type: 'text', text: { body: ' halo kak ' } });
  assert.equal(t.text, 'halo kak');
  assert.equal(t.knowledge_option, false);
  const [b] = normalize({ from: '6281200000001', id: 'wamid.4', type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'lain-123', title: 'Ya' } } });
  assert.equal(b.text, 'Ya');
  assert.equal(b.knowledge_option, false);
  const [i] = normalize({ from: '6281200000001', id: 'wamid.5', type: 'image', image: {} });
  assert.match(i.text, /tipe image/);
});

test('cabang opsi hanya tambahan di ujung alur balasan otomatis', () => {
  // alur lama tetap
  assert.deepEqual(targets('Balas Otomatis?', 0), ['Pecah Balasan']);
  assert.deepEqual(targets('Balas Otomatis?', 1), ['Eskalasi ke Owner']);
  assert.deepEqual(targets('Pecah Balasan'), ['Loop Chat Balasan']);
  assert.deepEqual(targets('Loop Chat Balasan', 1), ['Kirim Balasan Otomatis']);
  assert.deepEqual(targets('Balasan Terkirim Semua'), ['Ada Aset Gambar?']);
  assert.deepEqual(targets('Ada Aset Gambar?', 0), ['Baca Aset Gambar']);
  assert.deepEqual(targets('Baca Aset Gambar'), ['Kirim Aset Gambar']);
  assert.deepEqual(targets('Eskalasi ke Owner'), []);
  // cabang baru: setelah gambar (atau tanpa gambar)
  assert.deepEqual(targets('Kirim Aset Gambar'), ['Siapkan Opsi Knowledge']);
  assert.deepEqual(targets('Selesai Tanpa Aset'), ['Siapkan Opsi Knowledge']);
  assert.deepEqual(targets('Siapkan Opsi Knowledge'), ['Ada Opsi Knowledge?']);
  assert.deepEqual(targets('Ada Opsi Knowledge?', 0), ['Kirim Opsi Knowledge']);
  assert.deepEqual(targets('Ada Opsi Knowledge?', 1), ['Tanpa Opsi Knowledge']);
});

test('kirim opsi lewat nomor bisnis dan gagal kirim tidak menggagalkan eksekusi', () => {
  const send = node('Kirim Opsi Knowledge');
  const businessId = node('Kirim Balasan Otomatis').parameters.phoneNumberId.replace(/^=/, '');
  assert.ok(send.parameters.url.includes('/' + businessId + '/messages'));
  assert.equal(send.parameters.nodeCredentialType, 'whatsAppApi');
  assert.deepEqual(send.credentials, node('Kirim Balasan Otomatis').credentials);
  assert.equal(send.onError, 'continueRegularOutput');
  assert.equal(send.parameters.options.response.response.neverError, true);
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
process.exit(failed ? 1 : 0);
