// runfrml-proc package: RUNFRML.PAS (formula evaluator) and RUNPROC.PAS (procedure interpreter).
// Built-in functions are compiled from source text with the real compiler (RDFRML/RDPROC) and
// evaluated; expected values come from the FAND help texts (jazyk.md, procedury.md) and BP7
// semantics. The Czech collation, upper-case table and the working-days calendar are read from
// Účto's FAND.CFG. Procedures run end-to-end on small data files created in work/tmp-runfrml-proc/.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Routines of other packages that this package calls but that may still be stubs: fall back to a
// minimal version only while the real one throws NotImplementedError.
function fallback<A extends unknown[], R>(f: (...a: A) => R, g: (...a: A) => R): (...a: A) => R {
  return (...a: A): R => {
    try {
      return f(...a);
    } catch (e) {
      if ((e as Error)?.name === 'NotImplementedError') return g(...a);
      throw e;
    }
  };
}
vi.mock('../src/engine/pas/rdrun.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/engine/pas/rdrun.ts')>();
  const { BaseVars, ProcStkD } = await import('../src/engine/pas/base.ts');
  const { AccessVars, LocVarAd } = await import('../src/engine/pas/access.ts');
  const { LVAssignFrml } = await import('../src/engine/pas/runfrml.ts');
  return {
    ...m,
    // PAS: RDRUN.PAS PushProcStk / PopProcStk
    PushProcStk: fallback(m.PushProcStk, () => {
      const ps = new ProcStkD();
      ps.ChainBack = BaseVars.MyBP;
      BaseVars.MyBP = ps;
      let lv = m.RdRunVars.LVBD.Root;
      ps.LVRoot = lv;
      for (let l = lv; l !== null; l = l.Chain) {
        if (l.FTyp === 'R' || l.FTyp === 'S') ps.V[l.BPOfs] = 0;
        else if (l.FTyp === 'B') ps.V[l.BPOfs] = false;
      }
      while (lv !== null) {
        if ((lv.FTyp === 'R' || lv.FTyp === 'S' || lv.FTyp === 'B') && lv.Init !== null) {
          LVAssignFrml(lv, BaseVars.MyBP, false, lv.Init);
        }
        lv = lv.Chain;
      }
    }),
    PopProcStk: fallback(m.PopProcStk, () => {
      for (let lv = BaseVars.MyBP!.LVRoot; lv !== null; lv = lv.Chain) {
        if (lv.FTyp === 'S') AccessVars.TWork.Delete(LocVarAd(lv).v as number);
      }
      m.SetMyBP(BaseVars.MyBP!.ChainBack);
    }),
  };
});
vi.mock('../src/engine/pas/editor.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/engine/pas/editor.ts')>();
  const { BaseVars } = await import('../src/engine/pas/base.ts');
  return {
    ...m,
    // EDITOR.FindText: position after the first match of Pstr in PTxtPtr[1..PLen] ('u' = upcase)
    FindText: fallback(m.FindText, (Pstr: string, Popt: string, PTxtPtr: Uint8Array | null, PLen: number) => {
      const up = Popt.toLowerCase().includes('u');
      const t = BaseVars.UpcCharTab;
      const c = (b: number): number => (up ? t[b] : b);
      const n = Pstr.length;
      for (let i = 0; i + n <= PLen; i++) {
        let k = 0;
        while (k < n && c(PTxtPtr![i + k]) === c(Pstr.charCodeAt(k))) k++;
        if (k === n) return i + n + 1;
      }
      return 0;
    }),
  };
});

import {
  ref, FromUnicode, Output, TxtRewrite, getWord, FandRunError, GoExitSignal, Clock,
} from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, ProcStkD, InitBase, FormatCache, OpenH, ReadH, SeekH, PosH, OpenWorkH, SizeOfResA, MsgIdxFromBytes,
  ExitRecord, NewExit, RestoreExit, RDate, WRect, MaxLStrLen, _isoverwritefile, Exclusive,
} from '../src/engine/pas/base.ts';
import { SetDriversCrt, AssignCrt, DriversVars, ScrRowStr } from '../src/engine/pas/drivers.ts';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { encode852, decode852 } from '../src/engine/console/cp852.ts';
import { readReal48 } from '../src/engine/fand/numbers.ts';
import {
  AccessVars, FileD, RdbD, RdbPos, FrmlElem, FieldListEl, LocVar, WRectFrml, ResetCompilePars, GetRecSpace,
  _ShortS, _R, S_, R_, _const, _getlocvar, _eval, _equ, _lt, _gt,
  type FrmlPtr, type FieldDescr, type LinkD,
} from '../src/engine/pas/access.ts';
import { SetInpStr, RdLex, RdFrml } from '../src/engine/pas/compile.ts';
import { RdFileD } from '../src/engine/pas/rdfildcl.ts';
import { ReadDeclChpt, GetPInstr } from '../src/engine/pas/rdproc.ts';
import { RdRunVars, SetMyBP, TypAndFrml, _proc, _asgnloc } from '../src/engine/pas/rdrun.ts';
import {
  RunFrmlVars, RunReal, RunBool, RunShortStr, RunLongStr, RunInt, CompReal, CompBool, LeadChar, TrailChar,
  LongTrailChar, CopyLine, CopyToLongStr, DecodeField, DecodeFieldRSB, RunWFrml, RunWordImpl, FieldInList,
  GetFromKey, RunEvalFrml, AssgnFrml, LVAssignFrml, Owned, CanCopyT, Random,
} from '../src/engine/pas/runfrml.ts';
import { RunInstr, RunProcedure, CallProcedure, ResetCatalog } from '../src/engine/pas/runproc.ts';
import { registerHelper } from '../src/engine/pas/fanddos.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const TMP = join(ROOT, 'work/tmp-runfrml-proc');
const haveApp = existsSync(join(APP, 'FAND.CFG')) && existsSync(join(APP, 'FAND.RES'));

/** Byte string of a Unicode text (CP852) and back. */
const B = (u: string): string => String.fromCharCode(...encode852(u));
const U = (b: string): string => decode852(Uint8Array.from(b, (c) => c.charCodeAt(0)));
const H = (p: string): string => FromUnicode(p);
const L = (s: Uint8Array): string => U(String.fromCharCode(...s));

/** RUNFAND.InitRunFand: the FAND.RES message index (after BASE opened the file). */
function ReadResHeader(): void {
  const h = BaseVars.ResFile.Handle;
  const b = new Uint8Array(SizeOfResA);
  SeekH(h, 0);
  ReadH(h, 2, b);
  ReadH(h, SizeOfResA, b);
  BaseVars.ResFile.SetA(b);
  ReadH(h, 2, b);
  BaseVars.MsgIdxN = getWord(b, 0);
  const mi = new Uint8Array(5 * BaseVars.MsgIdxN);
  ReadH(h, mi.length, mi);
  BaseVars.MsgIdx = MsgIdxFromBytes(mi, BaseVars.MsgIdxN);
  BaseVars.FrstMsgPos = PosH(h);
}

