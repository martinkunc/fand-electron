// PAS: OBASE.PAS – printer output and text files over the HANDLE layer.
//
// Porting notes:
// * asm/DOS: BP7 PrintByte drives the printer through BIOS int $17 (status bits, out of paper,
//   offline, ESC cancels with PromptYN(22) + GoExit). The FPC port only writes one byte to
//   printer[prCurr].Handle, which OpenLPTHandle opens as the file 'LPT<n>.PRN' (BP7: device 'LPT<n>').
//   ClosePrinter: FPC always closes Handle; BP7 closes only ToHandle / reopens for OpCls. Follow FPC.
//   The Ovr far procedure (overlay stack fix-up for NewExit) is a no-op.
// * Text files: BP7 installs custom TextRec drivers (OpenFunc/InOutFunc/FlushFunc/CloseFunc) that
//   read/write through ReadH/WriteH. Here `text` is pasrt.TextFile; this module owns its I/O for
//   files opened by ResetTxt/RewriteTxt (reports, PRINTER.TXT). RewriteTxt('LPT1') routes output
//   through PrintChar (OutputLPT1/CloseLPT1 append ^L). FPC forces LineEnd = CR LF.
// * PrintCtrl translation: CPTest is a state machine for ^P <lo><hi> binary blocks (the count
//   bytes are bypassed, then N bytes pass untranslated); CtrlToESC toggles the ^S ^Q ^W ^B ^D ^E
//   ^A ^X ^V ^T style flags into PrTab(prXx1/prXx2) sequences; TranslateCodePage converts chars
//   >= $80 by printer[prCurr].Kod ('K','k','L','l') with DRIVERS ConvKamenLatin/ConvToNoDiakr.
// * Private state (implementation section): SFlag..TFlag, CPState, CPCount, PrintCtrlFlag.
// * No interface variables, no unit initialization.

import {
  StrI, StrToBytes, BytesToStr, GoExitSignal, fmInput, fmInOut, TxtAssign, TxtReset, TxtRewrite, type TextFile,
} from './pasrt.ts';
import {
  BaseVars, ExitRecord, NewExit, RestoreExit, GoExit, PrTab, SetMsgPar, OpenH, ReadH, WriteH, CloseH, SeekH,
  FileSizeH, MaxW, MinW, _isoldfile, _isoverwritefile, RdOnly, Exclusive, prUl1, prUl2, prKv1, prKv2, prBr1, prBr2,
  prDb1, prDb2, prBd1, prBd2, prKp1, prKp2, prEl1, prEl2, prUs11, prUs12, prUs21, prUs22, prUs31, prUs32, prReset,
  prPageSizeNN, prPageSizeTrail, prLMarg, prLMargTrail, prClose,
} from './base.ts';
import { WrLLF10Msg } from './obaseww.ts';
import { DriversVars, ConvKamenLatin, ConvToNoDiakr, foKamen, foLatin2, _ESC_ } from './drivers.ts';

// PAS: OBASE.PAS Ovr (overlay stack fix-up for NewExit: no-op)
function Ovr(): void {}

let SFlag = false;
let QFlag = false;
let WFlag = false;
let BFlag = false;
let DFlag = false;
let EFlag = false;
let AFlag = false;
let XFlag = false;
let VFlag = false;
let TFlag = false;
let CPState = 0;
let CPCount = 0;

// PAS: OBASE.PAS ResetCtrlFlags (private)
function ResetCtrlFlags(): void {
  SFlag = false;
  BFlag = false;
  QFlag = false;
  WFlag = false;
  DFlag = false;
  EFlag = false;
  AFlag = false;
  XFlag = false;
  VFlag = false;
  TFlag = false;
  CPState = 0;
}

// PAS: OBASE.PAS IsPrintCtrl – C in [^S,^Q,^W,^B,^D,^E,^A,^X,^V,^T]
export function IsPrintCtrl(c: string): boolean {
  return '\x13\x11\x17\x02\x04\x05\x01\x18\x16\x14'.includes(c[0] ?? '\x00');
}

