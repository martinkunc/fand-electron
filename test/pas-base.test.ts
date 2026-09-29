// BASE package: base.ts, common.ts (COMMONFPC), memory.ts, handle.ts, disk.ts (DISKFPC).
// Uses the pristine Účto install read-only (FAND.RES, FAND.CFG) and a scratch dir work/tmp-base.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ref, ToUnicode, FromUnicode, StrToBytes, BytesToStr, getWord, Clock, DirectorySeparator,
} from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, InitBase, RdMsg, SetMsgPar, PrTab, SetCurrPrinter, prName, FandFace, SizeOfResA,
  MsgIdxFromBytes, SizeOfSpec, SizeOfVideo, SizeOfColors, SizeOfFonts, LoadSpec, LoadVideo, LoadColors, LoadFonts,
  CachePage, OpenH, ReadH, WriteH, SeekH, PosH, FileSizeH, TruncH, CloseH, CloseClearH, DeleteFile, RenameFile56,
  UnixPath, MyFExpand, GetFileAttr, SetFileAttr, IsUpdHandle, RdWrCache, FlushHandles,
  _isnewfile, _isoldfile, _isoldnewfile, _isoverwritefile, RdOnly, Exclusive,
  FormatCache, Cache, CacheExist, SaveCache, ClearCacheH, SubstHandle, OSshell,
  ReplaceChar, SEquUpcase, StrPas, StrLPCopy, SLeadEqu, EqualsMask, EquLongStr, EquArea, SwapLong, ExChange,
  OverlapByteStr, CountDLines, GetDLine, FindCtrlM, SkipCtrlMJ, AddBackSlash, DelBackSlash, HexStrToLong,
  RDate, SplitDate, AddMonth, DifMonth, ValDate, StrDate, Today, CurrTime, LenStyleStr, LogToAbsLenStyleStr,
  SetStyleAttr, HexPtr, ListAt, WrStyleStr, WriteMsg, ClearLL,
} from '../src/engine/pas/base.ts';
import { FatGet, FatPut, TcFile, FillVolDirEntry, RingBufSz } from '../src/engine/pas/disk.ts';
import { SetDriversCrt, AssignCrt, DriversVars } from '../src/engine/pas/drivers.ts';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { TxtRewrite, TxtClose, Output } from '../src/engine/pas/pasrt.ts';
import { dateToDayNumber, dayNumberToDate, readReal48 } from '../src/engine/fand/numbers.ts';

const APP = resolve('vendor/extracted/app');
const TMP = resolve('work/tmp-base');

// RUNFAND.InitRunFand: the FAND.RES header after BASE opened the file
function ReadResHeader(): number {
  const h = BaseVars.ResFile.Handle;
  const b = new Uint8Array(SizeOfResA);
  ReadH(h, 2, b);
  const ver = getWord(b, 0);
  ReadH(h, SizeOfResA, b);
  BaseVars.ResFile.SetA(b);
  ReadH(h, 2, b);
  BaseVars.MsgIdxN = getWord(b, 0);
  const mi = new Uint8Array(5 * BaseVars.MsgIdxN);
  ReadH(h, mi.length, mi);
  BaseVars.MsgIdx = MsgIdxFromBytes(mi, BaseVars.MsgIdxN);
  BaseVars.FrstMsgPos = PosH(h);
  return ver;
}

// RUNFAND.RdCFG with typ = 3 (VGA)
function ReadCfg(): void {
  BaseVars.CVol = '';
  BaseVars.CPath = MyFExpand('FAND.CFG', 'FANDCFG');
  const h = OpenH(_isoldfile, RdOnly);
  expect(BaseVars.HandleError).toBe(0);
  const rd = (n: number): Uint8Array => {
    const b = new Uint8Array(n);
    expect(ReadH(h, n, b)).toBe(n);
    return b;
  };
  expect(BytesToStr(rd(4))).toBe(BaseVars.CfgVersion);
  LoadSpec(rd(SizeOfSpec));
  SeekH(h, PosH(h) + (SizeOfVideo + SizeOfColors) * 2);
  LoadVideo(rd(SizeOfVideo));
  LoadColors(rd(SizeOfColors));
  LoadFonts(rd(SizeOfFonts));
  BaseVars.CharOrdTab.set(rd(256));
  BaseVars.UpcCharTab.set(rd(256));
  BaseVars.prMax = rd(1)[0];
  for (let j = 1; j <= BaseVars.prMax; j++) {
    const A: number[] = [];
    for (let i = 0; i <= 32; i++) {
      const l = rd(1)[0];
      A.push(l, ...rd(l));
    }
    expect(rd(1)[0]).toBe(0xff);
    const pr = BaseVars.printer[j - 1];
    pr.Strg = Uint8Array.from(A);
    const t = rd(4);
    pr.Typ = String.fromCharCode(t[0]);
    pr.Kod = String.fromCharCode(t[1]);
    pr.Lpti = t[2];
    pr.TmOut = t[3];
  }
  BaseVars.NWDaysTab = getWord(rd(2), 0);
  BaseVars.WDaysFirst = readReal48(rd(6));
  BaseVars.WDaysLast = readReal48(rd(6));
  CloseH(h);
}

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  process.env.FANDRES = APP;
  process.env.FANDCFG = APP;
  InitBase();
});

