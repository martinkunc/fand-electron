// PAS: PRINTTXT.PAS – printing a text (file, memory block, or the FAND work file) with the
// WordStar-like dot commands, or handing it to a print-manager program.
//
// Porting notes:
// * No interface variables, no unit initialization.
// * Private state (implementation section): pBlk (CharArrPtr → Uint8Array), iBlk, nBlk, Po, charrd,
//   printBlk, outpsw, prFileNr (OpenMgrOutput counter, mod 100). Private routines: Ovr (no-op),
//   replaceNo ('#' in a template → value), PdfNameOf (FPC), ExecMgrPgm, OpenMgrOutput, CopyToMgr,
//   PrintTxtFBlk (+ nested PrintChar/PrintStr/NewLine/PrintHeFo/GetNum/EofInp/RdLnInp/ResetInp).
// * asm/DOS: Ovr (overlay stack fix-up, no-op); ExecMgrPgm reads the cursor with int $10 AH=3 in BP7
//   (FPC: WhereX/WhereY + WindMin) – use CrsGet/the DRIVERS cursor. `word(WindMin) := ...` restores
//   the Crt window after PushW.
// * FPC-only addition in ExecMgrPgm: when the manager program fails (LastExitCode<>0) the spool file
//   is converted with FANDPDF FandTxtToPdf and delivered with FandDeliverPdf. Keep it (host has no
//   DOS print manager); it is not observable in BP7.
// * Key global state: RdRunVars.Rprt (TextFile; PrintTxtFBlk reads it with readln and, to decide
//   when output starts (BegPos), uses the handle position minus the unread buffer:
//   PosH(Handle)-(BufEnd-BufPos); pasrt.TextFile keeps BufPos/BufEnd like TextRec, so it works as is),
//   AccessVars.RprtLine/RprtPage, BaseVars.WorkHandle/FandWorkName, BaseVars.spec (CpLines,
//   AutoRprtLimit, ChoosePrMsg), BaseVars.printer[prCurr] (ToMgr), BASE PrTab(prMgrProg/prMgrParam/
//   prMgrFileNm/prClose).
// * Tricky parts:
//   - Leading dot commands (case-insensitive, first 3 chars): .cp n (conditional page, AutoFF), .pl n
//     (page length), .po n (left margin), .ti n (copies), .he/.fo text (header/footer, AutoFF),
//     .ff (no final form feed / no adjust), .nm (no adjust). GetNum parses copy(Ln,4,255) trimmed;
//     a bad number leaves the value unchanged.
//   - The first non-dot line is printed after ResetPrinter; the whole text is re-read Times times.
//   - PrintHeFo: runs of '_' '.' ':' – with a '.'/':' they are date/time masks ('__.__.__',
//     '__.__.____', '__:__', else printed literally), without it the page number right-aligned in the
//     run's width (Str(RprtPage:len)).
//   - AutoFF: new page at RprtLine>MaxLine (MaxLine = Pl-Cp, Cp+2 with a footer) or a ^L line;
//     a leading ^L is stripped. Final ^L unless .ff or prTab(prClose)='ff' ({Mark***}).
//   - printBlk mode counts consumed bytes in charrd (CR LF = 2) to switch outpsw at BegPos.
//   - NewExit/RestoreExit around the whole print (label 3); RunMsgOn('P',0)/RunMsgOff.
//   - PrintFandWork reuses WorkHandle as the text file handle (TextRec.OpenFunc := OpenTxt), then
//     reopens the work file if printing closed it.

import {
  ref, StrI, ValI, ShortStr, GoExitSignal, TxtAssign, TxtReset, TxtReadln, TxtEof, TxtClose, type Ref,
} from './pasrt.ts';
import {
  BaseVars, ExitRecord, NewExit, RestoreExit, PrTab, OpenH, CloseH, SeekH, ReadH, WriteH, FileSizeH, PosH, GetStore,
  ReleaseStore, SetMsgPar, OSshell, OpenWorkH, UnixPath, StrDate, Today, CurrTime, _isoverwritefile, Exclusive,
  prMgrProg, prMgrParam, prMgrFileNm, prClose,
} from './base.ts';
import { DriversVars, CrsGet, CrsSet, WhereX, WhereY, GotoXY } from './drivers.ts';
import { PrintChar as ObPrintChar, ResetPrinter, ClosePrinter, OpenTxt, Seek0Txt, ResetTxt } from './obase.ts';
import { PushW, PopW, WrLLF10Msg, RunMsgOn, RunMsgOff } from './obaseww.ts';
import { AccessVars } from './access.ts';
import { TestMountVol } from './oaccess.ts';
import { PrinterMenu } from './wwmenu.ts';
import { LeadChar, TrailChar } from './runfrml.ts';
import { RdRunVars } from './rdrun.ts';
import { FandTxtToPdf, FandDeliverPdf } from './fandpdf.ts';

