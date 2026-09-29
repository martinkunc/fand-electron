// Runs Účto's original .NET helpers under Mono on macOS/Linux (docs/MONO-RUNTIME.md,
// docs/HELPERS-PLATFORMS.md). Nothing in the Účto folder is modified:
//   mono UctoMonoHost.exe <exe>=<patched copy> <config> <shim dirs> [args]
// * the runtime is the relocatable Mono shipped with the app (UCTO_MONO_ROOT), or a system
//   `mono` during development;
// * UctoPatch.exe writes patched copies (paths, CRLF, argv[0]) into a per-user cache;
// * UctoMonoHost.exe runs the helper in its own AppDomain with the X.xml config the helper
//   names in APP_CONFIG_FILE and preloads substitute assemblies (Rebex over Mono's TLS);
// * a private certificate store (XDG_CONFIG_HOME) is filled from the OS roots on first use.

import { spawn } from 'node:child_process';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, openSync, readSync, closeSync, realpathSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootCertificates } from 'node:tls';
import type { HelperContext } from './types.ts';
import { findCaseInsensitive } from './util.ts';

type Env = Record<string, string | undefined>;

// ------------------------------------------------------------------ PE / CLI metadata

export interface AssemblyMeta {
  name: string;
  version: string;
  refs: { name: string; version: string }[];
  isExe: boolean;
}

interface PeLayout {
  buf: Buffer;
  sections: { va: number; vsize: number; raw: number; rawSize: number }[];
  cliRva: number;
  isDll: boolean;
}

/** Parse PE headers; cliRva is 0 for native (non-.NET) images. Null for non-PE files (DOS MZ, scripts). */
function peLayout(buf: Buffer): PeLayout | null {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null; // 'PE\0\0'
  const nSections = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const characteristics = buf.readUInt16LE(pe + 22);
  const opt = pe + 24;
  if (opt + optSize > buf.length || optSize < 2) return null;
  const magic = buf.readUInt16LE(opt);
  const dirs = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : -1;
  if (dirs < 0) return null;
  const nDirs = buf.readUInt32LE(dirs - 4);
  const cliRva = nDirs > 14 && dirs + 15 * 8 <= opt + optSize ? buf.readUInt32LE(dirs + 14 * 8) : 0;
  const sections: PeLayout['sections'] = [];
  const secStart = opt + optSize;
  for (let i = 0; i < nSections && secStart + (i + 1) * 40 <= buf.length; i++) {
    const s = secStart + i * 40;
    sections.push({ vsize: buf.readUInt32LE(s + 8), va: buf.readUInt32LE(s + 12), rawSize: buf.readUInt32LE(s + 16), raw: buf.readUInt32LE(s + 20) });
  }
  return { buf, sections, cliRva, isDll: (characteristics & 0x2000) !== 0 };
}

function rvaToOffset(l: PeLayout, rva: number): number {
  for (const s of l.sections) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw;
  return -1;
}

