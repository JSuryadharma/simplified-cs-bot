import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './lib.mjs';

const required = [
  'compose.yaml',
  '.env.example',
  'db/001-init.sql',
  'mock-whatsapp/server.mjs',
  'scripts/generate-workflows.mjs',
];
for (const relative of required) {
  if (!fs.existsSync(path.join(projectRoot, relative))) throw new Error(`File wajib hilang: ${relative}`);
}

const workflowsDir = path.join(projectRoot, 'workflows');
const files = fs.readdirSync(workflowsDir).filter((name) => name.endsWith('.json')).sort();
if (files.length !== 1 || files[0] !== 'wa-admin-lengkap.json') {
  throw new Error(`Diharapkan hanya workflows/wa-admin-lengkap.json, ditemukan: ${files.join(', ')}`);
}

let nodeCount = 0;
let codeNodeCount = 0;
let expressionCount = 0;
const allRaw = [];

function validateExpressions(value, location) {
  if (typeof value === 'string') {
    if (value.startsWith('={{') && value.endsWith('}}')) {
      expressionCount += 1;
      const expression = value.slice(3, -2);
      try {
        new Function(`return (${expression});`);
      } catch (error) {
        throw new Error(`${location}: sintaks expression tidak valid: ${error.message}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateExpressions(entry, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      validateExpressions(entry, `${location}.${key}`);
    }
  }
}

for (const file of files) {
  const raw = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
  allRaw.push(raw);
  const workflow = JSON.parse(raw);
  if (workflow.id !== 'WaAdm1nLengkap26') throw new Error(`${file}: ID workflow gabungan tidak sesuai`);
  const notes = (workflow.nodes || []).filter((current) => current.type === 'n8n-nodes-base.stickyNote');
  if (notes.length < 7) throw new Error(`${file}: Sticky Note penjelasan belum lengkap`);
  const triggerKeys = (workflow.nodes || [])
    .filter((current) => current.type === 'n8n-nodes-base.webhook')
    .map((current) => `${current.parameters?.httpMethod}:${current.parameters?.path}`)
    .sort();
  const expectedTriggers = [
    'GET:whatsapp',
    'POST:admin/import-chat',
    'POST:admin/orders/upsert',
    'POST:admin/upload-knowledge',
    'POST:whatsapp',
  ];
  if (JSON.stringify(triggerKeys) !== JSON.stringify(expectedTriggers)) {
    throw new Error(`${file}: daftar webhook trigger tidak sesuai`);
  }
  const formPaths = (workflow.nodes || [])
    .filter((current) => current.type === 'n8n-nodes-base.formTrigger')
    .map((current) => current.parameters?.options?.path)
    .sort();
  if (JSON.stringify(formPaths) !== JSON.stringify(['admin-upload-knowledge'])) {
    throw new Error(`${file}: form upload knowledge belum terdefinisi dengan benar`);
  }
  const names = new Set();
  const ids = new Set();
  for (const current of workflow.nodes || []) {
    if (names.has(current.name)) throw new Error(`${file}: nama node duplikat ${current.name}`);
    if (ids.has(current.id)) throw new Error(`${file}: ID node duplikat ${current.id}`);
    names.add(current.name);
    ids.add(current.id);
    nodeCount += 1;
    if (current.type === 'n8n-nodes-base.code' && typeof current.parameters?.jsCode === 'string') {
      codeNodeCount += 1;
      try {
        new Function(current.parameters.jsCode);
      } catch (error) {
        throw new Error(`${file}: sintaks Code node "${current.name}" tidak valid: ${error.message}`);
      }
    }
  }
  validateExpressions(workflow, file);
  for (const [from, groups] of Object.entries(workflow.connections || {})) {
    if (!names.has(from)) throw new Error(`${file}: koneksi dari node yang tidak ada: ${from}`);
    for (const group of groups.main || []) {
      for (const edge of group || []) {
        if (!names.has(edge.node)) throw new Error(`${file}: koneksi ke node yang tidak ada: ${edge.node}`);
      }
    }
  }
  const references = [...raw.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
  for (const reference of references) {
    if (!names.has(reference)) throw new Error(`${file}: referensi node tidak ada: ${reference}`);
  }
}

const runtimeEnvExample = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf8');
const envKeys = [...new Set([...allRaw.join('\n').matchAll(/\$env\.([A-Z0-9_]+)/g)].map((match) => match[1]))];
for (const key of envKeys) {
  if (!runtimeEnvExample.includes(`${key}=`)) {
    throw new Error(`Environment workflow belum didokumentasikan di .env.example: ${key}`);
  }
}

process.stdout.write(
  `OK: ${files.length} workflow, ${nodeCount} node, ${codeNodeCount} Code node, ` +
  `${expressionCount} expression, ${envKeys.length} environment key tervalidasi.\n`,
);
