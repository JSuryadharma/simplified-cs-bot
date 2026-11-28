// Tes opsi jawaban dari AI (tombol/list WhatsApp hanya bila AI memberi opsi) dan alur order satu per satu:
// - "Siapkan Keputusan AI": produk_tersedia dari Qdrant, menjawab_opsi, aturan prompt, schema "opsi",
// - "Parse Keputusan AI": membersihkan dan menyaring opsi,
// - "Siapkan Pesan Opsi" (workflows/snippets/opsi-balasan.js): payload interaktif + fallback teks,
// - "Normalisasi dan Verifikasi": opsi yang diketuk,
// - wiring: alur lama tetap, cabang opsi otomatis PR #16 sudah diganti.
// Jalankan: node tests/reply-options.test.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const snippet = readFileSync(new URL('../workflows/snippets/opsi-balasan.js', import.meta.url), 'utf8');
const [workflow] = JSON.parse(readFileSync(new URL('../workflows/wa-admin-lengkap.json', import.meta.url), 'utf8'));
const node = (name) => {
  const found = workflow.nodes.find((n) => n.name === name);
  assert.ok(found, `node "${name}" ada`);
  return found;
};
const code = (name) => node(name).parameters.jsCode;
const targets = (name, output = 0) => (workflow.connections[name]?.main?.[output] || []).map((c) => c.node);
const stub = (nodes) => (name) => ({ first: () => ({ json: nodes[name] }) });
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

const KNOWLEDGE = [{ content_type: 'chat_qa', auto_reply: true, question: 'Saya mau order / pesan, bisa?', answer: 'Bisa kak. Kami menerima pesanan custom kaos, kemeja, jaket, hoodie.' }];
const parse = (decision, { message = 'Iya, saya mau order baju', env, prep = {} } = {}) => {
  const $ = stub({
    'Hasil Customer': { customer_phone: '6281200000001', message_text: message, orders: [], recent_messages: [] },
    'Siapkan Keputusan AI': { knowledge: KNOWLEDGE, assetRequest: {}, ...prep }
  });
  const content = JSON.stringify({ action: 'AUTO_REPLY', confidence: 0.9, reply: '', needs_summary: '', owner_question: '', asset_id: '', followup_tiket_terbuka: false, sapaan: false, opsi: [], ...decision });
  const $json = { choices: [{ finish_reason: 'stop', message: { content } }] };
  const args = ['$', '$json'];
  const vals = [$, $json];
  if (env) { args.push('$env'); vals.push(env); }
  return new Function(...args, code('Parse Keputusan AI'))(...vals)[0].json;
};
const pesanOpsi = (reply, options) => new Function('$', '$input', snippet)(
  stub({ 'Parse Keputusan AI': { options } }),
  { first: () => ({ json: { action: 'auto_reply', customer_phone: '6281200000001', reply, reply_part: 1, reply_parts: 1 } }) }
)[0].json;
const normalize = (message) => {
  const body = { entry: [{ changes: [{ value: { contacts: [{ wa_id: message.from, profile: { name: 'Pelanggan 1' } }], messages: [message] } }] }] };
  return new Function('require', '$input', '$env', code('Normalisasi dan Verifikasi'))(require, { first: () => ({ json: { body, headers: {} } }) }, {}).map((i) => i.json);
};
const siapkan = ({ points, normalisasi = { text: 'Iya, saya mau order baju', answering_question: '' } }) => {
  const $ = stub({
    'Cari Knowledge Qdrant': { result: { points: [] } },
    'Hasil Customer': { customer_name: 'Pelanggan 1', message_text: normalisasi.text, recent_messages: [], orders: [] },
    'Normalisasi dan Verifikasi': normalisasi
  });
  const out = new Function('$', '$input', '$env', code('Siapkan Keputusan AI'))($, { first: () => ({ json: { result: { points } } }) }, { OPENROUTER_MODEL: 'x' })[0].json;
  return { body: out.requestBody, payload: JSON.parse(out.requestBody.messages[1].content), system: out.requestBody.messages[0].content };
};

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('isi node "Siapkan Pesan Opsi" sama dengan snippet', () => {
  assert.equal(code('Siapkan Pesan Opsi'), snippet);
});

