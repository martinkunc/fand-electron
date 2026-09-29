// lexer-frml package: COMPILE.PAS with its includes LEXANAL/RDMIX/RDFRML/RDFRML1 and RDFILDCL.PAS.
// Lexer and formula compiler on small inputs, file declarations compiled from strings, and every
// F chapter (plus the D chapters, once RDPROC.ReadDeclChpt is ported) of all Účto projects,
// compiled in chapter order the way PROJMGR.CompileRdb does it.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { existsSync, readdirSync, mkdirSync, cpSync, rmSync, appendFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

// Routines of other packages that this package calls but that may still be stubs: fall back to a
// minimal version only while the real one throws NotImplementedError.
vi.mock('../src/engine/pas/runfrml.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/engine/pas/runfrml.ts')>();
  const { NotImplementedError } = await import('../src/engine/pas/pasrt.ts');
  const fb =
    <A extends unknown[], R>(f: (...a: A) => R, g: (...a: A) => R) =>
    (...a: A): R => {
      try {
        return f(...a);
      } catch (e) {
        if (e instanceof NotImplementedError) return g(...a);
        throw e;
      }
    };
  return {
    ...m,
    TrailChar: fb(m.TrailChar, (C: string, S: string) => {
      let n = S.length;
      while (n > 0 && S[n - 1] === C) n--;
      return S.slice(0, n);
    }),
    FieldInList: fb(m.FieldInList, (F, FL) => {
      for (let l = FL; l !== null; l = l.Chain) if (l.FldD === F) return true;
      return false;
    }),
  };
});
vi.mock('../src/engine/pas/projmgr1.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/engine/pas/projmgr1.ts')>();
  const { NotImplementedError } = await import('../src/engine/pas/pasrt.ts');
  const { SEquUpcase } = await import('../src/engine/pas/base.ts');
  return {
    ...m,
    ExtToTyp: (Ext: string): string => {
      try {
        return m.ExtToTyp(Ext);
      } catch (e) {
        if (!(e instanceof NotImplementedError)) throw e;
        if (Ext === '' || SEquUpcase(Ext, '.HLP')) return '6';
        if (SEquUpcase(Ext, '.X')) return 'X';
        if (SEquUpcase(Ext, '.DTA')) return '8';
        if (SEquUpcase(Ext, '.DBF')) return 'D';
        if (SEquUpcase(Ext, '.RDB')) return '0';
        return '?';
      }
    },
  };
});

import { ref, getWord, NotImplementedError, GoExitSignal, FromUnicode, BytesToStr } from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, OpenH, ReadH, PosH, _isoldfile, RdOnly, NewExit, RestoreExit, ExitRecord, RdMsg, ValDate, FormatCache,
  type TMsgIdxItem,
} from '../src/engine/pas/base.ts';
import { SetDriversCrt } from '../src/engine/pas/drivers.ts';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { encode852, decode852 } from '../src/engine/console/cp852.ts';
import {
  AccessVars, FileD, RdbD, RdbPos, FuncD, LocVar, LocVarBlkD, SumElem, ResetCompilePars, GetRecSpace, ReadRec,
  RdPrefixes, _ShortS, _T,
  _identifier, _number, _quotedstr, _assign, _addass, _le, _ne, _lequ, _limpl, _ge, _subrange, _lt, _equ, _gt,
  _const, _plus, _minus, _times, _divide, _div, _mod, _round, _concat, _unminus, _lneg, _and, _or, _compreal,
  _compstr, _inreal, _instr, _cond, _modulo, _strdate, _valdate, _pos, _replace, _leadchar, _trailchar, _copy,
  _str, _getwordvar, _today, _upcase, _char, _length, _addwdays, _userfunc, _field, _access, _owned, _trust,
  _getlocvar, _equmask, _copyline,
  type FrmlPtr, type FrmlElem, type FileDPtr,
} from '../src/engine/pas/access.ts';
import {
  CompileVars, SetInpStr, SetInpLongStr, RdLex, ReadChar, SkipBlank, Accept, RdInteger, RdRealConst, EquUpcase,
  IsKeyWord, TestKeyWord, IsOpt, IsDigitOpt, RdStrConst, Rd1Char, RdQuotedChar, IsIdentifStr, IsForwPoint,
  RdFrml, RdBool, RdRealFrml, RdStrFrml, RdKeyInBool, RdLocDcl, FindLocVar, EditModeToFlags, CompileRecLen,
  RdViewKey, IsKeyArg, RdKFList, SaveCompState, RestoreCompState, GetRprtOpt, GetEditOpt, FldTypIdentity,
  AllFldsList, RdAssignFrml, RdFrame, FrmlContxt, RdFldNameFrmlF, TestKeyWord as TKW, SetInpTTPos,
} from '../src/engine/pas/compile.ts';
import { RdFileD, RdByteList, RdUserView, RdChkDsFromPos } from '../src/engine/pas/rdfildcl.ts';
import { ReadDeclChpt } from '../src/engine/pas/rdproc.ts';
import { RdRunVars, ResetLVBD } from '../src/engine/pas/rdrun.ts';
import { Rdb } from '../src/engine/fand/rdb.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const WORK = join(ROOT, 'work/tmp-lexer-frml');
const haveApp = existsSync(join(APP, 'UCTO2026.RDB')) && existsSync(join(APP, 'FAND.RES'));

/** Byte string of a Unicode text (CP852) and back. */
const B = (u: string): string => String.fromCharCode(...encode852(u));
const U = (b: string): string => decode852(Uint8Array.from(b, (c) => c.charCodeAt(0)));

/** Loads the message index of Účto's FAND.RES (as RUNFAND does) so that RdMsg works. */
function loadResMessages(): void {
  BaseVars.CPath = FromUnicode(join(APP, 'FAND.RES'));
  BaseVars.CVol = '';
  const h = OpenH(_isoldfile, RdOnly);
  expect(BaseVars.HandleError).toBe(0);
  BaseVars.ResFile.Handle = h;
  const b = new Uint8Array(2);
  ReadH(h, 2, b);
  ReadH(h, 17 * 6, new Uint8Array(17 * 6));
  ReadH(h, 2, b);
  const n = getWord(b, 0);
  const it = new Uint8Array(5 * n);
  ReadH(h, it.length, it);
  const idx: TMsgIdxItem[] = [{ Nr: 0, Ofs: 0, Count: 0 }];
  for (let i = 0; i < n; i++) idx.push({ Nr: getWord(it, 5 * i), Ofs: getWord(it, 5 * i + 2), Count: it[5 * i + 4] });
  BaseVars.MsgIdx = idx;
  BaseVars.MsgIdxN = n;
  BaseVars.FrstMsgPos = PosH(h);
}

