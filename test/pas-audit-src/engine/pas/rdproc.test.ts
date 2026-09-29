// Audit of RDPROC.PAS RdRDBCall (CALL([\]rdb[,proc(args)])) and the identifier length limit of
// LEXANAL.PAS RdLex, driven by a bring-up discrepancy:
//
// Ostatní > Vlastní programy > Speciální podprogramy > module 01: MyCall1 stores
// 'begin call(SPEC01) end;' in PARAM3.TTT and DynamProc runs proc([PARAM3.TTT]). The reference
// FAND shows 'dlouhý název' (message 1002) and then 'úloha SPEC01 není odladěna' (630); ours shows
// the Hlášení of SPEC01's MAIN ('Pro modul 01 není zatím žádný speciální podprogram').
//
// Cause (reference side, found with an instrumented copy of the FPC build): the Error 2 is raised
// in ReadProcHead of SPEC01's MAIN (RUNPROC CallProcedure <- RunMainProc <- EditExecRdb), not in
// RdRDBCall. The FPC port decrypts the T-file header in FILEACC.TFile.RdPrefix with FPC's own
// System.Random (Mersenne Twister) instead of BP7's linear congruential generator, so the password
// area of SPEC01.TRO decodes to garbage, PROJMGR.CreateOpenChpt's HasPassword(Chpt,1,'') fails and
// CRdb^.Encrypted becomes true for an unprotected project. SetInpTTPos then XORs the plain chapter
// text with $AA and the lexer meets a 33+ character "identifier". With the BP7 generator the password
// area is 40 '@' (no password), so the text is read as it is - which is what ours does. Nothing to fix
// on our side; the tests below pin the BP7 behaviour and the compile of the CALL statement.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ref, getWord, GoExitSignal, FromUnicode } from '../../../../src/engine/pas/pasrt.ts';
import {
  BaseVars, OpenH, ReadH, PosH, _isoldfile, RdOnly, NewExit, RestoreExit, ExitRecord, FormatCache,
  type TMsgIdxItem,
} from '../../../../src/engine/pas/base.ts';
import { SetDriversCrt } from '../../../../src/engine/pas/drivers.ts';
import { Crt } from '../../../../src/engine/console/crt.ts';
import { KeyQueue } from '../../../../src/engine/console/keyqueue.ts';
import { encode852, decode852 } from '../../../../src/engine/console/cp852.ts';
import { AccessVars, FileD, RdbD, RdbPos, ResetCompilePars } from '../../../../src/engine/pas/access.ts';
import { SetInpStr, RdLex } from '../../../../src/engine/pas/compile.ts';
import { ReadProcHead, ReadProcBody } from '../../../../src/engine/pas/rdproc.ts';
import { _call, _proc, type InstrPtr } from '../../../../src/engine/pas/rdrun.ts';
import { Rdb } from '../../../../src/engine/fand/rdb.ts';
import { TpRandom, xorAA } from '../../../../src/engine/fand/coding.ts';

const ROOT = join(import.meta.dirname, '../../../..');
const APP = join(ROOT, 'vendor/extracted/app');
const haveApp = existsSync(join(APP, 'UCTO2026.RDB')) && existsSync(join(APP, 'FAND.RES'));

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

function ok<T>(body: () => T): T {
  const er = new ExitRecord();
  NewExit(null, er);
  try {
    return body();
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
    throw new Error(`compile error: ${U(BaseVars.MsgLine)}`);
  } finally {
    RestoreExit(er);
  }
}

/** A procedure chapter compiled from a (Unicode) string. */
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

beforeAll(() => {
  const kq = new KeyQueue();
  kq.close();
  SetDriversCrt(new Crt(kq, null, 80, 25));
  FormatCache();
  if (haveApp) loadResMessages();
});

beforeEach(() => {
  const a = AccessVars;
  ResetCompilePars();
  a.RdFldNameFrml = null;
  a.Switches = '';
  a.SwitchLevel = 0;
  a.FrmlSumEl = null;
  a.IsCompileErr = false;
  a.FuncDRoot = null;
  a.IsTestRun = false;
  a.LinkDRoot = null;
  a.CatFD = null;
  const chpt = new FileD();
  chpt.Name = 'TEST';
  const R = new RdbD();
  R.FD = chpt;
  a.FileDRoot = chpt;
  a.CRdb = R;
  a.InpRdbPos = new RdbPos();
});

