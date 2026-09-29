// PAS: KEYBD.PAS (include of DRIVERS) – keyboard buffer, BIOS keys, Kamenický/Latin-2 conversions.
// Re-exported by drivers.ts; state lives in DriversVars.
//
// Porting notes:
// * asm/DOS (BP7): int $16 keyboard (ReadKey/KeyPressed/ClearKeyBuf), int $33 mouse driver with an
//   event handler filling EventQueue, int $1B/$23 break handler, BIOS Timer at 0:$46C, Delay via
//   the tick counter, char conversions as xlat loops. The FPC port reads raw stdin: PollStdin +
//   ReadTermKey decode ANSI escape sequences into BIOS words (Ctrl+PgUp -> $0300 etc.). Here
//   Crt.readKey()/keyPressed() already deliver BIOS words (console/keys.ts, keyqueue.ts).
// * Key state (DriversVars): KbdChar (last key of ReadKbd), KbdBuffer (byte string of pending
//   keys: AddToKbdBuf stores lo(K) and, when lo = 0, also hi(K); K=0 is stored as $0300 and
//   $0300 as $8400), Event (TEvent), Timer (FPC: GetTickCount64 div 55), LLKeyFlags.
// * FandBatch: ReadKey returns _ESC_ immediately (headless runs must not block).
// * KbdTimer(Delta, Kind): waits Delta ticks; Kind 1 = ESC aborts (returns false), 2 = any key
//   aborts, 0 = plain wait. True when the time ran out.
// * Code-page tables (private): TabKtL/TabLtK (Kamenický <-> Latin-2), TabKtN/TabLtN (no
//   diacritics), ToggleKamen (Alt+F8 keyboard switch). Only foLatin2 matters for Účto (CP852),
//   but printers with Kod 'K'/'k' use ConvKamenLatin/ConvToNoDiakr (OBASE).
// * In DRIVERS (not this file; BP7 has them in KEYBD.PAS): the mouse, GetMouseKeyEvent/TestGlobalKey
//   (Alt+F8 keyboard menu, Alt+F6 printer menu), WaitEvent with the 'PC FAND' screen saver after
//   spec.ScreenDelay, AddCtrlAltShift, KbdPressed/ESCPressed/ReadKbd, Delay/Sound/NoSound.
// * BP7 semantics: GetKeyEvent translates spec.KbdTyp layouts (TabCsKbd/TabSlKbd/TabDtKbd with the
//   dead keys ^ ' : of TabHacek/TabCarka/TabUmlaut, Kamenicky results converted to Latin-2); Účto's
//   FAND.CFG has KbdTyp = OrigKbd. The host Ctrl+Break calls BreakIntHandler (BreakCheck halts).

import { StrToBytes, Halt } from './pasrt.ts';
import { BaseVars, CsKbd, CaKbd, SlKbd, DtKbd } from './base.ts';
import type { TVideoFont } from './drivers.ts';
import {
  DriversVars, BiosKeyPressed, BiosReadKey, BiosWaitKey, HostSleep, ReadKbd, KbdPressed, evKeyDown, foAscii, foLatin2,
  _ESC_,
} from './drivers.ts';

const S = StrToBytes;

// ---------------------------------------------------------------- private state and tables

const ofsHeadKeyBuf = 0x1a;
const ofsTailKeyBuf = 0x1c; // Bios
void ofsHeadKeyBuf;
void ofsTailKeyBuf;
let BreakFlag = false;
const diHacek = 1;
const diCarka = 2;
const diUmlaut = 3;
let Diak = 0; // diHacek, diCarka, diUmlaut (a pending dead key)
void diCarka;