function readHead(path: string, n: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(n);
    return b.subarray(0, readSync(fd, b, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

export type ExeKind = 'missing' | 'dotnet' | 'win32' | 'dos' | 'other';

/** Classify a program file by its headers (not by its extension). */
export function exeKind(path: string): ExeKind {
  let head: Buffer;
  try {
    if (!statSync(path).isFile()) return 'missing';
    head = readHead(path, 4096);
  } catch {
    return 'missing';
  }
  if (head.length < 2 || head.readUInt16LE(0) !== 0x5a4d) return 'other';
  let l = peLayout(head);
  // Headers beyond the first 4 KB (unusual e_lfanew): read the whole file.
  if (!l && head.length >= 0x40 && head.readUInt32LE(0x3c) + 256 > head.length) {
    try { l = peLayout(readFileSync(path)); } catch { /* keep null */ }
  }
  if (!l) return 'dos';
  return l.cliRva !== 0 ? 'dotnet' : 'win32';
}

/** True when the file is a managed (.NET) PE image: it has a CLI header. */
export function isDotNetAssembly(path: string): boolean {
  return exeKind(path) === 'dotnet';
}

interface Metadata {
  buf: Buffer;
  strings: number; // file offsets of the heaps
  us: number;
  usSize: number;
  blob: number;
  tables: number;
  rows: number[];
  tableOffset: number[];
  rowSize: number[];
  colOffsets: number[][];
  colSizes: number[][];
}

// Column kinds of the metadata tables 0x00..0x23 (ECMA-335 II.22). 2/4 = fixed width,
// 'S' #Strings, 'G' #GUID, 'B' #Blob, 'T<n>' index into table n, 'C<name>' coded index.
const CODED: Record<string, { bits: number; tables: number[] }> = {
  TypeDefOrRef: { bits: 2, tables: [0x02, 0x01, 0x1b] },
  HasConstant: { bits: 2, tables: [0x04, 0x08, 0x17] },
  HasCustomAttribute: { bits: 5, tables: [0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14, 0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b] },
  HasFieldMarshal: { bits: 1, tables: [0x04, 0x08] },
  HasDeclSecurity: { bits: 2, tables: [0x02, 0x06, 0x20] },
  MemberRefParent: { bits: 3, tables: [0x02, 0x01, 0x1a, 0x06, 0x1b] },
  HasSemantics: { bits: 1, tables: [0x14, 0x17] },
  MethodDefOrRef: { bits: 1, tables: [0x06, 0x0a] },
  MemberForwarded: { bits: 1, tables: [0x04, 0x06] },
  Implementation: { bits: 2, tables: [0x26, 0x23, 0x27] },
  CustomAttributeType: { bits: 3, tables: [0x06, 0x0a] },
  ResolutionScope: { bits: 2, tables: [0x00, 0x1a, 0x23, 0x01] },
  TypeOrMethodDef: { bits: 1, tables: [0x02, 0x06] },
};
const SCHEMA: string[][] = [
  /* 00 Module */ ['2', 'S', 'G', 'G', 'G'],
  /* 01 TypeRef */ ['CResolutionScope', 'S', 'S'],
  /* 02 TypeDef */ ['4', 'S', 'S', 'CTypeDefOrRef', 'T4', 'T6'],
  /* 03 FieldPtr */ ['T4'],
  /* 04 Field */ ['2', 'S', 'B'],
  /* 05 MethodPtr */ ['T6'],
  /* 06 MethodDef */ ['4', '2', '2', 'S', 'B', 'T8'],
  /* 07 ParamPtr */ ['T8'],
  /* 08 Param */ ['2', '2', 'S'],
  /* 09 InterfaceImpl */ ['T2', 'CTypeDefOrRef'],
  /* 0A MemberRef */ ['CMemberRefParent', 'S', 'B'],
  /* 0B Constant */ ['2', 'CHasConstant', 'B'],
  /* 0C CustomAttribute */ ['CHasCustomAttribute', 'CCustomAttributeType', 'B'],
  /* 0D FieldMarshal */ ['CHasFieldMarshal', 'B'],
  /* 0E DeclSecurity */ ['2', 'CHasDeclSecurity', 'B'],
  /* 0F ClassLayout */ ['2', '4', 'T2'],
  /* 10 FieldLayout */ ['4', 'T4'],
  /* 11 StandAloneSig */ ['B'],
  /* 12 EventMap */ ['T2', 'T20'],
  /* 13 EventPtr */ ['T20'],
  /* 14 Event */ ['2', 'S', 'CTypeDefOrRef'],
  /* 15 PropertyMap */ ['T2', 'T23'],
  /* 16 PropertyPtr */ ['T23'],
  /* 17 Property */ ['2', 'S', 'B'],
  /* 18 MethodSemantics */ ['2', 'T6', 'CHasSemantics'],
  /* 19 MethodImpl */ ['T2', 'CMethodDefOrRef', 'CMethodDefOrRef'],
  /* 1A ModuleRef */ ['S'],
  /* 1B TypeSpec */ ['B'],
  /* 1C ImplMap */ ['2', 'CMemberForwarded', 'S', 'T26'],
  /* 1D FieldRVA */ ['4', 'T4'],
  /* 1E EncLog */ ['4', '4'],
  /* 1F EncMap */ ['4'],
  /* 20 Assembly */ ['4', '2', '2', '2', '2', '4', 'B', 'S', 'S'],
  /* 21 AssemblyProcessor */ ['4'],
  /* 22 AssemblyOS */ ['4', '4', '4'],
  /* 23 AssemblyRef */ ['2', '2', '2', '2', '4', 'B', 'S', 'S', 'B'],
];

function readMetadata(buf: Buffer): Metadata | null {
  const l = peLayout(buf);
  if (!l || !l.cliRva) return null;
  const cli = rvaToOffset(l, l.cliRva);
  if (cli < 0) return null;
  const root = rvaToOffset(l, buf.readUInt32LE(cli + 8));
  if (root < 0 || buf.readUInt32LE(root) !== 0x424a5342) return null; // 'BSJB'
  const verLen = buf.readUInt32LE(root + 12);
  let p = root + 16 + verLen + 2;
  const nStreams = buf.readUInt16LE(p);
  p += 2;
  const md: Partial<Metadata> = { buf, strings: -1, us: -1, usSize: 0, blob: -1, tables: -1 };
  for (let i = 0; i < nStreams; i++) {
    const off = buf.readUInt32LE(p), size = buf.readUInt32LE(p + 4);
    let e = p + 8;
    while (buf[e] !== 0) e++;
    const name = buf.toString('latin1', p + 8, e);
    p = (e + 4) & ~3;
    if (name === '#Strings') md.strings = root + off;
    else if (name === '#US') { md.us = root + off; md.usSize = size; }
    else if (name === '#Blob') md.blob = root + off;
    else if (name === '#~' || name === '#-') md.tables = root + off;
  }
  if (md.tables! < 0) return null;
  const t = md.tables!;
  const heapSizes = buf[t + 6];
  const valid = buf.readBigUInt64LE(t + 8);
  const rows: number[] = [];
  let q = t + 24;
  for (let i = 0; i < 64; i++) {
    if ((valid >> BigInt(i)) & 1n) { rows[i] = buf.readUInt32LE(q); q += 4; } else rows[i] = 0;
  }
  if (heapSizes & 0x40) q += 4; // extra data
  const sizeOf = (col: string): number => {
    if (col === '2') return 2;
    if (col === '4') return 4;
    if (col === 'S') return heapSizes & 1 ? 4 : 2;
    if (col === 'G') return heapSizes & 2 ? 4 : 2;
    if (col === 'B') return heapSizes & 4 ? 4 : 2;
    if (col[0] === 'T') return rows[Number(col.slice(1))] < 0x10000 ? 2 : 4;
    const c = CODED[col.slice(1)];
    const max = Math.max(...c.tables.map((x) => rows[x] ?? 0));
    return max < 1 << (16 - c.bits) ? 2 : 4;
  };
  const tableOffset: number[] = [], rowSize: number[] = [], colOffsets: number[][] = [], colSizes: number[][] = [];
  for (let i = 0; i < SCHEMA.length; i++) {
    const sizes = SCHEMA[i].map(sizeOf);
    const offs: number[] = [];
    sizes.reduce((a, s) => (offs.push(a), a + s), 0);
    colSizes[i] = sizes;
    colOffsets[i] = offs;
    rowSize[i] = sizes.reduce((a, s) => a + s, 0);
    tableOffset[i] = q;
    q += rowSize[i] * rows[i];
  }
  return { ...(md as Metadata), rows, tableOffset, rowSize, colOffsets, colSizes };
}

function cell(md: Metadata, table: number, row: number, col: number): number {
  const at = md.tableOffset[table] + row * md.rowSize[table] + md.colOffsets[table][col];
  return md.colSizes[table][col] === 2 ? md.buf.readUInt16LE(at) : md.buf.readUInt32LE(at);
}

function heapString(md: Metadata, idx: number): string {
  const s = md.strings + idx;
  let e = s;
  while (md.buf[e] !== 0) e++;
  return md.buf.toString('utf8', s, e);
}

/** Read a compressed length (ECMA-335 II.24.2.4) at `at`: [length, header bytes]. */
function compressedLength(buf: Buffer, at: number): [number, number] {
  const b = buf[at];
  if ((b & 0x80) === 0) return [b, 1];
  if ((b & 0xc0) === 0x80) return [((b & 0x3f) << 8) | buf[at + 1], 2];
  return [((b & 0x1f) << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3], 4];
}

/** Name, version and assembly references of a .NET assembly; null for other files. */
export function readAssemblyMeta(path: string): AssemblyMeta | null {
  let buf: Buffer;
  try { buf = readFileSync(path); } catch { return null; }
  let md: Metadata | null;
  try { md = readMetadata(buf); } catch { return null; }
  if (!md || md.rows[0x20] === 0) return null;
  const ver = (t: number, r: number, c: number) => [0, 1, 2, 3].map((i) => cell(md!, t, r, c + i)).join('.');
  const refs: AssemblyMeta['refs'] = [];
  for (let r = 0; r < md.rows[0x23]; r++) refs.push({ name: heapString(md, cell(md, 0x23, r, 6)), version: ver(0x23, r, 0) });
  const l = peLayout(buf)!;
  return { name: heapString(md, cell(md, 0x20, 0, 7)), version: ver(0x20, 0, 1), refs, isExe: !l.isDll };
}

/**
 * The config file name a helper sets with AppDomain.CurrentDomain.SetData("APP_CONFIG_FILE", "X.xml"):
 * the IL is `ldstr "APP_CONFIG_FILE"; ldstr "X.xml"; callvirt SetData`. Null when absent.
 */
export function configNameFromIl(path: string): string | null {
  let buf: Buffer;
  try { buf = readFileSync(path); } catch { return null; }
  let md: Metadata | null;
  try { md = readMetadata(buf); } catch { return null; }
  if (!md || md.us < 0) return null;
  const usAt = (off: number): string | null => {
    if (off <= 0 || off >= md!.usSize) return null;
    const [len, hdr] = compressedLength(buf, md!.us + off);
    if (len < 1) return '';
    return buf.toString('utf16le', md!.us + off + hdr, md!.us + off + hdr + len - 1);
  };
  // Offset of "APP_CONFIG_FILE" in #US.
  let key = -1;
  for (let off = 1; off < md.usSize; ) {
    const [len, hdr] = compressedLength(buf, md.us + off);
    if (len === 0 && hdr === 1 && buf[md.us + off] === 0) break; // padding
    if (len === 31 && buf.toString('utf16le', md.us + off + hdr, md.us + off + hdr + 30) === 'APP_CONFIG_FILE') { key = off; break; }
    off += hdr + len;
  }
  if (key < 0) return null;
  const pat = Buffer.from([0x72, key & 0xff, (key >> 8) & 0xff, (key >> 16) & 0xff, 0x70, 0x72]);
  for (let at = buf.indexOf(pat); at >= 0; at = buf.indexOf(pat, at + 1)) {
    if (buf[at + 9] !== 0x70) continue;
    const s = usAt(buf.readUIntLE(at + 6, 3));
    if (s) return s;
  }
  return null;
}

// ------------------------------------------------------------------ locations

const MODULE_DIR = (() => {
  try { return dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
})();
/** Repository root in development (src/helpers or out/main -> two levels up). */
const DEV_ROOT = resolve(MODULE_DIR, '../..');

export const platformTag = (platform: string = process.platform, arch: string = process.arch) => `${platform}-${arch}`;

export interface MonoRuntime {
  /** The mono executable. */
  mono: string;
  /** Installation prefix (bin/, lib/mono, etc/mono), or null when unknown. */
  prefix: string | null;
  /** The relocatable runtime shipped with the app (false: a system Mono found on PATH). */
  bundled: boolean;
}

function isPrefix(dir: string | undefined): dir is string {
  return !!dir && existsSync(join(dir, 'bin', 'mono')) && existsSync(join(dir, 'lib', 'mono', '4.5', 'mscorlib.dll'));
}

function onPath(cmd: string, env: Env): string | null {
  for (const d of (env.PATH ?? '').split(delimiter)) {
    if (!d) continue;
    const f = join(d, cmd);
    try { if (statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

/**
 * Find Mono: $UCTO_MONO_ROOT, the runtime shipped in the app resources
 * (<resources>/mono or <resources>/mono/<platform>-<arch>), the development build
 * (resources/mono/<platform>-<arch>), else a system `mono` on PATH.
 */
export function locateMono(env: Env = process.env): MonoRuntime | null {
  const tag = platformTag();
  const res = (process as { resourcesPath?: string }).resourcesPath;
  if (env.UCTO_MONO_ROOT) return isPrefix(env.UCTO_MONO_ROOT) ? { mono: join(env.UCTO_MONO_ROOT, 'bin', 'mono'), prefix: env.UCTO_MONO_ROOT, bundled: true } : null;
  const candidates = [
    res && join(res, 'mono', tag),
    res && join(res, 'mono'),
    env.UCTO_RESOURCES && join(env.UCTO_RESOURCES, 'mono', tag),
    join(DEV_ROOT, 'resources', 'mono', tag),
  ];
  for (const c of candidates) if (isPrefix(c)) return { mono: join(c, 'bin', 'mono'), prefix: c, bundled: true };
  if (env.UCTO_MONO_SYSTEM === '0') return null;
  const extra = process.platform === 'darwin' ? ['/Library/Frameworks/Mono.framework/Versions/Current/Commands/mono', '/opt/homebrew/bin/mono', '/usr/local/bin/mono'] : [];
  const sys = onPath('mono', env) ?? extra.find((f) => existsSync(f)) ?? null;
  if (!sys) return null;
  let prefix: string | null = null;
  try {
    const real = realpathSync(sys);
    const p = dirname(dirname(real));
    if (existsSync(join(p, 'lib', 'mono', '4.5'))) prefix = p;
  } catch { /* unknown prefix */ }
  return { mono: sys, prefix, bundled: false };
}

export interface MonoShims {
  root: string;
  host: string; // UctoMonoHost.exe
  patcher: string | null; // UctoPatch.exe (Mono.Cecil.dll beside it)
  shimLib: string | null; // UctoShim.dll
}

/** The built launcher/patcher/substitutes: $UCTO_MONO_SHIMS, the app resources, or shims/mono. */
export function locateShims(env: Env = process.env): MonoShims | null {
  const res = (process as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    env.UCTO_MONO_SHIMS,
    res && join(res, 'mono-shims'),
    res && join(res, 'shims', 'mono'),
    env.UCTO_RESOURCES && join(env.UCTO_RESOURCES, 'shims', 'mono'),
    join(DEV_ROOT, 'shims', 'mono'),
  ];
  for (const root of candidates) {
    if (!root || !existsSync(join(root, 'host', 'UctoMonoHost.exe'))) continue;
    const patcher = join(root, 'patch', 'UctoPatch.exe');
    const shimLib = [join(root, 'shimlib', 'UctoShim.dll'), join(root, 'patch', 'UctoShim.dll')].find((f) => existsSync(f)) ?? null;
    return { root, host: join(root, 'host', 'UctoMonoHost.exe'), patcher: existsSync(patcher) && shimLib ? patcher : null, shimLib };
  }
  return null;
}

/** Per-user data: $UCTO_USER_DATA (Electron's userData), else the OS application-data folder. */
export function userDataDir(env: Env = process.env): string {
  if (env.UCTO_USER_DATA) return env.UCTO_USER_DATA;
  const home = env.HOME || homedir();
  if (process.platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'ucto');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'ucto');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'ucto');
}

/** Private Mono home (XDG_CONFIG_HOME for mono): certificate store, user-dirs.dirs. */
export const monoConfigDir = (userData: string) => join(userData, 'mono');
export const patchCacheDir = (userData: string) => join(userData, 'mono-patch');
export const logDir = (userData: string) => join(userData, 'logs');

// ------------------------------------------------------------------ environment

const DROP = ['MONO_PATH', 'MONO_GAC_PREFIX', 'MONO_CFG_DIR', 'MONO_CONFIG', 'MONO_ENV_OPTIONS', 'MONO_TLS_PROVIDER'];

/**
 * Linux GUI helpers (WinForms) need an X display: keep DISPLAY; under a pure Wayland
 * session pick the XWayland socket. macOS needs nothing (no X11; WinForms uses Carbon).
 */
export function displayEnv(env: Env, platform: string = process.platform, x11Dir = '/tmp/.X11-unix'): Env {
  if (platform !== 'linux' || env.DISPLAY) return {};
  if (!env.WAYLAND_DISPLAY) return {};
  try {
    const n = readdirSync(x11Dir).map((f) => /^X(\d+)$/.exec(f)?.[1]).filter((x): x is string => !!x).sort((a, b) => Number(a) - Number(b))[0];
    return n !== undefined ? { DISPLAY: ':' + n } : {};
  } catch {
    return {};
  }
}

/**
 * DOS drive letters inside exchange files (C:\UCTO2026\{AP02}\X.TXT) map like the engine's
 * HANDLE.UnixPath: $FAND_DRIVE_X, else the parent of the FAND task directory.
 */
export function driveEnv(env: Env, cwd: string): Env {
  const out: Env = {};
  const parent = dirname(resolve(cwd));
  for (let c = 65; c <= 90; c++) {
    const l = String.fromCharCode(c);
    out['UCTO_DRIVE_' + l] = env['FAND_DRIVE_' + l] || env['UCTO_DRIVE_' + l] || parent;
  }
  return out;
}

/** Environment for every mono process (docs/MONO-RUNTIME.md "Starting mono"). */
export function monoEnv(rt: MonoRuntime, base: Env, userData: string): Record<string, string> {
  const e: Env = { ...base };
  for (const k of DROP) delete e[k];
  const xdg = monoConfigDir(userData);
  if (base.XDG_CONFIG_HOME !== xdg) e.UCTO_ORIG_XDG_CONFIG_HOME = base.XDG_CONFIG_HOME ?? '';
  e.XDG_CONFIG_HOME = xdg;
  e.MONO_XMLSERIALIZER_THS = 'no';
  if (process.platform === 'darwin' && rt.prefix && existsSync(join(rt.prefix, 'etc', 'fonts'))) e.FONTCONFIG_PATH = join(rt.prefix, 'etc', 'fonts');
  const opener = join(xdg, 'bin', 'ucto-open');
  if (process.platform === 'linux' && !e.UCTO_OPEN_CMD && existsSync(opener)) e.UCTO_OPEN_CMD = opener;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) if (v !== undefined) out[k] = v;
  return out;
}

// ------------------------------------------------------------------ processes

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
}

const MAX_OUT = 1 << 20;

export function runProcess(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<RunResult> {
  return new Promise((done) => {
    let stdout = '', stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs, windowsHide: false });
    } catch (e) {
      done({ code: 1, stdout, stderr, error: String(e) });
      return;
    }
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < MAX_OUT) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_OUT) stderr += d.toString('utf8'); });
    child.on('error', (e) => done({ code: 1, stdout, stderr, error: e.message }));
    child.on('close', (code, signal) => done({ code: code ?? 1, stdout, stderr, error: signal ? `killed by ${signal}` : undefined }));
  });
}

