// Bring-up: Účto 2026 runs in our engine exactly like in the reference PC FAND (docs/REFERENCE.md).
// Both start on a fresh copy of the pristine install, answer the first-run screens (ucto.ts), reach
// the main menu and walk the same scenario: the cash book (Peněžní deník: a new entry, saved, then
// the list), a Finance submenu, every pull-down of the menu bar, the address book (Adresář firem:
// the list, a new address saved with Ctrl\ "Rychle dokončit", a field of it edited in the list, an
// address deleted with Ctrl+Y), a report shown on screen (Přehledy >
// Měsíční součty > Deník ve sloupcích > Úzký deník) and the exit. Scenario B (STEPS_B) walks
// liabilities, a check of the cash book (an edit and a report), a search, small assets and a letter
// typed in the text editor; scenario C (STEPS_C) an edit in a list and a switch to a new company and
// back. Each scenario is a run of its own. The screens after each step are
// compared (bringup.ts normalizes clock times and the reference's dropped control glyphs), and so
// are all files the runs left in the task directory (datacmp.ts: record by record, field by field).
//
// Both runs use the same task path one after the other, so stored paths are equal; our engine uses
// the reference's FAND.RES so message texts are the same (Účto ships the older 4.20 FAND.RES whose
// texts differ in 18 messages, e.g. 820 "duplicitní klíč").
//
// Known differences that are NOT failures (the reference is the FPC build; BP7 wins, PORTING.md):
// * VAT rate labels (Sazba "21%"/"12%") in the cash book form are blank in the reference: SAZDPH is
//   looked up with recno() on its descending date key, and the FPC XString.StoreD stores 6 bytes of a
//   double instead of the Real48. The scenarios book non-VAT entries (Druh OP, P1) to stay off it, and
//   a new small asset is not transferred to the cash book (that entry would be DKP with 21% VAT);
// * .Txx headers: the password area is XORed with Random (FILEACC RdPrefix/WrPrefix), and FPC's
//   System.Random is not BP7's, so the first 512 bytes of a written T file differ (texts compare equal).
// * index files (.Xnn): BP7 'ch' collation and Real48 keys;
// * {OBNV}: the reference's FANDDOS `copy {GLOB}\... {OBNV}\*.*` does not resolve directory case,
//   so only ours has the backup copies; UCTOTXT.UUU is the `set` output (host environment);
// * printing (F6 in a report): Účto's print manager UTISK04 is EXEC'd; ours runs its TS port (a PDF to
//   the host, the spool file deleted as the original does), the reference cannot run the .EXE and falls
//   back to FANDPDF ({tisk}/PRINT1.PRN + .pdf); the child's output also scrolls the reference's
//   terminal. Printing is therefore left out of the scenario.
// * the tip line under the company name after switching companies is chosen with random (Osveta);
// * EXPIMP ImportFD (a new company's code lists, CISDRUH/CISPOH): the DOS truncate `WriteH(h,0,...)`
//   is a no-op in the FPC WriteH, so the reference's copy keeps the rest of the 4 kB cache page the
//   file was created with; ours truncates (handle.ts WriteH of 0 bytes, BP7);
// * Účto's DOS utilities (FILESIZE.EXE, DISKSIZE.EXE, SUBDIR.EXE ...): the reference passes them to
//   /bin/sh ('not found', FileSize leaves PARAM3.FFF at -2, so a new company gets no {NOVA} templates);
//   ours has TS ports (fanddos.ts DosToolOf), switched off here with FAND_DOSTOOLS=0 to compare.
// * paths: ours shows the task DOS paths (HANDLE DosView, C:\UCTO\...), as BP7 FAND on DOS; the FPC
//   reference host paths. Switched off here with FAND_DOSPATHS=0 so both store and show the same
//   paths (test/ucto-dospaths.test.ts covers the DOS view, e.g. Tiskopisy > Faktura > Faktury, which
//   needs it: Účto's LogName cuts file names at '\'; the reference fails there with 630);
// * the VAT calculator (Kalkulačky > Daň z přidané hodnoty) reads the rates from SAZDPH like the forms
//   above: 0% in the reference, 21%/12% in ours, so its rows differ;
// * working days and holidays (addwdays/difwdays/typeday, the calendar): the FPC TypeDay skips the
//   FAND.CFG working-days table ({$ifndef FPC}); ours reads it (BP7), so only ours knows the holidays.

