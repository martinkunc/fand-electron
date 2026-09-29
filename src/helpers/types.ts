// Cross-platform replacements for Účto's Windows helper programs.
// Each helper is registered under the lower-cased .exe basename that Účto EXECs.

export type MessageKind = 'info' | 'warning' | 'error' | 'question';

/** UI a helper may use; served by the engine on the FAND screen (or collected in tests). */
export interface HelperUi {
  message(title: string, text: string, kind?: MessageKind): Promise<void>;
  /** Yes/No question; resolves true for Yes. */
  confirm(title: string, text: string): Promise<boolean>;
  /** Single-line input; null when cancelled. */
  prompt(title: string, label: string, initial?: string, secret?: boolean): Promise<string | null>;
  /** Open a file or URL with the OS default application (browser, PDF viewer, mail client). */
  open(target: string): Promise<void>;
  /** Print a PDF on the OS printer (dialog = let the user choose). Resolves false if cancelled/failed. */
  print(pdfPath: string, opts: { dialog: boolean; copies: number }): Promise<boolean>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  /** Native file dialog; returns a host path or null. */
  chooseFile(opts: { title: string; save?: boolean; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  /** OS-protected secret storage (Electron safeStorage) for passwords/PINs/certificate passphrases. */
  secretGet(key: string): Promise<string | null>;
  secretSet(key: string, value: string | null): Promise<void>;
}

export interface HelperContext {
  /** Lower-cased exe basename, e.g. 'ares2.exe'. */
  name: string;
  /** Host directory of the original exe (e.g. <app>/{ap02}); configs are resolved against it. */
  exeDir: string;
  /** Host working directory of the FAND task. */
  cwd: string;
  /** Command-line arguments as passed by EXEC (byte strings decoded from CP852). */
  args: string[];
  /** Root of the Účto installation on the host. */
  appDir: string;
  /** Map a DOS path (C:\UCTO2026\{AP02}\X.TXT, relative, any case) to an existing-or-new host path. */
  resolvePath(dosPath: string): string;
  ui: HelperUi;
  fetch: typeof fetch;
  /** Current time (replaceable in tests). */
  now(): Date;
  env: Record<string, string | undefined>;
}

export type Helper = (ctx: HelperContext) => Promise<number>;