// ------------------------------------------------------------------ certificate store

/** System CA bundles (PEM), first existing wins (the list Go's crypto/x509 uses on Linux). */
export const LINUX_CA_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/pki/tls/cacert.pem',
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
  '/etc/ssl/cert.pem',
];
const MAC_KEYCHAINS = ['/System/Library/Keychains/SystemRootCertificates.keychain', '/Library/Keychains/System.keychain'];

export function findCaBundle(candidates = LINUX_CA_BUNDLES): string | null {
  for (const f of candidates) {
    try { if (statSync(f).size > 0) return f; } catch { /* next */ }
  }
  return null;
}

function certSyncExe(rt: MonoRuntime): string | null {
  const f = rt.prefix && join(rt.prefix, 'lib', 'mono', '4.5', 'cert-sync.exe');
  return f && existsSync(f) ? f : null;
}

let certStore: Promise<boolean> | null = null;

/**
 * First-run (and after CA or app updates) import of the OS root certificates into Mono's
 * private store under <userData>/mono/.mono/certs. Resolves false when it could not be done;
 * helpers still run (TLS may then fail on Linux).
 */
export function ensureCertStore(rt: MonoRuntime, env: Env = process.env, userData = userDataDir(env)): Promise<boolean> {
  certStore ??= syncCerts(rt, env, userData).catch((e) => {
    console.error('cert-sync:', e);
    return false;
  });
  return certStore;
}

