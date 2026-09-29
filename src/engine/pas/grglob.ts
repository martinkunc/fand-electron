// PAS: GRGLOB.PAS – shared types, state and helpers of the BGI business graphics. NOT PORTED.
//
// Porting notes:
// * The whole GR* family (GRGLOB, GRINIT, GRMENU, GRMENU1, GRPOLY, GR2D, GR3DD, GR3DQ, GRTRANSF) and
//   RUNGRAPH is compiled only with {$ifdef FandGraph}, which is off in the FPC build. Typed stubs
//   calling notSupported. GRAPH instructions are still parsed (FandGraphParse), and Účto calls
//   graph(...) when PARAM3.ÚčtoG is false – RUNPROC must report "not supported" instead of crashing.
// * asm/DOS: BGI (graph unit), DAC palette registers via int $10 (Reg: Registers), direct video
//   memory, PCX load/save in GRTRANSF.
// * Key state: Parametry/Param3/Maxima records built from GraphD by CtiPar/ParRad; window texts
//   (ParW, ParWPU[] TWork positions); palette RGB[]/DACReg; typed constants BarvyPasDef, IsDACReg,
//   AutoGr, MausVisibleGr, PCX, NoPCX -> GrGlobVars.

import { notSupported, type Pointer, type Ref } from './pasrt.ts';
import type { FieldDPtr, FieldList, FileDPtr } from './access.ts';
import type { LongStrPtr, WRect } from './base.ts';
import type { GraphDPtr, WinGPtr } from './rdrun.ts';

export const max = 64; // max. records in a graph
export const MaxWinGr = 128; // max. text windows
export const BarvyDef = 'BYrgmOGRbMCaAc';

export type str1 = string;
export type str9 = string;
export type str14 = string;
export type str15 = string;
export type str30 = string;
export type str80 = string;
export type ComStr = string;
// PAS: GRGLOB.PAS FilText
export type FilText = Uint8Array; // [1..2048] of char
export type typUX = str30[]; // [1..max]
export type typUY = number[]; // [1..max] of real

// graph unit types
export interface PointType {
  X: number;
  Y: number;
}
export interface ViewPortType {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  Clip: boolean;
}
export interface PaletteType {
  Size: number;
  Colors: number[];
}

// PAS: GRGLOB.PAS LongStrAll
export interface LongStrAll {
  LL: number;
  A: Uint8Array; // [1..2048]
}

// PAS: GRGLOB.PAS Parametry
export class Parametry {
  Typ = '';
  Print = '';
  NazevF = '';
  UdajX = '';
  UdajY = '';
  UdajZ = '';
  Hlavicka = '';
  NazevX = '';
  NazevY = '';
  NazevZ = '';
  Color = '';
  Rastr = '';
  PopX = '';
  UX: typUX = new Array<string>(max + 1).fill('');
  UY: typUY = new Array<number>(max + 1).fill(0);
  UZ: typUY = new Array<number>(max + 1).fill(0);
  UL: typUY = new Array<number>(max + 1).fill(0);
  PocVet = 0;
  Interact = false;
  Barvy = '';
  FileParNaz = '';
  FilePCX = '';
  StartVeta = 0;
  VyberVet = false;
  Border = '\0';
  Pomer = 0;
}
// PAS: GRGLOB.PAS Maxima
export class Maxima {
  MaxExp = 0;
  Maximum = 0;
  Minimum = 0;
  MaximumC = 0;
  MaximumVst = 0;
  MinimumVst = 0;
}
// PAS: GRGLOB.PAS ParamW
export class ParamW {
  XZ = 0;
  YZ = 0;
  XK = 0;
  YK = 0;
  BarPoz = 0;
  BarPis = 0;
  FTxt: LongStrAll = { LL: 0, A: new Uint8Array(2048) };
  Text = '';
}
// PAS: GRGLOB.PAS Param3
export class Param3 {
  Udaj3: str80[] = new Array<string>(10).fill(''); // [0..9]
  Nazev3: str80[] = new Array<string>(10).fill('');
  U3: typUY[] = Array.from({ length: 10 }, () => new Array<number>(max + 1).fill(0));
  PocZ = 0;
}
export interface RGBrec {
  R: number;
  G: number;
  B: number;
}
export type qadr = PointType[]; // [1..4]

export const GrGlobVars = {
  // typed constants
  BarvyPasDef: 'BGCRMOaAbgcrmyw',
  ConvCol: [0, 1, 2, 3, 4, 5, 20, 7, 56, 57, 58, 59, 60, 61, 62, 63],
  IsDACReg: false,
  AutoGr: false,
  MausVisibleGr: false,
  PCX: false,
  NoPCX: false,

  m: 0,
  StupPoly: 0,
  StupPolyP: 0,
  GRexit: false,
  Poprve: false,
  FileFPtr: null as FileDPtr,
  UdajXPtr: null as FieldDPtr,
  UdajYPtr: null as FieldDPtr,
  UdajZPtr: null as FieldDPtr,
  Udaj3Ptr: new Array<FieldDPtr>(10).fill(null),
  MenuInit: 0,
  MemAloc: null as Pointer,
  RGB: Array.from({ length: 16 }, (): RGBrec => ({ R: 0, G: 0, B: 0 })),
  MinimumC: 0,
  MinimumVstP: 0,
  PoprveInit: false,
  iores: 0,
  ParWPU: new Array<number>(129).fill(0), // [1..128]
  ParWPN: 0,
  psnx: 0,
  psny: 0,
  OldPalette: null as PaletteType | null,
  DACReg: new Uint8Array(768),
  LastViewPort: null as ViewPortType | null,
  ViewPort: null as ViewPortType | null,
  /** ViewPortGD: WRect absolute ViewPort80x25 */
  ViewPort80x25: null as WRect | null,
  GMaxX: 0,
  GMaxY: 0,
  SizeLetter: 0,
  ColorWWFrame: '\0',
  ColorWWBack: '\0',
  ColorWWFor: '\0',
  MakeCls: false,
  LastColor: 0,
  HeadFrame: '' as ComStr,
  WWShadow: false,
  psx: 0,
  psy: 0,
  GrDriv: 0,
  GrMode: 0,
  smallPCX: false,
  key: 0,
  FLLoc: null as FieldList,
  FLLoc1: null as FieldList,
  NazevFStart: '',
  Mask1: 0,
  Mask2: 0,
  wd: null as WinGPtr,
  top: '',
  GraphShadow: false,
  ExitPCX: false,
  FTx: null as LongStrPtr | null,
  ftn: 0,
  ParW: new ParamW(),
  AssignPCX: '',
  GFpath: '',
};

