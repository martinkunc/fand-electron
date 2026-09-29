// Getting Účto 2026 from its start to the main menu. A pristine copy asks on its
// first run which version to use (we take the demo) and shows a few one-time
// notices; later starts show fewer. Works with any driver that reads the screen
// as text and types keys (EngineDriver, RefFandDriver).

import { K } from '../console/keys.ts';

export interface ScreenDriver {
  text(): string;
  press(...keys: (string | number)[]): unknown;
}

// The menu bar on the top line (the Finance pull-down is open under it).
export const UCTO_MAIN_MENU = /^\s*Finance\s+Inventář\s+Přehledy\s+Tiskopisy\s+Ostatní\s+Nápověda/;

// Screen text -> keys that answer it, as seen with the reference PC FAND. The first
// match wins, so a dialog comes before the screen it is shown over.
export const UCTO_START_ANSWERS: { name: string; when: RegExp; keys: (string | number)[] }[] = [
  // every start on Unix: the stored path ends '/' and Účto appends '\' to the current one
  { name: 'Přemístění programu', when: /Přemístění programu/, keys: [K.Enter] },
  // first run: 1) ostrá verze (licence) 2) demoverze 3) prohlížecí verze
  { name: 'Přepnout na Demonstrační verzi', when: /Přepnout na Demonstrační verzi/, keys: ['A'] },
  { name: 'Zadat licenční údaje', when: /Zadat licenční údaje/, keys: ['N'] }, // missed the demo: back
  { name: 'VYBERTE VERZI', when: /VYBERTE VERZI/, keys: [K.Home, K.Down, K.Enter] },
  { name: 'DEMOVERZE PROGRAMU ÚČTO', when: /DEMOVERZE PROGRAMU ÚČTO/, keys: [K.Esc] }, // help page
  { name: 'Děkujeme Vám za zájem', when: /Děkujeme Vám za zájem/, keys: [K.Enter] },
  { name: 'Jednorázové upozornění', when: /Jednorázové upozornění/, keys: [K.Enter] },
  { name: 'VYHRAZENÝ ADRESÁŘ', when: /VYHRAZENÝ ADRESÁŘ/, keys: [K.Enter] },
  // later starts: the demo's remaining days
  { name: 'Demoverze', when: /Demonstrační verze účta bude normálně pracovat/, keys: [K.Enter] },
  // first start of the day: a report of liabilities due
  { name: 'NEUHRAZENÉ ZÁVAZKY', when: /NEUHRAZENÉ ZÁVAZKY/, keys: [K.Esc] },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Answers the start-up screens until the main menu shows; returns the names of the
// screens answered, in order.
export async function startUcto(d: ScreenDriver, timeoutMs = 60000): Promise<string[]> {
  const seen: string[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = d.text();
    if (Date.now() > deadline) throw new Error(`Účto did not reach the main menu (answered: ${seen.join(', ')})\n--- screen ---\n${t}`);
    // act only on a settled screen (FAND paints a dialog in several writes)
    await sleep(300);
    if (d.text() !== t) continue;
    if (UCTO_MAIN_MENU.test(t.split('\n')[0])) return seen;
    const a = UCTO_START_ANSWERS.find((x) => x.when.test(t));
    if (!a) continue;
    seen.push(a.name);
    for (const k of a.keys) {
      d.press(k);
      await sleep(150); // one key at a time: a menu may flush keys typed ahead
    }
    // wait for the answer to take effect before looking again
    while (d.text() === t && Date.now() < deadline) await sleep(100);
  }
}