// PAS: OBASE.PAS PrintByte (private) – FPC: one byte to printer[prCurr].Handle (BP7: BIOS int $17)
function PrintByte(B: number): void {
  const pr = BaseVars.printer[BaseVars.prCurr];
  if (pr.Handle !== 0xff) WriteH(pr.Handle, 1, Uint8Array.of(B & 0xff));
}
// PAS: OBASE.PAS PrintByteStr (private)
function PrintByteStr(S: string): void {
  for (let i = 0; i < S.length; i++) PrintByte(S.charCodeAt(i));
}

// PAS: OBASE.PAS CtrlToESC (private) – the printer sequence of a text control char (style toggles)
function CtrlToESC(C: string): string {
  switch (C) {
    case '\x08':
    case '\x0c':
      return C;
    case '\x0d':
      return '\x0d\x0a'; // weak new-line, ^j of hard new-line ignored
    case '\x13':
      SFlag = !SFlag;
      return PrTab(SFlag ? prUl1 : prUl2);
    case '\x11':
      QFlag = !QFlag;
      return PrTab(QFlag ? prBr1 : prBr2);
    case '\x17':
      WFlag = !WFlag;
      return PrTab(WFlag ? prKv1 : prKv2);
    case '\x02':
      BFlag = !BFlag;
      return PrTab(BFlag ? prBd1 : prBd2);
    case '\x04':
      DFlag = !DFlag;
      return PrTab(DFlag ? prDb1 : prDb2);
    case '\x05':
      EFlag = !EFlag;
      return PrTab(EFlag ? prKp1 : prKp2);
    case '\x01':
      AFlag = !AFlag;
      return PrTab(AFlag ? prEl1 : prEl2);
    case '\x18':
      XFlag = !XFlag;
      return PrTab(XFlag ? prUs11 : prUs12);
    case '\x16':
      VFlag = !VFlag;
      return PrTab(VFlag ? prUs21 : prUs22);
    case '\x14':
      TFlag = !TFlag;
      return PrTab(TFlag ? prUs31 : prUs32);
    default:
      return '';
  }
}
// PAS: OBASE.PAS CPTest (private) – 0 = binary, 1 = normal, 2 = control, 3 = bypass;
// CPState 0 = normal, 1 = lo count, 2 = hi count, 3 = binary (^P <lo> <hi> then count bytes)
function CPTest(c: string): number {
  const b = c.charCodeAt(0);
  switch (CPState) {
    case 0:
      if (b < 0x20) {
        if (b === 0x10) {
          CPState = 1;
          return 3;
        }
        return 2;
      }
      return 1;
    case 1:
      CPState = 2;
      CPCount = b;
      return 3;
    case 2:
      CPCount = (CPCount + (b << 8)) & 0xffff;
      CPState = CPCount === 0 ? 0 : 3;
      return 3;
    default:
      CPCount = (CPCount - 1) & 0xffff;
      if (CPCount === 0) CPState = 0;
      return 0;
  }
}
// PAS: OBASE.PAS TranslateCodePage (private) – by printer[prCurr].Kod
function TranslateCodePage(c: string): string {
  if (c.charCodeAt(0) < 0x80) return c;
  const a = Uint8Array.of(c.charCodeAt(0));
  switch (BaseVars.printer[BaseVars.prCurr].Kod) {
    case 'K':
      ConvKamenLatin(a, 1, true);
      break;
    case 'k':
      ConvToNoDiakr(a, 1, foKamen);
      break;
    case 'L':
      ConvKamenLatin(a, 1, false);
      break;
    case 'l':
      ConvToNoDiakr(a, 1, foLatin2);
      break;
  }
  return String.fromCharCode(a[0]);
}
// PAS: OBASE.PAS PrintChar
export function PrintChar(c: string): void {
  switch (CPTest(c)) {
    case 0:
      PrintByte(c.charCodeAt(0));
      break;
    case 1:
      PrintByte(TranslateCodePage(c).charCodeAt(0));
      break;
    case 2:
      PrintByteStr(CtrlToESC(c));
      break;
  }
}
// PAS: OBASE.PAS PrintStr
export function PrintStr(s: string): void {
  for (let i = 0; i < s.length; i++) PrintChar(s[i]);
}
// PAS: OBASE.PAS OpenLPTHandle – FPC: file 'LPT<n>.PRN'
export function OpenLPTHandle(): number {
  const nr = StrI(BaseVars.printer[BaseVars.prCurr].Lpti);
  BaseVars.CPath = 'LPT' + nr + '.PRN';
  BaseVars.CVol = '';
  return OpenH(_isoverwritefile, Exclusive);
}
// PAS: OBASE.PAS ResetPrinter – NewExit-protected; false when cancelled
export function ResetPrinter(PgeLength: number, LeftMargin: number, Adj: boolean, Frst: boolean): boolean {
  let result = false;
  const er = new ExitRecord();
  NewExit(Ovr, er);
  try {
    const pr = BaseVars.printer[BaseVars.prCurr];
    if (Adj) {
      if (BaseVars.Spec.ChoosePrMsg) {
        if (!pr.ToHandle) PrintStr('\x08\x08');
      } else if (!pr.ToHandle) {
        PrintStr('\x08\x08');
        BaseVars.F10SpecKey = _ESC_;
        WrLLF10Msg(10); // adjust printer
        if (DriversVars.KbdChar === _ESC_) return false;
      }
    }
    pr.Handle = OpenLPTHandle(); // FPC (BP7: only when ToHandle)
    if (Frst) {
      PrintByteStr(PrTab(prReset));
      if (PrTab(prPageSizeNN).length > 0) {
        PrintByteStr(PrTab(prPageSizeNN));
        if (pr.Typ === 'L') PrintByteStr(StrI(MaxW(8, MinW(PgeLength, 128))));
        else PrintByte(PgeLength);
        PrintByteStr(PrTab(prPageSizeTrail));
      }
      if (LeftMargin > 0 && PrTab(prLMarg).length > 0) {
        PrintByteStr(PrTab(prLMarg));
        if (pr.Typ === 'L') PrintByteStr(StrI(LeftMargin));
        else PrintByte(LeftMargin);
        PrintByteStr(PrTab(prLMargTrail));
      }
    }
    ResetCtrlFlags();
    BaseVars.WasLPTCancel = false;
    result = true;
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
  } finally {
    RestoreExit(er);
  }
  return result;
}
// PAS: OBASE.PAS ClosePrinter
export function ClosePrinter(LeftMargin: number): void {
  const pr = BaseVars.printer[BaseVars.prCurr];
  if (LeftMargin > 0) {
    PrintByteStr(PrTab(prLMarg));
    if (pr.Typ === 'L') PrintByteStr('0');
    else PrintByte(0);
    PrintByteStr(PrTab(prLMargTrail));
  }
  if (PrTab(prClose) !== 'ff') PrintByteStr(PrTab(prClose)); // Mark***
  if (pr.Handle !== 0xff) {
    CloseH(pr.Handle); // FPC (BP7: CloseH when ToHandle, reopen/close for OpCls)
    pr.Handle = 0xff;
  }
}