describe.skipIf(!haveApp)('RDPROC RdRDBCall', () => {
  it("'begin call(SPEC01) end;' (MyCall1's dynamic program): rdb SPEC01, procedure main", () => {
    const pd = proc('begin call(SPEC01) end;');
    expect(pd!.Kind).toBe(_call);
    expect(pd!.Chain).toBeNull();
    expect([pd!.RdbNm, pd!.ProcNm, pd!.ProcCall]).toEqual(['SPEC01', 'main', null]);
  });

  it('a leading backslash is kept in the rdb name', () => {
    const pd = proc('begin call(\\SPEC01) end;');
    expect([pd!.RdbNm, pd!.ProcNm]).toEqual(['\\SPEC01', 'main']);
  });

  it('call(rdb,proc) and call(rdb,proc(args)): the procedure call is read with RdProcArg(C)', () => {
    let pd = proc('begin call(MODUL01,CallSest01) end;');
    expect([pd!.RdbNm, pd!.ProcNm, pd!.ProcCall!.Kind, pd!.ProcCall!.N, pd!.ProcCall!.ExPar]).toEqual([
      'MODUL01', 'CallSest01', _proc, 0, false,
    ]);
    pd = proc("begin call(MODUL09,Akce('a',1+2)) end;");
    expect([pd!.RdbNm, pd!.ProcNm, pd!.ProcCall!.N]).toEqual(['MODUL09', 'Akce', 2]);
    expect(pd!.ProcCall!.TArg.slice(1, 3).map((t) => t.FTyp)).toEqual(['S', 'R']);
  });

  it("rdb name up to 8, procedure name up to 12 characters, longer ones: 'dlouhý název'", () => {
    expect(proc('begin call(ABCDEFGH) end;')!.RdbNm).toBe('ABCDEFGH');
    expect(procErr('begin call(ABCDEFGHI) end;')).toBe('dlouhý název');
    // the backslash does not count
    expect(proc('begin call(\\ABCDEFGH) end;')!.RdbNm).toBe('\\ABCDEFGH');
    expect(proc('begin call(A,ABCDEFGHIJKL) end;')!.ProcNm).toBe('ABCDEFGHIJKL');
    expect(procErr('begin call(A,ABCDEFGHIJKLM) end;')).toBe('dlouhý název');
  });
});

describe.skipIf(!haveApp)('LEXANAL RdLex identifier length', () => {
  it("32 characters are an identifier, the 33rd gives 'dlouhý název'", () => {
    const id32 = 'A'.repeat(31) + '1';
    SetInpStr(ref(B(id32 + ' x')));
    ok(() => RdLex());
    expect(AccessVars.LexWord).toBe(id32);
    SetInpStr(ref(B(id32 + 'Z')));
    expect(compileErr(() => RdLex())).toBe('dlouhý název');
  });
});

describe.skipIf(!haveApp)("SPEC01.PRO: an unprotected project (the reference's 'dlouhý název')", () => {
  it('the TRO header decrypted with the BP7 generator has no password 1, so texts are not decoded', () => {
    const t = Uint8Array.from(readFileSync(join(APP, 'SPEC01.TRO')).subarray(0, 512));
    const irec = t[11] | (t[12] << 8);
    expect(irec & 0x4000).toBe(0x4000); // the newer header: seed MLen+Time, PwNew at 471
    const maxPage = new DataView(t.buffer).getInt32(17, true);
    const rnd = new TpRandom((maxPage + 1) * 512 + t[511]);
    for (let i = 13; i <= 510; i++) t[i] ^= rnd.next(255);
    // PwCode and Pw2Code: 40 '@' = no passwords (FILEACC.RdPrefix, WWMIX.HasPassword)
    expect(Buffer.from(t.subarray(471, 511)).toString('latin1')).toBe('@'.repeat(40));
    const r = new Rdb(join(APP, 'SPEC01.PRO'));
    try {
      expect([r.encrypted, r.tfile.licenseNr, r.tfile.header.password1]).toEqual([false, 0, '']);
    } finally {
      r.close();
    }
  });

  it("MAIN's head compiles from the plain text; the $AA-coded text is what the reference lexes", () => {
    const r = new Rdb(join(APP, 'SPEC01.PRO'));
    let plain: Uint8Array;
    try {
      const main = r.chapters.find((c) => c.typ === 'P' && c.name === 'MAIN')!;
      plain = r.textBytes(main);
    } finally {
      r.close();
    }
    const S = (b: Uint8Array): string => String.fromCharCode(...b);
    expect(U(S(plain))).toContain('Pro modul 01 není zatím žádný speciální podprogram');
    SetInpStr(ref(S(plain)));
    ok(() => ReadProcHead());
    expect(AccessVars.LexWord.toUpperCase()).toBe('BEGIN');
    // CRdb^.Encrypted wrongly true (FPC build): SetInpTTPos XORs the text with $AA -> Error 2
    SetInpStr(ref(S(xorAA(plain))));
    expect(compileErr(() => ReadProcHead())).toBe('dlouhý název');
  });
});