/** RUNFAND.RdCFG (the parts RUNFRML needs): CharOrdTab, UpcCharTab and the working-days table. */
function LoadCfgTables(path: string): void {
  const b = readFileSync(path);
  let o = 4 + 35 + 3 * (10 + 54) + 3;
  BaseVars.CharOrdTab = Uint8Array.from(b.subarray(o, o + 256));
  o += 256;
  BaseVars.UpcCharTab = Uint8Array.from(b.subarray(o, o + 256));
  o += 256;
  const prMax = b[o++];
  for (let j = 0; j < prMax; j++) {
    for (let i = 0; i <= 32; i++) o += 1 + b[o];
    expect(b[o++]).toBe(0xff);
    o += 4;
  }
  const n = b.readUInt16LE(o);
  o += 2;
  BaseVars.NWDaysTab = n;
  BaseVars.WDaysFirst = readReal48(b, o);
  BaseVars.WDaysLast = readReal48(b, o + 6);
  o += 12;
  const tab = [{ Typ: 0, Nr: 0 }];
  for (let i = 0; i < n; i++) tab.push({ Typ: b[o + 3 * i], Nr: b.readUInt16LE(o + 3 * i + 1) });
  BaseVars.WDaysTab = tab;
}

/** Runs body under a NewExit frame; a GoExit becomes an exception with the message. */
function ok<T>(body: () => T): T {
  const er = new ExitRecord();
  NewExit(null, er);
  try {
    return body();
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
    throw new Error(`GoExit: ${U(BaseVars.MsgLine)} (${BaseVars.LastExitCode})`);
  } finally {
    RestoreExit(er);
  }
}

function resetCompiler(): void {
  ResetCompilePars();
  AccessVars.RdFldNameFrml = null;
  AccessVars.Switches = '';
  AccessVars.SwitchLevel = 0;
  AccessVars.FrmlSumEl = null;
  AccessVars.IsCompileErr = false;
}

/** Compiles a formula from a Unicode text. */
function frml(src: string): { typ: string; z: FrmlPtr } {
  const S = ref(B(src));
  SetInpStr(S);
  RdLex();
  const t = ref('\0');
  const z = ok(() => RdFrml(t));
  expect(AccessVars.Lexem).toBe('\x1a');
  return { typ: t.v, z };
}
/** Evaluates a formula by its type: number, Unicode string or boolean. */
function run(src: string): number | string | boolean {
  const { typ, z } = frml(src);
  switch (typ) {
    case 'R':
      return RunReal(z);
    case 'S':
      return U(RunShortStr(z));
    default:
      return RunBool(z);
  }
}

let crt: Crt;
beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  if (haveApp) {
    process.env.FANDRES = APP;
    InitBase();
    ReadResHeader();
    LoadCfgTables(join(APP, 'FAND.CFG'));
  }
  FormatCache();
  crt = new Crt(new KeyQueue(), null, 80, 25);
  SetDriversCrt(crt);
  AssignCrt(Output);
  TxtRewrite(Output);
  DriversVars.FandBatch = true; // messages -> stderr, prompts answer No
  const tw = AccessVars.TWork;
  tw.IsWork = true;
  BaseVars.CPath = H(join(TMP, 'FANDWORK.T$$'));
  BaseVars.FandWorkTName = BaseVars.CPath;
  tw.Create();
  BaseVars.FandWorkName = H(join(TMP, 'FANDWORK.$$$'));
  BaseVars.FandWorkXName = H(join(TMP, 'FANDWORK.X$$'));
  OpenWorkH();
  BaseVars.CPath = BaseVars.FandWorkXName;
  AccessVars.XWork.Handle = OpenH(_isoverwritefile, Exclusive);
});
beforeEach(() => {
  resetCompiler();
  BaseVars.MyBP = null;
  BaseVars.ProcMyBP = null;
  BaseVars.ExitP = false;
  BaseVars.BreakP = false;
});

// ---------------------------------------------------------------- simple routines

describe('RUNFRML: helpers', () => {
  it('CompReal rounds both operands to M decimals (M<0: exact); CompBool', () => {
    expect(CompReal(1.234, 1.2, 1)).toBe(ord(_equ));
    expect(CompReal(1.234, 1.2, 5)).toBe(ord(_gt));
    expect(CompReal(1.2, 1.234, -1)).toBe(ord(_lt));
    expect(CompReal(-2.5, -3, 0)).toBe(ord(_equ)); // halves away from zero
    expect(CompReal(0.1 + 0.2, 0.3, 5)).toBe(ord(_equ));
    expect(CompBool(true, false)).toBe(ord(_gt));
    expect(CompBool(false, true)).toBe(ord(_lt));
    expect(CompBool(true, true)).toBe(ord(_equ));
  });
  it('LeadChar/TrailChar/LongTrailChar/CopyToLongStr', () => {
    expect(LeadChar(' ', '  ab ')).toBe('ab ');
    expect(TrailChar(' ', '  ab  ')).toBe('  ab');
    expect(TrailChar('x', 'xxx')).toBe('');
    expect(L(LongTrailChar(' ', '\0', CopyToLongStr('ab  ')))).toBe('ab');
    expect(L(LongTrailChar(' ', '_', CopyToLongStr('ab  ')))).toBe('ab__');
  });
  it('CopyLine selects lines N..N+M-1 (CR LF)', () => {
    const s = CopyToLongStr('one\r\ntwo\r\nthree\r\nfour');
    expect(L(CopyLine(s, 2, 1))).toBe('two');
    expect(BytesOf(CopyLine(CopyToLongStr('one\r\ntwo\r\nthree\r\nfour'), 2, 2))).toBe('two\r\nthree');
    expect(L(CopyLine(CopyToLongStr('one\r\ntwo'), 1, 1))).toBe('one');
    expect(L(CopyLine(CopyToLongStr('one\r\ntwo'), 5, 1))).toBe('');
  });
  it('RunWordImpl, FieldInList, RunEvalFrml', () => {
    expect(RunWordImpl(null, 7)).toBe(7);
    const z = new FrmlElem(_const);
    z.R = 3;
    expect(RunWordImpl(z, 7)).toBe(3);
    const f1 = {} as FieldDescr;
    const f2 = {} as FieldDescr;
    const fl = new FieldListEl();
    fl.FldD = f1;
    expect(FieldInList(f1, fl)).toBe(true);
    expect(FieldInList(f2, fl)).toBe(false);
    expect(RunEvalFrml(z)).toBe(z);
    expect(RunEvalFrml(null)).toBe(null);
  });
  it('RunWFrml centres zero coordinates (CenterWw); RunInt truncates; long strings', () => {
    const X = new WRectFrml();
    X.C1 = frml('0').z;
    X.R1 = frml('0').z;
    X.C2 = frml('20').z;
    X.R2 = frml('5').z;
    const W = new WRect();
    RunWFrml(X, 0, W);
    expect([W.C1, W.R1, W.C2, W.R2]).toEqual([31, 11, 50, 15]);
    X.C1 = frml('3').z;
    X.R1 = frml('2').z;
    X.C2 = frml('10').z;
    X.R2 = frml('4').z;
    RunWFrml(X, 0, W);
    expect([W.C1, W.R1, W.C2, W.R2]).toEqual([3, 2, 10, 4]);
    expect(RunInt(frml('-2.7').z)).toBe(-2);
    expect(RunInt(frml('2.7').z)).toBe(2);
    const long = frml("repeatstr('ab',200)+'c'").z;
    expect(RunLongStr(long).length).toBe(401);
    expect(RunShortStr(long).length).toBe(255);
    expect(RunLongStr(frml("repeatstr('x',70000)").z).length).toBe(70000 - 65536); // N: integer
    expect(RunLongStr(frml("repeatstr('ab',32767)").z).length).toBe(MaxLStrLen);
    expect(RunLongStr(frml("repeatstr('abc',30000)").z).length).toBe(Math.floor(MaxLStrLen / 3) * 3);
  });
});

