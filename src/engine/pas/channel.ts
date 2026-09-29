// PAS: CHANNEL.PAS (unit Channel) – LAN streams to the FAND SQL server over IPX/UDP. NOT PORTED.
//
// Porting notes:
// * Compiled only with {$ifdef FandSQL}, which is off (SWITCHES.PAS); typed stubs that call
//   notSupported so the SQL branches of other units type-check.
// * CHNNEL.PAS is an older copy of the same unit (unit Channel: MaxBlkSz 546, fixed ErrText,
//   no PutText/PutData) – this module stands for both.
// * asm/DOS: everything – IPX driver calls (IPX.PAS, included here -> ipx.ts), interrupt-time
//   post procedures (MpxPost), `asm pushf; sti` critical sections, BIOS Timer polling.
// * State: Strm1, nStreams (typed constants) -> ChannelVars; private StreamTab, Mpx* queue, AckBlk.

import { notSupported, type Pointer, type Ref } from './pasrt.ts';
import type { FieldDPtr, FrmlPtr, KeyDPtr, KeyFldDPtr, KeyInDPtr, XStringPtr } from './access.ts';
import type { LongStrPtr } from './base.ts';

// PAS: CHANNEL.PAS LANStream
export class LANStream {
  StreamNr = 0;
  SequNr = 0;
  Buf: Pointer = null;
  Buf2: Pointer = null;
  Requ: Pointer = null;
  iBuf = 0;
  Busy = false;
  RequWait = false;
  Receiving = false;
  EndTime = 0;

  // PAS: CHANNEL.PAS LANStream.Init
  Init(): this {
    return notSupported('CHANNEL.LANStream.Init');
  }
  // PAS: CHANNEL.PAS LANStream.Done
  Done(): void {
    return notSupported('CHANNEL.LANStream.Done');
  }
  // PAS: CHANNEL.PAS LANStream.Write
  Write(P: Uint8Array, L: number): void {
    return notSupported('CHANNEL.LANStream.Write');
  }
  // PAS: CHANNEL.PAS LANStream.Flush
  Flush(): void {
    return notSupported('CHANNEL.LANStream.Flush');
  }
  // PAS: CHANNEL.PAS LANStream.Read
  Read(P: Uint8Array, L: number): void {
    return notSupported('CHANNEL.LANStream.Read');
  }
  // PAS: CHANNEL.PAS LANStream.AtEnd
  AtEnd(): boolean {
    return notSupported('CHANNEL.LANStream.AtEnd');
  }
  // PAS: CHANNEL.PAS LANStream.Terminate
  Terminate(): void {
    return notSupported('CHANNEL.LANStream.Terminate');
  }
  // PAS: CHANNEL.PAS LANStream.Send
  Send(): void {
    return notSupported('CHANNEL.LANStream.Send');
  }
  // PAS: CHANNEL.PAS LANStream.Listen
  Listen(Blk: Uint8Array, L: number, Err: Ref<number>): void {
    return notSupported('CHANNEL.LANStream.Listen');
  }
  // PAS: CHANNEL.PAS LANStream.ReceiveWait
  ReceiveWait(): void {
    return notSupported('CHANNEL.LANStream.ReceiveWait');
  }
}
export type LANStreamPtr = LANStream | null;

