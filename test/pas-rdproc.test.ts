// rdproc package: RDPROC.PAS (procedure chapters P, declaration chapters D, EVAL) and RDMERG.PAS
// (merge chapters M). Procedures and merges compiled from strings, and every F, D, M and P chapter
// of all Účto projects, compiled in chapter order the way PROJMGR.CompileRdb does it.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, mkdirSync, cpSync, rmSync, appendFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

// Routines of other packages that this package calls at compile time but that may still be stubs:
// fall back to a minimal version only while the real one throws NotImplementedError.
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
    // RUNFRML.GetFromKey
    GetFromKey: fb(m.GetFromKey, (LD) => {
      let K = LD!.FromFD!.Keys;
      while (K!.IndexRoot !== LD!.IndexRoot) K = K!.Chain;
      return K;
    }),
    // only the string constants used by the EVAL tests
    RunLongStr: fb(m.RunLongStr, (Z) => {
      if (Z === null || Z.Op !== '\x10') throw new Error('RunLongStr fallback: constants only');
      return Uint8Array.from(Z.S, (c: string) => c.charCodeAt(0));
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

import { ref, fref, getWord, GoExitSignal, FromUnicode } from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, OpenH, ReadH, PosH, _isoldfile, RdOnly, NewExit, RestoreExit, ExitRecord, RdMsg, LastInChain, FormatCache, CloseClearH,
  type TMsgIdxItem,
} from '../src/engine/pas/base.ts';
import { SetDriversCrt } from '../src/engine/pas/drivers.ts';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { encode852, decode852 } from '../src/engine/console/cp852.ts';
import {
  AccessVars, FileD, RdbD, RdbPos, ResetCompilePars, GetRecSpace, ReadRec, RdPrefixes, _ShortS, _T,
  _const, _setmybp, _eval, _plus, _times, _userfunc, _newfile, _field,
  type FrmlPtr, type FileDPtr, type LocVarPtr,
} from '../src/engine/pas/access.ts';
import { SetInpStr, SetInpTTPos, RdLex, RdFrml } from '../src/engine/pas/compile.ts';
import { RdFileD } from '../src/engine/pas/rdfildcl.ts';
import { ReadProcHead, ReadProcBody, ReadDeclChpt, GetEvalFrml } from '../src/engine/pas/rdproc.ts';
import { ReadMerge } from '../src/engine/pas/rdmerg.ts';
import {
  RdRunVars, PInstrCodeNames, _move, _output, _locvar, _parfile, _ifthenelseM, _zero,
  type Instr, type InstrPtr, type AssignDPtr, type WrLnD,
} from '../src/engine/pas/rdrun.ts';
import { Rdb } from '../src/engine/fand/rdb.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const WORK = join(ROOT, 'work/tmp-rdproc');
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
  // a closed key queue: anything that waits for a key (an unexpected error message) throws
  // EngineShutdown instead of hanging the test
  const kq = new KeyQueue();
  kq.close();
  SetDriversCrt(new Crt(kq, null, 80, 25));
  FormatCache();
  if (haveApp) loadResMessages();
});
beforeEach(() => resetCompiler());

// ---------------------------------------------------------------- from strings

/** Instruction names without the leading '_'. */
const kindName = (k: number): string => PInstrCodeNames[k].slice(1);
/** A compact dump of an instruction chain: kinds, nested bodies in (). */
function dumpP(pd: InstrPtr): string {
  const out: string[] = [];
  for (let p = pd; p !== null; p = p.Chain) {
    const k = kindName(p.Kind);
    switch (k) {
      case 'ifthenelseP':
        out.push(`if(${dumpP(p.Instr)}|${dumpP(p.ElseInstr)})`);
        break;
      case 'whiledo':
      case 'repeatuntil':
        out.push(`${k}(${dumpP(p.Instr)})`);
        break;
      case 'forall':
        out.push(`forall(${dumpP(p.CInstr)})`);
        break;
      case 'menubox':
      case 'menubar': {
        const ch: string[] = [];
        for (let c = p.Choices; c !== null; c = c.Chain) ch.push(dumpP(c.Instr));
        out.push(`${k}(${ch.join('|')})`);
        break;
      }
      default:
        out.push(k);
    }
  }
  return out.join(';');
}