// Kamenicky <-> Latin2 and "no diacritics" tables: array[$80..$ff] of byte (index b - $80)
// Kamenicky to Latin2
const TabKtL = S(
  '\xac\x81\x82\xd4\x84\xd2\x9b\x9f\xd8\xb7\x91\xd6\x96\x92\x8e\xb5' +
  '\x90\xa7\xa6\x93\x94\xe0\x85\xe9\xec\x99\x9a\xe6\x95\xed\xfc\x9c' +
  '\xa0\xa1\xa2\xa3\xe5\xd5\xde\xe2\xe7\xfd\xea\xe8\x9e\xf5\xae\xaf' +
  '\xb0\xb1\xb2\xb3\xb4\x8b\xba\xfb\xeb\xb9\xba\xbb\xbc\xbd\xbe\xbf' +
  '\xc0\xc1\xc2\xc3\xc4\xc5\xc6\xba\xc8\xc9\xca\xcb\xcc\xcd\xce\xcf' +
  '\xd0\xd1\xd2\xd3\xd4\xd5\xd6\xd7\xd8\xd9\xda\xdb\xdc\xdd\xde\xdf' +
  '\xe0\xe1\xe2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\xea\xeb\xec\xed\xee\xef' +
  '\xf0\xf1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9\xfa\xfb\xfc\xfd\xfe\xff'
);
// Latin2 to Kamenicky
const TabLtK = S(
  '\x80\x81\x82\x83\x84\x96\x86\x87\x88\x89\xb6\xb5\x8c\x8d\x8e\x8f' +
  '\x90\x8a\x8d\x93\x94\x9c\x8c\x97\x98\x99\x9a\x86\x9f\x9d\x9e\x87' +
  '\xa0\xa1\xa2\xa3\xa4\xa5\x92\x91\xa8\xa9\xa0\xab\x80\xad\xae\xaf' +
  '\xb0\xb1\xb2\xb3\xb4\x8f\xb6\x89\xb8\xb9\xba\xbb\xbc\xbd\xbe\xbf' +
  '\xc0\xc1\xc2\xc3\xc4\xc5\xc6\xc7\xc8\xc9\xca\xcb\xcc\xcd\xce\xcf' +
  '\xd0\xd1\x85\xd3\x83\xa5\x8b\xd7\x88\xd9\xda\xdb\xdc\xdd\xa6\xdf' +
  '\x95\xe1\xa7\xe3\xe4\xa4\x9b\xa8\xab\x97\xaa\x55\x98\x9d\xee\xef' +
  '\xf0\xf1\xf2\xf3\xf4\xad\xf6\xf7\xf8\xf9\xfa\x75\x9e\xa9\xfe\xff'
);
// Kamenicky to NoDiakr
const TabKtN = S(
  '\x43\x75\x65\x64\x61\x44\x54\x63\x65\x45\x4c\x49\x6c\x6c\x41\x41' +
  '\x45\x7a\x5a\x6f\x6f\x4f\x75\x55\x79\x99\x9a\x53\x4c\x59\x52\x74' +
  '\x61\x69\x6f\x75\x6e\x4e\x55\x4f\x73\x72\x72\x52\xac\xad\xae\xaf' +
  '\xb0\xb1\xb2\xb3\xb4\xb5\xb6\xb7\xb8\xb9\xba\xbb\xbc\xbd\xbe\xbf' +
  '\xc0\xc1\xc2\xc3\xc4\xc5\xc6\xc7\xc8\xc9\xca\xcb\xcc\xcd\xce\xcf' +
  '\xd0\xd1\xd2\xd3\xd4\xd5\xd6\xd7\xd8\xd9\xda\xdb\xdc\xdd\xde\xdf' +
  '\xe0\xe1\xe2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\xea\xeb\xec\xed\xee\xef' +
  '\xf0\xf1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9\xfa\xfb\xfc\xfd\xfe\xff'
);
// Latin2 to NoDiakr
const TabLtN = S(
  '\x43\x75\x65\x61\x61\x75\x63\x63\x6c\x65\x4f\x6f\x69\x5a\x41\x43' +
  '\x45\x4c\x6c\x6f\x6f\x4c\x6c\x53\x73\x4f\x55\x54\x74\x4c\x9e\x63' +
  '\x61\x69\x6f\x75\x41\x61\x5a\x7a\x45\x65\x61\x7a\x43\x73\xae\xaf' +
  '\xb0\xb1\xb2\xb3\xb4\x41\x41\x45\x53\xb9\xba\xbb\xbc\x5a\x7a\xbf' +
  '\xc0\xc1\xc2\xc3\xc4\xc5\x41\x61\xc8\xc9\xca\xcb\xcc\xcd\xce\xcf' +
  '\x64\x44\x44\x45\x64\x4e\x49\x49\x65\xd9\xda\xdb\xdc\x54\x55\xdf' +
  '\x4f\xe1\x4f\x4e\x6e\x6e\x53\x73\x52\x55\x72\x55\x79\x59\x74\xef' +
  '\xf0\xf1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9\xfa\x75\x52\x72\xfe\xff'
);
const CsKbdSize = 67;
const CaKbdSize = 15;
// Ascii to CS keyboard: triples (char, scan code, result); result 1..3 = a dead key
const TabCsKbd = S(
  '\x31\x02\x2b\x32\x03\x88\x33\x04\xa8\x34\x05\x87\x35\x06\xa9\x36' +
  '\x07\x91\x37\x08\x98\x38\x09\xa0\x39\x0a\xa1\x30\x0b\x82\x2c\x53' +
  '\x2e\x3d\x0d\x02\x23\x0d\x02\x2b\x0d\x01\x27\x0d\x01\x21\x02\x31' +
  '\x40\x03\x32\x22\x03\x32\x23\x04\x33\x15\x04\x33\x24\x05\x34\x25' +
  '\x06\x35\x5e\x07\x36\x26\x07\x36\x26\x08\x37\x2f\x08\x37\x2a\x09' +
  '\x38\x28\x09\x38\x28\x0a\x39\x29\x0a\x39\x29\x0b\x30\x3d\x0b\x30' +
  '\x2d\x0c\x3d\xe1\x0c\x3d\x5f\x0c\x25\x3f\x0c\x25\x5b\x1a\xa3\x81' +
  '\x1a\xa3\x7b\x1a\x2f\x9a\x1a\x2f\x5d\x1b\x29\x2b\x1b\x29\x7d\x1b' +
  '\x28\x2a\x1b\x28\x3b\x27\x96\x94\x27\x96\x3a\x27\x22\x99\x27\x22' +
  '\x27\x28\xad\x84\x28\xad\x22\x28\x21\x8e\x28\x21\x7e\x29\x3b\x5e' +
  '\x29\x3b\x5c\x2b\x03\x7c\x2b\x27\x3c\x33\x3f\x3b\x33\x3f\x3e\x34' +
  '\x3a\x2f\x35\x2d\x3f\x35\x5f\x59\x15\x5a\x79\x15\x7a\x5a\x2c\x59' +
  '\x7a\x2c\x79\x19\x15\x1a\x1a\x2c\x19'
);
const SlKbdSize = 63;
// Ascii to Slov. keyboard
const TabSlKbd = S(
  '\x31\x02\x2b\x32\x03\x8c\x33\x04\xa8\x34\x05\x87\x35\x06\x9f\x36' +
  '\x07\x91\x37\x08\x98\x38\x09\xa0\x39\x0a\xa1\x30\x0b\x82\x2c\x53' +
  '\x2e\x3d\x0d\x02\x23\x0d\x02\x2b\x0d\x01\x27\x0d\x01\x21\x02\x31' +
  '\x40\x03\x32\x22\x03\x32\x23\x04\x33\x15\x04\x33\x24\x05\x34\x25' +
  '\x06\x35\x5e\x07\x36\x26\x07\x36\x26\x08\x37\x2f\x08\x37\x2a\x09' +
  '\x38\x28\x09\x38\x28\x0a\x39\x29\x0a\x39\x29\x0b\x30\x3d\x0b\x30' +
  '\x2d\x0c\x3d\xe1\x0c\x3d\x5f\x0c\x25\x3f\x0c\x25\x5b\x1a\xa3\x81' +
  '\x1a\xa3\x7b\x1a\x2f\x9a\x1a\x2f\x5d\x1b\x84\x2b\x1b\x84\x7d\x1b' +
  '\x28\x2a\x1b\x28\x3b\x27\x93\x94\x27\x93\x3a\x27\x22\x99\x27\x22' +
  '\x27\x28\x29\x84\x28\x29\x22\x28\x21\x8e\x28\x21\x7e\x29\x3b\x5e' +
  '\x29\x3b\x3c\x33\x3f\x3b\x33\x3f\x3e\x34\x3a\x2f\x35\x2d\x3f\x35' +
  '\x5f\x59\x15\x5a\x79\x15\x7a\x5a\x2c\x59\x7a\x2c\x79'
);
const DtKbdSize = 13;
// Ascii to D keyboard
const TabDtKbd = S(
  '\x40\x03\x22\x2d\x0c\xe1\x5f\x0c\x2f\x5b\x1a\x81\x7b\x1a\x9a\x3b' +
  '\x27\x94\x3a\x27\x99\x27\x28\x84\x22\x28\x8e\x3c\x33\x3b\x3e\x34' +
  '\x3a\x2f\x35\x2d\x7e\x29\x27'
);
const HacekSzSl = 29;
// after ^ (hacek): pairs (char, result)
const TabHacek = S(
  '\x63\x87\x43\x80\x64\x83\x44\x85\x74\x9f\x54\x86\x65\x88\x45\x89' +
  '\x7a\x91\x5a\x92\x6f\x93\x4f\xa7\x75\x96\x55\xa6\x72\xa9\x52\x9e' +
  '\x6c\x8c\x4c\x9c\x73\xa8\x53\x9b\x6e\xa4\x4e\xa5\x01\x2b\x61\x84' +
  '\x41\x8e\x70\x94\x50\x99\x68\x81\x48\x9a'
);
const CarkaSzSl = 21;
// after ' (carka)
const TabCarka = S(
  '\x65\x82\x45\x90\x6c\x8d\x4c\x8a\x69\xa1\x49\x8b\x6f\xa2\x4f\x95' +
  '\x75\xa3\x55\x97\x79\x98\x59\x9d\x61\xa0\x41\x8f\x72\xaa\x52\xab' +
  '\x02\x3d\x70\xb5\x50\xb6\x68\xb7\x48\xb8'
);
const UmlautSz = 7;
// after : (umlaut)
const TabUmlaut = S(
  '\x61\x84\x41\x8e\x6f\x94\x4f\x99\x75\x81\x55\x9a\x03\x5c'
);
// Alt+F8 CS/US toggle of Kamenicky codes: array[$41..$ab] of byte (index b - $41)
const ToggleKamen = S(
  '\x8f\x42\x80\x85\x90\x46\x47\x48\x8b\x4a\x4b\x8a\x4d\xa5\x95\x50' +
  '\x51\x9e\x9b\x86\x97\x56\x57\x58\x9d\x92\x5b\x5c\x5d\x5e\x5f\x60' +
  '\xa0\x62\x87\x83\x82\x66\x67\x68\xa1\x6a\x6b\x8d\x6d\xa4\xa2\x70' +
  '\x71\xa9\xa8\x9f\xa3\x76\x77\x78\x98\x91\x7b\x7c\x7d\x7e\x7f\x43' +
  '\x75\x88\x64\x61\x44\x54\x63\x65\x45\x9c\x49\x6c\x8c\x41\x8e\x89' +
  '\x7a\x5a\x94\x6f\xa7\x81\xa6\x79\x4f\x55\x53\x4c\x59\xab\x74\x84' +
  '\x69\x93\x96\x6e\x4e\x9a\x99\x73\xaa\x72\x52'
);
// ---------------------------------------------------------------- break