/** Test hook: forget the once-per-process result of ensureCertStore. */
export function resetCertStore(): void {
  certStore = null;
}

async function syncCerts(rt: MonoRuntime, env: Env, userData: string): Promise<boolean> {
  const xdg = monoConfigDir(userData);
  mkdirSync(xdg, { recursive: true });
  prepareConfigDir(xdg, env);
  const exe = certSyncExe(rt);
  if (!exe) return false;
  const stateFile = join(xdg, 'cert-sync.json');
  const sources = process.platform === 'darwin' ? MAC_KEYCHAINS.filter((f) => existsSync(f)) : [findCaBundle() ?? 'node:tls'];
  const state = {
    sources: sources.map((f) => {
      try { const s = statSync(f); return { path: f, size: s.size, mtime: s.mtimeMs }; } catch { return { path: f, size: 0, mtime: 0 }; }
    }),
    appVersion: env.UCTO_APP_VERSION ?? '',
    mono: rt.mono,
  };
  try {
    if (JSON.stringify(JSON.parse(readFileSync(stateFile, 'utf8'))) === JSON.stringify(state) && existsSync(join(xdg, '.mono', 'certs', 'Trust'))) return true;
  } catch { /* first run */ }

  let bundle = sources[0];
  let tmp: string | null = null;
  if (process.platform === 'darwin' || bundle === 'node:tls') {
    tmp = join(xdg, 'roots.pem');
    let pem = '';
    if (process.platform === 'darwin') {
      for (const k of sources) {
        const r = await runProcess('/usr/bin/security', ['find-certificate', '-a', '-p', k], {});
        if (r.code === 0) pem += r.stdout;
      }
    }
    if (!pem.includes('BEGIN CERTIFICATE')) pem = rootCertificates.join('\n') + '\n';
    writeFileSync(tmp, pem);
    bundle = tmp;
  }
  const r = await runProcess(rt.mono, [exe, '--quiet', '--user', bundle], { env: monoEnv(rt, env, userData), timeoutMs: 120_000 });
  if (r.code !== 0) {
    console.error(`cert-sync failed (${r.code}): ${r.error ?? ''} ${r.stderr}`);
    return false;
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return true;
}

/**
 * Prepare the private XDG_CONFIG_HOME: copy ~/.config/user-dirs.dirs (Mono resolves Desktop
 * etc. through it) and, on Linux, an opener that restores the user's XDG_CONFIG_HOME so
 * xdg-open keeps the user's default applications.
 */
function prepareConfigDir(xdg: string, env: Env): void {
  const userCfg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== xdg ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), '.config');
  const dirs = join(userCfg, 'user-dirs.dirs');
  try { if (existsSync(dirs)) copyFileSync(dirs, join(xdg, 'user-dirs.dirs')); } catch { /* optional */ }
  if (process.platform !== 'linux') return;
  const opener = join(xdg, 'bin', 'ucto-open');
  const script = '#!/bin/sh\n# Opens documents for Účto helpers running under Mono with the user\'s own XDG settings.\n' +
    'if [ -n "$UCTO_ORIG_XDG_CONFIG_HOME" ]; then XDG_CONFIG_HOME="$UCTO_ORIG_XDG_CONFIG_HOME"; export XDG_CONFIG_HOME; else unset XDG_CONFIG_HOME; fi\n' +
    'exec xdg-open "$@"\n';
  try {
    if (!existsSync(opener) || readFileSync(opener, 'utf8') !== script) {
      mkdirSync(dirname(opener), { recursive: true });
      writeFileSync(opener, script);
      chmodSync(opener, 0o755);
    }
  } catch { /* optional */ }
}