describe('BASE: FAND.RES and FAND.CFG of Účto', () => {
  it('opens FAND.RES and reads the header', () => {
    expect(BaseVars.FandResName).toBe(FromUnicode(join(APP, 'FAND.RES')));
    expect(BaseVars.UserLicNr).toBe(15961);
    expect(ReadResHeader()).toBe(0x0420);
    expect(BaseVars.MsgIdxN).toBeGreaterThan(10);
    expect(BaseVars.MsgIdx![1]).toEqual({ Nr: 9999, Ofs: 0, Count: 1 });
    expect(BaseVars.ResFile.A[FandFace].Size).toBe(492);
  });
  it('RdMsg: Kamenický -> CP852, $ parameters, missing messages', () => {
    RdMsg(50);
    expect(BaseVars.MsgLine).toBe('AN');
    RdMsg(3);
    expect(ToUnicode(BaseVars.MsgLine)).toBe('Návrat do FANDu příkazem EXIT');
    SetMsgPar(FromUnicode('Účty'));
    RdMsg(39);
    expect(ToUnicode(BaseVars.MsgLine)).toBe('generovat deklarace Účty podle fyzického souboru A/N?');
    RdMsg(12345);
    expect(ToUnicode(BaseVars.MsgLine)).toBe('zpráva 12345 chybí ve FAND.RES');
    SetMsgPar('x'.repeat(100));
    expect(BaseVars.MsgPar[1].length).toBe(80); // ScreenStr
  });
  it('TResFile.Get / GetStr read resource items', () => {
    const p = ref<Uint8Array | null>(null);
    expect(BaseVars.ResFile.Get(FandFace, p)).toBe(492);
    expect(p.v!.length).toBe(492);
    const s = BaseVars.ResFile.GetStr(FandFace);
    expect(Array.from(s)).toEqual(Array.from(p.v!));
  });
  it('FAND.CFG: spec, video, colors, fonts, tables, printers', () => {
    ReadCfg();
    expect(BaseVars.Spec.AutoRprtWidth).toBe(80);
    expect(BaseVars.Spec.F10Enter).toBe(true);
    expect(BaseVars.Spec.OffDefaultYear).toBe(10);
    expect(BaseVars.Spec.WithDiskFree).toBe(true);
    expect(BaseVars.Video.address).toBe(0xb800);
    expect(BaseVars.Video.cursOn).toBe(0x0607);
    expect(BaseVars.Colors.tNorm).toBe(7);
    expect(BaseVars.Colors.DesktopColor).toBe(1);
    expect(BaseVars.Fonts.VFont).toBe(1); // foLatin2
    expect(BaseVars.UpcCharTab[0x61]).toBe(0x41);
    expect(BaseVars.UpcCharTab[0x9f]).toBe(0xac); // č -> Č
    expect(SEquUpcase(FromUnicode('účto'), FromUnicode('ÚČTO'))).toBe(true);
    expect(BaseVars.prMax).toBe(5);
    SetCurrPrinter(1);
    expect(BaseVars.prCurr).toBe(1);
    expect(PrTab(prName)).toBe('HPDJ Lat');
    SetCurrPrinter(0);
    expect(PrTab(prName)).toBe('Windows3');
    SetCurrPrinter(9); // >= prMax: ignored
    expect(BaseVars.prCurr).toBe(0);
    expect(BaseVars.NWDaysTab).toBe(130);
  });
});

