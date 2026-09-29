// PAS: GRPOLY.PAS – polynomial regression graph. NOT PORTED.
//
// Porting notes:
// * Not compiled in the FPC build ({$ifdef FandGraph} is off): typed stubs calling notSupported.
//   BGI graphics (graph unit) throughout; see grglob.ts for the GR* family notes.

import { notSupported } from './pasrt.ts';
import type { Maxima, Parametry } from './grglob.ts';

// PAS: GRPOLY.PAS PolyLin
export function PolyLin(Param: Parametry, Maxim: Maxima): void {
  return notSupported('GRPOLY.PolyLin');
}
