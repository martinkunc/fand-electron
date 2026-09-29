// PAS: IPX.PAS – include of CHANNEL ({$I ipx}): IPX / packet-driver transport. NOT PORTED.
//
// Porting notes:
// * Only reachable with FandSQL (off). Pure asm/DOS: IPXExists scans interrupt vectors $60..$80
//   for 'IPX EMUL' and patches `int 0` in intrpt; OpenSocket/CloseSocket/Listen/SendBlock call
//   that interrupt with ECBs; ListenPostProc/SendPostProc are ESR callbacks at interrupt time.
// * State (private to CHANNEL): SndIpxBlk, RcvIpxBlk, SndEcb, RcvEcb, MySckt, UsrPostProc, flag.

import { notSupported, type Pointer } from './pasrt.ts';

export const BroadcastWaitTime = 18;
export const MaxConnectRetry = 4;
export const BLOCK_SIZE = 1514; // IPX = 576, FTP ODIPKT = 1514
export const BlkHeadSz = 42; // IPX = 30, UDP = 42

// PAS: IPX.PAS PROTOpkt – packet header (eth, ip, udp) + Data / ConnectErr
export class PROTOpkt {
  Raw = new Uint8Array(BLOCK_SIZE);
}
// PAS: IPX.PAS PROTOcb – protocol control block (ECB)
export class PROTOcb {
  Link: Pointer = null;
  ESRAddr: Pointer = null;
  InUse = 0;
  ComplCode = 0;
  Sckt = 0;
  Length = 0;
  Filler = new Uint8Array(20);
  FragCnt = 0;
  FragAddr: Pointer = null;
  FragSize = 0;
}
// PAS: IPX.PAS TUserPostProc
export type TUserPostProc = ((FormSend: boolean, Blk: Uint8Array, Len: number, Err: number) => void) | null;

// PAS: IPX.PAS IPXExists
export function IPXExists(): boolean {
  return notSupported('CHANNEL.IPXExists');
}
// PAS: IPX.PAS OpenSocket
export function OpenSocket(): boolean {
  return notSupported('CHANNEL.OpenSocket');
}
// PAS: IPX.PAS CloseSocket
export function CloseSocket(): void {
  return notSupported('CHANNEL.CloseSocket');
}
// PAS: IPX.PAS Listen
export function Listen(): void {
  return notSupported('CHANNEL.Listen');
}
// PAS: IPX.PAS SendBlock
export function SendBlock(Buf: Uint8Array | null, Len: number): void {
  return notSupported('CHANNEL.SendBlock');
}
// PAS: IPX.PAS Connect – 0 or error 2000..2002 / server ConnectErr
export function Connect(aUsrPostProc: TUserPostProc): number {
  return notSupported('CHANNEL.Connect');
}
// PAS: IPX.PAS DisConnect
export function DisConnect(): void {
  return notSupported('CHANNEL.DisConnect');
}
