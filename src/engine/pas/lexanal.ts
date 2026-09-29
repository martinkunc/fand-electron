// PAS: LEXANAL.PAS (include of COMPILE) – the FAND lexer: input setup, ReadChar/SkipBlank with
// {comments} and {$define/ifdef/ifndef/else/endif/include} directives, RdLex, Accept, keywords.
//
// Porting notes:
// * State: AccessVars.CurrChar/ForwChar/Lexem/LexWord/ExpChar, the input InpArrPtr (1-based in
//   Pascal: InpArrPtr^[i] is u8[i-1]), InpArrLen, CurrPos, OldErrPos, InpRdbPos, PrevCompInp
//   (include stack, SaveCompInp/LoadCompInp in ACCESS), Switches/SwitchLevel; CompileVars.ChptIPos
//   (the chapter found by {$include}). ^Z (#26) is the end-of-input char.
// * asm: Accept, EquUpcase, IsKeyWord, IsOpt have BP7 asm versions. Follow the FPC Pascal, but note:
//   BP7 IsKeyWord/IsOpt upcase only LexWord (through UpcCharTab) and compare with S as given
//   (S is always an upper-case literal), while FPC SEquUpcase upcases both – same result for
//   upper-case S. EquUpcase upcases both in either version.
// * FPC vs BP7: SkipBlank's blank range is #0..#$19,#$1B..' ' in FPC (#$1A excluded because it
//   is also the ^Z case label); same behaviour. InpRdbPos.R=ptr(0,1) ("LongStr + ShowErr") is
//   AccessVars.InpRdbPos.R === ShowErrRdb; SetInpTT with IRec=0 evaluates the string formula that
//   Pascal casts into RP.R – here RP.Frml. RdDirective (include): BP7 tests PtrRec(R).Seg<>0, which
//   is false for ptr(0,1) too (FPC tests R<>nil and would put the sentinel into CRdb): BP7 wins.
// * SetInpStr(var S): the input array aliases the caller's string in Pascal; here the byte string
//   is converted with StrToBytes (callers never change S while it is being compiled).
// * Tricky: Error() (see compile.ts) – it decrements CurrPos and reports LastExitCode:=CurrPos+1;
//   OldError resets CurrPos to OldErrPos (start of the last lexeme). SkipLevel/SkipBlank are goto
//   state machines (nested comments counted, quoted strings skipped in SkipLevel only).
//   RdRealConst accepts dates/times ('DD.MM.YY', 'DD.MM.YYYY', 'hh:mm:ss.tt') assembled from
//   several lexemes. RdLex limits: identifier 32 chars (Error 2), number 15 digits (Error 6).
// * Private routines: RdDirective.RdForwName, RdRealConst.ValofS (nested).

import { ref, chr, ord, StrToBytes, ValI, ValR, ShortStr, int16, type Ref } from './pasrt.ts';
import type { float, StringPtr, LongStrPtr } from './base.ts';
import {
  BaseVars, RdMsg, GoExit, StoreAvail, IsLetter, IsDigit, SEquUpcase, SetMsgPar, ValDate, StoreStr,
} from './base.ts';
import {
  AccessVars, RdbPos, CompInpD, ShowErrRdb, GetRecSpace, ReadRec, _T, CodingLongStr, SaveCompInp, LoadCompInp,
  _assign, _addass, _equ, _number, _identifier, _quotedstr, _subrange, _limpl, _ne, _lequ, _le, _lt, _ge, _gt,
  type FileDPtr,
} from './access.ts';
import { DriversVars, ClearKbdBuf } from './drivers.ts';
import { PushW, PopW } from './obaseww.ts';
import { SimpleEditText } from './editor.ts';
import { RunLongStr } from './runfrml.ts';
import { CompileVars } from './compile.ts';
import { FindChpt } from './rdmix.ts';

const EOFChar = '\x1a'; // ^Z

