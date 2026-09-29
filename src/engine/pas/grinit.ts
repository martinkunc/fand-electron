// PAS: GRINIT.PAS – graph set-up: axes, maxima, parameter reading, PCX viewing. NOT PORTED.
//
// Porting notes:
// * Not compiled in the FPC build ({$ifdef FandGraph} is off): typed stubs calling notSupported.
//   BGI graphics (graph unit) throughout; see grglob.ts for the GR* family notes.

import { notSupported, type Ref } from './pasrt.ts';
import type { Maxima, Param3, Parametry } from './grglob.ts';
import type { GraphDPtr } from './rdrun.ts';

// PAS: GRINIT.PAS VypMax
export function VypMax(Param: Parametry, Par3: Param3, Maxim: Maxima): void {
  return notSupported('GRINIT.VypMax');
}
// PAS: GRINIT.PAS Osy
export function Osy(Param: Parametry, Maxim: Maxima): void {
  return notSupported('GRINIT.Osy');
}
// PAS: GRINIT.PAS OsaX
export function OsaX(Param: Parametry, Maxim: Maxima): void {
  return notSupported('GRINIT.OsaX');
}
// PAS: GRINIT.PAS Stop
export function Stop(Param: Parametry): void {
  return notSupported('GRINIT.Stop');
}
// PAS: GRINIT.PAS TextW
export function TextW(): void {
  return notSupported('GRINIT.TextW');
}
// PAS: GRINIT.PAS CtiPar
export function CtiPar(Param: Parametry, Poprve: boolean, Par3: Param3, Maxim: Maxima, GD: GraphDPtr): void {
  return notSupported('GRINIT.CtiPar');
}
// PAS: GRINIT.PAS ViewPCX
export function ViewPCX(Par: Parametry, GD: Ref<GraphDPtr>): void {
  return notSupported('GRINIT.ViewPCX');
}
// PAS: GRINIT.PAS ViewPCXInteract
export function ViewPCXInteract(Par: Parametry, filePCX: Ref<string>): void {
  return notSupported('GRINIT.ViewPCXInteract');
}
// PAS: GRINIT.PAS ViewRGB
export function ViewRGB(Par: Parametry): void {
  return notSupported('GRINIT.ViewRGB');
}
// PAS: GRINIT.PAS RestorePalette
export function RestorePalette(): void {
  return notSupported('GRINIT.RestorePalette');
}