/** TS-only: the host's Ctrl+Break (BP7 BreakIntHandler on int $1B): sets BreakFlag unless spec.NoCheckBreak. */
let BreakHandlerOn = false;
// PAS: KEYBD.PAS BreakIntHandler (BP7 interrupt handler; TS entry for the host)
export function BreakIntHandler(): void {
  if (BreakHandlerOn && !BaseVars.Spec.NoCheckBreak) BreakFlag = true;
}
// PAS: KEYBD.PAS BreakIntrInit (BP7: installs BreakIntHandler on int $1B)
export function BreakIntrInit(): void {
  BreakHandlerOn = true;
}
// PAS: KEYBD.PAS BreakIntrDone
export function BreakIntrDone(): void {
  BreakHandlerOn = false;
}
// PAS: KEYBD.PAS BreakCheck (unit-internal) – Ctrl+Break ends the program
export function BreakCheck(): void {
  if (BreakFlag) {
    BreakFlag = false;
    ClearKeyBuf();
    Halt(0);
  }
}

// ---------------------------------------------------------------- code pages

// PAS: KEYBD.PAS CurrToKamen
export function CurrToKamen(C: string): string {
  const b = C.charCodeAt(0);
  if (BaseVars.Fonts.VFont === foLatin2 && b >= 0x80) return String.fromCharCode(TabLtK[b - 0x80]);
  return C;
}
// PAS: KEYBD.PAS ConvKamenToCurr – converts Buf[0..L-1] in place
export function ConvKamenToCurr(Buf: Uint8Array, L: number): void {
  let tab: Uint8Array;
  if (BaseVars.Fonts.NoDiakrSupported) tab = TabKtN;
  else if (BaseVars.Fonts.VFont === foLatin2) tab = TabKtL;
  else return;
  for (let i = 0; i < L; i++) if (Buf[i] >= 0x80) Buf[i] = tab[Buf[i] - 0x80];
}
// PAS: KEYBD.PAS ConvKamenLatin
export function ConvKamenLatin(Buf: Uint8Array, L: number, ToLatin: boolean): void {
  const tab = ToLatin ? TabKtL : TabLtK;
  for (let i = 0; i < L; i++) if (Buf[i] >= 0x80) Buf[i] = tab[Buf[i] - 0x80];
}
// PAS: KEYBD.PAS ToggleCS
export function ToggleCS(C: string): string {
  let b = C.charCodeAt(0);
  if (b < 0x41) return C;
  const latin = BaseVars.Fonts.VFont === foLatin2;
  if (latin && b >= 0x80) b = TabLtK[b - 0x80];
  if (b <= 0xab) b = ToggleKamen[b - 0x41];
  if (latin && b >= 0x80) b = TabKtL[b - 0x80];
  return String.fromCharCode(b);
}
// PAS: KEYBD.PAS NoDiakr
export function NoDiakr(C: string): string {
  const b = C.charCodeAt(0);
  if (b < 0x80) return C;
  if (BaseVars.Fonts.VFont === foLatin2) return String.fromCharCode(TabLtN[b - 0x80]);
  if (b <= 0xab) return String.fromCharCode(TabKtN[b - 0x80]);
  return C;
}
// PAS: KEYBD.PAS ConvToNoDiakr
export function ConvToNoDiakr(Buf: Uint8Array, L: number, FromFont: TVideoFont): void {
  if (FromFont === foAscii || L === 0) return;
  const tab = FromFont === foLatin2 ? TabLtN : TabKtN;
  for (let i = 0; i < L; i++) if (Buf[i] >= 0x80) Buf[i] = tab[Buf[i] - 0x80];
}

