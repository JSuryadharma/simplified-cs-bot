// Samakan nomor pengirim (Phone Number ID) semua node WhatsApp yang mengirim ke PELANGGAN dengan node
// "Kirim Balasan Otomatis" (nomor bisnis yang dihubungi pelanggan).
//   node scripts/apply-wa-sender.mjs <input.json> <output.json>
//
// Sebelumnya hanya balasan teks yang memakai nomor bisnis; gambar aset, jawaban owner yang diteruskan,
// dan balasan dari dashboard masih memakai sender test Meta (+1 555...), sehingga pelanggan tidak
// menerimanya di chat yang sama (atau sama sekali). Node yang mengirim ke OWNER tidak diubah.
// Skrip idempoten.
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('pakai: node scripts/apply-wa-sender.mjs <input.json> <output.json>');
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const workflow = Array.isArray(raw) ? raw[0] : raw;
const byName = (name) => workflow.nodes.find((n) => n.name === name);

const source = byName('Kirim Balasan Otomatis');
if (!source) throw new Error('node "Kirim Balasan Otomatis" tidak ditemukan');
const sender = String(source.parameters.phoneNumberId || '').replace(/^=/, '').trim();
if (!/^\d{10,20}$/.test(sender)) throw new Error(`phoneNumberId "Kirim Balasan Otomatis" tidak valid: ${sender}`);

const CUSTOMER_FACING = ['Kirim Aset Gambar', 'Teruskan Jawaban Owner', 'Kirim dari Dashboard'];
const changed = [];
for (const name of CUSTOMER_FACING) {
  const node = byName(name);
  if (!node) continue;
  if (String(node.parameters.phoneNumberId || '').replace(/^=/, '') !== sender) changed.push(`${name}: ${node.parameters.phoneNumberId} -> ${sender}`);
  node.parameters.phoneNumberId = sender;
}

fs.writeFileSync(output, JSON.stringify(Array.isArray(raw) ? [workflow] : workflow, null, 2));
process.stdout.write(`sender pelanggan = ${sender}${changed.length ? '\n  ' + changed.join('\n  ') : ' (tidak ada perubahan)'}\n`);