describe.skipIf(!haveApp)('RDPROC/RDMERG compiled from strings', () => {
  let R: RdbD;
  let adr: FileD;
  let fak: FileD;
  let par: FileD;
  function compileFD(name: string, typ: string, src: string): FileD {
    SetInpStr(ref(B(src)));
    ok(() => RdFileD(B(name), typ, ''));
    return AccessVars.CFile!;
  }
  /** A procedure chapter: head and body. */
  function proc(src: string): InstrPtr {
    SetInpStr(ref(B(src)));
    return ok(() => {
      ReadProcHead();
      return ReadProcBody();
    });
  }
  function procErr(src: string): string | null {
    SetInpStr(ref(B(src)));
    return compileErr(() => {
      ReadProcHead();
      ReadProcBody();
    });
  }
  function lvs(): string[] {
    const r: string[] = [];
    for (let lv: LocVarPtr = RdRunVars.LVBD.Root; lv !== null; lv = lv.Chain)
      r.push(`${U(lv.Name)}:${lv.FTyp}${lv.IsPar ? 'p' : ''}${lv.IsRetPar ? 'v' : ''}@${lv.BPOfs}`);
    return r;
  }
  beforeEach(() => {
    const a = AccessVars;
    a.LinkDRoot = null;
    a.CatFD = null;
    const chpt = new FileD();
    chpt.Name = 'TEST';
    R = new RdbD();
    R.FD = chpt;
    a.FileDRoot = chpt;
    a.CRdb = R;
    a.InpRdbPos = new RdbPos();
    adr = compileFD('ADR', 'X', 'Cislo:N,5; Nazev:A,30; Suma:F,10.2; Pozn:T; #K @ Cislo; Jm(@) Nazev;');
    fak = compileFD('FAK', 'X', 'Cislo:N,5; Adr:N,5; Castka:F,8.2; K:F,5,2; #K @ Cislo; ADR Adr;');
    par = compileFD('PAR', '6', 'A:F,5.0; S:A,10; #K @@;');
  });

  it('control statements, local variables and parameters', () => {
    const pd = proc(`(x:real; var s:string; r:record of ADR) var i:real; b:boolean=true; t:string; begin
      i:=1; while i<=x do begin i+=1; s:=s+'a' end;
      if i>3 then b:=true else b:=false;
      for i:=1 to 3 do writeln(i);
      case i=1: write('a'); i=2: write('b') else message('c') end;
      repeat i:=i-1 until i<0;
      forall i in ADR (Suma>1) do PAR.A:=0; forall r do r.Suma+=1;
      menu 'M' of 'a': exit; 'b',,i>1: cancel; escape: break end;
      exit;
    end;`);
    expect(dumpP(pd)).toBe(
      'asgnloc;whiledo(asgnloc;asgnloc);if(asgnloc|asgnloc);' +
        // FOR = v:=a; while v<=b do begin i; v+=1 end
        'asgnloc;whiledo(writeln;asgnloc);' +
        // CASE = nested if-then-else
        'if(writeln|if(writeln|writeln));repeatuntil(asgnloc);forall(asgnpar);forall(asgnrecfld);' +
        'menubox(exit|cancel);exit',
    );
    // BP7 frame layout: Size starts at 8, real 6, string 4 (TWork pos), boolean 1; records not in the frame
    expect(lvs()).toEqual(['x:Rp@8', 's:Spv@14', 'r:rp@0', 'i:R@18', 'b:B@24', 't:S@25']);
    expect(RdRunVars.LVBD.NParam).toBe(3);
    expect(RdRunVars.LVBD.Size).toBe(29);
    // FOR: the increment is 'i+=1'
    let p = pd!;
    for (let k = 0; k < 3; k++) p = p.Chain!;
    const inc = p.Chain!.Instr!.Chain!;
    expect([kindName(inc.Kind), inc.Add, inc.AssLV!.Name]).toEqual(['asgnloc', true, 'i']);
    // FORALL i IN ADR (cond): CVar i, no record var, CBool; FORALL r: CRecVar r, CFD = its file
    let fa = pd!;
    while (kindName(fa.Kind) !== 'forall') fa = fa.Chain!;
    expect([fa.CFD, fa.CVar!.Name, fa.CRecVar, fa.CBool !== null]).toEqual([adr, 'i', null, true]);
    const fr = fa.Chain!;
    expect([fr.CFD, fr.CVar, fr.CRecVar!.Name, fr.CBool]).toEqual([adr, null, 'r', null]);
    // MENU: head line, 3 choices, the second with a condition; ESCAPE branch
    const mb = fr.Chain!;
    expect([mb.Loop, mb.HdLine!.S, mb.WasESCBranch, kindName(mb.ESCInstr!.Kind)]).toEqual([false, 'M', true, 'break']);
    expect([mb.Choices!.TxtFrml!.S, mb.Choices!.Bool, mb.Choices!.Chain!.Bool !== null]).toEqual(['a', null, true]);
  });

  it('assignments', () => {
    const pd = proc(`(r:record of ADR) var i:real; s:string; q:record of ADR; f:record of FAK; begin
      i:=1; i+=2; s:='a'; PAR.A:=1; PAR.A+=r.Suma; PAR.S:='x'; r.Suma:=3; q:=r; f:=r;
      ADR[1].Nazev:='n'; ADR[i].Cislo:='1'; FAK[2].K:=1.5; ADR.nrecs:=0;
      usercode:=1; username:='u'; accright:='a'; edok:=true; today:=1.1.2020; randseed:=5; clipbd:='c';
    end;`);
    expect(dumpP(pd)).toBe(
      'asgnloc;asgnloc;asgnloc;asgnpar;asgnpar;asgnpar;asgnrecfld;asgnrecvar;asgnrecvar;' +
        'asgnfield;asgnfield;asgnfield;asgnnrecs;' +
        'asgnusercode;asgnusername;asgnaccright;asgnedok;asgnusertoday;asgnrand;asgnclipbd',
    );
    const L: Instr[] = [];
    for (let p = pd; p !== null; p = p.Chain) L.push(p);
    expect([L[0].Add, L[1].Add, L[4].Add, L[4].FD, L[4].FldD!.Name]).toEqual([false, true, true, par, 'A']);
    expect([L[6].AssLV!.Name, L[6].RecFldD!.Name]).toEqual(['r', 'Suma']);
    // q:=r (same file): every stored field is moved (_output); f:=r only the common Cislo
    const ass = (x: AssignDPtr): string[] => {
      const r: string[] = [];
      for (let a = x; a !== null; a = a.Chain) r.push(`${a.Kind === _output ? 'out' : 'zero'}:${U((a.OFldD ?? a.FldD)!.Name)}`);
      return r;
    };
    expect(ass(L[7].Ass)).toEqual(['out:Cislo', 'out:Nazev', 'out:Suma', 'out:Pozn']);
    expect(ass(L[8].Ass)).toEqual(['out:Cislo']);
    expect([L[8].RecLV1!.Name, L[8].RecLV2!.Name]).toEqual(['f', 'r']);
    // FILE[recno].field: IndexArg when the field is a key field of an X file
    expect([L[9].FD, L[9].FldD!.Name, L[9].Indexarg]).toEqual([adr, 'Nazev', true]);
    expect([L[10].FldD!.Name, L[10].Indexarg]).toEqual(['Cislo', true]);
    expect([L[11].FD, L[11].Indexarg]).toEqual([fak, false]);
    expect(L[12].FD).toBe(adr);
  });

  it('procedure calls and file instructions', () => {
    const pd = proc(`(r:record of ADR) var i:real; s:string; begin
      edit(ADR,(Cislo,Nazev),ww=(1,2,80,24),head='H',mode='^yli',cond=(Suma>0),exit=(F2,F3:,():quit));
      edit(r,(Nazev));
      sort(ADR,(Nazev,>Cislo));
      report(ADR,(Cislo,Nazev),head='R');
      readrec(r,1); writerec(r,i); appendrec(ADR); deleterec(ADR,2); recallrec(ADR,2);
      writeln('a',i:5:2,' ',s); write(i); message('m');
      gotoxy(1,2); clrscr; clreol; setkeybuf('x'); headline('h'); beep; wait; delay(10);
      with window(1,1,40,10) do begin writeln('x') end;
      with shared ADR(Rd) do i:=1 else i:=2;
      with locked ADR[1], FAK[2] do i:=1;
      indexfile(ADR); indexfile(FAK,compress);
      puttxt('A.TXT','x',append);
      exec('prog.exe','',nocancel);
    end;`);
    expect(dumpP(pd)).toBe(
      'edit;edit;sort;report;readrec;writerec;appendrec;deleterec;recallrec;writeln;writeln;writeln;' +
        'gotoxy;clrscr;clreol;setkeybuf;headline;beep;wait;delay;window;withshared;withlocked;' +
        'indexfile;indexfile;puttxt;exec',
    );
    const L: Instr[] = [];
    for (let p = pd; p !== null; p = p.Chain) L.push(p);
    const e = L[0];
    expect(e.EditFD).toBe(adr);
    const eo = e.EO!;
    const flds: string[] = [];
    for (let f = eo.Flds; f !== null; f = f.Chain) flds.push(f.FldD!.Name);
    expect(flds).toEqual(['Cislo', 'Nazev']);
    expect([eo.Head!.S, eo.Mode!.S, eo.Cond !== null]).toEqual(['H', '^yli', true]);
    expect(eo.ExD).not.toBe(null);
    // EDIT of a record variable
    expect([L[1].EditFD, L[1].EO!.Flds!.FldD!.Name]).toEqual([adr, 'Nazev']);
    // SORT keys: Nazev ascending, Cislo descending
    expect([L[2].SortFD, L[2].SK!.FldD!.Name, L[2].SK!.Descend, L[2].SK!.Chain!.Descend]).toEqual([adr, 'Nazev', false, true]);
    // REPORT: autoreport fields and head
    expect([L[3].RO!.Flds!.FldD!.Name, L[3].RO!.Head!.S, L[3].RO!.FDL.FD]).toEqual(['Cislo', 'R', adr]);
    // READREC(r,1) / WRITEREC(r,i): the record variable and its record number
    expect([L[4].LV!.Name, L[4].RecNr!.R, L[5].LV!.Name]).toEqual(['r', 1, 'r']);
    // WRITELN: LF 1 writeln, 0 write, 2 message; formatted real i:5:2
    expect([L[9].LF, L[10].LF, L[11].LF]).toEqual([1, 0, 2]);
    const wd: string[] = [];
    for (let w: WrLnD | null = L[9].WD; w !== null; w = w.Chain) wd.push(`${w.Typ}${w.N ? `:${w.N}:${w.M}` : ''}`);
    expect(wd).toEqual(['S', 'F:5:2', 'S', 'S']);
    // WITH SHARED ... ELSE, WITH LOCKED FD[n], FD[n]
    expect([L[21].WLD.FD, L[21].WasElse, kindName(L[21].WElseInstr!.Kind)]).toEqual([adr, true, 'asgnloc']);
    expect([L[22].WLD.FD, L[22].WLD.Chain!.FD, L[22].WasElse]).toEqual([adr, fak, false]);
    expect([L[23].IndexFD, L[23].Compress, L[24].IndexFD, L[24].Compress]).toEqual([adr, false, fak, true]);
    expect([L[25].TxtPath, L[25].App]).toEqual(['A.TXT', true]);
    expect([L[26].ProgPath, L[26].NoCancel]).toEqual(['prog.exe', true]);
  });

  it('compile errors', () => {
    // FORALL needs a local variable (FORALL i IN file / FORALL recvar)
    expect(procErr('begin forall ADR do exit; end;')).toMatch(/lokální proměnnou/);
    // FILE.field := only for parameter files
    expect(procErr('begin ADR.Suma:=0; end;')).not.toBe(null);
    // unknown chapter
    expect(procErr('begin proc(Nic,()); end;')).toMatch(/kapitola neexistuje/);
    // text after the final 'end;'
    expect(procErr('begin end; x')).not.toBe(null);
    // a type mismatch in an assignment
    expect(procErr("var i:real; begin i:='a'; end;")).not.toBe(null);
    // 'x := ...' of an undeclared identifier
    expect(procErr('begin xx:=1; end;')).not.toBe(null);
  });

  it('D chapter: FUNCTION declarations, used by formulas', () => {
    SetInpStr(ref(B(`function Dvakrat(x:real):real; var y:real; begin y:=x*2; Dvakrat:=y; end;
      function Jm(r:real; s:string):string; begin if r>0 then Jm:=s else Jm:=''; end;
      function Ano():boolean; begin Ano:=true end;`)));
    ok(() => ReadDeclChpt());
    const fns: string[] = [];
    for (let f = AccessVars.FuncDRoot; f !== null; f = f.Chain) {
      const lv: string[] = [];
      for (let v: LocVarPtr = f.LVB.Root; v !== null; v = v.Chain) lv.push(`${v.Name}:${v.FTyp}@${v.BPOfs}`);
      fns.push(`${f.Name}:${f.FTyp}(${lv.join(',')}) ${dumpP(f.Instr)}`);
    }
    // newest first; the result variable (named as the function) follows the parameters
    expect(fns).toEqual([
      'Ano:B(Ano:B@8) asgnloc',
      'Jm:S(r:R@8,s:S@14,Jm:S@18) if(asgnloc|asgnloc)',
      'Dvakrat:R(x:R@8,Dvakrat:R@14,y:R@20) asgnloc;asgnloc',
    ]);
    // a declared function is a formula
    AccessVars.RdFldNameFrml = null;
    SetInpStr(ref(B('Dvakrat(3)+1')));
    RdLex();
    const t = ref('\0');
    const z = ok(() => RdFrml(t));
    expect([t.v, z!.P1!.Op, z!.P1!.FC!.Name]).toEqual(['R', _userfunc, 'Dvakrat']);
    // a second declaration of the same name
    SetInpStr(ref(B('function Ano():real; begin Ano:=1 end;')));
    AccessVars.CRdb!.OldFCRoot = null;
    expect(compileErr(() => ReadDeclChpt())).toMatch(/dvakrát deklarováno/);
  });

  it('GetEvalFrml: EVAL strings compiled at run time', () => {
    // the _eval node of evalr('...') / evalb('...'), with the text as a string constant
    const evalNode = (typ: string, txt: string): FrmlPtr => {
      const c = { Op: _const, S: B(txt) } as unknown as FrmlPtr;
      const z = { Op: _eval, P1: c, EvalTyp: typ, EvalFD: null } as unknown as FrmlPtr;
      return z;
    };
    ok(() => {
      ReadProcHead(); // an empty procedure context
    });
    const z = GetEvalFrml(evalNode('R', '1+2*3'));
    expect(BaseVars.LastExitCode).toBe(0);
    expect(z!.Op).toBe(_setmybp);
    expect([z!.P1!.Op, z!.P1!.P2!.Op]).toEqual([_plus, _times]);
    // wrong type: nil, LastExitCode 1
    expect(GetEvalFrml(evalNode('R', "'a'"))).toBe(null);
    expect(BaseVars.LastExitCode).toBe(1);
    // a syntax error in a boolean EVAL gives the constant false; LastExitCode = the error position
    const zb = GetEvalFrml(evalNode('B', '1+'));
    expect(BaseVars.LastExitCode).toBe(3);
    expect([zb!.Op, zb!.P1!.Op, zb!.P1!.B]).toEqual([_setmybp, _const, false]);
    // an empty string: nil, LastExitCode 0
    expect(GetEvalFrml(evalNode('S', ''))).toBe(null);
    expect(BaseVars.LastExitCode).toBe(0);
  });

  it('M chapter: inputs, match fields, outputs, implicit assignments', () => {
    const inp = compileFD('INP', 'X', 'Cislo:N,5; Nazev:A,30; Castka:F,8.2; K:F,5.2; #K @ Cislo;');
    const out = compileFD('OUT', 'X', 'Cislo:N,5; Nazev:A,20; Suma:F,10.2; K:F,5,2; Pocet:F,4.0; #K @ Cislo;');
    SetInpStr(ref(B(`var n:real;
      #I1_INP (Castka>0) Cislo
      #I2_FAK Adr
      #O1_OUT (Castka>1) Suma:=Castka; Pocet+=1; n+=1;
      #O_ADR + Nazev:=I1.Nazev; if n>1 then Suma:=n else Suma:=0;`)));
    ok(() => ReadMerge());
    const rv = RdRunVars;
    expect(rv.MaxIi).toBe(2);
    const I1 = rv.IDA[1]!;
    const I2 = rv.IDA[2]!;
    expect([I1.Scan!.FD, I1.Bool !== null, I1.MFld!.FldD!.Name, I2.Scan!.FD, I2.MFld!.FldD!.Name]).toEqual([
      inp, true, 'Cislo', fak, 'Adr',
    ]);
    // one constant per match field of I1 (OldMFlds/NewMFlds)
    expect(rv.OldMFlds).not.toBe(null);
    expect(rv.OldMFlds!.Chain).toBe(null);
    // #O1_: the output of input 1 (IDA[1]^.RD); #O_: OutpRDs
    const rd1 = I1.RD!;
    expect([rd1.OD!.FD, rd1.Bool !== null]).toEqual([out, true]);
    const kinds = (x: AssignDPtr): string[] => {
      const r: string[] = [];
      for (let a = x; a !== null; a = a.Chain) {
        const nm = a.Kind === _move ? 'move' : a.Kind === _output ? 'out' : a.Kind === _locvar ? 'lv' : a.Kind === _parfile ? 'par' : a.Kind === _ifthenelseM ? 'if' : a.Kind === _zero ? 'zero' : `k${a.Kind}`;
        r.push(`${nm}${a.Kind === _output ? `:${U(a.OFldD!.Name)}${a.Add ? '+' : ''}` : ''}`);
      }
      return r;
    };
    // ImplAssign prepends, so the implicit name:=name assignments of the output fields not assigned
    // with ':=' come first, last field first. #O1 looks only into I1 (Pocet: none there -> _zero,
    // it is only added to with '+='); Cislo, same type -> a byte move; Nazev A,30 -> A,20 and
    // K F,5.2 -> F,5,2 (decimal comma) -> formulas.
    expect(kinds(rd1.Ass)).toEqual(['zero', 'out:K', 'out:Nazev', 'move', 'out:Suma', 'out:Pocet+', 'lv']);
    const mv = rd1.Ass!.Chain!.Chain!.Chain!;
    expect([mv.L, mv.FromPtr!.buffer === I1.Scan!.FD!.RecPtr!.buffer, mv.ToPtr!.buffer === rd1.OD!.RecPtr!.buffer]).toEqual([3, true, true]);
    // K: the input value is divided by nothing (no comma) and multiplied by 10^2 for the output
    const k = rd1.Ass!.Chain!;
    expect([k.OFldD!.Name, k.Frml!.Op, k.Frml!.NewFile, k.Frml!.NewRP === inp.RecPtr]).toEqual(['K', _newfile, inp, true]);
    expect([k.Frml!.P1!.Op, k.Frml!.P1!.P1!.Op, U(k.Frml!.P1!.P1!.Field!.Name), k.Frml!.P1!.P2!.R]).toEqual([_times, _field, 'K', 100]);
    const rdO = rv.OutpRDs!;
    expect([rdO.OD!.FD, rdO.OD!.Append, rdO.Bool]).toEqual([adr, true, null]);
    // #O_: all inputs are searched: Cislo from I1 (a move); Suma, Pozn in none -> _zero
    expect(kinds(rdO.Ass)).toEqual(['zero', 'zero', 'move', 'out:Nazev', 'if']);
    expect(rv.OutpFDRoot!.FD).toBe(out);
    expect(rv.OutpFDRoot!.Chain!.FD).toBe(adr);
  });

  it('M chapter: adjacent implicit moves are merged', () => {
    compileFD('INP', 'X', 'Cislo:N,5; Nazev:A,30; Castka:F,8.2; #K @ Cislo;');
    const out2 = compileFD('OUT2', 'X', 'Cislo:N,5; Nazev:A,30; X:F,5.0; #K @ Cislo;');
    SetInpStr(ref(B('#I1_INP #O_OUT2')));
    ok(() => ReadMerge());
    const rd = RdRunVars.OutpRDs!;
    expect(rd.OD!.FD).toBe(out2);
    const a = rd.Ass!;
    expect([a.Kind, a.FldD!.Name, a.Chain!.Kind, a.Chain!.L, a.Chain!.Chain]).toEqual([_zero, 'X', _move, 33, null]);
    expect(a.Chain!.FromPtr!.byteOffset).toBe(a.Chain!.ToPtr!.byteOffset); // Displ of Cislo in both
  });

  it('M chapter errors', () => {
    // inputs must be numbered 1, 2, ...
    SetInpStr(ref(B('#I2_ADR #O_FAK')));
    expect(compileErr(() => ReadMerge())).not.toBe(null);
    // the same file twice as an input
    SetInpStr(ref(B('#I1_ADR #I2_ADR #O_FAK')));
    expect(compileErr(() => ReadMerge())).toMatch(/dvakrát deklarováno/);
    // #O3 with only 2 inputs
    SetInpStr(ref(B('#I1_ADR Cislo #I2_FAK Adr #O3_PAR')));
    expect(compileErr(() => ReadMerge())).not.toBe(null);
  });
});

