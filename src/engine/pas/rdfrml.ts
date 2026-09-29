// PAS: RDFRML.PAS (include of COMPILE) – the formula parser: RdFormula -> RdBOr -> RdBAnd ->
// RdComp -> RdAdd -> RdMult -> RdPrim, built-in function tables, user functions (FuncD), 'in'
// constant lists, and key-in conditions (RdKeyInBool, used by edit/report/merge/for-all).
//
// Porting notes:
// * No interface state. FTyp result types: 'R' real, 'S' string, 'B' boolean. Uses
//   AccessVars.RdFldNameFrml/RdFunction (hooks set per caller: RDPROC RdFldNameFrmlP,
//   RDRPRT ...R, RDMERG ...M, default RdFldNameFrmlF), FrmlSumEl/FrstSumVar/ChainSumEl (sum/count),
//   FileVarsAllowed, AccessVars.FuncDRoot, RdRunVars.LVBD.
// * asm: IsFun (BP7) scans a table of string[9] (lower case, sorted) and stops early once LexWord
//   sorts below an entry; FPC scans linearly. Same result because the tables are sorted.
//   In TS: IsFun(names, codes, FunCode) over 0-based arrays.
// * RDFRML tables: R0Fun/R0Code (0-ary real), RCFun/RCCode (WordVarArr index 3..7 ->
//   _getwordvar with N01), S0Fun, B0Fun, S1Fun, R1Fun, R2Fun, RS1Fun, S3Fun ('text' = _str).
// * GetOp(Op, BytesAfter) inline data = FrmlElem.Inline (FPC FrmlInline(X), the bytes Pascal
//   allocates right after the node with GetStore). Layout RUNFRML reads:
//   - _instr/_inreal: N11 = tilde/precision; Inline = groups, each a count byte n (1..254) followed by
//     n constants, or $FF followed by two constants (an interval lo..hi); a 0 byte ends the list.
//     A string constant is a length byte + bytes (StoreStr); a real constant is sizeof(float) = 8
//     bytes, an IEEE double little-endian (FPC; BP7 stored 6-byte Real48 – never reaches disk).
//   - _modulo: W11 = number of integers N; the first integer (the modulus) is W12 (BP7 layout: the
//     first GetStore(2) lands on W12), the N-1 weights follow as little-endian words in Inline
//     (= FPC FrmlInline, = BP7 @W21).
//   - _trust: Inline = the byte string (length byte + bytes) of RdByteListInStore (BP7 @N01).
//   _const strings, Mask, Options are ordinary fields (S, Mask, Options).
// * SUM(...) returns FrmlPtr(@FrmlSumEl^.Op): FrmlAt(sumElem, {Op, R}), a live _const view.
// * SQL: RdKeyInBool's SQLFilter is only set for typSQLFile files (FandSQL off) – always false.
// * Private routines: TestBool, RdFormula, RdAdd, RdPrim (+ nested FindFuncD, IsFun), RdMult,
//   RdComp (+ RdPrecision, RdTilde, RdInConst, StoreConst), BOperation, RdBAnd, RdBOr,
//   RdKeyInBool.MyBPContext, RdKeyInBool.RdFL. TestBool and RdFormula are exported because
//   RDFRML1 (same Pascal unit) uses them.

import { ref, fref, ord, byte, UpCase, ShortStr, type Ref } from './pasrt.ts';
import { ChainLast } from './base.ts';
import {
  AccessVars, FrmlListEl, KeyInD, SumElem, FrmlAt,
  _identifier, _quotedstr, _subrange, _equ, _ne, _limpl, _lequ, _const, _getwordvar, _userfunc, _copy, _str,
  _cond, _modulo, _strdate, _valdate, _replace, _pos, _addwdays, _difwdays, _leadchar, _trailchar,
  _copyline, _repeatstr, _char, _trust, _equmask, _lneg, _unminus, _times, _divide, _div, _mod, _round,
  _plus, _concat, _minus, _compreal, _compstr, _inreal, _instr, _and, _or, _eval, _setmybp, _access,
  _cprinter, _currtime, _edrecno, _exitcode, _getmaxx, _getmaxy, _maxcol, _maxrow, _memavail, _mousex,
  _mousey, _pi, _random, _today, _txtpos, _txtxy, _accright, _clipbd, _edbool, _edfield, _edfile, _edkey,
  _edreckey, _keybuf, _password, _readkey, _username, _version, _isnewrec, _testmode, _getenv, _lowcase,
  _nodiakr, _upcase, _abs, _arctan, _color, _cos, _exp, _frac, _int, _ln, _sin, _sqr, _sqrt, _typeday,
  _addmonth, _difmonth, _diskfree, _length, _linecnt, _ord, _val,
  type FrmlPtr, type FrmlList, type KeyInDPtr, type KeyFldDPtr,
} from './access.ts';
import { TrailChar } from './runfrml.ts';
import { RdByteListInStore } from './rdfildcl.ts';
import {
  Error, OldError, SkipBlank, RdLex, TestLex, Accept, RdInteger, RdRealConst, EquUpcase, IsKeyWord,
  AcceptKeyWord, RdQuotedChar,
} from './lexanal.ts';
import { GetOp } from './rdfrml1.ts';