/** Opcode names for readable trees. */
const OPS: Record<string, string> = {
  [_const]: 'const', [_plus]: '+', [_minus]: '-', [_times]: '*', [_divide]: '/', [_div]: 'div', [_mod]: 'mod',
  [_round]: 'round', [_concat]: '++', [_unminus]: 'neg', [_lneg]: 'not', [_and]: 'and', [_or]: 'or',
  [_limpl]: '=>', [_lequ]: '<=>', [_compreal]: 'cmpR', [_compstr]: 'cmpS', [_inreal]: 'inR', [_instr]: 'inS',
  [_cond]: 'cond', [_modulo]: 'modulo', [_strdate]: 'strdate', [_valdate]: 'valdate', [_pos]: 'pos',
  [_replace]: 'replace', [_leadchar]: 'leadchar', [_trailchar]: 'trailchar', [_copy]: 'copy', [_str]: 'str',
  [_getwordvar]: 'wordvar', [_today]: 'today', [_upcase]: 'upcase', [_char]: 'char', [_length]: 'length',
  [_addwdays]: 'addwdays', [_userfunc]: 'userfunc', [_field]: 'field', [_access]: 'access', [_owned]: 'owned',
  [_trust]: 'trust', [_getlocvar]: 'lv', [_equmask]: 'equmask', [_copyline]: 'copyline',
};
function dump(z: FrmlPtr): string {
  if (z === null) return 'nil';
  const name = OPS[z.Op] ?? `op${z.Op.charCodeAt(0).toString(16)}`;
  if (z.Op === _const) {
    if (z.S !== '') return JSON.stringify(U(z.S));
    return z.B ? 'true' : String(z.R);
  }
  if (z.Op === _field) return `F:${U(z.Field!.Name)}`;
  const args: string[] = [];
  const ar = (z.Op.charCodeAt(0) >= 0xf0 ? 3 : z.Op.charCodeAt(0) >= 0xb0 ? 2 : z.Op.charCodeAt(0) >= 0x60 ? 1 : 0);
  if (z.Op === _access) return `access(${z.File2 ? U(z.File2.Name) : ''},${z.LD ? U(z.LD.RoleName) : ''},${dump(z.P1)})`;
  for (let i = 1; i <= ar; i++) {
    const p = (z as unknown as Record<string, FrmlPtr>)[`P${i}`];
    if (p !== null || i < ar) args.push(dump(p));
  }
  return `${name}(${args.join(',')})`;
}

/** Compile a formula from a Unicode text; FTyp and the tree. */
function frml(src: string): { typ: string; z: FrmlPtr; dump: string } {
  const S = ref(B(src));
  SetInpStr(S);
  RdLex();
  const t = ref('\0');
  const z = RdFrml(t);
  expect(AccessVars.Lexem).toBe('\x1a');
  return { typ: t.v, z, dump: dump(z) };
}

/** Runs body under a NewExit frame; returns the compile error message (Unicode) or null. */
function compileErr(body: () => void): string | null {
  const er = new ExitRecord();
  NewExit(null, er);
  try {
    body();
    return null;
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
    return U(BaseVars.MsgLine);
  } finally {
    RestoreExit(er);
  }
}

