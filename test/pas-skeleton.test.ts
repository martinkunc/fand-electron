import { describe, it, expect } from 'vitest';
import { ref, fref, CopyRec, AssignRec, GoExitSignal, NotImplementedError, notImpl } from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, ExitRecord, ProcStkD, NewExit, GoExit, RestoreExit, ChainLast, LastInChain, ListLength, ListAt,
  SetMsgPar, Set3MsgPar, HexD, GetStore, StoreStr,
} from '../src/engine/pas/base.ts';
import {
  AccessVars, FrmlElem, FrmlAt, LocVar, SumElem, FileD, FieldDescr, KeyFldD, XPage, XItem, XKey, XWKey, XScan,
  RdbPos, _const, _getlocvar, _plus, CompStr, CompLongStr, CompArea, EquKFlds, LocVarAd, GetWordVar, SetWordVar,
  FieldDMask, GetRecSpace, WordVarArr, SetDeletedFlag, DeletedFlag, SaveCompInp, CompInpD, XPageSize,
} from '../src/engine/pas/access.ts';
import {
  Instr, InpD, AssignD, RdRunVars, _proc, _edittxt, _puttxt, _window, _output, _locvar, EFldD, EdExitD, EdExKeyD,
  TestExitKey, SetMyBP, ResetLVBD, TypAndFrml, EditDCopiedFields, EditD, PInstrCodeNames, _portout,
} from '../src/engine/pas/rdrun.ts';
import { TEvent, DriversVars, FrameChars, ScrWrStr, ScrCell } from '../src/engine/pas/drivers.ts';

describe('pas skeleton: formulas', () => {
  it('FrmlElem zero defaults and same-offset aliases', () => {
    const z = new FrmlElem(_plus);
    expect(z.Op).toBe(_plus);
    expect(z.P1).toBeNull();
    expect(z.R).toBe(0);
    expect(z.S).toBe('');
    const a = new FrmlElem(_const);
    z.PP1 = a;
    expect(z.P1).toBe(a);
    expect(z.PPPPPP1).toBe(a);
    z.ownSum = a;
    expect(z.P2).toBe(a);
    z.Arg[2] = a;
    expect(new FrmlElem().Arg[2]).toBeNull();
    expect(Object.keys(new FrmlElem())).toEqual([]);
  });
  it('FrmlAt: a record viewed as a formula node', () => {
    const lv = new LocVar();
    lv.Op = _getlocvar;
    lv.BPOfs = 12;
    const z = FrmlAt(lv, { Op: 'Op', BPOfs: 'BPOfs' });
    expect(z.Op).toBe(_getlocvar);
    expect(z.BPOfs).toBe(12);
    lv.BPOfs = 16;
    expect(z.BPOfs).toBe(16);
    expect(FrmlAt(lv, { Op: 'Op', BPOfs: 'BPOfs' })).toBe(z);
    const s = new SumElem();
    s.Op = _const;
    const zs = FrmlAt(s, { Op: 'Op', R: 'R' });
    s.R = 5;
    expect(zs.R).toBe(5);
    const id = new InpD();
    const ze = FrmlAt(id, { Op: 'OpErr', B: 'Error' });
    id.Error = true;
    expect(ze.B).toBe(true);
  });
});

