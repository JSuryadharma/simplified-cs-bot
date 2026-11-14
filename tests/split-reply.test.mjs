// Tes untuk node "Pecah Balasan" (workflows/snippets/pecah-balasan.js).
// Jalankan: node tests/split-reply.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const code = readFileSync(new URL('../workflows/snippets/pecah-balasan.js', import.meta.url), 'utf8');
const run = (reply, env = {}) =>
  new Function('$input', '$env', code)({ first: () => ({ json: { reply, customer_phone: '620000' } }) }, env)
    .map((item) => item.json.reply);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('balasan pendek tetap satu chat', () => {
  assert.deepEqual(run('Halo kak, ada yang bisa dibantu?'), ['Halo kak, ada yang bisa dibantu?']);
});

test('contoh size chart dipecah per kalimat dan kalimat pendek digabung', () => {
  const reply = 'Siang kak.. ada dong size chart nya, kami kirim gambarnya y.. Ini size chart jaket SaViOr (lebar x panjang cm): XS 50x60, S 53x63, M 56x66, L 59x69, XL 62x72, big size 2XL 66x74, 3XL 69x76, 4XL 72x78, 5XL 75x80, 6XL 80x82. Panjang lengan standar, toleransi jahit +/- 1-2 cm. Kalau mau size chart kaos atau hoodie juga ada y kak, tinggal bilang aja 🙏';
  const parts = run(reply);
  assert.deepEqual(parts, [
    'Siang kak.. ada dong size chart nya, kami kirim gambarnya y..',
    'Ini size chart jaket SaViOr (lebar x panjang cm): XS 50x60, S 53x63, M 56x66, L 59x69, XL 62x72, big size 2XL 66x74, 3XL 69x76, 4XL 72x78, 5XL 75x80, 6XL 80x82.',
    'Panjang lengan standar, toleransi jahit +/- 1-2 cm. Kalau mau size chart kaos atau hoodie juga ada y kak, tinggal bilang aja 🙏'
  ]);
  assert.equal(parts.join(' '), reply, 'tidak ada teks yang hilang');
});

test('tidak memecah desimal, harga ribuan, singkatan, dan nomor daftar', () => {
  const reply = 'Harga kaos cotton combed 30s mulai Rp. 85.000 per pcs untuk ukuran S sampai XL, dan tambahan Rp 5.000 untuk 2XL, dll. minimal order 24 pcs ya kak. Bahan 1.5 mm juga ada untuk jaket parasut. Alamat workshop kami di Jl. Melati No. 12 kak, bisa datang langsung hari Senin sampai Sabtu.';
  const parts = run(reply);
  for (const p of parts) {
    assert.ok(!/^(\d|000|5 mm|Melati|12|minimal)/.test(p), `potongan salah: ${p}`);
  }
  assert.equal(parts.join(' '), reply);
});

test('nomor daftar di awal baris tidak jadi pembatas', () => {
  const reply = 'Untuk order bisa ikuti langkah ini kak:\n1. Kirim desain dan jumlah per ukuran.\n2. Kami kirim penawaran harga dan mockup.\n3. Bayar DP 50% lalu produksi dimulai.\nEstimasi produksi sekitar 14 hari kerja setelah desain final dan DP masuk ya kak. Kalau ada pertanyaan lain, kabari aja.';
  const parts = run(reply);
  assert.ok(parts.every((p) => !/^\d\.$/.test(p.trim())));
  assert.ok(parts.some((p) => p.includes('1. Kirim desain')));
  assert.ok(parts.length >= 2);
});

test('setiap chat tidak terlalu panjang kecuali satu kalimat panjang', () => {
  const s = 'Ini kalimat contoh yang cukup panjang untuk menguji penggabungan kalimat kak.';
  const parts = run(Array(8).fill(s).join(' '));
  assert.ok(parts.length > 1 && parts.length <= 5);
  assert.ok(parts.slice(0, -1).every((p) => p.length <= 200));
});

test('batas jumlah chat bisa diatur lewat env', () => {
  const s = 'Kalimat yang lumayan panjang supaya tidak digabung dengan kalimat lain ya kak, terima kasih banyak.';
  assert.equal(run(Array(6).fill(s).join(' '), { WA_REPLY_MAX_CHARS: '120', WA_REPLY_MAX_PARTS: '2' }).length, 2);
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
process.exit(failed ? 1 : 0);