describe('COMMON: strings and buffers', () => {
  it('ReplaceChar modifies the caller string (BP7)', () => {
    const s = ref('a.b.c');
    ReplaceChar(s, '.', '/');
    expect(s.v).toBe('a/b/c');
  });
  it('StrPas, StrLPCopy, SLeadEqu', () => {
    expect(StrPas(Uint8Array.from([0x41, 0x42, 0, 0x43]))).toBe('AB');
    const d = new Uint8Array(4).fill(9);
    StrLPCopy(d, 'ABCDEF', 4);
    expect(Array.from(d)).toEqual([0x41, 0x42, 0x43, 0]);
    expect(SLeadEqu('ABCX', 'ABCY')).toBe(3);
    expect(SLeadEqu('AB', 'ABC')).toBe(2);
    expect(SLeadEqu('', 'A')).toBe(0);
  });
  it('EqualsMask with BP7 semantics', () => {
    const m = (s: string, mask: string): boolean => EqualsMask(StrToBytes(s), s.length, mask);
    expect(m('UCTO.RDB', '*.RDB')).toBe(true);
    expect(m('ucto.rdb', '*.RDB')).toBe(true); // Účto's CharOrdTab folds case
    expect(m('UCTO.RDX', '*.RDB')).toBe(false);
    expect(m('ABC', 'A?C')).toBe(true);
    expect(m('ABC', 'A*')).toBe(true);
    expect(m('ABC', '*')).toBe(true);
    expect(m('', '*')).toBe(true);
    expect(m('ABC', 'AB')).toBe(false);
    expect(m('AB', 'ABC')).toBe(false);
    expect(m('ABCBC', '*BC')).toBe(true);
    expect(m('A1B', 'A*B')).toBe(true);
    expect(m('AXB', 'A*?')).toBe(false); // BP7: the char after '*' is literal
    expect(m('AX?', 'A*?')).toBe(true);
    expect(m('ABC', 'A**')).toBe(false);
  });
  it('EquLongStr, EquArea, SwapLong, ExChange, OverlapByteStr', () => {
    expect(EquLongStr(StrToBytes('abc'), StrToBytes('abc'))).toBe(true);
    expect(EquLongStr(StrToBytes('abc'), StrToBytes('abd'))).toBe(false);
    expect(EquArea(StrToBytes('abcx'), StrToBytes('abcy'), 3)).toBe(true);
    expect(SwapLong(0x12345678)).toBe(0x78563412);
    expect(SwapLong(0x000000ff)).toBe(-0x01000000);
    const x = StrToBytes('ab'), y = StrToBytes('cd');
    ExChange(x, y, 2);
    expect(BytesToStr(x) + BytesToStr(y)).toBe('cdab');
    expect(OverlapByteStr('abc', 'xyc')).toBe(true);
    expect(OverlapByteStr('abc', 'xyz')).toBe(false);
  });
  it('CountDLines, GetDLine (CR LF), FindCtrlM, SkipCtrlMJ', () => {
    const b = StrToBytes('one\r\ntwo\r\nthree');
    expect(CountDLines(b, b.length, '\r')).toBe(3);
    expect(CountDLines(b, 0, '\r')).toBe(0);
    expect(GetDLine(b, b.length, '\r', 1)).toBe('one');
    expect(GetDLine(b, b.length, '\r', 2)).toBe('two');
    expect(GetDLine(b, b.length, '\r', 3)).toBe('three');
    expect(GetDLine(b, b.length, '\r', 4)).toBe('');
    const m = StrToBytes('ab\r\ncd\ref');
    expect(FindCtrlM(m, 1, 1)).toBe(3);
    expect(FindCtrlM(m, 1, 2)).toBe(7);
    expect(FindCtrlM(m, 1, 3)).toBe(m.length + 1);
    expect(SkipCtrlMJ(m, 3)).toBe(5);
    expect(SkipCtrlMJ(m, 7)).toBe(8);
  });
  it('AddBackSlash, DelBackSlash, HexStrToLong, HexPtr, ListAt', () => {
    const S = ref('dir');
    AddBackSlash(S);
    expect(S.v).toBe('dir' + DirectorySeparator);
    AddBackSlash(S);
    expect(S.v).toBe('dir' + DirectorySeparator);
    DelBackSlash(S);
    expect(S.v).toBe('dir');
    const e = ref('');
    AddBackSlash(e);
    expect(e.v).toBe('');
    expect(HexStrToLong('1aF')).toBe(0x1af);
    expect(HexStrToLong('FFFFFFFF')).toBe(-1);
    expect(HexStrToLong('1G')).toBe(0);
    expect(HexPtr(0x1234)).toBe('00001234');
    interface E {
      Chain: E | null;
    }
    const c: E = { Chain: { Chain: null } };
    expect(ListAt(c, 1)).toBe(c.Chain);
  });
  it('LenStyleStr, LogToAbsLenStyleStr, SetStyleAttr', () => {
    const s = 'a\x13bc\x13d';
    expect(LenStyleStr(s)).toBe(4);
    expect(LogToAbsLenStyleStr(s, 2)).toBe(3);
    expect(LogToAbsLenStyleStr(s, 4)).toBe(6);
    const a = ref(0);
    expect(SetStyleAttr('\x13', a)).toBe(true);
    expect(a.v).toBe(BaseVars.Colors.tUnderline);
    expect(SetStyleAttr('x', a)).toBe(false);
  });
});