// PAS: LEXANAL.PAS Error – compile error N (message 1000+N); never returns (GoExit)
export function Error(N: number): never {
  const a = AccessVars;
  const bv = BaseVars;
  RdMsg(1000 + N);
  let ErrMsg = bv.MsgLine;
  if (N === 1) {
    if (a.ExpChar >= ' ') ErrMsg = ErrMsg + ' ' + a.ExpChar;
    else {
      switch (a.ExpChar) {
        case _assign: bv.MsgLine = ':='; break;
        case _addass: bv.MsgLine = '+='; break;
        case _equ: bv.MsgLine = '='; break;
        case _number: RdMsg(1004); break;
        case _identifier: RdMsg(1005); break;
        case _quotedstr: RdMsg(1013); break;
      }
      ErrMsg = ErrMsg + ' ' + bv.MsgLine;
    }
    ErrMsg = ShortStr(ErrMsg);
  }
  a.CurrPos--;
  ClearKbdBuf();
  const l = a.InpArrLen;
  const i = ref(a.CurrPos);
  if (
    a.IsTestRun &&
    ((a.PrevCompInp !== null && a.InpRdbPos.R !== a.CRdb) /* $include higher Rdb */ ||
      a.InpRdbPos.R === ShowErrRdb) /* LongStr + ShowErr */ &&
    StoreAvail() > l + bv.TxtCols * bv.TxtRows * 2 + 50
  ) {
    const w = PushW(1, 1, bv.TxtCols, bv.TxtRows);
    DriversVars.TextAttr = bv.Colors.tNorm;
    const p = new Uint8Array(l);
    p.set(a.InpArrPtr!.subarray(0, l));
    if (a.PrevCompInp !== null) RdMsg(63);
    else RdMsg(61);
    const HdTxt = ShortStr(bv.MsgLine, 40);
    SimpleEditText('T', ErrMsg, HdTxt, p, 0xfff, ref(l), i, ref(false));
    PopW(w);
  }
  a.EdRecKey = ErrMsg;
  bv.LastExitCode = i.v + 1;
  a.IsCompileErr = true;
  bv.MsgLine = ErrMsg;
  return GoExit();
}

/** TS-only: the new InpRdbPos (a fresh record: callers may hold a copy of the old one). */
function NewInpRdbPos(R: RdbPos['R'], IRec: number): void {
  const p = new RdbPos();
  p.R = R;
  p.IRec = IRec;
  AccessVars.InpRdbPos = p;
}

// PAS: LEXANAL.PAS SetInpStr
export function SetInpStr(S: Ref<string>): void {
  const a = AccessVars;
  a.InpArrLen = S.v.length;
  a.InpArrPtr = StrToBytes(S.v);
  if (a.InpArrLen === 0) a.ForwChar = EOFChar;
  else a.ForwChar = chr(a.InpArrPtr[0]);
  a.CurrPos = 1;
  NewInpRdbPos(null, 0);
}
// PAS: LEXANAL.PAS SetInpLongStr
export function SetInpLongStr(S: LongStrPtr, ShowErr: boolean): void {
  const a = AccessVars;
  a.InpArrLen = S.length;
  a.InpArrPtr = S;
  if (a.InpArrLen === 0) a.ForwChar = EOFChar;
  else a.ForwChar = chr(a.InpArrPtr[0]);
  a.CurrPos = 1;
  NewInpRdbPos(ShowErr ? ShowErrRdb : null, 0);
}
// PAS: LEXANAL.PAS SetInpTTPos – input from CFile^.TF at Pos
export function SetInpTTPos(Pos: number, Decode: boolean): void {
  const a = AccessVars;
  let s = a.CFile!.TF!.Read(2, Pos);
  if (Decode) s = CodingLongStr(s);
  a.InpArrLen = s.length;
  a.InpArrPtr = s;
  if (a.InpArrLen === 0) a.ForwChar = EOFChar;
  else a.ForwChar = chr(a.InpArrPtr[0]);
  a.CurrPos = 1;
}
// PAS: LEXANAL.PAS SetInpTT – input from a chapter's text (FromTxt) or old text
export function SetInpTT(RP: RdbPos, FromTxt: boolean): void {
  const a = AccessVars;
  if (RP.IRec === 0) {
    SetInpLongStr(RunLongStr(RP.Frml), true);
    return;
  }
  NewInpRdbPos(RP.R, RP.IRec);
  const CF = a.CFile;
  const CR = a.CRecPtr;
  a.CFile = RP.R!.FD;
  a.CRecPtr = GetRecSpace();
  ReadRec(RP.IRec);
  let Pos: number;
  if (FromTxt) Pos = _T(a.ChptTxt);
  else Pos = _T(a.ChptOldTxt);
  SetInpTTPos(Pos, RP.R!.Encrypted);
  a.CFile = CF;
  a.CRecPtr = CR;
}
// PAS: LEXANAL.PAS SetInpTTxtPos – continue at FD^.TxtPosUDLI of its chapter
export function SetInpTTxtPos(FD: FileDPtr): void {
  const a = AccessVars;
  SetInpTT(FD!.ChptPos, true);
  const pos = FD!.TxtPosUDLI & 0xffff;
  if (pos > a.InpArrLen) a.ForwChar = EOFChar;
  else a.ForwChar = chr(a.InpArrPtr![pos - 1]);
  a.CurrPos = pos;
}
// PAS: LEXANAL.PAS ReadChar
export function ReadChar(): void {
  const a = AccessVars;
  a.CurrChar = a.ForwChar;
  if (a.CurrPos < a.InpArrLen) {
    a.CurrPos++;
    a.ForwChar = chr(a.InpArrPtr![a.CurrPos - 1]);
  } else if (a.CurrPos === a.InpArrLen) {
    a.CurrPos++;
    a.ForwChar = EOFChar;
  }
}

