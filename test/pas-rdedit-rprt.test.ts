// rdedit-rprt package: RDEDIT.PAS (edit forms, NewEditD), RDRPRT.PAS (report compiler) and the
// RDRUN.PAS runtime helpers. Small forms and reports compiled from strings (the BlkD text layout
// RUNRPRT walks), then every E and R chapter of all Účto projects compiled in chapter order the
// way PROJMGR.CompileRdb does it (F and D chapters first), plus NewEditD on each E form and on an
// automatic form of every file (which reads the files' #D/#L/#I sections).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { existsSync, readdirSync, mkdirSync, cpSync, rmSync, appendFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

// Routines of other packages that this package calls but that may still be stubs: fall back to a
// minimal version only while the real one throws NotImplementedError.
vi.mock('../src/engine/pas/runfrml.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/engine/pas/runfrml.ts')>();
  const { NotImplementedError, StrToBytes } = await import('../src/engine/pas/pasrt.ts');
  type Z = import('../src/engine/pas/access.ts').FrmlPtr;
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
  const cnst = (z: Z): Z => {
    if (z !== null && z.Op !== '\x10') throw new Error(`test fallback: only constants (op ${z.Op.charCodeAt(0)})`);
    return z;
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
    RunShortStr: fb(m.RunShortStr, (X: Z) => cnst(X)?.S ?? ''),
    RunLongStr: fb(m.RunLongStr, (X: Z) => StrToBytes(cnst(X)?.S ?? '')),
    RunInt: fb(m.RunInt, (X: Z) => Math.trunc(cnst(X)?.R ?? 0)),
    RunWordImpl: fb(m.RunWordImpl, (Z: Z, Impl: number) => (Z === null ? Impl : Math.trunc(cnst(Z)!.R))),
    RunEvalFrml: fb(m.RunEvalFrml, (Z: Z) => Z),
    GetFromKey: fb(m.GetFromKey, (LD) => LD!.FromFD!.Keys),
    // PushProcStk passes the new frame as OldBP
    LVAssignFrml: fb(m.LVAssignFrml, (LV, BP, _Add, X: Z) => {
      BP!.V[LV!.BPOfs] = cnst(X)!.R;
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

import { ref, getWord, GoExitSignal, FromUnicode, NotImplementedError } from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, OpenH, ReadH, PosH, _isoldfile, RdOnly, NewExit, RestoreExit, ExitRecord, RdMsg, ProcStkD, FormatCache,
  type TMsgIdxItem,
} from '../src/engine/pas/base.ts';
import { SetDriversCrt } from '../src/engine/pas/drivers.ts';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { encode852, decode852 } from '../src/engine/console/cp852.ts';
import {
  AccessVars, FileD, RdbD, RdbPos, LocVar, FrmlElem, AddD, ResetCompilePars, GetRecSpace, ReadRec, RdPrefixes,
  _ShortS, _T, _const, _getlocvar, _field, _newfile, _getwordvar, NullMode, RdMode,
  type FileDPtr, type FieldDPtr,
} from '../src/engine/pas/access.ts';
import { SetInpStr, RdLex, SetInpTTPos, AllFldsList, RdLocDcl } from '../src/engine/pas/compile.ts';
import { RdFileD } from '../src/engine/pas/rdfildcl.ts';
import { ReadDeclChpt } from '../src/engine/pas/rdproc.ts';
import {
  RdRunVars, ResetLVBD, EditOpt, RprtOpt, EdExitD, EdExKeyD, PushProcStk, PopProcStk, SetMyBP, LockForAdd,
  RunAddUpdte1, TestExitKey, SetCompileAll, type BlkDPtr, type EditD, type LvDescrPtr,
} from '../src/engine/pas/rdrun.ts';
import { PushEdit, RdFormOrDesign, NewEditD } from '../src/engine/pas/rdedit.ts';
import { ReadReport } from '../src/engine/pas/rdrprt.ts';
import { Rdb } from '../src/engine/fand/rdb.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const WORK = join(ROOT, 'work/tmp-rdedit-rprt');
const haveApp = existsSync(join(APP, 'UCTO2026.RDB')) && existsSync(join(APP, 'FAND.RES'));

/** Byte string of a Unicode text (CP852) and back. */
const B = (u: string): string =>
  Array.from(u, (c) => (c.charCodeAt(0) < 0x20 ? c : String.fromCharCode(...encode852(c)))).join('');
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

/** The text of compile error N (message 1000+N). */
function msg(n: number): string {
  RdMsg(1000 + n);
  return U(BaseVars.MsgLine);
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
    return U(BaseVars.MsgLine) || `error ${BaseVars.LastExitCode}`;
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
  RdRunVars.EditDRoot = null;
}

/** A console that fails instead of waiting for a key or a delay (nothing may wait in these tests). */
class NoWaitCrt extends Crt {
  override readKey(timeoutMs = Infinity): ReturnType<Crt['readKey']> {
    if (timeoutMs === Infinity) throw new Error('test: readKey would wait');
    return super.readKey(0);
  }
  override delay(ms: number): void {
    throw new Error(`test: delay ${ms} ms`);
  }
}

beforeAll(() => {
  SetDriversCrt(new NoWaitCrt(new KeyQueue(), null, 80, 25));
  FormatCache();
  if (haveApp) loadResMessages();
});
beforeEach(() => resetCompiler());

/** A fresh RDB with the given file declarations compiled from strings. */
function setupFiles(decls: [string, string, string][]): FileD[] {
  AccessVars.LinkDRoot = null;
  const chpt = new FileD();
  chpt.Name = 'TEST';
  const R = new RdbD();
  R.FD = chpt;
  AccessVars.FileDRoot = chpt;
  AccessVars.CRdb = R;
  AccessVars.CatFD = null;
  return decls.map(([name, typ, src]) => {
    SetInpStr(ref(B(src)));
    ok(() => RdFileD(B(name), typ, ''));
    return AccessVars.CFile!;
  });
}
function fld(fd: FileDPtr, name: string): FieldDPtr {
  for (let f = fd!.FldD; f !== null; f = f.Chain) if (U(f.Name) === name) return f;
  throw new Error(`no field ${name}`);
}
function compileReport(src: string, RO: RprtOpt | null = null): void {
  SetInpStr(ref(B(src)));
  ok(() => ReadReport(RO));
}
/** The text lines of a compiled block: [line length, stored bytes as numbers]. */
function blkLines(b: BlkDPtr): [number, number[]][] {
  const out: [number, number[]][] = [];
  const t = b!.Txt!;
  let p = 0;
  for (let i = 0; i < b!.NTxtLines; i++) {
    const ln = t[p];
    const n = t[p + 1] | (t[p + 2] << 8);
    out.push([ln, Array.from(t.subarray(p + 3, p + 3 + n))]);
    p += 3 + n;
  }
  expect(p).toBe(t.length);
  return out;
}
const bytes = (s: string): number[] => Array.from(encode852(s));

// ---------------------------------------------------------------- RDRPRT from strings

describe('RDRPRT: reports compiled from strings', () => {
  let adr: FileD;
  let pol: FileD;
  beforeEach(() => {
    [adr, pol] = setupFiles([
      ['ADR', 'X', 'Cislo:N,5; Nazev:A,20; Castka:F,10.2; Datum:D; Cas:R; Ok:B; Pozn:T; #K @ Cislo; Jm(@) Nazev;'],
      ['POL', 'X', 'Cislo:N,5; Mnozstvi:F,8.2; Popis:A,10; #K @ Cislo,Popis;'],
    ]);
  });

  it('inputs, blocks, field runs and the BlkD text layout', () => {
    compileReport(
      'VAR n:real;\r\n.PAGESIZE:=60;.PAGELIMIT:=55;\r\n#I1_ADR\r\n' +
        '#PH;\r\n  Hlavička\\\r\n' +
        '#DE Nazev,Castka,Datum,Ok;\r\n _____ ____.__ __.__.____ _\r\n' +
        '#RF (count>0) sum(Castka);\r\nCelkem ______.__\r\n',
    );
    const rv = RdRunVars;
    expect(rv.MaxIi).toBe(1);
    const id = rv.IDA[1]!;
    expect(id.Scan!.FD).toBe(adr);
    expect(id.Scan!.Key).toBe(null); // no /key: the record order
    expect([id.Op, id.OpErr, id.OpWarn]).toEqual([_const, _const, _const]);
    expect(id.ForwRecPtr!.length).toBe(adr.RecLen + 2);
    expect(adr.RecPtr!.length).toBe(adr.RecLen + 2);
    expect(rv.PgeSizeZ!.R).toBe(60);
    expect(rv.PgeLimitZ!.R).toBe(55);
    expect(U(rv.LVBD.Root!.Name)).toBe('n');
    // no match fields: the report level is the only main level
    expect(rv.FrstLvM).toBe(rv.LstLvM);
    expect(rv.OldMFlds).toBe(null);
    // DE level of I1 (no sort fields)
    expect(id.FrstLvS).toBe(id.LstLvS);
    expect(id.FrstLvS!.Fld).toBe(null);
    // #PH: leading blanks are counted in NBlksFrst, not stored; '\' at the end = FF2
    const ph = rv.PageHd!;
    expect(ph.NBlksFrst).toBe(2);
    expect(ph.FF2).toBe(true);
    expect(blkLines(ph)).toEqual([[10, bytes('Hlavička')]]);
    // #DE: A -> 'S' with its column, F,.2 -> 'R' (L,M), long date -> 'D' only #FF, B -> 'B' (L, 0)
    const de = id.FrstLvS!.Ft!;
    const rf = [] as [string, string, boolean][];
    for (let r = de.RFD; r !== null; r = r.Chain) rf.push([r.FrmlTyp, r.Typ, r.BlankOrWrap]);
    expect(rf).toEqual([
      ['S', 'S', false],
      ['R', 'R', false],
      ['R', 'D', true],
      ['B', 'B', false],
    ]);
    expect(de.NBlksFrst).toBe(1);
    expect(blkLines(de)).toEqual([[27, [0xff, 5, 2, 0x20, 0xff, 7, 2, 0x20, 0xff, 0x20, 0xff, 1, 0]]]);
    // #RF: condition, sum chained to I1 (first sum variable) and into the report level's zero list
    const ft = rv.LstLvM!.Ft!;
    expect(ft.Bool).not.toBe(null);
    expect(id.Sum).not.toBe(null);
    expect(id.Sum!.Chain).toBe(null);
    const zl = rv.LstLvM!.ZeroLst!;
    expect(zl.Chain).toBe(null);
    zl.RPtr!.v = 12.5;
    expect(id.Sum!.R).toBe(12.5);
    expect(blkLines(ft)).toEqual([[16, [...bytes('Celkem '), 0xff, 9, 2]]]);
    expect(rv.PFZeroLst).toBe(null);
    expect(rv.RprtHd).toBe(null);
  });

  it('match fields, two inputs, sort levels, #CH/#CF/#DH, auto sort, named block fields', () => {
    compileReport(
      '#I1_ADR! Cislo;Nazev\r\n#I2_POL\r\n' +
        '#RH;\r\n\\\r\n' +
        '#CH_Cislo;\r\nSkupina\r\n' +
        '#DH1;\r\nDetaily\r\n' +
        '#CH1_Nazev Nazev;\r\n_____\r\n' +
        '#DE2 Popis,Mnozstvi;\r\n__________ _____,__\r\n' +
        '#CF_Cislo s:=sum(I2.Mnozstvi), s*2;\r\n_____.__ ______.__\r\n' +
        '#PF .NOTATEND,.LINE<=3, page;\r\n__\r\n',
    );
    const rv = RdRunVars;
    expect(rv.MaxIi).toBe(2);
    const [i1, i2] = [rv.IDA[1]!, rv.IDA[2]!];
    // I2 has no match fields listed: copied by name from I1
    expect(i1.MFld!.FldD).toBe(fld(adr, 'Cislo'));
    expect(i2.MFld!.FldD).toBe(fld(pol, 'Cislo'));
    expect(i2.MFld!.Chain).toBe(null);
    // auto sort key of I1 = match fields + sort fields
    expect(i1.AutoSort).toBe(true);
    expect([i1.SK!.FldD, i1.SK!.Chain!.FldD, i1.SK!.Chain!.Chain]).toEqual([
      fld(adr, 'Cislo'),
      fld(adr, 'Nazev'),
      null,
    ]);
    expect(i1.SFld!.FldD).toBe(fld(adr, 'Nazev'));
    expect(i1.OldSFlds).not.toBe(null);
    // levels of I1: FrstLvS (DE) -> Nazev (= LstLvS)
    expect(i1.FrstLvS!.Chain).toBe(i1.LstLvS);
    expect(i1.LstLvS!.Fld).toBe(fld(adr, 'Nazev'));
    expect(i1.LstLvS!.ChainBack).toBe(i1.FrstLvS);
    // main levels: FrstLvM (Cislo) -> LstLvM (report)
    expect(rv.FrstLvM!.Fld).toBe(fld(adr, 'Cislo'));
    expect(rv.FrstLvM!.Chain).toBe(rv.LstLvM);
    expect(rv.OldMFlds).not.toBe(null);
    expect(rv.NewMFlds).not.toBe(null);
    // #RH '\' alone: an empty FF1 block becomes FF2 without lines
    expect([rv.RprtHd!.NTxtLines, rv.RprtHd!.FF1, rv.RprtHd!.FF2]).toEqual([0, false, true]);
    expect(rv.FrstLvM!.Hd!.NTxtLines).toBe(1);
    expect(i1.FrstLvS!.Hd!.NTxtLines).toBe(1);
    expect(i1.LstLvS!.Hd!.RFD!.Typ).toBe('S');
    // #DE2: fields of I2
    const de2 = i2.FrstLvS!.Ft!;
    expect(de2.RFD!.Frml!.Op).toBe(_newfile); // FrmlContxt: a field of I2's record
    expect(de2.RFD!.Frml!.P1!.Op).toBe(_field);
    expect(de2.RFD!.Chain!.Typ).toBe('F');
    expect(blkLines(de2)).toEqual([[19, [0xff, 10, 1, 0x20, 0xff, 8, 2]]]);
    // #CF_Cislo: the named sum field; sum over I2 chained to I2
    const cf = rv.FrstLvM!.Ft!;
    expect(U(cf.RFD!.Name)).toBe('s');
    expect(i2.Sum).not.toBe(null);
    expect(i1.Sum).toBe(null);
    expect(rv.FrstLvM!.ZeroLst!.RPtr).not.toBe(null);
    // #PF options
    const pf = rv.PageFt!;
    expect(pf.NotAtEnd).toBe(true);
    expect(pf.LineBound!.R).toBe(3);
    expect(pf.RFD!.Frml!.Op).toBe(_getwordvar);
    expect(pf.RFD!.Frml!.N01).toBe(1);
  });

  it('BEGIN..END assignments, IF, local variables, .LINE:=, .PAGE:=, NOTSOLO', () => {
    compileReport(
      'VAR n,m:real; t:string;\r\n#I_ADR (Castka>0)\r\n' +
        '#DE begin n:=n+1; if n>2 then begin m:=0; t:=\'x\' end else m+=1 end, ' +
        'n,.LINE:=5,.PAGE:=2,.NOTSOLO, begin t:=Nazev end;\r\n___\r\n' +
        '#RF;\r\n',
    );
    const rv = RdRunVars;
    const de = rv.IDA[1]!.FrstLvS!.Ft!;
    expect(rv.IDA[1]!.Bool).not.toBe(null);
    const bp = de.BeforeProc!;
    expect(bp.Kind).toBe(2 /* _locvar */ + 1);
    expect(U(bp.LV!.Name)).toBe('n');
    const iff = bp.Chain!;
    expect(iff.Kind).toBe(5); // _ifthenelseM
    expect(iff.Instr!.Chain!.LV!.Name).toBe('t');
    expect(iff.ElseInstr!.Add).toBe(true);
    expect(de.AfterProc!.LV!.Name).toBe('t');
    expect(de.RFD!.Frml!.Op).toBe(_getlocvar);
    expect([de.AbsLine, de.LineNo!.R, de.SetPage, de.PageNo!.R, de.DHLevel]).toEqual([true, 5, true, 2, 1]);
    // an empty #RF block
    expect(rv.LstLvM!.Ft!.NTxtLines).toBe(0);
    expect(rv.LstLvM!.Ft!.Txt).toBe(null);
  });

  it('COUNT/ERROR/WARNING/ERRORTEXT/GROUP, In. prefix, @ blank, ^P, time fields', () => {
    compileReport(
      '#I1_ADR Cislo\r\n#I2_POL Cislo\r\n' +
        '#DE1 I1.count, error, errortext, group, Cas, Cas, Pozn;\r\n' +
        '@@@@ __ ______ __ __:__ __:__:__.__ \x10\r\n#RF;\r\n',
    );
    const i1 = RdRunVars.IDA[1]!;
    const de = i1.FrstLvS!.Ft!;
    const f = [] as FrmlElem[];
    const t = [] as string[];
    for (let r = de.RFD; r !== null; r = r.Chain) {
      f.push(r.Frml!);
      t.push(r.Typ + (r.BlankOrWrap ? '@' : ''));
    }
    expect(t).toEqual(['R@', 'B', 'S', 'R', 'T', 'T', 'P']);
    f[0].R = 7;
    expect(i1.Count).toBe(7);
    f[1].B = true;
    expect(i1.Error).toBe(true);
    expect(f[2]).toBe(i1.ErrTxtFrml);
    expect(i1.ErrTxtFrml!.Op).toBe(_const);
    f[3].R = 3;
    expect(RdRunVars.MergOpGroup.Group).toBe(3);
    expect(blkLines(de)[0][1]).toEqual([
      0xff, 4, 0, 0x20, 0xff, 2, 0, 0x20, 0xff, 6, 9, 0x20, 0xff, 2, 0, 0x20, 0xff, 2, 3, 0x20, 0xff, 2, 9, 0x20, 0xff,
    ]);
    // ERRORTEXT: the input's checks (none compiled from strings: no chapter text)
    expect(i1.Chk).toBe(null);
  });

  it('auto report options (RprtOpt.FDL: view key, condition, key-in replace the chapter ones)', () => {
    const RO = new RprtOpt();
    RO.FDL.FD = adr;
    RO.FDL.ViewKey = adr.Keys!.Chain;
    const c = new FrmlElem(_const);
    c.B = true;
    RO.FDL.Cond = c;
    compileReport("#I1_POL (Cislo='1')\r\n#DE Nazev;\r\n___\r\n", RO);
    const id = RdRunVars.IDA[1]!;
    expect(id.Scan!.FD).toBe(adr);
    expect(id.Scan!.Key).toBe(adr.Keys!.Chain);
    expect(id.Bool).toBe(c); // RunEvalFrml(FDL^.Cond)
  });

  it.skipIf(!haveApp)('compile errors', () => {
    const err = (src: string): string | null => compileErr(() => ReadReport((SetInpStr(ref(B(src))), null)));
    expect(err('#I1_ADR\r\n#DE Nazev;\r\n_____ _____\r\n')).toBe(null); // a repeated group
    expect(err('#I1_ADR\r\n#DE Nazev,Cislo;\r\n_____\r\n')).toBe(msg(30)); // more fields than runs
    expect(err('#I1_ADR\r\n#DE;\r\n_____\r\n')).toBe(msg(30)); // a run without fields
    expect(err('#I1_ADR\r\n#XX;\r\n')).toBe(msg(57));
    expect(err('#I1_ADR\r\n#DE Castka;\r\n__,__\r\n')).toBe(null);
    expect(err('#I1_ADR\r\n#DE Nazev;\r\n__,__\r\n')).toBe(msg(12)); // ',' needs a number
    expect(err('#I1_ADR\r\n#DE Datum;\r\n__.__.___\r\n')).toBe(msg(71));
    expect(err('#I1_ADR\r\n#DE Castka;\r\n__:_\r\n')).toBe(msg(69));
    expect(err('#I1_ADR\r\n#DE Ok;\r\n@@\r\n')).toBe(msg(80)); // '@' only for R,F,S
    expect(err('#I1_ADR\r\n#DE Nazev;\r\n_____ @@@@@\r\n')).toBe(null); // '@' after '_': allowed
    expect(err('#I1_ADR\r\n#DE Nazev;\r\n@@@@@ _____\r\n')).toBe(msg(73)); // '_' after '@'
    expect(err('#I1_ADR\r\n#DE Nazev;\r\n__.__\r\n')).toBe(msg(12));
    expect(err('#I1_ADR\r\n#DE Castka;\r\n__.__,\r\n')).toBe(msg(95));
    expect(err('#I2_ADR\r\n#DE;\r\n')).toBe(msg(61));
    expect(err('#X1_ADR\r\n#DE;\r\n')).toBe(msg(89));
    expect(err('#I1_ADR\r\n#I2_ADR\r\n#DE;\r\n')).toBe(msg(26)); // the same file twice
    expect(err('#I1_ADR\r\n#CH_Nazev;\r\n')).toBe(msg(46)); // not a level
    expect(err('#I1_ADR\r\n#DE3;\r\n')).toBe(msg(62));
    expect(err('#I1_ADR\r\n#DE x:=1, x;\r\n__ __\r\n')).toBe(null); // a named block field
    expect(err('VAR x:real;\r\n#I1_ADR\r\n#DE x:=1;\r\n')).toBe(msg(26)); // named like a variable
    expect(err('#I1_ADR\r\n#DE begin Nazev:=1 end;\r\n')).toBe(msg(147));
    expect(err('#I1_ADR\r\n#DE .XY;\r\n')).toBe(msg(54));
    expect(err('.XY:=1;#I1_ADR\r\n#DE;\r\n')).toBe(msg(56));
    expect(err('#I1_ADR Cislo\r\n#I2_POL Mnozstvi\r\n#DE;\r\n')).toBe(msg(12));
    expect(err('#I1_ADR\r\n#I2_POL Cislo\r\n#DE;\r\n')).toBe(msg(22));
    expect(err('#I1_ADR!\r\n#DE;\r\n')).toBe(msg(60)); // auto sort without keys
    expect(err('#I1_ADR\r\n#RF sum(count);\r\n__\r\n')).toBe(msg(41));
  });
});

// ---------------------------------------------------------------- RDEDIT from strings

describe('RDEDIT: forms from strings, automatic layout, NewEditD', () => {
  let adr: FileD;
  beforeEach(() => {
    [adr] = setupFiles([
      ['ADR', 'X', 'Cislo:N,5; Nazev:A,20; Castka:F,10.2; Pozn:T; #K @ Cislo;'],
    ]);
  });
  /** A form position whose text is a string formula (RdbPos.IRec = 0). */
  function formPos(src: string): RdbPos {
    const z = new FrmlElem(_const);
    z.S = B(src);
    const RP = new RdbPos();
    RP.Frml = z;
    return RP;
  }
  const lines = (e: EditD): string[][] => {
    const out: string[][] = [];
    for (let rt = e.RecTxt; rt !== null; rt = rt.Chain) {
      const l: string[] = [];
      for (let sl = rt.SL; sl !== null; sl = sl.Chain) l.push(U(sl.S));
      out.push(l);
    }
    return out;
  };

  it('PushEdit: a new EditD with the default window', () => {
    PushEdit();
    const e = RdRunVars.EditDRoot!;
    expect([e.V.C1, e.V.R1, e.V.C2, e.V.R2]).toEqual([1, 2, 80, 24]);
    expect(e.PrevE).toBe(null);
    PushEdit();
    expect(RdRunVars.EditDRoot!.PrevE).toBe(e);
  });

  it('RdEForm: head lines, scan order, field positions, pages', () => {
    const L = fld(adr, 'Castka')!.L;
    PushEdit();
    const e = RdRunVars.EditDRoot!;
    const src =
      '{komentář}\r\n  Adresy\r\n#_ADR Cislo,3:Nazev,2:Castka,4:Pozn;\r\n' +
      `Číslo: _____ Název: ____________\r\nČástka: ${'_'.repeat(L)}\\\r\nPozn: _\r\n`;
    ok(() => RdFormOrDesign(null, null, formPos(src)));
    expect(e.IsUserForm).toBe(true);
    expect(e.FD).toBe(adr);
    expect([e.FrstCol, e.LastCol, e.FrstRow, e.LastRow, e.Rows]).toEqual([1, 80, 2, 24, 23]);
    expect(e.NHdTxt).toBe(1);
    expect(U(e.HdTxt!.S)).toBe('  Adresy');
    expect(e.NPages).toBe(2);
    expect(lines(e)).toEqual([
      ['Číslo:       Název:             ', `Částka: ${' '.repeat(L)}`],
      ['Pozn:  '],
    ]);
    expect([e.RecTxt!.N, e.RecTxt!.Chain!.N]).toEqual([2, 1]);
    // ordered by ScanNr: Cislo(1), Castka(2), Nazev(3), Pozn(4)
    const d = [] as [string, number, number, number, number][];
    for (let D = e.FirstFld; D !== null; D = D.Chain) d.push([U(D.FldD!.Name), D.Col, D.Ln, D.Page, D.L]);
    expect(d).toEqual([
      ['Cislo', 8, 1, 1, 5],
      ['Castka', 9, 2, 1, L],
      ['Nazev', 21, 1, 1, 12],
      ['Pozn', 7, 1, 2, 1],
    ]);
    expect(e.LastFld!.FldD).toBe(fld(adr, 'Pozn'));
    expect(e.LastFld!.ChainBack!.FldD).toBe(fld(adr, 'Nazev'));
    expect(e.FirstFld!.ChainBack).toBe(null);
    // the field list in the order of the form
    const fl = [] as string[];
    for (let f = e.Flds; f !== null; f = f.Chain) fl.push(U(f.FldD!.Name));
    expect(fl).toEqual(['Cislo', 'Nazev', 'Castka', 'Pozn']);
  });

  it.skipIf(!haveApp)('RdEForm errors', () => {
    const err = (src: string): string | null =>
      compileErr(() => {
        PushEdit();
        RdFormOrDesign(null, null, formPos(src));
      });
    expect(err('#_ADR Cislo;\r\n___\r\n')).toMatch(/.+/); // 79: wrong length
    expect(err('#_ADR Cislo;\r\n_____ _____\r\n')).toMatch(/.+/); // 30: more runs
    expect(err('#_ADR Cislo,Nazev;\r\n_____\r\n')).toMatch(/.+/); // 30: more fields
    expect(err('#_ADR 1:Cislo,1:Nazev;\r\n_____ ___\r\n')).toMatch(/.+/); // 77
    expect(err('#_ADR Cislo;\r\nx\r\n')).toMatch(/.+/); // 81: page without fields
    expect(err('hlava\r\n')).toMatch(/.+/); // 76
    expect(err(`#_ADR Cislo;\r\n${' '.repeat(80)}_____\r\n`)).toMatch(/.+/); // 102
  });

  it('AutoDesign: centred names, pages, a single-line form becomes head + record', () => {
    PushEdit();
    const e = RdRunVars.EditDRoot!;
    ok(() => RdFormOrDesign(adr, AllFldsList(adr, false), new RdbPos()));
    expect(e.IsUserForm).toBe(false);
    expect(e.NPages).toBe(1);
    // all fields fit one line: names become the head line, the record text is one empty line
    expect(e.NHdTxt).toBe(1);
    const L = fld(adr, 'Castka')!.L;
    const w = Math.max(L, 6);
    const LT = fld(adr, 'Pozn')!.L; // a T field: its length counts for the layout, D.L = 1
    const lt = Math.max(LT, 4);
    const center = (n: string, l: number): string => {
      const m = Math.trunc((l - n.length + 1) / 2);
      return ' '.repeat(m) + n + ' '.repeat(l - n.length - m + 1);
    };
    expect(U(e.HdTxt!.S)).toBe(center('Cislo', 5) + center('Nazev', 20) + center('Castka', w) + center('Pozn', lt));
    expect(lines(e)).toEqual([['']]);
    const d = [] as [number, number, number][];
    for (let D = e.FirstFld; D !== null; D = D.Chain) d.push([D.Col, D.Ln, D.L]);
    expect(d).toEqual([
      [1, 1, 5],
      [7, 1, 20],
      [28 + Math.trunc((w - L + 1) / 2), 1, L],
      [29 + w + Math.trunc((lt - LT + 1) / 2), 1, 1],
    ]);
    expect(e.LastFld!.FldD).toBe(fld(adr, 'Pozn'));
    // a window of one row: no head line
    PushEdit();
    const e1 = RdRunVars.EditDRoot!;
    e1.V.R2 = e1.V.R1;
    ok(() => RdFormOrDesign(adr, AllFldsList(adr, false), new RdbPos()));
    expect([e1.Rows, e1.NHdTxt, e1.HdTxt]).toEqual([1, 0, null]);
  });

  it('AutoDesign: wraps lines, pages, the dashed line under a short form', () => {
    const [big] = setupFiles([
      ['BIG', 'X', Array.from({ length: 30 }, (_, i) => `Pole${i}:A,30;`).join(' ') + ' #K @ Pole0;'],
    ]);
    PushEdit();
    const e = RdRunVars.EditDRoot!;
    ok(() => RdFormOrDesign(big, AllFldsList(big, false), new RdbPos()));
    // two 31-column fields per 80-column line, 2 text lines each, 23 rows -> 11 lines per page
    // 15 lines of 2 fields: 11 on page 1 (22 rows), 4 on page 2
    expect(e.NPages).toBe(2);
    expect(lines(e).map((p) => p.length)).toEqual([22, 8]);
    expect(e.RecTxt!.N).toBe(22);
    const last = e.LastFld!;
    expect([last.Page, last.Ln, last.Col]).toEqual([2, 8, 32]);
    // a two-line form in a larger window gets a dashed line
    const [two] = setupFiles([['TWO', 'X', 'A:A,50; Bb:A,50; #K @ A;']]);
    PushEdit();
    const e2 = RdRunVars.EditDRoot!;
    ok(() => RdFormOrDesign(two, AllFldsList(two, false), new RdbPos()));
    expect(e2.RecTxt!.N).toBe(5);
    expect(lines(e2)[0][4]).toBe('-'.repeat(80));
  });

  it('NewEditD: options, mode flags, colours, standard head, tab/dupl/noed lists, key checks', () => {
    BaseVars.Colors.dTxt = 0x17;
    BaseVars.Colors.dNorm = 0x1f;
    const EO = new EditOpt();
    const mode = new FrmlElem(_const);
    mode.S = '^Y01';
    EO.Mode = mode;
    const fl = AllFldsList(adr, false)!;
    EO.Flds = fl;
    const tab = { Chain: null, FldD: fld(adr, 'Nazev') };
    EO.Tab = tab;
    EO.NegNoEd = true; // NoEd = nil negated: nothing editable
    ok(() => NewEditD(adr, EO));
    const e = RdRunVars.EditDRoot!;
    expect(e.FD).toBe(adr);
    expect([e.Attr, e.dNorm, e.dTab]).toEqual([0x17, 0x1f, 0x1f]);
    expect([e.NoDelete, e.Only1Record, e.OnlySearch]).toEqual([true, true, false]);
    expect(e.NRecs).toBe(22);
    expect([e.BaseRec, e.IRec, e.ChkSwitch, e.WarnSwitch, e.AddSwitch]).toEqual([1, 1, true, true, true]);
    expect(e.CFld).toBe(e.FirstFld);
    expect(e.VK).toBe(adr.Keys);
    expect(e.OldRecPtr).not.toBe(e.NewRecPtr);
    expect(U(e.Head!)).toBe(' '.repeat(17) + 'ADR' + '          ______                                 __.__.____');
    expect(e.Last).toBe(null);
    expect(e.NFlds).toBe(4);
    expect([e.NTabsSet, e.NEdSet, e.NDuplSet]).toEqual([1, 0, 4]);
    let D = e.FirstFld;
    const tabs = [] as boolean[];
    for (; D !== null; D = D.Chain) tabs.push(D.Tab);
    expect(tabs).toEqual([false, true, false, false]);
    // the unique key @Cislo is checked at its field
    expect(e.FirstFld!.KL!.Key).toBe(adr.Keys);
    expect(e.FirstFld!.Chain!.KL).toBe(null);
    expect(e.AfterE).toBe(null);
  });

  it('NewEditD: record variable, OnlyTabs without tabs', () => {
    const EO = new EditOpt();
    EO.Flds = AllFldsList(adr, true);
    EO.LVRecPtr = new Uint8Array(adr.RecLen + 2);
    EO.SetOnlyView = true;
    ok(() => NewEditD(adr, EO));
    const e = RdRunVars.EditDRoot!;
    expect([e.EdRecVar, e.Only1Record, e.NoDelete, e.NoCreate, e.OnlyTabs]).toEqual([true, true, true, true, true]);
    expect(e.NewRecPtr).toBe(EO.LVRecPtr);
    expect(U(e.Head!)).toBe(' '.repeat(20) + '          ______                                 __.__.____'); // no name
    expect(e.NEdSet).toBe(0);
  });
});

// ---------------------------------------------------------------- RDRUN

describe('RDRUN: frames, exit keys, #A locking, compile-all', () => {
  it('PushProcStk / PopProcStk: typed zero slots, Init formulas, frame chain', () => {
    setupFiles([]);
    ResetLVBD();
    SetInpStr(ref(B("a,b:real; s:string; t:boolean; c:real=5; begin")));
    RdLex();
    ok(() => RdLocDcl(RdRunVars.LVBD, false, false, 'P'));
    const old = BaseVars.MyBP;
    PushProcStk();
    const bp = BaseVars.MyBP!;
    expect(bp.ChainBack).toBe(old);
    expect(bp.LVRoot).toBe(RdRunVars.LVBD.Root);
    const vals: Record<string, number | boolean> = {};
    for (let lv = bp.LVRoot; lv !== null; lv = lv.Chain) vals[lv.Name] = bp.V[lv.BPOfs];
    expect(vals).toEqual({ a: 0, b: 0, s: 0, t: false, c: 5 });
    PopProcStk();
    expect(BaseVars.MyBP).toBe(old);
    // SetMyBP
    const f = new ProcStkD();
    f.LVRoot = new LocVar();
    SetMyBP(f);
    expect(RdRunVars.LVBD.Root).toBe(f.LVRoot);
    SetMyBP(null);
    expect(RdRunVars.LVBD.Root).toBe(null);
    BaseVars.MyBP = old;
  });

  it('TestExitKey', () => {
    const X = new EdExitD();
    const k1 = new EdExKeyD();
    k1.KeyCode = 0x3b00;
    k1.Break = 12;
    const k2 = new EdExKeyD();
    k2.KeyCode = 0x1c0d;
    k2.Break = 13;
    k1.Chain = k2;
    X.Keys = k1;
    expect(TestExitKey(0x1c0d, X)).toBe(true);
    expect(AccessVars.EdBreak).toBe(13);
    expect(TestExitKey(0x0001, X)).toBe(false);
  });

  it('LockForAdd remembers and restores the lock modes of the #A target files; RunAddUpdte1 stops at StopAD', () => {
    const [a, b, c] = setupFiles([
      ['A1', 'X', 'K:N,3; #K @ K;'],
      ['B1', 'X', 'K:N,3; #K @ K;'],
      ['C1', 'X', 'K:N,3; #K @ K;'],
    ]);
    const ad1 = new AddD();
    ad1.File2 = b;
    const ad2 = new AddD();
    ad2.File2 = c;
    ad1.Chain = ad2;
    a.Add = ad1;
    const adc = new AddD();
    adc.File2 = c;
    b.Add = adc;
    b.LMode = RdMode;
    c.LMode = NullMode;
    const md = ref(NullMode);
    expect(LockForAdd(a, 0, false, md)).toBe(true);
    expect([b.ExLMode, c.ExLMode]).toEqual([RdMode, NullMode]);
    expect(LockForAdd(a, 0, true, md)).toBe(true);
    expect(b.TaLMode).toBe(RdMode);
    // Kind 2 with closed files (Handle $FF): OldLMode does nothing
    expect(LockForAdd(a, 2, false, md)).toBe(true);
    expect(AccessVars.CFile).toBe(c);
    // RunAddUpdte1: no #A, or StopAD first -> true, CFile kept
    AccessVars.CFile = c;
    expect(RunAddUpdte1('+', null, false, null, null)).toBe(true);
    AccessVars.CFile = a;
    expect(RunAddUpdte1('+', null, true, ad1, null)).toBe(true);
    expect(AccessVars.CFile).toBe(a);
  });

  it('SetCompileAll', () => {
    const tf = { CompileAll: false, TimeStmp: 0, Handle: 0xff } as unknown as NonNullable<typeof AccessVars.ChptTF>;
    const old = AccessVars.ChptTF;
    AccessVars.ChptTF = tf;
    SetCompileAll();
    expect(tf.CompileAll).toBe(true);
    expect(tf.TimeStmp).toBeGreaterThan(40000);
    AccessVars.ChptTF = old;
  });
});

// ---------------------------------------------------------------- Účto projects

interface ProjectResult {
  name: string;
  counts: Record<string, number>;
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
  SetInpStr(ref(s));
  RdFileD(FromUnicode(basename(path, extname(path))), '0', '');
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
  if (process.env.RDEDIT_TRACE) appendFileSync(process.env.RDEDIT_TRACE, `RdPrefixes ${path}\n`);
  RdPrefixes();
  if (process.env.RDEDIT_TRACE) appendFileSync(process.env.RDEDIT_TRACE, `RdPrefixes done\n`);
  R.Encrypted = new Rdb(path, tpath).encrypted;
  if (R.ChainBack !== null) R.HelpFD = R.ChainBack.HelpFD;
  return R;
}

/** Statistics of a NewEditD result: the #D/#L/#I sections and key checks it attached. */
function countEdit(e: EditD, inc: (k: string) => void): void {
  for (let D = e.FirstFld; D !== null; D = D.Chain) {
    for (let c = D.Chk; c !== null; c = c.Chain) inc('#L');
    for (let d = D.Dep; d !== null; d = d.Chain) inc('#D');
    if (D.Impl !== null) inc('#I');
    for (let k = D.KL; k !== null; k = k.Chain) inc('key');
    expect(D.Col).toBeGreaterThanOrEqual(e.FrstCol);
    expect(D.Col + D.L - 1).toBeLessThanOrEqual(e.LastCol);
    expect(D.Page).toBeGreaterThanOrEqual(1);
    expect(D.Page).toBeLessThanOrEqual(e.NPages);
  }
  for (let i = e.Impl; i !== null; i = i.Chain) inc('#I');
  expect(e.Head).not.toBe(null);
}
/** Statistics of a compiled report; every block text must parse in the RUNRPRT layout. */
function countReport(inc: (k: string) => void): void {
  const rv = RdRunVars;
  const blocks = (b: BlkDPtr): void => {
    for (; b !== null; b = b.Chain) {
      inc('blocks');
      for (let i = 0; i < b.NTxtLines; i++) inc('lines');
      if (b.NTxtLines > 0) blkLines(b);
      for (let s = b.Sum; s !== null; s = s.Chain) inc('sums');
    }
  };
  blocks(rv.RprtHd);
  blocks(rv.PageHd);
  blocks(rv.PageFt);
  for (let L: LvDescrPtr = rv.FrstLvM; L !== null; L = L.Chain) {
    blocks(L.Hd);
    blocks(L.Ft);
  }
  for (let i = 1; i <= rv.MaxIi; i++) {
    for (let L: LvDescrPtr = rv.IDA[i]!.FrstLvS; L !== null; L = L.Chain) {
      blocks(L.Hd);
      blocks(L.Ft);
    }
    for (let s = rv.IDA[i]!.Sum; s !== null; s = s.Chain) inc('sums');
  }
}

/** PROJMGR.CompileRdb for the F, D, E and R chapters; each E form also goes through NewEditD. */
function compileProject(R: RdbD, name: string): ProjectResult {
  const a = AccessVars;
  const res: ProjectResult = { name, counts: {}, errors: [] };
  const inc = (k: string): void => {
    res.counts[k] = (res.counts[k] ?? 0) + 1;
  };
  const chpt = R.FD!;
  for (let I = 1; I <= chpt.NRecs; I++) {
    a.CFile = chpt;
    a.CRecPtr = chpt.RecPtr;
    ReadRec(I);
    const typ = _ShortS(a.ChptTyp)[0];
    const Name = _ShortS(a.ChptName).replace(/ +$/, '');
    const Txt = _T(a.ChptTxt);
    if (!(process.env.RDEDIT_TYPES ?? 'FDER').includes(typ)) continue;
    if (process.env.RDEDIT_TRACE) appendFileSync(process.env.RDEDIT_TRACE, `${name} #${I} ${typ} ${U(Name)}\n`);
    const RP = new RdbPos();
    RP.R = R;
    RP.IRec = I;
    a.InpRdbPos = RP;
    a.IsCompileErr = false;
    let step = typ;
    const er = new ExitRecord();
    NewExit(null, er);
    try {
      switch (typ) {
        case 'F': {
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
          inc('F');
          // an automatic form of the file with its #D/#L/#I sections (as EDIT without a form)
          const fd = a.CFile!;
          if (fd.Typ !== 'D' || fd.FldD !== null) {
            step = 'F-auto-NewEditD';
            const EO = new EditOpt();
            EO.Flds = AllFldsList(fd, false);
            const OldE = RdRunVars.EditDRoot;
            NewEditD(fd, EO);
            countEdit(RdRunVars.EditDRoot!, inc);
            RdRunVars.EditDRoot = OldE;
            inc('F-auto');
          }
          break;
        }
        case 'D':
          ResetCompilePars();
          SetInpTTPos(Txt, R.Encrypted);
          ReadDeclChpt();
          inc('D');
          break;
        case 'E': {
          const OldE = RdRunVars.EditDRoot;
          PushEdit();
          RdFormOrDesign(null, null, RP);
          RdRunVars.EditDRoot = OldE;
          inc('E');
          step = 'E-NewEditD';
          const EO = new EditOpt();
          EO.FormPos = RP;
          NewEditD(null, EO);
          countEdit(RdRunVars.EditDRoot!, inc);
          RdRunVars.EditDRoot = OldE;
          inc('E-NewEditD');
          break;
        }
        case 'R':
          SetInpTTPos(Txt, R.Encrypted);
          ReadReport(null);
          countReport(inc);
          inc('R');
          break;
      }
    } catch (e) {
      if (e instanceof NotImplementedError) {
        res.errors.push(`${name} #${I} ${step} ${U(Name)}: ${e.message}`);
      } else {
        if (!(e instanceof GoExitSignal)) {
          throw new Error(`${name} #${I} ${step} ${U(Name)}: ${(e as Error).stack}`);
        }
        res.errors.push(`${name} #${I} ${step} ${U(Name)}: ${U(BaseVars.MsgLine)} @${BaseVars.LastExitCode}`);
      }
    } finally {
      RestoreExit(er);
    }
  }
  a.CFile = chpt;
  a.CRecPtr = chpt.RecPtr;
  return res;
}

/**
 * Who CALLs whom (as in pas-lexer-frml.test.ts): a sub-project sees the files, links and functions
 * of the project that called it, so it is compiled on top of that chain. callee -> callers.
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
  UPG04: ['UPG', 'MODUL04'],
  UPG07: ['UPG'], UPG08: ['UPG'], UPG09: ['UPG'],
  UPG97: ['UPG04'],
  UPG99: ['UPG', 'UPG02', 'UPG04', 'UPG05', 'UPG06', 'UPG08', 'UPG09'],
};

describe.skipIf(!haveApp)('Účto: every E and R chapter compiles', () => {
  const projects = haveApp ? readdirSync(APP).filter((f) => /\.(RDB|PRO)$/i.test(f)).sort() : [];
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

  /** A compiled project: its RdbD and the global chains right after its chapters. */
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
    const a = AccessVars;
    BaseVars.Spec.CPMdrive = ' ';
    // the catalog (PROJMGR: message 52), declared only: the Catalog form and #_CATALOG need it
    a.FileDRoot = null;
    RdMsg(52);
    SetInpStr(ref(BaseVars.MsgLine));
    ok(() => RdFileD('Catalog', 'C', ''));
    a.CatFD = a.CFile;
    a.FileDRoot = null;
    const results: ProjectResult[] = [];
    for (const f of projects) {
      const name = f.replace(/\.(RDB|PRO)$/i, '').toUpperCase();
      // the first call chain in which the project compiles cleanly, else the errors of the first one
      let first: ProjectResult | null = null;
      let good: ProjectResult | null = null;
      for (const ch of chainsTo(name)) {
        const r = compileChain(ch).res;
        first ??= r;
        if (r.errors.length === 0) {
          good = r;
          break;
        }
      }
      results.push(good ?? first!);
    }
    a.CRdb = null;
    a.CatFD = null;
    const errors = results.flatMap((r) => r.errors);
    const total: Record<string, number> = {};
    for (const r of results) for (const [k, n] of Object.entries(r.counts)) total[k] = (total[k] ?? 0) + n;
    console.log(`${results.length} projects compiled:`, JSON.stringify(total));
    if (process.env.RDEDIT_ERRORS) appendFileSync(process.env.RDEDIT_ERRORS, errors.join('\n') + '\n');
    expect(errors).toEqual([]);
    expect(results.length).toBe(projects.length);
    expect(total.E).toBeGreaterThan(700);
    expect(total.R).toBeGreaterThan(900);
    expect(total['E-NewEditD']).toBe(total.E);
    expect(total['F-auto']).toBe(total.F);
    for (const k of ['#L', '#D', '#I', 'key', 'blocks', 'lines', 'sums']) expect(total[k]).toBeGreaterThan(50);
  });
});