import { describe, it, expect } from 'vitest';
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REF_FAND, RefFandDriver } from '../src/engine/testing/refdriver.ts';
import { EngineDriver } from '../src/engine/testing/driver.ts';
import { startUcto, UCTO_MAIN_MENU } from '../src/engine/testing/ucto.ts';
import { runSteps, quitUcto, diffScreens, formatScreenDiffs, settle, type Step, type StepScreen } from '../src/engine/testing/bringup.ts';
import { loadFileDecls, compareTaskDirs } from '../src/engine/testing/datacmp.ts';
import { K, fKey } from '../src/engine/console/keys.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const REF_RES = join(REF_FAND, '..');
const ready = existsSync(REF_FAND) && existsSync(join(REF_RES, 'FAND.RES')) && existsSync(join(APP, 'UCTO2026.RDB'));

const E = K.Enter;
const ESC = K.Esc;
const D = K.Down;
const CTRL_Y = 0x1519;

// From the main menu (Finance pull-down open, cursor on Peněžní deník).
const STEPS: Step[] = [
  // --- cash book: a new entry
  { name: 'Finance > Peněžní deník', keys: [E], wait: 'Nové věty' },
  { name: 'Peněžní deník > Nové věty', keys: [E], wait: 'PENĚŽNÍ DENÍK', settle: 800 },
  { name: 'deník: Datum (today)', keys: [E], wait: 'Doklad: zkratky' },
  { name: 'deník: Doklad P001', keys: ['P001', E], wait: 'Text: stručný popis' },
  { name: 'deník: Text', keys: ['Vklad', E], wait: 'Druh: zkratka operace' },
  { name: 'deník: Druh OP', keys: ['OP', E], wait: 'Firma: číslo firmy' },
  { name: 'deník: Firma 00000', keys: [E], wait: 'Naz0:' },
  { name: 'deník: Naz0', keys: [E], wait: 'Dic0:' },
  { name: 'deník: Dic0', keys: [E], wait: 'Výkon: zkratka' },
  { name: 'deník: Výkon', keys: [E], wait: 'DatumDPH:' },
  { name: 'deník: DatumDPH', keys: [E], wait: 'Celkem: zúčtovaná' },
  { name: 'deník: Celkem 5000', keys: ['5000', E], wait: 'Plat: B-banka' },
  { name: 'deník: Plat H (record saved)', keys: [E], wait: 'H:5000' },
  { name: 'deník: Esc', keys: [ESC], wait: 'Tiskové sestavy' },
  { name: 'Peněžní deník > Seznam', keys: [D, D, E], wait: 'P001', settle: 800 },
  { name: 'deník list: Esc', keys: [ESC], wait: 'Tiskové sestavy' },
  { name: 'Peněžní deník: Esc', keys: [ESC], wait: /Kontroly\s+»/ },
  // --- a Finance submenu
  { name: 'Finance > Číselníky', keys: [D, D, D, D, D, D, E], wait: 'Typy dokladů' },
  { name: 'Číselníky: Esc', keys: [ESC] },
  // --- the menu bar
  { name: 'menu: Inventář', keys: [K.Right] },
  { name: 'menu: Přehledy', keys: [K.Right], wait: 'Účetní výkazy' },
  { name: 'menu: Tiskopisy', keys: [K.Right], wait: 'Adresář firem' },
  { name: 'menu: Ostatní', keys: [K.Right], wait: 'Jiná firma' },
  { name: 'menu: Nápověda', keys: [K.Right] },
  { name: 'menu: back to Tiskopisy', keys: [K.Left, K.Left], wait: 'Adresář firem' },
  // --- the address book: browse, a new address
  { name: 'Tiskopisy > Adresář firem', keys: [E], wait: 'Seznam adres' },
  { name: 'Adresář firem > Seznam adres', keys: [D, E], wait: 'ADRESY PODLE ČÍSLA', settle: 800 },
  { name: 'adresy: F2 nová', keys: [fKey(2)], wait: 'NOVÁ ADRESA' },
  { name: 'adresy: Číslo (proposed)', keys: [E], wait: 'Kód: pomůcka' },
  { name: 'adresy: Kód TEST', keys: ['TEST', E], wait: 'Firma: název firmy' },
  { name: 'adresy: Firma', keys: ['Zkouška s.r.o.', E], wait: 'Oddělení:' },
  { name: 'adresy: Esc from the unfinished record', keys: [ESC], wait: 'Rychle dokončit' },
  { name: 'adresy: Rychle dokončit (saved)', keys: [D, E], wait: 'ADRESY PODLE ČÍSLA', settle: 800 },
  { name: 'adresy: to Misto of the new record', keys: [K.Right, K.Right, K.Right], wait: 'Místo: město' },
  { name: 'adresy: Misto Liberec', keys: ['Liberec', E], wait: /Zkouška s\.r\.o\.\s+Liberec/ },
  { name: 'adresy: Ctrl+PgDn (last record)', keys: [K.CtrlPgDn], wait: 'dovoz a vývoz' },
  { name: 'adresy: Ctrl+Y', keys: [CTRL_Y], wait: 'zrušit větu' },
  { name: 'adresy: zrušit A', keys: ['A'], wait: 'Pokud jste adresu 00999' },
  { name: 'adresy: Hlášení Enter', keys: [E], wait: 'Ponechat adresu v adresáři' },
  { name: 'adresy: Ponechat N (deleted)', keys: ['N'], wait: /^(?![\s\S]*dovoz a vývoz)/ },
  { name: 'adresy: Esc', keys: [ESC], wait: 'Speciální údaje' },
  { name: 'Adresář firem: Esc', keys: [ESC] },
  // --- a report on screen
  { name: 'menu: Přehledy', keys: [K.Left], wait: 'Měsíční součty' },
  { name: 'Přehledy > Měsíční součty', keys: [D, D, E], wait: 'Deník ve sloupcích' },
  { name: '> Deník ve sloupcích', keys: [D, E], wait: 'Kumulované součty' },
  { name: '> Měsíční součty', keys: [E], wait: 'Úzký deník' },
  { name: '> Úzký deník (report)', keys: [E], wait: 'PENĚŽNÍ DENÍK - měsíční součty', settle: 1500 },
  { name: 'report: PgDn', keys: [K.PgDn] },
  { name: 'report: Esc', keys: [ESC], wait: 'Úzký deník', settle: 1000 },
];