// ---------------------------------------------------------------- keyboard

// PAS: KEYBD.PAS ClearKeyBuf – Bios
export function ClearKeyBuf(): void {
  while (BiosKeyPressed()) BiosReadKey();
  Diak = 0;
}
// PAS: KEYBD.PAS ClearKbdBuf – buffer + Bios
export function ClearKbdBuf(): void {
  ClearKeyBuf();
  DriversVars.KbdBuffer = '';
}
// PAS: KEYBD.PAS KeyPressed – Bios
export function KeyPressed(): boolean {
  BreakCheck();
  return BiosKeyPressed();
}
// PAS: KEYBD.PAS ReadKey – Bios, blocking; ASCII keys lose the scan code, $0300 -> 0, $8400 -> $0300
export function ReadKey(): number {
  if (DriversVars.FandBatch) return _ESC_; // FPC
  while (!KeyPressed()) BiosWaitKey(Infinity);
  let ax = BiosReadKey();
  if ((ax & 0xff) !== 0) ax &= 0xff;
  else if (ax === 0x0300) ax = 0;
  else if (ax === 0x8400) ax = 0x0300;
  return ax;
}

// PAS: KEYBD.PAS ConvHCU (private) – al through the (char, result) pairs of a dead-key table
function ConvHCU(al: number, tab: Uint8Array, n: number): number {
  for (let i = 0; i < n; i++) if (tab[2 * i] === al) return tab[2 * i + 1];
  return al;
}

