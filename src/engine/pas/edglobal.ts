// PAS: EDGLOBAL.PAS – include of EDITOR: helpers shared by the whole editor: RdFldNameFrmlT
// (field names are not allowed in `calculate` formulas: Error(8)), messages (MyWrLLMsg: message
// 700+HandleError; MyRunError; HMsgExit: RunError(700+HandleError) for a bad text file path),
// character and string search (FindChar, FindString with the find options, SEquOrder), colour-
// control order (SetColorOrd), SimplePrintHead (PHNum := 0, PPageS := $7FFF; page numbering of
// the view).
//
// Porting notes:
// * State: EditorVars/EdPriv in editor.ts. All routines are unit-internal (exported for the other
//   editor modules only).
// * asm/DOS: BP7 asm FindChar/FindUpcChar/FindOrdChar/FindCtrl, ported from the asm: they scan
//   T^[Pos..Len] and return Len (FindCtrl: L+1) when nothing is found. BP7 FindChar leaves Num
//   unchanged (the FPC version sets it to the count found, which breaks UpdScreen's repeated
//   searches with the same Num after a miss).
// * Find options (OptionStr, TestOptStr is case-insensitive): 'u' ignore case (UpcCharTab),
//   '~' CharOrdTab order (ignore diacritics), 'w' whole words (Oddel separators), 'l' in block,
//   'g' global / 'e' from the beginning, 'n' replace without asking.

import { chr, UpCase, Pos, Copy, type Ref } from './pasrt.ts';
import { BaseVars, SetMsgPar, SEquUpcase } from './base.ts';
import type { FrmlPtr } from './access.ts';
import { WrLLF10Msg, RunError } from './obaseww.ts';
import { Error } from './lexanal.ts';
import { EdPriv, Tg, IsOddel, type ColorOrd } from './editor.ts';

// PAS: EDGLOBAL.PAS RdFldNameFrmlT – unit-internal
export function RdFldNameFrmlT(FTyp: Ref<string>): FrmlPtr {
  return Error(8);
}
// PAS: EDGLOBAL.PAS MyWrLLMsg – unit-internal
export function MyWrLLMsg(s: string): void {
  const bv = BaseVars;
  if (bv.HandleError === 4) s = '';
  SetMsgPar(s);
  WrLLF10Msg(700 + bv.HandleError);
}
// PAS: EDGLOBAL.PAS MyRunError – unit-internal
export function MyRunError(s: string, n: number): void {
  SetMsgPar(s);
  RunError(n);
}
// PAS: EDGLOBAL.PAS HMsgExit – unit-internal
export function HMsgExit(s: string): void {
  const HE = BaseVars.HandleError;
  switch (HE) {
    case 0:
      return;
    case 1:
      s = s.slice(0, 1);
      SetMsgPar(s);
      RunError(700 + HE);
      break;
    case 2:
    case 3:
      SetMsgPar(s);
      RunError(700 + HE);
      break;
    case 4:
      RunError(704);
  }
}

// PAS: EDGLOBAL.PAS FindChar – unit-internal (BP7 asm: repnz scasb, Num-th occurrence of C)
export function FindChar(Num: Ref<number>, C: string, Pos: number, Len: number): number {
  const t = EdPriv.T!;
  const c = C.charCodeAt(0);
  let count = 0;
  for (let i = Pos; i <= Len; i++) {
    if ((t[i - 1] ?? 0) === c) {
      count++;
      if (count === Num.v) return i;
    }
  }
  return Len; // BP7: Num unchanged
}

// PAS: EDGLOBAL.PAS TestOptStr – unit-internal
export function TestOptStr(c: string): boolean {
  const o = EdPriv.OptionStr;
  return Pos(c, o) !== 0 || Pos(UpCase(c), o) !== 0;
}

