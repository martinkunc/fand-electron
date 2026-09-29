// PAS: GR2D.PAS – 2D bar, circular (pie) and line graphs. NOT PORTED.
//
// Porting notes:
// * Not compiled in the FPC build ({$ifdef FandGraph} is off): typed stubs calling notSupported.
//   BGI graphics (graph unit) throughout; see grglob.ts for the GR* family notes.

import { notSupported } from './pasrt.ts';
import type { Maxima, Parametry } from './grglob.ts';

// PAS: GR2D.PAS Sloupce2
export function Sloupce2(Param: Parametry, Maxim: Maxima): void {
  return notSupported('GR2D.Sloupce2');
}
// PAS: GR2D.PAS Sloupce3
export function Sloupce3(Param: Parametry, Maxim: Maxima): void {
  return notSupported('GR2D.Sloupce3');
}
// PAS: GR2D.PAS Circular
export function Circular(Param: Parametry, Maxim: Maxima): void {
  return notSupported('GR2D.Circular');
}
// PAS: GR2D.PAS Linear
export function Linear(Param: Parametry, Maxim: Maxima): void {
  return notSupported('GR2D.Linear');
}