describe('COMMON: dates', () => {
  afterEach(() => {
    BaseVars.userToday = 0;
    Clock.now = () => new Date();
  });
  it('RDate / SplitDate agree with fand/numbers day numbers', () => {
    expect(RDate(2026, 9, 28, 0, 0, 0, 0)).toBe(dateToDayNumber(2026, 9, 28));
    expect(RDate(1, 1, 1, 0, 0, 0, 0)).toBe(1);
    expect(RDate(2025, 2, 29, 0, 0, 0, 0)).toBe(0);
    expect(RDate(2024, 2, 29, 0, 0, 0, 0)).toBe(dateToDayNumber(2024, 2, 29));
    expect(RDate(0, 0, 0, 12, 0, 0, 0)).toBe(0.5);
    const d = ref(0), m = ref(0), y = ref(0);
    for (let n = 693000; n < 745000; n += 37) {
      SplitDate(n + 0.25, d, m, y);
      expect({ y: y.v, m: m.v, d: d.v }).toEqual(dayNumberToDate(n));
    }
    SplitDate(0, d, m, y);
    expect([d.v, m.v, y.v]).toEqual([1, 1, 1]);
  });
  it('AddMonth, DifMonth', () => {
    const r = AddMonth(RDate(2024, 1, 31, 12, 0, 0, 0), 1);
    expect(r).toBe(RDate(2024, 2, 29, 12, 0, 0, 0));
    expect(AddMonth(RDate(2023, 12, 15, 0, 0, 0, 0), 2)).toBe(RDate(2024, 2, 15, 0, 0, 0, 0));
    expect(AddMonth(RDate(2024, 3, 31, 0, 0, 0, 0), -1)).toBe(RDate(2024, 2, 29, 0, 0, 0, 0));
    expect(DifMonth(RDate(2025, 11, 5, 0, 0, 0, 0), RDate(2026, 2, 1, 0, 0, 0, 0))).toBe(3);
  });
  it('ValDate / StrDate with date masks', () => {
    const r = RDate(2026, 9, 28, 0, 0, 0, 0);
    expect(ValDate('28.09.2026', 'DD.MM.YYYY')).toBe(r);
    expect(StrDate(r, 'DD.MM.YYYY')).toBe('28.09.2026');
    expect(StrDate(r, 'D.M.YY')).toBe('8.9.26');
    expect(StrDate(r, 'YYYYMMDD')).toBe('20260928');
    expect(StrDate(0, 'DD.MM.YYYY')).toBe('  .  .    ');
    expect(ValDate('31.02.2026', 'DD.MM.YYYY')).toBe(0);
    expect(ValDate('28.13.2026', 'DD.MM.YYYY')).toBe(0);
    expect(ValDate('x', 'DD.MM.YYYY')).toBe(0);
    // two-digit years: Spec.OffDefaultYear pivots the century
    BaseVars.userToday = r;
    const off = BaseVars.Spec.OffDefaultYear;
    BaseVars.Spec.OffDefaultYear = 10; // pivot (2026+10) mod 100 = 36
    expect(ValDate('1.1.35', 'DD.MM.YY')).toBe(RDate(2035, 1, 1, 0, 0, 0, 0));
    expect(ValDate('1.1.37', 'DD.MM.YY')).toBe(RDate(1937, 1, 1, 0, 0, 0, 0));
    BaseVars.Spec.OffDefaultYear = 0;
    expect(ValDate('1.1.37', 'DD.MM.YY')).toBe(RDate(2037, 1, 1, 0, 0, 0, 0));
    BaseVars.Spec.OffDefaultYear = off;
    // missing parts come from Today
    expect(ValDate('15', 'DD.MM.YYYY')).toBe(RDate(2026, 9, 15, 0, 0, 0, 0));
    expect(ValDate(' 5.10.', 'DD.MM.YYYY')).toBe(RDate(2026, 10, 5, 0, 0, 0, 0));
  });
  it('ValDate / StrDate with time masks', () => {
    expect(ValDate('12:30', 'hh:mm')).toBe((12 * 60 + 30) / 1440);
    expect(StrDate(0.5, 'hh:mm')).toBe('12:00');
    expect(StrDate(0.5, 'hh:mm:ss')).toBe('12:00:00');
    expect(StrDate(1.5, 'hhh:mm')).toBe(' 36:00');
    expect(StrDate(-0.5, 'hh:mm')).toBe('-12:00');
    expect(ValDate('-1:30', 'hh:mm')).toBe(-1.5 / 24); // the '-' takes one digit place
    expect(ValDate('-01:30', 'hh:mm')).toBe(0);
    expect(ValDate('00:00', 'hh:mm')).toBe(1e-11);
    expect(ValDate('25:00', 'hh:mm')).toBe(25 / 24); // hours are the leading unit: no limit
    expect(ValDate('10:75', 'hh:mm')).toBe(0);
    expect(ValDate('1.1.2026 25:00', 'D.M.YYYY hh:mm')).toBe(0);
    expect(ValDate('3 12:00', 'D hh:mm')).toBe(3.5);
    expect(StrDate(3.5, 'D hh:mm')).toBe('3 12:00');
    const r = RDate(2026, 9, 28, 13, 45, 10, 0);
    expect(StrDate(r, 'DD.MM.YYYY hh:mm:ss')).toBe('28.09.2026 13:45:10');
    expect(ValDate('28.09.2026 13:45:10', 'DD.MM.YYYY hh:mm:ss')).toBeCloseTo(r, 9);
  });
  it('Today and CurrTime use the host clock (Clock.now) unless userToday', () => {
    Clock.now = () => new Date(2026, 8, 28, 18, 0, 0, 0);
    expect(Today()).toBe(RDate(2026, 9, 28, 0, 0, 0, 0));
    expect(CurrTime()).toBe(0.75);
    BaseVars.userToday = 5;
    expect(Today()).toBe(5);
  });
});