// PAS: EDGLOBAL.PAS FindString.FindUpcChar (nested)
function FindUpcChar(C: string, Pos: number, Len: number): number {
  const t = EdPriv.T!;
  const tab = BaseVars.UpcCharTab;
  const c = tab[C.charCodeAt(0)];
  for (let i = Pos; i <= Len; i++) if (tab[t[i - 1] ?? 0] === c) return i;
  return Len;
}
// PAS: EDGLOBAL.PAS FindString.FindOrdChar (nested)
function FindOrdChar(C: string, Pos: number, Len: number): number {
  const t = EdPriv.T!;
  const tab = BaseVars.CharOrdTab;
  const c = tab[C.charCodeAt(0)];
  for (let i = Pos; i <= Len; i++) if (tab[t[i - 1] ?? 0] === c) return i;
  return Len;
}
// PAS: EDGLOBAL.PAS FindString.SEquOrder (nested)
function SEquOrder(S1: string, S2: string): boolean {
  if (S1.length !== S2.length) return false;
  const tab = BaseVars.CharOrdTab;
  for (let i = 0; i < S1.length; i++) if (tab[S1.charCodeAt(i)] !== tab[S2.charCodeAt(i)]) return false;
  return true;
}

// PAS: EDGLOBAL.PAS FindString – unit-internal: FindStr in T^[I..Len]; I := the index after it
export function FindString(I: Ref<number>, Len: number): boolean {
  const P = EdPriv;
  const FindStr = P.FindStr;
  const c = FindStr.length > 0 ? FindStr[0] : '\0';
  if (FindStr === '') return false;
  const n = FindStr.length;
  for (;;) {
    // 1:
    let i1: number;
    if (TestOptStr('~')) i1 = FindOrdChar(c, I.v, Len);
    else if (TestOptStr('u')) i1 = FindUpcChar(c, I.v, Len);
    else i1 = FindChar({ v: 1 }, c, I.v, Len);
    I.v = i1;
    if (I.v + n > Len) return false;
    const s2 = FindStr;
    let s1 = '';
    for (let k = 0; k < n; k++) s1 += chr(Tg(I.v + k));
    if (TestOptStr('~')) {
      if (!SEquOrder(s1, s2)) {
        I.v++;
        continue;
      }
    } else if (TestOptStr('u')) {
      if (!SEquUpcase(s1, s2)) {
        I.v++;
        continue;
      }
    } else if (s1 !== s2) {
      I.v++;
      continue;
    }
    if (TestOptStr('w')) {
      if ((I.v > 1 && !IsOddel(Tg(I.v - 1))) || !IsOddel(Tg(I.v + n))) {
        I.v++;
        continue;
      }
    }
    I.v += n;
    return true;
  }
}

// PAS: EDGLOBAL.PAS SetColorOrd.FindCtrl (nested): first colour control char in T^[F..L], else L+1
function FindCtrl(F: number, L: number): number {
  const t = EdPriv.T!;
  for (let i = F; i <= L; i++) {
    const c = t[i - 1] ?? 0;
    if (c === 1 || c === 2 || c === 4 || c === 5 || c === 0x11 || c === 0x13 || c === 0x17) return i;
  }
  return L + 1;
}
// PAS: EDGLOBAL.PAS SetColorOrd – unit-internal: toggle the colour control chars of T^[First..Last) in CO
export function SetColorOrd(CO: Ref<ColorOrd>, First: number, Last: number): void {
  let I = FindCtrl(First, Last);
  while (I < Last) {
    const ch = chr(Tg(I));
    const pp = Pos(ch, CO.v);
    if (pp > 0) CO.v = Copy(CO.v, 1, pp - 1) + Copy(CO.v, pp + 1, CO.v.length - pp);
    else CO.v = (CO.v + ch).slice(0, 7); // string[CountC]
    I = FindCtrl(I + 1, Last);
  }
}

// PAS: EDGLOBAL.PAS SimplePrintHead – unit-internal (the .cp/.pl/.he parsing is commented out)
export function SimplePrintHead(): void {
  EdPriv.PHNum = 0;
  EdPriv.PPageS = 0x7fff;
}