// ---------------------------------------------------------------- Účto projects

interface ProjectResult {
  name: string;
  n: Record<string, number>;
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

/** RUNFAND: the catalog file declaration (message 52), opened read only. */
function openCatalog(path: string, name: string): void {
  const a = AccessVars;
  const root = a.FileDRoot;
  RdMsg(52);
  SetInpStr(ref(BaseVars.MsgLine));
  RdFileD('Catalog', 'C', '');
  const cat = a.CFile!;
  a.CatFD = cat;
  a.FileDRoot = root;
  a.CatRdbName = cat.FldD;
  a.CatFileName = a.CatRdbName!.Chain;
  a.CatArchiv = a.CatFileName!.Chain;
  a.CatPathName = a.CatArchiv!.Chain;
  a.CatVolume = a.CatPathName!.Chain;
  a.CatFDName = FromUnicode(name);
  BaseVars.CPath = FromUnicode(path);
  cat.UMode = RdOnly;
  cat.Handle = OpenH(_isoldfile, RdOnly);
  expect(BaseVars.HandleError).toBe(0);
  a.CFile = cat;
  RdPrefixes();
}

/** PROJMGR.CreateOpenChpt (read only, no directories): the chapter file of a project. */
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
  const nm = FromUnicode(basename(path, extname(path)));
  RdFileD(nm, '0', '');
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

/** PROJMGR.CompileRdb: the F, D, M and P chapters (R, E, U, L belong to other packages). */
function compileProject(R: RdbD, name: string): ProjectResult {
  const a = AccessVars;
  const res: ProjectResult = { name, n: {}, errors: [] };
  const chpt = R.FD!;
  for (let I = 1; I <= chpt.NRecs; I++) {
    a.CFile = chpt;
    a.CRecPtr = chpt.RecPtr;
    ReadRec(I);
    const typ = _ShortS(a.ChptTyp)[0];
    const Name = _ShortS(a.ChptName).replace(/ +$/, '');
    const Txt = _T(a.ChptTxt);
    if (!(process.env.RDPROC_TYPES ?? 'FDMP').includes(typ)) continue;
    if (process.env.RDPROC_TRACE) appendFileSync(process.env.RDPROC_TRACE, `${name} #${I} ${typ} ${U(Name)}\n`);
    const RP = new RdbPos();
    RP.R = R;
    RP.IRec = I;
    a.InpRdbPos = RP;
    a.IsCompileErr = false;
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
            // PROJMGR.CompileRdb.RdF: a chapter file declared as a data file
            RdMsg(51);
            const s = BaseVars.MsgLine;
            RdMsg(49);
            SetInpStr(ref(s + String(BaseVars.TxtCols - Number(BaseVars.MsgLine.trim()))));
          } else SetInpTTPos(Txt, R.Encrypted);
          RdFileD(nm, FDTyp, ext);
          if (a.CFile!.IsHlpFile) R.HelpFD = a.CFile;
          break;
        }
        case 'D':
          ResetCompilePars();
          SetInpTTPos(Txt, R.Encrypted);
          ReadDeclChpt();
          break;
        case 'M':
          SetInpTTPos(Txt, R.Encrypted);
          ReadMerge();
          break;
        case 'P': {
          const lstFD = LastInChain(fref(a, 'FileDRoot')) as FileD;
          const ld = a.LinkDRoot;
          SetInpTTPos(Txt, R.Encrypted);
          if (a.InpArrLen > 0) {
            ReadProcHead();
            ReadProcBody();
          }
          lstFD.Chain = null;
          a.LinkDRoot = ld;
          break;
        }
      }
      res.n[typ] = (res.n[typ] ?? 0) + 1;
    } catch (e) {
      if (!(e instanceof GoExitSignal)) {
        res.errors.push(`${name} #${I} ${typ} ${U(Name)}: ${String(e)}`);
      } else {
        const inp = a.InpArrPtr;
        const at = a.CurrPos;
        const ctx = process.env.RDPROC_CTX && inp ? ` [${U(String.fromCharCode(...inp.subarray(Math.max(0, at - 100), at)))}<<>>${U(String.fromCharCode(...inp.subarray(at, at + 30)))}]` : '';
        res.errors.push(`${name} #${I} ${typ} ${U(Name)}: ${U(BaseVars.MsgLine)} @${BaseVars.LastExitCode}${ctx}`);
      }
    } finally {
      RestoreExit(er);
    }
  }
  a.CFile = chpt;
  a.CRecPtr = chpt.RecPtr;
  return res;
}

