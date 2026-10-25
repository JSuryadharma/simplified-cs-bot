// Parser ekspor chat WhatsApp (.txt) untuk impor knowledge.
// File ini sengaja tanpa import/export: isinya disisipkan apa adanya ke Code node n8n
// (scripts/apply-knowledge-import.mjs) dan dimuat oleh scripts/knowledge/index.mjs,
// sehingga parser di CLI, dashboard, dan n8n selalu sama.

const WA_LINE = /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}[.:]\d{2}(?:[.:]\d{2})?)\]?\s*(?:[-–]\s*)?(.*)$/;
const WA_SENDER = /^([^:]{1,60}?):\s?([\s\S]*)$/;
const WA_ATTACHMENT = /^(.+?\.[a-z0-9]{2,5})\s*(?:\((?:file terlampir|file attached)\)|<attached>)$/i;
const WA_ATTACHMENT_IOS = /^<(?:attached|terlampir):\s*\d*-?(.+?\.[a-z0-9]{2,5})>$/i;
const WA_MEDIA_OMITTED = /^<(?:Media tidak disertakan|Media omitted)>$/i;
const WA_SKIP_TEXT = /^(Pesan ini dihapus|Anda menghapus pesan ini|Menunggu pesan ini|This message was deleted|You deleted this message|Waiting for this message|null)$/i;
const WA_EDITED = /\s*<(?:Pesan ini diedit|This message was edited)>\s*$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