// PAS: RDFRML.PAS TestBool
export function TestBool(FTyp: string): void {
  if (FTyp !== 'B') OldError(18);
}
// PAS: RDFRML.PAS TestString
export function TestString(FTyp: string): void {
  if (FTyp !== 'S') OldError(19);
}
// PAS: RDFRML.PAS TestReal
export function TestReal(FTyp: string): void {
  if (FTyp !== 'R') OldError(20);
}

// PAS: RDFRML.PAS RdPrim.FindFuncD
function FindFuncD(ZZ: Ref<FrmlPtr>): boolean {
  const typ = ref('\0');
  let fc = AccessVars.FuncDRoot;
  while (fc !== null) {
    if (EquUpcase(fc.Name)) {
      RdLex();
      RdLex();
      const z = GetOp(_userfunc, 8)!;
      z.FC = fc;
      let lv = fc.LVB.Root;
      const n = fc.LVB.NParam;
      for (let i = 1; i <= n; i++) {
        const fl = new FrmlListEl();
        ChainLast(fref(z, 'FrmlL'), fl);
        fl.Frml = RdFormula(typ);
        if (typ.v !== lv!.FTyp) OldError(12);
        lv = lv!.Chain;
        if (i < n) Accept(',');
      }
      Accept(')');
      ZZ.v = z;
      return true;
    }
    fc = fc.Chain;
  }
  return false;
}

const MaxLen = 9;
// PAS: RDFRML.PAS RdPrim.IsFun (FPC version: LexWord lower-cased in 'A'..'Z', linear scan)
function IsFun(XFun: readonly string[], XCode: readonly string[], FunCode: Ref<string>): boolean {
  const lw0 = AccessVars.LexWord;
  if (lw0.length > MaxLen) return false;
  let lw = '';
  for (let i = 0; i < lw0.length; i++) {
    const c = lw0.charCodeAt(i);
    lw += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 32) : lw0[i];
  }
  for (let i = 0; i < XFun.length; i++) {
    if (lw === XFun[i]) {
      FunCode.v = XCode[i];
      RdLex();
      return true;
    }
  }
  return false;
}

// alphabetic ordered lower case names
const R0Fun = [
  'cprinter', 'currtime', 'edrecno', 'exitcode', 'getmaxx', 'getmaxy', 'maxcol', 'maxrow', 'memavail',
  'mousex', 'mousey', 'pi', 'random', 'today', 'txtpos', 'txtxy',
];
const RCFun = ['edbreak', 'edirec', 'menux', 'menuy', 'usercode'];
const S0Fun = [
  'accright', 'clipbd', 'edbool', 'edfield', 'edfile', 'edkey', 'edreckey', 'keybuf', 'password', 'readkey',
  'username', 'version',
];
const B0Fun = ['isnewrec', 'testmode'];
const S1Fun = ['char', 'getenv', 'lowcase', 'nodiakr', 'upcase'];
const R1Fun = ['abs', 'arctan', 'color', 'cos', 'exp', 'frac', 'int', 'ln', 'sin', 'sqr', 'sqrt', 'typeday'];
const R2Fun = ['addmonth', 'addwdays', 'difmonth', 'difwdays'];
const RS1Fun = ['diskfree', 'length', 'linecnt', 'ord', 'val'];
const S3Fun = ['copy', 'str', 'text'];

