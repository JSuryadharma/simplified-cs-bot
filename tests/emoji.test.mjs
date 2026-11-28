// Tes: emoji 🤗 tidak pernah dikirim ke pelanggan, dan teks tetap bot tanpa emoji.
// Jalankan: node tests/emoji.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const [workflow] = JSON.parse(readFileSync(new URL('../workflows/wa-admin-lengkap.json', import.meta.url), 'utf8'));
const code = (name) => workflow.nodes.find((n) => n.name === name).parameters.jsCode;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

const parse = (llmReply, { message = 'min order kaos brp kak?', extra = {} } = {}) => {
  const nodes = {
    'Hasil Customer': { customer_phone: '6281200000001', message_text: message, orders: [], recent_messages: [] },
    'Siapkan Keputusan AI': { knowledge: [{ content_type: 'chat_qa', auto_reply: true, question: 'Minimal order berapa pcs?', answer: 'Minimal order 12 pcs per warna.' }], assetRequest: {} }
  };
  const $ = (name) => ({ first: () => ({ json: nodes[name] }) });
  const $json = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ action: 'AUTO_REPLY', confidence: 0.9, reply: llmReply, needs_summary: '', owner_question: '', asset_id: '', followup_tiket_terbuka: false, sapaan: false, ...extra }) } }] };
  return new Function('$', '$json', code('Parse Keputusan AI'))($, $json)[0].json;
};

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('emoji 🤗 dari model dibuang dari balasan', () => {
  assert.equal(parse('Siang kak.. minimal order 12 pcs per warna y 🤗').reply, 'Siang kak.. minimal order 12 pcs per warna y');
  assert.equal(parse('Baik kak 🤗 minimal order 12 pcs per warna 🤗🤗').reply, 'Baik kak minimal order 12 pcs per warna');
});

test('balasan tanpa 🤗 tidak berubah', () => {
  assert.equal(parse('Siang kak.. minimal order 12 pcs per warna y 🙏🏻').reply, 'Siang kak.. minimal order 12 pcs per warna y 🙏🏻');
});

test('template sapaan tanpa emoji', () => {
  assert.equal(parse('', { message: 'halo kak', extra: { sapaan: true } }).reply, 'Halo kak, ada yang bisa kami bantu?');
});

test('prompt gaya tidak lagi menyuruh memakai 🤗', () => {
  const prompt = code('Siapkan Keputusan AI');
  assert.ok(!prompt.includes('Emoji secukupnya: 🤗'));
  assert.ok(prompt.includes('Jangan pernah memakai emoji 🤗'));
});

test('teks tetap untuk pelanggan tidak memakai emoji', () => {
  const texts = [...code('Parse Keputusan AI').matchAll(/reply = '([^']*)'|\+ ' ya[^']*'|' dan ' \+ daftar\[daftar\.length - 1\] \+ '([^']*)'/g)].map((m) => m[0]);
  assert.ok(texts.length >= 4);
  for (const t of texts) assert.ok(!EMOJI.test(t), `masih ada emoji: ${t}`);
  const opsi = code('Siapkan Pesan Opsi');
  for (const t of opsi.match(/button: '[^']*'|title: '[^']*'/g)) assert.ok(!EMOJI.test(t), `masih ada emoji: ${t}`);
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
process.exit(failed ? 1 : 0);