describe('pas skeleton: instructions', () => {
  it('Instr defaults, embedded records and aliases', () => {
    const p = new Instr(_proc);
    expect(p.Kind).toBe(_proc);
    expect(p.Bool).toBeNull();
    expect(p.PPos).toBeInstanceOf(RdbPos);
    p.PPos.IRec = 7;
    expect(new Instr(_proc).PPos.IRec).toBe(0);
    p.TArg[1] = new TypAndFrml();
    expect(p.TArg.length).toBe(2);
    const t = new Instr(_puttxt);
    t.TxtPath1 = 'X.TXT';
    expect(t.TxtPath).toBe('X.TXT');
    const w = new Instr(_window);
    expect(w.W2).toBe(w.W);
    expect(new Instr(_edittxt).Ww.C1).toBeNull();
    expect(PInstrCodeNames[_portout]).toBe('_portout');
    expect(PInstrCodeNames.length).toBe(_portout + 1);
  });
  it('AssignD aliases', () => {
    const a = new AssignD(_locvar);
    a.Frml1 = new FrmlElem(_const);
    a.Add1 = true;
    expect(a.Frml).toBe(a.Frml1);
    expect(a.Add).toBe(true);
    expect(new AssignD(_output).Add).toBe(false);
  });
  it('EFldD.Ed, TestExitKey', () => {
    const e = new EFldD();
    e.FldD = new FieldDescr();
    e.FldD.Flg = 1;
    e.EdN = true;
    expect(e.Ed(true)).toBe(true);
    expect(e.Ed(false)).toBe(false);
    const x = new EdExitD();
    x.Keys = new EdExKeyD();
    x.Keys.KeyCode = 0x3b00;
    x.Keys.Break = 5;
    expect(TestExitKey(0x3b00, x)).toBe(true);
    expect(AccessVars.EdBreak).toBe(5);
    expect(TestExitKey(1, x)).toBe(false);
  });
  it('EditD block-copied fields exist', () => {
    const e = new EditD();
    for (const f of EditDCopiedFields) expect(f in e).toBe(true);
  });
});

describe('pas skeleton: BASE', () => {
  it('NewExit / GoExit / RestoreExit', () => {
    const er = new ExitRecord();
    BaseVars.ExitP = true;
    let caught = false;
    NewExit(null, er);
    try {
      BaseVars.ExitP = false;
      GoExit();
    } catch (e) {
      if (!(e instanceof GoExitSignal)) throw e;
      caught = true;
      expect(BaseVars.ExitP).toBe(true); // restored from ExitBuf
    } finally {
      RestoreExit(er);
    }
    expect(caught).toBe(true);
    expect(BaseVars.ExitBuf.Armed).toBe(false);
  });
  it('chains', () => {
    const root = ref<KeyFldD | null>(null);
    const a = new KeyFldD();
    const b = new KeyFldD();
    ChainLast(root, a);
    ChainLast(root, b);
    expect(root.v).toBe(a);
    expect(a.Chain).toBe(b);
    expect(ListLength(root.v)).toBe(2);
    expect(ListAt(root.v, 1)).toBe(b);
    expect(LastInChain(root)).toBe(b);
    const empty = ref<KeyFldD | null>(null);
    LastInChain(empty).Chain = a;
    expect(empty.v).toBe(a);
    const fd = new FileD();
    const k = new XKey();
    ChainLast(fref(fd, 'Keys'), k);
    expect(fd.Keys).toBe(k);
  });
  it('trivial routines', () => {
    SetMsgPar('a');
    Set3MsgPar('x', 'y', 'z');
    expect(BaseVars.MsgPar.slice(1, 4)).toEqual(['x', 'y', 'z']);
    expect(HexD(0x12ab)).toBe('000012AB');
    expect(GetStore(4)).toEqual(new Uint8Array(4));
    expect(StoreStr('s')).toBe('s');
  });
});