// The code tables use ACCESS constants, so they are built on first use (PORTING.md section 5).
let funCodes: ReturnType<typeof MakeFunCodes> | null = null;
/** TS-only: the Pascal typed constants R0Code..S3Code. */
function MakeFunCodes() {
  return {
    R0Code: [
      _cprinter, _currtime, _edrecno, _exitcode, _getmaxx, _getmaxy, _maxcol, _maxrow, _memavail,
      _mousex, _mousey, _pi, _random, _today, _txtpos, _txtxy,
    ],
    RCCode: ['\x03', '\x04', '\x05', '\x06', '\x07'],
    S0Code: [
      _accright, _clipbd, _edbool, _edfield, _edfile, _edkey, _edreckey, _keybuf, _password, _readkey, _username,
      _version,
    ],
    B0Code: [_isnewrec, _testmode],
    S1Code: [_char, _getenv, _lowcase, _nodiakr, _upcase],
    R1Code: [_abs, _arctan, _color, _cos, _exp, _frac, _int, _ln, _sin, _sqr, _sqrt, _typeday],
    R2Code: [_addmonth, _addwdays, _difmonth, _difwdays],
    RS1Code: [_diskfree, _length, _linecnt, _ord, _val],
    S3Code: [_copy, _str, _str],
  };
}
function FunCodes(): ReturnType<typeof MakeFunCodes> {
  return (funCodes ??= MakeFunCodes());
}

/** TS-only: a string as a length-prefixed byte image (StoreStr into inline data). */
function PStrBytes(s: string): number[] {
  const b = [s.length & 0xff];
  for (let i = 0; i < s.length && i < 255; i++) b.push(s.charCodeAt(i) & 0xff);
  return b;
}

