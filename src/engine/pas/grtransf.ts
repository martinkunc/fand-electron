// PAS: GRTRANSF.PAS – moving/inverting graphic windows, PCX show/save. NOT PORTED.
//
// Porting notes:
// * Not compiled in the FPC build ({$ifdef FandGraph} is off): typed stubs calling notSupported.
// * asm/DOS: direct EGA/VGA plane access, DAC registers (int $10), 256-colour mode 13h detection.
// * State: the sh_* variables (Tshpcx decoder – file, window/picture geometry, RLE state, line
//   buffers) are interface variables -> GrTransfVars; the sh_* routines are its methods in Pascal
//   (commented-out OBJECT) and interface procedures here.

import { notSupported } from './pasrt.ts';

// PAS: GRTRANSF.PAS TPL – one screen line, 4 bit planes
export type TPL = (Uint8Array | null)[]; // [1..4]
// PAS: GRTRANSF.PAS TL – one bit plane of a line
export type TL = Uint8Array;
// PAS: GRTRANSF.PAS TLinesOff
export type TLinesOff = number[];

// masks for drawing at the picture edges
export const fbits = [0xff, 0x7f, 0x3f, 0x1f, 0x0f, 0x07, 0x03, 0x01];
export const ebits = [0x80, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc, 0xfe, 0xff];

export const HOMEKEY = 0x47; // key codes
export const ARROWUP = 0x48;
export const PAGEUP = 0x49;
export const ARROWDOWN = 0x50;
export const PAGEDOWN = 0x51;
export const ARROWLEFT = 0x4b;
export const ARROWRIGHT = 0x4d;
export const ENDKEY = 0x4f;
export const ESC = 0x1b;
export const ENTER = 0xd;
export const St_Up = 16; // window move steps
export const St_Down = 16;
export const St_Right = 24; // multiples of 8 only
export const St_Left = 24;

export const GrTransfVars = {
  sh_fp: null as number | null, // file
  sh_grDriver: 0,
  sh_Xwo: 0,
  sh_Ywo: 0,
  sh_Ww: 0,
  sh_Hw: 0,
  sh_Xfo: 0,
  sh_Yfo: 0,
  sh_Wf: 0,
  sh_Hf: 0,
  sh_LinesOff: null as TLinesOff | null,
  sh_LineBeg: 0,
  sh_fbuf: new Uint8Array(80),
  sh_pbuf: 0,
  sh_count: 0,
  sh_value: 0,
  sh_fBPL: 0,
  sh_fbPP: 0,
  sh_fPlanes: 0,
  sh_bMode13: false,
  sh_fb: 0,
  sh_fBt: 0,
  sh_eb: 0,
  sh_eBt: 0,
  sh_buf: 0,
  sh_PtrE: 0,
  sh_PL: [] as TPL, // [1..4]
  sh_actPlane: 0,
  sh_actByte: 0,
  sh_ScrDelay: 0,
};

// PAS: GRTRANSF.PAS MovePict
export function MovePict(x: number, y: number, w: number, h: number, xn: number, yn: number): void {
  return notSupported('GRTRANSF.MovePict');
}
// PAS: GRTRANSF.PAS Inverze
export function Inverze(x1: number, y1: number, x2: number, y2: number): void {
  return notSupported('GRTRANSF.Inverze');
}
// PAS: GRTRANSF.PAS InverzeWin
export function InverzeWin(): void {
  return notSupported('GRTRANSF.InverzeWin');
}
// PAS: GRTRANSF.PAS GrayWin
export function GrayWin(): void {
  return notSupported('GRTRANSF.GrayWin');
}
// PAS: GRTRANSF.PAS IsMode256Col
export function IsMode256Col(): boolean {
  return notSupported('GRTRANSF.IsMode256Col');
}
// PAS: GRTRANSF.PAS IsDACRegisters
export function IsDACRegisters(): boolean {
  return notSupported('GRTRANSF.IsDACRegisters');
}
// PAS: GRTRANSF.PAS ShowPCX – 0 ok, 1 cannot open, 2 not PCX, 3 VGA 256 colours only
export function ShowPCX(NameFile: string): number {
  return notSupported('GRTRANSF.ShowPCX');
}
// PAS: GRTRANSF.PAS ShowPCXAt
export function ShowPCXAt(NameFile: string, x1: number, y1: number, x2: number, y2: number): number {
  return notSupported('GRTRANSF.ShowPCXAt');
}
// PAS: GRTRANSF.PAS SavePCX – 0 ok, 1 cannot write
export function SavePCX(NameFile: string): number {
  return notSupported('GRTRANSF.SavePCX');
}
// PAS: GRTRANSF.PAS sh_Init
export function sh_Init(NameFile: string, x: number, y: number, w: number, h: number): number {
  return notSupported('GRTRANSF.sh_Init');
}
// PAS: GRTRANSF.PAS sh_CheckWinSize
export function sh_CheckWinSize(x: number, y: number, w: number, h: number): void {
  return notSupported('GRTRANSF.sh_CheckWinSize');
}
// PAS: GRTRANSF.PAS sh_SetFbuf
export function sh_SetFbuf(): void {
  return notSupported('GRTRANSF.sh_SetFbuf');
}
// PAS: GRTRANSF.PAS sh_GetByte
export function sh_GetByte(): number {
  return notSupported('GRTRANSF.sh_GetByte');
}
// PAS: GRTRANSF.PAS sh_StartShow
export function sh_StartShow(): void {
  return notSupported('GRTRANSF.sh_StartShow');
}
// PAS: GRTRANSF.PAS sh_ReadLine
export function sh_ReadLine(): void {
  return notSupported('GRTRANSF.sh_ReadLine');
}
// PAS: GRTRANSF.PAS sh_ReadLineNo
export function sh_ReadLineNo(line: number): void {
  return notSupported('GRTRANSF.sh_ReadLineNo');
}
// PAS: GRTRANSF.PAS sh_ShowLine
export function sh_ShowLine(Xscreen: number, Yscreen: number, Xfile: number, w: number): void {
  return notSupported('GRTRANSF.sh_ShowLine');
}
// PAS: GRTRANSF.PAS sh_Loop
export function sh_Loop(): void {
  return notSupported('GRTRANSF.sh_Loop');
}
// PAS: GRTRANSF.PAS sh_ReadShow
export function sh_ReadShow(x: number, y: number, w: number, h: number, xs: number, ys: number): void {
  return notSupported('GRTRANSF.sh_ReadShow');
}
// PAS: GRTRANSF.PAS sh_outbyte
export function sh_outbyte(): number {
  return notSupported('GRTRANSF.sh_outbyte');
}
// PAS: GRTRANSF.PAS sh_InitBuf
export function sh_InitBuf(Xfile: number): void {
  return notSupported('GRTRANSF.sh_InitBuf');
}