const ord = (c: string): number => c.charCodeAt(0);

// ---------------------------------------------------------------- built-in functions

describe('RUNFRML: arithmetic (jazyk.md: speciální operátory, aritmetické funkce)', () => {
  it('operators, div, mod, round', () => {
    expect(run('1+2*3-4/8')).toBe(6.5);
    expect(run('10 div 3')).toBe(3);
    expect(run('10 mod 3')).toBe(1);
    expect(run('-7 div 2')).toBe(-3);
    expect(run('-7 mod 2')).toBe(-1);
    expect(run('pi round 2')).toBe(3.14);
    expect(run('1.6 round 0')).toBe(2);
    expect(run('2.5 round 0')).toBe(3);
    expect(run('-2.5 round 0')).toBe(-3);
    expect(run('1.005 round 2')).toBe(1.01); // RoundReal adds 0.50001
  });
  it('abs, int, frac, sqr, sqrt, exp, ln, sin/cos/arctan', () => {
    expect(run('abs(-3.5)')).toBe(3.5);
    expect(run('int(-3.7)')).toBe(-3);
    expect(run('frac(3.25)')).toBe(0.25);
    expect(run('sqr(1.5)')).toBe(2.25);
    expect(run('sqrt(16)')).toBe(4);
    expect(run('exp(0)')).toBe(1);
    expect(run('exp(100)')).toBe(0); // FAND: out of range -> 0
    expect(run('ln(exp(2))')).toBeCloseTo(2, 12);
    expect(run('sin(0)+cos(0)')).toBe(1);
    expect(run('arctan(1)*4')).toBeCloseTo(Math.PI, 12);
  });
  it('BP7 Real48 run-time errors: /0 = 200, sqrt(-1) and ln(0) = 207', () => {
    const e = (src: string): number => {
      try {
        run(src);
      } catch (x) {
        if (x instanceof FandRunError) return x.code;
        throw x;
      }
      return 0;
    };
    expect(e('1/0')).toBe(200);
    expect(e('1 div 0')).toBe(200);
    expect(e('1 mod 0')).toBe(200);
    expect(e('sqrt(-1)')).toBe(207);
    expect(e('ln(0)')).toBe(207);
  });
  it('comparisons with precision (1.234 > 1.2 but 1.234 =.1 1.2), logical operators', () => {
    expect(run('1.234 > 1.2')).toBe(true);
    expect(run('1.234 =.1 1.2')).toBe(true);
    expect(run('1.234 = 1.2')).toBe(false);
    expect(run('1 <> 2')).toBe(true);
    expect(run('2 >= 2 & 1 <= 0')).toBe(false);
    expect(run('^(1>2) | false')).toBe(true);
    expect(run('false => false')).toBe(true);
    expect(run('true => false')).toBe(false);
    expect(run('(1>2) <=> false')).toBe(true);
  });
  it('random is the BP7 generator (RandSeed*$08088405+1)', () => {
    RunFrmlVars.RandSeed = 0;
    expect(run('random')).toBe(1 / 4294967296);
    expect(RunFrmlVars.RandSeed).toBe(1);
    RunFrmlVars.RandSeed = 1;
    expect(Random()).toBe(((0x08088405 + 1) >>> 0) / 4294967296);
    for (let i = 0; i < 100; i++) {
      const r = Random();
      expect(r >= 0 && r < 1).toBe(true);
    }
  });
  it('maxcol, maxrow, memavail, exitcode, getwordvar, color', () => {
    expect(run('maxcol')).toBe(BaseVars.TxtCols);
    expect(run('maxrow')).toBe(BaseVars.TxtRows);
    expect(run('memavail')).toBeLessThanOrEqual(655360);
    BaseVars.LastExitCode = 3;
    expect(run('exitcode')).toBe(3);
    AccessVars.MenuX = 12;
    expect(run('menux')).toBe(12);
    BaseVars.Colors.userColor[2] = 0x1e;
    BaseVars.Colors.mNorm = 0x70;
    BaseVars.Colors.DesktopColor = 0x17;
    expect(run('color(2)')).toBe(0x1e);
    expect(run('color(16)')).toBe(0x70);
    expect(run('color(53)')).toBe(0x17);
    expect(run('color(99)')).toBe(0x17);
  });
});

