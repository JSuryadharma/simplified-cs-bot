// Tiket tidak memblokir percakapan (workflow "WA Admin - Sistem Lengkap", file JSON hasil export n8n).
//   node scripts/apply-nonblocking-tickets.mjs <input.json> <output.json>
// Pasangan dari db/005-nonblocking-tickets.sql (receive_customer mengirim open_ticket_question).
//
// 1. Prompt keputusan AI tahu ada tiket terbuka, tetapi menilai pesan terbaru secara mandiri:
//    pertanyaan yang dijawab knowledge/data order tetap AUTO_REPLY walau tiket masih menunggu owner.
// 2. Pesan yang hanya menagih/menanggapi pertanyaan di tiket terbuka ("jadi harganya berapa?",
//    "oke ditunggu") dibalas singkat bahwa owner sedang mengecek, tanpa eskalasi ulang ke owner.
// 3. Sapaan/tes dibalas sapaan biasa, tanpa tiket dan tanpa menyebut owner.
// Skrip idempoten.
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('pakai: node scripts/apply-nonblocking-tickets.mjs <input.json> <output.json>');
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const workflow = Array.isArray(raw) ? raw[0] : raw;
const must = (name) => { const n = workflow.nodes.find((x) => x.name === name); if (!n) throw new Error(`node "${name}" tidak ditemukan`); return n; };
const replaceOnce = (code, from, to, label) => {
  if (!code.includes(from)) throw new Error(`${label}: teks asal tidak ditemukan`);
  return code.replace(from, to);
};

// ---------------------------------------------------------------- 1. Prompt
const prep = must('Siapkan Keputusan AI');
let code = prep.parameters.jsCode;
if (!code.includes('tiket_terbuka')) {
  code = replaceOnce(code, '13. Output wajib mengikuti JSON schema.', [
    '13. tiket_terbuka berarti pertanyaan sebelumnya sedang menunggu jawaban owner. Ini TIDAK menghalangi percakapan: nilai pesan_pelanggan terbaru secara mandiri. Jika knowledge_relevan atau data_order menjawabnya, pilih AUTO_REPLY. Pilih ESCALATE hanya jika pesan terbaru itu sendiri membutuhkan owner, dan tulis ringkasan/pertanyaan owner hanya untuk pesan terbaru.',
    '14. Jika pesan terbaru hanya menagih, mengulang, atau menanggapi pertanyaan di tiket_terbuka (mis. "jadi harganya berapa?", "oke ditunggu ya"), pilih AUTO_REPLY, isi followup_tiket_terbuka = true, dan balas singkat bahwa pertanyaan itu sedang dicek owner dan akan segera dikabari. Jangan menjawab isi pertanyaan itu sendiri. Selain kasus ini followup_tiket_terbuka = false.',
    '15. Output wajib mengikuti JSON schema.',
  ].join('\n'), 'aturan prompt');
  code = replaceOnce(code, '  riwayat_terbaru: ctx.recent_messages,',
    "  riwayat_terbaru: ctx.recent_messages,\n  tiket_terbuka: ctx.open_ticket_code ? { kode: ctx.open_ticket_code, pertanyaan_menunggu_owner: ctx.open_ticket_question || '' } : null,",
    'payload');
  code = replaceOnce(code, "            asset_id: { type: 'string' }\n          },",
    "            asset_id: { type: 'string' },\n            followup_tiket_terbuka: { type: 'boolean' }\n          },", 'schema');
  code = replaceOnce(code, "required: ['action', 'confidence', 'reply', 'needs_summary', 'owner_question', 'asset_id']",
    "required: ['action', 'confidence', 'reply', 'needs_summary', 'owner_question', 'asset_id', 'followup_tiket_terbuka']", 'required');
  prep.parameters.jsCode = code;
}