// PAS: GRGLOB.PAS Beep
export function Beep(): void {
  return notSupported('GRGLOB.Beep');
}
// PAS: GRGLOB.PAS BarFrame
export function BarFrame(qad: qadr): void {
  return notSupported('GRGLOB.BarFrame');
}
// PAS: GRGLOB.PAS Bar3Q
export function Bar3Q(x1: number, y1: number, x2: number, y2: number, z: number, zx: number, top: boolean): void {
  return notSupported('GRGLOB.Bar3Q');
}
// PAS: GRGLOB.PAS hod
export function hod(x: number, y: number, h: number, MaximumC: number, maxExp: number): void {
  return notSupported('GRGLOB.hod');
}
// PAS: GRGLOB.PAS co
export function co(c: number, B: str14): number {
  return notSupported('GRGLOB.co');
}
// PAS: GRGLOB.PAS promptstr
export function promptstr(Pis: str80, typt: str1, delka: number, zust: number, Def: str80): str80 {
  return notSupported('GRGLOB.promptstr');
}
// PAS: GRGLOB.PAS LeftUpCh
export function LeftUpCh(st: str80): str80 {
  return notSupported('GRGLOB.LeftUpCh');
}
// PAS: GRGLOB.PAS CursorOn
export function CursorOn(): void {
  return notSupported('GRGLOB.CursorOn');
}
// PAS: GRGLOB.PAS CursorOff
export function CursorOff(): void {
  return notSupported('GRGLOB.CursorOff');
}
// PAS: GRGLOB.PAS Nazev
export function Nazev(par: ComStr, parametr: ComStr): ComStr {
  return notSupported('GRGLOB.Nazev');
}
// PAS: GRGLOB.PAS ParRad
export function ParRad(Param: Parametry, Par3: Param3, Maxim: Maxima, GD: GraphDPtr): void {
  return notSupported('GRGLOB.ParRad');
}
// PAS: GRGLOB.PAS TxWPar
export function TxWPar(GD: GraphDPtr, stop: boolean): void {
  return notSupported('GRGLOB.TxWPar');
}
// PAS: GRGLOB.PAS StoreParWInTWork
export function StoreParWInTWork(): void {
  return notSupported('GRGLOB.StoreParWInTWork');
}
// PAS: GRGLOB.PAS ReadParWInTWork
export function ReadParWInTWork(): void {
  return notSupported('GRGLOB.ReadParWInTWork');
}
// PAS: GRGLOB.PAS DelParWInTWork
export function DelParWInTWork(): void {
  return notSupported('GRGLOB.DelParWInTWork');
}
// PAS: GRGLOB.PAS DelAllParWInTWork
export function DelAllParWInTWork(): void {
  return notSupported('GRGLOB.DelAllParWInTWork');
}
// PAS: GRGLOB.PAS ClrScrG
export function ClrScrG(Color: str14): void {
  return notSupported('GRGLOB.ClrScrG');
}
// PAS: GRGLOB.PAS RectToPix
export function RectToPix(
  c1: number, r1: number, c2: number, r2: number,
  x1: Ref<number>, y1: Ref<number>, x2: Ref<number>, y2: Ref<number>,
): void {
  return notSupported('GRGLOB.RectToPix');
}
// PAS: GRGLOB.PAS K
export function K(Size: number): number {
  return notSupported('GRGLOB.K');
}
// PAS: GRGLOB.PAS OutTextXYC
export function OutTextXYC(X: number, Y: number, str: string): void {
  return notSupported('GRGLOB.OutTextXYC');
}
// PAS: GRGLOB.PAS SetWindow
export function SetWindow(ViewPort: ViewPortType): void {
  return notSupported('GRGLOB.SetWindow');
}
// PAS: GRGLOB.PAS KonB
export function KonB(KP: str9): number {
  return notSupported('GRGLOB.KonB');
}
// PAS: GRGLOB.PAS ShowFrame
export function ShowFrame(Border: string): void {
  return notSupported('GRGLOB.ShowFrame');
}
// PAS: GRGLOB.PAS ShowShadow
export function ShowShadow(): void {
  return notSupported('GRGLOB.ShowShadow');
}
// PAS: GRGLOB.PAS ShowOnlyShadow
export function ShowOnlyShadow(c1: number, r1: number, c2: number, r2: number): void {
  return notSupported('GRGLOB.ShowOnlyShadow');
}
