// Shared helpers: code pages, flat .NET appSettings configs, case-insensitive paths, logs.

import { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, basename, join, isAbsolute } from 'node:path';
import iconv from 'iconv-lite';

export type CodePage = 852 | 1250 | 65001;

export function decodeCp(buf: Uint8Array, cp: CodePage): string {
  return cp === 65001 ? Buffer.from(buf).toString('utf8').replace(/^\uFEFF/, '') : iconv.decode(Buffer.from(buf), `cp${cp}`);
}

export function encodeCp(text: string, cp: CodePage): Buffer {
  return cp === 65001 ? Buffer.from(text, 'utf8') : iconv.encode(text, `cp${cp}`);
}

/** Find an existing path ignoring case, component by component. Returns the input if not found. */
export function findCaseInsensitive(path: string): string {
  if (existsSync(path)) return path;
  const parent = dirname(path);
  if (parent === path) return path;
  const realParent = findCaseInsensitive(parent);
  const want = basename(path).toLowerCase();
  try {
    const hit = readdirSync(realParent).find((e) => e.toLowerCase() === want);
    return join(realParent, hit ?? basename(path));
  } catch {
    return join(realParent, basename(path));
  }
}

/**
 * Map a DOS path as written by Účto to the host. A drive with a FAND_DRIVE_x root maps to that
 * root (as HANDLE.UnixPath); other drive-letter paths are taken relative to the installation root: everything after the first path element that matches the app
 * directory name (e.g. C:\UCTO2026\{AP02}\X -> <appDir>/{AP02}/X); otherwise relative to cwd.
 */
export function dosToHost(dosPath: string, appDir: string, cwd: string): string {
  const p = dosPath.trim().replace(/\\/g, '/');
  const drive = /^[A-Za-z]:\/?/.exec(p);
  if (drive) {
    const parts = p.slice(drive[0].length).split('/').filter(Boolean);
    // the engine's drive roots (fand.ts main: C: = the parent of the app directory, Z: = '/')
    const root = process.env['FAND_DRIVE_' + drive[0][0].toUpperCase()];
    if (root) return findCaseInsensitive(join(root, ...parts));
    const appName = basename(appDir).toLowerCase();
    const i = parts.findIndex((x) => x.toLowerCase() === appName);
    const rest = i >= 0 ? parts.slice(i + 1) : parts.slice(1);
    return findCaseInsensitive(join(appDir, ...rest));
  }
  if (isAbsolute(p)) return findCaseInsensitive(p);
  return findCaseInsensitive(join(cwd, p));
}

/** Read `<add key="" value="">` pairs of a .NET-style config written by FAND (CP852). */
export function readAppSettings(path: string, cp: CodePage = 852): Map<string, string> {
  const text = decodeCp(readFileSync(findCaseInsensitive(path)), cp);
  const out = new Map<string, string>();
  const re = /<add\s+key\s*=\s*"([^"]*)"\s+value\s*=\s*"([^"]*)"\s*\/?>/gi;
  for (let m; (m = re.exec(text)); ) out.set(m[1], unescapeXml(m[2]));
  return out;
}

export function unescapeXml(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e as string]!);
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** Write CRLF lines in the given code page (StreamWriter.WriteLine semantics: trailing CRLF). */
export function writeLines(path: string, lines: string[], cp: CodePage): void {
  writeFileSync(path, encodeCp(lines.map((l) => l + '\r\n').join(''), cp));
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** .NET style "dd.MM.yyyy - hh:mm" (12-hour clock as the original format string 'hh'). */
export function logStamp(d: Date): string {
  const h = d.getHours() % 12 || 12;
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} - ${pad2(h)}:${pad2(d.getMinutes())}`;
}

export function appendLog(path: string, d: Date, message: string, details = ''): void {
  appendFileSync(path, encodeCp(`${logStamp(d)} | Chyba: ${message}\r\nDetaily:${details}\r\n`, 1250));
}
