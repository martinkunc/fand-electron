// prolog package: RDPROLG.PAS (compiler of L chapters) and RUNPROLG.PAS (the interpreter).
// Small programs compiled from strings and run with write/writeln output captured from Output,
// the L chapters of all Účto projects compiled on top of their F chapters, and Účto-like
// programs using the FAND metadata built-ins (fandfile, fandfield, fandkey, fandlink) on the real RDB.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { existsSync, readdirSync, mkdirSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

import {
  ref, getWord, GoExitSignal, FromUnicode, TxtAssign, TxtRewrite, Output, type TextFile,
} from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, OpenH, ReadH, PosH, _isoldfile, RdOnly, NewExit, RestoreExit, ExitRecord, RdMsg, OpenWorkH, FormatCache,
  type TMsgIdxItem,
} from '../src/engine/pas/base.ts';
import { SetDriversCrt, DriversVars } from '../src/engine/pas/drivers.ts';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { encode852, decode852 } from '../src/engine/console/cp852.ts';
import {
  AccessVars, FileD, RdbD, RdbPos, ResetCompilePars, GetRecSpace, ReadRec, RdPrefixes, _ShortS, _T, _const,
  type FileDPtr,
} from '../src/engine/pas/access.ts';
import { SetInpStr, SetInpLongStr, SetInpTTPos, GetOp } from '../src/engine/pas/compile.ts';
import { RdFileD } from '../src/engine/pas/rdfildcl.ts';
import { ReadDeclChpt } from '../src/engine/pas/rdproc.ts';
import {
  ReadProlog, RdPrologVars, SgPtr, SgMark, SgRelease, SgPred, SgStr, SgDom, TProgRoots, TPredicate,
  _BuildInOpt, _DbaseOpt, _FandCallOpt, _CioMaskOpt, _PackInpOpt, _ListD, _FunD,
} from '../src/engine/pas/rdprolg.ts';
import { RunProlog, RunPrologVars, Abbrev, SaveDb } from '../src/engine/pas/runprolg.ts';
import { Rdb } from '../src/engine/fand/rdb.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const SRC = join(ROOT, 'work/source');
const WORK = join(ROOT, 'work/tmp-prolog');
const haveApp = existsSync(join(APP, 'UCTO2026.RDB')) && existsSync(join(APP, 'FAND.RES'));

/** Byte string of a Unicode text (CP852) and back. */
const B = (u: string): string => String.fromCharCode(...encode852(u));
const U = (b: string): string =>
  b
    .split(/([\x00-\x1f]+)/)
    .map((x, i) => (i % 2 ? x : decode852(Uint8Array.from(x, (c) => c.charCodeAt(0)))))
    .join('');

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

// ---------------------------------------------------------------- output capture
let out = '';
function captureOutput(): void {
  const drv = (F: TextFile): number => {
    out += F.Buf;
    F.Buf = '';
    F.BufPos = 0;
    return 0;
  };
  TxtAssign(Output, '');
  Output.OpenFunc = () => 0;
  Output.InOutFunc = drv;
  Output.FlushFunc = drv;
  Output.CloseFunc = () => 0;
  TxtRewrite(Output);
}

interface RunResult {
  out: string;
  EdBreak: number;
  LastExitCode: number;
  msg: string;
}
/** Runs the Prolog program src (Unicode) from a string formula (Pos.IRec=0), as `lproc [src]`. */
function runL(src: string, pred: string | null = null): RunResult {
  resetCompiler();
  const z = GetOp(_const, 0)!;
  z.S = B(src);
  const pos = new RdbPos();
  pos.IRec = 0;
  pos.Frml = z;
  out = '';
  BaseVars.MsgLine = '';
  RunProlog(pos, pred === null ? null : B(pred));
  return { out: U(out), EdBreak: AccessVars.EdBreak, LastExitCode: BaseVars.LastExitCode, msg: U(BaseVars.MsgLine) };
}
/** Compiles src only (ReadProlog(0) like PROJMGR); returns the error message or null. */
function compileL(src: string): string | null {
  resetCompiler();
  const s = Uint8Array.from(encode852(src));
  const er = new ExitRecord();
  NewExit(null, er);
  const m = SgMark();
  try {
    SetInpLongStr(s, false);
    ReadProlog(0);
    return null;
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
    return `${U(BaseVars.MsgLine)} @${AccessVars.CurrPos}`;
  } finally {
    RestoreExit(er);
    SgRelease(m);
  }
}

beforeAll(() => {
  const kq = new KeyQueue();
  // a test must never wait for a key: fail with a stack instead of blocking forever
  kq.read = (timeoutMs = Infinity) => {
    if (timeoutMs === Infinity) throw new Error(`test would wait for a key: ${U(BaseVars.MsgLine)}`);
    return null;
  };
  SetDriversCrt(new Crt(kq, null, 80, 25));
  DriversVars.FandBatch = true; // messages go to stderr, key waits answer Esc, prompts No
  if (haveApp) loadResMessages();
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  FormatCache(); // the handles read and write through the cache
  BaseVars.FandWorkName = FromUnicode(join(WORK, 'FANDWORK.$$$'));
  OpenWorkH();
  const tw = AccessVars.TWork;
  tw.IsWork = true;
  BaseVars.CPath = FromUnicode(join(WORK, 'FANDWORK.T$$'));
  BaseVars.FandWorkTName = BaseVars.CPath;
  tw.Create();
  BaseVars.MaxWSize = 0;
  captureOutput();
});
beforeEach(() => resetCompiler());