// Scenario B, from the main menu (Finance pull-down open, cursor on Peněžní deník): liabilities (a
// new non-VAT record through the Doklad and Firma popups), a check of the cash book (Kontroly >
// Doklad-Platba: an edit whose condition Účto types through setkeybuf, then the same as a report),
// a search in the cash book list (F3), small assets (a new item, saved without a transfer to the
// cash book, which would book VAT) and a letter with its text typed in the text editor (Tiskopisy >
// Pošta, a program of its own).
const STEPS_B: Step[] = [
  // --- liabilities: a new non-VAT record
  { name: 'Finance > Závazky a pohledávky', keys: [D, E], wait: 'Zaúčtování plateb' },
  { name: 'Závazky > Formulář', keys: [E], wait: 'ZÁVAZKY A POHLEDÁVKY', settle: 1000 },
  { name: 'závazky: F2 nová', keys: [fKey(2)], wait: 'DatumVyst:' },
  { name: 'závazky: DatumVyst (today)', keys: [E], wait: 'DatumSpl:' },
  { name: 'závazky: DatumSpl (proposed)', keys: [E], wait: 'Doklad:' },
  { name: 'závazky: Doklad (číselník)', keys: [E], wait: 'ČÍSELNÍK DOKLADŮ' },
  { name: 'závazky: Doklad P/ (taken)', keys: [E], wait: 'Text:' },
  { name: 'závazky: Text', keys: ['Půjčka od společníka', E], wait: 'Druh:' },
  { name: 'závazky: Druh P1', keys: ['P1', E], wait: 'Firma:' },
  { name: 'závazky: Firma 00000', keys: [E], wait: 'FIRMA P/' },
  { name: 'závazky: Název', keys: [E], settle: 700 },
  { name: 'závazky: DIČ', keys: [E], wait: 'Výkon:' },
  { name: 'závazky: Výkon', keys: [E], wait: 'DatumDPH:' },
  { name: 'závazky: DatumDPH', keys: [E], wait: 'Celkem:' },
  { name: 'závazky: Celkem 1500', keys: ['1500', E], wait: 'Plat:' },
  { name: 'závazky: Plat H (saved)', keys: [E], wait: 'DatumVyst:', settle: 1000 },
  { name: 'závazky: Esc', keys: [ESC], wait: 'Zaúčtování plateb' },
  { name: 'Závazky: Esc', keys: [ESC], wait: /Kontroly\s+»/ },
  // --- a check of the cash book: an edit filtered by a condition, then the same as a report
  { name: 'Finance > Kontroly', keys: [D, D, D, D, D, D, D, E], wait: 'KONTROLY VE FINANCÍCH' },
  { name: 'Kontroly > Doklad-Platba', keys: [E], wait: 'Editovat chybné věty' },
  { name: '> Editovat chybné věty', keys: [E], wait: 'PENĚŽNÍ DENÍK', settle: 1500 },
  { name: 'chybné věty: PgDn', keys: [K.PgDn], settle: 1000 },
  { name: 'chybné věty: Esc', keys: [ESC], wait: 'Opis chybných vět' },
  { name: '> Opis chybných vět', keys: [D, E], settle: 2500 },
  { name: 'opis: Esc', keys: [ESC], settle: 1500 },
  { name: 'opis: Esc2', keys: [ESC], settle: 1000 },
  { name: 'opis: Esc3', keys: [ESC], settle: 1000 },
  // --- the cash book list: find a date with F3
  { name: 'Finance: Home', keys: [K.Home], settle: 700 },
  { name: 'Finance > Peněžní deník', keys: [E], wait: 'Nové věty' },
  { name: 'Peněžní deník > Seznam', keys: [D, D, E], wait: 'PENĚŽNÍ DENÍK', settle: 1000 },
  { name: 'deník list: F3 najdi', keys: [fKey(3)], settle: 800 },
  { name: 'deník list: 30.01.26', keys: ['30.01.26', E], settle: 1000 },
  { name: 'deník list: Esc', keys: [ESC], wait: 'Tiskové sestavy' },
  { name: 'Peněžní deník: Esc', keys: [ESC], wait: /Kontroly\s+»/ },
  // --- small assets: a new item
  { name: 'menu: Inventář', keys: [K.Right], wait: 'Drobný majetek' },
  { name: 'Inventář > Drobný majetek', keys: [D, E], wait: 'Vyřazení' },
  { name: 'Drobný majetek > Formulář', keys: [E], wait: 'DROBNÝ MAJETEK', settle: 1000 },
  { name: 'DM: F2 nová', keys: [fKey(2)], wait: 'Číslo: inventární' },
  { name: 'DM: Číslo (proposed)', keys: [E], wait: 'Kód:' },
  { name: 'DM: Kód', keys: [E], wait: 'Klasif' },
  { name: 'DM: Název', keys: ['Židle kancelářská', E], wait: 'Klasifikace:' },
  { name: 'DM: Klasif', keys: [E], wait: 'Umístění:' },
  { name: 'DM: Umístění', keys: ['účtárna', E], wait: 'Cena:' },
  { name: 'DM: Cena 2500', keys: ['2500', E], wait: 'Počet:' },
  { name: 'DM: Počet 2', keys: ['2', E], settle: 800 },
  { name: 'DM: Hmotný', keys: [E], wait: 'Pozn:' },
  { name: 'DM: Pozn', keys: [E], wait: 'DatumPoř:' },
  { name: 'DM: DatumPoř (today)', keys: [E], wait: 'Doklad:' },
  { name: 'DM: Doklad', keys: [E], wait: 'Firma:' },
  { name: 'DM: Firma', keys: [E], wait: 'Výkon:' },
  { name: 'DM: Výkon', keys: [E], wait: 'DatumVyř' },
  { name: 'DM: DatumVyř', keys: [E], wait: 'ZpůsobVyř:' },
  { name: 'DM: ZpůsobVyř', keys: [E], wait: 'PŘENÉST DO' },
  { name: 'DM: Nepřenášet nikam (saved)', keys: [D, D, E], settle: 1000 },
  { name: 'DM: Esc', keys: [ESC], wait: 'Vyřazení' },
  { name: 'Drobný majetek: Esc', keys: [ESC], wait: 'Číselníky inventáře' },
  // --- a letter with its text (Tiskopisy > Pošta, a program of its own)
  { name: 'menu: Tiskopisy', keys: [K.Right, K.Right], wait: 'Adresář firem' },
  { name: 'Tiskopisy > Pošta', keys: [D, E], wait: 'Došlá pošta', settle: 1000 },
  { name: 'Pošta > Dopisy', keys: [E], wait: 'PSANÍ A TISK', settle: 1000 },
  { name: 'dopisy: F2 nový', keys: [fKey(2)], wait: 'Číslo: číslo firmy' },
  { name: 'dopisy: Číslo 00101', keys: ['00101', E], wait: 'Jméno:' },
  { name: 'dopisy: Jméno', keys: [E], wait: 'Datum:' },
  { name: 'dopisy: Datum', keys: [E], wait: 'Věc:' },
  { name: 'dopisy: Věc', keys: ['Zkouška dopisu', E], wait: 'Od:' },
  { name: 'dopisy: Od', keys: [E], wait: 'Text: vlastní dopis' },
  { name: 'dopisy: Text (editor)', keys: [K.Ins], wait: /^\s*1:1\s/, settle: 1000 },
  { name: 'dopisy: typing', keys: ['Dobrý den,', E, E, 'toto je zkušební dopis.', E, 'S pozdravem'], settle: 800 },
  { name: 'dopisy: Esc from the editor (saved)', keys: [ESC], settle: 1000 },
  { name: 'dopisy: Esc', keys: [ESC], wait: 'Vyřizuje a podpis', settle: 1000 },
  { name: 'Pošta: Esc', keys: [ESC], settle: 1000 },
];