// ------------------------------------------------------------------ patching

export interface Prepared {
  /** Assembly the host loads instead of the original (patched copy), or null for the original. */
  load: string | null;
  /** Folder of the patched copies (its DLLs are preloaded), or null. */
  dir: string | null;
  /** Config file name from APP_CONFIG_FILE, relative to the helper folder, or null. */
  config: string | null;
  log: string;
}

/**
 * Ensure a patched copy of `exe` (and the private DLLs it uses) exists in the cache:
 * `mono UctoPatch.exe --prepare` is idempotent and keyed by content hashes.
 */
export async function preparePatched(rt: MonoRuntime, shims: MonoShims, exe: string, env: Record<string, string>, userData: string, exclude: string[]): Promise<Prepared> {
  if (!shims.patcher || !shims.shimLib) return { load: null, dir: null, config: null, log: 'UctoPatch not built' };
  const args = [shims.patcher, '--prepare', exe, '--shim', shims.shimLib, '--cache', patchCacheDir(userData)];
  if (exclude.length) args.push('--exclude', exclude.join(';'));
  const r = await runProcess(rt.mono, args, { env, timeoutMs: 300_000 });
  const out = Object.fromEntries(r.stdout.split(/\r?\n/).map((l) => /^(\w+)=(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2]]));
  const log = `$ ${rt.mono} ${args.join(' ')}\n${r.stdout}${r.stderr}${r.error ? r.error + '\n' : ''}exit ${r.code}\n`;
  if (r.code !== 0 || !out.dir) return { load: null, dir: null, config: null, log };
  const load = join(out.dir, basename(exe));
  return { load: existsSync(load) ? load : null, dir: out.dir, config: out.config || null, log };
}

