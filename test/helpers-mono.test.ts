// Helper dispatch (Windows originals / Mono / TypeScript ports) and the Mono runner.
// The end-to-end tests run the ORIGINAL UctoQR.exe from a copy of the pristine Účto in
// work/tmp-integration/ and are skipped when no Mono runtime or no built shims exist.

import { describe, it, expect, beforeAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import iconv from 'iconv-lite';
import { routeFor, helperName, portEnabled, helperForRoute, type Route } from '../src/helpers/dispatch.ts';
import { HELPERS, routeOf } from '../src/helpers/registry.ts';
import {
  exeKind, isDotNetAssembly, readAssemblyMeta, configNameFromIl, locateMono, locateShims, rebexShimDir,
  displayEnv, driveEnv, monoEnv, messageBoxMode, parseMessageBoxes, unhandledException, findCaBundle, monoCommand,
  type ExeKind,
} from '../src/helpers/mono.ts';
import { runHelperSync, type SyncUi } from '../src/helpers/sync.ts';
import { recordingUi, testContext } from '../src/helpers/testing.ts';

const ROOT = resolve(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const hasApp = existsSync(join(APP, '{tisk}', 'UctoQR.exe'));

const ports = (n: string) => Object.hasOwn(HELPERS, n);
const probeOf = (kinds: Record<string, ExeKind>) => (p: string) => kinds[p.replace(/\\/g, '/').split('/').pop()!.toLowerCase()] ?? 'missing';
const KINDS: Record<string, ExeKind> = {
  'ares2.exe': 'dotnet', 'uctoexp.exe': 'dotnet', 'uemail06.exe': 'win32', 'utisk04.exe': 'win32', 'fand2pdf.exe': 'win32',
  'nic.exe': 'dos', 'ro.exe': 'dos', 'x.bat': 'other',
};
const route = (exe: string, platform: NodeJS.Platform, env: Record<string, string> = {}) =>
  routeFor(`/u/{tisk}/${exe}`, { platform, env, hasPort: ports, probe: probeOf(KINDS) });

describe('helper dispatch', () => {
  it('names helpers like EXEC does', () => {
    expect(helperName('C:\\UCTO\\{AP02}\\ARES2.EXE')).toBe('ares2.exe');
    expect(helperName('/x/Utisk04')).toBe('utisk04.exe');
  });

  it('Windows: runs the originals; TypeScript ports only when configured', () => {
    expect(route('ARES2.EXE', 'win32')).toMatchObject({ kind: 'native', name: 'ares2.exe' });
    expect(route('Utisk04.exe', 'win32')).toMatchObject({ kind: 'native' });
    expect(route('UEMAIL06.EXE', 'win32')).toMatchObject({ kind: 'native' });
    expect(route('Utisk04.exe', 'win32', { UCTO_HELPER_PORTS: 'utisk04' })).toEqual({ kind: 'port', name: 'utisk04.exe' });
    expect(route('FAND2PDF.EXE', 'win32', { UCTO_HELPER_PORTS: 'all' })).toEqual({ kind: 'port', name: 'fand2pdf.exe' });
    expect(route('RO.EXE', 'win32')).toBeNull(); // DOS program: the engine handles it
    expect(route('X.BAT', 'win32')).toBeNull();
    expect(route('MISSING.EXE', 'win32')).toBeNull();
  });

  for (const platform of ['linux', 'darwin'] as const) {
    it(`${platform}: .NET -> Mono, native with a port -> port, other native -> unavailable`, () => {
      expect(route('Ares2.exe', platform)).toMatchObject({ kind: 'mono', name: 'ares2.exe' });
      expect(route('Utisk04.exe', platform)).toEqual({ kind: 'port', name: 'utisk04.exe' });
      expect(route('FAND2PDF.EXE', platform)).toEqual({ kind: 'port', name: 'fand2pdf.exe' });
      expect(route('NIC.EXE', platform)).toEqual({ kind: 'port', name: 'nic.exe' });
      expect(route('UEMAIL06.EXE', platform)).toMatchObject({ kind: 'unavailable', name: 'uemail06.exe' });
      expect(route('RO.EXE', platform)).toBeNull();
      expect(route('MISSING.EXE', platform)).toBeNull();
      // UctoExp keeps its port until the original is verified under Mono; it can be forced.
      expect(route('UctoExp.exe', platform)).toEqual({ kind: 'port', name: 'uctoexp.exe' });
      expect(route('UctoExp.exe', platform, { UCTO_HELPER_PORTS: 'none' })).toMatchObject({ kind: 'mono' });
    });
  }

  it('ports can be listed by name', () => {
    expect(portEnabled('utisk04.exe', 'win32', { UCTO_HELPER_PORTS: 'fand2pdf, utisk04.exe' })).toBe(true);
    expect(portEnabled('uctoexp.exe', 'win32', { UCTO_HELPER_PORTS: 'fand2pdf, utisk04.exe' })).toBe(false);
    expect(portEnabled('uctoexp.exe', 'linux', {})).toBe(true);
  });

  it('Ares2 and Nepl2 are no longer ported', () => {
    expect(ports('ares2.exe')).toBe(false);
    expect(ports('nepl2.exe')).toBe(false);
  });

  it('tells the user when a program is not available on this platform', async () => {
    const { ui, log } = recordingUi();
    const r: Route = { kind: 'unavailable', exe: '/u/{tisk}/UEMAIL06.EXE', name: 'uemail06.exe' };
    expect(await helperForRoute(r, HELPERS)(testContext('/u', r.exe, [], ui))).toBe(1);
    expect(log.messages[0].text).toBe('Program UEMAIL06.EXE není na této platformě dostupný.');
  });
});

describe.skipIf(!hasApp)('.NET detection on the original helpers', () => {
  it('classifies by PE/CLI headers, not by extension', () => {
    expect(exeKind(join(APP, '{ap02}', 'Ares2.exe'))).toBe('dotnet');
    expect(exeKind(join(APP, '{tisk}', 'UctoQR.exe'))).toBe('dotnet');
    expect(exeKind(join(APP, '{ap02}', 'Rebex.Http.dll'))).toBe('dotnet');
    expect(exeKind(join(APP, '{tisk}', 'Utisk04.exe'))).toBe('win32'); // VB6
    expect(exeKind(join(APP, '{tisk}', 'FAND2PDF.EXE'))).toBe('win32');
    expect(exeKind(join(APP, 'NIC.EXE'))).toBe('dos'); // Borland Pascal
    expect(exeKind(join(APP, '{tisk}', 'nope.exe'))).toBe('missing');
    expect(isDotNetAssembly(join(APP, '{tisk}', 'UEMAIL06.EXE'))).toBe(false);
  });

  it('reads assembly identities and references', () => {
    const rebex = readAssemblyMeta(join(APP, '{ap03}', 'Rebex.Common.dll'))!;
    expect([rebex.name, rebex.version, rebex.isExe]).toEqual(['Rebex.Common', '5.0.7320.0', false]);
    const ares = readAssemblyMeta(join(APP, '{ap02}', 'Ares2.exe'))!;
    expect(ares.isExe).toBe(true);
    expect(ares.refs).toContainEqual({ name: 'Rebex.Http', version: '6.0.8000.0' });
  });

  it('finds the APP_CONFIG_FILE name in the IL', () => {
    expect(configNameFromIl(join(APP, '{ap02}', 'Ares2.exe'))).toBe('Ares2.xml');
    expect(configNameFromIl(join(APP, '{tisk}', 'UctoQR.exe'))).toBe('UctoQR.xml');
    expect(configNameFromIl(join(APP, '{ap03}', 'UctoZP2.exe'))).toBe('UctoZP.xml'); // not the exe name
    expect(configNameFromIl(join(APP, '{ap02}', 'Nepl2.exe'))).toBeNull(); // uses Nepl2.exe.config semantics
  });

  it('routes the real files on this platform', () => {
    const env = { ...process.env, UCTO_HELPER_PORTS: undefined };
    const ares = routeOf(join(APP, '{AP02}', 'ARES2.EXE'), env); // case-insensitive lookup
    if (process.platform === 'win32') expect(ares?.kind).toBe('native');
    else expect(ares).toMatchObject({ kind: 'mono', exe: join(APP, '{ap02}', 'Ares2.exe') });
  });
});

describe('Mono environment', () => {
  it('keeps DISPLAY, finds XWayland under Wayland, nothing on macOS', () => {
    const x = mkdtempSync(join(tmpdir(), 'x11-'));
    writeFileSync(join(x, 'X1'), '');
    writeFileSync(join(x, 'X0'), '');
    expect(displayEnv({ DISPLAY: ':5' }, 'linux', x)).toEqual({});
    expect(displayEnv({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux', x)).toEqual({ DISPLAY: ':0' });
    expect(displayEnv({ WAYLAND_DISPLAY: 'wayland-0' }, 'darwin', x)).toEqual({});
  });

  it('maps DOS drives like the engine (FAND_DRIVE_X, else the parent of the task dir)', () => {
    const e = driveEnv({ FAND_DRIVE_D: '/data' }, '/home/u/UCTO2026');
    expect(e.UCTO_DRIVE_C).toBe('/home/u');
    expect(e.UCTO_DRIVE_D).toBe('/data');
  });

  it('isolates Mono from the user environment', () => {
    const e = monoEnv({ mono: '/m/bin/mono', prefix: '/m', bundled: true }, { MONO_PATH: '/x', MONO_ENV_OPTIONS: '--debug', HOME: '/h' }, '/ud');
    expect(e.MONO_PATH).toBeUndefined();
    expect(e.MONO_ENV_OPTIONS).toBeUndefined();
    expect(e.XDG_CONFIG_HOME).toBe('/ud/mono');
    expect(e.MONO_XMLSERIALIZER_THS).toBe('no');
    expect(e.HOME).toBe('/h');
  });

  it('answers MessageBoxes in the shim where WinForms cannot show them', () => {
    expect(messageBoxMode({}, 'darwin')).toBe('stderr');
    expect(messageBoxMode({}, 'linux')).toBe('stderr');
    expect(messageBoxMode({ DISPLAY: ':0' }, 'linux')).toBeNull();
    expect(messageBoxMode({ UCTO_MESSAGEBOX: '6' }, 'darwin')).toBeNull();
    expect(parseMessageBoxes('x\nMessageBox [Ares]: Chyba | IČO nenalezeno\n')).toEqual([{ caption: 'Ares', text: 'Chyba\nIČO nenalezeno' }]);
    expect(unhandledException('System.IO.FileNotFoundException: Could not find file "/x"\n  at ...')).toBe('System.IO.FileNotFoundException: Could not find file "/x"');
    expect(unhandledException('Authorization required')).toBeNull();
  });

  it.skipIf(process.platform !== 'linux')('finds the system CA bundle', () => {
    expect(findCaBundle()).toBeTruthy();
    expect(findCaBundle(['/nonexistent'])).toBeNull();
  });
});

// ---------------------------------------------------------------- end to end

const rt = process.platform === 'win32' ? null : locateMono();
const shims = locateShims();
const canRun = hasApp && !!rt && !!shims;
const T = join(ROOT, 'work', 'tmp-integration');
const TASK = join(T, 'UCTO2026'); // C:\UCTO2026\... maps here via UCTO_DRIVE_C = T
const USER = join(T, 'userdata');
const zbar = (() => { try { execFileSync('zbarimg', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const noUi: SyncUi = { message: () => {}, confirm: () => true, prompt: () => null, open: () => {}, print: () => true, clipboardRead: () => '', clipboardWrite: () => {}, chooseFile: () => null, secretGet: () => null, secretSet: () => {} };

function qrConfig(scale: number): string {
  // As Účto's report UctoQR writes it: CP852, DOS paths, CRLF.
  return `<?xml version="1.0" encoding="utf-8" ?>\r\n<configuration>\r\n<appSettings>\r\n` +
    `<add key="scale" value="${scale}"/>\r\n<add key="left" value="25"/>\r\n<add key="bottom" value="55"/>\r\n<add key="qrtype" value="1"/>\r\n<add key="pageDisplay" value="1"/>\r\n` +
    `<add key="outputPDF" value="C:\\UCTO2026\\{MAIL}\\UCTOQR.PDF"/>\r\n<add key="inputPDF" value="C:\\UCTO2026\\{TISK}\\ENP1.PDF"/>\r\n<add key="qrImage" value="C:\\UCTO2026\\{MAIL}\\UCTOQR.JPG"/>\r\n` +
    `<add key="runAR" value="N"/>\r\n<add key="overwriteSource" value="N"/>\r\n<add key="prefix" value="19"/>\r\n<add key="account" value="2000145399"/>\r\n<add key="code" value="0800"/>\r\n` +
    `<add key="konstanta" value="123500"/>\r\n<add key="amount" value="1234.50"/>\r\n<add key="currency" value="CZK"/>\r\n<add key="dueDate" value="20260315"/>\r\n` +
    `<add key="msg" value="Faktura 1"/>\r\n<add key="vs" value="2026001"/>\r\n<add key="ks" value=""/>\r\n<add key="ss" value=""/>\r\n<add key="password" value=""/>\r\n<add key="attachFilename" value=""/>\r\n<add key="rn" value="STEHLIK"/>\r\n` +
    `</appSettings>\r\n</configuration>\r\n`;
}

/** Environment of an EXEC from the engine: no display (headless CI), private user data. */
function execEnv(): Record<string, string | undefined> {
  return { ...process.env, DISPLAY: undefined, WAYLAND_DISPLAY: undefined, UCTO_USER_DATA: USER, UCTO_MESSAGEBOX: undefined, UCTO_HELPER_PORTS: undefined, FAND_DRIVE_C: undefined };
}

describe.skipIf(!canRun)('original UctoQR under Mono (end to end)', () => {
  beforeAll(() => {
    rmSync(T, { recursive: true, force: true });
    mkdirSync(join(TASK, '{tisk}'), { recursive: true });
    mkdirSync(join(TASK, '{MAIL}'), { recursive: true });
    for (const f of ['UctoQR.exe', 'itextsharp.dll', 'MessagingToolkit.QRCode.dll', 'ENP1.PDF']) cpSync(join(APP, '{tisk}', f), join(TASK, '{tisk}', f));
  });

  it('builds the launcher command: patched copy, config from the IL, drive mapping', async () => {
    writeFileSync(join(TASK, '{tisk}', 'UCTOQR.XML'), iconv.encode(qrConfig(2), 'cp852'));
    const c = await monoCommand(rt!, shims!, join(TASK, '{tisk}', 'UctoQR.exe'), [], TASK, execEnv());
    expect(c.cmd).toBe(rt!.mono);
    expect(c.args[0]).toBe(shims!.host);
    if (shims!.patcher) expect(c.args[1]).toMatch(new RegExp(`^${join(TASK, '{tisk}', 'UctoQR.exe').replace(/[{}.]/g, '\\$&')}=${USER}/mono-patch/.+/UctoQR\\.exe$`));
    expect(c.args[2]).toBe(join(TASK, '{tisk}', 'UCTOQR.XML')); // 'UctoQR.xml' found case-insensitively
    expect(c.env.UCTO_DRIVE_C).toBe(T);
    expect(c.env.XDG_CONFIG_HOME).toBe(join(USER, 'mono'));
    expect(c.env.UCTO_MESSAGEBOX).toBe('stderr'); // no display: the shim answers, we show the text
    expect(c.cwd).toBe(TASK);
  }, 180_000);

  it('EXEC runs the original through the helper worker and stamps a decodable QR payment', () => {
    writeFileSync(join(TASK, '{tisk}', 'UCTOQR.XML'), iconv.encode(qrConfig(2), 'cp852'));
    rmSync(join(TASK, '{MAIL}', 'UCTOQR.PDF'), { force: true });
    rmSync(join(TASK, '{MAIL}', 'UCTOQR.JPG'), { force: true });
    const shown: string[] = [];
    const code = runHelperSync({ exePath: join(TASK, '{TISK}', 'UCTOQR.EXE'), args: [], cwd: TASK, appDir: TASK, env: execEnv() },
      { ...noUi, message: (_t, x) => shown.push(x) }, 180_000);
    expect(shown).toEqual([]);
    expect(code).toBe(0);
    const pdf = readFileSync(join(TASK, '{MAIL}', 'UCTOQR.PDF'));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // Private certificate store initialised on first use.
    expect(existsSync(join(USER, 'mono', 'cert-sync.json'))).toBe(true);
    expect(existsSync(join(USER, 'mono', '.mono', 'certs', 'Trust'))).toBe(true);
    if (zbar) {
      const qr = execFileSync('zbarimg', ['-q', '--raw', join(TASK, '{MAIL}', 'UCTOQR.JPG')]).toString().trim();
      expect(qr).toBe('SPD*1.0*ACC:CZ6508000000192000145399*AM:1234.50*CC:CZK*DT:20260315*MSG:FAKTURA 1*X-VS:2026001*RN:STEHLIK');
    }
  }, 180_000);

  it.skipIf(!shims?.patcher)('shows the helper\'s MessageBox on the FAND screen and returns its exit code', () => {
    writeFileSync(join(TASK, '{tisk}', 'UCTOQR.XML'), iconv.encode(qrConfig(9), 'cp852')); // scale 1..5 only
    const shown: string[] = [];
    const code = runHelperSync({ exePath: join(TASK, '{tisk}', 'UctoQR.exe'), args: [], cwd: TASK, appDir: TASK, env: execEnv() },
      { ...noUi, message: (_t, x) => shown.push(x) }, 180_000);
    expect(code).toBe(1);
    expect(shown.length).toBeGreaterThan(0);
    expect(existsSync(join(USER, 'logs', 'mono-uctoqr.log'))).toBe(true);
  }, 180_000);
});

// Live public endpoint (ARES), opt-in: UCTO_LIVE_TESTS=1.
describe.skipIf(!canRun || process.env.UCTO_LIVE_TESTS !== '1')('original Ares2 under Mono (live ARES)', () => {
  it('looks up IČO 00006947 with the substitute Rebex', () => {
    const ap02 = join(TASK, '{ap02}');
    mkdirSync(ap02, { recursive: true });
    for (const f of ['Ares2.exe', 'Rebex.Common.dll', 'Rebex.Http.dll', 'Rebex.Networking.dll']) cpSync(join(APP, '{ap02}', f), join(ap02, f));
    expect(rebexShimDir(shims!, join(ap02, 'Ares2.exe'))).toMatch(/6\.0\.8000\.0$/);
    writeFileSync(join(ap02, 'ARES2.XML'), iconv.encode('<?xml version="1.0" encoding="utf-8" ?>\r\n<configuration>\r\n<appSettings>\r\n<add key="outputEncoding" value="852" />\r\n' +
      '<add key="outputFilename" value="C:\\UCTO2026\\{AP02}\\ARES2.TXT" />\r\n<add key="regNo" value="00006947" />\r\n<add key="logFilename" value="C:\\UCTO2026\\{AP02}\\ARES2.LOG"/>\r\n</appSettings>\r\n</configuration>\r\n', 'cp852'));
    rmSync(join(ap02, 'ARES2.TXT'), { force: true });
    const shown: string[] = [];
    const code = runHelperSync({ exePath: join(ap02, 'ARES2.EXE'), args: [], cwd: TASK, appDir: TASK, env: execEnv() }, { ...noUi, message: (_t, x) => shown.push(x) }, 180_000);
    expect(shown).toEqual([]);
    expect(code).toBe(0);
    const lines = iconv.decode(readFileSync(join(ap02, 'ARES2.TXT')), 'cp852').split('\r\n');
    expect(lines[0]).toBe('Ministerstvo financí');
    expect(lines[4]).toBe('00006947');
  }, 180_000);
});
