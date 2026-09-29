// PAS: RUNMERG.PAS – the merge interpreter (MERGE chapters/instruction): reads the input files
// IDA[1..MaxIi] in match-field order, runs the assignments per group and writes the output files.
//
// Porting notes:
// * asm/DOS: none.
// * Key global state: RdRunVars (IDA, MaxIi, OldMFlds/NewMFlds, OutpFDRoot, OutpRDs, Join,
//   MergOpGroup.Group (the `group` merge variable)), private NRecsAll (progress count,
//   RunMsgOn('M', NRecsAll)).
// * Tricky parts: all routines are nested in RunMerge. Group loop (label 1): the input with the
//   smallest match key (CompMFlds/SetOldMFlds) defines the group; JoinProc recursively forms the
//   cartesian product of the inputs (Join); RunAssign interprets AssignD chains (_zero/_move/_output/
//   _locvar/_parfile/_ifthenelseM; `_move` copies raw bytes FromPtr->ToPtr, L bytes); WriteOutp
//   writes OutpRD with Bool filters (append or rewrite, InplFD = in-place update). At the end
//   SaveCache(0) must succeed or GoExit. PushProcStk/PopProcStk frame for the merge locals.

import { Move, fref, ref, type Ref } from './pasrt.ts';
import { BaseVars, GoExit, SaveCache } from './base.ts';
import {
  AccessVars, XString, CompStr, ZeroAllFlds, ClearDeletedFlag, PutRec, TryInsertAllIndexes, NewLMode, OldLMode,
  ClearRecSpace, AsgnParFldFrml, _ShortS, _R, _B, S_, R_, B_, ExclMode, RdMode, _lt, _gt,
  type KeyFldDPtr, type SumElPtr, type FieldDPtr,
} from './access.ts';
import {
  RdRunVars, PushProcStk, PopProcStk, _zero, _move, _output, _locvar, _parfile, _ifthenelseM,
  type InpDPtr, type AssignDPtr, type OutpRDPtr, type OutpFDPtr, type ConstList,
} from './rdrun.ts';
import { RunMsgOn, RunMsgN, RunMsgOff, CFileError } from './obaseww.ts';
import { RewriteF, OpenDuplF, SubstDuplF } from './oaccess.ts';
import { RunBool, RunReal, RunShortStr, AssgnFrml, LVAssignFrml } from './runfrml.ts';

let NRecsAll = 0;