describe('RUNFRML: text functions (jazyk.md: textové funkce)', () => {
  it('length, char, ord, copy, repeatstr, concatenation', () => {
    expect(run("length('abc')")).toBe(3);
    expect(run('char(65)')).toBe('A');
    expect(run('char(321)')).toBe('A'); // modulo 256
    expect(run("ord('Jan')")).toBe(74);
    expect(run("ord('')")).toBe(0);
    expect(run("copy('Jan Novák',5,5)")).toBe('Novák');
    expect(run("copy('abc',0,2)")).toBe('ab');
    expect(run("copy('abc',3,10)")).toBe('c');
    expect(run("copy('abc',4,1)")).toBe('');
    expect(run("copy('abc',-1,1)")).toBe('');
    expect(run("repeatstr('ab',3)")).toBe('ababab');
    expect(run("repeatstr('ab',0)")).toBe('');
    expect(run("'a'+'b'+char(67)")).toBe('abC');
  });
  it('leadchar/trailchar (remove or replace)', () => {
    expect(run("leadchar('x',trailchar('x','xxxAAAAxx'))")).toBe('AAAA');
    expect(run("leadchar('x','xxab','y')")).toBe('yyab');
    expect(run("trailchar(' ','ab  ','.')")).toBe('ab..');
  });
  it('str with width/decimals and with a mask (help examples)', () => {
    expect(run('str(625.128,5,2)')).toBe('625.13');
    expect(run('str(625.128,1,0)')).toBe('625');
    expect(run('str(625,6,0)')).toBe('   625');
    expect(run('str(1.5,-1,-1)')).toBe(' 1.5000000000E+00');
    expect(run("str(1234.25,'__.___,__')")).toBe(' 1.234,25');
    expect(run("str(1234,'000.000')")).toBe('001.234');
    expect(run("str(-5,'___')")).toBe(' -5');
    expect(run("str(0,'__,__')")).toBe('     '); // zero: blanks only
    expect(run("str(0.5,'__,__')")).toBe(' 0,50');
    expect(run("str(123456,'___')")).toBe('123456'); // overflow: digits joined at the left
  });
  it('val, upcase, lowcase, nodiakr (FAND.CFG tables)', () => {
    expect(run("val(' 12.5 ')")).toBe(12.5);
    expect(run("val('1e3')")).toBe(1000);
    expect(run("val('x')")).toBe(0);
    expect(run("upcase('abc xyz')")).toBe('ABC XYZ');
    expect(run("lowcase('ABC XYZ')")).toBe('abc xyz');
    if (haveApp) {
      expect(run("upcase('Příliš žluťoučký kůň')")).toBe('PŘÍLIŠ ŽLUŤOUČKÝ KŮŇ');
      expect(run("lowcase('PŘÍLIŠ ŽLUŤOUČKÝ KŮŇ')")).toBe('příliš žluťoučký kůň');
    }
    expect(run("nodiakr('Příliš žluťoučký kůň')")).toBe('Prilis zlutoucky kun');
  });
  it('linecnt, copyline', () => {
    expect(run("linecnt('a'+char(13)+char(10)+'b'+char(13)+char(10)+'c')")).toBe(3);
    expect(run("linecnt('')")).toBe(0);
    expect(run("copyline('a'+char(13)+char(10)+'b'+char(13)+char(10)+'c',2)")).toBe('b');
  });
  it('pos, replace (help examples; FindText is EDITOR)', () => {
    expect(run("pos('lhota','Dolní Lhota')")).toBe(0);
    expect(run("pos('lhota','Dolní Lhota','u')")).toBe(7);
    expect(run("pos('lh','Dolní Lhota','u',2)")).toBe(0);
    expect(run("pos('an','banana')")).toBe(2);
    expect(run("pos('an','banana','',2)")).toBe(4);
    expect(run("replace('a','banana','o')")).toBe('bonono');
    expect(run("replace('an','banana','')")).toBe('ba');
    expect(run("replace('x','banana','yy')")).toBe('banana');
  });
  it('equmask (help examples)', () => {
    expect(run("equmask('Dolní Lhota','Lhota')")).toBe(false);
    expect(run("equmask('Dolní Lhota','*Lhota')")).toBe(true);
    expect(run("equmask('Dolní Lhota','?Lhota')")).toBe(false);
    expect(run("equmask('Dolní Lhota','??????Lhota')")).toBe(true);
  });
  it('string comparisons: binary, and lexical with ~ (Czech collation, trailing blanks ignored)', () => {
    expect(run("'Praha' <> 'Praha '")).toBe(true);
    expect(run("'a' < 'b'")).toBe(true);
    expect(run("'abc' > 'ab'")).toBe(true);
    if (haveApp) {
      expect(run("'Praha' =~ 'PRAHA   '")).toBe(true);
      expect(run("'baba' =~ 'bÁBa'")).toBe(true);
      expect(run("'chata' >~ 'hrad'")).toBe(true); // ch sorts after h
      expect(run("'chata' > 'hrad'")).toBe(false);
      expect(run("'čas' <~ 'dům'")).toBe(true);
    }
  });
  it('in: real and string constant lists with intervals (help examples)', () => {
    expect(run("'350' in ['300'..'399','520','800'..'999']")).toBe(true);
    expect(run("'520' in ['300'..'399','520','800'..'999']")).toBe(true);
    expect(run("'400' in ['300'..'399','520','800'..'999']")).toBe(false);
    expect(run("'999' in ['300'..'399','520','800'..'999']")).toBe(true);
    for (const [y, r] of [[1916, true], [1950, false], [1968, true], [1989, true], [1990, false]] as const) {
      expect(run(`${y} in [1914..1918,1939..1945,1968,1989]`)).toBe(r);
    }
    expect(run('1.0000001 in [1]')).toBe(true); // precision 5 decimals
    expect(run('1.0000001 in.10 [1]')).toBe(false);
    if (haveApp) expect(run("'praha  ' in~ ['PRAHA','Brno']")).toBe(true);
    expect(run("'praha' in ['PRAHA','Brno']")).toBe(false);
  });
  it('modulo: (n - sum(ci*wi) mod n) mod 10 = check digit', () => {
    expect(run("modulo('1231',11,3,2,1)")).toBe(true);
    expect(run("modulo('1234',11,3,2,1)")).toBe(false);
    expect(run("modulo('123',11,3,2,1)")).toBe(false); // wrong length
  });
  it('cond, getenv, version, username/accright, trust', () => {
    expect(run("cond(1>2:'a',2>1:'b',else:'c')")).toBe('b');
    expect(run("cond(1>2:'a',2>3:'b',else:'c')")).toBe('c');
    expect(run("cond(1>2:'a')")).toBe('');
    expect(run('cond(1>2 :1,else:2)+1')).toBe(3); // '2:1' would be a time constant
    expect(run("getenv('')")).toBe('FAND');
    expect(run('version')).toBe('4.20');
    AccessVars.UserName = B('Novák');
    expect(run('username')).toBe('Novák');
    AccessVars.UserCode = 0;
    expect(run('trust(5)')).toBe(true);
    AccessVars.UserCode = 7;
    AccessVars.AccRight = '\x07';
    expect(run('trust(5,7)')).toBe(true);
    expect(run('trust(5,8..10)')).toBe(false);
    AccessVars.UserCode = 0;
  });
});