test('prompt: order ditanya satu per satu, opsi desain dan jenis produk, schema punya opsi', () => {
  const { system, body, payload } = siapkan({ points: [] });
  assert.match(system, /TANYA SATU PER SATU/);
  assert.match(system, /\["Sudah ada desain", "Butuh referensi"\]/);
  assert.match(system, /Kalau boleh tau kakak mau order jenis apa\?/);
  assert.match(system, /JANGAN menulis daftar opsi/);
  const schema = body.response_format.json_schema.schema;
  assert.deepEqual(schema.properties.opsi, { type: 'array', items: { type: 'string' } });
  assert.ok(schema.required.includes('opsi'));
  assert.equal(payload.menjawab_opsi, null);
  assert.ok(!/model, bahan, warna, sablon\/bordir, jumlah per ukuran, dan tanggal dibutuhkan\. Jangan ESCALATE/.test(system), 'aturan lama "tanya semua detail" sudah diganti');
});

test('produk_tersedia diambil dari Qdrant, urut terbanyak, tanpa nama bahan', () => {
  const points = [
    { payload: { products: ['kaos', 'cotton combed'] } }, { payload: { products: ['kaos'] } }, { payload: { products: ['jaket', 'fleece'] } },
    { payload: { products: ['kaos', 'jersey'] } }, { payload: { produk: 'jaket / varsity' } }, { payload: {} }
  ];
  assert.deepEqual(siapkan({ points }).payload.produk_tersedia, ['kaos', 'jaket', 'jersey', 'varsity']);
  assert.deepEqual(siapkan({ points: undefined }).payload.produk_tersedia, []);
});

test('opsi yang diketuk diteruskan ke AI sebagai menjawab_opsi', () => {
  const { payload } = siapkan({ points: [], normalisasi: { text: 'Butuh referensi desain', answering_question: 'sudah ada desain yang diinginkan?' } });
  assert.deepEqual(payload.menjawab_opsi, { pertanyaan: 'sudah ada desain yang diinginkan?', pilihan: 'Butuh referensi desain', konteks: '' });
});

test('Parse: opsi dari AI dibersihkan (nomor, emoji, duplikat) dan daftar opsi di reply dibuang', () => {
  const r = parse({ reply: 'Bisa kak.. sudah ada desain yang diinginkan?\n1. Sudah ada desain\n2. Butuh referensi desain', opsi: ['1. Sudah ada desain', 'Butuh referensi desain 🙏', 'sudah ada desain'] });
  assert.deepEqual(r.options, ['Sudah ada desain', 'Butuh referensi desain']);
  assert.equal(r.reply, 'Bisa kak.. sudah ada desain yang diinginkan?');
});

test('Parse: tanpa opsi untuk eskalasi, sapaan, tiket menunggu owner, satu opsi, kirim gambar, atau env mati', () => {
  const opsi = ['Kaos', 'Jaket'];
  assert.deepEqual(parse({ action: 'ESCALATE', opsi }).options, []);
  assert.deepEqual(parse({ reply: 'Halo kak, ada yang bisa kami bantu?', sapaan: true, opsi }, { message: 'halo' }).options, []);
  assert.deepEqual(parse({ reply: 'Mau order jenis apa kak?', opsi: ['Kaos'] }).options, []);
  assert.deepEqual(parse({ reply: 'Mau order jenis apa kak?', opsi }, { env: { WA_KNOWLEDGE_OPTIONS: 'false' } }).options, []);
  assert.deepEqual(parse({ reply: 'Mau order jenis apa kak?', opsi }, { env: { WA_KNOWLEDGE_OPTIONS: 'true' } }).options, opsi);
  assert.deepEqual(parse({ reply: 'Mau order jenis apa kak?', opsi: [] }).options, []);
});

test('Parse: "untuk produk apa?" dari sistem otomatis memberi opsi produk', () => {
  const r = parse({ action: 'ESCALATE', reply: '' }, { message: 'minta size chart dong', prep: { assetRequest: { kind: 'size_chart', produk: [], match: null, kandidat: ['a', 'b'], kandidat_produk: ['jaket', 'kaos', 'hoodie'] } } });
  assert.equal(r.action, 'AUTO_REPLY');
  assert.deepEqual(r.options, ['Jaket', 'Kaos', 'Hoodie']);
});