// PAS: KEYBD.PAS GetKeyEvent (BP7; unit-internal) – next key of KbdBuffer or the Bios into Event:
// national keyboard layouts (spec.KbdTyp) with dead keys ^ ' :, ASCII keys without scan code.
export function GetKeyEvent(): void {
  const dv = DriversVars;
  const E = dv.Event;
  BreakCheck();
  let ax: number;
  const L = dv.KbdBuffer.length;
  if (L > 0) {
    // read from the buffer
    ax = dv.KbdBuffer.charCodeAt(0);
    let n = 1;
    if (L > 1 && ax === 0) {
      ax = dv.KbdBuffer.charCodeAt(1) << 8;
      n = 2;
    }
    dv.KbdBuffer = dv.KbdBuffer.slice(n);
    if (ax === 0x0300) ax = 0;
    else if (ax === 0x8400) ax = 0x0300;
  } else {
    if (!BiosKeyPressed()) {
      E.What = 0; // evNothing
      E.KeyCode = 0;
      return;
    }
    ax = BiosReadKey();
    if (ax === 0x0300) ax = 0;
    else if (ax === 0x8400) ax = 0x0300;
    let tab: Uint8Array | null = null;
    let cx = 0;
    switch (BaseVars.Spec.KbdTyp) {
      case CsKbd:
        tab = TabCsKbd;
        cx = CsKbdSize;
        break;
      case CaKbd:
        tab = TabCsKbd;
        cx = CaKbdSize;
        break;
      case SlKbd:
        tab = TabSlKbd;
        cx = SlKbdSize;
        break;
      case DtKbd:
        tab = TabDtKbd;
        cx = DtKbdSize;
        break;
    }
    if (tab === null) {
      if ((ax & 0xff) !== 0) ax &= 0xff;
    } else {
      // Cs, Ca, Sl or Dt keyboard
      for (let i = 0; i < cx; i++) {
        if (tab[3 * i] === (ax & 0xff) && tab[3 * i + 1] === ((ax >> 8) & 0xff)) {
          const al = tab[3 * i + 2];
          ax = (ax & 0xff00) | al;
          if (al <= diUmlaut && al !== Diak) {
            Diak = al; // an extra ^ or ': wait for the letter
            E.What = 0;
            E.KeyCode = 0;
            return;
          }
          break; // doubly pressed ^ ': the dead key itself
        }
      }
      let al = ax & 0xff;
      if (Diak === diHacek) al = ConvHCU(al, TabHacek, HacekSzSl);
      else if (Diak === diCarka) al = ConvHCU(al, TabCarka, CarkaSzSl);
      else if (Diak === diUmlaut) al = ConvHCU(al, TabUmlaut, UmlautSz);
      ax = (ax & 0xff00) | al;
      if (al !== 0) {
        ax = al; // clear the scan code
        if (BaseVars.Fonts.VFont === foLatin2 && al >= 0x80 && al <= 0xb8) ax = TabKtL[al - 0x80]; // Kamen -> Latin2
      }
    }
  }
  E.What = evKeyDown;
  Diak = 0;
  E.KeyCode = ax;
}

