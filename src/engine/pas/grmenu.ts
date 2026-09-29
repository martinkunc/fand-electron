// PAS: GRMENU.PAS – interactive graph parameter menus. NOT PORTED.
//
// Porting notes:
// * Not compiled in the FPC build ({$ifdef FandGraph} is off): typed stubs calling notSupported.
//   BGI graphics (graph unit) throughout; see grglob.ts for the GR* family notes.

import { notSupported } from './pasrt.ts';
import type { Maxima, Param3, Parametry, str30 } from './grglob.ts';
import type { GraphDPtr } from './rdrun.ts';

// PAS: GRMENU.PAS MenuPar
export function MenuPar(Param: Parametry, Par3: Param3, Poprve: boolean, Maxim: Maxima, GD: GraphDPtr): void {
  return notSupported('GRMENU.MenuPar');
}
// PAS: GRMENU.PAS Menu1
export function Menu1(Param: Parametry, Par3: Param3, Maxim: Maxima): void {
  return notSupported('GRMENU.Menu1');
}
// PAS: GRMENU.PAS Menu2
export function Menu2(Param: Parametry, Par3: Param3, Maxim: Maxima): void {
  return notSupported('GRMENU.Menu2');
}
// PAS: GRMENU.PAS Menu3
export function Menu3(Param: Parametry, Par3: Param3, Maxim: Maxima): void {
  return notSupported('GRMENU.Menu3');
}
// PAS: GRMENU.PAS Menu4
export function Menu4(Param: Parametry, Par3: Param3): void {
  return notSupported('GRMENU.Menu4');
}
// PAS: GRMENU.PAS Menu5
export function Menu5(Param: Parametry, Par3: Param3): void {
  return notSupported('GRMENU.Menu5');
}
// PAS: GRMENU.PAS Menu6
export function Menu6(Param: Parametry, Par3: Param3): void {
  return notSupported('GRMENU.Menu6');
}
// PAS: GRMENU.PAS SetTxtPar1
export function SetTxtPar1(NPar: number, Txt: str30): void {
  return notSupported('GRMENU.SetTxtPar1');
}
// PAS: GRMENU.PAS SetTxtPar2
export function SetTxtPar2(NPar: number, Txt: str30): void {
  return notSupported('GRMENU.SetTxtPar2');
}
// PAS: GRMENU.PAS WritePar1
export function WritePar1(Param: Parametry, Par3: Param3): void {
  return notSupported('GRMENU.WritePar1');
}
// PAS: GRMENU.PAS WritePar2
export function WritePar2(Param: Parametry, Par3: Param3, Mask: boolean): void {
  return notSupported('GRMENU.WritePar2');
}
// PAS: GRMENU.PAS Menu
export function Menu(MsgNr: number, IStart: number): number {
  return notSupported('GRMENU.Menu');
}
