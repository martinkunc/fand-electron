// PAS: FANDDML.PAS (unit FandDML) – client library linked into external Pascal programs that call
// a running FAND through DML. NOT PORTED (not part of the FAND executable).
//
// Porting notes:
// * asm/DOS: every routine pushes its parameters and far-calls _CallDML (address taken from the
//   'DMLADDR=' environment variable in _OpenDML); results come back in registers / on the stack.
// * It redeclares its own mirror types of BASE/ACCESS records (_FieldDescr, _FileD, _RdbD, _Inst_)
//   so a client could read FAND's memory directly; these are opaque here.
// * State: _searchParOfs, _keyFound, _CallDML, _inst -> FandDMLVars.

import { notSupported, type Pointer, type Ref } from './pasrt.ts';

export const f_Stored = 1; // FieldD flags
export const f_Encryp = 2;
export const f_Mask = 4;
export const f_Comma = 8;

export const _prUl1 = 1;
export const _prUl2 = 2;
export const _prKv1 = 3;
export const _prKv2 = 4;
export const _prBr1 = 5;
export const _prBr2 = 6;
export const _prDb1 = 7;
export const _prDb2 = 8;
export const _prBd1 = 9;
export const _prBd2 = 10;
export const _prKp1 = 11;
export const _prKp2 = 12;
export const _prEl1 = 13;
export const _prEl2 = 14;
export const _prReset = 15;
export const _prPageSizeNN = 16;
export const _prPageSizeTrail = 17;
export const _prLMarg = 18;
export const _prLMargTrail = 19;
export const _prUs11 = 20;
export const _prUs12 = 21;
export const _prUs21 = 22;
export const _prUs22 = 23;
export const _prUs31 = 24;
export const _prUs32 = 25;
export const _prLine72 = 26;
export const _prLine216 = 27;
export const _prDen60 = 28;
export const _prDen120 = 29;
export const _prDen240 = 30;
export const _prColor = 31;
export const _prClose = 32;

/** Opaque handles into the FAND process (Pascal ItemPtr/FilePtr/RdbDPtr/FrmlPtr). */
export type ItemPtr = Pointer;
export type FilePtr = Pointer;
export type RdbDPtr = Pointer;
export type FrmlPtr = Pointer;
export type FileUseMode = number;

export const FandDMLVars = {
  _searchParOfs: 0,
  _keyFound: false,
  _CallDML: null as Pointer,
  _inst: null as Pointer,
};