// ------------------------------------------------------------------ running

/** Substitute Rebex set matching the Rebex version shipped next to the helper (bin/<version>). */
export function rebexShimDir(shims: MonoShims, exe: string): string | null {
  const base = join(shims.root, 'rebex', 'bin');
  const dir = dirname(exe);
  let version: string | null = null;
  const common = findCaseInsensitive(join(dir, 'Rebex.Common.dll'));
  if (existsSync(common)) version = readAssemblyMeta(common)?.version ?? null;
  if (!version) version = readAssemblyMeta(exe)?.refs.find((r) => /^Rebex\./i.test(r.name))?.version ?? null;
  if (!version) return null;
  const d = join(base, version);
  return existsSync(join(d, 'Rebex.Common.dll')) ? d : null;
}

export interface MonoCommand {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  log: string;
  /** MessageBoxes are answered by the shim (OK) and must be shown by us afterwards. */
  forwardMessages: boolean;
}

/**
 * WinForms cannot show dialogs on macOS (64-bit Mono has no Carbon driver) or on Linux
 * without an X display: there the patched helpers answer MessageBox.Show themselves
 * ($UCTO_MESSAGEBOX=stderr, see shims/mono/shimlib/Forms.cs) and the texts are shown on
 * the FAND screen when the helper ends. An explicit $UCTO_MESSAGEBOX is kept.
 */
