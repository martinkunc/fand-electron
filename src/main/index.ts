// Electron main process: one window per engine session. The engine runs in a
// worker thread; screen diffs go to the renderer, keys come back into the shared
// keyboard queue.

import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron';
import { Worker } from 'node:worker_threads';
import { existsSync, readdirSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyQueue } from '../engine/console/keyqueue.ts';
import { serveHost } from '../engine/hostbridge.ts';
import { makeHostHandler } from './host.ts';
import { firstAppDir, isAppDir, launcherDirs, loadSettings, parentsOf, pickTask, runsInside, saveSettings, scanAppDir, selfCopyPlan, settingsPath, type Settings } from './appdir.ts';

const here = dirname(fileURLToPath(import.meta.url));

// Locations the engine/helper workers need (inherited through process.env).
process.env.UCTO_RESOURCES ??= app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'resources') : resolve(here, '../../resources');
process.env.UCTO_HELPER_WORKER ??= join(here, 'helper-worker.js');
// Original .NET helpers on macOS/Linux run under the bundled Mono (src/helpers/mono.ts): its
// prefix (<resources>/mono, as electron-builder.yml copies it, or .../mono/<platform>-<arch>)
// and the per-user folder for its certificate store, patched helper copies and logs.
process.env.UCTO_USER_DATA ??= app.getPath('userData');
process.env.UCTO_APP_VERSION ??= app.getVersion();
if (process.platform !== 'win32' && !process.env.UCTO_MONO_ROOT) {
  const tag = `${process.platform}-${process.arch}`;
  const roots = app.isPackaged
    ? [join(process.resourcesPath, 'mono', tag), join(process.resourcesPath, 'mono')]
    : [resolve(here, '../../resources/mono', tag)];
  const root = roots.find((r) => existsSync(join(r, 'bin', 'mono')));
  if (root) process.env.UCTO_MONO_ROOT = root;
}

interface Session {
  win: BrowserWindow;
  worker: Worker;
  keys: KeyQueue;
}
const sessions = new Map<number, Session>();

/** --fand (or FAND_DESKTOP=1): the FAND desktop without a task – PC FAND's own development environment. */
const desktopMode = process.argv.includes('--fand') || !!process.env.FAND_DESKTOP;
/** FAND.RES and FAND.CFG of ALIS PC FAND (MIT) for folders without their own (resources/fand). */
const bundledFand = (): string => join(process.env.UCTO_RESOURCES!, 'fand');

/**
 * Where is the FAND application installed? --app-dir=, UCTO_DIR, the folder chosen last time
 * (settings.json), the folder the packaged app sits in (<app>/ucto-electron/ucto.exe), then the
 * development working copy. --choose-app-dir asks again.
 */
function findAppDir(saved: Settings): string | null {
  if (process.argv.includes('--choose-app-dir')) return null;
  const arg = process.argv.find((a) => a.startsWith('--app-dir='))?.slice('--app-dir='.length);
  // the FAND desktop needs only a folder (FAND.RES is bundled): the command line or the last one
  if (desktopMode) return firstAppDir([arg, process.env.FAND_DIR, saved.fandDir], true);
  return firstAppDir([
    arg,
    process.env.UCTO_DIR,
    saved.appDir,
    ...(app.isPackaged ? [...launcherDirs(process.env), ...parentsOf(process.execPath)] : [resolve(here, '../../work/ucto')]),
  ]);
}