/** Runs body under a NewExit frame; a compile error becomes an exception with its message. */
function ok<T>(body: () => T): T {
  const er = new ExitRecord();
  NewExit(null, er);
  try {
    return body();
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
    throw new Error(`compile error: ${U(BaseVars.MsgLine)} at ${BaseVars.LastExitCode}`);
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
  AccessVars.FuncDRoot = null;
  AccessVars.IsTestRun = false;
}

beforeAll(() => {
  // a closed queue: anything waiting for a key (a message box) throws EngineShutdown, never hangs
  const kq = new KeyQueue();
  kq.close();
  SetDriversCrt(new Crt(kq, null, 80, 25));
  if (haveApp) loadResMessages();
  FormatCache();
});
beforeEach(() => resetCompiler());

// ---------------------------------------------------------------- lexer

describe('LEXANAL: lexemes', () => {
  function lexemes(src: string): string[] {
    const S = ref(B(src));
    SetInpStr(S);
    const out: string[] = [];
    for (;;) {
      RdLex();
      const l = AccessVars.Lexem;
      if (l === '\x1a') break;
      if (l === _identifier) out.push(`id:${U(AccessVars.LexWord)}`);
      else if (l === _number) out.push(`n:${AccessVars.LexWord}`);
      else if (l === _quotedstr) out.push(`q:${U(AccessVars.LexWord)}`);
      else {
        const names: Record<string, string> = {
          [_assign]: ':=', [_addass]: '+=', [_le]: '<=', [_ne]: '<>', [_lequ]: '<=>', [_limpl]: '=>', [_ge]: '>=',
          [_subrange]: '..', [_lt]: '<', [_equ]: '=', [_gt]: '>',
        };
        out.push(names[l] ?? l);
      }
    }
    return out;
  }
  it('identifiers, numbers, operators', () => {
    expect(lexemes('a:=b+=c<=d<>e<=>f=>g>=h..i<j=k>l')).toEqual([
      'id:a', ':=', 'id:b', '+=', 'id:c', '<=', 'id:d', '<>', 'id:e', '<=>', 'id:f', '=>', 'id:g', '>=',
      'id:h', '..', 'id:i', '<', 'id:j', '=', 'id:k', '>', 'id:l',
    ]);
    expect(lexemes('Číslo_1 12 3.5;#K @')).toEqual(['id:Číslo_1', 'n:12', 'n:3', '.', 'n:5', ';', '#', 'id:K', '@']);
  });
  it('quoted strings: doubled quote, \\\\ and \\nnn codes', () => {
    expect(lexemes("'it''s\\065\\\\x' ''")).toEqual(["q:it's" + 'A\\x', 'q:']);
  });
  it('comments (nested) and blanks, CR LF', () => {
    expect(lexemes('{ a { b } c }\r\n x {x}y')).toEqual(['id:x', 'id:y']);
  });
  it('{$define} / {$ifdef} / {$ifndef} / {$else} / {$endif}', () => {
    expect(lexemes('{$define AB}{$ifdef A}one{$else}two{$endif} three')).toEqual(['id:one', 'id:three']);
    expect(lexemes('{$define AB}{$ifndef A}one{$else}two{$endif}')).toEqual(['id:two']);
    expect(lexemes("{$ifdef Z}x{$ifdef A}y{$endif}'{'{$else}z{$endif}")).toEqual(['id:z']);
    expect(AccessVars.SwitchLevel).toBe(0);
  });
  it('ReadChar/SkipBlank at the end of the input', () => {
    const S = ref(B('a '));
    SetInpStr(S);
    expect(AccessVars.ForwChar).toBe('a');
    ReadChar();
    expect(AccessVars.CurrChar).toBe('a');
    SkipBlank(false);
    expect(AccessVars.ForwChar).toBe('\x1a');
    expect(AccessVars.CurrChar).toBe('a');
    const L = new Uint8Array(0);
    SetInpLongStr(L, true);
    expect(AccessVars.ForwChar).toBe('\x1a');
  });
  it('RdInteger, RdRealConst (numbers, exponents, dates and times)', () => {
    let S = ref('123 -4.25 1.5e3 2E-2 31.12.2025 12:30');
    SetInpStr(S);
    RdLex();
    expect(RdInteger()).toBe(123);
    expect(RdRealConst()).toBe(-4.25);
    expect(RdRealConst()).toBe(1500);
    expect(RdRealConst()).toBe(0.02);
    const d = RdRealConst();
    expect(d).toBe(ValDate('31.12.2025', 'DD.MM.YYYY'));
    expect(d).toBeGreaterThan(700000);
    expect(RdRealConst()).toBe(ValDate('12:30', 'hh:mm:ss.tt'));
    S = ref('1..5');
    SetInpStr(S);
    RdLex();
    expect(RdRealConst()).toBe(1);
    expect(AccessVars.Lexem).toBe(_subrange);
  });
  it('keywords and options', () => {
    const S = ref(B('Begin kEy= X1= ab'));
    SetInpStr(S);
    RdLex();
    expect(EquUpcase('BEGIN')).toBe(true);
    expect(TestKeyWord('BEGIN')).toBe(true);
    expect(IsKeyWord('END')).toBe(false);
    expect(IsKeyWord('BEGIN')).toBe(true);
    expect(IsOpt('KEY')).toBe(true);
    const n = ref(0);
    expect(IsDigitOpt('X', n)).toBe(true);
    expect(n.v).toBe(1);
    expect(TKW('AB')).toBe(true);
    expect(IsIdentifStr('a_1')).toBe(true);
    expect(IsIdentifStr('1a')).toBe(false);
    expect(IsIdentifStr('')).toBe(false);
  });
  it('RdStrConst, Rd1Char, RdQuotedChar, IsForwPoint', () => {
    const S = ref("'abc' x 'y' F.a F..b");
    SetInpStr(S);
    RdLex();
    expect(RdStrConst()).toBe('abc');
    expect(Rd1Char()).toBe('x');
    expect(RdQuotedChar()).toBe('y');
    expect(IsForwPoint()).toBe(true);
    RdLex();
    RdLex();
    RdLex();
    expect(AccessVars.LexWord).toBe('F');
    expect(IsForwPoint()).toBe(false);
  });
});

describe.skipIf(!haveApp)('LEXANAL: compile errors (FAND.RES messages)', () => {
  function msg(n: number): string {
    RdMsg(n);
    return U(BaseVars.MsgLine);
  }
  it('Error sets MsgLine, IsCompileErr, LastExitCode and GoExits', () => {
    const e = compileErr(() => frml("1+'a'"));
    expect(e).toBe(msg(1020));
    expect(AccessVars.IsCompileErr).toBe(true);
    expect(BaseVars.LastExitCode).toBe(6);
  });
  it('Error(1) names the expected lexeme', () => {
    expect(compileErr(() => frml('(1+2'))).toBe(msg(1001) + ' )');
    expect(compileErr(() => frml('copy(1'))).toBe(msg(1019));
    const S = ref('x');
    SetInpStr(S);
    RdLex();
    expect(compileErr(() => Accept(_assign))).toBe(msg(1001) + ' :=');
  });
  it('lexer limits and unterminated input', () => {
    expect(compileErr(() => frml('a'.repeat(33)))).toBe(msg(1002));
    expect(compileErr(() => frml('1234567890123456'))).toBe(msg(1006));
    expect(compileErr(() => frml("'abc"))).toBe(msg(1017));
    expect(compileErr(() => frml('{ comment'))).toBe(msg(1011));
    expect(compileErr(() => frml('{$ifdef A} x'))).toBe(msg(1011));
    expect(compileErr(() => frml('{$foo}1'))).toBe(msg(1158));
  });
  it('field names without a file context', () => {
    expect(compileErr(() => frml('x+1'))).toBe(msg(1110));
    expect(compileErr(() => frml('nosuchfun(1)'))).toBe(msg(1075));
  });
});

// ---------------------------------------------------------------- formulas

describe('RDFRML: formulas', () => {
  it('arithmetic precedence and associativity', () => {
    expect(frml('1+2*3').dump).toBe('+(1,*(2,3))');
    expect(frml('2-3-4').dump).toBe('-(-(2,3),4)');
    expect(frml('(1+2)*3/4').dump).toBe('/(*(+(1,2),3),4)');
    expect(frml('7 div 2 mod 3').dump).toBe('mod(div(7,2),3)');
    expect(frml('-1+ +2').dump).toBe('+(neg(1),2)');
    const r = frml('2.5 round 1');
    expect(r.dump).toBe('round(2.5,1)');
    expect(r.typ).toBe('R');
  });
  it('strings, booleans, comparisons', () => {
    let r = frml("'ab'+'c'");
    expect(r.typ).toBe('S');
    expect(r.dump).toBe('++("ab","c")');
    r = frml('1<2 & ^(3>=4) | true => false <=> true');
    expect(r.typ).toBe('B');
    expect(r.dump).toBe('<=>(=>(or(and(cmpR(1,2),not(cmpR(3,4))),true),0),true)' /* const false dumps as 0 */);
    r = frml('1 =.2 1.001');
    expect(r.z!.N21).toBe(_equ.charCodeAt(0));
    expect(r.z!.N22).toBe(2);
    r = frml('1<2');
    expect(r.z!.N21).toBe(_lt.charCodeAt(0));
    expect(r.z!.N22).toBe(5);
    r = frml("'a'<>~'A'");
    expect(r.z!.Op).toBe(_compstr);
    expect(r.z!.N21).toBe(_ne.charCodeAt(0));
    expect(r.z!.N22).toBe(1);
  });
  it("'in' constant lists: inline layout", () => {
    let r = frml('3 in [1,3..5,7]');
    expect(r.typ).toBe('B');
    expect(r.z!.Op).toBe(_inreal);
    expect(r.z!.N11).toBe(5);
    const d = (x: number) => [...new Uint8Array(new Float64Array([x]).buffer)];
    expect([...r.z!.Inline!]).toEqual([1, ...d(1), 0xff, ...d(3), ...d(5), 1, ...d(7), 0]);
    r = frml("'b' in ~['a','b ','c'..'d']");
    expect(r.z!.Op).toBe(_instr);
    expect(r.z!.N11).toBe(1);
    expect(BytesToStr(r.z!.Inline!)).toBe('\x02\x01a\x01b\xff\x01c\x01d\x00');
    r = frml("'b' in ['x', 'y']");
    expect(BytesToStr(r.z!.Inline!)).toBe('\x02\x01x\x01y\x00');
  });
  it('cond, copy/str/text, modulo', () => {
    let r = frml("cond(1=1:'a',2=3:'b',else:'c')");
    expect(r.typ).toBe('S');
    expect(r.dump).toBe('cond(cmpR(1,1),"a",cond(cmpR(2,3),"b",cond(nil,"c")))');
    expect(frml("copy('abc',2,1)").dump).toBe('copy("abc",2,1)');
    r = frml('str(1,5,2)');
    expect(r.typ).toBe('S');
    expect(r.dump).toBe('str(1,5,2)');
    expect(frml("text(1,'999')").dump).toBe('str(1,"999")');
    r = frml("modulo('1234',11,4,3,2)");
    expect(r.typ).toBe('B');
    expect(r.z!.W11).toBe(4);
    expect(r.z!.W12).toBe(11);
    expect([...r.z!.Inline!]).toEqual([4, 0, 3, 0, 2, 0]);
  });
  it('date and string functions', () => {
    let r = frml("strdate(today,'DD.MM.YYYY')");
    expect(r.typ).toBe('S');
    expect(r.z!.Op).toBe(_strdate);
    expect(U(r.z!.Mask)).toBe('DD.MM.YYYY');
    expect(r.z!.P1!.Op).toBe(_today);
    r = frml('dtext(1,mm)');
    expect(r.z!.Mask).toBe('MM');
    r = frml("date('1.1.20')");
    expect(r.typ).toBe('R');
    expect(r.z!.Op).toBe(_valdate);
    expect(r.z!.Mask).toBe('DD.MM.YY');
    r = frml("valdate('2020','YYYY')");
    expect(r.z!.Mask).toBe('YYYY');
    r = frml("pos('a','abc','~',2)");
    expect(r.typ).toBe('R');
    expect(r.dump).toBe('pos("a","abc",2)');
    expect(r.z!.Options).toBe('~');
    r = frml("replace('a','b','abc')");
    expect(r.typ).toBe('S');
    expect(r.z!.Op).toBe(_replace);
    expect(r.z!.Options).toBe('');
    r = frml("trailchar(' ','x ','_')");
    expect(r.z!.N11).toBe(0x20);
    expect(r.z!.N12).toBe(0x5f);
    expect(frml("leadchar('0','007')").z!.Op).toBe(_leadchar);
    expect(frml("upcase('a')+char(65)").dump).toBe('++(upcase("a"),char(65))');
    expect(frml("length('abc')").typ).toBe('R');
    r = frml('addwdays(today,5,2)');
    expect(r.z!.N21).toBe(2);
    expect(frml("copyline('a',1,2)").dump).toBe('copyline("a",1,2)');
    expect(frml("equmask('a','?')").typ).toBe('B');
    r = frml('trust(1,3..4)');
    expect(r.typ).toBe('B');
    expect([...r.z!.Inline!]).toEqual([3, 1, 3, 4]);
  });
  it('0-ary functions, word variables, true/false', () => {
    expect(frml('usercode').z!.Op).toBe(_getwordvar);
    expect(frml('usercode').z!.N01).toBe(7);
    expect(frml('EdBreak').z!.N01).toBe(3);
    expect(frml('Today').typ).toBe('R');
    expect(frml('username').typ).toBe('S');
    expect(frml('testmode').typ).toBe('B');
    expect(frml('TRUE').dump).toBe('true');
    expect(frml('false').z!.B).toBe(false);
  });
  it('user functions (FuncD) and sum()', () => {
    const fc = new FuncD();
    fc.Name = 'Dvakrat';
    fc.FTyp = 'R';
    const p1 = new LocVar();
    p1.FTyp = 'R';
    const p2 = new LocVar();
    p2.FTyp = 'S';
    p1.Chain = p2;
    fc.LVB.Root = p1;
    fc.LVB.NParam = 2;
    AccessVars.FuncDRoot = fc;
    const r = frml("dvakrat(1+1,'x')*2");
    expect(r.dump).toBe('*(userfunc(),2)');
    expect(r.z!.P1!.FC).toBe(fc);
    expect(dump(r.z!.P1!.FrmlL!.Frml)).toBe('+(1,1)');
    expect(dump(r.z!.P1!.FrmlL!.Chain!.Frml)).toBe('"x"');
    // sum(...) chains a SumElem and yields its (Op,R) view
    const sums: SumElem[] = [];
    AccessVars.ChainSumEl = () => sums.push(AccessVars.FrmlSumEl!);
    const s = frml('sum(2*3)+1');
    expect(sums.length).toBe(1);
    expect(s.z!.P1!.Op).toBe(_const);
    sums[0].R = 42;
    expect(s.z!.P1!.R).toBe(42);
    expect(dump(sums[0].Frml)).toBe('*(2,3)');
    expect(AccessVars.FrmlSumEl).toBe(null);
  });
  it('RdBool/RdRealFrml/RdStrFrml and type errors', () => {
    let S = ref('1+1');
    SetInpStr(S);
    RdLex();
    expect(dump(RdRealFrml())).toBe('+(1,1)');
    S = ref("'a'");
    SetInpStr(S);
    RdLex();
    expect(dump(RdStrFrml())).toBe('"a"');
    S = ref('true');
    SetInpStr(S);
    RdLex();
    expect(dump(RdBool())).toBe('true');
  });
});

// ---------------------------------------------------------------- file declarations from strings

describe('RDFILDCL: file declarations compiled from strings', () => {
  let R: RdbD;
  function compileFD(name: string, typ: string, src: string, ext = ''): FileD {
    const S = ref(B(src));
    SetInpStr(S);
    ok(() => RdFileD(B(name), typ, ext));
    return AccessVars.CFile!;
  }
  function fld(fd: FileD, name: string) {
    for (let f = fd.FldD; f !== null; f = f.Chain) if (U(f.Name) === name) return f;
    throw new Error(`no field ${name}`);
  }
  beforeEach(() => {
    AccessVars.LinkDRoot = null;
    const chpt = new FileD();
    chpt.Name = 'TEST';
    R = new RdbD();
    R.FD = chpt;
    AccessVars.FileDRoot = chpt;
    AccessVars.CRdb = R;
    AccessVars.CatFD = null;
  });
  it('fields, record layout, keys, computed fields', () => {
    const fd = compileFD(
      'ADR', 'X',
      "Číslo:N,5; Název:A,30; Pozn:T; Datum:D; Částka:F,10.2; Kód:A,'[AB](x|yy)!'; Ok:B; K:F,3,1; R:R; Zkr:A,5R; " +
        "#C Popis:=Název+'x':A,31; Dvoj:=Částka*2:F,12.2; #K @ Číslo; Jm(@) *~Název,>Číslo; Iv(@) <= Datum;",
    );
    expect(fd.Typ).toBe('X');
    expect(AccessVars.FileDRoot!.Chain).toBe(fd);
    expect(fd.RecLen).toBe(1 + 3 + 30 + 4 + 6 + 6 + 5 + 1 + 2 + 6 + 5);
    expect(fd.FrstDispl).toBe(6);
    const c = fld(fd, 'Částka');
    expect([c.Displ, c.NBytes, c.L, c.M, c.FrmlTyp]).toEqual([44, 6, 14, 2, 'R']);
    const k = fld(fd, 'Kód');
    expect([k.L, k.NBytes, k.Mask]).toEqual([5, 5, '[AB](x|yy)!']);
    expect(fld(fd, 'K').Flg & 8).toBe(8); // f_Comma
    expect(fld(fd, 'Datum').Mask).toBe('DD.MM.YY');
    expect(fld(fd, 'Zkr').M).toBe(0); // right justified
    expect(fld(fd, 'Název').M).toBe(1);
    const p = fld(fd, 'Popis');
    expect(p.Flg & 1).toBe(0);
    expect(dump(p.Frml)).toBe('++(F:Název,"x")');
    expect(fd.TF).not.toBe(null);
    expect(fd.XF).not.toBe(null);
    const keys = [];
    for (let K = fd.Keys; K !== null; K = K.Chain) keys.push(K);
    expect(keys.map((K) => [U(K.Alias!), K.IndexRoot, K.IndexLen, K.Duplic, K.Intervaltest])).toEqual([
      ['', 1, 3, false, false],
      ['Jm', 2, 33, true, false],
      ['Iv', 3, 6, false, true],
    ]);
    expect(keys[1].KFlds!.CompLex).toBe(true);
    expect(keys[1].KFlds!.Chain!.Descend).toBe(true);
    expect(fd.LiOfs).toBe(null); // compiled from a string
  });
  it('links, #A cumulations, field access formulas, OWNED', () => {
    const adr = compileFD('ADR', 'X', 'Cislo:N,5; Nazev:A,30; Suma:F,10.2; Pocet:F,5.0; #K @ Cislo;');
    const fak = compileFD(
      'FAK', 'X',
      'Cislo:N,5; Adr:N,5; Castka:F,8.2; #K @ Cislo; FAK_Adr(@) * Adr; ADR Adr; Odb(ADR) ! Adr; #C Jm:=ADR.Nazev:A,30; Ex:=ADR.exist:B; ' +
        '#A ADR.Suma+=Castka; if Castka>0 then Odb.Pocet:=1;',
    );
    expect(dump(fld(fak, 'Jm').Frml)).toBe('access(ADR,ADR,F:Nazev)');
    expect(dump(fld(fak, 'Ex').Frml)).toBe('access(ADR,ADR,nil)');
    const links = [];
    for (let L = AccessVars.LinkDRoot; L !== null; L = L.Chain) links.push(L);
    expect(links.map((L) => [L.RoleName, L.FromFD, L.ToFD, L.MemberRef, L.IndexRoot])).toEqual([
      ['Odb', fak, adr, 1, 2],
      ['ADR', fak, adr, 0, 2],
    ]);
    expect(fak.nLDs).toBe(2);
    expect(links[0].Args!.FldD).toBe(fld(fak, 'Adr'));
    const a1 = fak.Add!;
    expect([a1.File2, a1.Field, a1.Assign, dump(a1.Frml)]).toEqual([adr, fld(adr, 'Suma'), false, 'F:Castka']);
    const a2 = a1.Chain!;
    expect([a2.LD, a2.Field, a2.Assign, dump(a2.Frml), dump(a2.Bool)]).toEqual([
      links[0], fld(adr, 'Pocet'), true, '1', 'cmpR(F:Castka,0)',
    ]);
    // OWNED(...) in a formula of ADR; key-in conditions
    AccessVars.CFile = adr;
    const S = ref(B('owned(FAK.Castka:Castka>1)+owned(Odb(FAK))'));
    SetInpStr(S);
    RdLex();
    const t = ref('');
    const z = ok(() => RdFldNameFrmlF(t));
    expect(t.v).toBe('R');
    expect(z!.Op).toBe(_owned);
    expect(z!.ownLD).toBe(links[1]);
    expect(dump(z!.ownSum)).toBe('F:Castka');
    expect(dump(z!.ownBool)).toBe('cmpR(F:Castka,1)');
    AccessVars.CFile = fak;
    AccessVars.CViewKey = fak.Keys;
    const S2 = ref(B("key in ['1'..'5','7'] & Castka>0"));
    SetInpStr(S2);
    RdLex();
    const KI = ref<import('../src/engine/pas/access.ts').KeyInDPtr>(null);
    const sql = ref(true);
    const kb = ok(() => RdKeyInBool(KI, true, false, sql));
    expect(sql.v).toBe(false);
    expect(dump(kb)).toBe('op65(cmpR(F:Castka,0))');
    expect(dump(KI.v!.FL1!.Frml)).toBe('op65("1")');
    expect(dump(KI.v!.FL2!.Frml)).toBe('op65("5")');
    expect(dump(KI.v!.Chain!.FL1!.Frml)).toBe('op65("7")');
    expect(KI.v!.Chain!.FL2).toBe(null);
    expect(IsKeyArg(fld(fak, 'Cislo'), fak)).toBe(true);
    expect(IsKeyArg(fld(fak, 'Castka'), fak)).toBe(false);
    const nf = FrmlContxt(kb, fak, null);
    expect(nf!.NewFile).toBe(fak);
  });
  it('#U views, #D, #L checks, #I implicit values (LiRoots kept for chapter input)', () => {
    compileFD('ADR', 'X', 'Cislo:N,5; Nazev:A,30; #K @ Cislo;');
    const S = ref(B(
      "A:N,5; B:A,10; D:D; #K @ A; #U Hlavni (1,3..4): (A,B); Druha (0): ^(B!); " +
        "#D (A<>'') B:='x'; D:=today; #L A<>'1'; B<>'' ? : 'prazdne'; #I D:=today; B:='y'",
    ));
    SetInpStr(S);
    AccessVars.InpRdbPos.R = R; // as if compiled from chapter 1
    AccessVars.InpRdbPos.IRec = 1;
    ok(() => RdFileD('X1', 'X', ''));
    const fd = AccessVars.CFile!;
    expect(fd.ChptPos.R).toBe(R);
    expect(fd.ChptPos.IRec).toBe(1);
    expect(fd.TxtPosUDLI).toBeGreaterThan(0);
    expect(S.v[fd.TxtPosUDLI - 1] + S.v[fd.TxtPosUDLI]).toBe('#U');
    const views = [];
    for (let v = fd.ViewNames; v !== null; v = v.Chain) views.push([v.S, v.After]);
    expect(views).toEqual([['Hlavni', '\x01\x03\x04'], ['Druha', '\x00']]);
    const li = fd.LiOfs!;
    const chks = [];
    for (let c = li.Chks; c !== null; c = c.Chain) chks.push([dump(c.Bool), dump(c.TxtZ), c.Warning]);
    expect(chks).toEqual([
      ['cmpS(F:A,"1")', '"A<>\'1\'"', false],
      ['cmpS(F:B,0)', '"prazdne"', true], // (an empty string const dumps as 0)
    ]);
    const impl = [];
    for (let i = li.Impls; i !== null; i = i.Chain) impl.push([U(i.FldD!.Name), dump(i.Frml)]);
    expect(impl).toEqual([['D', 'today()'], ['B', '"y"']]);
  });
  it('RdByteList, RdLocDcl (incl. FILE variables), EditModeToFlags, misc RDMIX', () => {
    const adr = compileFD('ADR', 'X', 'Cislo:N,5; Nazev:A,30; #K @ Cislo; ADR_Jm(@) Nazev;');
    let S = ref('(1,3..5, 255)');
    SetInpStr(S);
    RdLex();
    const s = ref('');
    RdByteList(s);
    expect(s.v).toBe('\x01\x03\x04\x05\xff');
    // local declarations
    ResetLVBD();
    const LVB: LocVarBlkD = RdRunVars.LVBD;
    S = ref(B("x,y:real=3; s:string='a'; b:boolean=true; r:record of ADR; i:index of ADR(Nazev); f:file.X[A:N,5; #K @ A]; begin"));
    SetInpStr(S);
    RdLex();
    ok(() => RdLocDcl(LVB, false, true, 'P'));
    expect(TKW('BEGIN')).toBe(true);
    const lvs: LocVar[] = [];
    for (let lv = LVB.Root; lv !== null; lv = lv.Chain) lvs.push(lv);
    expect(lvs.map((lv) => [lv.Name, lv.FTyp, lv.BPOfs])).toEqual([
      ['x', 'R', 8], ['y', 'R', 14], ['s', 'S', 20], ['b', 'B', 24], ['r', 'r', 0], ['i', 'i', 0], ['f', 'f', 0],
    ]);
    expect(LVB.Size).toBe(25);
    expect(lvs[0].Init!.R).toBe(3);
    expect(lvs[0].Init).toBe(lvs[1].Init);
    expect(lvs[2].Init!.S).toBe('a');
    expect(lvs[3].Init!.B).toBe(true);
    expect(lvs[4].FD).toBe(adr);
    expect(lvs[4].RecPtr).toBeInstanceOf(Uint8Array);
    const wk = lvs[5].RecPtr as import('../src/engine/pas/access.ts').XWKey;
    expect([wk.InWork, wk.Duplic, wk.IndexLen]).toEqual([true, true, 30]);
    const ffd = lvs[6].FD!;
    expect([ffd.Name, ffd.Typ, ffd.IsDynFile, ffd.RecLen]).toEqual(['f', 'X', true, 4]);
    expect(ffd.ChptPos.R).toBe(R);
    const lv = ref<LocVar | null>(null);
    S = ref('s');
    SetInpStr(S);
    RdLex();
    expect(FindLocVar(LVB.Root, lv)).toBe(true);
    expect(lv.v).toBe(lvs[2]);
    // parameter list
    const PB = new LocVarBlkD();
    S = ref('a:real; var b:string)');
    SetInpStr(S);
    RdLex();
    RdLocDcl(PB, true, false, 'P');
    expect([PB.NParam, PB.Root!.IsPar, PB.Root!.Chain!.IsRetPar]).toEqual([2, true, true]);
    // view key '/Jm'
    AccessVars.CFile = adr;
    S = ref('/ADR_Jm /@ /X_Jm');
    SetInpStr(S);
    RdLex();
    const k2 = adr.Keys!.Chain;
    expect(RdViewKey()).toBe(k2);
    expect(RdViewKey()).toBe(adr.Keys);
    expect(RdViewKey()).toBe(k2);
    // key field list
    S = ref('>Nazev,Cislo');
    SetInpStr(S);
    RdLex();
    const kf = ref<import('../src/engine/pas/access.ts').KeyFldDPtr>(null);
    expect(RdKFList(kf, adr)).toBe(33);
    expect(kf.v!.Descend).toBe(true);
    const flg: boolean[] = [];
    EditModeToFlags('^y??sl', flg, false);
    expect(flg[1]).toBe(true);
    expect(flg[9]).toBe(true);
    expect(flg[24]).toBe(true);
    expect(flg.filter(Boolean).length).toBe(3);
    const ro = GetRprtOpt()!;
    expect([ro.Style, ro.Mode]).toEqual(['?', 0]);
    expect(GetEditOpt()!.UserSelFlds).toBe(true);
    expect(AllFldsList(adr, true)!.Chain!.FldD!.Name).toBe('Nazev');
    expect(FldTypIdentity(adr.FldD, adr.FldD)).toBe(true);
    // RdFrame, RdAssignFrml
    S = ref(",@=' x '!");
    SetInpStr(S);
    RdLex();
    const Z = ref<FrmlPtr>(null);
    const wf = ref(0);
    RdFrame(Z, wf);
    expect(wf.v).toBe(0x02 | 0x10 | 0x20 | 0x01);
    expect(Z.v!.S).toBe(' x ');
    S = ref('+=1');
    SetInpStr(S);
    RdLex();
    const add = ref(false);
    RdAssignFrml('R', add, Z);
    expect(add.v).toBe(true);
    // SaveCompState / RestoreCompState
    S = ref('a b');
    SetInpStr(S);
    RdLex();
    const st = SaveCompState();
    RdLex();
    expect(AccessVars.LexWord).toBe('b');
    RestoreCompState(st);
    expect(AccessVars.LexWord).toBe('a');
    // CompileRecLen for a '8' and a DBF file
    const f8 = compileFD('F8', '8', 'A:N,4; D:D; F:F,5.2;');
    expect([f8.RecLen, f8.FrstDispl]).toEqual([2 + 2 + 4, 4]);
    const fdb = compileFD('FD', 'D', 'A:A,4; D:D; F:F,5.2; T:T;');
    expect([fdb.RecLen, fdb.FrstDispl]).toEqual([1 + 4 + 8 + 8 + 10, 5 * 32 + 1]);
    AccessVars.CFile = fdb;
    CompileRecLen();
    expect(fdb.RecLen).toBe(31);
  });
});

// ---------------------------------------------------------------- Účto projects

interface ProjectResult {
  name: string;
  fOk: number;
  dOk: number;
  dSkipped: number;
  errors: string[];
}

/** PROJMGR.SetChptFldDPtr */
function SetChptFldDPtr(): void {
  const a = AccessVars;
  a.ChptTF = a.Chpt!.TF;
  a.ChptTxtPos = a.Chpt!.FldD;
  a.ChptVerif = a.ChptTxtPos!.Chain;
  a.ChptOldTxt = a.ChptVerif!.Chain;
  a.ChptTyp = a.ChptOldTxt!.Chain;
  a.ChptName = a.ChptTyp!.Chain;
  a.ChptTxt = a.ChptName!.Chain;
}

/** PROJMGR.CreateOpenChpt (read only, no catalog/dirs): the chapter file of a project. */
function openProject(path: string, tpath: string): RdbD {
  const a = AccessVars;
  a.FileDRoot = null;
  const R = new RdbD();
  R.ChainBack = a.CRdb;
  R.OldLDRoot = a.LinkDRoot;
  R.OldFCRoot = a.FuncDRoot;
  RdMsg(51);
  let s = BaseVars.MsgLine;
  RdMsg(48);
  s = s + String(BaseVars.TxtCols - Number(BaseVars.MsgLine.trim()));
  if (process.env.LEXFRML_TRACE) appendFileSync(process.env.LEXFRML_TRACE, `open ${path}: ${U(s)}\n`);
  SetInpStr(ref(s));
  const nm = FromUnicode(basename(path, extname(path)));
  RdFileD(nm, '0', '');
  if (process.env.LEXFRML_TRACE) appendFileSync(process.env.LEXFRML_TRACE, `compiled\n`);
  R.FD = a.CFile;
  a.CRdb = R;
  const cf = a.CFile!;
  cf.RecPtr = GetRecSpace();
  SetChptFldDPtr();
  cf.UMode = RdOnly;
  BaseVars.CPath = FromUnicode(path);
  cf.Handle = OpenH(_isoldfile, RdOnly);
  expect(BaseVars.HandleError).toBe(0);
  BaseVars.CPath = FromUnicode(tpath);
  cf.TF!.Handle = OpenH(_isoldfile, RdOnly);
  expect(BaseVars.HandleError).toBe(0);
  RdPrefixes();
  R.Encrypted = new Rdb(path, tpath).encrypted;
  if (R.ChainBack !== null) R.HelpFD = R.ChainBack.HelpFD;
  return R;
}

/** PROJMGR.CompileRdb, the F and D chapters. */
function compileProject(R: RdbD, name: string): ProjectResult {
  const a = AccessVars;
  const res: ProjectResult = { name, fOk: 0, dOk: 0, dSkipped: 0, errors: [] };
  const chpt = R.FD!;
  for (let I = 1; I <= chpt.NRecs; I++) {
    a.CFile = chpt;
    a.CRecPtr = chpt.RecPtr;
    ReadRec(I);
    const typ = _ShortS(a.ChptTyp)[0];
    const Name = _ShortS(a.ChptName).replace(/ +$/, '');
    const Txt = _T(a.ChptTxt);
    if (typ !== 'F' && typ !== 'D') continue;
    if (process.env.LEXFRML_TRACE) appendFileSync(process.env.LEXFRML_TRACE, `${name} #${I} ${typ} ${U(Name)}\n`);
    const RP = new RdbPos();
    RP.R = R;
    RP.IRec = I;
    a.InpRdbPos = RP;
    a.IsCompileErr = false;
    const er = new ExitRecord();
    NewExit(null, er);
    try {
      if (typ === 'F') {
        const dot = Name.indexOf('.');
        const nm = dot < 0 ? Name : Name.slice(0, dot);
        const ext = dot < 0 ? '' : Name.slice(dot);
        const FDTyp = { '': '6', '.X': 'X', '.DTA': '8', '.DBF': 'D', '.HLP': '6', '.RDB': '0' }[ext.toUpperCase()] ?? '?';
        if (FDTyp === '0') {
          // PROJMGR.CompileRdb.RdF: a chapter file, declared by messages 51 and 49
          RdMsg(51);
          const s = BaseVars.MsgLine;
          RdMsg(49);
          SetInpStr(ref(s + String(BaseVars.TxtCols - Number(BaseVars.MsgLine.trim()))));
        } else SetInpTTPos(Txt, R.Encrypted);
        RdFileD(nm, FDTyp, ext);
        if (a.CFile!.IsHlpFile) R.HelpFD = a.CFile;
        res.fOk++;
      } else {
        ResetCompilePars();
        SetInpTTPos(Txt, R.Encrypted);
        try {
          ReadDeclChpt();
          res.dOk++;
        } catch (e) {
          if (!(e instanceof NotImplementedError)) throw e;
          res.dSkipped++;
        }
      }
    } catch (e) {
      if (!(e instanceof GoExitSignal)) throw e;
      res.errors.push(`${name} #${I} ${typ} ${U(Name)}: ${U(BaseVars.MsgLine)} @${BaseVars.LastExitCode}`);
    } finally {
      RestoreExit(er);
    }
  }
  a.CFile = chpt;
  a.CRecPtr = chpt.RecPtr;
  return res;
}

/**
 * Who CALLs whom (`call(MODULxx,...)` in the decoded sources): a sub-project sees the files,
 * links and functions of the project that called it, so it is compiled on top of that chain.
 * callee -> callers, the most general caller first.
 */
const CALLERS: Record<string, string[]> = {
  MODUL01: ['UCTO2026'],
  IMPORT: ['UCTO2026', 'MODUL01'],
  UCTOINFO: ['UCTO2026', 'MODUL01'],
  UPG: ['UCTO2026', 'MODUL01'],
  MODUL02: ['MODUL01'], MODUL03: ['MODUL01'], MODUL04: ['MODUL01'], MODUL05: ['MODUL01'],
  MODUL06: ['MODUL01'], MODUL07: ['MODUL01'], MODUL08: ['MODUL01'],
  MODUL09: ['MODUL01', 'MODUL03'],
  MODUL94: ['MODUL01', 'MODUL04'],
  MODUL95: ['UCTO2026', 'MODUL01', 'MODUL03', 'MODUL04', 'MODUL05', 'MODUL09', 'MODUL94', 'MODUL97'],
  MODUL97: ['MODUL01', 'MODUL04', 'UPG', 'UPG04'],
  MODUL98: ['MODUL01', 'UPG'],
  MODUL99: ['UCTO2026', 'MODUL01', 'MODUL02', 'MODUL04', 'MODUL05', 'MODUL06', 'UPG', 'UPG02', 'UPG04',
    'UPG05', 'UPG06', 'UPG08', 'UPG09'],
  SEST01: ['MODUL01'], SEST02: ['MODUL02'], SEST03: ['MODUL03'], SEST04: ['MODUL04'], SEST05: ['MODUL05'],
  SEST06: ['MODUL06'], SEST07: ['MODUL07'], SEST08: ['MODUL08'], SEST09: ['MODUL09'], SEST97: ['MODUL97'],
  SPEC01: ['MODUL01'], SPEC02: ['MODUL01'], SPEC03: ['MODUL01'], SPEC04: ['MODUL01', 'MODUL04'],
  SPEC05: ['MODUL01'], SPEC06: ['MODUL01'], SPEC07: ['MODUL01'],
  UPG01: ['UPG'], UPG02: ['UPG'], UPG03: ['UPG'], UPG05: ['UPG'], UPG06: ['UPG'],
  // _DETI.X links PRACOV, which only MODUL04 declares; at run time FAND loads the precompiled FD
  // segment of an unchanged F chapter (PROJMGR.CompileRdb RdFDSegment) instead of its source
  UPG04: ['UPG', 'MODUL04'],
  UPG07: ['UPG'], UPG08: ['UPG'], UPG09: ['UPG'],
  UPG97: ['UPG04'],
  UPG99: ['UPG', 'UPG02', 'UPG04', 'UPG05', 'UPG06', 'UPG08', 'UPG09'],
};

describe.skipIf(!haveApp)('Účto: every F and D chapter compiles', () => {
  const projects = haveApp
    ? readdirSync(APP).filter((f) => /\.(RDB|PRO)$/i.test(f)).sort()
    : [];
  const fileOf = new Map(projects.map((f) => [f.replace(/\.(RDB|PRO)$/i, '').toUpperCase(), f]));
  function textPath(f: string): string {
    return join(WORK, f.replace(/\.RDB$/i, '.TTT').replace(/\.PRO$/i, '.TRO'));
  }
  beforeAll(() => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    for (const f of projects) {
      cpSync(join(APP, f), join(WORK, f));
      const t = basename(textPath(f));
      if (existsSync(join(APP, t))) cpSync(join(APP, t), join(WORK, t));
    }
  });

  /** A compiled project: its RdbD and the global chains right after its F and D chapters. */
  interface Compiled {
    R: RdbD;
    FD: FileDPtr;
    LD: typeof AccessVars.LinkDRoot;
    FC: typeof AccessVars.FuncDRoot;
    res: ProjectResult;
  }
  const byChain = new Map<string, Compiled>();
  /** Compiles `chain` (top project first), reusing the compiled parents. */
  function compileChain(chain: string[]): Compiled {
    const key = chain.join('/');
    const done = byChain.get(key);
    if (done) return done;
    const parent = chain.length > 1 ? compileChain(chain.slice(0, -1)) : null;
    const a = AccessVars;
    a.CRdb = parent?.R ?? null;
    a.FileDRoot = parent?.FD ?? null;
    a.LinkDRoot = parent?.LD ?? null;
    a.FuncDRoot = parent?.FC ?? null;
    if (parent === null) a.CatFD = null;
    const f = fileOf.get(chain[chain.length - 1])!;
    const R = openProject(join(WORK, f), textPath(f));
    const res = compileProject(R, key);
    const c: Compiled = { R, FD: a.FileDRoot, LD: a.LinkDRoot, FC: a.FuncDRoot, res };
    byChain.set(key, c);
    return c;
  }
  /** The call chains that reach `name`, shortest first. */
  function chainsTo(name: string, seen: Set<string> = new Set()): string[][] {
    if (name === 'UCTO2026') return [['UCTO2026']];
    const callers = CALLERS[name] ?? ['UCTO2026'];
    const out: string[][] = [];
    for (const c of callers) {
      if (seen.has(c) || !fileOf.has(c)) continue;
      for (const ch of chainsTo(c, new Set([...seen, name]))) out.push([...ch, name]);
    }
    return out.sort((x, y) => x.length - y.length);
  }

  it('UCTO2026 (top) and each sub-project on top of the project that calls it', () => {
    const results: ProjectResult[] = [];
    for (const f of projects) {
      const name = f.replace(/\.(RDB|PRO)$/i, '').toUpperCase();
      // the first call chain in which the project compiles cleanly, else the errors of the first one
      let first: ProjectResult | null = null;
      let ok: ProjectResult | null = null;
      for (const ch of chainsTo(name)) {
        const r = compileChain(ch).res;
        first ??= r;
        if (r.errors.length === 0) {
          ok = r;
          break;
        }
      }
      results.push(ok ?? first!);
    }
    AccessVars.CRdb = null;
    const errors = results.flatMap((r) => r.errors);
    const fOk = results.reduce((n, r) => n + r.fOk, 0);
    const dOk = results.reduce((n, r) => n + r.dOk, 0);
    const dSkipped = results.reduce((n, r) => n + r.dSkipped, 0);
    console.log(
      `${results.length} projects: F chapters compiled: ${fOk}; D chapters: ${dOk} compiled, ${dSkipped} skipped (RDPROC stub)`,
    );
    expect(errors).toEqual([]);
    expect(results.length).toBe(projects.length);
    expect(fOk).toBeGreaterThan(300);
  });
});
