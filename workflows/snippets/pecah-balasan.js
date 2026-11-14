// Pecah Balasan: memecah balasan AI yang panjang menjadi beberapa chat WhatsApp pendek.
// Sumber kode untuk node Code "Pecah Balasan" di workflows/wa-admin-lengkap.json
// (tempel ulang ke node itu kalau file ini diubah; tes: node tests/split-reply.test.mjs).
//
// Aturan:
// - Pembatas utama: akhir kalimat (. ! ? …) yang diikuti spasi/baris baru.
// - Bukan pembatas: angka desimal/ribuan (1.5, 150.000), ukuran (50x60), singkatan
//   (Rp., dll., No., Jl., ...), nomor daftar di awal baris ("1. Kaos"), inisial ("A."),
//   dan elipsis ("kak.. ada") bila kalimat berikutnya diawali huruf kecil.
// - Kalimat pendek digabung sampai sekitar WA_REPLY_MAX_CHARS karakter per chat,
//   jadi tidak dikirim satu chat per kalimat kecil. Kalimat yang panjang tidak dipotong.
// - Jumlah chat dibatasi WA_REPLY_MAX_PARTS; sisanya digabung ke chat terakhir.

function envNumber(name, fallback) {
  try {
    const value = Number($env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch (error) {
    return fallback;
  }
}

const MAX_CHARS = envNumber('WA_REPLY_MAX_CHARS', 200);
const MIN_CHARS = envNumber('WA_REPLY_MIN_CHARS', 60);
const MAX_PARTS = envNumber('WA_REPLY_MAX_PARTS', 5);

// Singkatan yang hampir tidak pernah mengakhiri kalimat (tidak pernah jadi pembatas).
const ABBREVIATIONS = new Set([
  'rp', 'no', 'jl', 'jln', 'tgl', 'yth', 'bpk', 'sdr', 'dr', 'drs', 'ir', 'pt', 'cv', 'kel',
  'kec', 'kab', 'prov', 'telp', 'tlp', 'cth', 'mis', 'spt', 'vs', 'a.n', 'u.p', 's.d', 'd.a',
  'mr', 'mrs', 'ms', 'e.g', 'i.e'
]);
// Singkatan yang bisa mengakhiri kalimat: jadi pembatas hanya kalau kalimat berikutnya
// diawali huruf besar ("kaos, hoodie, dll. Untuk ...").
const SOFT_ABBREVIATIONS = new Set(['dll', 'dsb', 'dst', 'dkk', 'etc', 'sbb']);

function isBoundary(text, punctStart, punctEnd) {
  const punct = text.slice(punctStart, punctEnd);
  const after = text.slice(punctEnd);
  const nextChar = (after.match(/^\s+(\S)/) || [])[1];
  if (!nextChar) return false; // akhir teks ditangani di luar
  const before = text.slice(0, punctStart);
  const lastToken = (before.match(/(\S+)$/) || [])[1] || '';
  const bare = lastToken.replace(/^[("'“‘]+/, '').toLowerCase();
  const isLower = /\p{Ll}/u.test(nextChar);

  if (punct.includes('.') && !/[!?…]/.test(punct)) {
    if (punct.length === 1) {
      if (ABBREVIATIONS.has(bare)) return false;
      if (SOFT_ABBREVIATIONS.has(bare) && !/\p{Lu}/u.test(nextChar)) return false;
      if (/^\p{L}$/u.test(bare)) return false; // inisial: "A."
      // Nomor daftar di awal baris: "1. Kaos" / "2) Hoodie".
      const lineStart = before.lastIndexOf('\n') + 1;
      if (/^\d{1,2}$/.test(bare) && before.slice(lineStart).trim() === lastToken) return false;
    } else if (isLower) {
      return false; // elipsis lanjutan: "kak.. ada dong"
    }
  }
  if ((punct === '…') && isLower) return false;
  return true;
}

function splitSentences(text) {
  const sentences = [];
  const re = /[.!?…]+["'”’)]*/g;
  let start = 0;
  let match;
  while ((match = re.exec(text))) {
    const punctEnd = match.index + match[0].length;
    if (isBoundary(text, match.index, punctEnd)) {
      sentences.push(text.slice(start, punctEnd).trim());
      start = punctEnd;
    }
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences.filter(Boolean);
}

function splitReply(reply) {
  const text = String(reply || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  if (text.length <= MAX_CHARS) return [text];

  // Paragraf (baris kosong) selalu memulai chat baru; di dalam paragraf, pisah per kalimat.
  const parts = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const units = [];
    for (const line of paragraph.split('\n')) {
      const sentences = splitSentences(line);
      sentences.forEach((sentence, index) => units.push({ text: sentence, sep: index === 0 && units.length ? '\n' : ' ' }));
    }
    let current = '';
    for (const unit of units) {
      if (!current) {
        current = unit.text;
      } else if (current.length < MIN_CHARS || current.length + unit.sep.length + unit.text.length <= MAX_CHARS) {
        current += unit.sep + unit.text;
      } else {
        parts.push(current);
        current = unit.text;
      }
    }
    if (current) parts.push(current);
  }

  // Potongan terakhir yang sangat pendek digabung ke sebelumnya.
  if (parts.length > 1 && parts[parts.length - 1].length < MIN_CHARS / 2) {
    const tail = parts.pop();
    parts[parts.length - 1] += ' ' + tail;
  }
  while (parts.length > MAX_PARTS) {
    const tail = parts.pop();
    parts[parts.length - 1] += '\n\n' + tail;
  }
  return parts;
}

const base = $input.first().json;
const chunks = splitReply(base.reply);
if (!chunks.length) chunks.push(String(base.reply || ''));
return chunks.map((reply, index) => ({
  json: { ...base, reply, reply_full: base.reply, reply_part: index + 1, reply_parts: chunks.length }
}));
