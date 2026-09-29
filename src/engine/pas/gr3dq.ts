// PAS: GR3DQ.PAS – 3D bar graphs (Q variants). NOT PORTED.
//
// Porting notes:
// * Not compiled in the FPC build ({$ifdef FandGraph} is off): typed stubs calling notSupported.
//   BGI graphics (graph unit) throughout; see grglob.ts for the GR* family notes.

import { notSupported } from './pasrt.ts';
import type { Maxima, Param3, Parametry } from './grglob.ts';

// PAS: GR3DQ.PAS OsyQ
export function OsyQ(Param: Parametry, Par3: Param3, Maxim: Maxima): void {
  return notSupported('GR3DQ.OsyQ');
}
// PAS: GR3DQ.PAS SloupQS
export function SloupQS(Param: Parametry, Par3: Param3, Maxim: Maxima): void {
  return notSupported('GR3DQ.SloupQS');
}
// PAS: GR3DQ.PAS SloupQL
export function SloupQL(Param: Parametry, Par3: Param3, Maxim: Maxima): void {
  return notSupported('GR3DQ.SloupQL');
}