// PAS: RDFRML.PAS RdPrim – the function-call part (identifier followed by '(')
function RdFunCall(FTyp: Ref<string>): FrmlPtr {
  const a = AccessVars;
  const Typ = ref('\0');
  const FunCode = ref('\0');
  let Z: FrmlPtr;
  let Z1: FrmlPtr = null;
  let Z2: FrmlPtr = null;
  let Z3: FrmlPtr = null;
  const zz = ref<FrmlPtr>(null);
  // shared tails of the Pascal labels
  const L4 = (): void => {
    // 4:
    FTyp.v = 'R';
    Accept(')');
  };
  const L3 = (z: FrmlPtr): void => {
    // 3:
    z!.P1 = RdAdd(Typ);
    TestString(Typ.v);
    L4();
  };
  const L6 = (): void => {
    // 6:
    FTyp.v = 'S';
    Accept(')');
  };
  const L2 = (): FrmlPtr => {
    // 2:
    const z = GetOp(_strdate, a.LexWord.length + 1)!;
    z.P1 = Z1;
    z.Mask = ShortStr(a.LexWord, 80);
    RdLex();
    Accept(')');
    FTyp.v = 'S';
    return z;
  };
  const L8 = (): FrmlPtr => {
    // 8:
    let Options = '';
    if (a.Lexem === ',') {
      RdLex();
      if (a.Lexem !== ',') {
        TestLex(_quotedstr);
        Options = ShortStr(a.LexWord, 5);
        RdLex();
      }
      if (FunCode.v === _pos && a.Lexem === ',') {
        RdLex();
        Z3 = RdAdd(Typ);
        TestReal(Typ.v);
      }
    }
    const z = GetOp(FunCode.v, Options.length + 1)!;
    z.P1 = Z1;
    z.P2 = Z2;
    z.P3 = Z3;
    z.Options = Options;
    Accept(')');
    return z;
  };
  const L5 = (z: FrmlPtr): void => {
    // 5:
    RdLex();
    z!.N11 = ord(RdQuotedChar());
    Accept(',');
    z!.P1 = RdAdd(Typ);
    TestString(Typ.v);
    if (a.Lexem === ',') {
      RdLex();
      z!.N12 = ord(RdQuotedChar());
    }
    L6();
  };
  const L7 = (z: FrmlPtr): void => {
    // 7:
    RdLex();
    z!.P1 = RdAdd(Typ);
    TestString(Typ.v);
    Accept(',');
    z!.P2 = RdAdd(Typ);
    TestReal(Typ.v);
    if (a.Lexem === ',' && z!.Op === _copyline) {
      RdLex();
      z!.P3 = RdAdd(Typ);
      TestReal(Typ.v);
    }
    L6();
  };

  if (FindFuncD(zz)) {
    Z = zz.v;
    FTyp.v = Z!.FC!.FTyp;
  } else if (IsFun(S3Fun, FunCodes().S3Code, FunCode)) {
    RdLex();
    Z = GetOp(FunCode.v, 0)!;
    Z.P1 = RdAdd(FTyp);
    if (FunCode.v === _copy) TestString(FTyp.v);
    else {
      TestReal(FTyp.v);
      FTyp.v = 'S';
    }
    Accept(',');
    Z.P2 = RdAdd(Typ);
    if (!(FunCode.v === _str && Typ.v === 'S')) {
      TestReal(Typ.v);
      Accept(',');
      Z.P3 = RdAdd(Typ);
      TestReal(Typ.v);
    }
    // 0:
    Accept(')');
  } else if (IsKeyWord('COND')) {
    RdLex();
    Z2 = null;
    for (;;) {
      // 1:
      const z = GetOp(_cond, 0)!;
      if (!IsKeyWord('ELSE')) {
        z.P1 = RdFormula(Typ);
        TestBool(Typ.v);
      }
      Accept(':');
      z.P2 = RdAdd(Typ);
      if (Z2 === null) {
        Z1 = z;
        FTyp.v = Typ.v;
        if (Typ.v === 'B') OldError(70);
      } else {
        Z2.P3 = z;
        if (FTyp.v === 'S') TestString(Typ.v);
        else TestReal(Typ.v);
      }
      if (z.P1 !== null && a.Lexem === ',') {
        RdLex();
        Z2 = z;
        continue;
      }
      break;
    }
    Accept(')');
    Z = Z1;
  } else if (IsKeyWord('MODULO')) {
    RdLex();
    Z1 = RdAdd(Typ);
    TestString(Typ.v);
    Z = GetOp(_modulo, 2)!;
    Z.P1 = Z1;
    let N = 0;
    const weights: number[] = [];
    do {
      Accept(',');
      const w = RdInteger() & 0xffff;
      if (N === 0) Z.W12 = w; // the modulus
      else weights.push(w & 0xff, w >> 8);
      N++;
    } while (a.Lexem === ',');
    Z.Inline = Uint8Array.from(weights);
    Accept(')');
    Z.W11 = N;
    FTyp.v = 'B';
  } else if (IsKeyWord('SUM')) {
    RdLex();
    if (a.FrmlSumEl !== null) OldError(74);
    if (a.ChainSumEl === null) Error(28);
    const se = new SumElem();
    a.FrmlSumEl = se;
    a.FrstSumVar = true;
    se.Op = _const;
    se.R = 0;
    se.Frml = RdAdd(FTyp);
    TestReal(FTyp.v);
    Accept(')');
    Z = FrmlAt(se, { Op: 'Op', R: 'R' });
    a.ChainSumEl!();
    a.FrmlSumEl = null;
  } else if (IsKeyWord('DTEXT')) {
    RdLex();
    Z1 = RdAdd(Typ);
    TestReal(Typ.v);
    Accept(',');
    TestLex(_identifier);
    let w = '';
    for (let I = 0; I < a.LexWord.length; I++) w += UpCase(a.LexWord[I]);
    a.LexWord = w;
    Z = L2();
  } else if (IsKeyWord('STRDATE')) {
    RdLex();
    Z1 = RdAdd(Typ);
    TestReal(Typ.v);
    Accept(',');
    TestLex(_quotedstr);
    Z = L2();
  } else if (IsKeyWord('DATE')) {
    RdLex();
    Z = GetOp(_valdate, 9)!;
    Z.Mask = 'DD.MM.YY';
    L3(Z);
  } else if (IsKeyWord('VALDATE')) {
    RdLex();
    Z1 = RdAdd(Typ);
    TestString(Typ.v);
    Accept(',');
    TestLex(_quotedstr);
    Z = GetOp(_valdate, a.LexWord.length + 1)!;
    Z.P1 = Z1;
    Z.Mask = ShortStr(a.LexWord, 80);
    RdLex();
    L4();
  } else if (IsKeyWord('REPLACE')) {
    RdLex();
    Z1 = RdAdd(Typ);
    TestString(Typ.v);
    Accept(',');
    Z2 = RdAdd(Typ);
    TestString(Typ.v);
    Accept(',');
    Z3 = RdAdd(FTyp);
    TestString(FTyp.v);
    FunCode.v = _replace;
    Z = L8();
  } else if (IsKeyWord('POS')) {
    RdLex();
    Z1 = RdAdd(Typ);
    TestString(Typ.v);
    Accept(',');
    Z2 = RdAdd(Typ);
    TestString(Typ.v);
    Z3 = null;
    FunCode.v = _pos;
    FTyp.v = 'R';
    Z = L8();
  } else if (IsFun(RS1Fun, FunCodes().RS1Code, FunCode)) {
    RdLex();
    Z = GetOp(FunCode.v, 0);
    L3(Z);
  } else if (IsFun(R1Fun, FunCodes().R1Code, FunCode)) {
    RdLex();
    Z = GetOp(FunCode.v, 0)!;
    Z.P1 = RdAdd(Typ);
    TestReal(Typ.v);
    L4();
  } else if (IsFun(R2Fun, FunCodes().R2Code, FunCode)) {
    RdLex();
    Z = GetOp(FunCode.v, 1)!;
    Z.P1 = RdAdd(Typ);
    TestReal(Typ.v);
    Accept(',');
    Z.P2 = RdAdd(Typ);
    TestReal(Typ.v);
    if ((Z.Op === _addwdays || Z.Op === _difwdays) && a.Lexem === ',') {
      RdLex();
      Z.N21 = byte(RdInteger());
      if (Z.N21 > 3) OldError(136);
    }
    L4();
  } else if (IsKeyWord('LEADCHAR')) {
    Z = GetOp(_leadchar, 2);
    L5(Z);
  } else if (IsKeyWord('TRAILCHAR')) {
    Z = GetOp(_trailchar, 2);
    L5(Z);
  } else if (IsKeyWord('COPYLINE')) {
    Z = GetOp(_copyline, 0);
    L7(Z);
  } else if (IsKeyWord('REPEATSTR')) {
    Z = GetOp(_repeatstr, 0);
    L7(Z);
  } else if (IsFun(S1Fun, FunCodes().S1Code, FunCode)) {
    Z = GetOp(FunCode.v, 0)!;
    RdLex();
    Z.P1 = RdAdd(FTyp);
    if (FunCode.v === _char) TestReal(FTyp.v);
    else TestString(FTyp.v);
    L6();
  } else if (IsKeyWord('TRUST')) {
    Z = GetOp(_trust, 0)!;
    Z.Inline = Uint8Array.from(PStrBytes(RdByteListInStore()));
    FTyp.v = 'B';
  } else if (IsKeyWord('EQUMASK')) {
    Z = GetOp(_equmask, 0)!;
    FTyp.v = 'B';
    RdLex();
    Z.P1 = RdAdd(Typ);
    TestString(Typ.v);
    Accept(',');
    Z.P2 = RdAdd(Typ);
    TestString(Typ.v);
    Accept(')');
  } else if (a.RdFunction !== null) Z = a.RdFunction(FTyp);
  else Error(75);
  return Z;
}
// PAS: RDFRML.PAS RdPrim
function RdPrim(FTyp: Ref<string>): FrmlPtr {
  const a = AccessVars;
  const FunCode = ref('\0');
  let Z: FrmlPtr;
  switch (a.Lexem) {
    case _identifier:
      SkipBlank(false);
      if (IsFun(R0Fun, FunCodes().R0Code, FunCode)) {
        Z = GetOp(FunCode.v, 0);
        FTyp.v = 'R';
      } else if (IsFun(RCFun, FunCodes().RCCode, FunCode)) {
        Z = GetOp(_getwordvar, 1)!;
        Z.N01 = ord(FunCode.v);
        FTyp.v = 'R';
      } else if (IsFun(S0Fun, FunCodes().S0Code, FunCode)) {
        Z = GetOp(FunCode.v, 0);
        FTyp.v = 'S';
      } else if (IsFun(B0Fun, FunCodes().B0Code, FunCode)) {
        Z = GetOp(FunCode.v, 0);
        FTyp.v = 'B';
      } else if (IsKeyWord('TRUE')) {
        Z = GetOp(_const, 1)!;
        Z.B = true;
        FTyp.v = 'B';
      } else if (IsKeyWord('FALSE')) {
        Z = GetOp(_const, 1);
        FTyp.v = 'B';
      } else if (!EquUpcase('OWNED') && a.ForwChar === '(') Z = RdFunCall(FTyp);
      else {
        if (a.RdFldNameFrml === null) Error(110);
        Z = a.RdFldNameFrml(FTyp);
        if (Z!.Op !== _access || Z!.LD !== null) a.FrstSumVar = false;
      }
      break;
    case '^':
      RdLex();
      Z = GetOp(_lneg, 0)!;
      Z.P1 = RdPrim(FTyp);
      TestBool(FTyp.v);
      break;
    case '(':
      RdLex();
      Z = RdFormula(FTyp);
      Accept(')');
      break;
    case '-':
      RdLex();
      if (a.Lexem === '-') Error(7);
      Z = GetOp(_unminus, 0)!;
      Z.P1 = RdPrim(FTyp);
      TestReal(FTyp.v);
      break;
    case '+':
      RdLex();
      if (a.Lexem === '+') Error(7);
      Z = RdPrim(FTyp);
      TestReal(FTyp.v);
      break;
    case _quotedstr:
      Z = GetOp(_const, a.LexWord.length + 1)!;
      FTyp.v = 'S';
      Z.S = a.LexWord;
      RdLex();
      break;
    default:
      FTyp.v = 'R';
      Z = GetOp(_const, 6)!;
      Z.R = RdRealConst();
  }
  return Z;
}
// PAS: RDFRML.PAS RdMult
function RdMult(FTyp: Ref<string>): FrmlPtr {
  const a = AccessVars;
  let Z = RdPrim(FTyp);
  for (;;) {
    // 1:
    const Z1 = Z;
    switch (a.Lexem) {
      case '*':
        Z = GetOp(_times, 0);
        break;
      case '/':
        Z = GetOp(_divide, 0);
        break;
      case _identifier:
        if (EquUpcase('div')) {
          Z = GetOp(_div, 0);
          break;
        }
        if (EquUpcase('mod')) {
          Z = GetOp(_mod, 0);
          break;
        }
        if (EquUpcase('round')) {
          TestReal(FTyp.v);
          Z = GetOp(_round, 0)!;
          RdLex();
          Z.P1 = Z1;
          Z.P2 = RdPrim(FTyp);
          TestReal(FTyp.v);
        }
        return Z;
      default:
        return Z;
    }
    // 2:
    TestReal(FTyp.v);
    RdLex();
    Z!.P1 = Z1;
    Z!.P2 = RdPrim(FTyp);
    TestReal(FTyp.v);
  }
}
// PAS: RDFRML.PAS RdAdd
function RdAdd(FTyp: Ref<string>): FrmlPtr {
  const a = AccessVars;
  let Z = RdMult(FTyp);
  for (;;) {
    // 1:
    let Z1: FrmlPtr;
    if (a.Lexem === '+') {
      Z1 = Z;
      if (FTyp.v !== 'R') {
        Z = GetOp(_concat, 0)!;
        TestString(FTyp.v);
        RdLex();
        Z.P1 = Z1;
        Z.P2 = RdMult(FTyp);
        TestString(FTyp.v);
        continue;
      }
      Z = GetOp(_plus, 0);
    } else if (a.Lexem === '-') {
      Z1 = Z;
      Z = GetOp(_minus, 0);
      TestReal(FTyp.v);
    } else return Z;
    // 2:
    RdLex();
    Z!.P1 = Z1;
    Z!.P2 = RdMult(FTyp);
    TestReal(FTyp.v);
  }
}
// PAS: RDFRML.PAS RdComp
function RdComp(FTyp: Ref<string>): FrmlPtr {
  const a = AccessVars;
  let Z: FrmlPtr;
  let R = 0;
  let S = '';
  const buf: number[] = []; // the inline constant list (_inreal/_instr)
  // PAS: RDFRML.PAS RdComp.RdPrecision
  const RdPrecision = (): number => {
    let n = 5;
    if (a.Lexem === '.' && a.ForwChar >= '0' && a.ForwChar <= '9') {
      RdLex();
      n = RdInteger() & 0xffff;
      if (n > 10) OldError(21);
    }
    return n;
  };
  // PAS: RDFRML.PAS RdComp.RdTilde
  const RdTilde = (): number => {
    if (a.Lexem === '~') {
      RdLex();
      return 1;
    }
    return 0;
  };
  // PAS: RDFRML.PAS RdComp.RdInConst
  const RdInConst = (): void => {
    if (FTyp.v === 'S') {
      if (Z!.N11 === 1 /* tilde */) S = TrailChar(' ', a.LexWord);
      else S = a.LexWord;
      Accept(_quotedstr);
    } else R = RdRealConst();
  };
  // PAS: RDFRML.PAS RdComp.StoreConst
  const StoreConst = (): void => {
    switch (FTyp.v) {
      case 'S':
        buf.push(...PStrBytes(S));
        break;
      case 'R': {
        const f = new Uint8Array(8);
        new DataView(f.buffer).setFloat64(0, R, true);
        buf.push(...f);
        break;
      }
    }
  };
  Z = RdAdd(FTyp);
  const Z1 = Z;
  const lx = ord(a.Lexem);
  if (lx >= ord(_equ) && lx <= ord(_ne)) {
    if (FTyp.v === 'R') {
      Z = GetOp(_compreal, 2)!;
      Z.P1 = Z1;
      Z.N21 = ord(a.Lexem);
      RdLex();
      Z.N22 = RdPrecision();
      Z.P2 = RdAdd(FTyp);
      TestReal(FTyp.v);
      FTyp.v = 'B';
    } else {
      TestString(FTyp.v);
      Z = GetOp(_compstr, 2)!;
      Z.P1 = Z1;
      Z.N21 = ord(a.Lexem);
      RdLex();
      Z.N22 = RdTilde();
      Z.P2 = RdAdd(FTyp);
      TestString(FTyp.v);
      FTyp.v = 'B';
    }
  } else if (a.Lexem === _identifier && IsKeyWord('IN')) {
    if (FTyp.v === 'R') {
      Z = GetOp(_inreal, 1)!;
      Z.N11 = RdPrecision();
    } else {
      TestString(FTyp.v);
      Z = GetOp(_instr, 1)!;
      Z.N11 = RdTilde();
    }
    Z.P1 = Z1;
    Accept('[');
    let N = 0;
    let B = -1; // index of the current count byte in buf
    for (;;) {
      // 1:
      RdInConst();
      if ((a.Lexem as string) === _subrange) {
        if (N !== 0) {
          buf[B] = N & 0xff;
          N = 0;
        }
        B = buf.length;
        buf.push(0xff);
        StoreConst();
        RdLex();
        RdInConst();
        StoreConst();
      } else {
        if (N === 0) {
          B = buf.length;
          buf.push(0);
        }
        N++;
        StoreConst();
      }
      if ((a.Lexem as string) !== ']') {
        Accept(',');
        continue;
      }
      break;
    }
    RdLex();
    if (N !== 0) buf[B] = N & 0xff;
    buf.push(0);
    Z.Inline = Uint8Array.from(buf);
    FTyp.v = 'B';
  }
  return Z;
}
// PAS: RDFRML.PAS BOperation
function BOperation(Typ: string, Fun: string, Frml: FrmlPtr): FrmlPtr {
  TestBool(Typ);
  const Z = GetOp(Fun, 0)!;
  RdLex();
  Z.P1 = Frml;
  return Z;
}
// PAS: RDFRML.PAS RdBAnd
function RdBAnd(FTyp: Ref<string>): FrmlPtr {
  let Z = RdComp(FTyp);
  while (AccessVars.Lexem === '&') {
    Z = BOperation(FTyp.v, _and, Z);
    Z!.P2 = RdComp(FTyp);
    TestBool(FTyp.v);
  }
  return Z;
}
// PAS: RDFRML.PAS RdBOr
function RdBOr(FTyp: Ref<string>): FrmlPtr {
  let Z = RdBAnd(FTyp);
  while (AccessVars.Lexem === '|') {
    Z = BOperation(FTyp.v, _or, Z);
    Z!.P2 = RdBAnd(FTyp);
    TestBool(FTyp.v);
  }
  return Z;
}
// PAS: RDFRML.PAS RdFormula
export function RdFormula(FTyp: Ref<string>): FrmlPtr {
  let Z = RdBOr(FTyp);
  while (AccessVars.Lexem === _limpl || AccessVars.Lexem === _lequ) {
    Z = BOperation(FTyp.v, AccessVars.Lexem, Z);
    Z!.P2 = RdBOr(FTyp);
    TestBool(FTyp.v);
  }
  return Z;
}

