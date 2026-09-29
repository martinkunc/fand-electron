// PAS: GR3DD.PAS – 3D bar graphs (D variants). NOT PORTED.
//
// Porting notes:
// * Not compiled in the FPC build ({$ifdef FandGraph} is off): typed stubs calling notSupported.
//   BGI graphics (graph unit) throughout; see grglob.ts for the GR* family notes.

import { notSupported } from './pasrt.ts';
import type { Maxima, Param3, Parametry } from './grglob.ts';

// PAS: GR3DD.PAS OsyD
export function OsyD(Param: Parametry, Par3: Param3, Maxim: Maxima): void {
  return notSupported('GR3DD.OsyD');
}
// PAS: GR3DD.PAS SloupDS
export function SloupDS(Param: Parametry, Par3: Param3, Maxim: Maxima): void {
  return notSupported('GR3DD.SloupDS');
}
// PAS: GR3DD.PAS SloupDL
export function SloupDL(Param: Parametry, Par3: Param3, Maxim: Maxima): void {
  return notSupported('GR3DD.SloupDL');
}
// PAS: GR3DD.PAS SloupSB
export function SloupSB(Param: Parametry, Par3: Param3, Maxim: Maxima): void {
  return notSupported('GR3DD.SloupSB');
}