describe('pas skeleton: ACCESS', () => {
  it('compare functions', () => {
    expect(CompStr('abc', 'abd')).toBe(2);
    expect(CompStr('abc', 'ab')).toBe(4);
    expect(CompStr('ab', 'ab')).toBe(1);
    expect(CompLongStr(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(1);
    expect(CompArea(new Uint8Array([3]), new Uint8Array([2]), 1)).toBe(4);
    const k1 = new KeyFldD();
    k1.FldD = new FieldDescr();
    k1.FldD.Name = 'A';
    const k2 = CopyRec(k1);
    expect(k2).not.toBe(k1);
    expect(EquKFlds(k1, k2)).toBe(true);
    k2.Descend = true;
    expect(EquKFlds(k1, k2)).toBe(false);
  });
  it('local variable frame', () => {
    const lv = new LocVar();
    lv.FTyp = 'R';
    lv.BPOfs = 8;
    const ps = new ProcStkD();
    ps.LVRoot = lv;
    SetMyBP(ps);
    expect(RdRunVars.LVBD.Root).toBe(lv);
    const slot = LocVarAd(lv);
    slot.v = 3.5;
    expect(ps.V[8]).toBe(3.5);
    SetMyBP(null);
    ResetLVBD();
    expect(RdRunVars.LVBD.Size).toBe(8);
  });
  it('record flags, word vars, Chpt alias, lazy work files', () => {
    const fd = new FileD();
    fd.Typ = 'X';
    fd.RecLen = 10;
    AccessVars.CFile = fd;
    AccessVars.CRecPtr = GetRecSpace();
    expect(AccessVars.CRecPtr.length).toBe(12);
    SetDeletedFlag();
    expect(DeletedFlag()).toBe(true);
    SetWordVar(5, 70000);
    expect(GetWordVar(5)).toBe(70000 & 0xffff);
    expect(AccessVars.MenuX).toBe(70000 & 0xffff);
    WordVarArr[0] = 12;
    expect(AccessVars.RprtLine).toBe(12);
    expect(WordVarArr[0]).toBe(12);
    AccessVars.Chpt = fd;
    expect(AccessVars.FileDRoot).toBe(fd);
    AccessVars.FileDRoot = null;
    expect(AccessVars.TWork).toBe(AccessVars.TWork);
    expect(AccessVars.XWork.Handle).toBe(0xff);
    const f = new FieldDescr();
    f.Mask = 'DD.MM.YYYY';
    expect(FieldDMask(f)).toBe('DD.MM.YYYY');
    const ci = new CompInpD();
    SaveCompInp(ci);
    expect(ci.InpRdbPos).not.toBe(AccessVars.InpRdbPos);
    AccessVars.CFile = null;
    AccessVars.CRecPtr = null;
  });
  it('index page views', () => {
    const p = new XPage();
    expect(p.Raw.length).toBe(2 * XPageSize); // room for a temporary overflow (INDEX.PAS: GetStore(2*XPageSize))
    p.IsLeaf = true;
    p.GreaterPage = 0x01020304;
    p.NItems = 3;
    expect(p.Raw[0]).toBe(1);
    expect(p.GreaterPage).toBe(0x01020304);
    expect(p.NItems).toBe(3);
    p.A[0] = 9;
    expect(p.Raw[7]).toBe(9);
    const x = new XItem(p.Raw, 7);
    x.DownPage = 1234;
    expect(x.DownPage).toBe(1234);
    expect(new XWKey()).toBeInstanceOf(XKey);
    expect(new XScan().EOF).toBe(false);
  });
  it('stubs throw NotImplementedError', () => {
    expect(() => notImpl('ACCESS.Example')).toThrow(NotImplementedError); // ReadRec is implemented now
  });
  it('AssignRec resets prototype defaults', () => {
    const a = new Instr(_proc);
    const b = new Instr(_proc);
    b.N = 3;
    AssignRec(b, a);
    expect(b.N).toBe(0);
  });
});

describe('pas skeleton: DRIVERS', () => {
  it('TEvent overlays and constants', () => {
    const e = new TEvent();
    e.KeyCode = 0x3b00;
    expect(e.ScanCode).toBe(0x3b);
    e.CharCode = 'a';
    expect(e.KeyCode).toBe(0x3b61);
    expect(DriversVars.EventQueue.length).toBe(16);
    expect(FrameChars.length).toBe(21);
    ScrWrStr(0, 0, 'x', 7); // headless: video memory only
    expect(ScrCell(0, 0)).toBe(0x0778);
  });
});