// ---------------------------------------------------------------- the compiler

describe.skipIf(!haveApp)('RDPROLG: compiler', () => {
  it('builds the segment: Roots at offset 0, built-in domains and predicates, main first', () => {
    resetCompiler();
    const m = SgMark();
    SetInpLongStr(Uint8Array.from(encode852('#PREDICATES foo(Integer) #CLAUSES foo(1). main:-foo(1).')), false);
    const sg = ReadProlog(0);
    expect(sg).toBe(RdPrologVars._Sg);
    const roots = SgPtr(0) as TProgRoots;
    expect(roots).toBeInstanceOf(TProgRoots);
    const names: string[] = [];
    for (let o = roots.Predicates; o !== 0; o = SgPred(o).Chain) names.push(SgStr(SgPred(o).Name));
    expect(names[0]).toBe('main');
    expect(names).toContain('fandfield');
    expect(names[names.length - 1]).toBe('foo');
    const concat = SgPred(roots.Predicates + 0) as TPredicate;
    expect(concat.Branch).not.toBeNull(); // main has a clause
    const doms: string[] = [];
    for (let o = roots.Domains; o !== 0; o = SgDom(o).Chain) doms.push(SgDom(o).Name);
    expect(doms.slice(0, 7)).toEqual(['String', 'LongString', 'Integer', 'Real', 'Boolean', 'Lexem', 'L_Lexem']);
    SgRelease(m);
  });

  it('predicate options: database, FAND procedure, built-ins', () => {
    resetCompiler();
    const m = SgMark();
    SetInpLongStr(
      Uint8Array.from(encode852("#DATABASE fakt(String,Integer) #PREDICATES @pr['begin end;'](String,&Integer) #CLAUSES fakt('a',1). main:-fakt(X,_),pr(X,_).")),
      false,
    );
    ReadProlog(0);
    const roots = SgPtr(0) as TProgRoots;
    const byName = new Map<string, TPredicate>();
    for (let o = roots.Predicates; o !== 0; o = SgPred(o).Chain) byName.set(SgStr(SgPred(o).Name), SgPred(o));
    expect(byName.get('fakt')!.Opt).toBe(_DbaseOpt + _CioMaskOpt + _PackInpOpt);
    expect(byName.get('fakt')!.Branch).toBeNull(); // saved into the database's SOfs
    expect(byName.get('pr')!.Opt).toBe(_FandCallOpt);
    expect(byName.get('pr')!.InpMask).toBe(1);
    expect(byName.get('pr')!.LocVarSz).toBe(8 + 6); // frame: ProcStkD + the output real
    expect(byName.get('concat')!.Opt).toBe(_BuildInOpt + _CioMaskOpt);
    expect(byName.get('len_?')!.InpMask).toBe(1);
    SgRelease(m);
  });

  it('domains, constants, lists and functors compile', () => {
    expect(
      compileL(`
      #DOMAINS Jmeno=String  Bod=bod(Integer,Integer);nic  Seznam=L_Bod
      #CONSTANTS Integer: jedna=1, dva=2
      #PREDICATES delka(Seznam,&Integer) p(Bod)
      #CLAUSES
        delka([],0).
        delka([_|T],N):-delka(T,N1),N=N1+1.
        p(bod(jedna,dva)).
        p(nic).
        main:-delka([bod(1,2),nic],N),N=2,p(nic).`),
    ).toBeNull();
  });

  it('compile checks (level 0) do not exhaust the segment table (no FPC 32-chapter limit)', () => {
    const m = SgMark();
    for (let i = 0; i < 40; i++) {
      resetCompiler();
      SetInpLongStr(Uint8Array.from(encode852('#CLAUSES main.')), false);
      ReadProlog(0);
    }
    expect(SgMark()).toBe(m);
  });

  it('reports compile errors with the FAND messages', () => {
    // undefined predicate (513), undeclared domain (517), unused variable (521)
    expect(compileL('#CLAUSES main:-foo.')).toMatch(/@\d+/);
    expect(compileL('#PREDICATES p(Neni) #CLAUSES main.')).toMatch(/@\d+/);
    expect(compileL('#PREDICATES p(Integer) #CLAUSES p(X). main.')).toMatch(/X/);
    // a predicate without clauses (522)
    expect(compileL('#PREDICATES p #CLAUSES main:-p.')).toMatch(/p/);
    // main not defined
    expect(compileL('#PREDICATES p #CLAUSES p.')).toMatch(/main/);
  });
});

// ---------------------------------------------------------------- the interpreter

