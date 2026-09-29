// PAS: GRMENU1.PAS – graph parameter menus 7 and 8. NOT PORTED.
//
// Porting notes:
// * Not compiled in the FPC build ({$ifdef FandGraph} is off): typed stubs calling notSupported.
//   BGI graphics (graph unit) throughout; see grglob.ts for the GR* family notes.

import { notSupported } from './pasrt.ts';
import type { Maxima, Param3, Parametry } from './grglob.ts';
import type { GraphDPtr } from './rdrun.ts';

// PAS: GRMENU1.PAS Menu7
export function Menu7(Param: Parametry, Par3: Param3, Maxim: Maxima, GD: GraphDPtr): void {
  return notSupported('GRMENU1.Menu7');
}
// PAS: GRMENU1.PAS Menu8
export function Menu8(Param: Parametry, Par3: Param3): void {
  return notSupported('GRMENU1.Menu8');
}
