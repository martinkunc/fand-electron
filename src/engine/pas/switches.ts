// PAS: SWITCHES.PAS – conditional-compilation switches {$I switches}-ed by every unit.
//
// Porting notes:
// * Not code: the flags pick which Pascal branches are ported (PORTING.md 1). They are exported
//   as constants for documentation and for the rare runtime check; ported code simply leaves the
//   inactive branches out instead of testing these.
// * FPC also sets {$mode tp} {$J+} (typed constants are writable -> <Unit>Vars) and {$H-}
//   (string = ShortString -> byte strings).

// PAS: SWITCHES.PAS {$define ...} – active in the FPC build we follow
export const FandNetV = true;
export const FandDML = true;
export const FandProlog = true;
export const FandLProc = true; // defined with FandProlog
export const FandGraphParse = true; // defined for FPC (GRAPH instructions parsed, not run)
// inactive: { $define ...}
export const FandRunV = false;
export const FandSQL = false;
export const FandDemo = false;
export const FandTest = false;
export const FandAng = false;
export const Trial = false;
export const FandGraph = false;
export const Coproc = false;