// PAS: PRINTTXT.PAS Ovr (overlay stack fix-up: no-op)
function Ovr(): void {}

let pBlk: Uint8Array | null = null;
let iBlk = 0;
let nBlk = 0;
let Po = 0;
let charrd = 0;
let printBlk = false;
let outpsw = false;

// PAS: PRINTTXT.PAS replaceNo (private) – the first '#' of s replaced by sNew
function replaceNo(s: string, sNew: string): string {
  const i = s.indexOf('#');
  if (i >= 0) s = ShortStr(s.slice(0, i) + sNew + s.slice(i + 1));
  return s;
}
// PAS: PRINTTXT.PAS PdfNameOf (private, FPC)
function PdfNameOf(s: string): string {
  for (let i = s.length; i >= 1; i--) {
    if (s[i - 1] === '/' || s[i - 1] === '\\') break;
    if (s[i - 1] === '.') return s.slice(0, i - 1) + '.pdf';
  }
  return s + '.pdf';
}
// PAS: PRINTTXT.PAS ExecMgrPgm (private) – run the print manager on the spool file CPath
function ExecMgrPgm(): void {
  const bv = BaseVars;
  const dv = DriversVars;
  const pgmNm = PrTab(prMgrProg);
  if (pgmNm === '') return;
  const param = replaceNo(PrTab(prMgrParam), bv.CPath);
  const spool = UnixPath(bv.CPath); // FPC
  const wmin = { X: dv.WindMin.X, Y: dv.WindMin.Y };
  const wmax = { X: dv.WindMax.X, Y: dv.WindMax.Y };
  const crs = CrsGet();
  const w = PushW(1, 1, bv.TxtCols, 1);
  dv.WindMin.X = wmin.X; // word(WindMin):=wmin
  dv.WindMin.Y = wmin.Y;
  dv.WindMax.X = wmax.X;
  dv.WindMax.Y = wmax.Y;
  CrsSet(crs);
  OSshell(pgmNm, param, true, true, false, false);
  // FPC: without a DOS print manager the spool file becomes a PDF
  if (bv.LastExitCode !== 0 && spool !== '') {
    if (FandTxtToPdf(spool, PdfNameOf(spool))) FandDeliverPdf(PdfNameOf(spool), true);
  }
  const x = WhereX() + dv.WindMin.X - 1; // BP7: int $10 AH=3
  const y = WhereY() + dv.WindMin.Y - 1;
  PopW(w);
  GotoXY(x - dv.WindMin.X + 1, y - dv.WindMin.Y + 1);
}
let prFileNr = 0;
// PAS: PRINTTXT.PAS OpenMgrOutput (private) – the next spool file prMgrFileNm ('#' = 0..99)
function OpenMgrOutput(): number {
  const bv = BaseVars;
  prFileNr = (prFileNr + 1) % 100;
  const s = StrI(prFileNr);
  bv.CPath = replaceNo(PrTab(prMgrFileNm), s);
  bv.CVol = '';
  let h: number;
  if (bv.CPath.length === 0) h = 0xff;
  else {
    h = OpenH(_isoverwritefile, Exclusive);
    if (bv.HandleError !== 0) {
      SetMsgPar(bv.CPath);
      WrLLF10Msg(700 + bv.HandleError);
      h = 0xff;
    }
  }
  return h;
}
// PAS: PRINTTXT.PAS CopyToMgr (private) – copy the text to the spool file, run the manager
function CopyToMgr(): void {
  const bv = BaseVars;
  const av = AccessVars;
  const Rprt = RdRunVars.Rprt;
  const h2 = OpenMgrOutput();
  if (h2 === 0xff) return;
  const cf = av.CFile;
  const cr = av.CRecPtr;
  if (printBlk) WriteH(h2, nBlk, pBlk!);
  else {
    const h1 = Rprt.Handle;
    SeekH(h1, 0);
    const lbuf = 1000;
    const buf = GetStore(lbuf);
    let sz = FileSizeH(h1);
    while (sz > 0) {
      const n = sz > lbuf ? lbuf : sz;
      sz -= n;
      ReadH(h1, n, buf);
      WriteH(h2, n, buf);
    }
    ReleaseStore(buf);
    CloseH(h1);
    if (h1 === bv.WorkHandle) bv.WorkHandle = 0xff;
    Rprt.Handle = 0xff;
  }
  CloseH(h2);
  ExecMgrPgm();
  av.CFile = cf;
  av.CRecPtr = cr;
}

