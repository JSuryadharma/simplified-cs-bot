// Siapkan Pesan Opsi: chat balasan terakhir yang punya opsi jawaban dari AI (field "opsi" di
// keputusan LLM) dikirim sebagai pesan interaktif WhatsApp: teks balasan + tombol (maks 3 opsi
// pendek) atau list "Pilih jawaban" (4-10 opsi / opsi panjang).
// Sumber kode untuk node Code "Siapkan Pesan Opsi" di workflows/wa-admin-lengkap.json
// (tempel ulang ke node itu kalau file ini diubah; tes: node tests/reply-options.test.mjs).
//
// Id tiap opsi: "opt:<opsi>|q:<pertanyaan bot>". Saat pelanggan mengetuknya, node
// "Normalisasi dan Verifikasi" memakai <opsi> sebagai teks pesan dan <pertanyaan bot> sebagai
// answering_question, supaya AI tahu pilihan itu menjawab pertanyaan apa (chat history kosong).
// fallback_reply = teks + daftar opsi bernomor, dipakai bila pesan interaktif gagal terkirim.

const base = $input.first().json;
const options = ($('Parse Keputusan AI').first().json.options || []).map((o) => String(o)).filter(Boolean).slice(0, 10);
const reply = String(base.reply || '').trim();
const phone = String(base.customer_phone || '').replace(/\D/g, '');

const cut = (s, max) => {
  const text = String(s || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return (space > max * 0.5 ? head.slice(0, space) : head).replace(/[\s,.;:!?/-]+$/, '') + '…';
};
// Pertanyaan bot = kalimat terakhir yang diakhiri "?" (atau seluruh balasan, dipotong)
const questions = reply.match(/[^.!?\n]*\?/g) || [];
const question = cut(questions.length ? questions[questions.length - 1] : reply, 110);
const id = (o) => ('opt:' + cut(o, 72) + '|q:' + question).slice(0, 200);
const fallbackReply = reply + '\n\n' + options.map((o, i) => (i + 1) + '. ' + o).join('\n');

const useButtons = options.length <= 3 && options.every((o) => o.length <= 20) && reply.length <= 1024;
const interactive = useButtons
  ? {
      type: 'button',
      body: { text: reply.slice(0, 1024) },
      action: { buttons: options.map((o) => ({ type: 'reply', reply: { id: id(o), title: o } })) }
    }
  : {
      type: 'list',
      body: { text: reply.slice(0, 4096) },
      action: {
        button: 'Pilih jawaban',
        sections: [{
          title: 'Pilihan',
          rows: options.map((o) => ({ id: id(o), title: cut(o, 24), ...(o.length > 24 ? { description: cut(o, 72) } : {}) }))
        }]
      }
    };

return [{ json: {
  ...base,
  customer_phone: phone,
  options,
  question,
  fallback_reply: fallbackReply,
  whatsapp_payload: { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'interactive', interactive }
} }];
