// PAS: RUNGRAPH.PAS – runs the GRAPH instruction and the F-key auto graph. NOT PORTED.
//
// Porting notes:
// * Not compiled in the FPC build ({$ifdef FandGraph} is off): typed stubs calling notSupported.
//   GraphD/WinG records are still built by RDPROC (FandGraphParse), see rdrun.ts. Účto uses
//   graph(...) in some menus when PARAM3.ÚčtoG is false; the caller should show a message rather
//   than let NotImplementedError end the task.
// * asm/DOS: BGI InitGraph/CloseGraph, switching between text and graphics mode, printing the
//   screen image to the printer.

import { notSupported } from './pasrt.ts';
import type { FieldList, FrmlPtr, KeyDPtr } from './access.ts';
import type { GraphDPtr } from './rdrun.ts';

// PAS: RUNGRAPH.PAS RunBGraph
export function RunBGraph(GD: GraphDPtr, AutoGraph: boolean): void {
  return notSupported('RUNGRAPH.RunBGraph');
}
// PAS: RUNGRAPH.PAS RunAutoGraph
export function RunAutoGraph(FL: FieldList, VK: KeyDPtr, Bool: FrmlPtr): void {
  return notSupported('RUNGRAPH.RunAutoGraph');
}