export function messageBoxMode(env: Env, platform: string = process.platform): string | null {
  if (env.UCTO_MESSAGEBOX !== undefined) return null;
  if (platform === 'darwin') return 'stderr';
  if (platform === 'linux' && !env.DISPLAY) return 'stderr';
  return null;
}

/** "MessageBox [caption]: text | line 2" lines the shim writes to stderr. */
export function parseMessageBoxes(stderr: string): { caption: string; text: string }[] {
  const out: { caption: string; text: string }[] = [];
  for (const m of stderr.matchAll(/^MessageBox \[(.*?)\]: (.*)$/gm)) out.push({ caption: m[1], text: m[2].replace(/ \| /g, '\n').trimEnd() });
  return out;
}

/** The first line of an unhandled exception the launcher printed, if any. */
export function unhandledException(stderr: string): string | null {
  const m = /^(?:Unhandled Exception:\s*)?((?:[\w]+\.)+\w*Exception\b.*)$/m.exec(stderr);
  return m ? m[1].trim() : null;
}

/** Everything needed to start `exe` under Mono (patching it first when the patcher is built). */
export async function monoCommand(rt: MonoRuntime, shims: MonoShims, exe: string, args: string[], cwd: string, base: Env): Promise<MonoCommand> {
  const userData = userDataDir(base);
  const env = { ...monoEnv(rt, base, userData), ...(driveEnv(base, cwd) as Record<string, string>), ...(displayEnv(base) as Record<string, string>) };
  const mb = messageBoxMode(env);
  if (mb) env.UCTO_MESSAGEBOX = mb;
  const rebex = rebexShimDir(shims, exe);
  const substitutes = rebex ? readdirSync(rebex).filter((f) => /\.dll$/i.test(f)) : [];
  const p = base.UCTO_MONO_NOPATCH === '1' ? { load: null, dir: null, config: null, log: 'patching disabled\n' } : await preparePatched(rt, shims, exe, env, userData, substitutes);
  const configName = p.config ?? configNameFromIl(exe);
  const config = configName ? findCaseInsensitive(resolve(dirname(exe), configName.replace(/\\/g, '/'))) : exe + '.config';
  const shimDirs = [p.dir, rebex, shims.shimLib && dirname(shims.shimLib)].filter((d): d is string => !!d);
  const target = p.load ? `${exe}=${p.load}` : exe;
  return { cmd: rt.mono, args: [shims.host, target, config, shimDirs.join(';'), ...args], cwd, env, log: p.log, forwardMessages: !!mb };
}