describe('RUNFRML: dates (jazyk.md: funkce pro datum a čas)', () => {
  const d = (y: number, m: number, dd: number): number => RDate(y, m, dd, 0, 0, 0, 0);
  it('strdate/valdate/today/currtime/addmonth/difmonth', () => {
    expect(run("strdate(valdate('24.12.2025','DD.MM.YYYY'),'DD.MM.YYYY')")).toBe('24.12.2025');
    expect(run("valdate('24.12.2025','DD.MM.YYYY')")).toBe(d(2025, 12, 24));
    expect(run("strdate(addmonth(valdate('31.01.2024','DD.MM.YYYY'),1),'DD.MM.YYYY')")).toBe('29.02.2024');
    expect(run("difmonth(valdate('15.01.2024','DD.MM.YYYY'),valdate('15.04.2024','DD.MM.YYYY'))")).toBe(3);
    const now = new Date(2025, 5, 7, 13, 30, 0);
    const c0 = Clock.now;
    Clock.now = () => now;
    try {
      expect(run('today')).toBe(d(2025, 6, 7));
      expect(run("strdate(today+currtime,'DD.MM.YYYY hh:mm')")).toBe('07.06.2025 13:30');
    } finally {
      Clock.now = c0;
    }
  });
  it('typeday: weekends; holidays from the FAND.CFG table (BP7)', () => {
    expect(run(`typeday(${d(2025, 6, 7)})`)).toBe(1); // Saturday
    expect(run(`typeday(${d(2025, 6, 8)})`)).toBe(2); // Sunday
    expect(run(`typeday(${d(2025, 6, 9)})`)).toBe(0);
    if (haveApp && BaseVars.NWDaysTab > 0) {
      // any day of the installed table must report its own type
      const it1 = BaseVars.WDaysTab[1];
      expect(run(`typeday(${BaseVars.WDaysFirst + it1.Nr})`)).toBe(it1.Typ);
    }
  });
  it('addwdays/difwdays over weekends', () => {
    // Friday 6.6.2025 + 1 working day = Monday 9.6.2025 (no holiday there)
    const saved = [BaseVars.NWDaysTab, BaseVars.WDaysFirst, BaseVars.WDaysLast];
    BaseVars.NWDaysTab = 0;
    BaseVars.WDaysFirst = 0;
    BaseVars.WDaysLast = 0;
    try {
      expect(run(`addwdays(${d(2025, 6, 6)},1)`)).toBe(d(2025, 6, 9));
      expect(run(`addwdays(${d(2025, 6, 9)},-1)`)).toBe(d(2025, 6, 6));
      expect(run(`addwdays(${d(2025, 6, 6)},2,2)`)).toBe(d(2025, 6, 15)); // 2 Sundays
      expect(run(`difwdays(${d(2025, 6, 6)},${d(2025, 6, 13)})`)).toBe(5);
      expect(run(`difwdays(${d(2025, 6, 13)},${d(2025, 6, 6)})`)).toBe(-5);
      expect(run(`difwdays(${d(2025, 6, 6)},${d(2025, 6, 13)},1)`)).toBe(1);
    } finally {
      [BaseVars.NWDaysTab, BaseVars.WDaysFirst, BaseVars.WDaysLast] = saved;
    }
  });
});

// ---------------------------------------------------------------- local variables, user functions