function textPath(f: string): string {
  return join(WORK, f.replace(/\.RDB$/i, '.TTT').replace(/\.PRO$/i, '.TRO'));
}

/** A compiled project, usable as the parent of the projects it calls. */
interface Compiled {
  R: RdbD;
  FileDRoot: FileDPtr;
  LinkDRoot: typeof AccessVars.LinkDRoot;
  FuncDRoot: typeof AccessVars.FuncDRoot;
  res: ProjectResult;
  chain: string;
}

/** Closes the chapter file of a compiled project that is not kept (handles are limited). */
function closeProject(c: Compiled): void {
  const fd = c.R.FD!;
  CloseClearH(fref(fd, 'Handle'));
  CloseClearH(fref(fd.TF!, 'Handle'));
}

/** Compiles project file f on top of parent (null = a top project), as RUNPROJ does on CALL. */
function compileOn(parent: Compiled | null, f: string): Compiled {
  const a = AccessVars;
  a.CRdb = parent?.R ?? null;
  a.FileDRoot = parent?.FileDRoot ?? null;
  a.LinkDRoot = parent?.LinkDRoot ?? null;
  a.FuncDRoot = parent?.FuncDRoot ?? null;
  const name = basename(f, extname(f)).toUpperCase();
  // a top project has its own catalog (PGM, SESTAVY and TTT are separate applications)
  if (parent === null && existsSync(join(WORK, `${name}.CAT`))) openCatalog(join(WORK, `${name}.CAT`), name);
  const R = openProject(join(WORK, f), textPath(f));
  const res = compileProject(R, basename(f));
  const c: Compiled = {
    R, FileDRoot: a.FileDRoot, LinkDRoot: a.LinkDRoot, FuncDRoot: a.FuncDRoot, res,
    chain: parent ? `${parent.chain}>${name}` : name,
  };
  a.CRdb = parent?.R ?? null;
  return c;
}