/** The first start (or the folder is gone): ask for the folder of the FAND application. */
async function chooseAppDir(saved: Settings): Promise<string | null> {
  const intro = await dialog.showMessageBox({
    type: 'info',
    title: 'účto – PC FAND',
    message: desktopMode ? 'Vývojové prostředí PC FAND' : 'Aplikace PC FAND nebyla nalezena.',
    detail: desktopMode
      ? 'Vyberte pracovní složku pro vývoj úloh PC FAND (může být i prázdná; FAND.RES a FAND.CFG se použijí ' +
        'přibalené, pokud je složka nemá). Volba se zapamatuje; změnit ji můžete parametrem --choose-app-dir.'
      : 'Vyberte složku, ve které je nainstalovaná vaše aplikace PC FAND (například účto: složka se souborem ' +
        'UCTO2026.RDB a FAND.RES). Volba se zapamatuje; změnit ji můžete spuštěním s parametrem --choose-app-dir.',
    buttons: ['Vybrat složku…', 'Ukončit'],
    defaultId: 0,
    cancelId: 1,
  });
  if (intro.response !== 0) return null;
  const last = desktopMode ? saved.fandDir : saved.appDir;
  let start = last && existsSync(last) ? last : app.getPath('home');
  for (;;) {
    const r = await dialog.showOpenDialog({
      title: desktopMode ? 'Vyberte pracovní složku PC FAND' : 'Vyberte složku s aplikací PC FAND',
      defaultPath: start,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    start = dir;
    const scan = scanAppDir(dir);
    if (isAppDir(scan, process.env, desktopMode)) {
      if (scan.writable) return dir;
      const w = await dialog.showMessageBox({
        type: 'warning',
        title: 'účto – PC FAND',
        message: 'Do vybrané složky nelze zapisovat.',
        detail: `${dir}\n\nAplikace ukládá data do své složky, bez práva zápisu nebude fungovat správně.`,
        buttons: ['Vybrat jinou složku', 'Přesto použít', 'Ukončit'],
        defaultId: 0,
        cancelId: 2,
      });
      if (w.response === 1) return dir;
      if (w.response === 2) return null;
      continue;
    }
    const missing = [
      ...(scan.tasks.length === 0 ? ['úloha PC FAND (soubor .RDB)'] : []),
      ...(!scan.hasRes && !process.env.FANDRES ? ['soubor FAND.RES'] : []),
    ];
    const e = await dialog.showMessageBox({
      type: 'error',
      title: 'účto – PC FAND',
      message: 'Ve vybrané složce není aplikace PC FAND.',
      detail: `${dir}\n\nChybí: ${missing.join(', ')}.`,
      buttons: ['Vybrat jinou složku', 'Ukončit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (e.response !== 0) return null;
  }
}

/**
 * After the folder was chosen: the packaged app copies itself into it (<app>/ucto-electron, the .app
 * bundle or the AppImage) and restarts from the copy, which then finds the application next to itself.
 * Returns true when the copy runs (this instance quits); false = go on from here (development build,
 * already inside, or the copy failed).
 */
async function copySelfInto(appDir: string): Promise<boolean> {
  if (!app.isPackaged) return false;
  const plan = selfCopyPlan(appDir, process.execPath, process.platform, process.env);
  if (runsInside(appDir, plan.src)) return false;
  try {
    await cp(plan.src, plan.dest, { recursive: true, force: true, verbatimSymlinks: true, preserveTimestamps: true });
  } catch (e) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'účto – PC FAND',
      message: 'Aplikaci se nepodařilo zkopírovat do složky s aplikací PC FAND.',
      detail: `${plan.dest}\n\n${String(e)}\n\nPokračuje se z původního umístění; vybraná složka se zapamatovala.`,
    });
    return false;
  }
  await dialog.showMessageBox({
    type: 'info',
    title: 'účto – PC FAND',
    message: 'Aplikace byla zkopírována ke vaší aplikaci PC FAND.',
    detail: `${plan.exe}\n\nNyní se spustí odtud; příště ji spouštějte z této složky.`,
  });
  forceQuit = true;
  app.relaunch({ execPath: plan.exe, args: process.argv.slice(1).filter((a) => a !== '--choose-app-dir') });
  app.exit(0);
  return true;
}

/** Several tasks and none preferred: ask which one runs ('' = the FAND desktop). */
async function chooseTask(appDir: string, tasks: string[]): Promise<string | null> {
  const shown = tasks.slice(0, 12);
  const r = await dialog.showMessageBox({
    type: 'question',
    title: 'účto – PC FAND',
    message: 'Kterou úlohu spustit?',
    detail: appDir,
    buttons: [...shown, 'PC FAND (vývojové prostředí)', 'Ukončit'],
    cancelId: shown.length + 1,
  });
  if (r.response < shown.length) return shown[r.response];
  return r.response === shown.length ? '' : null;
}

/** FANDRES/FANDCFG for a folder without its own FAND.RES / FAND.CFG: the bundled ones. */
function fandEnv(appDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  let names: string[] = [];
  try {
    names = readdirSync(appDir).map((f) => f.toUpperCase());
  } catch {
    // the engine reports it
  }
  if (!names.includes('FAND.RES') && !process.env.FANDRES) env.FANDRES = bundledFand();
  if (!names.includes('FAND.CFG') && !process.env.FANDCFG) env.FANDCFG = bundledFand();
  return env;
}

/** true when the app quits on purpose (devScreenshot): windows close without asking */
let forceQuit = false;

async function createWindow(): Promise<void> {
  const settingsFile = settingsPath(app.getPath('userData'));
  const saved = loadSettings(settingsFile);
  let appDir = findAppDir(saved);
  const chosen = !appDir;
  if (!appDir) appDir = await chooseAppDir(saved);
  if (!appDir) {
    app.quit();
    return;
  }
  let task: string | null = '';
  if (desktopMode) {
    if (saved.fandDir !== appDir) saveSettings(settingsFile, { ...saved, fandDir: appDir });
  } else {
    const tasks = scanAppDir(appDir).tasks;
    const wanted = process.env.FAND_TASK ?? process.argv.find((a) => a.startsWith('--task='))?.slice(7);
    task = pickTask(tasks, wanted ?? (saved.appDir === appDir ? saved.task : undefined)) ?? (await chooseTask(appDir, tasks));
    if (task === null) {
      app.quit();
      return;
    }
    if (task !== '' && (saved.appDir !== appDir || saved.task !== task)) saveSettings(settingsFile, { ...saved, appDir, task });
    if (chosen && task !== '' && (await copySelfInto(appDir))) return;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#000000',
    title: task ? 'účto – PC FAND' : 'PC FAND',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  const keys = new KeyQueue();
  const worker = new Worker(join(here, 'engine-worker.js'));
  const session: Session = { win, worker, keys };
  // webContents is gone once the window is destroyed: keep its id for the 'closed' handler
  const wcId = win.webContents.id;
  sessions.set(wcId, session);
  let engineExited = false;

  serveHost(worker, makeHostHandler(() => (win.isDestroyed() ? null : win)));
  worker.on('message', (m) => {
    if (win.isDestroyed()) return;
    if (m.type === 'screen') win.webContents.send('fand:screen', m.diff);
    else if (m.type === 'error') {
      console.error(m.message);
      win.webContents.send('fand:error', m.message);
    } else if (m.type === 'exit') {
      engineExited = true;
      win.close();
    }
  });
  worker.on('error', (e) => {
    console.error(e);
    if (!win.isDestroyed()) win.webContents.send('fand:error', String(e));
  });

  // Closing the window stops the engine at once (like closing a DOS box): files it has not
  // written out yet (FAND's cache) may be lost, so ask first while the program still runs.
  win.on('close', (e) => {
    if (engineExited || forceQuit) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Zrušit', 'Přesto zavřít'],
      defaultId: 0,
      cancelId: 0,
      title: 'účto',
      message: 'Program účto ještě běží.',
      detail: 'Ukončete ho raději z jeho menu, jinak se neuložená data mohou ztratit.',
    });
    if (choice === 0) e.preventDefault();
  });

  win.on('closed', () => {
    keys.close();
    setTimeout(() => void worker.terminate(), 1000);
    sessions.delete(wcId);
  });

  win.webContents.once('did-finish-load', () => {
    // --browse (or FAND_BROWSE=1): the read-only chapter browser instead of running the task
    const browse = process.argv.includes('--browse') || !!process.env.FAND_BROWSE;
    // project '' = the FAND desktop (UFAND without a task)
    worker.postMessage({ type: 'start', sab: keys.sab, appDir, project: task || undefined, browse, env: fandEnv(appDir), cols: 80, rows: 25 });
    if (process.env.FAND_SCREENSHOT) void devScreenshot(session, process.env.FAND_SCREENSHOT);
  });

  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(here, '../renderer/index.html'));
}