// PAS: CHANNEL.PAS SQLStream
export class SQLStream extends LANStream {
  // PAS: CHANNEL.PAS SQLStream.Login
  Login(UserName: string, Password: string): void {
    return notSupported('CHANNEL.SQLStream.Login');
  }
  // PAS: CHANNEL.PAS SQLStream.SelectXRec
  SelectXRec(K: KeyDPtr, X: XStringPtr, CompOp: string, WithT: boolean): boolean {
    return notSupported('CHANNEL.SQLStream.SelectXRec');
  }
  // PAS: CHANNEL.PAS SQLStream.DeleteXRec
  DeleteXRec(K: KeyDPtr, X: XStringPtr, Ad: boolean): void {
    return notSupported('CHANNEL.SQLStream.DeleteXRec');
  }
  // PAS: CHANNEL.PAS SQLStream.UpdateXRec
  UpdateXRec(K: KeyDPtr, X: XStringPtr, Ad: boolean): boolean {
    return notSupported('CHANNEL.SQLStream.UpdateXRec');
  }
  // PAS: CHANNEL.PAS SQLStream.UpdateXFld
  UpdateXFld(K: KeyDPtr, X: XStringPtr, F: FieldDPtr): void {
    return notSupported('CHANNEL.SQLStream.UpdateXFld');
  }
  // PAS: CHANNEL.PAS SQLStream.InsertRec
  InsertRec(Ad: boolean, Cancel: boolean): boolean {
    return notSupported('CHANNEL.SQLStream.InsertRec');
  }
  // PAS: CHANNEL.PAS SQLStream.ReadTFld
  ReadTFld(K: KeyDPtr, X: XStringPtr, F: FieldDPtr): void {
    return notSupported('CHANNEL.SQLStream.ReadTFld');
  }
  // PAS: CHANNEL.PAS SQLStream.WriteTFld
  WriteTFld(K: KeyDPtr, X: XStringPtr, F: FieldDPtr): void {
    return notSupported('CHANNEL.SQLStream.WriteTFld');
  }
  // PAS: CHANNEL.PAS SQLStream.SendTxt
  SendTxt(S: LongStrPtr, Cancel: boolean): number {
    return notSupported('CHANNEL.SQLStream.SendTxt');
  }
  // PAS: CHANNEL.PAS SQLStream.DefKeyAcc
  DefKeyAcc(K: KeyDPtr): void {
    return notSupported('CHANNEL.SQLStream.DefKeyAcc');
  }
  // PAS: CHANNEL.PAS SQLStream.KeyAcc
  KeyAcc(K: KeyDPtr, X: XStringPtr): boolean {
    return notSupported('CHANNEL.SQLStream.KeyAcc');
  }
  // PAS: CHANNEL.PAS SQLStream.EndKeyAcc
  EndKeyAcc(K: KeyDPtr): void {
    return notSupported('CHANNEL.SQLStream.EndKeyAcc');
  }
  // PAS: CHANNEL.PAS SQLStream.InpResetTxt
  InpResetTxt(S: LongStrPtr): void {
    return notSupported('CHANNEL.SQLStream.InpResetTxt');
  }
  // PAS: CHANNEL.PAS SQLStream.InpReset
  InpReset(K: KeyDPtr, SK: KeyFldDPtr, KI: KeyInDPtr, Filter: FrmlPtr, WithT: boolean): void {
    return notSupported('CHANNEL.SQLStream.InpReset');
  }
  // PAS: CHANNEL.PAS SQLStream.GetRec
  GetRec(): boolean {
    return notSupported('CHANNEL.SQLStream.GetRec');
  }
  // PAS: CHANNEL.PAS SQLStream.InpClose
  InpClose(): void {
    return notSupported('CHANNEL.SQLStream.InpClose');
  }
  // PAS: CHANNEL.PAS SQLStream.OutpRewrite
  OutpRewrite(Append: boolean): void {
    return notSupported('CHANNEL.SQLStream.OutpRewrite');
  }
  // PAS: CHANNEL.PAS SQLStream.PutRec
  PutRec(): void {
    return notSupported('CHANNEL.SQLStream.PutRec');
  }
  // PAS: CHANNEL.PAS SQLStream.OutpClose
  OutpClose(): void {
    return notSupported('CHANNEL.SQLStream.OutpClose');
  }
}
export type SQLStreamPtr = SQLStream | null;

export const ChannelVars = {
  Strm1: null as SQLStreamPtr,
  nStreams: 0,
};

// PAS: CHANNEL.PAS SQLConnect
export function SQLConnect(): void {
  return notSupported('CHANNEL.SQLConnect');
}
// PAS: CHANNEL.PAS SQLDisconnect
export function SQLDisconnect(): void {
  return notSupported('CHANNEL.SQLDisconnect');
}
// PAS: CHANNEL.PAS ShutDownStreams
export function ShutDownStreams(N: number): void {
  return notSupported('CHANNEL.ShutDownStreams');
}