// PAS: RUNMERG.PAS RunMerge – run the compiled merge (RdRunVars state from RDMERG.ReadMerge)
export function RunMerge(): void {
  const av = AccessVars;
  const rv = RdRunVars;

  // PAS: RUNMERG.PAS CompMFlds (nested)
  function CompMFlds(M: KeyFldDPtr): number {
    const x = new XString();
    x.PackKF(M);
    return CompStr(x.S, rv.OldMXStr.S);
  }
  // PAS: RUNMERG.PAS SetOldMFlds (nested)
  function SetOldMFlds(M: KeyFldDPtr): void {
    rv.OldMXStr.Clear();
    let C: ConstList = rv.OldMFlds;
    while (C !== null) {
      const F: FieldDPtr = M!.FldD;
      switch (F!.FrmlTyp) {
        case 'S':
          C.S = _ShortS(F);
          rv.OldMXStr.StoreStr(C.S, M);
          break;
        case 'R':
          C.R = _R(F);
          rv.OldMXStr.StoreReal(C.R, M);
          break;
        default:
          C.B = _B(F);
          rv.OldMXStr.StoreBool(C.B, M);
      }
      C = C.Chain;
      M = M!.Chain;
    }
  }
  // PAS: RUNMERG.PAS SetMFlds (nested)
  function SetMFlds(M: KeyFldDPtr): void {
    let C: ConstList = rv.OldMFlds;
    while (M !== null) {
      const F = M.FldD;
      switch (F!.FrmlTyp) {
        case 'S':
          S_(F, C!.S);
          break;
        case 'R':
          R_(F, C!.R);
          break;
        default:
          B_(F, C!.B);
      }
      M = M.Chain;
      C = C!.Chain;
    }
  }
  // PAS: RUNMERG.PAS ReadInpFile (nested)
  function ReadInpFile(ID: InpDPtr): void {
    const id = ID!;
    av.CRecPtr = id.ForwRecPtr;
    for (;;) {
      id.Scan!.GetRec();
      if (id.Scan!.EOF) return;
      NRecsAll++;
      RunMsgN(NRecsAll);
      if (RunBool(id.Bool)) return;
    }
  }
  // PAS: RUNMERG.PAS ZeroSumFlds (nested)
  function ZeroSumFlds(Z: SumElPtr): void {
    while (Z !== null) {
      Z.R = 0.0;
      Z = Z.Chain;
    }
  }
  // PAS: RUNMERG.PAS SumUp (nested)
  function SumUp(Z: SumElPtr): void {
    while (Z !== null) {
      Z.R = Z.R + RunReal(Z.Frml);
      Z = Z.Chain;
    }
  }
  // PAS: RUNMERG.PAS RunAssign (nested)
  function RunAssign(A: AssignDPtr): void {
    while (A !== null) {
      switch (A.Kind) {
        case _move:
          Move(A.FromPtr!, A.ToPtr!, A.L);
          break;
        case _zero:
          switch (A.FldD!.FrmlTyp) {
            case 'S':
              S_(A.FldD, '');
              break;
            case 'R':
              R_(A.FldD, 0);
              break;
            default:
              B_(A.FldD, false);
          }
          break;
        case _output:
          AssgnFrml(A.OFldD, A.Frml, false, A.Add);
          break;
        case _locvar:
          LVAssignFrml(A.LV, BaseVars.MyBP, A.Add, A.Frml);
          break;
        case _parfile:
          AsgnParFldFrml(A.FD, A.PFldD, A.Frml, A.Add);
          break;
        case _ifthenelseM:
          if (RunBool(A.Bool)) RunAssign(A.Instr);
          else RunAssign(A.ElseInstr);
          break;
      }
      A = A.Chain;
    }
  }
  // PAS: RUNMERG.PAS WriteOutp (nested)
  function WriteOutp(RD: OutpRDPtr): void {
    while (RD !== null) {
      if (RunBool(RD.Bool)) {
        const OD: OutpFDPtr = RD.OD;
        if (OD === null) RunAssign(RD.Ass); // dummy
        else {
          av.CFile = OD.FD;
          av.CRecPtr = OD.RecPtr;
          ClearDeletedFlag();
          RunAssign(RD.Ass);
          // {$ifdef FandSQL} IsSQLFile: OD^.Strm^.PutRec – SQL not ported
          PutRec();
          if (OD.Append && av.CFile!.Typ === 'X') TryInsertAllIndexes(av.CFile!.IRec);
        }
      }
      RD = RD.Chain;
    }
  }
  // PAS: RUNMERG.PAS OpenInp (nested)
  function OpenInp(): void {
    NRecsAll = 0;
    for (let I = 1; I <= rv.MaxIi; I++) {
      const id = rv.IDA[I]!;
      av.CFile = id.Scan!.FD;
      if (id.IsInplace) id.Md = NewLMode(ExclMode);
      else id.Md = NewLMode(RdMode);
      id.Scan!.ResetSort(id.SK, fref(id, 'Bool'), id.Md, id.SQLFilter);
      NRecsAll += id.Scan!.NRecs;
    }
  }
  // PAS: RUNMERG.PAS OpenOutp (nested)
  function OpenOutp(): void {
    let OD = rv.OutpFDRoot;
    while (OD !== null) {
      av.CFile = OD.FD;
      // {$ifdef FandSQL} IsSQLFile: New(Strm, Init); OutpRewrite – SQL not ported
      if (OD.InplFD !== null) OD.FD = OpenDuplF(true);
      else OD.Md = RewriteF(OD.Append);
      OD = OD.Chain;
    }
  }
  // PAS: RUNMERG.PAS CloseInpOutp (nested)
  function CloseInpOutp(): void {
    let OD = rv.OutpFDRoot;
    while (OD !== null) {
      av.CFile = OD.FD;
      ClearRecSpace(OD.RecPtr!);
      // {$ifdef FandSQL} IsSQLFile: OutpClose; Done – SQL not ported
      if (OD.InplFD !== null) {
        av.CFile = OD.InplFD;
        SubstDuplF(OD.FD, true);
      } else OldLMode(OD.Md);
      OD = OD.Chain;
    }
    for (let i = 1; i <= rv.MaxIi; i++) {
      const id = rv.IDA[i]!;
      id.Scan!.Close();
      ClearRecSpace(id.ForwRecPtr!);
      OldLMode(id.Md);
    }
  }
  // PAS: RUNMERG.PAS MoveForwToRec (nested)
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
  // PAS: RUNMERG.PAS MergeProc (nested)
  function MergeProc(): void {
    for (let i = 1; i <= rv.MaxIi; i++) {
      const ID = rv.IDA[i]!;
      if (ID.Exist) {
        let res: number;
        do {
          MoveForwToRec(ID);
          SumUp(ID.Sum);
          WriteOutp(ID.RD);
          ReadInpFile(ID);
          if (ID.Scan!.EOF) res = ord_gt();
          else {
            res = CompMFlds(ID.MFld);
            if (res === ord_lt()) CFileError(607);
          }
        } while (res !== ord_gt());
      } else {
        av.CFile = ID.Scan!.FD;
        av.CRecPtr = av.CFile!.RecPtr;
        ZeroAllFlds();
        SetMFlds(ID.MFld);
      }
    }
  }
  // PAS: RUNMERG.PAS JoinProc (nested)
  function JoinProc(Ii: number, EmptyGroup: Ref<boolean>): void {
    if (Ii > rv.MaxIi) {
      if (!EmptyGroup.v) {
        for (let I = 1; I <= rv.MaxIi; I++) SumUp(rv.IDA[I]!.Sum);
        WriteOutp(rv.IDA[rv.MaxIi]!.RD);
      }
    } else {
      const ID = rv.IDA[Ii]!;
      if (ID.Exist) {
        ID.Scan!.SeekRec(ID.IRec - 1);
        ID.Count = 0.0;
        av.CRecPtr = ID.ForwRecPtr;
        ID.Scan!.GetRec();
        let res: number;
        do {
          MoveForwToRec(ID);
          JoinProc(Ii + 1, EmptyGroup);
          ReadInpFile(ID);
          if (ID.Scan!.EOF) res = ord_gt();
          else {
            res = CompMFlds(ID.MFld);
            if (res === ord_lt()) CFileError(607);
          }
        } while (res !== ord_gt());
      } else {
        av.CFile = ID.Scan!.FD;
        av.CRecPtr = av.CFile!.RecPtr;
        EmptyGroup.v = true;
        ZeroAllFlds();
        SetMFlds(ID.MFld);
        JoinProc(Ii + 1, EmptyGroup);
      }
    }
  }

  // RunMerge - body
  PushProcStk();
  OpenInp();
  OpenOutp();
  rv.MergOpGroup.Group = 1.0;
  RunMsgOn('M', NRecsAll);
  NRecsAll = 0;
  for (let I = 1; I <= rv.MaxIi; I++) ReadInpFile(rv.IDA[I]);
  for (;;) {
    // label 1
    let MinIi = 0;
    let NEof = 0;
    for (let I = 1; I <= rv.MaxIi; I++) {
      const id = rv.IDA[I]!;
      av.CFile = id.Scan!.FD;
      id.IRec = id.Scan!.IRec;
      ZeroSumFlds(id.Sum);
      if (id.Scan!.EOF) NEof++;
      if (rv.OldMFlds === null) {
        id.Exist = !id.Scan!.EOF;
        MinIi = 1;
      } else {
        av.CRecPtr = id.ForwRecPtr;
        id.Exist = false;
        id.Count = 0.0;
        if (!id.Scan!.EOF) {
          let res = ord_lt(); // MinIi = 0: goto 2
          if (MinIi !== 0) res = CompMFlds(id.MFld);
          if (res !== ord_gt()) {
            if (res === ord_lt()) {
              // label 2
              SetOldMFlds(id.MFld);
              MinIi = I;
            }
            id.Exist = true;
          }
        }
      }
    }
    for (let I = 1; I <= MinIi - 1; I++) rv.IDA[I]!.Exist = false;
    if (NEof === rv.MaxIi) {
      const b = SaveCache(0);
      RunMsgOff();
      if (!b) GoExit();
      CloseInpOutp();
      PopProcStk();
      return;
    }
    const EmptyGroup = ref(false);
    if (rv.Join) JoinProc(1, EmptyGroup);
    else MergeProc();
    if (!EmptyGroup.v) {
      WriteOutp(rv.OutpRDs);
      rv.MergOpGroup.Group = rv.MergOpGroup.Group + 1.0;
    }
  }
}

/** TS-only: ord(_gt) / ord(_lt) – compare results of CompStr */
function ord_gt(): number {
  return _gt.charCodeAt(0);
}
function ord_lt(): number {
  return _lt.charCodeAt(0);
}