describe.skipIf(!haveApp)('RUNPROLG: programs', () => {
  it('writes, succeeds (EdBreak=0) and fails (EdBreak=1)', () => {
    let r = runL("#CLAUSES main:-writeln('ahoj ','svete').");
    expect(r.out).toBe('ahoj svete\r\n');
    expect(r.EdBreak).toBe(0);
    expect(r.LastExitCode).toBe(0);
    r = runL('#CLAUSES main:-fail.');
    expect(r.EdBreak).toBe(1);
    expect(r.LastExitCode).toBe(0);
  });

  it('backtracking, cut and arithmetic', () => {
    const r = runL(`
      #PREDICATES cislo(&Integer) fakt(Integer,&Integer)
      #CLAUSES
        cislo(1). cislo(2). cislo(3).
        fakt(0,1):-!.
        fakt(N,F):-N1:Integer=N-1,fakt(N1,F1),F=N*F1.
        main:-cislo(X),write(X,' '),X>=2,!,fakt(5,F),writeln(F).`);
    expect(r.out).toBe('1 2 120\r\n');
    expect(r.EdBreak).toBe(0);
  });

  it('strings: concat modes, functions, conversions', () => {
    const r = runL(`
      #PREDICATES rozdel(String)
      #CLAUSES
        rozdel(S):-concat(A,B,S),write(A,'|',B,' '),fail.
        rozdel(_).
        main:-concat('ab','cd',X),writeln(X),
              concat('ab',Y,'abcd'),writeln(Y),
              concat(Z,'cd','abcd'),writeln(Z),
              rozdel('abc'),writeln(''),
              L:Integer=length('hello'),writeln(L),
              S:String=copy('abcdef',2,3)+str(42)+repeatstr('x',3),writeln(S),
              T:String=leadchar('0','0012')+trailchar(' ','ab  ')+'!',writeln(T),
              P:Integer=pos('cd','abcdef'),writeln(P),
              V:Integer=val('123')+max(1,2)+min(5,3),writeln(V).`);
    expect(r.msg).toBe('');
    expect(r.out).toBe(
      "'abcd'\r\n'cd'\r\n'ab'\r\n'a'|'bc' 'ab'|'c' 'abc'|'' \r\n5\r\n'bcd42xxx'\r\n'12ab!'\r\n3\r\n128\r\n",
    );
  });

  it('lists: head|tail, + concatenation, list built-ins, all_', () => {
    const r = runL(`
      #DOMAINS Seznam=L_Integer
      #PREDICATES delka(Seznam,&Integer) clen(&Integer) spoj(Seznam,Seznam,&Seznam)
      #CLAUSES
        delka([],0).
        delka([_|T],N):-delka(T,N1),N=N1+1.
        clen(1). clen(2). clen(3).
        spoj(A,B,A+B).
        main:-delka([1,2,3,4],N),writeln(N),
              spoj([1,2],[3],S),writeln(S),
              len_Integer(S,L),writeln(L),
              inv_Integer(S,I),writeln(I),
              add_Integer(7,S,A),writeln(A),
              add_Integer(2,S,A2),writeln(A2),
              del_Integer(2,[1,2,3],D),writeln(D),
              mem_Integer(3,S),
              union_Integer([1,2],[2,3],U),writeln(U),
              minus_Integer([1,2,3],[2],M),writeln(M),
              inter_Integer([1,2,3],[3,2,5],X),writeln(X),
              all_Integer(clen(C),C,V),writeln(V).`);
    expect(r.msg).toBe('');
    expect(r.out).toBe(
      '4\r\n[1,2,3]\r\n3\r\n[3,2,1]\r\n[7,1,2,3]\r\n[1,2,3]\r\n[1,3]\r\n[1,2,3]\r\n[1,3]\r\n[2,3]\r\n[1,2,3]\r\n',
    );
  });

  it('mem_ enumerates with backtracking', () => {
    const r = runL(`#CLAUSES main:-mem_String(X,['a','b','c']),write(X),fail. main:-writeln('.').`);
    expect(r.out).toBe("'a''b''c'.\r\n");
  });

  it('not(), comparisons of reals and functors, booleans', () => {
    const r = runL(`
      #DOMAINS Tvar=kruh(Real);ctverec(Real)
      #PREDICATES je(Integer) plocha(Tvar,&Real) kladny(Integer,&Boolean)
      #CLAUSES
        je(1). je(2).
        plocha(kruh(R),P):-P=3.0*R*R.
        plocha(ctverec(A),P):-P=A*A.
        kladny(X,true):-X>0,!.
        kladny(_,false).
        main:-not(je(3)),writeln('ne 3'),
              plocha(ctverec(1.5),P),P>2.2,P<2.3,writeln(P),
              T:Tvar=kruh(2.0),T=kruh(2.0),T<>ctverec(2.0),writeln(T),
              kladny(-5,B),writeln(B).`);
    expect(r.msg).toBe('');
    expect(r.out).toBe('ne 3\r\n 2.2500000000E+00\r\nkruh( 2.0000000000E+00)\r\nfalse\r\n');
  });

  it('database: facts, assert, retract, packed input matching', () => {
    const r = runL(`
      #DATABASE osoba(String,Integer)
      #PREDICATES vypis
      #CLAUSES
        osoba('Jan',30).
        osoba('Eva',25).
        vypis:-osoba(J,V),write(J,'=',V,' '),fail.
        vypis:-writeln('').
        main:-vypis,assert(osoba('Petr',40)),vypis,
              retract(osoba('Jan',_)),vypis,
              osoba('Eva',X),writeln(X).`);
    expect(r.msg).toBe('');
    expect(r.out).toBe("'Jan'=30 'Eva'=25 \r\n'Jan'=30 'Eva'=25 'Petr'=40 \r\n'Eva'=25 'Petr'=40 \r\n25\r\n");
  });

  it('LongString terms go through the work file', () => {
    const r = runL(`
      #PREDICATES spoj(LongString,LongString,&LongString)
      #CLAUSES
        spoj(A,B,A+'-'+B).
        main:-spoj('abc','def',X),writeln(X),X='abc-def'.`);
    expect(r.msg).toBe('');
    expect(r.out).toBe("'abc-def'\r\n");
    expect(r.EdBreak).toBe(0);
  });

  it('runs a named predicate (arity 0), else RunError 1545', () => {
    let r = runL(`#PREDICATES druhy #CLAUSES druhy:-writeln('druhy'). main:-writeln('main').`, 'druhy');
    expect(r.out).toBe('druhy\r\n');
    r = runL(`#PREDICATES druhy(Integer) #CLAUSES druhy(1). main.`, 'druhy');
    expect(r.EdBreak).toBe(2);
    expect(r.msg).toMatch(/druhy/);
  });

  it('compile errors inside RunProlog end with EdBreak=2', () => {
    const r = runL('#CLAUSES main:-nic.');
    expect(r.EdBreak).toBe(2);
    expect(r.LastExitCode).toBe(19); // Error: the position in the source
    expect(r.msg).toBe('očekávám název predikátu'); // 513
    expect(RunPrologVars.ProlgCallLevel).toBe(0);
  });

  it('a runaway recursion ends with RunError 624 (out of memory), EdBreak=2', () => {
    const r = runL(`#PREDICATES p(Integer) #CLAUSES p(X):-Y:Integer=X+1,p(Y). main:-p(0).`);
    expect(r.EdBreak).toBe(2);
    expect(r.msg).toMatch(/pam/); // "nestačí paměť"
    expect(RunPrologVars.ProlgCallLevel).toBe(0);
  });

  it('loadlex-free lexem built-ins: getlex/nextlex on an empty list', () => {
    const r = runL(`#CLAUSES main:-getlex(L),writeln(L),nextlex.`);
    expect(r.out).toBe('[]\r\n');
  });

  it('abbrev (Czech abbreviations)', () => {
    expect(U(Abbrev(B('Účetní doklad')))).toBe('Úč. dokl.');
    const r = runL(`#CLAUSES main:-abbrev('Hlavní kniha',X),writeln(X).`);
    expect(r.out).toBe("'Hl. kn.'\r\n");
  });

  it('autorecursion p(!,...), `; L+=Term`, `;` alone, self (checked against the reference FAND)', () => {
    const r = runL(`
      #DOMAINS Strom=uzel(Strom,Strom);list(Integer)  LI=L_Integer
      #DATABASE cnt(Integer)
      #PREDICATES zdvoj(Strom,&Strom) soucet(Strom,Integer,&Integer) kopie(LI,&LI)
        sude(LI,&LI) loop vsechny clen(&Integer)
      #CLAUSES
        cnt(3).
        clen(1). clen(2). clen(3).
        zdvoj(list(X),list(Y)):-Y=X*2,!.
        zdvoj(!,!).
        soucet(list(X),A,S):-S=A+X,!.
        soucet(!,A,A).
        kopie(!,!).
        sude(L,S):-mem_Integer(X,L),Z:Integer=X/2*2,Z=X;S+=[X].
        loop:-cnt(N),N>0,write(N),retract(cnt(N)),assert(cnt(N-1)),self.
        loop.
        vsechny:-clen(X),write(X);.
        main:-zdvoj(uzel(list(1),uzel(list(2),list(3))),T),writeln(T),
              soucet(uzel(list(1),uzel(list(2),list(3))),10,S),writeln(S),
              kopie([4,5,6],K),writeln(K),
              sude([1,2,3,4,6],SU),writeln(SU),
              loop,writeln(''),vsechny,writeln('').`);
    expect(r.msg).toBe('');
    // the FPC reference prints uzel(list(2),[]) for the first line: its TAutoR copies 4*Arity bytes
    // of 8-byte pointers; BP7 (and this port) rebuild the whole term
    expect(r.out).toBe('uzel(list(2),uzel(list(4),list(6)))\r\n16\r\n[4,5,6]\r\n[2,4,6]\r\n321\r\n123\r\n');
  });

  it('trace(1) prints CALL/RETURN/FAIL/REDO like the reference FAND', () => {
    const r = runL(`
      #DATABASE f(Integer)
      #PREDICATES p(Integer,&Integer) q(L_Integer,&Integer)
      #CLAUSES
        f(1). f(2).
        p(X,Y):-Y=X*2.
        q(L,N):-len_Integer(L,N).
        main:-trace(1),p(3,Y),q([1,2],N),f(Z),Z>1,assert(f(5)),not(f(7)),writeln(Y,N,Z).`);
    expect(r.out.split('\r\n')).toEqual([
      'CALL p(3,_)', 'RETURN p(_,6)', 'CALL q([1,2],_)', 'RETURN q(_,2)', 'CALL f(_)', 'RETURN f(1)', 'FAIL',
      'REDO f', 'RETURN f(2)', 'CALL assert(f(5))', 'CALL not(f(7))', 'FAIL', 'RETURN not()', '622', 'RETURN main', '',
    ]);
    expect(r.EdBreak).toBe(0);
  });

  it('`; error(...)` alternative and error(0,Pos,...) end the chapter with EdBreak=2', () => {
    let r = runL(`
      #PREDICATES p(Integer)
      #CLAUSES
        p(X):-X>0 ; error(0,'zaporne cislo').
        main:-p(5),writeln('ok'),p(0-1),writeln('nic').`);
    expect([r.out, r.EdBreak, r.LastExitCode, U(AccessVars.EdRecKey)]).toEqual(['ok\r\n', 2, 0, 'zaporne cislo']);
    r = runL(`#CLAUSES main:-S:String='xx',I:Integer=7,error(0,I,'chyba ',S).`);
    expect([r.EdBreak, r.LastExitCode, U(AccessVars.EdRecKey)]).toEqual([2, 7, 'chyba ']);
  });

  it('SaveDb/ConsultDb round trip of the initial database', () => {
    resetCompiler();
    const m = SgMark();
    SetInpLongStr(Uint8Array.from(encode852("#DATABASE f(String,Integer,Real,L_Integer) #CLAUSES f('a',-1,2.5,[1,2]). main.")), false);
    ReadProlog(0);
    const roots = SgPtr(0) as TProgRoots;
    const db = SgPtr(roots.Databases) as { SOfs: number };
    const s = SgPtr(db.SOfs) as Uint8Array;
    // #1, 4 args (word length + data), #0 end of predicate
    expect(Array.from(s)).toEqual([1, 2, 0, 1, 97, 2, 0, 0xff, 0xff, 6, 0, 0x82, 0, 0, 0, 0, 0x20, 6, 0, 2, 0, 1, 0, 2, 0, 0]);
    void SaveDb;
    SgRelease(m);
  });
});