// Scenario C, from the main menu: an edit in the cash book list (committed by moving off the
// record), then Ostatní > Jiná firma > Vlastní účetnictví: Účto creates the company {DATA} from its
// templates (ExecDos copy, EXPIMP ImportFD of the code lists, FILESIZE.EXE, which neither side can
// run), its empty cash book ('soubor ... je prázdný'), and back to Příklad.
const STEPS_C: Step[] = [
  { name: 'Finance > Peněžní deník', keys: [E], wait: 'Nové věty' },
  { name: 'Peněžní deník > Seznam', keys: [D, D, E], wait: 'PENĚŽNÍ DENÍK', settle: 1000 },
  { name: 'deník list: to Text', keys: [K.Right, K.Right, K.Right], wait: 'Text: stručný' },
  { name: 'deník list: Text', keys: ['nákup pro výrobu II', E], wait: 'Výkon:' },
  { name: 'deník list: Up (saved)', keys: [K.Up], settle: 1000 },
  { name: 'deník list: Esc', keys: [ESC], wait: 'Tiskové sestavy' },
  { name: 'Peněžní deník: Esc', keys: [ESC], wait: /Kontroly\s+»/ },
  { name: 'menu: Ostatní', keys: [K.Left, K.Left], wait: 'Jiná firma' },
  { name: 'Ostatní > Jiná firma', keys: [E], wait: 'Vlastní účetnictví' },
  { name: 'Jiná firma > Vlastní účetnictví', keys: [D, E], wait: 'Přejít k vlastnímu účetnictví' },
  { name: 'Přejít: A', keys: ['A'], wait: 'NOVÁ FIRMA', settle: 1500 },
  { name: 'nová: Peněžní deník', keys: [E], wait: 'Nové věty' },
  { name: 'nová: Seznam (DENIK is empty)', keys: [D, D, E], wait: 'je prázdný' },
  { name: 'nová: prázdný Enter', keys: [E], settle: 1000 },
  { name: 'nová: Peněžní deník Esc', keys: [ESC], wait: /Kontroly\s+»/ },
  { name: 'nová: menu Ostatní', keys: [K.Left, K.Left], wait: 'Jiná firma' },
  { name: 'nová: Jiná firma', keys: [E], wait: 'Vlastní účetnictví' },
  { name: 'Jiná firma > Příklad', keys: [D, E], wait: 'Ano/Ne' },
  { name: 'Příklad: A', keys: ['A'], wait: 'STEHLÍK & SYN', settle: 1500 },
];