function waParseDate(date, time) {
  const [d, m, yRaw] = date.split('/').map(Number);
  const y = yRaw < 100 ? 2000 + yRaw : yRaw;
  const [hh, mm] = time.split(/[.:]/).map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00+07:00`;
}

// Kembalikan { messages, senders, owner } dari isi file ekspor.
// messages: { ts, sender, role: 'owner'|'customer', text, attachments: [{ file, kind }], media_omitted, template }
function parseWhatsAppExport(raw, opts) {
  const options = opts || {};
  const lines = String(raw || '').replace(/\r\n?/g, '\n').replace(/[‎‏‪-‮]/g, '').split('\n');
  const entries = [];
  for (const line of lines) {
    const m = line.match(WA_LINE);
    if (m) {
      const rest = m[3];
      const s = rest.match(WA_SENDER);
      // Baris sistem (enkripsi, timer, "Kini bisnis Anda ...") tidak punya "nama: teks"
      if (!s || /^(Pesan dan telepon|Messages and calls|Timer pesan|Kini bisnis Anda|Anda menonaktifkan)/i.test(rest)) {
        entries.push({ ts: waParseDate(m[1], m[2]), system: true, sender: '', lines: [rest] });
      } else {
        entries.push({ ts: waParseDate(m[1], m[2]), system: false, sender: s[1].trim(), lines: [s[2]] });
      }
    } else if (entries.length) {
      entries[entries.length - 1].lines.push(line);
    }
  }

  const counts = {};
  for (const e of entries) if (!e.system) counts[e.sender] = (counts[e.sender] || 0) + 1;
  const senders = Object.keys(counts);
  const wanted = String(options.ownerName || '').trim().toLowerCase();
  let owner = senders.find((s) => wanted && s.toLowerCase() === wanted) ||
    senders.find((s) => wanted && s.toLowerCase().includes(wanted)) || '';
  if (!owner) {
    // Owner = pengirim template sapaan bisnis; cadangan: pengirim yang bukan nomor telepon
    const greeter = entries.find((e) => !e.system && /terima ?kasih sudah menghubungi/i.test(e.lines.join(' ')));
    owner = greeter ? greeter.sender : (senders.find((s) => !/^\+?\d[\d\s-]+$/.test(s)) || senders[0] || '');
  }

  const messages = [];
  for (const e of entries) {
    if (e.system) continue;
    const attachments = [];
    let mediaOmitted = false;
    const textLines = [];
    for (const rawLine of e.lines) {
      const line = rawLine.replace(WA_EDITED, '').trim();
      const att = line.match(WA_ATTACHMENT) || line.match(WA_ATTACHMENT_IOS);
      if (att) {
        const file = att[1].trim();
        attachments.push({ file, kind: IMAGE_EXT.test(file) && !/^STK-/i.test(file) ? 'image' : (/\.(opus|mp3|m4a)$/i.test(file) ? 'audio' : /\.(mp4|mov)$/i.test(file) ? 'video' : 'file') });
        continue;
      }
      if (WA_MEDIA_OMITTED.test(line)) { mediaOmitted = true; continue; }
      textLines.push(line);
    }
    let text = textLines.join('\n').trim();
    if (WA_SKIP_TEXT.test(text)) text = '';
    // Setelah <Media tidak disertakan> baris berikut kadang hanya nama file dokumen
    if (mediaOmitted && /^[^\s]+\.(pdf|png|jpe?g|zip|docx?|xlsx?)$/i.test(text)) { attachments.push({ file: text, kind: 'file', omitted: true }); text = ''; }
    if (!text && !attachments.length && !mediaOmitted) continue;
    messages.push({
      ts: e.ts,
      sender: e.sender,
      role: e.sender === owner ? 'owner' : 'customer',
      text,
      attachments,
      media_omitted: mediaOmitted,
      template: e.sender === owner && /terima ?kasih sudah menghubungi kami/i.test(text),
    });
  }
  return { messages, senders: counts, owner };
}

// Sembunyikan data pribadi sebelum teks dikirim ke model eksternal / disimpan sebagai knowledge.
function redactPii(text) {
  return String(text || '')
    .replace(/https?:\/\/(?:drive\.google|docs\.google|www\.canva|canva\.link|alkitab\.app)\S*/gi, '[TAUTAN]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[EMAIL]')
    .replace(/(?:\+?62|\b0)8[\d\s‑-]{7,14}\d/g, '[NOMOR_HP]')
    .replace(/\b\d{9,18}\b/g, '[NOMOR_REKENING]')
    .replace(/^.*\b(?:Jl\.?|Jalan|RT\s?\d|RW\s?\d|Pastori|Kel\.|Kec\.)\b.*$/gim, (line) => /Agus Salim/i.test(line) ? line : '[ALAMAT]');
}

// Bagi percakapan menjadi potongan berurutan untuk dilabeli model.
// Sesi baru bila jeda > gapDays; satu potongan maksimal maxChars karakter.
function chunkConversation(parsed, opts) {
  const options = opts || {};
  const maxChars = options.maxChars || 7000;
  const gapMs = (options.gapDays || 3) * 86400000;
  const chunks = [];
  let current = [];
  let size = 0;
  let last = 0;
  const flush = () => { if (current.length) chunks.push(current); current = []; size = 0; };
  for (const m of parsed.messages) {
    if (m.template) continue;
    const t = Date.parse(m.ts);
    if (last && t - last > gapMs && size > maxChars * 0.5) flush();
    last = t;
    const who = m.role === 'owner' ? 'OWNER' : 'PELANGGAN';
    const parts = [];
    for (const a of m.attachments) parts.push(a.kind === 'image' ? `[GAMBAR ${a.file}]` : `[${a.kind.toUpperCase()}]`);
    if (m.media_omitted && !m.attachments.length) parts.push('[MEDIA]');
    if (m.text) parts.push(redactPii(m.text));
    const line = `${m.ts.slice(0, 10)} ${who}: ${parts.join(' ')}`;
    if (size + line.length > maxChars) flush();
    current.push(line);
    size += line.length + 1;
  }
  flush();
  return chunks.map((lines, index) => ({ index, text: lines.join('\n') }));
}

// Gambar yang dikirim owner beserta konteks percakapan di sekitarnya (untuk pelabelan aset).
function ownerImagesWithContext(parsed, opts) {
  const before = (opts && opts.before) || 3;
  const after = (opts && opts.after) || 2;
  const out = [];
  parsed.messages.forEach((m, i) => {
    if (m.role !== 'owner') return;
    for (const a of m.attachments) {
      if (a.kind !== 'image') continue;
      const ctx = parsed.messages.slice(Math.max(0, i - before), i + after + 1)
        .filter((x) => !x.template)
        .map((x) => `${x.role === 'owner' ? 'OWNER' : 'PELANGGAN'}: ${x.attachments.map((y) => '[' + y.file + ']').join(' ')} ${redactPii(x.text)}`.trim());
      out.push({ file: a.file, ts: m.ts, caption: redactPii(m.text), context: ctx.join('\n') });
    }
  });
  return out;
}