// PAS: PRINTTXT.PAS PrintTxtFBlk (private) – print the text (block or Rprt) with the dot commands
function PrintTxtFBlk(BegPos: number, CtrlL: boolean): void {
  const bv = BaseVars;
  const av = AccessVars;
  const Rprt = RdRunVars.Rprt;
  let Ln = '';
  // Pascal `Ln[1]` with Ln[1]:=' ' set before each read: ' ' for an empty line
  const Ln1 = (): string => (Ln.length > 0 ? Ln[0] : ' ');
  // PAS: PrintTxtFBlk.PrintChar
  const PrintChar = (c: string): void => {
    if (outpsw) ObPrintChar(c);
  };
  // PAS: PrintTxtFBlk.PrintStr
  const PrintStr = (s: string): void => {
    for (let i = 0; i < s.length; i++) PrintChar(s[i]);
  };
  // PAS: PrintTxtFBlk.NewLine
  const NewLine = (): void => {
    PrintStr('\r\n');
    av.RprtLine = (av.RprtLine + 1) & 0xffff;
  };
  // PAS: PrintTxtFBlk.PrintHeFo – '__' runs: page number, '__.__.__' date, '__:__' time
  const PrintHeFo = (T: string): void => {
    let i = 1;
    while (i <= T.length) {
      if (T[i - 1] === '_') {
        let m = '';
        let point = false;
        while (i <= T.length && (T[i - 1] === '_' || T[i - 1] === '.' || T[i - 1] === ':')) {
          if (T[i - 1] !== '_') point = true;
          m += T[i - 1];
          i++;
        }
        if (point) {
          if (m === '__.__.__') PrintStr(StrDate(Today(), 'DD.MM.YY'));
          else if (m === '__.__.____') PrintStr(StrDate(Today(), 'DD.MM.YYYY'));
          else if (m === '__:__') PrintStr(StrDate(CurrTime(), 'hh:mm'));
          else PrintStr(m);
        } else {
          m = StrI(av.RprtPage, m.length);
          PrintStr(m);
        }
      } else {
        PrintChar(T[i - 1]);
        i++;
      }
    }
    NewLine();
  };
  // PAS: PrintTxtFBlk.GetNum – a bad number leaves NN unchanged
  const GetNum = (NN: Ref<number>): void => {
    const n = ref(0), i = ref(0);
    ValI(LeadChar(' ', TrailChar(' ', Ln.slice(3, 258))), n, i);
    if (i.v === 0) NN.v = n.v & 0xffff;
  };
  // PAS: PrintTxtFBlk.EofInp
  const EofInp = (): boolean => (printBlk ? iBlk > nBlk : TxtEof(Rprt));
  // PAS: PrintTxtFBlk.RdLnInp
  const RdLnInp = (): void => {
    if (printBlk) {
      const p = pBlk!;
      Ln = '';
      while (iBlk <= nBlk) {
        const c = p[iBlk - 1];
        iBlk++;
        if (c === 0x0d) {
          charrd++;
          if (p[iBlk - 1] === 0x0a) {
            iBlk++;
            charrd++;
          }
          break; // goto 1
        }
        if (Ln.length < 255) Ln = Ln + String.fromCharCode(c);
      }
      // 1:
      charrd += Ln.length;
      if (charrd > BegPos) outpsw = true;
    } else {
      Ln = TxtReadln(Rprt, 255);
      if (!outpsw) {
        if (PosH(Rprt.Handle) - (Rprt.BufEnd - Rprt.BufPos) >= BegPos) outpsw = true;
      }
    }
  };
  // PAS: PrintTxtFBlk.ResetInp
  const ResetInp = (): void => {
    if (printBlk) iBlk = 1;
    else Seek0Txt(Rprt);
  };

  let Times = 0;
  const Ti = ref(0), Cp = ref(0), Pl = ref(0), PoR = ref(0);
  let MaxLine = 0;
  let FrstRun: boolean, AutoFF: boolean, FFOpt: boolean, NMOpt: boolean, He: boolean, Fo: boolean, adj: boolean;
  let FoTxt = '';
  let HeTxt = '';
  const er = new ExitRecord();
  NewExit(Ovr, er);
  try {
    RunMsgOn('P', 0);
    FrstRun = true;
    outpsw = false;
    charrd = 0;
    do {
      AutoFF = false;
      FFOpt = false;
      NMOpt = false;
      He = false;
      Fo = false;
      Po = 0;
      Ti.v = 1;
      Cp.v = bv.Spec.CpLines;
      Pl.v = bv.Spec.AutoRprtLimit + Cp.v;
      ResetInp();
      let found = false;
      while (!EofInp()) {
        RdLnInp();
        const s = Ln.slice(0, 3);
        const is = (x: string): boolean => s.length === 3 && s.toLowerCase() === x;
        if (is('.cp')) {
          AutoFF = true;
          GetNum(Cp);
        } else if (is('.pl')) GetNum(Pl);
        else if (is('.po')) {
          PoR.v = Po;
          GetNum(PoR);
          Po = PoR.v;
        } else if (is('.ti')) GetNum(Ti);
        else if (is('.he')) {
          He = true;
          AutoFF = true;
          HeTxt = Ln.slice(3, 258);
        } else if (is('.fo')) {
          Fo = true;
          AutoFF = true;
          FoTxt = Ln.slice(3, 258);
        } else if (is('.ff')) FFOpt = true;
        else if (is('.nm')) NMOpt = true;
        else {
          found = true; // goto 1
          break;
        }
      }
      if (!found) return; // goto 3
      // 1:
      adj = FrstRun && !FFOpt && !NMOpt;
      if (adj && bv.Spec.ChoosePrMsg) if (!PrinterMenu(62)) return;
      if (bv.printer[bv.prCurr].ToMgr) {
        CopyToMgr();
        return;
      }
      if (!ResetPrinter(Pl.v, Po, adj, FrstRun)) return;
      av.RprtPage = 1;
      av.RprtLine = 1;
      if (FrstRun) {
        FrstRun = false;
        Times = Ti.v;
      }
      if (Fo) Cp.v = (Cp.v + 2) & 0xffff;
      MaxLine = (Pl.v - Cp.v) & 0xffff;
      if (He) {
        PrintHeFo(HeTxt);
        NewLine();
      }
      PrintStr(Ln);
      NewLine();
      while (!EofInp()) {
        RdLnInp();
        if (AutoFF && (av.RprtLine > MaxLine || Ln1() === '\x0c')) {
          if (Fo) {
            while (av.RprtLine <= MaxLine) NewLine();
            NewLine();
            PrintHeFo(FoTxt);
          }
          PrintChar('\x0c');
          av.RprtPage = (av.RprtPage + 1) & 0xffff;
          av.RprtLine = 1;
          if (He) {
            PrintHeFo(HeTxt);
            NewLine();
          }
        } else if (Ln1() === '\x0c') PrintChar('\x0c');
        if (Ln1() === '\x0c') Ln = Ln.slice(1, 256);
        PrintStr(Ln);
        NewLine();
      }
      if (Fo) {
        while (av.RprtLine <= MaxLine) NewLine();
        NewLine();
        PrintHeFo(FoTxt);
      }
      if (!FFOpt && CtrlL) {
        if (PrTab(prClose) !== 'ff') PrintChar('\x0c'); // Mark***
      }
      Times = (Times - 1) & 0xffff;
    } while (Times !== 0);
    ClosePrinter(Po);
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
  } finally {
    // 3:
    RestoreExit(er);
    RunMsgOff();
  }
}
// PAS: PRINTTXT.PAS PrintArray – print N bytes of P (untyped pointer → Uint8Array)
export function PrintArray(P: Uint8Array, N: number, CtrlL: boolean): void {
  printBlk = true;
  pBlk = P;
  nBlk = N;
  PrintTxtFBlk(0, CtrlL);
}
// PAS: PRINTTXT.PAS PrintTxtFile – print the text file BaseVars.CPath, output starting at byte BegPos
export function PrintTxtFile(BegPos: number): void {
  const bv = BaseVars;
  const Rprt = RdRunVars.Rprt;
  TestMountVol(bv.CPath[0] ?? '\0');
  if (!ResetTxt(Rprt)) {
    SetMsgPar(bv.CPath);
    WrLLF10Msg(700 + bv.HandleError);
    return;
  }
  printBlk = false;
  PrintTxtFBlk(BegPos, true);
  if (Rprt.Handle === 0xff) return;
  TxtClose(Rprt);
}
// PAS: PRINTTXT.PAS PrintFandWork – print the FAND work file (FandWorkName)
export function PrintFandWork(): void {
  const bv = BaseVars;
  const Rprt = RdRunVars.Rprt;
  CloseH(bv.WorkHandle);
  TxtAssign(Rprt, bv.FandWorkName);
  Rprt.OpenFunc = OpenTxt;
  OpenWorkH();
  Rprt.Handle = bv.WorkHandle;
  TxtReset(Rprt);
  printBlk = false;
  PrintTxtFBlk(0, true);
  if (bv.WorkHandle === 0xff) OpenWorkH();
}