/** Helper implementation: run the original .NET program `exe` under Mono. */
export async function runMonoHelper(exe: string, ctx: HelperContext): Promise<number> {
  const name = basename(exe);
  const rt = locateMono(ctx.env);
  const shims = locateShims(ctx.env);
  if (!rt || !shims) {
    await ctx.ui.message(name, `Program ${name} nelze spustit: chybí běhové prostředí Mono${rt ? ' (spouštěč UctoMonoHost)' : ''}.\nPřeinstalujte aplikaci.`, 'error');
    return 1;
  }
  await ensureCertStore(rt, ctx.env);
  const c = await monoCommand(rt, shims, exe, ctx.args, ctx.cwd, ctx.env);
  const r = await runProcess(c.cmd, c.args, { cwd: c.cwd, env: c.env, timeoutMs: Number(ctx.env.UCTO_HELPER_TIMEOUT_MS) || 12 * 3600_000 });
  const logFile = writeRunLog(ctx.env, name, c, r);
  const boxes = c.forwardMessages ? parseMessageBoxes(r.stderr) : [];
  for (const b of boxes.slice(0, 10)) await ctx.ui.message(b.caption || name, b.text, 'info');
  if (r.code !== 0 && !boxes.length) {
    const why = r.error && !r.stderr ? r.error : unhandledException(r.stderr);
    if (why) await ctx.ui.message(name, `Program ${name} skončil s chybou:\n${why}${logFile ? `\n\nPodrobnosti: ${logFile}` : ''}`, 'error');
  }
  return r.code;
}

function writeRunLog(env: Env, name: string, c: MonoCommand, r: RunResult): string | null {
  try {
    const dir = logDir(userDataDir(env));
    mkdirSync(dir, { recursive: true });
    const text = `${new Date().toISOString()}\n${c.log}$ cd ${c.cwd}\n$ ${c.cmd} ${c.args.map((a) => JSON.stringify(a)).join(' ')}\n` +
      `--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}\n--- exit ${r.code}${r.error ? ' (' + r.error + ')' : ''}\n`;
    const file = join(dir, `mono-${name.toLowerCase().replace(/\.exe$/, '')}.log`);
    writeFileSync(file, text);
    return file;
  } catch {
    return null; // logging is best effort
  }
}