// PAS: FANDDML.PAS _OpenDML
export function _OpenDML(UserHeapSize: number): void {
  return notSupported('FANDDML._OpenDML');
}
// PAS: FANDDML.PAS _file
export function _file(Name: string): FilePtr {
  return notSupported('FANDDML._file');
}
// PAS: FANDDML.PAS _resetm
export function _resetm(F: FilePtr, UseMode: FileUseMode): void {
  return notSupported('FANDDML._resetm');
}
// PAS: FANDDML.PAS _reset
export function _reset(F: FilePtr): void {
  return notSupported('FANDDML._reset');
}
// PAS: FANDDML.PAS _rewrite
export function _rewrite(F: FilePtr): void {
  return notSupported('FANDDML._rewrite');
}
// PAS: FANDDML.PAS _close
export function _close(F: FilePtr): void {
  return notSupported('FANDDML._close');
}
// PAS: FANDDML.PAS _item
export function _item(F: FilePtr, Name: string): ItemPtr {
  return notSupported('FANDDML._item');
}
// PAS: FANDDML.PAS _seek
export function _seek(F: FilePtr, N: number): void {
  return notSupported('FANDDML._seek');
}
// PAS: FANDDML.PAS _indexseek
export function _indexseek(F: FilePtr, Alias: string, N: number): void {
  return notSupported('FANDDML._indexseek');
}
// PAS: FANDDML.PAS _deleterec
export function _deleterec(F: FilePtr): void {
  return notSupported('FANDDML._deleterec');
}
// PAS: FANDDML.PAS _recallrec
export function _recallrec(F: FilePtr): void {
  return notSupported('FANDDML._recallrec');
}
// PAS: FANDDML.PAS _filesize
export function _filesize(F: FilePtr): number {
  return notSupported('FANDDML._filesize');
}
// PAS: FANDDML.PAS _filepos
export function _filepos(F: FilePtr): number {
  return notSupported('FANDDML._filepos');
}
// PAS: FANDDML.PAS _eof
export function _eof(F: FilePtr): boolean {
  return notSupported('FANDDML._eof');
}
// PAS: FANDDML.PAS _read
export function _read(F: FilePtr): void {
  return notSupported('FANDDML._read');
}
// PAS: FANDDML.PAS _write
export function _write(F: FilePtr): void {
  return notSupported('FANDDML._write');
}
// PAS: FANDDML.PAS _s
export function _s(F: FilePtr, I: ItemPtr): string {
  return notSupported('FANDDML._s');
}
// PAS: FANDDML.PAS _r
export function _r(F: FilePtr, I: ItemPtr): number {
  return notSupported('FANDDML._r');
}
// PAS: FANDDML.PAS _b
export function _b(F: FilePtr, I: ItemPtr): boolean {
  return notSupported('FANDDML._b');
}
// PAS: FANDDML.PAS _t
export function _t(Arr: Uint8Array, Len: Ref<number>, MaxLen: number, F: FilePtr, I: ItemPtr): void {
  return notSupported('FANDDML._t');
}
// PAS: FANDDML.PAS _deleted
export function _deleted(F: FilePtr): boolean {
  return notSupported('FANDDML._deleted');
}
// PAS: FANDDML.PAS s_
export function s_(F: FilePtr, I: ItemPtr, S: string): void {
  return notSupported('FANDDML.s_');
}
// PAS: FANDDML.PAS r_
export function r_(F: FilePtr, I: ItemPtr, R: number): void {
  return notSupported('FANDDML.r_');
}
// PAS: FANDDML.PAS b_
export function b_(F: FilePtr, I: ItemPtr, B: boolean): void {
  return notSupported('FANDDML.b_');
}
// PAS: FANDDML.PAS t_
export function t_(Arr: Uint8Array, Len: number, F: FilePtr, I: ItemPtr): void {
  return notSupported('FANDDML.t_');
}
// PAS: FANDDML.PAS _setkey
export function _setkey(F: FilePtr, Alias: string): void {
  return notSupported('FANDDML._setkey');
}
// PAS: FANDDML.PAS PushReal
export function PushReal(R: number): void {
  return notSupported('FANDDML.PushReal');
}
// PAS: FANDDML.PAS PushBoolean
export function PushBoolean(B: boolean): void {
  return notSupported('FANDDML.PushBoolean');
}
// PAS: FANDDML.PAS PushString
export function PushString(S: string): void {
  return notSupported('FANDDML.PushString');
}
// PAS: FANDDML.PAS _searchkey
export function _searchkey(): void {
  return notSupported('FANDDML._searchkey');
}
// PAS: FANDDML.PAS _indexpos
export function _indexpos(): number {
  return notSupported('FANDDML._indexpos');
}
// PAS: FANDDML.PAS _keylink
export function _keylink(F: FilePtr, Name: string): void {
  return notSupported('FANDDML._keylink');
}
// PAS: FANDDML.PAS _save
export function _save(): void {
  return notSupported('FANDDML._save');
}
// PAS: FANDDML.PAS _newfilesize
export function _newfilesize(F: FilePtr, N: number): void {
  return notSupported('FANDDML._newfilesize');
}
// PAS: FANDDML.PAS _fandmsg
export function _fandmsg(N: number, Par1: string | null, Par2: string | null): void {
  return notSupported('FANDDML._fandmsg');
}
// PAS: FANDDML.PAS _strdate
export function _strdate(R: number, Mask: string): string {
  return notSupported('FANDDML._strdate');
}
// PAS: FANDDML.PAS _valdate
export function _valdate(S: string, Mask: string): number {
  return notSupported('FANDDML._valdate');
}
// PAS: FANDDML.PAS _menu
export function _menu(Header: string, MenuTxt: string): number {
  return notSupported('FANDDML._menu');
}
// PAS: FANDDML.PAS _f10message
export function _f10message(Text: string): void {
  return notSupported('FANDDML._f10message');
}
// PAS: FANDDML.PAS _prompts
export function _prompts(Text: string, Typ: string, L: number, M: number): string {
  return notSupported('FANDDML._prompts');
}
// PAS: FANDDML.PAS _promptr
export function _promptr(Text: string, Typ: string, L: number, M: number, Mask: string): number {
  return notSupported('FANDDML._promptr');
}
// PAS: FANDDML.PAS _promptb
export function _promptb(Text: string): boolean {
  return notSupported('FANDDML._promptb');
}
// PAS: FANDDML.PAS _mountvol
export function _mountvol(Vol: string, Drive: string): void {
  return notSupported('FANDDML._mountvol');
}
// PAS: FANDDML.PAS _CRdb
export function _CRdb(): RdbDPtr {
  return notSupported('FANDDML._CRdb');
}
// PAS: FANDDML.PAS _StoreAvail
export function _StoreAvail(): number {
  return notSupported('FANDDML._StoreAvail');
}
// PAS: FANDDML.PAS _GetStore
export function _GetStore(Size: number): Pointer {
  return notSupported('FANDDML._GetStore');
}
// PAS: FANDDML.PAS _ReleaseStore
export function _ReleaseStore(P: Pointer): void {
  return notSupported('FANDDML._ReleaseStore');
}
// PAS: FANDDML.PAS _RdFrml
export function _RdFrml(
  S: string, FD: FilePtr, Z: Ref<FrmlPtr>, FTyp: Ref<string>, WasError: Ref<boolean>, Pos: Ref<number>,
): string {
  return notSupported('FANDDML._RdFrml');
}
// PAS: FANDDML.PAS _RunReal
export function _RunReal(Z: FrmlPtr, FD: FilePtr): number {
  return notSupported('FANDDML._RunReal');
}
// PAS: FANDDML.PAS _RunStr
export function _RunStr(Z: FrmlPtr, FD: FilePtr): string {
  return notSupported('FANDDML._RunStr');
}
// PAS: FANDDML.PAS _RunBool
export function _RunBool(Z: FrmlPtr, FD: FilePtr): boolean {
  return notSupported('FANDDML._RunBool');
}
// PAS: FANDDML.PAS _PrTab
export function _PrTab(N: number): string {
  return notSupported('FANDDML._PrTab');
}