describe('HANDLE: host files', () => {
  it('OpenH modes, ReadH/WriteH/SeekH/PosH/FileSizeH/TruncH', () => {
    const p = FromUnicode(join(TMP, 'a.dat'));
    BaseVars.CPath = p;
    BaseVars.CVol = '';
    let h = OpenH(_isnewfile, Exclusive);
    expect(BaseVars.HandleError).toBe(0);
    expect(h).toBeGreaterThanOrEqual(5);
    expect(IsUpdHandle(h)).toBe(true);
    WriteH(h, 5, StrToBytes('hello'));
    expect(PosH(h)).toBe(5);
    SeekH(h, 10); // a hole of zeros
    WriteH(h, 2, StrToBytes('!!'));
    expect(FileSizeH(h)).toBe(12);
    expect(PosH(h)).toBe(12);
    SeekH(h, 1);
    const b = new Uint8Array(20);
    expect(ReadH(h, 20, b)).toBe(11);
    expect(BytesToStr(b, 0, 11)).toBe('ello\0\0\0\0\0!!');
    expect(ReadH(h, 5, b)).toBe(0); // at EOF
    TruncH(h, 4);
    expect(FileSizeH(h)).toBe(4);
    CloseH(h);
    expect(IsUpdHandle(h)).toBe(false);
    // _isnewfile on an existing file
    expect(OpenH(_isnewfile, Exclusive)).toBe(0xff);
    expect(BaseVars.HandleError).toBe(80);
    // _isoldfile: read-only, not updated
    h = OpenH(_isoldfile, RdOnly);
    expect(IsUpdHandle(h)).toBe(false);
    expect(FileSizeH(h)).toBe(4);
    const hh = ref(h);
    CloseClearH(hh);
    expect(hh.v).toBe(0xff);
    // _isoverwritefile truncates
    h = OpenH(_isoverwritefile, Exclusive);
    expect(FileSizeH(h)).toBe(0);
    CloseH(h);
    // missing file / missing directory
    BaseVars.CPath = FromUnicode(join(TMP, 'none.dat'));
    expect(OpenH(_isoldfile, RdOnly)).toBe(0xff);
    expect(BaseVars.HandleError).toBe(2);
    BaseVars.CPath = FromUnicode(join(TMP, 'nodir', 'none.dat'));
    OpenH(_isoldfile, RdOnly);
    expect(BaseVars.HandleError).toBe(3);
    // _isoldnewfile creates
    BaseVars.CPath = FromUnicode(join(TMP, 'b.dat'));
    h = OpenH(_isoldnewfile, Exclusive);
    expect(BaseVars.HandleError).toBe(0);
    CloseH(h);
    expect(fs.existsSync(join(TMP, 'b.dat'))).toBe(true);
  });
  it('UnixPath: case-insensitive components, drive letters, backslashes', () => {
    fs.mkdirSync(join(TMP, 'Sub', '(stan)'), { recursive: true });
    fs.writeFileSync(join(TMP, 'Sub', '(stan)', 'Data.000'), 'x');
    const up = FromUnicode(join(TMP, 'SUB', '(STAN)', 'DATA.000'));
    expect(UnixPath(up)).toBe(FromUnicode(join(TMP, 'Sub', '(stan)', 'Data.000')));
    // a missing last component keeps its case
    expect(UnixPath(FromUnicode(join(TMP, 'SUB', 'NEW.TXT')))).toBe(FromUnicode(join(TMP, 'Sub', 'NEW.TXT')));
    process.env.FAND_DRIVE_Q = TMP;
    expect(UnixPath('Q:\\SUB\\(STAN)\\data.000')).toBe(FromUnicode(join(TMP, 'Sub', '(stan)', 'Data.000')));
    expect(UnixPath('q:\\')).toBe(FromUnicode(TMP + '/'));
    delete process.env.FAND_DRIVE_Q;
    // no drive mapping: the parent of the cwd
    const cwd = process.cwd();
    expect(UnixPath('X:\\zz')).toBe(FromUnicode(cwd.slice(0, cwd.lastIndexOf('/') + 1) + 'zz'));
    // open through a DOS-cased path
    BaseVars.CPath = up;
    const h = OpenH(_isoldfile, RdOnly);
    expect(BaseVars.HandleError).toBe(0);
    CloseH(h);
  });
  it('DeleteFile, RenameFile56, GetFileAttr/SetFileAttr, MyFExpand', () => {
    const a = FromUnicode(join(TMP, 'r1.txt')), b = FromUnicode(join(TMP, 'R2.TXT'));
    fs.writeFileSync(ToUnicode(a), 'r');
    RenameFile56(a, b, false);
    expect(BaseVars.HandleError).toBe(0);
    expect(fs.existsSync(ToUnicode(b))).toBe(true);
    RenameFile56(a, b, false);
    expect(BaseVars.HandleError).toBe(1);
    BaseVars.CPath = b;
    expect(GetFileAttr() & 0x01).toBe(0);
    SetFileAttr(GetFileAttr() | 0x01);
    expect(BaseVars.HandleError).toBe(0);
    expect(GetFileAttr() & 0x01).toBe(1);
    SetFileAttr(GetFileAttr() & 0x26);
    expect(GetFileAttr() & 0x01).toBe(0);
    BaseVars.CPath = FromUnicode(join(TMP, 'none'));
    expect(GetFileAttr()).toBe(0);
    expect(BaseVars.HandleError).toBe(1);
    DeleteFile(b);
    expect(BaseVars.HandleError).toBe(0);
    DeleteFile(b);
    expect(BaseVars.HandleError).toBe(1);
    process.env.FANDTESTX = TMP;
    fs.writeFileSync(join(TMP, 'fand.tst'), '');
    expect(MyFExpand('Fand.Tst', 'FANDTESTX')).toBe(FromUnicode(join(TMP, 'fand.tst')));
    expect(MyFExpand('Other.Tst', 'FANDTESTX')).toBe(FromUnicode(join(TMP, 'Other.Tst')));
    delete process.env.FANDTESTX;
  });
});