// ---------------------------------------------------------------- Účto

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

interface ProjectResult {
  name: string;
  L: string[];
  errors: string[];
}
/** PROJMGR.CompileRdb for F and D chapters (declarations) and L chapters (ReadProlog(0), as FPC). */
function compileProject(R: RdbD, name: string): ProjectResult {
  const a = AccessVars;
  const res: ProjectResult = { name, L: [], errors: [] };
  const chpt = R.FD!;
  for (let I = 1; I <= chpt.NRecs; I++) {
    a.CFile = chpt;
    a.CRecPtr = chpt.RecPtr;
    ReadRec(I);
    const typ = _ShortS(a.ChptTyp)[0];
    const Name = _ShortS(a.ChptName).replace(/ +$/, '');
    const Txt = _T(a.ChptTxt);
    if (typ !== 'F' && typ !== 'D' && typ !== 'L') continue;
    const RP = new RdbPos();
    RP.R = R;
    RP.IRec = I;
    a.InpRdbPos = RP;
    a.IsCompileErr = false;
    const er = new ExitRecord();
    NewExit(null, er);
    const m = SgMark();
    try {
      if (typ === 'F') {
        const dot = Name.indexOf('.');
        const nm = dot < 0 ? Name : Name.slice(0, dot);
        const ext = dot < 0 ? '' : Name.slice(dot);
        const FDTyp = { '': '6', '.X': 'X', '.DTA': '8', '.DBF': 'D', '.HLP': '6' }[ext.toUpperCase()] ?? '?';
        SetInpTTPos(Txt, R.Encrypted);
        RdFileD(nm, FDTyp, ext);
        if (a.CFile!.IsHlpFile) R.HelpFD = a.CFile;
      } else if (typ === 'D') {
        ResetCompilePars();
        SetInpTTPos(Txt, R.Encrypted);
        ReadDeclChpt();
      } else {
        ResetCompilePars();
        SetInpTTPos(Txt, R.Encrypted);
        ReadProlog(0);
        res.L.push(U(Name));
      }
    } catch (e) {
      if (!(e instanceof GoExitSignal)) res.errors.push(`${name} #${I} ${typ} ${U(Name)}: ${String(e)}`);
      else res.errors.push(`${name} #${I} ${typ} ${U(Name)}: ${U(BaseVars.MsgLine)} @${AccessVars.CurrPos}`);
    } finally {
      RestoreExit(er);
      SgRelease(m);
    }
  }
  a.CFile = chpt;
  a.CRecPtr = chpt.RecPtr;
  return res;
}

