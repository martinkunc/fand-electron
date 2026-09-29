// Dump all chapters of FAND projects (.RDB/.PRO) as UTF-8 text files.
// Usage: node src/tools/fand-dump.ts <app-dir> <out-dir>

import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { Rdb, CHAPTER_TYPE_NAMES } from '../engine/fand/rdb.ts';

const [appDir, outDir] = process.argv.slice(2);
if (!appDir || !outDir) {
  console.error('usage: fand-dump <app-dir> <out-dir>');
  process.exit(2);
}

const projects = readdirSync(appDir).filter((f) => /\.(rdb|pro)$/i.test(f));
let total = 0;
let failed = 0;
for (const p of projects) {
  const rdb = new Rdb(join(appDir, p));
  const dir = join(outDir, basename(p).replace('.', '_'));
  mkdirSync(dir, { recursive: true });
  const index: string[] = [];
  for (const ch of rdb.chapters) {
    const file = `${String(ch.recNr).padStart(4, '0')}_${ch.typ.trim() || 'I'}_${ch.name.replace(/[^\p{L}\p{N}_]/gu, '_') || 'noname'}.txt`;
    try {
      writeFileSync(join(dir, file), rdb.text(ch));
      index.push(`${ch.recNr}\t${ch.typ}\t${ch.name}\t${CHAPTER_TYPE_NAMES[ch.typ] ?? '?'}\t${file}`);
      total++;
    } catch (e) {
      failed++;
      index.push(`${ch.recNr}\t${ch.typ}\t${ch.name}\tERROR ${(e as Error).message}`);
    }
  }
  writeFileSync(join(dir, '_index.tsv'), index.join('\n') + '\n');
  console.log(`${p}: ${rdb.chapters.length} chapters, licence ${rdb.tfile.licenseNr}, encrypted ${rdb.encrypted}`);
  rdb.close();
}
console.log(`dumped ${total} chapters, ${failed} failed`);
