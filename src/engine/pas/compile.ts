// PAS: COMPILE.PAS – the shared compiler front end: lexer (LEXANAL), declarations and helpers
// (RDMIX), formula parser (RDFRML, RDFRML1). Used by RDPROC, RDFILDCL, RDEDIT, RDRPRT, RDMERG,
// RDPROLG, PROJMGR, EDITOR, EXPIMP, DML.
//
// Porting notes:
// * State: the lexer state lives in ACCESS (AccessVars.CurrChar .. LstCompileVar: CurrChar,
//   ForwChar, ExpChar, Lexem, LexWord, InpArrPtr/InpArrLen/CurrPos/OldErrPos, InpRdbPos,
//   PrevCompInp, the *Allowed flags, FrmlSumEl, RdFldNameFrml/RdFunction/ChainSumEl, ...) plus
//   AccessVars.Switches/SwitchLevel ({$define}/{$ifdef}). COMPILE's own interface variable is only
//   ChptIPos (CompileVars). Procedures' local vars are declared into RdRunVars.LVBD.
// * asm/DOS-specific: Ovr (overlay stack fix-up, not needed: no NewExit(Ovr) semantics here);
//   StateLen measures the byte span CurrChar..LstCompileVar – replaced by the field list
//   CompStateFields. The BP7 asm versions of Accept, EquUpcase, IsKeyWord, IsOpt (LEXANAL) and
//   IsFun (RDFRML) have FPC Pascal twins; see the notes in those modules for the small BP7
//   differences.
// * SaveCompState/RestoreCompState copy the whole compile state (used around nested compiles:
//   RdFileD of a FILE local var, CallRdFDSegment, GetEvalFrml, RDPROC include handling).
// * Tricky: Error() is the compile-error exit: it formats message 1000+N, optionally opens the
//   source in SimpleEditText at the error position (test run), sets EdRecKey/LastExitCode/
//   IsCompileErr/MsgLine and ends in GoExit(). Every caller of a compiler entry therefore runs
//   under a NewExit frame (see PORTING.md section 11).

import { CopyRec, type Pointer, type Ref } from './pasrt.ts';
import { AccessVars, RdbPos, type CompInpDPtr, type SumElPtr, type FrmlPtr } from './access.ts';

export * from './lexanal.ts';
export * from './rdmix.ts';
export * from './rdfrml.ts';
export * from './rdfrml1.ts';

let chptIPos: RdbPos | null = null;

export const CompileVars = {
  /** used in LexAnal and ProjMgr (lazy: RdbPos comes from another module) */
  get ChptIPos(): RdbPos {
    return (chptIPos ??= new RdbPos());
  },
  set ChptIPos(v: RdbPos) {
    chptIPos = v;
  },
};

/**
 * TS-only: the AccessVars fields between CurrChar and LstCompileVar (the byte range Pascal
 * SaveCompState moves), in declaration order.
 */
export const CompStateFields = [
  'CurrChar', 'ForwChar', 'ExpChar', 'Lexem', 'LexWord', 'SpecFDNameAllowed', 'IdxLocVarAllowed',
  'FDLocVarAllowed', 'IsCompileErr', 'PrevCompInp', 'InpArrPtr', 'InpRdbPos', 'InpArrLen', 'CurrPos',
  'OldErrPos', 'FrmlSumEl', 'FrstSumVar', 'FileVarsAllowed', 'RdFldNameFrml', 'RdFunction', 'ChainSumEl',
] as const;

/** TS-only: what SaveCompState returns. */
export interface CompState {
  CurrChar: string;
  ForwChar: string;
  ExpChar: string;
  Lexem: string;
  LexWord: string;
  SpecFDNameAllowed: boolean;
  IdxLocVarAllowed: boolean;
  FDLocVarAllowed: boolean;
  IsCompileErr: boolean;
  PrevCompInp: CompInpDPtr;
  InpArrPtr: Uint8Array | null;
  InpRdbPos: RdbPos;
  InpArrLen: number;
  CurrPos: number;
  OldErrPos: number;
  FrmlSumEl: SumElPtr;
  FrstSumVar: boolean;
  FileVarsAllowed: boolean;
  RdFldNameFrml: ((FTyp: Ref<string>) => FrmlPtr) | null;
  RdFunction: ((FTyp: Ref<string>) => FrmlPtr) | null;
  ChainSumEl: (() => void) | null;
}

// PAS: COMPILE.PAS SaveCompState
export function SaveCompState(): Pointer {
  const a = AccessVars as unknown as Record<string, unknown>;
  const st: Record<string, unknown> = {};
  for (const f of CompStateFields) st[f] = a[f];
  st.InpRdbPos = CopyRec(AccessVars.InpRdbPos); // record copy, not a reference
  return st as unknown as CompState;
}

// PAS: COMPILE.PAS RestoreCompState
export function RestoreCompState(p: Pointer): void {
  const a = AccessVars as unknown as Record<string, unknown>;
  const st = p as Record<string, unknown>;
  for (const f of CompStateFields) a[f] = st[f];
  AccessVars.InpRdbPos = CopyRec(st.InpRdbPos as RdbPos);
}