describe('MEMORY: disk cache', () => {
  it('RdWrCache through 4 kB cache pages, SaveCache, ClearCacheH, SubstHandle', () => {
    FormatCache();
    expect(CacheExist()).toBe(true);
    expect(BaseVars.NCachePages).toBe(64);
    BaseVars.CPath = FromUnicode(join(TMP, 'cache.dat'));
    const h = OpenH(_isoverwritefile, Exclusive);
    const data = new Uint8Array(10000).map((_, i) => (i * 7) & 0xff);
    WriteH(h, data.length, data);
    // cached write across a page boundary
    const w = StrToBytes('ABCDEFGH');
    RdWrCache(false, h, false, 4092, 8, w);
    expect(BaseVars.CacheRoot!.Upd).toBe(true);
    expect(BaseVars.CacheRoot!.Handle).toBe(h);
    expect(BaseVars.CacheRoot!.HPage).toBe(((h << 24) | 1) >>> 0);
    const r = new Uint8Array(12);
    RdWrCache(true, h, false, 4090, 12, r);
    expect(Array.from(r)).toEqual([data[4090], data[4091], ...Array.from(w), data[4100], data[4101]]);
    // not yet on disk
    const direct = new Uint8Array(8);
    RdWrCache(true, h, true, 4092, 8, direct);
    expect(Array.from(direct)).toEqual(Array.from(data.subarray(4092, 4100)));
    expect(SaveCache(0)).toBe(true);
    RdWrCache(true, h, true, 4092, 8, direct);
    expect(BytesToStr(direct)).toBe('ABCDEFGH');
    expect(BaseVars.CacheRoot!.Upd).toBe(false);
    SubstHandle(h, 77);
    expect(BaseVars.CacheRoot!.Handle).toBe(77);
    SubstHandle(77, h);
    ClearCacheH(h);
    let z = BaseVars.CacheRoot;
    while (z) {
      expect(z.Handle).toBe(0xff);
      z = z.Chain;
    }
    // MRU: the hit moves to the front
    const p0 = Cache(h, 0)!;
    const p2 = Cache(h, 2)!;
    expect(BaseVars.CacheRoot).toBe(p2);
    expect(Cache(h, 0)).toBe(p0);
    expect(BaseVars.CacheRoot).toBe(p0);
    FlushHandles();
    CloseH(h);
  });
  it('CachePage.Handle overlays the top byte of HPage', () => {
    const z = new CachePage();
    z.HPage = 0x12000345;
    expect(z.Handle).toBe(0x12);
    z.Handle = 0xff;
    expect(z.HPage).toBe(0xff000345);
  });
  it('OSshell with an empty command', () => {
    BaseVars.LastExitCode = 5;
    expect(OSshell('', '  ', false, false, false, false)).toBe(true);
    expect(BaseVars.LastExitCode).toBe(0);
  });
});