// ---------------------------------------------------------------- 2. Parse keputusan
const parse = must('Parse Keputusan AI');
code = parse.parameters.jsCode;
if (!code.includes('followup_tiket_terbuka')) {
  code = replaceOnce(code,
    "if (action === 'AUTO_REPLY' && (!reply || (!hasKnowledge && !hasOrders))) action = 'ESCALATE';",
    `// Tanggapan atas tiket yang masih menunggu owner: balas singkat, jangan eskalasi ulang.
// Balasan tidak boleh memuat angka (harga/tanggal/jumlah) karena jawabannya belum ada dari owner.
const ticketFollowup = Boolean(ctx.open_ticket_code) && parsed.followup_tiket_terbuka === true && action === 'AUTO_REPLY';
if (ticketFollowup && (!reply || /\\d/.test(reply))) {
  reply = 'Baik kak, pertanyaan sebelumnya masih kami cek dengan owner ya. Nanti segera kami kabari 🙏';
}
if (action === 'AUTO_REPLY' && !ticketFollowup && (!reply || (!hasKnowledge && !hasOrders))) action = 'ESCALATE';`,
    'guard parse');
  parse.parameters.jsCode = code;
}

// ---------------------------------------------------------------- 3. Sapaan
// Sapaan/tes ("halo", "permisi", "tes") dibalas sapaan biasa: tidak membuat tiket dan tidak
// dianggap menagih tiket terbuka (sebelumnya "Halo" dibalas "pertanyaan Anda sedang dicek owner").
code = prep.parameters.jsCode;
if (!code.includes('sapaan:')) {
  code = replaceOnce(code,
    'pilih AUTO_REPLY, isi followup_tiket_terbuka = true,',
    'dan pesan itu jelas merujuk ke pertanyaan tersebut, pilih AUTO_REPLY, isi followup_tiket_terbuka = true,', 'aturan 14');
  code = replaceOnce(code, '15. Output wajib mengikuti JSON schema.', [
    '15. Jika pesan terbaru hanya sapaan, basa-basi, atau tes (mis. "halo", "permisi", "selamat siang", "tes", "makasih"), pilih AUTO_REPLY, isi sapaan = true, dan balas sapaan singkat yang ramah lalu tanyakan apa yang bisa dibantu. Jangan menyebut tiket atau owner, dan jangan ESCALATE. Selain kasus ini sapaan = false.',
    '16. Output wajib mengikuti JSON schema.',
  ].join('\n'), 'aturan sapaan');
  code = replaceOnce(code, "            followup_tiket_terbuka: { type: 'boolean' }\n",
    "            followup_tiket_terbuka: { type: 'boolean' },\n            sapaan: { type: 'boolean' }\n", 'schema sapaan');
  code = replaceOnce(code, "'asset_id', 'followup_tiket_terbuka']", "'asset_id', 'followup_tiket_terbuka', 'sapaan']", 'required sapaan');
  prep.parameters.jsCode = code;
}
code = parse.parameters.jsCode;
if (!code.includes('isGreeting')) {
  code = replaceOnce(code,
    "if (action === 'AUTO_REPLY' && !ticketFollowup && (!reply || (!hasKnowledge && !hasOrders))) action = 'ESCALATE';",
    `const isGreeting = parsed.sapaan === true && action === 'AUTO_REPLY';
if (isGreeting && (!reply || /\\d|owner|tiket|dicek/i.test(reply))) reply = 'Halo kak 👋 Ada yang bisa kami bantu?';
if (action === 'AUTO_REPLY' && !ticketFollowup && !isGreeting && (!reply || (!hasKnowledge && !hasOrders))) action = 'ESCALATE';`,
    'guard sapaan');
  parse.parameters.jsCode = code;
}

fs.writeFileSync(output, JSON.stringify(Array.isArray(raw) ? [workflow] : workflow, null, 2));
process.stdout.write('apply-nonblocking-tickets: prompt + parse diperbarui (tiket terbuka + sapaan)\n');