// PAS: RDFRML.PAS RdKeyInBool.MyBPContext
function MyBPContext(Z: FrmlPtr, NewMyBP: boolean): FrmlPtr {
  if (NewMyBP) {
    const Z1 = GetOp(_setmybp, 0)!;
    Z1.P1 = Z;
    Z = Z1;
  }
  return Z;
}
// PAS: RDFRML.PAS RdKeyInBool.RdFL
function RdFL(NewMyBP: boolean, FL1: FrmlList): FrmlList {
  const a = AccessVars;
  const FTyp = ref('\0');
  let KF: KeyFldDPtr = a.CViewKey!.KFlds;
  const FLRoot = ref<FrmlList>(null);
  const KF2 = KF!.Chain;
  const FVA = a.FileVarsAllowed;
  a.FileVarsAllowed = false;
  const b = FL1 !== null;
  if (KF2 !== null) Accept('(');
  for (;;) {
    // 1:
    const FL = new FrmlListEl();
    ChainLast(FLRoot, FL);
    FL.Frml = MyBPContext(RdFrml(FTyp), NewMyBP);
    if (FTyp.v !== KF!.FldD!.FrmlTyp) OldError(12);
    KF = KF!.Chain;
    if (b) {
      FL1 = FL1!.Chain;
      if (FL1 !== null) {
        Accept(',');
        continue;
      }
    } else if (KF !== null && a.Lexem === ',') {
      RdLex();
      continue;
    }
    break;
  }
  if (KF2 !== null) Accept(')');
  a.FileVarsAllowed = FVA;
  return FLRoot.v;
}
// PAS: RDFRML.PAS RdKeyInBool
export function RdKeyInBool(
  KIRoot: Ref<KeyInDPtr>, NewMyBP: boolean, FromRdProc: boolean, SQLFilter: Ref<boolean>,
): FrmlPtr {
  const a = AccessVars;
  let result: FrmlPtr = null;
  KIRoot.v = null;
  SQLFilter.v = false;
  let FVA = false;
  if (FromRdProc) {
    FVA = a.FileVarsAllowed;
    a.FileVarsAllowed = true;
    if (
      a.Lexem === _identifier &&
      a.ForwChar === '(' &&
      (EquUpcase('EVALB') || EquUpcase('EVALS') || EquUpcase('EVALR'))
    ) {
      a.FileVarsAllowed = false;
    }
  }
  let frml = true;
  if (IsKeyWord('KEY')) {
    AcceptKeyWord('IN');
    if (a.CFile!.Typ !== 'X' || a.CViewKey === null) OldError(118);
    if (a.CViewKey!.KFlds === null) OldError(176);
    Accept('[');
    for (;;) {
      // 1:
      const KI = new KeyInD();
      ChainLast(KIRoot, KI);
      KI.X1 = ''; // GetZStore(l): an empty key string
      KI.X2 = '';
      KI.FL1 = RdFL(NewMyBP, null);
      if (a.Lexem === _subrange) {
        RdLex();
        KI.FL2 = RdFL(NewMyBP, KI.FL1);
      }
      if (a.Lexem === ',') {
        RdLex();
        continue;
      }
      break;
    }
    Accept(']');
    if (a.Lexem === '&') RdLex();
    else frml = false;
  }
  if (frml) {
    // 2:
    a.FrmlSumEl = null;
    const FTyp = ref('\0');
    const Z = RdFormula(FTyp)!;
    if (a.CFile!.typSQLFile && FTyp.v === 'S') SQLFilter.v = true;
    else {
      TestBool(FTyp.v);
      if (Z.Op === _eval) Z.EvalFD = a.CFile;
    }
    result = MyBPContext(Z, NewMyBP && Z.Op !== _eval);
  }
  if (FromRdProc) a.FileVarsAllowed = FVA;
  return result;
}
// PAS: RDFRML.PAS RdFrml
export function RdFrml(FTyp: Ref<string>): FrmlPtr {
  AccessVars.FrmlSumEl = null;
  return RdFormula(FTyp);
}
// PAS: RDFRML.PAS RdBool
export function RdBool(): FrmlPtr {
  const FTyp = ref('\0');
  AccessVars.FrmlSumEl = null;
  const Z = RdFormula(FTyp);
  TestBool(FTyp.v);
  return Z;
}
// PAS: RDFRML.PAS RdRealFrml
export function RdRealFrml(): FrmlPtr {
  const FTyp = ref('\0');
  AccessVars.FrmlSumEl = null;
  const Z = RdAdd(FTyp);
  TestReal(FTyp.v);
  return Z;
}
// PAS: RDFRML.PAS RdStrFrml
export function RdStrFrml(): FrmlPtr {
  const FTyp = ref('\0');
  AccessVars.FrmlSumEl = null;
  const Z = RdAdd(FTyp);
  TestString(FTyp.v);
  return Z;
}