// Scenario D, from the main menu: reports (Přehledy > Účetní výkazy > Výkaz příjmů a výdajů and its
// column sums), fixed assets (current depreciation, the asset list), and two calculators (Ostatní >
// Kalkulačky: the VAT calculator computed with ^F5, the calendar paged with PgDn).
const STEPS_D: Step[] = [
  // --- a statement: Výkaz příjmů a výdajů
  { name: 'menu: Přehledy', keys: [K.Right, K.Right], wait: 'Účetní výkazy' },
  { name: 'Přehledy > Účetní výkazy', keys: [E], wait: 'Jiné období' },
  { name: 'Účetní výkazy > Výkaz příjmů a výdajů', keys: [D, D, D, D, D, E], wait: 'Součty sloupců' },
  { name: '> Výkaz příjmů a výdajů (report)', keys: [E], wait: 'Základ daně', settle: 1500 },
  { name: 'výkaz: Esc', keys: [ESC], wait: 'Součty sloupců', settle: 1000 },
  { name: '> Součty sloupců (report)', keys: [D, E], settle: 3000 },
  { name: 'součty: Esc', keys: [ESC], wait: 'Nepeněžní operace', settle: 1000 },
  { name: 'Výkaz příjmů: Esc', keys: [ESC], wait: 'Uzávěrkové operace' },
  { name: 'Účetní výkazy: Esc', keys: [ESC], wait: 'Měsíční součty' },
  // --- fixed assets: depreciation and the list
  { name: 'menu: Inventář', keys: [K.Left], wait: 'Dlouhodobý majetek' },
  { name: 'Inventář > Dlouhodobý majetek', keys: [E], wait: 'Aktuální odpisy' },
  { name: '> Aktuální odpisy', keys: [D, D, D, E], wait: 'AKTUÁLNÍ ODPISY', settle: 1500 },
  { name: 'odpisy: Down', keys: [D], settle: 800 },
  { name: 'odpisy: Esc', keys: [ESC], wait: 'Technické zhodnocení', settle: 1000 },
  { name: '> Seznam majetku', keys: [K.Up, K.Up, E], wait: 'DLOUHODOBÝ MAJETEK', settle: 1500 },
  { name: 'seznam: End', keys: [K.End], settle: 800 },
  { name: 'seznam: Esc', keys: [ESC], wait: 'Technické zhodnocení', settle: 1000 },
  { name: 'Dlouhodobý majetek: Esc', keys: [ESC], wait: 'Číselníky inventáře' },
  // --- calculators
  { name: 'menu: Ostatní', keys: [K.Right, K.Right, K.Right], wait: 'Jiná firma' },
  { name: 'Ostatní > Kalkulačky', keys: [D, D, D, D, D, D, D, D, E], wait: 'Daň z přidané hodnoty' },
  { name: '> Kalkulačka DPH', keys: [E], wait: 'VÝPOČET Z CENY S DANÍ', settle: 1000 },
  { name: 'DPH: datum', keys: [E], settle: 700 },
  { name: 'DPH: základ 2500', keys: ['2500', E], settle: 700 },
  { name: 'DPH: ^F5', keys: [fKey(5, 2)], settle: 1000 },
  { name: 'DPH: Esc prompt', keys: [ESC], settle: 700 },
  { name: 'DPH: Esc', keys: [ESC], wait: 'Sčítačka', settle: 1000 },
  { name: '> Kalendář', keys: [D, D, D, D, D, D, D, D, E], wait: 'KALENDÁŘ', settle: 1000 },
  { name: 'kalendář: PgDn', keys: [K.PgDn], settle: 1000 },
  { name: 'kalendář: PgDn 2', keys: [K.PgDn], settle: 1000 },
  { name: 'kalendář: Esc', keys: [ESC], wait: 'Telefonní seznam', settle: 1000 },
  { name: 'Kalkulačky: Esc', keys: [ESC], wait: 'Jiná firma', settle: 1000 },
];