test('pesan opsi: 2 opsi pendek jadi tombol dengan teks balasan', () => {
  const r = pesanOpsi('Baik kak.. sudah ada desain yang diinginkan?', ['Sudah ada desain', 'Butuh referensi desain']);
  const i = r.whatsapp_payload.interactive;
  assert.equal(r.whatsapp_payload.to, '6281200000001');
  assert.equal(i.type, 'list', '"Butuh referensi desain" 22 huruf > 20, jadi list');
  const r2 = pesanOpsi('Baik kak.. sudah ada desain yang diinginkan?', ['Sudah ada', 'Butuh referensi']);
  const b = r2.whatsapp_payload.interactive;
  assert.equal(b.type, 'button');
  assert.equal(b.body.text, 'Baik kak.. sudah ada desain yang diinginkan?');
  assert.deepEqual(b.action.buttons.map((x) => x.reply.title), ['Sudah ada', 'Butuh referensi']);
  assert.equal(b.action.buttons[0].reply.id, 'opt:Sudah ada|q:sudah ada desain yang diinginkan?');
});

test('pesan opsi: jenis produk jadi list yang valid untuk WhatsApp', () => {
  const r = pesanOpsi('Kalau boleh tau kakak mau order jenis apa?', ['Kaos', 'Jaket', 'Jersey', 'Hoodie', 'Polo', 'Kemeja seragam kerja lengan panjang']);
  const i = r.whatsapp_payload.interactive;
  assert.equal(i.type, 'list');
  assert.equal(i.body.text, 'Kalau boleh tau kakak mau order jenis apa?');
  assert.ok(i.action.button.length <= 20);
  const rows = i.action.sections[0].rows;
  assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.ok(row.id.startsWith('opt:') && row.id.length <= 200);
    assert.ok(row.title.length <= 24);
    if (row.description) assert.ok(row.description.length <= 72);
  }
  assert.ok(!EMOJI.test(JSON.stringify(i)));
  assert.equal(r.fallback_reply, 'Kalau boleh tau kakak mau order jenis apa?\n\n1. Kaos\n2. Jaket\n3. Jersey\n4. Hoodie\n5. Polo\n6. Kemeja seragam kerja lengan panjang');
});

test('opsi diketuk: teks = opsi, answering_question = pertanyaan bot (list dan tombol)', () => {
  const id = pesanOpsi('Baik kak.. sudah ada desain yang diinginkan?', ['Sudah ada desain', 'Butuh referensi desain']).whatsapp_payload.interactive.action.sections[0].rows[1].id;
  const [m] = normalize({ from: '6281200000001', id: 'wamid.1', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: 'Butuh referensi desain' } } });
  assert.equal(m.text, 'Butuh referensi desain');
  assert.equal(m.answering_question, 'sudah ada desain yang diinginkan?');
  const [b] = normalize({ from: '6281200000001', id: 'wamid.2', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'opt:Kaos|q:mau order jenis apa?', title: 'Kaos' } } });
  assert.equal(b.text, 'Kaos');
  assert.equal(b.answering_question, 'mau order jenis apa?');
});

test('pesan biasa dan opsi lama (kb:) tetap seperti sebelumnya', () => {
  const [t] = normalize({ from: '6281200000001', id: 'wamid.3', type: 'text', text: { body: ' Iya, saya mau order baju ' } });
  assert.equal(t.text, 'Iya, saya mau order baju');
  assert.equal(t.answering_question, '');
  const [k] = normalize({ from: '6281200000001', id: 'wamid.4', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'kb:Minimal order berapa pcs?', title: 'Minimal order…' } } });
  assert.equal(k.text, 'Minimal order berapa pcs?');
  const [y] = normalize({ from: '6281200000001', id: 'wamid.5', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'lain', title: 'Ya' } } });
  assert.equal(y.text, 'Ya');
});