const Dirs = ['define', 'ifdef', 'ifndef', 'else', 'endif', 'include']; // [0..5]

// PAS: LEXANAL.PAS RdDirective.RdForwName
function RdForwName(): string {
  const a = AccessVars;
  let s = '';
  while (s.length < 12 && (IsLetter(a.ForwChar) || IsDigit(a.ForwChar))) {
    s += a.ForwChar;
    ReadChar();
  }
  return s;
}
// PAS: LEXANAL.PAS RdDirective – 0 define, 1 ifdef/ifndef (b = condition), 3 else, 4 endif, 5 include
export function RdDirective(b: Ref<boolean>): number {
  const a = AccessVars;
  ReadChar();
  let s = RdForwName();
  let i = 0;
  while (i <= 5 && !SEquUpcase(s, Dirs[i])) i++;
  if (i > 5) Error(158);
  const isUpper = (c: string): boolean => c >= 'A' && c <= 'Z';
  if (i <= 2) {
    while (a.ForwChar === ' ') ReadChar();
    if (i === 0) {
      a.Switches = '';
      while (a.Switches.length < 20 && isUpper(a.ForwChar)) {
        a.Switches += a.ForwChar;
        ReadChar();
      }
    } else {
      if (!isUpper(a.ForwChar)) Error(158);
      ReadChar();
      b.v = false;
      for (let j = 0; j < a.Switches.length; j++) if (a.Switches[j] === a.CurrChar) b.v = true;
      if (i === 2) b.v = !b.v;
      i = 1;
    }
  } else if (i === 5) {
    while (a.ForwChar === ' ') ReadChar();
    s = RdForwName();
    const r = a.CRdb;
    if (a.InpRdbPos.R !== null && a.InpRdbPos.R !== ShowErrRdb) a.CRdb = a.InpRdbPos.R;
    const res = FindChpt('I', s, false, CompileVars.ChptIPos);
    a.CRdb = r;
    if (!res) Error(37);
  }
  if (a.ForwChar !== '}') Error(158);
  ReadChar();
  return i;
}
// PAS: LEXANAL.PAS SkipLevel
export function SkipLevel(withElse: boolean): void {
  const a = AccessVars;
  const begLevel = a.SwitchLevel;
  const b = ref(false);
  for (;;) {
    // 1: skip to directive
    let directive = false;
    switch (a.ForwChar) {
      case "'":
        do ReadChar();
        while (a.ForwChar !== "'" && a.ForwChar !== EOFChar);
        break;
      case '{': {
        ReadChar();
        if ((a.ForwChar as string) === '$') {
          directive = true;
          break;
        }
        let n = 1;
        for (;;) {
          // 2:
          const c = a.ForwChar;
          if (c === '{') n++;
          else if (c === EOFChar) Error(11);
          else if (c === '}') {
            n--;
            if (n === 0) {
              ReadChar();
              break;
            }
          }
          ReadChar();
        }
        continue; // goto 1
      }
      case EOFChar:
        Error(11);
    }
    if (!directive) {
      ReadChar();
      continue; // goto 1
    }
    // 3:
    switch (RdDirective(b)) {
      case 1: // if
        a.SwitchLevel++;
        break;
      case 3: // else
        if (a.SwitchLevel === begLevel) {
          if (withElse) return;
          Error(159);
        }
        break;
      case 4: // end
        if (a.SwitchLevel === 0) Error(159);
        a.SwitchLevel--;
        if (a.SwitchLevel < begLevel) return;
        break;
    }
  }
}
// PAS: LEXANAL.PAS SkipBlank
export function SkipBlank(toNextLine: boolean): void {
  const a = AccessVars;
  const CC = a.CurrChar;
  const b = ref(false);
  outer: for (;;) {
    // 1:
    const c = a.ForwChar;
    if (c === EOFChar) {
      if (a.PrevCompInp !== null) {
        const ci = a.PrevCompInp;
        LoadCompInp(ci);
        if (a.CurrPos <= a.InpArrLen) a.ForwChar = chr(a.InpArrPtr![a.CurrPos - 1]);
        continue;
      }
      break;
    }
    if (c <= ' ') {
      if (toNextLine && c === '\r') {
        ReadChar();
        if (a.ForwChar === '\n') ReadChar();
        break;
      }
      ReadChar();
      continue;
    }
    if (c === '{') {
      ReadChar();
      if (a.ForwChar === '$') {
        const n = RdDirective(b);
        switch (n) {
          case 0:
            break;
          case 1:
            a.SwitchLevel++;
            if (!b.v) SkipLevel(true);
            break;
          case 5: {
            const ci = new CompInpD();
            SaveCompInp(ci);
            a.PrevCompInp = ci;
            SetInpTT(CompileVars.ChptIPos, true);
            break;
          }
          default:
            if (a.SwitchLevel === 0) Error(159);
            if (n === 3) SkipLevel(false);
            else a.SwitchLevel--;
        }
        continue;
      }
      let n = 1;
      for (;;) {
        // 2:
        const c2 = a.ForwChar;
        if (c2 === '{') n++;
        else if (c2 === EOFChar) Error(11);
        else if (c2 === '}') {
          n--;
          if (n === 0) {
            ReadChar();
            continue outer;
          }
        }
        ReadChar();
      }
    }
    break;
  }
  a.CurrChar = CC;
}
// PAS: LEXANAL.PAS OldError
export function OldError(N: number): never {
  AccessVars.CurrPos = AccessVars.OldErrPos;
  return Error(N);
}
// PAS: LEXANAL.PAS RdBackSlashCode – '\\' or '\nnn' inside a quoted string
export function RdBackSlashCode(): void {
  const a = AccessVars;
  if (a.ForwChar === '\\') {
    ReadChar();
    return;
  }
  let Num = '';
  while (IsDigit(a.ForwChar) && Num.length < 3) {
    ReadChar();
    Num = Num + a.CurrChar;
  }
  if (Num === '') return;
  const n = ref(0);
  const i = ref(0);
  ValI(Num, n, i);
  if (n.v > 255) Error(7);
  a.CurrChar = chr(n.v);
}
// PAS: LEXANAL.PAS RdLex
export function RdLex(): void {
  const a = AccessVars;
  a.OldErrPos = a.CurrPos;
  SkipBlank(false);
  ReadChar();
  a.Lexem = a.CurrChar;
  if (IsLetter(a.CurrChar)) {
    a.Lexem = _identifier;
    let w = a.CurrChar;
    let i = 1;
    while (IsLetter(a.ForwChar) || IsDigit(a.ForwChar)) {
      i++;
      if (i > 32) Error(2);
      ReadChar();
      w += a.CurrChar;
    }
    a.LexWord = w;
  } else if (IsDigit(a.CurrChar)) {
    a.Lexem = _number;
    let w = a.CurrChar;
    let i = 1;
    while (IsDigit(a.ForwChar)) {
      i++;
      if (i > 15) Error(6);
      ReadChar();
      w += a.CurrChar;
    }
    a.LexWord = w;
  } else {
    switch (a.CurrChar) {
      case "'": {
        a.Lexem = _quotedstr;
        ReadChar();
        a.LexWord = '';
        while (a.CurrChar !== "'" || a.ForwChar === "'") {
          if ((a.CurrChar as string) === EOFChar) Error(17);
          if (a.LexWord.length === 255) Error(6);
          if (a.CurrChar === "'") ReadChar();
          else if (a.CurrChar === '\\') RdBackSlashCode();
          a.LexWord = a.LexWord + a.CurrChar;
          ReadChar();
        }
        break;
      }
      case ':':
        if (a.ForwChar === '=') {
          ReadChar();
          a.Lexem = _assign;
        }
        break;
      case '.':
        if (a.ForwChar === '.') {
          ReadChar();
          a.Lexem = _subrange;
        }
        break;
      case '=':
        if (a.ForwChar === '>') {
          ReadChar();
          a.Lexem = _limpl;
        } else a.Lexem = _equ;
        break;
      case '+':
        if (a.ForwChar === '=') {
          ReadChar();
          a.Lexem = _addass;
        }
        break;
      case '<':
        switch (a.ForwChar) {
          case '>':
            ReadChar();
            a.Lexem = _ne;
            break;
          case '=':
            ReadChar();
            if ((a.ForwChar as string) === '>') {
              ReadChar();
              a.Lexem = _lequ;
            } else a.Lexem = _le;
            break;
          default:
            a.Lexem = _lt;
        }
        break;
      case '>':
        if (a.ForwChar === '=') {
          ReadChar();
          a.Lexem = _ge;
        } else a.Lexem = _gt;
        break;
    }
  }
}
// PAS: LEXANAL.PAS IsForwPoint – '.' that does not start '..'
export function IsForwPoint(): boolean {
  const a = AccessVars;
  // InpArrPtr^[CurrPos+1]: the char after ForwChar (beyond the input: not a '.')
  return a.ForwChar === '.' && a.InpArrPtr![a.CurrPos] !== 0x2e;
}
// PAS: LEXANAL.PAS TestIdentif
export function TestIdentif(): void {
  if (AccessVars.Lexem !== _identifier) Error(29);
}
// PAS: LEXANAL.PAS TestLex
export function TestLex(X: string): void {
  if (AccessVars.Lexem !== X) {
    AccessVars.ExpChar = X;
    Error(1);
  }
}
// PAS: LEXANAL.PAS Accept
export function Accept(X: string): void {
  if (AccessVars.Lexem !== X) {
    AccessVars.ExpChar = X;
    Error(1);
  }
  RdLex();
}
// PAS: LEXANAL.PAS RdInteger
export function RdInteger(): number {
  const I = ref(0);
  const J = ref(0);
  ValI(AccessVars.LexWord, I, J);
  if (J.v !== 0) AccessVars.Lexem = '\0'; // <>_number
  Accept(_number);
  return int16(I.v);
}
// PAS: LEXANAL.PAS RdRealConst.ValofS
function ValofS(S: string): float {
  const I = ref(0);
  const R = ref(0);
  ValR(S, R, I);
  if (I.v !== 0) {
    R.v = ValDate(S, 'DD.MM.YY');
    if (R.v === 0) {
      R.v = ValDate(S, 'DD.MM.YYYY');
      if (R.v === 0) {
        R.v = ValDate(S, 'hh:mm:ss.tt');
        if (R.v === 0) Error(7);
      }
    }
  }
  return R.v;
}
// PAS: LEXANAL.PAS RdRealConst
export function RdRealConst(): float {
  const a = AccessVars;
  let S: string;
  if (a.Lexem === '-') {
    S = '-';
    RdLex();
  } else S = '';
  TestLex(_number);
  S = S + a.LexWord;
  // 1:
  while (a.ForwChar === '.' || a.ForwChar === ':') {
    RdLex();
    if (a.Lexem !== _subrange && IsDigit(a.ForwChar)) {
      S = S + a.Lexem;
      RdLex();
      S = S + a.LexWord;
      continue;
    }
    return ValofS(S);
  }
  const next = a.InpArrPtr![a.CurrPos]; // InpArrPtr^[CurrPos+1]
  if ((a.ForwChar === 'E' || a.ForwChar === 'e') && (next === 0x2d || (next >= 0x30 && next <= 0x39))) {
    S = S + 'e';
    ReadChar();
    if ((a.ForwChar as string) === '-') {
      ReadChar();
      S = S + '-';
    }
    RdLex();
    TestLex(_number);
    S = S + a.LexWord;
  }
  RdLex();
  return ValofS(S);
}
// PAS: LEXANAL.PAS EquUpcase – LexWord = S ignoring case
export function EquUpcase(S: string): boolean {
  return SEquUpcase(AccessVars.LexWord, S);
}
// PAS: LEXANAL.PAS TestKeyWord
export function TestKeyWord(S: string): boolean {
  return AccessVars.Lexem === _identifier && EquUpcase(S);
}
// PAS: LEXANAL.PAS IsKeyWord – S upper case; reads the next lexeme when it matches
export function IsKeyWord(S: string): boolean {
  if (AccessVars.Lexem !== _identifier) return false;
  if (!SEquUpcase(AccessVars.LexWord, S)) return false;
  RdLex();
  return true;
}
// PAS: LEXANAL.PAS AcceptKeyWord
export function AcceptKeyWord(S: string): void {
  if (TestKeyWord(S)) RdLex();
  else {
    SetMsgPar(S);
    Error(33);
  }
}
// PAS: LEXANAL.PAS IsOpt – 'S=' (S upper case)
export function IsOpt(S: string): boolean {
  if (AccessVars.Lexem !== _identifier || !SEquUpcase(AccessVars.LexWord, S)) return false;
  RdLex();
  Accept(_equ);
  return true;
}
// PAS: LEXANAL.PAS IsDigitOpt – 'Sn=' with one digit n
export function IsDigitOpt(S: string, N: Ref<number>): boolean {
  const a = AccessVars;
  const lw = a.LexWord;
  if (
    a.Lexem === _identifier &&
    lw.length === S.length + 1 &&
    SEquUpcase(lw.slice(0, S.length), S) &&
    IsDigit(lw[lw.length - 1])
  ) {
    N.v = ord(lw[lw.length - 1]) - ord('0');
    RdLex();
    Accept(_equ);
    return true;
  }
  return false;
}
// PAS: LEXANAL.PAS RdStrConst
export function RdStrConst(): StringPtr {
  const S = StoreStr(AccessVars.LexWord);
  Accept(_quotedstr);
  return S;
}
// PAS: LEXANAL.PAS Rd1Char
export function Rd1Char(): string {
  const a = AccessVars;
  if (a.Lexem !== _identifier || a.LexWord.length !== 1) Error(124);
  const c = a.LexWord[0];
  RdLex();
  return c;
}
// PAS: LEXANAL.PAS RdQuotedChar
export function RdQuotedChar(): string {
  const a = AccessVars;
  if (a.Lexem !== _quotedstr || a.LexWord.length !== 1) Error(15);
  const c = a.LexWord[0];
  RdLex();
  return c;
}
// PAS: LEXANAL.PAS IsIdentifStr
export function IsIdentifStr(S: string): boolean {
  if (S.length === 0 || !IsLetter(S[0])) return false;
  for (let i = 1; i < S.length; i++) if (!(IsLetter(S[i]) || IsDigit(S[i]))) return false;
  return true;
}