/**
 * The chain of callers each Účto project runs under (CALL puts the called project on top of the
 * caller, and its chapters see the files, functions and procedures of all projects below).
 * Found by compiling each project on top of every candidate caller: the literal CALL(name) graph
 * of the sources, plus CALLs with computed names (UPG -> MODULnn -> UPGnn, MODUL06 -> SPEC06).
 * PGM, SESTAVY and TTT are separate applications with their own catalogs.
 */
const CHAINS = [
  'UCTO2026', 'UCTO2026>MODUL95', 'UCTO2026>UCTOINFO', 'UCTO2026>MODUL01',
  ...['02', '03', '04', '05', '06', '07', '08', '09', '99'].map((n) => `UCTO2026>MODUL01>MODUL${n}`),
  ...['02', '03', '04', '05', '06', '07', '08', '09'].map((n) => `UCTO2026>MODUL01>MODUL${n}>SEST${n}`),
  'UCTO2026>MODUL01>MODUL04>MODUL94', 'UCTO2026>MODUL01>MODUL04>MODUL97', 'UCTO2026>MODUL01>MODUL04>MODUL97>SEST97',
  'UCTO2026>MODUL01>SEST01', 'UCTO2026>MODUL01>IMPORT',
  ...['01', '02', '03', '04', '05', '07'].map((n) => `UCTO2026>MODUL01>SPEC${n}`), 'UCTO2026>MODUL01>MODUL06>SPEC06',
  'UCTO2026>MODUL01>UPG', 'UCTO2026>MODUL01>UPG>UPG01', 'UCTO2026>MODUL01>UPG>UPG07', 'UCTO2026>MODUL01>UPG>MODUL98',
  ...['02', '03', '04', '05', '06', '08', '09', '99'].map((n) => `UCTO2026>MODUL01>UPG>MODUL${n}>UPG${n}`),
  'UCTO2026>MODUL01>UPG>MODUL04>MODUL97>UPG97',
  'PGM', 'SESTAVY', 'TTT',
];

