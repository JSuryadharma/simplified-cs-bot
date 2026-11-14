// node --test tests/knowledge-edit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildEdit, applyEditToDataset, formatDataset } from '../dashboard/knowledge-edit.mjs';
import { buildKnowledgeDocs } from '../scripts/knowledge/index.mjs';

const DATASET = new URL('../knowledge/dataset/savior-knowledge.json', import.meta.url);
const hashHex = (s) => createHash('sha1').update(s).digest('hex');

test('formatDataset menulis ulang dataset tanpa perubahan format', () => {
  const raw = readFileSync(DATASET, 'utf8');
  assert.equal(formatDataset(JSON.parse(raw)), raw);
});

test('teks dan payload hasil edit sama dengan hasil impor dataset', () => {
  const dataset = JSON.parse(readFileSync(DATASET, 'utf8'));
  const item = dataset.items.find((it) => it.products.length && it.tags.length);
  const [doc] = buildKnowledgeDocs({ items: [item] }, { hashHex }).docs;
  const edit = buildEdit({ answer: item.answer }, doc.payload, 'T');
  assert.equal(edit.text, doc.text);
  assert.equal(edit.payload.tags, doc.payload.tags);
  assert.deepEqual(edit.payload.products, doc.payload.products);
  assert.equal(edit.payload.kb_id, item.id);

  const changed = buildEdit({ question: 'Q baru?', answer: 'Jawaban baru', category: 'bahan', tags: 'a, b', products: ['kaos'] }, doc.payload, 'T');
  assert.equal(changed.text, 'Pertanyaan: Q baru?\nJawaban: Jawaban baru\nProduk: kaos\nTag: a, b');
  assert.equal(changed.payload.category, 'bahan');
  assert.equal(changed.payload.edited_at, 'T');
  assert.equal(changed.payload.source, doc.payload.source, 'field lain dipertahankan');
});

test('validasi dan aturan referensi harga', () => {
  const cur = { content_type: 'chat_qa', category: 'bahan', question: 'q', answer: 'a', auto_reply: true };
  assert.match(buildEdit({ answer: '  ' }, cur).error, /Jawaban/);
  assert.match(buildEdit({ category: 'ngawur' }, cur).error, /Label/);
  assert.match(buildEdit({}, { content_type: 'image_asset' }).error, /gambar/);
  assert.equal(buildEdit({ content_type: 'price_reference', auto_reply: true }, cur).payload.auto_reply, false);
  assert.equal(buildEdit({ auto_reply: false }, cur).payload.auto_reply, false);
});

test('applyEditToDataset hanya mengubah item yang diedit', () => {
  const raw = readFileSync(DATASET, 'utf8');
  const dataset = JSON.parse(raw);
  const target = dataset.items[2];
  const { fields } = buildEdit({ answer: 'Jawaban baru' }, { ...target, kb_id: target.id });
  assert.equal(applyEditToDataset(dataset, target.id, fields), true);
  assert.equal(applyEditToDataset(dataset, 'tidak-ada', fields), false);
  const before = raw.split('\n');
  const after = formatDataset(dataset).split('\n');
  assert.equal(after.length, before.length);
  const diff = after.filter((line, i) => line !== before[i]);
  assert.deepEqual(diff, ['      "answer": "Jawaban baru",']);
});
