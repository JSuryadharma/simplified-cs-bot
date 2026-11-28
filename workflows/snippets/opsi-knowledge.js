// Siapkan Opsi Knowledge: setelah balasan otomatis (dan gambar) terkirim, tawarkan pelanggan
// pertanyaan lain yang jawabannya ADA di knowledge, sebagai pesan interaktif WhatsApp
// (tombol balasan bila muat, kalau tidak list message).
// Sumber kode untuk node Code "Siapkan Opsi Knowledge" di workflows/wa-admin-lengkap.json
// (tempel ulang ke node itu kalau file ini diubah; tes: node tests/knowledge-options.test.mjs).
//
// Cabang ini hanya tambahan di ujung alur balasan otomatis: balasan teks, Pecah Balasan,
// gambar, eskalasi/tiket tidak berubah. Kalau tidak ada opsi, cabang berhenti tanpa kirim apa pun.
//
// Opsi diambil dari knowledge_used (hasil Qdrant yang sudah lolos QDRANT_SCORE_THRESHOLD):
// - hanya Q&A yang boleh dijawab otomatis (bukan price_reference / image_asset / auto_reply=false),
// - tanpa jawaban yang menunggu owner ("tunggu konfirmasi owner", ...),
// - tanpa entri teratas (yang barusan dijawab) dan entri yang mirip pertanyaan/balasan sekarang,
// - pertanyaan unik (yang hampir sama dibuang), maksimal WA_KNOWLEDGE_OPTIONS_MAX (default 3, maks 10).
// Tidak dikirim untuk sapaan, tanggapan tiket yang masih menunggu owner, eskalasi, atau bila
// balasan bot sedang bertanya balik ke pelanggan (diakhiri "?").
// Matikan dengan WA_KNOWLEDGE_OPTIONS=false.
//
// Saat pelanggan mengetuk opsi, WhatsApp mengirim id "kb:<pertanyaan>". Node
// "Normalisasi dan Verifikasi" memakai pertanyaan itu sebagai teks pesan, jadi dijawab lewat
// alur RAG yang sama seperti pesan teks biasa.

function envValue(name, fallback) {
  try {
    const value = $env[name];
    return value === undefined || value === null || value === '' ? fallback : String(value);
  } catch (error) {
    return fallback;
  }
}

const OPTION_PREFIX = 'kb:';
const enabled = !/^(false|0|off|no|tidak)$/i.test(envValue('WA_KNOWLEDGE_OPTIONS', 'true'));
const maxOptions = Math.min(10, Math.max(1, Number(envValue('WA_KNOWLEDGE_OPTIONS_MAX', '3')) || 3));

const decision = $('Parse Keputusan AI').first().json;
const ctx = $('Hasil Customer').first().json;
const phone = String(ctx.customer_phone || decision.customer_phone || '').replace(/\D/g, '');
const reply = String(decision.reply || '').trim();

const words = (s) => new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3));
const overlap = (a, b) => {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let same = 0;
  for (const w of A) if (B.has(w)) same += 1;
  return same / Math.min(A.size, B.size);
};
const normQuestion = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cut = (s, max) => {
  const text = String(s || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return (space > max * 0.5 ? head.slice(0, space) : head).replace(/[\s,.;:!?/-]+$/, '') + '…';
};

let skipReason = '';
if (!enabled) skipReason = 'dimatikan (WA_KNOWLEDGE_OPTIONS=false)';
else if (decision.action !== 'AUTO_REPLY') skipReason = 'bukan balasan otomatis';
else if (decision.is_greeting) skipReason = 'sapaan';
else if (decision.ticket_followup) skipReason = 'tiket masih menunggu owner';
else if (/\?\s*[🙏🏻🤗😊]*\s*$/u.test(reply)) skipReason = 'balasan sedang bertanya ke pelanggan';
else if (!phone) skipReason = 'nomor pelanggan kosong';

const options = [];
if (!skipReason) {
  const eligible = (Array.isArray(decision.knowledge_used) ? decision.knowledge_used : []).filter((e) =>
    e && e.question && e.answer &&
    e.content_type !== 'price_reference' && e.content_type !== 'image_asset' &&
    e.auto_reply !== false &&
    !/(tunggu|menunggu)\s+konfirmasi|konfirmasi\s+(dari\s+)?owner|(cek|tanya|tanyakan)\s+(dulu\s+)?(ke\s+)?owner/i.test(e.answer));
  const seen = new Set([normQuestion(decision.customer_message || ctx.message_text)]);
  eligible.forEach((entry, index) => {
    if (options.length >= maxOptions) return;
    const key = normQuestion(entry.question);
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (index === 0) return; // entri paling relevan = yang barusan dijawab
    if (overlap(entry.question, decision.customer_message || ctx.message_text) >= 0.7) return;
    if (reply && overlap(entry.answer, reply) >= 0.6) return;
    if (options.some((q) => overlap(q, entry.question) >= 0.7)) return; // hampir sama dengan opsi lain
    options.push(entry.question.replace(/\s+/g, ' ').trim());
  });
  if (!options.length) skipReason = 'tidak ada knowledge lain yang relevan';
}

if (skipReason) return [{ json: { send_options: false, skip_reason: skipReason, customer_phone: phone } }];

const id = (q) => (OPTION_PREFIX + q).slice(0, 200);
const bodyText = 'Mungkin kakak juga mau tahu ini 👇';
const useButtons = options.length <= 3 && options.every((q) => q.length <= 20);
const interactive = useButtons
  ? {
      type: 'button',
      body: { text: bodyText },
      action: { buttons: options.map((q) => ({ type: 'reply', reply: { id: id(q), title: q } })) }
    }
  : {
      type: 'list',
      body: { text: bodyText },
      footer: { text: 'Ketuk salah satu, nanti kami jawab 🙏' },
      action: {
        button: 'Lihat pertanyaan',
        sections: [{
          title: 'Pertanyaan lain',
          rows: options.map((q) => ({ id: id(q), title: cut(q, 24), ...(q.length > 24 ? { description: cut(q, 72) } : {}) }))
        }]
      }
    };

return [{ json: {
  send_options: true,
  customer_phone: phone,
  options,
  whatsapp_payload: { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'interactive', interactive }
} }];