// ---------------------------------------------------------------- text files (TextRec drivers)

let PrintCtrlFlag = false;

// PAS: OBASE.PAS TestTxtHError (private)
function TestTxtHError(F: TextFile): void {
  if (BaseVars.HandleError !== 0) {
    SetMsgPar(F.Name);
    WrLLF10Msg(700 + BaseVars.HandleError);
    GoExit();
  }
}
// PAS: OBASE.PAS InputTxt (private)
function InputTxt(F: TextFile): number {
  const buf = new Uint8Array(F.BufSize);
  F.BufEnd = ReadH(F.Handle, F.BufSize, buf);
  F.Buf = BytesToStr(buf, 0, F.BufEnd);
  F.BufPos = 0;
  TestTxtHError(F);
  return 0;
}
// PAS: OBASE.PAS OutputTxt (private) – with PrintCtrl: ^P binary blocks, style controls -> printer codes
function OutputTxt(F: TextFile): number {
  let out: string;
  if (PrintCtrlFlag) {
    out = '';
    for (let i = 0; i < F.Buf.length; i++) {
      const c = F.Buf[i];
      switch (CPTest(c)) {
        case 0:
          out += c;
          break;
        case 1:
          out += TranslateCodePage(c);
          break;
        case 2:
          out += CtrlToESC(c);
          break;
      }
    }
  } else out = F.Buf;
  F.Buf = '';
  F.BufPos = 0;
  WriteH(F.Handle, out.length, StrToBytes(out));
  TestTxtHError(F);
  return 0;
}
// PAS: OBASE.PAS OutputLPT1 (private)
function OutputLPT1(F: TextFile): number {
  const s = F.Buf;
  F.Buf = '';
  F.BufPos = 0;
  for (let i = 0; i < s.length; i++) if (!BaseVars.WasLPTCancel) PrintChar(s[i]);
  return 0;
}
// PAS: OBASE.PAS FlushTxt (private)
function FlushTxt(F: TextFile): number {
  return 0;
}
// PAS: OBASE.PAS CloseTxt (private)
function CloseTxt(F: TextFile): number {
  CloseH(F.Handle);
  TestTxtHError(F);
  return 0;
}
// PAS: OBASE.PAS CloseLPT1 (private)
function CloseLPT1(F: TextFile): number {
  if (!BaseVars.WasLPTCancel) PrintChar('\x0c');
  return 0;
}
// PAS: OBASE.PAS OpenTxt – TextRec open driver (append seeks to the end); returns the IO result
export function OpenTxt(F: TextFile): number {
  if (F.Mode === fmInOut) SeekH(F.Handle, FileSizeH(F.Handle)); // append
  F.InOutFunc = F.Mode === fmInput ? InputTxt : OutputTxt;
  F.FlushFunc = FlushTxt;
  F.CloseFunc = CloseTxt;
  if (PrintCtrlFlag) ResetCtrlFlags();
  return 0;
}
// PAS: OBASE.PAS OpenLPT1 (private)
function OpenLPT1(F: TextFile): number {
  F.InOutFunc = OutputLPT1;
  F.CloseFunc = CloseLPT1;
  return 0;
}
// PAS: OBASE.PAS Seek0Txt – rewind a text file opened by ResetTxt
export function Seek0Txt(F: TextFile): void {
  SeekH(F.Handle, 0);
  F.BufEnd = F.BufSize;
  F.BufPos = F.BufEnd;
}
// PAS: OBASE.PAS ResetTxt – opens BaseVars.CPath read-only; false + HandleError on failure
export function ResetTxt(F: TextFile): boolean {
  TxtAssign(F, BaseVars.CPath);
  F.OpenFunc = OpenTxt;
  F.Handle = 0; // for error detection in OpenH
  F.Handle = OpenH(_isoldfile, RdOnly);
  if (BaseVars.HandleError !== 0) return false;
  TxtReset(F);
  return true;
}
// PAS: OBASE.PAS RewriteTxt – creates BaseVars.CPath ('LPT1' = the printer)
export function RewriteTxt(F: TextFile, PrintCtrl: boolean): boolean {
  TxtAssign(F, BaseVars.CPath);
  if (BaseVars.CPath === 'LPT1') F.OpenFunc = OpenLPT1;
  else {
    PrintCtrlFlag = PrintCtrl;
    F.OpenFunc = OpenTxt;
    F.Handle = OpenH(_isoverwritefile, Exclusive);
    if (BaseVars.HandleError !== 0) return false;
  }
  TxtRewrite(F);
  F.LineEnd = '\r\n'; // FPC
  return true;
}
// PAS: OBASE.PAS SetPrintTxtPath – CPath := WrkDir + 'PRINTER.TXT'
export function SetPrintTxtPath(): void {
  BaseVars.CPath = BaseVars.WrkDir + 'PRINTER.TXT';
  BaseVars.CVol = '';
}