describe('RUNFRML/RUNPROC: local variables and user FUNCTIONs', () => {
  /** A frame with an 'R', 'S' and 'B' local (BPOfs 8, 14, 18). */
  function frame(): { r: LocVar; s: LocVar; b: LocVar } {
    const mk = (n: string, t: string, o: number): LocVar => {
      const lv = new LocVar();
      lv.Name = n;
      lv.FTyp = t;
      lv.Op = _getlocvar;
      lv.BPOfs = o;
      return lv;
    };
    const r = mk('r', 'R', 8);
    const s = mk('s', 'S', 14);
    const b = mk('b', 'B', 18);
    r.Chain = s;
    s.Chain = b;
    const ps = new ProcStkD();
    ps.LVRoot = r;
    ps.V[8] = 0;
    ps.V[14] = 0;
    ps.V[18] = false;
    SetMyBP(ps);
    return { r, s, b };
  }
  const gl = (lv: LocVar): FrmlElem => {
    const z = new FrmlElem(_getlocvar);
    z.BPOfs = lv.BPOfs;
    return z;
  };
  it('LVAssignFrml / _getlocvar for R, S (TWork), B', () => {
    const { r, s, b } = frame();
    LVAssignFrml(r, BaseVars.MyBP, false, frml('2*21').z);
    LVAssignFrml(r, BaseVars.MyBP, true, frml('0.5').z);
    expect(RunReal(gl(r))).toBe(42.5);
    LVAssignFrml(s, BaseVars.MyBP, false, frml("'Žluťoučký'").z);
    const pos1 = BaseVars.MyBP!.V[14];
    expect(U(RunShortStr(gl(s)))).toBe('Žluťoučký');
    LVAssignFrml(s, BaseVars.MyBP, false, frml("'kůň'").z);
    expect(U(RunShortStr(gl(s)))).toBe('kůň');
    expect(pos1).not.toBe(0);
    LVAssignFrml(b, BaseVars.MyBP, false, frml('1<2').z);
    expect(RunBool(gl(b))).toBe(true);
  });
  it('FUNCTION declarations (D chapter) run through RunUserFunc/RunProcedure', () => {
    const R = new RdbD();
    R.FD = new FileD();
    AccessVars.CRdb = R;
    AccessVars.FuncDRoot = null;
    R.OldFCRoot = null;
    const S = ref(B(
      'FUNCTION fact(n:real):real; var i:real; begin fact:=1; i:=2; ' +
        'while i<=n do begin fact:=fact*i; i:=i+1 end; end; ' +
        "FUNCTION twice(s:string):string; begin twice:=s+s; end; " +
        'FUNCTION odd(n:real):boolean; begin if n mod 2=1 then odd:=true else odd:=false; end; ' +
        'FUNCTION fib(n:real):real; begin if n<2 then fib:=n else fib:=fib(n-1)+fib(n-2); end;',
    ));
    SetInpStr(S);
    ok(() => ReadDeclChpt());
    expect(run('fact(5)')).toBe(120);
    expect(run('fact(10)/fact(8)')).toBe(90);
    expect(run("twice('ab')+'|'+twice(twice('x'))")).toBe('abab|xxxx');
    expect(run('odd(3) & ^odd(4)')).toBe(true);
    expect(run('fib(15)')).toBe(610);
    expect(BaseVars.MyBP).toBe(null);
    AccessVars.FuncDRoot = null;
    AccessVars.CRdb = null;
  });
  it('EVALS/EVALR/EVALB compile a string at run time (procedure context)', () => {
    const { r, s } = frame();
    BaseVars.ProcMyBP = BaseVars.MyBP;
    BaseVars.MyBP!.V[r.BPOfs] = 4;
    void s;
    const mk = (typ: string, src: string): FrmlElem => {
      const z = new FrmlElem(_eval);
      z.EvalTyp = typ;
      const c = new FrmlElem(_const);
      c.S = B(src);
      z.P1 = c;
      return z;
    };
    expect(RunReal(mk('R', '6*7'))).toBe(42);
    expect(BaseVars.LastExitCode).toBe(0);
    expect(U(RunShortStr(mk('S', "copy('abcdef',2,3)")))).toBe('bcd');
    expect(RunBool(mk('B', '1>2'))).toBe(false);
    expect(RunReal(mk('R', "'x'"))).toBe(0); // wrong type: nil formula
    expect(BaseVars.LastExitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------- Účto D chapters

const SRC = join(ROOT, 'work/source');
describe.skipIf(!existsSync(join(SRC, 'MODUL05_PRO/0174_D_noname.txt')))('Účto FUNCTIONs (decoded D chapters)', () => {
  function loadD(rel: string): void {
    const R = new RdbD();
    R.FD = new FileD();
    AccessVars.CRdb = R;
    R.OldFCRoot = AccessVars.FuncDRoot;
    SetInpStr(ref(B(readFileSync(join(SRC, rel), 'utf8'))));
    ok(() => ReadDeclChpt());
  }
  beforeAll(() => {
    AccessVars.FuncDRoot = null;
    resetCompiler();
    loadD('MODUL05_PRO/0174_D_noname.txt');
    loadD('MODUL99_PRO/0136_D_noname.txt');
  });
  const d = (y: number, m: number, dd: number): number => RDate(y, m, dd, 0, 0, 0, 0);
  it('MODUL05: Orez2M, PovolZn (for/exit in a function), Odst6 (case, difmonth, valdate)', () => {
    expect(run('Orez2M(12.349)')).toBe(12.34);
    expect(run("PovolZn('12 3','0123456789')")).toBe(true);
    expect(run("PovolZn('12a','0123456789')")).toBe(false);
    const odst6 = (reg: number, rok: number, r23: boolean): number =>
      run(`Odst6(${reg},1000,${r23},${rok},0,0,0,0,0,'','','','')`) as number;
    expect(odst6(d(2020, 1, 1), d(2007, 6, 1), true)).toBe(0); // before 2008: exit
    expect(odst6(d(2020, 1, 1), d(2021, 1, 1), true)).toBe(520); // 12 months under 36: 52 %
    // 6 months at 52 % and 6 at 60 %: Orez2M(1000/12*0.60) is 49.99 in double arithmetic (the FPC
    // reference too); BP7 Real48 rounds 1000/12 up and gets 50.00 (559.98). Known deviation (PORTING 13).
    expect(odst6(d(2017, 7, 1), d(2020, 1, 1), true)).toBeCloseTo(43.33 * 6 + 49.99 * 6, 10);
    expect(odst6(d(2017, 7, 1), d(2020, 1, 1), false)).toBe(0); // no month counted
  });
  it('MODUL99: KalkRes/KalkErr (EVALR in a FUNCTION, exitcode, txtpos)', () => {
    expect(run("KalkRes('2*3+1')")).toBe(7);
    expect(run("KalkErr('2*3+1')")).toBe(0);
    expect(run("KalkErr('2*(3+')")).toBeGreaterThan(0);
    expect(BaseVars.LastExitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------- procedures

describe('RUNPROC: RunInstr, CallProcedure', () => {
  /** A PROC instruction for a procedure given by its source text (Pos.IRec=0: string formula). */
  function procInstr(src: string, args: TypAndFrml[] = []) {
    const PD = GetPInstr(_proc, 8)!;
    const RP = new RdbPos();
    RP.IRec = 0;
    const c = new FrmlElem(_const);
    c.S = B(src);
    RP.Frml = c;
    PD.Pos = RP;
    PD.N = args.length;
    PD.TArg = [new TypAndFrml(), ...args];
    return PD;
  }
  function callerFrame(n: number): ProcStkD {
    const ps = new ProcStkD();
    for (let i = 0; i < n; i++) ps.V[8 + 6 * i] = 0;
    SetMyBP(ps);
    BaseVars.ProcMyBP = ps;
    return ps;
  }
  function locArg(typ: string, bpofs: number, ret: boolean): TypAndFrml {
    const t = new TypAndFrml();
    t.FTyp = typ;
    const z = new FrmlElem(_getlocvar);
    z.BPOfs = bpofs;
    t.Frml = z;
    t.IsRetPar = ret;
    return t;
  }
  function constArg(r: number): TypAndFrml {
    const t = new TypAndFrml();
    t.FTyp = 'R';
    const z = new FrmlElem(_const);
    z.R = r;
    t.Frml = z;
    return t;
  }
  beforeEach(() => {
    const R = new RdbD();
    const chpt = new FileD();
    chpt.Typ = '0';
    chpt.Name = 'TEST';
    R.FD = chpt;
    R.RdbDir = H(TMP);
    R.DataDir = H(TMP);
    AccessVars.CRdb = R;
    AccessVars.FileDRoot = chpt;
    AccessVars.TopRdbDir = H(TMP);
    AccessVars.TopDataDir = '';
    AccessVars.LinkDRoot = null;
    AccessVars.FuncDRoot = null;
  });
  it('parameters, var parameters, loops, if, break/exit, repeat, for, case', () => {
    const caller = callerFrame(3);
    const PD = procInstr(
      '(n:real; var f:real; var s:string; var ok:boolean) var i:real; ' +
        'begin f:=1; i:=1; while true do begin if i>n then break; f:=f*i; i:=i+1 end; ' +
        "s:=''; repeat s:=s+'x'; i:=i-1 until i<=3; " +
        "for i:=1 to 3 do s:=s+str(i,1,0); " +
        "case n=4: s:=s+'four'; n=5: s:=s+'five'; else s:=s+'?' end; " +
        'ok:=true; exit; ok:=false; end;',
      [constArg(5), locArg('R', 8, true), locArg('S', 14, true), locArg('B', 18, true)],
    );
    caller.V[14] = 0;
    caller.V[18] = false;
    ok(() => CallProcedure(PD));
    expect(BaseVars.MyBP).toBe(caller);
    expect(caller.V[8]).toBe(120);
    expect(U(BytesOf(AccessVars.TWork.Read(1, caller.V[14] as number)))).toBe('xxx123five');
    expect(caller.V[18]).toBe(true);
    expect(BaseVars.ExitP).toBe(false);
  });
  it('parameter mismatch is compile error 119', () => {
    callerFrame(1);
    const PD = procInstr('(n:real) begin end;', []);
    expect(() => ok(() => CallProcedure(PD))).toThrow(/GoExit/);
  });
  it('write/writeln/clrscr/gotoxy on the screen', () => {
    callerFrame(0);
    BaseVars.ProcAttr = 0x07;
    DriversVars.TextAttr = 0x07;
    DriversVars.FandBatch = false;
    const PD = procInstr("begin clrscr; gotoxy(3,2); write('A=',(1+1):3:1,' ',true); writeln(''); write('Č'); end;");
    try {
      ok(() => CallProcedure(PD));
    } finally {
      DriversVars.FandBatch = true;
    }
    expect(U(ScrRowStr(1)).slice(2, 12)).toBe('A=2.0 ' + BaseVars.AbbrYes + '   ');
    expect(U(ScrRowStr(2)).slice(0, 1)).toBe('Č');
  });
  it('EXEC dispatches to the FANDDOS helper registry (exitcode); CANCEL is GoExit', () => {
    const ps = callerFrame(1);
    const seen: string[][] = [];
    registerHelper('MYHELP', (Nm, Ext, Dir, Av, nAv, ExitCode) => {
      seen.push(Av.slice(1, nAv + 1));
      ExitCode.v = 3;
      return true;
    });
    try {
      const PD = procInstr("(var e:real) begin exec('MYHELP.EXE','alfa beta'); e:=exitcode; end;", [
        locArg('R', 8, true),
      ]);
      ok(() => CallProcedure(PD));
      expect(ps.V[8]).toBe(3);
      expect(seen.length).toBe(1);
      expect(seen[0].join(' ')).toContain('alfa');
    } finally {
      registerHelper('MYHELP', null);
    }
    const PD2 = procInstr('begin cancel; end;');
    callerFrame(0);
    expect(() => ok(() => CallProcedure(PD2))).toThrow(/GoExit/);
  });
  it('RunProcedure keeps the caller ExitP/BreakP; RunInstr stops on ExitP', () => {
    BaseVars.BreakP = true;
    RunProcedure(null);
    expect(BaseVars.BreakP).toBe(true);
    BaseVars.BreakP = false;
    const ps = new ProcStkD();
    const lv = new LocVar();
    lv.FTyp = 'R';
    lv.BPOfs = 8;
    ps.V[8] = 0;
    SetMyBP(ps);
    const i1 = GetPInstr(_asgnloc, 9)!;
    i1.AssLV = lv;
    i1.Frml = frml('1').z;
    i1.Add = true;
    const i2 = GetPInstr(_asgnloc, 9)!;
    i2.AssLV = lv;
    i2.Frml = frml('10').z;
    i2.Add = true;
    i1.Chain = i2;
    RunInstr(i1);
    expect(ps.V[8]).toBe(11);
    BaseVars.ExitP = true;
    RunInstr(i1);
    expect(ps.V[8]).toBe(11);
    BaseVars.ExitP = false;
  });
});

// ---------------------------------------------------------------- data files

describe('RUNPROC/RUNFRML: records, forall, recno, owned on real .000/.X files', () => {
  let adr: FileD;
  let fak: FileD;
  function compileFD(name: string, typ: string, src: string): FileD {
    SetInpStr(ref(B(src)));
    ok(() => RdFileD(B(name), typ, ''));
    return AccessVars.CFile!;
  }
  function fld(fd: FileD, name: string): FieldDescr {
    for (let f = fd.FldD; f !== null; f = f.Chain) if (U(f.Name) === name) return f;
    throw new Error(`no field ${name}`);
  }
  function callerFrame(n: number): ProcStkD {
    const ps = new ProcStkD();
    for (let i = 0; i < n; i++) ps.V[8 + 6 * i] = 0;
    SetMyBP(ps);
    BaseVars.ProcMyBP = ps;
    return ps;
  }
  function proc(src: string, rets: number): number[] {
    const caller = callerFrame(rets);
    const PD = GetPInstr(_proc, 8)!;
    const RP = new RdbPos();
    const c = new FrmlElem(_const);
    c.S = B(src);
    RP.Frml = c;
    PD.Pos = RP;
    PD.N = rets;
    PD.TArg = [new TypAndFrml()];
    for (let i = 0; i < rets; i++) {
      const t = new TypAndFrml();
      t.FTyp = 'R';
      const z = new FrmlElem(_getlocvar);
      z.BPOfs = 8 + 6 * i;
      t.Frml = z;
      t.IsRetPar = true;
      PD.TArg.push(t);
    }
    ok(() => CallProcedure(PD));
    return Array.from({ length: rets }, (_, i) => caller.V[8 + 6 * i] as number);
  }
  beforeAll(() => {
    const dir = join(TMP, 'data');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const R = new RdbD();
    const chpt = new FileD();
    chpt.Typ = '0';
    chpt.Name = 'TEST';
    R.FD = chpt;
    R.RdbDir = H(dir);
    R.DataDir = H(dir);
    AccessVars.CRdb = R;
    AccessVars.FileDRoot = chpt;
    AccessVars.TopRdbDir = H(dir);
    AccessVars.TopDataDir = '';
    AccessVars.LinkDRoot = null;
    AccessVars.FuncDRoot = null;
    AccessVars.CatFD = null;
    resetCompiler();
    adr = compileFD('ADR', 'X', 'Cislo:A,5; Nazev:A,30; Suma:F,10.2; Pozn:T; #K @ Cislo; ADR_Jm(@) ~Nazev;');
    fak = compileFD('FAK', 'X', 'Cislo:A,5; Adr:A,5; Castka:F,8.2; #K @ Cislo; FAK_Adr(@) *Adr; ADR Adr;');
    expect(fld(adr, 'Suma').FrmlTyp).toBe('R');
  });
  it('writerec(r,0) appends; readrec; forall with a record variable; forall i in FILE (cond)', () => {
    const [n] = proc(
      "(var n:real) var r:record of ADR; f:record of FAK; i,j:real; begin i:=1; while i<=5 do begin " +
        "readrec(r,0); r.Cislo:=str(i,1,0); r.Nazev:=copy('EDCBA',i,1)+'-firma'; r.Suma:=i*100; " +
        "r.Pozn:='poznámka '+str(i,1,0); writerec(r,0); " +
        'j:=1; while j<=i do begin readrec(f,0); f.Cislo:=str(10*i+j,2,0); f.Adr:=str(i,1,0); ' +
        'f.Castka:=j; writerec(f,0); j:=j+1 end; ' +
        'i:=i+1 end; n:=ADR.nrecs; end;',
      1,
    );
    expect(n).toBe(5);
    expect(adr.NRecs).toBe(5);
    expect(fak.NRecs).toBe(15);
    const [s, c, big, t] = proc(
      '(var s:real; var c:real; var big:real; var t:real) var r:record of ADR; i:real; begin ' +
        's:=0; c:=0; forall r do begin s:=s+r.Suma; c:=c+1 end; ' +
        'big:=0; forall i in ADR (Suma>250) do big:=big+1; ' +
        "readrec(r,3); if r.Pozn='poznámka 3' then t:=r.Suma else t:=-1; end;",
      4,
    );
    expect([s, c, big, t]).toEqual([1500, 5, 3, 300]);
  });
  it('forall over a key (/@ and an alternative key) and with break', () => {
    const [first, last, cnt] = proc(
      '(var first:real; var last:real; var cnt:real) var r:record of ADR; begin cnt:=0; first:=0; ' +
        'forall r/Jm do begin if first=0 then first:=r.Suma; last:=r.Suma; cnt:=cnt+1 end; ' +
        'forall r/@ do begin cnt:=cnt+1; if r.Suma>=200 then break end; end;',
      3,
    );
    expect([first, last, cnt]).toEqual([500, 100, 7]); // Jm: A-firma (500) .. E-firma (100)
  });
  it('recno/keyof, owner forall, writerec update, deleterec', () => {
    const [rn, n4, sumOwn, upd, left] = proc(
      '(var rn:real; var n4:real; var sumOwn:real; var upd:real; var left:real) ' +
        'var r:record of ADR; f:record of FAK; i:real; begin ' +
        "rn:=recno(ADR,'3'); readrec(r,rn); n4:=0; " +
        'forall f owner r do n4:=n4+1; ' +
        'sumOwn:=0; forall i in FAK owner ADR[2] do sumOwn:=sumOwn+FAK[i].Castka; ' +
        'r.Suma:=r.Suma+1; writerec(r,rn); readrec(r,0); readrec(r,rn); upd:=r.Suma; ' +
        'deleterec(ADR,5); left:=ADR.nrecs; end;',
      5,
    );
    expect([rn, n4, sumOwn, upd, left]).toEqual([3, 3, 3, 301, 4]);
  });
  it('FILE[i].field :=, appendrec/recallrec/isdeleted, readrec by key, r2:=r, linkrec, with shared', () => {
    const [a1, a2, a3, a4, a5] = proc(
      '(var a1:real; var a2:real; var a3:real; var a4:real; var a5:real) ' +
        'var r,r2:record of ADR; f:record of FAK; i:real; begin ' +
        'ADR[1].Suma:=111; a1:=ADR[1].Suma; ' +
        'appendrec(ADR); i:=ADR.nrecs; if isdeleted(ADR,6) then begin recallrec(ADR,6); ' +
        'if isdeleted(ADR,6) then a2:=-1 else a2:=ADR.nrecs-i end; ' +
        "readrec(r,0); r.Cislo:='1'; readrec(r,keyof(r)); r2:=r; a3:=r2.Suma; " +
        'readrec(f,1); readrec(r2,0); linkrec(f,r2); a4:=1000*exitcode+r2.Suma; ' +
        'with shared ADR(RD) do a5:=ADR.nrecsabs; end;',
      5,
    );
    expect([a1, a2, a3, a4, a5]).toEqual([111, 1, 111, 111, 6]);
  });
  it('puttxt / gettxt / filesize; clipbd, accright and usercode assignments', () => {
    const path = join(TMP, 'put.txt');
    const [len, sz, same, uc] = proc(
      '(var len:real; var sz:real; var same:real; var uc:real) var s:string; begin ' +
        `puttxt('${path}','Žluťoučký'+char(13)+char(10)); puttxt('${path}','kůň',append); ` +
        `s:=gettxt('${path}'); len:=length(s); sz:=filesize('${path}'); ` +
        "clipbd:='schránka'; if clipbd='schránka' then same:=1 else same:=0; " +
        'usercode:=65; uc:=usercode+ord(accright); end;',
      4,
    );
    expect(readFileSync(path)).toEqual(Buffer.from(B('Žluťoučký\r\nkůň'), 'latin1'));
    expect([len, sz, same, uc]).toEqual([14, 14, 1, 130]);
    AccessVars.UserCode = 0;
  });
  it('Owned (count and sum) and GetFromKey from the Pascal API', () => {
    const a = AccessVars;
    let ld: LinkD | null = null;
    for (let l = a.LinkDRoot; l !== null; l = l.Chain) if (l.FromFD === fak && l.ToFD === adr) ld = l;
    expect(ld).not.toBe(null);
    expect(GetFromKey(ld)!.IndexRoot).toBe(ld!.IndexRoot);
    a.CFile = adr;
    a.CRecPtr = GetRecSpace();
    S_(fld(adr, 'Cislo'), '4');
    expect(Owned(null, null, ld)).toBe(4);
    a.CFile = adr;
    const sum = new FrmlElem('\x11'); // _field
    sum.Field = fld(fak, 'Castka');
    expect(Owned(null, sum, ld)).toBe(10);
    expect(a.CFile).toBe(adr);
  });
  it('ResetCatalog closes the files of the open RDBs', () => {
    AccessVars.CFile = adr;
    AccessVars.CRecPtr = GetRecSpace();
    expect(adr.Handle).not.toBe(0xff);
    ResetCatalog();
    expect(adr.Handle).toBe(0xff);
    expect(fak.Handle).toBe(0xff);
    expect(adr.CatIRec).toBe(0);
    expect(AccessVars.CFile).toBe(adr);
  });
  it('AssgnFrml and DecodeField/DecodeFieldRSB', () => {
    const a = AccessVars;
    a.CFile = adr;
    a.CRecPtr = GetRecSpace();
    AssgnFrml(fld(adr, 'Nazev'), frml("'Novák'").z, false, false);
    AssgnFrml(fld(adr, 'Suma'), frml('12.345').z, false, false);
    AssgnFrml(fld(adr, 'Suma'), frml('1').z, false, true);
    expect(U(_ShortS(fld(adr, 'Nazev'))).trimEnd()).toBe('Novák');
    expect(_R(fld(adr, 'Suma'))).toBeCloseTo(13.35, 10);
    const t = ref('');
    DecodeField(fld(adr, 'Suma'), 20, t);
    expect(t.v).toBe('         13.35'); // F,10.2: L=14
    DecodeField(fld(adr, 'Nazev'), 8, t);
    expect(U(t.v)).toBe('Novák   ');
    DecodeField(fld(adr, 'Pozn'), 8, t);
    expect(t.v).toBe('.');
    const F = fld(adr, 'Suma');
    DecodeFieldRSB(F, 20, 1e12, '', false, t);
    expect(t.v).toBe('1000000000000>'); // wider than L: cut, '>'
    DecodeFieldRSB(F, 4, 12.5, '', false, t);
    expect(t.v).toBe('2.50');
    R_(F, 0);
    expect(CanCopyT(null, frml("'x'").z)).toBe(false);
  });
});

/** TS: a LongStr as a byte string. */
function BytesOf(s: Uint8Array): string {
  return String.fromCharCode(...s);
}
