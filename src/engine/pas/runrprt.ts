// PAS: RUNRPRT.PAS – the report interpreter: merges the input files (IDA[1..MaxIi]) by their match
// fields, prints group headings/footings, page heads/foots and details to the report text (Rprt).
//
// Porting notes:
// * asm/DOS: Ovr (no-op). No other asm; GetLine walks the text with pointer arithmetic
//   (TAOff absolute TA / FPC PtrUInt) - use an offset into the Uint8Array.
// * Output goes to RdRunVars.Rprt (pasrt.TextFile) opened by RewriteRprt: no path -> the print
//   view file (SetPrintTxtPath, PrintView := true, viewed afterwards by RUNPROC.ReportProc);
//   'LPT1' -> printer (ResetPrinter/ClosePrinter); otherwise a file (SetTxtPathVol). Header dot
//   commands '.ti n' (copies) and '.pl n' (page length <> 72) are written for PRINTTXT.
// * Key global state: RdRunVars (IDA, MaxIi, FrstLvM/LstLvM, RprtHd, PageHd/PageFt, PgeLimitZ/
//   PgeSizeZ, MergOpGroup.Group, OldMFlds/NewMFlds, SelQuest, PrintView), BaseVars.WasLPTCancel,
//   AccessVars.RprtLine/RprtPage (the `line`/`page` report variables). Private module state:
//   PrintDH, Y: YRec (pending text block/TT columns), FrstBlk, NoFF, WasFF2, SetPage, WasOutput,
//   LineLenLst, PageNo, PgeSize, Store2Ptr, NRecsAll, RecCount, NEof, MinID, FirstLines, WasDot,
//   NLinesOutp; private types TTD (text columns of T fields: Chain, SL, Col, Width, Ln) and YRec
//   (P, I, Ln, TLn, Sz, Blk, ChkPg, TD).
// * Tricky parts: all routines are nested in RunReport (share its locals); goto 0/1/2/3 loops:
//   0 = repeat for Times copies (LPT1 only), 1 = next group, 2 = end of data, 3 = NewExit target
//   (PORTING.md 11; on GoExit the file is closed, the frame popped, and GoExit re-raised unless the
//   printer was cancelled). Print1NTupel formats fields by the RFldD edit masks (REditD: Char, L, M);
//   NewTxtCol wraps T-field text into columns (GetLine with Absatz/Wrap). Page breaks: CheckPgeLimit,
//   PgeLimit/PgeSize defaults from spec.AutoRprtLimit/CpLines. PushProcStk/PopProcStk frame for the
//   report's local variables. RunMsgOn('R', NRecsAll) progress.

import {
  GoExitSignal, TxtWrite, TxtWriteln, TxtClose, Move, StrI, StrR, chr, fref, ref, getWord, type Ref, type Pointer,
} from './pasrt.ts';
import {
  BaseVars, ExitRecord, NewExit, RestoreExit, GoExit, RdMsg, SetMsgPar, ChainLast, LenStyleStr, StrDate, SEquUpcase,
  MaxI, type float, type LongStrPtr, type StringPtr,
} from './base.ts';
import { ESCPressed } from './drivers.ts';
import {
  AccessVars, XString, CompStr, ZeroAllFlds, NewLMode, OldLMode, ClearRecSpace, AsgnParFldFrml, _ShortS, _R, _B,
  S_, R_, B_, Power10, RdMode, StringListEl, _equ, _lt, _gt,
  type KeyFldDPtr, type SumElPtr, type FloatPtrList, type StringList, type FieldDPtr,
} from './access.ts';
import {
  RdRunVars, PushProcStk, PopProcStk, _locvar, _parfile, _ifthenelseM,
  type RprtOptPtr, type BlkDPtr, type RFldDPtr, type InpDPtr, type AssignDPtr, type LvDescrPtr, type ConstList,
} from './rdrun.ts';
import { IsPrintCtrl, SetPrintTxtPath, ResetPrinter, ClosePrinter, RewriteTxt } from './obase.ts';
import { WrLLF10Msg, PromptYN, RunError, RunMsgOn, RunMsgN, RunMsgOff } from './obaseww.ts';
import { SetTxtPathVol, TestMountVol } from './oaccess.ts';
import { RunBool, RunReal, RunInt, RunLongStr, RunShortStr, LVAssignFrml } from './runfrml.ts';
import { PromptFilter } from './wwmix.ts';

// PAS: RUNRPRT.PAS Ovr (overlay stack fix-up for NewExit: no-op)
function Ovr(): void {}

export type TTDPtr = TTD | null;
// PAS: RUNRPRT.PAS TTD – pending lines of a wrapped text column
export class TTD {
  Chain: TTDPtr = null;
  SL: StringList = null;
  Col = 0;
  Width = 0;
  Ln = 0;
}
// PAS: RUNRPRT.PAS YRec – the block text being printed. P is an offset into Blk^.Txt (Pchar).
export class YRec {
  P = 0;
  I = 0;
  Ln = 0;
  TLn = 0;
  Sz = 0;
  Blk: BlkDPtr = null;
  ChkPg = false;
  TD: TTDPtr = null;
}