interface Run {
  start: string[];
  menu: string;
  screens: StepScreen[];
  exit: number;
  errors: string[];
}

async function runOne(d: RefFandDriver | EngineDriver, steps: Step[]): Promise<Run> {
  try {
    const start = await startUcto(d, 120_000);
    const menu = await settle(d);
    const screens = await runSteps(d, steps);
    const exit = await quitUcto(d);
    return { start, menu, screens, exit, errors: 'errors' in d ? d.errors : [] };
  } finally {
    await d.close();
  }
}

// The VAT rate label (Sazba '21%'/'12%') the forms show beside a VAT sum: blank in the reference
// (the FPC StoreD bug, see the header), so existing VAT records differ in it.
const maskVatRate = (line: string) => line.replace(/│   (\d\d%|   )(?= )/g, '│   ~~~');

/** Known, explained differences of one scenario. */
interface Known {
  /** rewrites both sides' screen lines (after maskVatRate) */
  mask?: (line: string, y: number) => string;
  /** data differences that are known and explained */
  data?: (d: { file: string; what: string }) => boolean;
}

/** Runs the reference and then our engine on fresh copies at the same path and compares both. */
async function bringUp(steps: Step[], known: Known = {}): Promise<void> {
  const base = mkdtempSync('/tmp/fandbu-');
  const dir = join(base, 'task');
  try {
    cpSync(APP, dir, { recursive: true });
    // a minimal environment for the reference: Účto stores and parses the output of `set`
    // BRINGUP_APPRES=1: both use Účto's own FAND.RES (4.20, as the app ships it) instead of the reference's
    const appRes = !!process.env.BRINGUP_APPRES;
    const ref = await runOne(new RefFandDriver({ taskDir: dir, task: 'ucto2026', cleanEnv: true, env: appRes ? { FANDRES: dir } : {} }), steps);
    renameSync(dir, join(base, 'ref'));

    cpSync(APP, dir, { recursive: true });
    const ours = await runOne(new EngineDriver({ appDir: dir, project: 'UCTO2026', env: appRes ? { FAND_DOSTOOLS: '0', FAND_DOSPATHS: '0' } : { FANDRES: REF_RES, FAND_DOSTOOLS: '0', FAND_DOSPATHS: '0' } }), steps);
    renameSync(dir, join(base, 'ours'));

    // the reference must have walked the scenario as intended, or the comparison means nothing
    expect(ref.menu.split('\n')[0]).toMatch(UCTO_MAIN_MENU);
    expect(ref.screens.filter((s) => s.timeout).map((s) => `${s.step}: ${s.timeout}`)).toEqual([]);
    expect(ref.exit).toBe(0);

    expect(ours.errors).toEqual([]);
    expect(ours.start).toEqual(ref.start);
    const screens = diffScreens([{ step: 'main menu', screen: ref.menu }, ...ref.screens], [{ step: 'main menu', screen: ours.menu }, ...ours.screens], (l, y) => (known.mask ? known.mask(maskVatRate(l), y) : maskVatRate(l)));
    expect(formatScreenDiffs(screens)).toBe('');
    expect(ours.exit).toBe(0);

    const decls = loadFileDecls(APP);
    const data = compareTaskDirs(join(base, 'ref'), join(base, 'ours'), decls, {
      ignore: (f) => f === 'UCTOTXT.UUU',
      reportMissing: (f, side) => !(side === 'ref' && f.startsWith('{OBNV}/')),
    });
    expect(data.filter((d) => !known.data?.(d)).map((d) => `${d.file}: ${d.what}`)).toEqual([]);
  } finally {
    if (!process.env.KEEP_BRINGUP) rmSync(base, { recursive: true, force: true });
    else console.log(`bring-up dirs kept in ${base}`);
  }
}