/**
 * Development hook: FAND_KEYS="Enter,Down,Down,Enter" is typed after start-up, then
 * the window is captured to the FAND_SCREENSHOT png path and the app quits.
 */
async function devScreenshot(s: Session, path: string): Promise<void> {
  const { K } = await import('../engine/console/keys.ts');
  const { writeFileSync } = await import('node:fs');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  for (const k of (process.env.FAND_KEYS ?? '').split(',').filter(Boolean)) {
    s.keys.push(K[k as keyof typeof K] ?? Number(k));
    await sleep(150);
  }
  await sleep(800);
  const img = await s.win.webContents.capturePage();
  writeFileSync(path, img.toPNG());
  forceQuit = true;
  app.quit();
}

ipcMain.on('fand:key', (e, code: number, shift: number) => {
  sessions.get(e.sender.id)?.keys.push(code, shift);
});

// Linux: run through XWayland. Chromium's native Wayland backend fails on some compositors (COSMIC:
// 'create_immed failed and produced an invalid wl_buffer'). --ozone-platform=... or FAND_WAYLAND=1
// keeps the choice to the user.
if (process.platform === 'linux' && !process.env.FAND_WAYLAND && !process.argv.some((a) => a.startsWith('--ozone-platform'))) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // Alt and F10 belong to the DOS application
  return createWindow();
});
app.on('window-all-closed', () => app.quit());