test('wiring: alur lama tetap, chat terakhir dengan opsi lewat pesan interaktif, gagal -> teks', () => {
  for (const old of ['Siapkan Opsi Knowledge', 'Ada Opsi Knowledge?', 'Kirim Opsi Knowledge']) assert.ok(!workflow.nodes.some((n) => n.name === old), `${old} dihapus`);
  assert.deepEqual(targets('Cari Knowledge Qdrant'), ['Daftar Produk Knowledge']);
  assert.deepEqual(targets('Daftar Produk Knowledge'), ['Siapkan Keputusan AI']);
  assert.deepEqual(targets('Balas Otomatis?', 0), ['Pecah Balasan']);
  assert.deepEqual(targets('Balas Otomatis?', 1), ['Tiket di Dashboard']);
  assert.deepEqual(targets('Pecah Balasan'), ['Loop Chat Balasan']);
  assert.deepEqual(targets('Loop Chat Balasan', 0), ['Balasan Terkirim Semua']);
  assert.deepEqual(targets('Loop Chat Balasan', 1), ['Chat dengan Opsi?']);
  assert.deepEqual(targets('Chat dengan Opsi?', 0), ['Siapkan Pesan Opsi']);
  assert.deepEqual(targets('Chat dengan Opsi?', 1), ['Kirim Balasan Otomatis']);
  assert.deepEqual(targets('Siapkan Pesan Opsi'), ['Kirim Balasan dengan Opsi']);
  assert.deepEqual(targets('Kirim Balasan dengan Opsi'), ['Opsi Terkirim?']);
  assert.deepEqual(targets('Opsi Terkirim?', 0), ['Jeda Antar Chat']);
  assert.deepEqual(targets('Opsi Terkirim?', 1), ['Opsi Gagal, Kirim Teks']);
  assert.deepEqual(targets('Opsi Gagal, Kirim Teks'), ['Kirim Balasan Otomatis']);
  assert.deepEqual(targets('Kirim Balasan Otomatis'), ['Jeda Antar Chat']);
  assert.deepEqual(targets('Jeda Antar Chat'), ['Loop Chat Balasan']);
  assert.deepEqual(targets('Balasan Terkirim Semua'), ['Ada Aset Gambar?']);
  assert.deepEqual(targets('Kirim Aset Gambar'), []);
});

test('kirim opsi lewat nomor bisnis, gagal kirim tidak menggagalkan eksekusi', () => {
  const send = node('Kirim Balasan dengan Opsi');
  const businessId = node('Kirim Balasan Otomatis').parameters.phoneNumberId.replace(/^=/, '');
  assert.ok(send.parameters.url.includes('/' + businessId + '/messages'));
  assert.deepEqual(send.credentials, node('Kirim Balasan Otomatis').credentials);
  assert.equal(send.onError, 'continueRegularOutput');
  assert.equal(send.parameters.options.response.response.neverError, true);
  assert.match(node('Chat dengan Opsi?').parameters.conditions.conditions[0].leftValue, /reply_part === \$json\.reply_parts/);
});


// ---- Alur referensi desain: jenis -> model -> warna -> "Ini kita ada bentukan design yang mirip" + gambar
const ASSET = { content_type: 'image_asset', asset_id: 'kaos-vneck-tosca', asset_path: '/home/node/.n8n/storage/kaos.jpg', mime_type: 'image/jpeg', asset_kind: 'foto', asset_detail: 'contoh_desain', produk: 'kaos', question: '', answer: '' };

test('prompt: alur referensi tanya model, lalu warna, lalu kirim desain yang mirip; schema konteks_order', () => {
  const { system, body } = siapkan({ points: [] });
  assert.match(system, /Mau model yang seperti apa kak\?/);
  assert.match(system, /Warnanya mau apa kak\?/);
  assert.match(system, /Ini kita ada bentukan design yang mirip/);
  assert.match(system, /konteks_order/);
  const schema = body.response_format.json_schema.schema;
  assert.deepEqual(schema.properties.konteks_order, { type: 'string' });
  assert.ok(schema.required.includes('konteks_order'));
});