describe('DISK: FAT12 and LZSS', () => {
  it('FatPut / FatGet', () => {
    const fat = new Uint8Array(64);
    for (let i = 2; i < 40; i++) FatPut(fat, i, (i * 97) & 0xfef);
    for (let i = 2; i < 40; i++) expect(FatGet(fat, i)).toBe((i * 97) & 0xfef);
    FatPut(fat, 5, 0xff8);
    expect(FatGet(fat, 5)).toBe(0xfff8);
    expect(FatGet(fat, 4)).toBe((4 * 97) & 0xfef);
    expect(FatGet(fat, 6)).toBe((6 * 97) & 0xfef);
  });
  it('FillVolDirEntry', () => {
    const e = new Uint8Array(32).fill(0x55);
    FillVolDirEntry(e, 'UCTO');
    expect(BytesToStr(e, 0, 11)).toBe('UCTO       ');
    expect(e[11]).toBe(0x08);
    expect(e[26]).toBe(0);
  });

  // TcFile with WriteBuf2/ReadBuf2 over memory (EXPIMP's ThFile does this with files)
  class MemCFile extends TcFile {
    Out: number[] = [];
    In: Uint8Array = new Uint8Array(0);
    InPos = 0;
    ChunkIn = 1000;
    WriteBuf2(): void {
      this.Out.push(...this.Buf2.subarray(0, this.lBuf2));
      this.lBuf2 = 0;
    }
    ReadBuf2(): void {
      const n = Math.min(this.ChunkIn, this.In.length - this.InPos);
      if (n <= 0) {
        this.EOF2 = true;
        return;
      }
      this.Buf2.set(this.In.subarray(this.InPos, this.InPos + n));
      this.InPos += n;
      this.lBuf2 = n;
      this.iBuf2 = 0;
    }
  }
  function compress(data: Uint8Array, chunk: number): Uint8Array {
    const f = new MemCFile().Init(1);
    f.InitBufOutp();
    for (let i = 0; i < data.length; i += chunk) {
      const n = Math.min(chunk, data.length - i);
      f.Buf.set(data.subarray(i, i + n));
      f.lBuf = n;
      f.WriteBuf(i + n >= data.length);
    }
    if (data.length === 0) f.WriteBuf(true);
    return Uint8Array.from(f.Out);
  }
  function decompress(packed: Uint8Array): Uint8Array {
    const f = new MemCFile().Init(1);
    f.In = packed;
    const out: number[] = [];
    f.InitBufInp();
    while (!f.EOF) {
      out.push(...f.Buf.subarray(0, f.lBuf));
      f.ReadBuf();
    }
    return Uint8Array.from(out);
  }
  it('TcFile compresses and restores (literals, matches, bytes >= $80)', () => {
    const text = StrToBytes(FromUnicode('Účetnictví – příjmy a výdaje; '.repeat(200)));
    let seed = 1;
    const rnd = new Uint8Array(5000).map(() => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 24));
    const mixed = new Uint8Array(text.length + rnd.length + 3000);
    mixed.set(text);
    mixed.set(rnd, text.length);
    for (const [data, chunk] of [[text, RingBufSz], [rnd, 1000], [mixed, 777]] as [Uint8Array, number][]) {
      const packed = compress(data, chunk);
      if (data === text) expect(packed.length).toBeLessThan(data.length / 5);
      expect(Array.from(decompress(packed))).toEqual(Array.from(data));
    }
  });
  it('TcFile without compression passes the buffer through', () => {
    const f = new MemCFile().Init(0);
    expect(f.Buf).toBe(f.Buf2);
    f.InitBufOutp();
    f.Buf.set(StrToBytes('plain'));
    f.lBuf = 5;
    f.WriteBuf(true);
    expect(BytesToStr(Uint8Array.from(f.Out))).toBe('plain');
    // TS: the host free space is environment-dependent (0 on a full disk); only the shape is fixed
    // here, test/pas-audit-src/engine/pas/disk.test.ts covers DiskFree with a mocked statfs.
    const free = new TcFile().Init(1).MyDiskFree(false, 0);
    expect(Number.isInteger(free) && free >= -1 && free <= 0x7fffffff).toBe(true);
    const wdf = BaseVars.Spec.WithDiskFree;
    BaseVars.Spec.WithDiskFree = false;
    expect(new TcFile().Init(1).MyDiskFree(false, 0)).toBe(0x7fffffff);
    BaseVars.Spec.WithDiskFree = wdf;
  });
});