let PrintDH = 0;
let Y = new YRec();
let FrstBlk = false;
let NoFF = false;
let WasFF2 = false;
let SetPage = false;
let WasOutput = false;
let LineLenLst = 0;
let PageNo = 0;
let PgeSize = 0;
let Store2Ptr: Pointer = null;

let NRecsAll = 0;
let RecCount = 0;
let NEof = 0;
let MinID: InpDPtr = null;
let FirstLines = false;
let WasDot = false;
let NLinesOutp = 0;

/** TS-only: write(x:N) – right-justify s in a field of N chars (Pascal never truncates). */
function Fw(s: string, N: number): string {
  return s.length >= N ? s : ' '.repeat(N - s.length) + s;
}

// PAS: RUNRPRT.PAS RunReport
export function RunReport(RO: RprtOptPtr): void {
  const av = AccessVars;
  const bv = BaseVars;
  const rv = RdRunVars;
  const Rprt = rv.Rprt;
  const write = (...S: string[]): void => TxtWrite(Rprt, ...S);
  const writeln = (...S: string[]): void => TxtWriteln(Rprt, ...S);
  const ord_equ = _equ.charCodeAt(0);
  const ord_lt = _lt.charCodeAt(0);
  const ord_gt = _gt.charCodeAt(0);

  // PAS: RUNRPRT.PAS ResetY (nested)
  function ResetY(): void {
    Y = new YRec();
  }
  // PAS: RUNRPRT.PAS IncPage (nested)
  function IncPage(): void {
    if (SetPage) {
      SetPage = false;
      av.RprtPage = PageNo & 0xffff;
    } else av.RprtPage = (av.RprtPage + 1) & 0xffff;
  }
  // PAS: RUNRPRT.PAS NewLine (nested)
  function NewLine(): void {
    writeln();
    if (WasDot) WasDot = false;
    else {
      av.RprtLine = (av.RprtLine + 1) & 0xffff;
      NLinesOutp++;
      FirstLines = false;
    }
    LineLenLst = 0;
    if (av.RprtLine > PgeSize) {
      av.RprtLine = (av.RprtLine - PgeSize) & 0xffff;
      IncPage();
    }
  }
  // PAS: RUNRPRT.PAS FormFeed (nested)
  function FormFeed(): void {
    if (NoFF) NoFF = false;
    else {
      write('\x0c');
      av.RprtLine = 1;
      IncPage();
    }
    LineLenLst = 0;
    WasFF2 = false;
  }
  // PAS: RUNRPRT.PAS NewPage (nested)
  function NewPage(): void {
    PrintPageFt();
    PrintPageHd();
    TruncLine();
    FrstBlk = false;
  }
  // PAS: RUNRPRT.PAS OutOfLineBound (nested)
  function OutOfLineBound(B: BlkDPtr): boolean {
    const b = B!;
    return (b.LineBound !== null && av.RprtLine > RunReal(b.LineBound)) || (b.AbsLine && RunInt(b.LineNo) < av.RprtLine);
  }
  // PAS: RUNRPRT.PAS Zero (nested)
  function Zero(Z: FloatPtrList): void {
    while (Z !== null) {
      Z.RPtr!.v = 0;
      Z = Z.Chain;
    }
  }
  // PAS: RUNRPRT.PAS WriteNBlks (nested)
  function WriteNBlks(N: number): void {
    if (N > 0) write(' '.repeat(N));
  }
  // PAS: RUNRPRT.PAS NewTxtCol (nested) – write the first line of a text field, queue the rest in Y.TD
  function NewTxtCol(S: LongStrPtr, Col: number, Width: number, Wrap: boolean): void {
    let Absatz = false;
    const TA = S; // CharArrPtr(@S^.A): TAOff below is the offset of TA^[1]
    const TAOff = ref(0);
    // PAS: RUNRPRT.PAS GetLine (nested in NewTxtCol)
    function GetLine(TAO: Ref<number>, TLen: Ref<number>, Width: number, Wrap: boolean): string {
      const T = (k: number): number => TA[TAO.v + k]; // T^[k]
      let i = 0;
      let i2 = 0;
      let w = 0;
      let WasWrd = false;
      let nWords = 0;
      let Fill = false;
      let iWrdEnd = 0;
      let i2WrdEnd = 0;
      let wWrdEnd = 0;
      let nWrdEnd = 0;
      const s: number[] = new Array(256).fill(0x20); // s[1..255] (s[0] = length)
      while (i < TLen.v && i2 < 255) {
        const c = T(i);
        if (c === 13) {
          Absatz = true;
          break; // goto 1
        }
        if (w >= Width && c === 0x20 && Wrap) break; // goto 1
        if (c !== 0x20 || WasWrd || !Wrap || Absatz) {
          i2++;
          s[i2] = c;
          if (!IsPrintCtrl(chr(c))) w++;
        }
        if (c === 0x20) {
          if (WasWrd) {
            WasWrd = false;
            i2WrdEnd = i2 - 1;
            iWrdEnd = i;
            wWrdEnd = w - 1;
            nWrdEnd = nWords;
          }
        } else if (!WasWrd) {
          WasWrd = true;
          Absatz = false;
          nWords++;
        }
        i++;
      }
      // label 1
      if (Wrap && nWords >= 2 && w > Width) {
        i2 = i2WrdEnd;
        i = iWrdEnd;
        w = wWrdEnd;
        nWords = nWrdEnd;
        Fill = true;
        Absatz = false;
      }
      if (i < TLen.v && T(i) === 13) {
        i++;
        if (i < TLen.v && T(i) === 10) i++;
      }
      TAO.v += i;
      TLen.v -= i;
      let l2 = i2;
      if (w < Width) l2 += Width - w;
      const n = l2 - i2;
      l2 &= 0xff; // s[0] := char(l2)
      if (nWords <= 1 || n === 0 || !Fill) {
        for (let k = 1; k <= n && i2 + k <= 255; k++) s[i2 + k] = 0x20; // FillChar(s[i2+1], n, ' ')
        return String.fromCharCode(...s.slice(1, 1 + l2));
      }
      const n1 = Math.trunc(n / (nWords - 1));
      let n2 = n % (nWords - 1);
      const s1 = s.slice(1, 1 + i2); // s[0] := char(i2); s1 := s
      i2 = 1;
      WasWrd = false;
      for (let k = 1; k <= s1.length; k++) {
        s[i2] = s1[k - 1];
        if (s[i2] !== 0x20) WasWrd = true;
        else if (WasWrd) {
          WasWrd = false;
          for (let j = 1; j <= n1; j++) {
            i2++;
            s[i2] = 0x20;
          }
          if (n2 > 0) {
            n2--;
            i2++;
            s[i2] = 0x20;
          }
        }
        i2++;
      }
      return String.fromCharCode(...s.slice(1, 1 + l2));
    }

    const LL = ref(S.length);
    let Ln = 0;
    let TD: TTD | null = null;
    Absatz = true;
    if (Wrap) {
      for (let i = 1; i <= LL.v; i++) if (TA[i - 1] === 13 && (i === LL.v || TA[i] !== 10)) TA[i - 1] = 0x20;
    }
    let ss = GetLine(TAOff, LL, Width, Wrap);
    write(ss);
    while (LL.v > 0) {
      ss = GetLine(TAOff, LL, Width, Wrap);
      Ln++;
      if (Ln === 1) {
        TD = new TTD();
        TD.SL = null;
        TD.Col = Col;
        TD.Width = Width;
      }
      const SL = new StringListEl();
      SL.S = ss;
      ChainLast(fref(TD!, 'SL'), SL);
    }
    if (Ln > 0) {
      TD!.Ln = Ln;
      ChainLast(fref(Y, 'TD'), TD!);
      if (Ln > Y.TLn) Y.TLn = Ln;
    }
  }
  // PAS: RUNRPRT.PAS CheckPgeLimit (nested)
  function CheckPgeLimit(): void {
    if (Y.ChkPg && av.RprtLine > av.PgeLimit && av.PgeLimit < PgeSize) {
      const p2 = Store2Ptr;
      const YY = Y;
      ResetY();
      NewPage();
      Y = YY;
      Store2Ptr = p2;
    }
  }
  // PAS: RUNRPRT.PAS PendingTT (nested) – the queued lines of text columns
  function PendingTT(): void {
    const lll = LineLenLst;
    let Col = LineLenLst + 1;
    while (Y.TLn > 0) {
      NewLine();
      CheckPgeLimit();
      let TD = Y.TD;
      Col = 1;
      while (TD !== null) {
        if (TD.Ln > 0) {
          WriteNBlks(TD.Col - Col);
          const SL = TD.SL!;
          write(SL.S);
          const l = LenStyleStr(SL.S);
          Col = TD.Col + l;
          TD.Ln--;
          TD.SL = SL.Chain;
        }
        TD = TD.Chain;
      }
      Y.TLn--;
      LineLenLst = lll;
    }
    WriteNBlks(LineLenLst + 1 - Col);
    if (Y.TD !== null) {
      Y.TD = null;
      Y.TLn = 0;
    }
  }
  // PAS: RUNRPRT.PAS Print1NTupel (nested) – print the block text with the field values
  function Print1NTupel(Skip: boolean): void {
    if (Y.Ln === 0) return;
    let RF: RFldDPtr = null;
    let atHead = true; // RF = RFldDPtr(@Y.Blk^.RFD): the fake head whose Chain is RFD
    const T = Y.Blk!.Txt!;
    for (;;) {
      // label 1
      WasOutput = true;
      while (Y.I < Y.Sz) {
        const p = Y.P + Y.I; // RE := @Y.P[Y.I]
        const C = T[p];
        if (C === 0xff) {
          RF = atHead ? Y.Blk!.RFD : RF!.Chain;
          atHead = false;
          if (RF === null) return;
          const L = T[p + 1]; // RE^.L, RE^.M
          const M = T[p + 2];
          if (RF.FrmlTyp === 'R') {
            let R: float = 0;
            if (!Skip) R = RunReal(RF.Frml);
            let Mask = '';
            let lbl2 = false;
            switch (RF.Typ) {
              case 'R':
              case 'F':
                if (Skip) write(Fw(' ', L));
                else {
                  if (RF.Typ === 'F') R = R / Power10[M];
                  if (RF.BlankOrWrap && R === 0) {
                    if (M === 0) write(Fw(' ', L));
                    else write(Fw(' ', L - M - 1), '.', Fw(' ', M));
                  } else write(StrR(R, L, M));
                }
                Y.I += 2;
                break;
              case 'D':
                if (RF.BlankOrWrap) Mask = 'DD.MM.YYYY';
                else Mask = 'DD.MM.YY';
                lbl2 = true;
                break;
              case 'T':
                Mask = 'hhhhhh'.slice(0, L) + ':mm:ss.tt'.slice(0, M);
                Y.I += 2;
                lbl2 = true;
                break;
            }
            if (lbl2) {
              // label 2
              if (Skip) write(Fw(' ', Mask.length));
              else write(StrDate(R, Mask));
            }
          } else {
            if (RF.Typ === 'P') {
              const S = RunLongStr(RF.Frml);
              // ^P, then the LongStr with its length word
              write('\x10', chr(S.length & 0xff), chr((S.length >> 8) & 0xff));
              let t = '';
              for (let k = 0; k < S.length; k++) t += chr(S[k]);
              write(t);
              Y.I++; // label 3
              continue;
            }
            Y.I += 2;
            if (Skip) write(Fw(' ', L));
            else {
              switch (RF.FrmlTyp) {
                case 'S': {
                  let S = RunLongStr(RF.Frml);
                  let LL = S.length;
                  while (LL > 0 && S[LL - 1] === 0x20) LL--;
                  S = S.subarray(0, LL);
                  NewTxtCol(S, M, L, RF.BlankOrWrap);
                  break;
                }
                case 'B':
                  if (RunBool(RF.Frml)) write(bv.AbbrYes);
                  else write(bv.AbbrNo);
                  break;
              }
            }
          }
        } else {
          if (C === 0x2e && Y.I === 0 && FirstLines) WasDot = true;
          write(chr(C));
        }
        Y.I++; // label 3
      }
      PendingTT();
      Y.Ln--;
      if (Y.Ln > 0) {
        Y.P += Y.Sz;
        NewLine();
        const L = T[Y.P];
        Y.P++;
        Y.Sz = getWord(T, Y.P);
        Y.P += 2;
        Y.I = 0;
        CheckPgeLimit();
        LineLenLst = L;
        continue; // goto 1
      }
      break;
    }
    Y.Blk = null;
  }
  // PAS: RUNRPRT.PAS FinishTuple (nested)
  function FinishTuple(): void {
    while (Y.Blk !== null) Print1NTupel(true);
  }
  // PAS: RUNRPRT.PAS RunAProc (nested)
  function RunAProc(A: AssignDPtr): void {
    while (A !== null) {
      switch (A.Kind) {
        case _locvar:
          LVAssignFrml(A.LV, bv.MyBP, A.Add, A.Frml);
          break;
        case _parfile:
          AsgnParFldFrml(A.FD, A.PFldD, A.Frml, A.Add);
          break;
        case _ifthenelseM:
          if (RunBool(A.Bool)) RunAProc(A.Instr);
          else RunAProc(A.ElseInstr);
          break;
      }
      A = A.Chain;
    }
  }
  // PAS: RUNRPRT.PAS PrintTxt (nested)
  function PrintTxt(B: BlkDPtr, ChkPg: boolean): void {
    if (B === null) return;
    if (B.SetPage) {
      PageNo = RunInt(B.PageNo);
      SetPage = true;
    }
    if (B !== Y.Blk) {
      FinishTuple();
      if (B.AbsLine) {
        const i1 = av.RprtLine;
        const i2 = RunInt(B.LineNo) - 1;
        for (let I = i1; I <= i2; I++) NewLine();
      }
      if (B.NTxtLines > 0) {
        if (B.NBlksFrst < LineLenLst) NewLine();
        for (let I = 1; I <= B.NBlksFrst - LineLenLst; I++) write(' ');
      }
      ResetY();
      Y.Ln = B.NTxtLines;
      if (Y.Ln !== 0) {
        Y.Blk = B;
        Y.P = 0;
        Y.ChkPg = ChkPg;
        const T = B.Txt!;
        LineLenLst = T[Y.P];
        Y.P++;
        Y.Sz = getWord(T, Y.P);
        Y.P += 2;
      }
    }
    RunAProc(B.BeforeProc);
    Print1NTupel(false);
    RunAProc(B.AfterProc);
  }
  // PAS: RUNRPRT.PAS TruncLine (nested)
  function TruncLine(): void {
    FinishTuple();
    if (LineLenLst > 0) NewLine();
  }
  // PAS: RUNRPRT.PAS PrintBlkChn (nested)
  function PrintBlkChn(B: BlkDPtr, ChkPg: boolean, ChkLine: boolean): void {
    while (B !== null) {
      if (RunBool(B.Bool)) {
        if (ChkLine) {
          if (OutOfLineBound(B)) WasFF2 = true;
          if (B.FF1 || WasFF2) NewPage();
        }
        PrintTxt(B, ChkPg);
        WasFF2 = B.FF2;
      }
      B = B.Chain;
    }
  }
  // PAS: RUNRPRT.PAS PrintPageFt (nested)
  function PrintPageFt(): void {
    if (!FrstBlk) {
      const b = WasFF2;
      TruncLine();
      const Ln = av.RprtLine;
      PrintBlkChn(rv.PageFt, false, false);
      TruncLine();
      NoFF = av.RprtLine < Ln;
      Zero(rv.PFZeroLst);
      WasFF2 = b;
    }
  }
  // PAS: RUNRPRT.PAS PrintPageHd (nested)
  function PrintPageHd(): void {
    const b = FrstBlk;
    if (!b) FormFeed();
    PrintBlkChn(rv.PageHd, false, false);
    if (!b) PrintDH = 2;
  }
  // PAS: RUNRPRT.PAS SumUp (nested)
  function SumUp(S: SumElPtr): void {
    while (S !== null) {
      S.R = S.R + RunReal(S.Frml);
      S = S.Chain;
    }
  }
  // PAS: RUNRPRT.PAS PrintBlock (nested) – DH: the DH blocks to print before (#DH .notsolo)
  function PrintBlock(B: BlkDPtr, DH: BlkDPtr): void {
    let pdh = false;
    while (B !== null) {
      if (RunBool(B.Bool)) {
        if (B !== Y.Blk) {
          if (B.NTxtLines > 0 && B.NBlksFrst < LineLenLst) TruncLine();
          if (OutOfLineBound(B)) WasFF2 = true;
          let LAfter = av.RprtLine + MaxI(0, B.NTxtLines - 1);
          if (DH !== null && PrintDH >= DH.DHLevel + 1) {
            let B1: BlkDPtr = DH;
            while (B1 !== null) {
              if (RunBool(B1.Bool)) LAfter += B1.NTxtLines;
              B1 = B1.Chain;
            }
          }
          if (B.FF1 || WasFF2 || (FrstBlk && B.NTxtLines > 0) || (av.PgeLimit < PgeSize && LAfter > av.PgeLimit)) NewPage();
          if (DH !== null && PrintDH >= DH.DHLevel + 1) {
            PrintBlkChn(DH, true, false);
            PrintDH = 0;
          }
        }
        WasOutput = false;
        PrintTxt(B, true);
        WasFF2 = B.FF2;
        if (DH === null && WasOutput) pdh = true;
        SumUp(B.Sum);
      }
      B = B.Chain;
    }
    if (pdh) PrintDH = 2;
  }
  // PAS: RUNRPRT.PAS Footings (nested)
  function Footings(L: LvDescrPtr, L2: LvDescrPtr): void {
    while (L !== null) {
      PrintBlock(L.Ft, null);
      if (L === L2) return;
      L = L.Chain;
    }
  }
  // PAS: RUNRPRT.PAS Headings (nested)
  function Headings(L: LvDescrPtr, L2: LvDescrPtr): void {
    while (L !== null && L !== L2) {
      PrintBlock(L.Hd, null);
      L = L.ChainBack;
    }
  }
  // PAS: RUNRPRT.PAS ZeroSumFlds (nested)
  function ZeroSumFlds(L: LvDescrPtr): void {
    while (L !== null) {
      Zero(L.ZeroLst);
      L = L.ChainBack;
    }
  }
  // PAS: RUNRPRT.PAS ReadInpFile (nested)
  function ReadInpFile(ID: InpDPtr): void {
    const id = ID!;
    av.CRecPtr = id.ForwRecPtr;
    for (;;) {
      id.Scan!.GetRec();
      if (id.Scan!.EOF) return;
      if (ESCPressed() && PromptYN(24)) {
        bv.WasLPTCancel = true;
        GoExit();
      }
      RecCount++;
      RunMsgN(RecCount);
      if (RunBool(id.Bool)) return;
    }
  }
  // PAS: RUNRPRT.PAS OpenInp (nested)
  function OpenInp(): void {
    NRecsAll = 0;
    for (let i = 1; i <= rv.MaxIi; i++) {
      const id = rv.IDA[i]!;
      av.CFile = id.Scan!.FD;
      if (id.Scan!.Kind === 5) id.Scan!.SeekRec(0);
      else {
        id.Md = NewLMode(RdMode);
        id.Scan!.ResetSort(id.SK, fref(id, 'Bool'), id.Md, id.SQLFilter);
      }
      NRecsAll += id.Scan!.NRecs;
    }
  }
  // PAS: RUNRPRT.PAS CloseInp (nested)
  function CloseInp(): void {
    for (let i = 1; i <= rv.MaxIi; i++) {
      const id = rv.IDA[i]!;
      if (id.Scan!.Kind !== 5) {
        id.Scan!.Close();
        ClearRecSpace(id.ForwRecPtr!);
        OldLMode(id.Md);
      }
    }
  }
  // PAS: RUNRPRT.PAS CompMFlds (nested)
  function CompMFlds(C: ConstList, M: KeyFldDPtr, NLv: Ref<number>): number {
    const x = new XString();
    NLv.v = 0;
    while (C !== null) {
      NLv.v++;
      x.Clear();
      x.StoreKF(M);
      const res = CompStr(x.S, C.S);
      if (res !== ord_equ) return res;
      C = C.Chain;
      M = M!.Chain;
    }
    return ord_equ;
  }
  // PAS: RUNRPRT.PAS GetMFlds (nested) – x: XStringPtr(@C^.S)
  function GetMFlds(C: ConstList, M: KeyFldDPtr): void {
    while (C !== null) {
      const x = new XString();
      x.StoreKF(M);
      C.S = x.S;
      C = C.Chain;
      M = M!.Chain;
    }
  }
  // PAS: RUNRPRT.PAS MoveMFlds (nested)
  function MoveMFlds(C1: ConstList, C2: ConstList): void {
    while (C2 !== null) {
      C2.S = C1!.S;
      C1 = C1!.Chain;
      C2 = C2.Chain;
    }
  }
  // PAS: RUNRPRT.PAS PutMFlds (nested) – the match fields of the missing input from MinID
  function PutMFlds(M: KeyFldDPtr): void {
    if (MinID === null) return;
    const cf = av.CFile;
    const cf1 = MinID.Scan!.FD;
    const cr = av.CRecPtr;
    const cr1 = MinID.ForwRecPtr;
    let m1 = MinID.MFld;
    while (M !== null) {
      const f: FieldDPtr = M.FldD;
      const f1: FieldDPtr = m1!.FldD;
      av.CFile = cf1;
      av.CRecPtr = cr1;
      switch (f!.FrmlTyp) {
        case 'S': {
          const s = _ShortS(f1);
          av.CFile = cf;
          av.CRecPtr = cr;
          S_(f, s);
          break;
        }
        case 'R': {
          const r = _R(f1);
          av.CFile = cf;
          av.CRecPtr = cr;
          R_(f, r);
          break;
        }
        default: {
          const b = _B(f1);
          av.CFile = cf;
          av.CRecPtr = cr;
          B_(f, b);
        }
      }
      M = M.Chain;
      m1 = m1!.Chain;
    }
  }
  // PAS: RUNRPRT.PAS GetMinKey (nested)
  function GetMinKey(): void {
    let mini = 0;
    NEof = 0;
    const nlv = ref(0);
    for (let i = 1; i <= rv.MaxIi; i++) {
      const id = rv.IDA[i]!;
      av.CFile = id.Scan!.FD;
      if (id.Scan!.EOF) NEof++;
      if (rv.OldMFlds === null) {
        id.Exist = !id.Scan!.EOF;
        mini = 1;
      } else {
        av.CRecPtr = id.ForwRecPtr;
        id.Exist = false;
        if (!id.Scan!.EOF) {
          let res = ord_lt; // mini = 0: goto 1
          if (mini !== 0) res = CompMFlds(rv.NewMFlds, id.MFld, nlv);
          if (res !== ord_gt) {
            if (res === ord_lt) {
              // label 1
              GetMFlds(rv.NewMFlds, id.MFld);
              mini = i;
            }
            id.Exist = true;
          }
        }
      }
    }
    if (mini > 0) {
      for (let i = 1; i <= mini - 1; i++) rv.IDA[i]!.Exist = false;
      MinID = rv.IDA[mini];
    } else MinID = null;
  }
  // PAS: RUNRPRT.PAS ZeroCount (nested)
  function ZeroCount(): void {
    for (let i = 1; i <= rv.MaxIi; i++) rv.IDA[i]!.Count = 0.0;
  }
  // PAS: RUNRPRT.PAS GetDifLevel (nested) – the level of the first changed match field
  function GetDifLevel(): LvDescrPtr {
    let C1 = rv.NewMFlds;
    let C2 = rv.OldMFlds;
    let M = rv.IDA[1]!.MFld;
    let L = rv.LstLvM!.ChainBack;
    while (M !== null) {
      if (C1!.S !== C2!.S) return L;
      C1 = C1!.Chain;
      C2 = C2!.Chain;
      M = M.Chain;
      L = L!.ChainBack;
    }
    return null; // Pascal: result undefined (the keys always differ here)
  }
  // PAS: RUNRPRT.PAS MoveForwToRec (nested)
  function MoveForwToRec(ID: InpDPtr): void {
    const id = ID!;
    av.CFile = id.Scan!.FD;
    av.CRecPtr = av.CFile!.RecPtr;
    Move(id.ForwRecPtr!, av.CRecPtr!, av.CFile!.RecLen + 1);
    id.Count = id.Count + 1;
    let C = id.Chk;
    if (C !== null) {
      id.Error = false;
      id.Warning = false;
      id.ErrTxtFrml!.S = '';
      while (C !== null) {
        if (!RunBool(C.Bool)) {
          id.Warning = true;
          id.ErrTxtFrml!.S = RunShortStr(C.TxtZ);
          if (!C.Warning) {
            id.Error = true;
            return;
          }
        }
        C = C.Chain;
      }
    }
  }
  // PAS: RUNRPRT.PAS MoveFrstRecs (nested)
  function MoveFrstRecs(): void {
    for (let i = 1; i <= rv.MaxIi; i++) {
      const id = rv.IDA[i]!;
      if (id.Exist) MoveForwToRec(id);
      else {
        av.CFile = id.Scan!.FD;
        av.CRecPtr = av.CFile!.RecPtr;
        ZeroAllFlds();
        PutMFlds(id.MFld);
      }
    }
  }
  // PAS: RUNRPRT.PAS MergeProc (nested) – the detail records of one group
  function MergeProc(): void {
    const nlv = ref(0);
    for (let i = 1; i <= rv.MaxIi; i++) {
      const ID = rv.IDA[i]!;
      if (!ID.Exist) continue;
      av.CFile = ID.Scan!.FD;
      av.CRecPtr = av.CFile!.RecPtr;
      let L = ID.LstLvS;
      lbl1: for (;;) {
        // label 1
        ZeroSumFlds(L);
        GetMFlds(ID.OldSFlds, ID.SFld);
        if (WasFF2) PrintPageHd();
        Headings(L, ID.FrstLvS);
        if (PrintDH === 0) PrintDH = 1;
        for (;;) {
          // label 2
          PrintBlock(ID.FrstLvS!.Ft, ID.FrstLvS!.Hd); // DE
          SumUp(ID.Sum);
          ReadInpFile(ID);
          if (ID.Scan!.EOF) break lbl1;
          let res = CompMFlds(rv.NewMFlds, ID.MFld, nlv);
          if (res === ord_lt && rv.MaxIi > 1) {
            SetMsgPar(ID.Scan!.FD!.Name);
            RunError(607);
          }
          if (res !== ord_equ) break lbl1;
          res = CompMFlds(ID.OldSFlds, ID.SFld, nlv);
          if (res === ord_equ) {
            MoveForwToRec(ID);
            continue;
          }
          L = ID.LstLvS;
          while (nlv.v > 1) {
            L = L!.ChainBack;
            nlv.v--;
          }
          Footings(ID.FrstLvS!.Chain, L);
          if (WasFF2) PrintPageFt();
          MoveForwToRec(ID);
          continue lbl1;
        }
      }
      // label 4
      Footings(ID.FrstLvS!.Chain, ID.LstLvS);
    }
  }
  // PAS: RUNRPRT.PAS RewriteRprt (nested) – open Rprt (print view file, LPT1 or a file)
  function RewriteRprt(RO: RprtOptPtr, Pl: number, Times: Ref<number>, IsLPT1: Ref<boolean>): boolean {
    rv.PrintView = false;
    bv.WasLPTCancel = false;
    IsLPT1.v = false;
    Times.v = 1;
    let PrintCtrl = RO !== null ? RO.PrintCtrl : false; // BP7 reads RO^ even when RO = nil
    if (RO !== null && RO.Times !== null) Times.v = RunInt(RO.Times) & 0xffff;
    if (RO === null || (RO.Path === null && RO.CatIRec === 0)) {
      SetPrintTxtPath();
      rv.PrintView = true;
      PrintCtrl = false;
    } else {
      if (RO.Path !== null && SEquUpcase(RO.Path, 'LPT1')) {
        bv.CPath = 'LPT1';
        bv.CVol = '';
        IsLPT1.v = true;
        return ResetPrinter(Pl, 0, true, true) && RewriteTxt(Rprt, false);
      }
      SetTxtPathVol(RO.Path, RO.CatIRec);
    }
    TestMountVol(bv.CPath[0] ?? '\0');
    if (!RewriteTxt(Rprt, PrintCtrl)) {
      SetMsgPar(bv.CPath);
      WrLLF10Msg(700 + bv.HandleError);
      rv.PrintView = false;
      return false;
    }
    if (Times.v > 1) {
      writeln('.ti ', StrI(Times.v, 1));
      Times.v = 1;
    }
    if (Pl !== 72) writeln('.pl ', StrI(Pl));
    return true;
  }

  // RunReport - body
  if (rv.SelQuest) {
    const id = rv.IDA[1]!;
    av.CFile = id.Scan!.FD;
    const s = ref<StringPtr>(null);
    if (!PromptFilter('', fref(id, 'Bool'), s)) {
      rv.PrintView = false;
      return;
    }
  }
  if (rv.PgeLimitZ !== null) av.PgeLimit = RunInt(rv.PgeLimitZ) & 0xffff;
  else av.PgeLimit = bv.Spec.AutoRprtLimit;
  if (rv.PgeSizeZ !== null) PgeSize = RunInt(rv.PgeSizeZ);
  else PgeSize = bv.Spec.AutoRprtLimit + bv.Spec.CpLines;
  if (PgeSize < 2) PgeSize = 2;
  if (av.PgeLimit > PgeSize || av.PgeLimit === 0) av.PgeLimit = (PgeSize - 1) & 0xffff;
  const Times = ref(0);
  const isLPT1 = ref(false);
  if (!RewriteRprt(RO, PgeSize, Times, isLPT1)) return;
  Store2Ptr = null; // MarkStore2(Store2Ptr)
  let ex = true;
  PushProcStk();
  const er = new ExitRecord();
  NewExit(Ovr, er);
  try {
    OpenInp();
    rv.MergOpGroup.Group = 1.0;
    let frst = true;
    NLinesOutp = 0;
    PrintDH = 2;
    lbl0: for (;;) {
      // label 0
      RunMsgOn('R', NRecsAll);
      RecCount = 0;
      for (let i = 1; i <= rv.MaxIi; i++) {
        if (frst) frst = false;
        else rv.IDA[i]!.Scan!.SeekRec(0);
        ReadInpFile(rv.IDA[i]);
      }
      av.RprtPage = 1;
      av.RprtLine = 1;
      SetPage = false;
      FirstLines = true;
      WasDot = false;
      WasFF2 = false;
      NoFF = false;
      LineLenLst = 0;
      FrstBlk = true;
      ResetY();
      let L = rv.LstLvM;
      const RFb = rv.LstLvM!.Ft;
      ZeroSumFlds(L);
      GetMinKey();
      ZeroCount();
      MoveFrstRecs();
      if (rv.RprtHd !== null) {
        if (rv.RprtHd.FF1) FormFeed();
        av.RprtPage = 1;
        PrintBlkChn(rv.RprtHd, false, false);
        TruncLine();
        if (WasFF2) FormFeed();
        if (SetPage) {
          SetPage = false;
          av.RprtPage = PageNo & 0xffff;
        } else av.RprtPage = 1;
      }
      let goto2 = NEof === rv.MaxIi;
      for (;;) {
        if (!goto2) {
          // label 1
          if (WasFF2) PrintPageHd();
          Headings(L, null);
          MergeProc();
          MoveMFlds(rv.NewMFlds, rv.OldMFlds);
          GetMinKey();
          if (NEof !== rv.MaxIi) {
            L = GetDifLevel();
            Footings(rv.FrstLvM, L);
            if (WasFF2) PrintPageFt();
            ZeroSumFlds(L);
            ZeroCount();
            MoveFrstRecs();
            rv.MergOpGroup.Group = rv.MergOpGroup.Group + 1.0;
            continue; // goto 1
          }
          if (rv.FrstLvM !== rv.LstLvM) Footings(rv.FrstLvM, rv.LstLvM!.ChainBack);
        }
        goto2 = false;
        // label 2
        WasFF2 = false;
        TruncLine();
        PrintBlkChn(RFb, false, true);
        const b = WasFF2;
        if (rv.PageFt !== null && !rv.PageFt.NotAtEnd) PrintPageFt();
        TruncLine();
        RunMsgOff();
        if (Times.v > 1) {
          // only LPT1
          Times.v--;
          write('\x0c');
          continue lbl0;
        }
        if (b) FormFeed();
        ex = false;
        break lbl0;
      }
    }
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
  } finally {
    RestoreExit(er);
  }
  // label 3
  if (rv.PrintView && NLinesOutp === 0 && LineLenLst === 0) {
    RdMsg(159);
    writeln();
    write(bv.MsgLine);
  }
  TxtClose(Rprt);
  if (isLPT1.v) ClosePrinter(0);
  CloseInp();
  PopProcStk();
  if (ex) {
    RunMsgOff();
    if (!bv.WasLPTCancel) GoExit();
  }
}
