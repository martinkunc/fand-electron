// Test doubles for helper modules: a recording HelperUi and a HelperContext factory.

import { dirname } from 'node:path';
import type { HelperContext, HelperUi } from './types.ts';
import { dosToHost } from './util.ts';

export interface UiLog {
  messages: { title: string; text: string; kind?: string }[];
  opened: string[];
  printed: { path: string; dialog: boolean; copies: number }[];
  clipboard: string;
  secrets: Map<string, string>;
}

export function recordingUi(answers: { confirm?: boolean; prompt?: (string | null)[]; chooseFile?: (string | null)[] } = {}): { ui: HelperUi; log: UiLog } {
  const log: UiLog = { messages: [], opened: [], printed: [], clipboard: '', secrets: new Map() };
  const prompts = [...(answers.prompt ?? [])];
  const files = [...(answers.chooseFile ?? [])];
  const ui: HelperUi = {
    message: async (title, text, kind) => { log.messages.push({ title, text, kind }); },
    confirm: async () => answers.confirm ?? true,
    prompt: async () => (prompts.length ? prompts.shift()! : null),
    open: async (t) => { log.opened.push(t); },
    print: async (path, o) => { log.printed.push({ path, ...o }); return true; },
    clipboardRead: async () => log.clipboard,
    clipboardWrite: async (t) => { log.clipboard = t; },
    chooseFile: async () => (files.length ? files.shift()! : null),
    secretGet: async (k) => log.secrets.get(k) ?? null,
    secretSet: async (k, v) => { if (v === null) log.secrets.delete(k); else log.secrets.set(k, v); },
  };
  return { ui, log };
}

/** Context for a helper whose original exe lives at `exePath` inside the app dir `appDir`. */
export function testContext(appDir: string, exePath: string, args: string[], ui: HelperUi, fetchImpl: typeof fetch = fetch): HelperContext {
  return {
    name: exePath.split(/[\\/]/).pop()!.toLowerCase(),
    exeDir: dirname(exePath),
    cwd: appDir,
    args,
    appDir,
    resolvePath: (p) => dosToHost(p, appDir, appDir),
    ui,
    fetch: fetchImpl,
    now: () => new Date(2026, 8, 28, 10, 5),
    env: {},
  };
}
