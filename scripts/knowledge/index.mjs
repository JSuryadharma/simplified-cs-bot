// Memuat kode bersama (parser ekspor WhatsApp + pembangun dokumen knowledge) sebagai modul ESM.
// File *.snippet.js yang sama disisipkan ke Code node n8n oleh scripts/apply-knowledge-import.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PARSER_SOURCE = fs.readFileSync(path.join(here, 'wa-parse.snippet.js'), 'utf8');
export const BUILD_SOURCE = fs.readFileSync(path.join(here, 'build.snippet.js'), 'utf8');
const api = new Function(`${PARSER_SOURCE}\n${BUILD_SOURCE}\nreturn { parseWhatsAppExport, redactPii, chunkConversation, ownerImagesWithContext, buildKnowledgeDocs, labelsToDataset, KB_LABEL_SYSTEM, KB_LABEL_SCHEMA };`)();
export const {
  parseWhatsAppExport, redactPii, chunkConversation, ownerImagesWithContext,
  buildKnowledgeDocs, labelsToDataset, KB_LABEL_SYSTEM, KB_LABEL_SCHEMA,
} = api;
export const sha1Hex = (s) => createHash('sha1').update(s).digest('hex');