describe.skipIf(!ready)('bring-up: Účto 2026 in our engine versus the reference PC FAND', () => {
  it('shows the same screens and leaves the same data (cash book, menus, address book, report)', () => bringUp(STEPS), 600_000);
  it('shows the same screens and leaves the same data (liabilities, checks, search, small assets, letter)', () => bringUp(STEPS_B), 900_000);
  it('shows the same screens and leaves the same data (list edit, a new company and back)', () =>
    bringUp(STEPS_C, {
      // the tip under the company name (Osveta) is chosen with Random: BP7's generator here, FPC's there
      mask: (l, y) => (y === 22 && /^░░░ \S/.test(l) ? '░░░ (tip)' : l),
      // EXPIMP ImportFD copies a code list over the file it has just created (one 4 kB cache page)
      // and truncates with the DOS `WriteH(h,0,...)`, which the FPC WriteH ignores: the reference
      // keeps the rest of that page. Ours truncates (BP7), so only ours has no bytes after the records.
      data: (d) => /^\{(DATA|TREN)\}\/CIS(DRUH|POH)\.001$/.test(d.file) && /^bytes after the records differ \(\d+ \/ 0\)$/.test(d.what),
    }), 900_000);
  it('shows the same screens and leaves the same data (reports, fixed assets, calculators)', () =>
    bringUp(STEPS_D, {
      mask: (l) =>
        l
          // VAT calculator rows: rate and amounts (SAZDPH, see the header)
          .replace(/^(║ +(?:základní|1\.snížená)).*?(  [ZS] ║)/, '$1 ~$2')
          // calendar: working days, holidays and the holiday marks (the FAND.CFG table, see the header)
          .replace(/pracovní +\d+/g, 'pracovní ~')
          .replace(/\+ svátky +\d*\*? /g, '+ svátky ~ ')
          .replace(/(\d)\*/g, '$1 '),
    }), 900_000);
});