// PAS: KEYBD.PAS KbdTimer – waits Delta ticks: Kind 0 plain, 1 Esc aborts, 2 any key aborts (false)
export function KbdTimer(Delta: number, Kind: number): boolean {
  const dv = DriversVars;
  const EndTime = dv.Timer + Delta;
  for (;;) {
    switch (Kind) {
      case 1:
        if (KeyPressed() && ReadKey() === _ESC_) return false;
        break;
      case 2:
        if (KbdPressed()) {
          ReadKbd();
          return false;
        }
        break;
    }
    const now = dv.Timer;
    if (now >= EndTime) return true;
    // TS: sleep instead of polling; a key ends the sleep early for Kind 1/2
    if (Kind === 0) HostSleep((EndTime - now) * 55);
    else BiosWaitKey(Math.min(55, (EndTime - now) * 55));
  }
}
// PAS: KEYBD.PAS AddToKbdBuf
export function AddToKbdBuf(KeyCode: number): void {
  let K = KeyCode & 0xffff;
  if (K === 0) K = 0x0300;
  else if (K === 0x0300) K = 0x8400;
  const dv = DriversVars;
  if (dv.KbdBuffer.length > 253) return;
  dv.KbdBuffer += String.fromCharCode(K & 0xff);
  if ((K & 0xff) === 0) dv.KbdBuffer += String.fromCharCode((K >> 8) & 0xff);
}