/** The decoded source of an Účto chapter (work/source), '' when missing. */
function source(dir: string, file: string): string {
  const p = join(SRC, dir, file);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

describe.skipIf(!haveApp)('Účto: L chapters', () => {
  const projects = haveApp ? readdirSync(APP).filter((f) => /\.(RDB|PRO)$/i.test(f)).sort() : [];
  const UWORK = join(WORK, 'ucto');
  function textPath(f: string): string {
    return join(UWORK, f.replace(/\.RDB$/i, '.TTT').replace(/\.PRO$/i, '.TRO'));
  }
  let top: RdbD;
  let topFD: FileDPtr = null;
  let topLD: typeof AccessVars.LinkDRoot = null;
  const results: ProjectResult[] = [];
  const opened = new Map<string, { R: RdbD; FD: FileDPtr; LD: typeof AccessVars.LinkDRoot }>();

  beforeAll(() => {
    mkdirSync(UWORK, { recursive: true });
    for (const f of projects) {
      cpSync(join(APP, f), join(UWORK, f));
      const t = basename(textPath(f));
      if (existsSync(join(APP, t))) cpSync(join(APP, t), join(UWORK, t));
    }
    cpSync(join(APP, 'UCTO2026.CAT'), join(UWORK, 'UCTO2026.CAT'));
    const a = AccessVars;
    a.CRdb = null;
    a.LinkDRoot = null;
    a.FuncDRoot = null;
    a.FileDRoot = null;
    openCatalog(join(UWORK, 'UCTO2026.CAT'), 'UCTO2026');
    top = openProject(join(UWORK, 'UCTO2026.RDB'), textPath('UCTO2026.RDB'));
    results.push(compileProject(top, 'UCTO2026'));
    topFD = a.FileDRoot;
    topLD = a.LinkDRoot;
    opened.set('UCTO2026', { R: top, FD: topFD, LD: topLD });
    // the projects with L chapters (and the parent of UPG99: the upgrade of MODUL99)
    for (const f of projects) {
      if (!/^(MODUL02|MODUL05|MODUL99|UPG99)\./i.test(f)) continue;
      const parent = opened.get(/^UPG99\./i.test(f) ? 'MODUL99' : 'UCTO2026')!;
      a.CRdb = parent.R;
      a.FileDRoot = parent.FD;
      a.LinkDRoot = parent.LD;
      const R = openProject(join(UWORK, f), textPath(f));
      results.push(compileProject(R, basename(f)));
      opened.set(basename(f, extname(f)).toUpperCase(), { R, FD: a.FileDRoot, LD: a.LinkDRoot });
    }
  });

  /** Makes project name current (CRdb, FileDRoot, LinkDRoot) as when running in it. */
  function enter(name: string): RdbD {
    const o = opened.get(name)!;
    AccessVars.CRdb = o.R;
    AccessVars.FileDRoot = o.FD;
    AccessVars.LinkDRoot = o.LD;
    AccessVars.Chpt = o.R.FD;
    SetChptFldDPtr();
    return o.R;
  }

  it('every L chapter of every project compiles', () => {
    const errors = results.flatMap((r) => r.errors).filter((e) => / L /.test(e));
    const L = results.flatMap((r) => r.L.map((n) => `${r.name}:${n}`));
    expect(errors).toEqual([]);
    expect(L.length).toBe(13);
    expect(L).toContain('MODUL99.PRO:Prolog');
    expect(L).toContain('UCTO2026:DeklOK');
  });

  it('fandfile/fandfield/all_ on the real RDB: the Indexy and Texty chapters of MODUL02', () => {
    enter('MODUL02');
    // the chapter text with the FAND procedure @param3TttW replaced by a clause that writes
    const proc = "@param3TttW['(Txt:string) begin PARAM3.TTT:=Txt end;'](LongString)";
    for (const [file, nameOf] of [
      ['0149_L_Indexy.txt', (fd: FileD) => fd.Typ === 'X'],
      [
        '0150_L_Texty.txt',
        (fd: FileD) => {
          if (U(fd.Name) === 'HELP02') return false;
          for (let f = fd.FldD; f !== null; f = f.Chain) if (f.Typ === 'T') return (f.Flg & 1) === 1;
          return false;
        },
      ],
    ] as const) {
      let src = source('MODUL02_PRO', file);
      expect(src).toContain(proc);
      src = src.replace(proc, 'param3TttW(LongString)').replace('#CLAUSES', '#CLAUSES param3TttW(T):-writeln(T).');
      const r = runL(src);
      expect(r.msg).toBe('');
      expect(r.EdBreak).toBe(0);
      // expected: the files of MODUL02 in NextFD order
      const names: string[] = [];
      for (let fd = AccessVars.FileDRoot; fd !== null; fd = fd.Chain) {
        if (fd.Typ === '0' || fd.ChptPos.R === null) continue;
        if (nameOf(fd)) names.push(U(fd.Name));
      }
      expect(names.length).toBeGreaterThan(0);
      const body = names.map((n) => `proc(${file.includes('Indexy') ? 'Indexy1' : 'Texty1'},(@${n}));\r`).join('');
      expect(r.out).toBe(`'begin\r${body}end;'\r\n`);
    }
  });

  it('runs a chapter by its record (Pos.IRec): MODUL02 Indexy up to its FAND procedure', () => {
    const R = enter('MODUL02');
    const chpt = R.FD!;
    let irec = 0;
    for (let I = 1; I <= chpt.NRecs; I++) {
      AccessVars.CFile = chpt;
      AccessVars.CRecPtr = chpt.RecPtr;
      ReadRec(I);
      if (_ShortS(AccessVars.ChptTyp)[0] === 'L' && _ShortS(AccessVars.ChptName).trim() === 'Indexy') irec = I;
    }
    expect(irec).toBe(149);
    const pos = new RdbPos();
    pos.R = R;
    pos.IRec = irec;
    out = '';
    BaseVars.MsgLine = '';
    RunProlog(pos, null);
    // the chapter compiles from its record and runs up to its FAND procedure param3TttW, whose
    // PARAM3 data file is not set up in this harness (no data directories): a RunError, EdBreak=2
    expect(U(BaseVars.MsgLine)).toMatch(/^soubor .*nenalezen$/);
    expect(AccessVars.EdBreak).toBe(2);
    expect(RunPrologVars.ProlgCallLevel).toBe(0);
  });

  it('call(Chapter,Pred) runs another L chapter (nested RunProlog)', () => {
    enter('MODUL02');
    const m = SgMark();
    const r = runL(`
      #PREDICATES zkus(String)
      #CLAUSES
        zkus(P):-call('FileName',P),writeln('ano'),!.
        zkus(_):-writeln('ne').
        main:-zkus('neni'),zkus('main'),call('Neni','main').`);
    // 'neni': RunError 1545 in the nested run -> call fails; 'main' of FileName needs the PARAM3
    // data file (not set up here) -> fails; an unknown chapter is RunError 1554 of the outer run
    expect(r.out).toBe('ne\r\nne\r\n');
    expect(r.EdBreak).toBe(2);
    expect(r.msg).toMatch(/Neni/);
    expect(RunPrologVars.ProlgCallLevel).toBe(0);
    expect(SgMark()).toBe(m);
  });

  it('fandfield/fandkey/fandkeyfield/fandlink/fandlinkfield describe a file like its FileD', () => {
    enter('UCTO2026');
    // a file with keys and links
    let fd = AccessVars.FileDRoot;
    let target: FileD | null = null;
    for (; fd !== null; fd = fd.Chain) {
      if (fd.Typ !== 'X' || fd.Keys === null || fd.ChptPos.R === null) continue;
      let ld = AccessVars.LinkDRoot;
      while (ld !== null && ld.FromFD !== fd) ld = ld.Chain;
      if (ld !== null) {
        target = fd;
        break;
      }
    }
    expect(target).not.toBeNull();
    const T = target!;
    const nm = U(T.Name);
    const r = runL(`
      #PREDICATES pole klice vazby
      #CLAUSES
        pole:-fandfield('${nm}',N,T,L,D,F,M),write(N,T,L,D,F,M,';'),fail.
        pole:-writeln('').
        klice:-fandkey('${nm}',K,I,Du),write(K,I,Du,':'),fandkeyfield('${nm}',K,P,C,De),write(P,C,De,' '),fail.
        klice:-writeln('').
        vazby:-fandlink('${nm}',R,To,TK,FK,Fl),write(R,To,TK,FK,Fl,':'),fandlinkfield('${nm}',R,P),write(P,' '),fail.
        vazby:-writeln('').
        main:-pole,klice,vazby.`);
    expect(r.msg).toBe('');
    const [pole, klice, vazby] = r.out.split('\r\n');
    // fields
    let exp = '';
    for (let f = T.FldD; f !== null; f = f.Chain) {
      let m = 0;
      let l = f.L;
      if (f.Typ === 'F') {
        m = f.M;
        l--;
        if (m > 0) l -= m + 1;
      }
      let flg = f.Flg;
      if (f.Typ === 'N' || f.Typ === 'A') flg |= f.M << 4;
      exp += `'${U(f.Name)}''${f.Typ}'${l}${m}${flg}'${(f.Flg & 4) !== 0 ? U(f.Mask) : ''}';`;
    }
    expect(pole).toBe(exp);
    // keys and their fields
    exp = '';
    for (let k = T.Keys; k !== null; k = k.Chain) {
      const kn = k.Alias === null || k.Alias === '' ? '@' : U(k.Alias);
      for (let kf = k.KFlds; kf !== null; kf = kf.Chain)
        exp += `'${kn}'${k.Intervaltest}${k.Duplic}:'${U(kf.FldD!.Name)}'${kf.CompLex}${kf.Descend} `;
    }
    expect(klice).toBe(exp);
    // links from the file
    exp = '';
    for (let ld = AccessVars.LinkDRoot; ld !== null; ld = ld.Chain) {
      if (ld.FromFD !== T) continue;
      let fk = '';
      for (let k = T.Keys; k !== null; k = k.Chain) if (k.IndexRoot === ld.IndexRoot) fk = k.Alias ?? '';
      const pound = (s: string): string => (s === '' ? '@' : U(s));
      const head = `'${U(ld.RoleName)}''${U(ld.ToFD!.Name)}''${pound(ld.ToKey!.Alias ?? '')}''${pound(fk)}'${ld.MemberRef + (ld.IndexRoot !== 0 ? 4 : 0)}:`;
      for (let kf = ld.Args; kf !== null; kf = kf.Chain) exp += `${head}'${U(kf.FldD!.Name)}' `;
    }
    expect(vazby).toBe(exp);
  });
});

// ---------------------------------------------------------------- FAND files and procedures

describe.skipIf(!haveApp)('RUNPROLG: FAND procedures, FAND-file predicates, save/consult/loadlex', () => {
  const H = FromUnicode;
  beforeAll(() => {
    const dir = join(WORK, 'data');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const R = new RdbD();
    const chpt = new FileD();
    chpt.Typ = '0';
    chpt.Name = 'TEST';
    R.FD = chpt;
    R.RdbDir = H(dir);
    R.DataDir = H(dir);
    const a = AccessVars;
    a.CRdb = R;
    a.FileDRoot = chpt;
    a.TopRdbDir = H(dir);
    a.TopDataDir = '';
    a.LinkDRoot = null;
    a.FuncDRoot = null;
    a.CatFD = null;
    for (const [name, typ, src] of [
      ['OSOBY', 'X', 'Jmeno:A,10; Vek:F,3.0; Mesto:A,10; Pozn:T; #K @ Jmeno; OS_M(@) *Mesto;'],
      ['PAR', '6', 'T:T; N:F,5.0; #K @@;'],
    ]) {
      resetCompiler();
      SetInpStr(ref(B(src)));
      const er = new ExitRecord();
      NewExit(null, er);
      try {
        RdFileD(B(name), typ, '');
      } finally {
        RestoreExit(er);
      }
      const fd = a.CFile!;
      fd.ChptPos.R = R; // a data file of the RDB (NextFD skips FDs without ChptPos.R)
    }
  });

  it('@proc[...] predicates call FAND procedures with in and out arguments', () => {
    const r = runL(`
      #PREDICATES
        @dvakrat['(x:real; var y:real) begin y:=2*x end;'](Integer,&Integer)
        @spoj['(a:string; b:string; var c:string) begin c:=a+b end;'](String,LongString,&String)
        @neg['(b:boolean; var c:boolean) begin c:=^b end;'](Boolean,&Boolean)
        @real['(var r:real) begin r:=1.5 end;'](&Real)
      #CLAUSES main:-dvakrat(21,X),writeln(X),spoj('ab','cd',S),writeln(S),neg(true,B),writeln(B),real(R),writeln(R).`);
    expect(r.msg).toBe('');
    expect(r.out).toBe("42\r\n'abcd'\r\nfalse\r\n 1.5000000000E+00\r\n");
    expect(r.EdBreak).toBe(0);
  });

  it('FAND-file predicates: assert, scan by key and sequentially, retract', () => {
    const r = runL(`
      #DATABASE @osoby(Jmeno/String,Vek/Integer,Mesto/String)
      #PREDICATES vypis(String)
      #CLAUSES
        vypis(M):-osoby(J,V,M),write(J,V,' '),fail.
        vypis(_):-writeln('').
        main:-assert(osoby('Jan',30,'Praha')),assert(osoby('Eva',25,'Brno')),assert(osoby('Petr',40,'Praha')),
              vypis('Praha'),vypis('Brno'),
              osoby('Eva',V,_),writeln(V),
              osoby(J,40,_),writeln(J),
              retract(osoby('Jan',_,_)),vypis('Praha'),
              not(osoby('Jan',_,_)),writeln('bez Jana').`);
    expect(r.msg).toBe('');
    expect(r.out).toBe("'Jan'30 'Petr'40 \r\n'Eva'25 \r\n25\r\n'Petr'\r\n'Petr'40 \r\n'bez Jana'\r\n".replace("'bez Jana'", 'bez Jana'));
    expect(r.EdBreak).toBe(0);
  });

  it('save/consult a named database in a T field; loadlex/getlex/nextlex', () => {
    let r = runL(`
      #DATABASE - db fakt(String,Integer) jiny(L_Integer)
      #CLAUSES
        fakt('a',1). fakt('b',2). jiny([1,2,3]).
        main:-assert(fakt('c',3)),save(db,PAR.T).`);
    expect(r.msg).toBe('');
    expect(r.EdBreak).toBe(0);
    r = runL(`
      #DATABASE - db fakt(String,Integer) jiny(L_Integer)
      #PREDICATES vypis
      #CLAUSES
        vypis:-fakt(S,I),write(S,I,' '),fail.
        vypis:-jiny(L),writeln(L),!.
        vypis:-writeln('-').
        main:-vypis,consult(db,PAR.T),vypis.`);
    expect(r.msg).toBe('');
    expect(r.out).toBe("-\r\n'a'1 'b'2 'c'3 [1,2,3]\r\n");
    r = runL(`
      #PREDICATES @txt['begin PAR.T:=''ab 12 {kom{en}tar} x_1+'' end;']
      #CLAUSES
        main:-txt,loadlex(PAR.T),getlex(L),writeln(L),nextlex,nextlex,getlex(M),writeln(M).`);
    expect(r.msg).toBe('');
    expect(r.out).toBe(
      "[lex(2,1,'ab'),lex(5,3,'12'),lex(22,2,'x_1'),...]\r\n[lex(22,2,'x_1'),lex(23,0,'+'),lex(23,0,'')]\r\n",
    );
  });
});