/**
 * Compile errors that are not RDPROC/RDMERG bugs.
 * - Files that are not in UCTO2026.CAT: FILE.PATH:=... needs a catalog record (TestCatError), which
 *   the installation of MODUL94 adds; the pristine catalog has none for MODUL94.
 * - FPC deviation in RDFILDCL (lexer-frml package): a local 'f:file.X [like FD]' recompiles FD's
 *   text (CallRdFDSegment) and TestUserView finds FD's own #U view names in FileDRoot (error 26).
 *   BP7 reads the stored FD segment instead. Listed so that a fix there does not break this test.
 */
const KNOWN_ERRORS = [
  'MODUL94.PRO #10 P ImportOic: soubor ZAMOIC není v katalogu',
  'MODUL94.PRO #88 P GenX: soubor GENX není v katalogu',
  'MODUL94.PRO #89 P ImpSabl1: soubor GENX není v katalogu',
  'MODUL94.PRO #90 P Sablony: soubor GENX není v katalogu',
  'MODUL94.PRO #93 P MHx: soubor GENX není v katalogu',
  'MODUL94.PRO #94 P MH2x: soubor GENX není v katalogu',
  'MODUL94.PRO #101 P PriprX: soubor XML není v katalogu',
  'MODUL94.PRO #103 P ServisX: soubor XML není v katalogu',
  'MODUL01.PRO #155 P CisDruhVz: dvakrát deklarováno',
  'MODUL04.PRO #76 P KategEx: dvakrát deklarováno',
];

