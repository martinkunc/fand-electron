// Electron implementations of the host services helpers need (see src/engine/hostbridge.ts).

import { app, BrowserWindow, clipboard, dialog, safeStorage, shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HostOp } from '../engine/hostbridge.ts';

function secretsFile(): string {
  return join(app.getPath('userData'), 'secrets.json');
}

function loadSecrets(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(secretsFile(), 'utf8'));
  } catch {
    return {};
  }
}

async function printPdf(owner: BrowserWindow | null, path: string, opts: { dialog: boolean; copies: number }): Promise<boolean> {
  // Silent printing on Unix goes through CUPS (lp), which handles PDF natively.
  if (!opts.dialog && process.platform !== 'win32') {
    return new Promise((resolve) => execFile('lp', ['-n', String(Math.max(1, opts.copies)), path], (err) => resolve(!err)));
  }
  // Otherwise show the PDF in Chromium's viewer and print from there (system dialog).
  const win = new BrowserWindow({ width: 900, height: 1000, parent: owner ?? undefined, show: opts.dialog, webPreferences: { plugins: true } });
  await win.loadURL(pathToFileURL(path).href);
  return new Promise((resolve) => {
    win.webContents.print({ silent: !opts.dialog, copies: Math.max(1, opts.copies), printBackground: true }, (ok) => {
      if (!opts.dialog) win.close();
      resolve(ok);
    });
  });
}

export function makeHostHandler(getWindow: () => BrowserWindow | null) {
  return async (op: HostOp, args: unknown[]): Promise<unknown> => {
    const win = getWindow();
    switch (op) {
      case 'open': {
        const target = String(args[0]);
        if (/^(https?|mailto):/i.test(target)) await shell.openExternal(target);
        else {
          const err = await shell.openPath(target);
          if (err) throw new Error(err);
        }
        return null;
      }
      case 'print':
        return printPdf(win, String(args[0]), args[1] as { dialog: boolean; copies: number });
      case 'clipboardRead':
        return clipboard.readText();
      case 'clipboardWrite':
        clipboard.writeText(String(args[0]));
        return null;
      case 'chooseFile': {
        const o = args[0] as { title: string; save?: boolean; defaultPath?: string; filters?: { name: string; extensions: string[] }[] };
        if (o.save) {
          const r = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
          return r.canceled ? null : (r.filePath ?? null);
        }
        const r = win ? await dialog.showOpenDialog(win, { ...o, properties: ['openFile'] }) : await dialog.showOpenDialog({ ...o, properties: ['openFile'] });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      }
      case 'secretGet': {
        const v = loadSecrets()[String(args[0])];
        if (!v) return null;
        return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : null;
      }
      case 'secretSet': {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Úložiště hesel operačního systému není dostupné');
        const all = loadSecrets();
        const key = String(args[0]);
        if (args[1] === null) delete all[key];
        else all[key] = safeStorage.encryptString(String(args[1])).toString('base64');
        writeFileSync(secretsFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
        return null;
      }
    }
  };
}

export function hasSecretsFile(): boolean {
  return existsSync(secretsFile());
}