test('konteks order ikut di id opsi, dibaca Normalisasi, dan diteruskan ke AI', () => {
  const prep = new Function('$', '$input', snippet)(
    stub({ 'Parse Keputusan AI': { options: ['Oblong', 'V-neck', 'Berkerah'], konteks_order: 'butuh referensi; produk: kaos' } }),
    { first: () => ({ json: { customer_phone: '6281200000001', reply: 'Siap kak.. mau model yang seperti apa kak?' } }) }
  )[0].json;
  const btn = prep.whatsapp_payload.interactive.action.buttons[1].reply;
  assert.equal(btn.id, 'opt:V-neck|q:mau model yang seperti apa kak?|c:butuh referensi; produk: kaos');
  const [m] = normalize({ from: '6281200000001', id: 'wamid.9', type: 'interactive', interactive: { type: 'button_reply', button_reply: btn } });
  assert.equal(m.text, 'V-neck');
  assert.equal(m.answering_question, 'mau model yang seperti apa kak?');
  assert.equal(m.answering_context, 'butuh referensi; produk: kaos');
  const { payload } = siapkan({ points: [], normalisasi: m });
  assert.deepEqual(payload.menjawab_opsi, { pertanyaan: 'mau model yang seperti apa kak?', pilihan: 'V-neck', konteks: 'butuh referensi; produk: kaos' });
  assert.match(node('Embedding Pertanyaan').parameters.jsonBody, /answering_context/);
});

test('id opsi tetap maks 200 karakter walau pertanyaan dan konteks panjang', () => {
  const r = new Function('$', '$input', snippet)(
    stub({ 'Parse Keputusan AI': { options: ['Kombinasi batik dengan list di lengan dan kerah', 'Polos'], konteks_order: 'x'.repeat(90) } }),
    { first: () => ({ json: { customer_phone: '1', reply: 'Baik kak, ' + 'y'.repeat(150) + ' mau model yang seperti apa?' } }) }
  )[0].json;
  for (const row of r.whatsapp_payload.interactive.action.sections[0].rows) assert.ok(row.id.length <= 200, row.id.length);
});

test('Parse: jawaban opsi alur order tidak dipaksa eskalasi walau knowledge kosong', () => {
  const mo = { pertanyaan: 'sudah ada desain yang diinginkan?', pilihan: 'Butuh referensi', konteks: '' };
  const r = parse({ reply: 'Siap kak.. kalau boleh tau kakak mau order jenis apa?', opsi: ['Kaos', 'Jaket', 'Polo'], konteks_order: 'butuh referensi' }, { message: 'Butuh referensi', prep: { knowledge: [], menjawabOpsi: mo } });
  assert.equal(r.action, 'AUTO_REPLY');
  assert.deepEqual(r.options, ['Kaos', 'Jaket', 'Polo']);
  assert.equal(r.konteks_order, 'butuh referensi');
  // tanpa menjawab_opsi dan tanpa knowledge tetap eskalasi (aturan lama)
  assert.equal(parse({ reply: 'Siap kak..', opsi: [] }, { message: 'Butuh referensi', prep: { knowledge: [] } }).action, 'ESCALATE');
});

test('Parse: di akhir alur referensi gambar desain yang mirip ikut dikirim', () => {
  const mo = { pertanyaan: 'warnanya mau apa kak?', pilihan: 'Tosca', konteks: 'butuh referensi; produk: kaos; model: V-neck' };
  const r = parse({ reply: 'Ini kita ada bentukan design yang mirip ya kak', asset_id: 'kaos-vneck-tosca', konteks_order: 'butuh referensi; produk: kaos; model: V-neck; warna: tosca' }, { message: 'Tosca', prep: { knowledge: [ASSET], menjawabOpsi: mo } });
  assert.equal(r.action, 'AUTO_REPLY');
  assert.equal(r.selected_asset?.asset_id, 'kaos-vneck-tosca');
  assert.deepEqual(r.options, []);
  // tanpa alur opsi, pesan "Tosca" saja tidak memicu kirim gambar (aturan lama)
  assert.equal(parse({ reply: 'Baik kak', asset_id: 'kaos-vneck-tosca' }, { message: 'Tosca', prep: { knowledge: [ASSET] } }).selected_asset, null);
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
process.exit(failed ? 1 : 0);