describe.skipIf(!haveApp)('Účto: every F, D, M and P chapter compiles', () => {
  const projects = haveApp ? readdirSync(APP).filter((f) => /\.(RDB|PRO)$/i.test(f)).sort() : [];
  beforeAll(() => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    for (const f of projects) {
      cpSync(join(APP, f), join(WORK, f));
      const t = basename(textPath(f));
      if (existsSync(join(APP, t))) cpSync(join(APP, t), join(WORK, t));
    }
    for (const f of readdirSync(APP).filter((x) => /\.CAT$/i.test(x))) cpSync(join(APP, f), join(WORK, f));
  });
  it('each project on top of the projects that CALL it', () => {
    const a = AccessVars;
    const byName = new Map(projects.map((f) => [basename(f, extname(f)).toUpperCase(), f]));
    const compiled = new Map<string, Compiled>();
    const done = new Map<string, Compiled>();
    for (const chain of CHAINS) {
      let parent: Compiled | null = null;
      const names = chain.split('>');
      for (let i = 0; i < names.length; i++) {
        const key = names.slice(0, i + 1).join('>');
        let c = compiled.get(key);
        if (c === undefined) {
          c = compileOn(parent, byName.get(names[i])!);
          compiled.set(key, c);
        }
        parent = c;
      }
      done.set(names[names.length - 1], parent!);
    }
    a.CRdb = null;
    a.CatFD = null;
    expect([...byName.keys()].filter((n) => !done.has(n))).toEqual([]);
    // the errors of the projects on their final chain, and of the chains below them
    const results = [...compiled.values()].map((c) => c.res);
    const errors = [...new Set(results.flatMap((r) => r.errors))];
    const n: Record<string, number> = {};
    for (const c of done.values()) for (const [k, v] of Object.entries(c.res.n)) n[k] = (n[k] ?? 0) + v;
    console.log(`compiled chapters: ${JSON.stringify(n)}; errors: ${errors.length}`);
    if (process.env.RDPROC_ERRS) appendFileSync(process.env.RDPROC_ERRS, errors.join('\n') + '\n');
    expect(errors.filter((e) => !KNOWN_ERRORS.some((k) => e.startsWith(k)))).toEqual([]);
    expect(n.P).toBeGreaterThan(2600);
    expect(n.M).toBeGreaterThan(220);
    expect(n.D).toBeGreaterThan(70);
  }, 300_000);
});
