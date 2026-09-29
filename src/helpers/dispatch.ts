// Platform policy for EXEC of an Účto helper program (docs/HELPERS-PLATFORMS.md, "hybrid"):
// * Windows: start the original .exe; TypeScript ports only when explicitly configured
//   ($UCTO_HELPER_PORTS).
// * macOS/Linux: a TypeScript port when one exists (native VB6/Delphi printing helpers, and
//   UctoExp until it is verified under Mono), else a .NET assembly runs under the bundled
//   Mono (./mono.ts), else the user is told the program is not available here.
// Programs that are not Windows executables (DOS .EXE/.COM, .BAT) are left to the engine.

import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import type { Helper, HelperContext } from './types.ts';
import { exeKind, runMonoHelper, type ExeKind } from './mono.ts';
import { findCaseInsensitive } from './util.ts';

type Env = Record<string, string | undefined>;

export type Route =
  /** Windows: spawn the original program. */
  | { kind: 'native'; exe: string; name: string }
  /** macOS/Linux: original .NET program under Mono. */
  | { kind: 'mono'; exe: string; name: string }
  /** TypeScript replacement registered under `name`. */
  | { kind: 'port'; name: string }
  /** Windows program without a way to run it on this platform. */
  | { kind: 'unavailable'; exe: string; name: string };

export interface RouteOptions {
  platform?: NodeJS.Platform;
  env?: Env;
  /** Is there a TypeScript port registered under this lower-cased exe name? */
  hasPort: (name: string) => boolean;
  /** Classify the program file (tests replace it). */
  probe?: (path: string) => ExeKind;
}

/** Lower-cased basename with '.exe' added when there is no extension ('ARES2' -> 'ares2.exe'). */
export function helperName(exePath: string): string {
  const base = exePath.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  return base.includes('.') ? base : base + '.exe';
}

/**
 * Which TypeScript ports are enabled. $UCTO_HELPER_PORTS: 'all', 'none', or a list of
 * names ('fand2pdf,utisk04.exe'). Default: all on macOS/Linux, none on Windows.
 */
export function portEnabled(name: string, platform: NodeJS.Platform, env: Env): boolean {
  const cfg = env.UCTO_HELPER_PORTS?.trim().toLowerCase();
  if (!cfg) return platform !== 'win32';
  if (cfg === 'all') return true;
  if (cfg === 'none') return false;
  return cfg.split(/[,;\s]+/).filter(Boolean).some((n) => (n.includes('.') ? n : n + '.exe') === name);
}

/** Decide how EXEC of `exePath` is served; null = not a helper (the engine handles it). */
export function routeFor(exePath: string, opts: RouteOptions): Route | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const name = helperName(exePath);
  const port = opts.hasPort(name) && portEnabled(name, platform, env);
  const exe = platform === 'win32' ? exePath : findCaseInsensitive(exePath);
  const kind = (opts.probe ?? exeKind)(exe);

  if (platform === 'win32') {
    if (port) return { kind: 'port', name };
    if (kind === 'win32' || kind === 'dotnet') return { kind: 'native', exe, name };
    return null;
  }
  if (port) return { kind: 'port', name };
  if (kind === 'dotnet') return { kind: 'mono', exe, name };
  if (kind === 'win32') return { kind: 'unavailable', exe, name };
  return null;
}

/** Windows: run the original program and wait for it (its windows are shown normally). */
export function runNative(exe: string, ctx: HelperContext): Promise<number> {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(exe, ctx.args, { cwd: ctx.cwd, env: ctx.env as NodeJS.ProcessEnv, stdio: 'ignore', windowsHide: false });
    } catch (e) {
      void ctx.ui.message(basename(exe), `Program ${basename(exe)} se nepodařilo spustit: ${String(e)}`, 'error').then(() => done(1));
      return;
    }
    child.on('error', (e) => void ctx.ui.message(basename(exe), `Program ${basename(exe)} se nepodařilo spustit: ${e.message}`, 'error').then(() => done(1)));
    child.on('exit', (code) => done(code ?? 1));
  });
}

export async function unavailable(exe: string, ctx: HelperContext): Promise<number> {
  const name = basename(exe).toUpperCase();
  await ctx.ui.message(name, `Program ${name} není na této platformě dostupný.`, 'warning');
  return 1;
}

/** The Helper implementing a route; `ports` maps lower-cased exe names to TypeScript ports. */
export function helperForRoute(route: Route, ports: Record<string, Helper>): Helper {
  switch (route.kind) {
    case 'port': return ports[route.name];
    case 'native': return (ctx) => runNative(route.exe, ctx);
    case 'mono': return (ctx) => runMonoHelper(route.exe, ctx);
    case 'unavailable': return (ctx) => unavailable(route.exe, ctx);
  }
}

/** Originals (Windows exe, Mono) may run interactive dialogs for a long time. */
export function routeTimeoutMs(route: Route): number {
  return route.kind === 'port' ? 10 * 60_000 : 24 * 3600_000;
}
