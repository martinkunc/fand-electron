// Helpers keyed by lower-cased exe basename: the TypeScript ports, and helperFor(), which
// applies the platform policy of ./dispatch.ts (original exe on Windows, Mono for .NET
// helpers on macOS/Linux, a port for native helpers, else "not available").

import type { Helper } from './types.ts';
import { fand2pdf } from './fand2pdf.ts';
import { utisk04 } from './utisk04.ts';
import { uctoexp } from './uctoexp.ts';
import { routeFor, helperForRoute, type Route } from './dispatch.ts';

/** TypeScript ports. Ares2 and Nepl2 are gone: their originals run under Mono. */
export const HELPERS: Record<string, Helper> = {
  'fand2pdf.exe': fand2pdf,
  // TODO(verification): drop this port once the original UctoExp (Jet OLEDB redirected to
  // UctoShim.Data by UctoPatch) is confirmed to work under Mono; until then it wins over Mono.
  'uctoexp.exe': uctoexp,
  'utisk04.exe': (c) => utisk04(c),
  'utisk98.exe': (c) => utisk04(c),
  'utisk01.exe': (c) => utisk04(c, { forceDialog: true }),
  // DOSBox print stub: the spool file is handled by the print manager itself.
  'nic.exe': async () => 0,
};

/** How EXEC of `exePath` is served on this platform; null when it is not a helper. */
export function routeOf(exePath: string, env: Record<string, string | undefined> = process.env): Route | null {
  return routeFor(exePath, { env, hasPort: (n) => Object.hasOwn(HELPERS, n) });
}

export function helperFor(exePath: string): Helper | undefined {
  const r = routeOf(exePath);
  return r ? helperForRoute(r, HELPERS) : undefined;
}