describe('COMMON: output through the CRT', () => {
  it('WrStyleStr toggles t* attributes, WriteMsg writes MsgLine, ClearLL clears the last line', () => {
    const crt = new Crt(new KeyQueue(), null, 80, 25);
    SetDriversCrt(crt);
    AssignCrt(Output);
    TxtRewrite(Output);
    try {
      DriversVars.Crs.X = 0;
      DriversVars.Crs.Y = 2;
      BaseVars.Colors.tUnderline = 0x1e;
      BaseVars.Colors.tItalic = 0x2f;
      WrStyleStr('a\x13b\x17c\x17d\x13e', 0x07);
      const cells = [0, 1, 2, 3, 4].map((x) => crt.screen.getCell(x, 2));
      expect(cells.map((c) => c.ch).join('')).toBe('abcde');
      expect(cells.map((c) => c.attr)).toEqual([0x07, 0x1e, 0x2f, 0x1e, 0x07]);
      expect(DriversVars.TextAttr).toBe(0x07);
      DriversVars.Crs.X = 0;
      DriversVars.Crs.Y = 3;
      WriteMsg(3);
      expect([...Array(29).keys()].map((x) => crt.screen.getCell(x, 3).ch).join('')).toBe('Návrat do FANDu příkazem EXIT');
      crt.screen.setCell(5, 24, 'X', 0x70);
      ClearLL(0);
      expect(crt.screen.getCell(5, 24).ch).toBe(' ');
      expect(crt.screen.getCell(5, 24).attr).toBe(BaseVars.Colors.uNorm);
    } finally {
      TxtClose(Output);
      SetDriversCrt(null);
    }
  });
});
