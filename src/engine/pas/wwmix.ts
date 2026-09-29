// PAS: WWMIX.PAS – selection lists (PutSelect/SelectStr/GetSelect), field-list selection, disk file
// selection, filter and last-line prompts, passwords.
//
// Porting notes:
// * asm/DOS: Ovr (no-op). SelectDiskFile uses DOS FindFirst/FindNext with DosError 0/18 and the
//   directory separator ('\' in BP7, DirectorySeparator in FPC) -> node:fs readdir via UnixPath;
//   directories are listed as '\NAME' (host separator in FPC), '..' walks up.
// * Key global state: WwMixVars.ss (the interface record: PointTo, Abcd, AscDesc, Subset, ImplAll,
//   Empty, Size, Tag). Private: sv (ItemRoot, markp, NItems, MaxItemLen, Tabs, TabSize, WwSize, Base,
//   iItem) and the item list (Item: Chain, Tag, S up to 46 chars). PutSelect on an empty list resets
//   sv and `FillChar(ss.Abcd, sizeof(ss)-5, 0)` = every ss field after PointTo.
// * Tricky parts:
//   - SelectStr: multi-column window sized from the item count/width, cursor keys, mouse, first
//     letter search, Subset mode with tags (SelMark = #$F0 marks pre-selected / non-stored items,
//     '+'/'-' toggles, Ins/Grey +/- all), GraspAndMove (reorder with AscDesc), Abcd (alphabetic
//     sort by AbcdSort). GetSelect returns the next selected item (tag in ss.Tag) and frees it.
//   - PromptFilter: compiles the typed condition (RdBool) under NewExit (PORTING.md 11); on a
//     compile error shows message 110 with the error position and prompts again.
//   - PassWord: TwoTimes asks again (messages 628/637/638); input is starred (EditTxt star=true).
//   - Passwords (SetPassword/HasPassword) live in the T-file header PwCode/Pw2Code, 20 bytes padded
//     with '@' and scrambled with Code (fand/coding.ts XOR) - on-disk format, must match BP7.
//   - FPC deviation: HasPasswordAuth accepts an empty password for Nr 1/2 unconditionally. That
//     bypasses the task password; BP7 wins (plain HasPassword).

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import {
  GoExitSignal, TxtWrite, Output, ref, fref, chr, ord, ShortStr, Copy, Pos, FSplit, DirectorySeparator, ToUnicode,
  FromUnicode, type Ref, type Pointer, type PathStr, type DirStr, type NameStr, type ExtStr,
} from './pasrt.ts';
import {
  BaseVars, ExitRecord, RdMsg, SetMsgPar, ChainLast, MinW, MaxW, MarkStore, ReleaseStore, NewExit,
  RestoreExit, UnixPath, WHasFrame, WDoubleFrame, WShadow, WPushPixel, type StringPtr,
} from './base.ts';
import { DosView, DosFExpand, GetDirDos, HostToDos } from './handle.ts';
import {
  AccessVars, FieldListEl, CompLexStr, Code, ResetCompilePars, _gt, type FieldList, type FileDPtr, type FrmlPtr,
  type FieldDPtr,
} from './access.ts';
import {
  DriversVars, GotoXY, WhereX, ClrEol, ScrWrChar, GetEvent, ClrEvent, ReadKbd, evMouseMove, evMouseDown,
  evMouseUp, evKeyDown, mbDoubleClick, _M_, _ESC_, _left_, _right_, _up_, _down_, _PgUp_, _PgDn_, _Z_, _W_,
  _CtrlPgUp_, _CtrlPgDn_, _Home_, _End_, _F2_, _CtrlF2_, _F3_, _CtrlF3_, _F9_, _EOF,
} from './drivers.ts';
import { PushScr, PopScr, PushW, PushWFramed, PopW, WrLLMsg, WrLLF10Msg } from './obaseww.ts';
import { SetInpStr, RdLex, RdBool, Error } from './compile.ts';
import { TrailChar } from './runfrml.ts';
import { EditTxt } from './runedi.ts';
import { FandMaskMatch } from './fanddos.ts';

export const SelMark = '\xf0';

// PAS: WWMIX.PAS ss – selection options and results
export class SelectOpts {
  PointTo: StringPtr = null; // (nil) at beginning point to this item
  Abcd = false; // alphabetical order in window
  AscDesc = false; // > ascending, < descending
  Subset = false;
  ImplAll = false; // implic. the whole set
  Empty = false; // returned, test before calling SelectStr
  Size = 0; // returned, subset size after SelectStr
  Tag = '\x00'; // returned for each GetSelect
}

export const WwMixVars = {
  ss: new SelectOpts(),
};

// PAS: WWMIX.PAS Item (implementation type)
class Item {
  Chain: ItemPtr = null;
  Tag = ' ';
  S = '';
}
type ItemPtr = Item | null;

// PAS: WWMIX.PAS sv (implementation variable)
const sv = {
  ItemRoot: null as ItemPtr,
  markp: null as Pointer,
  NItems: 0,
  MaxItemLen: 0,
  Tabs: 0,
  TabSize: 0,
  WwSize: 0,
  Base: 0,
  iItem: 0,
};

/** TS-only: `ItemPtr(@sv.ItemRoot)` – a pseudo item whose Chain is sv.ItemRoot. */
function RootItem(): Item {
  const r = new Item();
  Object.defineProperty(r, 'Chain', {
    get: () => sv.ItemRoot,
    set: (v: ItemPtr) => {
      sv.ItemRoot = v;
    },
  });
  return r;
}

/** TS-only: write(...) to the CRT (System.Output). */
function write(...S: string[]): void {
  TxtWrite(Output, ...S);
}

// PAS: WWMIX.PAS Ovr (overlay fix-up; FPC: empty)
function Ovr(): void {}

// PAS: WWMIX.PAS PutSelect
export function PutSelect(s: string): void {
  const ss = WwMixVars.ss;
  const l = MinW(s.length, 46);
  const p = new Item();
  p.Tag = ' ';
  p.S = s.slice(0, l);
  if (ss.Empty) {
    sv.ItemRoot = null;
    sv.markp = null;
    sv.NItems = 0;
    sv.MaxItemLen = 0;
    sv.Tabs = 0;
    sv.TabSize = 0;
    sv.WwSize = 0;
    sv.Base = 0;
    sv.iItem = 0;
    // FillChar(ss.Abcd, sizeof(ss)-5, #0): every field after PointTo
    ss.Abcd = false;
    ss.AscDesc = false;
    ss.Subset = false;
    ss.ImplAll = false;
    ss.Empty = false;
    ss.Size = 0;
    ss.Tag = '\0';
    sv.markp = p;
  }
  ChainLast(fref(sv, 'ItemRoot'), p);
  sv.NItems++;
  sv.MaxItemLen = MaxW(l, sv.MaxItemLen);
}

// PAS: WWMIX.PAS GetItem (private)
function GetItem(N: number): Item {
  let p = sv.ItemRoot!;
  for (let i = 2; i <= N; i++) p = p.Chain!;
  return p;
}

// PAS: WWMIX.PAS SelectStr
export function SelectStr(C1: number, R1: number, NMsg: number, LowTxt: string): void {
  const ss = WwMixVars.ss;
  const dv = DriversVars;
  const colors = BaseVars.Colors;

  function WriteItem(N: number): void {
    const i = N - sv.Base;
    GotoXY((i % sv.Tabs) * sv.TabSize + 2, Math.trunc(i / sv.Tabs) + 1);
    let l: number;
    if (N > sv.NItems) l = sv.TabSize - 2;
    else {
      const p = GetItem(N);
      if (ss.Subset) write(p.Tag);
      write(p.S);
      l = sv.MaxItemLen - p.S.length;
    }
    if (l > 0) write(' '.repeat(l));
  }
  function SetAttr(Attr: number): void {
    dv.TextAttr = Attr;
    WriteItem(sv.iItem);
  }
  function IVOn(): void {
    dv.TextAttr = colors.sHili;
    WriteItem(sv.iItem);
  }
  function IVOff(): void {
    dv.TextAttr = colors.sNorm;
    WriteItem(sv.iItem);
  }
  function DisplWw(): void {
    dv.TextAttr = colors.sNorm;
    const max = sv.Base + sv.WwSize - 1;
    let c = sv.Base > 1 ? '\x18' : ' ';
    ScrWrChar(dv.WindMin.X, dv.WindMin.Y, c, dv.TextAttr);
    c = max >= sv.NItems ? ' ' : '\x19';
    ScrWrChar(dv.WindMax.X, dv.WindMax.Y, c, dv.TextAttr);
    for (let i = sv.Base; i <= max; i++) WriteItem(i);
    SetAttr(colors.sHili);
  }
  function Right(): void {
    if (sv.iItem < sv.NItems) {
      IVOff();
      sv.iItem++;
      if (sv.iItem >= sv.Base + sv.WwSize) {
        sv.Base += sv.Tabs;
        DisplWw();
      } else IVOn();
    }
  }
  function Left(): void {
    if (sv.iItem > 1) {
      IVOff();
      sv.iItem--;
      if (sv.iItem < sv.Base) {
        sv.Base -= sv.Tabs;
        DisplWw();
      } else IVOn();
    }
  }
  function Down(): void {
    if (sv.iItem + sv.Tabs <= sv.NItems) {
      IVOff();
      sv.iItem += sv.Tabs;
      if (sv.iItem >= sv.Base + sv.WwSize) {
        sv.Base += sv.Tabs;
        DisplWw();
      } else IVOn();
    }
  }
  function Up(): void {
    if (sv.iItem > sv.Tabs) {
      IVOff();
      sv.iItem -= sv.Tabs;
      if (sv.iItem < sv.Base) {
        sv.Base -= sv.Tabs;
        DisplWw();
      } else IVOn();
    }
  }
  function SetTag(c: string): void {
    const p = GetItem(sv.iItem);
    p.Tag = c;
    dv.TextAttr = colors.sHili;
    WriteItem(sv.iItem);
    Right();
  }
  function SetAllTags(c: string): void {
    let p = sv.ItemRoot;
    while (p !== null) {
      p.Tag = c;
      p = p.Chain;
    }
    DisplWw();
  }
  function Switch(I1: number, I2: number): void {
    let p1: Item = RootItem();
    for (let i = 2; i <= I1; i++) p1 = p1.Chain!;
    const q1 = p1.Chain!;
    let p2: Item = RootItem();
    for (let i = 2; i <= I2; i++) p2 = p2.Chain!;
    const q2 = p2.Chain!;
    const h = q1.Chain;
    p1.Chain = q2;
    q1.Chain = q2.Chain;
    if (p2 === q1) q2.Chain = q1;
    else {
      q2.Chain = h;
      p2.Chain = q1;
    }
  }
  function GraspAndMove(schar: string): void {
    const p = GetItem(sv.iItem);
    if (p.Tag === ' ') p.Tag = schar;
    SetAttr(colors.sHili + 0x80);
    const A = colors.sHili;
    colors.sHili = (colors.sHili + 0x80) & 0xff;
    for (;;) {
      switch (ReadKbd()) {
        case _left_:
          if (sv.iItem > 1) {
            Switch(sv.iItem - 1, sv.iItem);
            Left();
          }
          break;
        case _right_:
          if (sv.iItem < sv.NItems) {
            Switch(sv.iItem, sv.iItem + 1);
            Right();
          }
          break;
        case _down_:
          if (sv.iItem + sv.Tabs <= sv.NItems) {
            Switch(sv.iItem, sv.iItem + sv.Tabs);
            Down();
          }
          break;
        case _up_:
          if (sv.iItem > sv.Tabs) {
            Switch(sv.iItem - sv.Tabs, sv.iItem);
            Up();
          }
          break;
        case _F9_:
        case _ESC_:
          colors.sHili = A;
          SetAttr(A);
          return;
      }
    }
  }
  function AbcdSort(): void {
    let sorted: boolean;
    do {
      let r: Item = RootItem();
      let p = sv.ItemRoot!;
      let q = p.Chain;
      sorted = true;
      while (q !== null) {
        if (CompLexStr(p.S, q.S) === ord(_gt)) {
          r.Chain = q;
          p.Chain = q.Chain;
          q.Chain = p;
          r = q;
          q = p.Chain;
          sorted = false;
        } else {
          r = p;
          p = q;
          q = q.Chain;
        }
      }
    } while (!sorted);
  }
  function SetFirstiItem(): void {
    sv.iItem = 1;
    if (ss.PointTo === null) return;
    let p = sv.ItemRoot;
    while (p !== null) {
      if (p.S === ss.PointTo) return;
      sv.iItem++;
      p = p.Chain;
    }
  }
  function MouseInItem(I: Ref<number>): boolean {
    const ev = dv.Event;
    const x = ev.Where.X - dv.WindMin.X - 1;
    if (x < 0) return false;
    const ix = Math.trunc(x / sv.TabSize);
    if (ix >= sv.Tabs) return false;
    if (ev.Where.Y < dv.WindMin.Y || ev.Where.Y > dv.WindMax.Y) return false;
    I.v = (ev.Where.Y - dv.WindMin.Y) * sv.Tabs + ix + sv.Base;
    if (I.v > sv.NItems) return false;
    return true;
  }

  let schar = '\x10';
  const i = ref(0);
  const pw = PushScr(1, BaseVars.TxtRows, BaseVars.TxtCols, BaseVars.TxtRows);
  if (ss.Subset) {
    if (ss.AscDesc) WrLLMsg(135);
    else WrLLMsg(134);
  } else WrLLMsg(152);
  const rows = 5;
  const cols = BaseVars.TxtCols > 52 ? 50 : BaseVars.TxtCols - 2;
  RdMsg(NMsg);
  let c2 = cols;
  if (C1 !== 0) c2 = C1 + cols + 1;
  let r2 = rows;
  if (R1 !== 0) r2 = R1 + rows + 1;
  dv.TextAttr = colors.sNorm;
  const w2 = PushWFramed(C1, R1, c2, r2, dv.TextAttr, BaseVars.MsgLine, LowTxt, WHasFrame + WDoubleFrame + WShadow + WPushPixel);

  // label 3
  const Finish = (): void => {
    ClrEvent();
    PopW(w2);
    PopScr(pw);
    ReleaseStore(pw);
    if (ss.Empty) return;
    ss.Empty = true;
    ss.PointTo = null;
    ss.Size = 0;
    let p = sv.ItemRoot;
    while (p !== null) {
      if (p.Tag !== ' ') ss.Size++;
      p = p.Chain;
    }
    if (ss.Subset && ss.ImplAll && ss.Size === 0) {
      p = sv.ItemRoot;
      while (p !== null) {
        if (p.S[0] !== SelMark) {
          p.Tag = schar;
          ss.Size++;
        }
        p = p.Chain;
      }
    }
    if (dv.KbdChar === _ESC_) ReleaseStore(sv.markp);
  };

  if (ss.Empty) {
    do ReadKbd();
    while (dv.KbdChar !== _ESC_);
    Finish();
    return;
  }
  sv.TabSize = sv.MaxItemLen + 2;
  if (ss.Subset) sv.TabSize++;
  sv.Tabs = Math.trunc(cols / sv.TabSize);
  sv.WwSize = sv.Tabs * rows;
  let MaxBase = 1;
  while (MaxBase + sv.WwSize <= sv.NItems) MaxBase += sv.Tabs;
  if (ss.Abcd) AbcdSort();
  if (ss.AscDesc) schar = '<';
  else schar = '\x10';
  SetFirstiItem();
  sv.Base = sv.iItem - ((sv.iItem - 1) % sv.WwSize);
  DisplWw();
  let iOld = 0;
  for (;;) {
    // 1:
    GetEvent();
    const ev = dv.Event;
    switch (ev.What) {
      case evMouseMove:
        if (iOld !== 0 && MouseInItem(i) && i.v !== iOld) {
          Switch(i.v, iOld);
          sv.iItem = i.v;
          DisplWw();
          iOld = i.v;
        }
        break;
      case evMouseDown:
        if (MouseInItem(i)) {
          if (ss.Subset) {
            const p = GetItem(i.v);
            if (p.Tag === ' ') p.Tag = schar;
            else p.Tag = ' ';
            sv.iItem = i.v;
            iOld = i.v;
            DisplWw();
          } else {
            // 2:
            dv.KbdChar = _M_;
            sv.iItem = i.v;
            Finish();
            return;
          }
        } else if (ss.Subset && (ev.Buttons & mbDoubleClick) !== 0) {
          // 2:
          dv.KbdChar = _M_;
          sv.iItem = i.v;
          Finish();
          return;
        }
        break;
      case evMouseUp:
        iOld = 0;
        break;
      case evKeyDown: {
        dv.KbdChar = ev.KeyCode;
        switch (dv.KbdChar) {
          case _M_:
          case _ESC_:
            Finish();
            return;
          case _left_:
            Left();
            break;
          case _right_:
            Right();
            break;
          case _up_:
            Up();
            break;
          case _down_:
            Down();
            break;
          case _PgUp_:
            if (sv.Base > 1) {
              IVOff();
              let b = sv.Base - sv.WwSize;
              if (b < 1) b = 1;
              sv.iItem -= sv.Base - b;
              sv.Base = b;
              DisplWw();
              IVOn();
            }
            break;
          case _PgDn_:
            if (sv.Base < MaxBase) {
              IVOff();
              let b = sv.Base + sv.WwSize;
              if (b > MaxBase) b = MaxBase;
              sv.iItem += b - sv.Base;
              if (sv.iItem > sv.NItems) sv.iItem -= sv.Tabs;
              sv.Base = b;
              DisplWw();
              IVOn();
            }
            break;
          case _Z_:
            if (sv.Base < MaxBase) {
              IVOff();
              sv.Base = sv.Base + sv.Tabs;
              if (sv.iItem < sv.Base) sv.iItem = sv.iItem + sv.Tabs;
              if (sv.iItem > sv.NItems) sv.iItem = sv.NItems;
              DisplWw();
              IVOn();
            }
            break;
          case _W_:
            if (sv.Base > 1) {
              IVOff();
              sv.Base = sv.Base - sv.Tabs;
              if (sv.iItem >= sv.Base + sv.WwSize) sv.iItem = sv.iItem - sv.Tabs;
              DisplWw();
              IVOn();
            }
            break;
          case _CtrlPgUp_:
          case _Home_:
            if (sv.iItem > 1) {
              IVOff();
              sv.iItem = 1;
              if (sv.Base > 1) {
                sv.Base = 1;
                DisplWw();
              }
              IVOn();
            }
            break;
          case _CtrlPgDn_:
          case _End_:
            if (sv.iItem < sv.NItems) {
              IVOff();
              sv.iItem = sv.NItems;
              if (sv.Base < MaxBase) {
                sv.Base = MaxBase;
                DisplWw();
              }
              IVOn();
            }
            break;
          default:
            if (ss.Subset) {
              switch (dv.KbdChar) {
                case _F2_:
                  SetTag(schar);
                  break;
                case _CtrlF2_:
                  SetAllTags(schar);
                  break;
                case 62: // '>'
                  if (ss.AscDesc) SetTag('>');
                  break;
                case _F3_:
                  SetTag(' ');
                  break;
                case _CtrlF3_:
                  SetAllTags(' ');
                  break;
                case _F9_:
                  ClrEvent();
                  GraspAndMove(schar);
                  break;
              }
            }
        }
        break;
      }
    }
    ClrEvent();
  }
}

// PAS: WWMIX.PAS GetSelect
export function GetSelect(): string {
  const ss = WwMixVars.ss;
  if (!ss.Subset) {
    const p = GetItem(sv.iItem);
    ReleaseStore(sv.markp);
    return p.S;
  }
  // p: ItemPtr absolute sv{.ItemRoot}
  while (sv.ItemRoot !== null && sv.ItemRoot.Tag === ' ') sv.ItemRoot = sv.ItemRoot.Chain;
  if (sv.ItemRoot === null) {
    ss.Tag = ' ';
    return '';
  }
  ss.Tag = sv.ItemRoot.Tag;
  const result = sv.ItemRoot.S;
  sv.ItemRoot = sv.ItemRoot.Chain;
  return result;
}

// ---------------------------------------------------------------------------

// PAS: WWMIX.PAS SelFieldList
export function SelFieldList(Nmsg: number, ImplAll: boolean, FLRoot: Ref<FieldList>): boolean {
  const ss = WwMixVars.ss;
  FLRoot.v = null;
  if (ss.Empty) return true;
  ss.Subset = true;
  ss.ImplAll = ImplAll;
  SelectStr(0, 0, Nmsg, AccessVars.CFile!.Name);
  if (DriversVars.KbdChar === _ESC_) return false;
  for (;;) {
    // 1:
    let s = GetSelect();
    if (s === '') return true;
    let F: FieldDPtr = AccessVars.CFile!.FldD;
    if (s[0] === SelMark) s = Copy(s, 2, 255);
    while (F !== null) {
      if (s === F.Name) {
        const FL = new FieldListEl();
        ChainLast(FLRoot, FL);
        FL.FldD = F;
        break;
      }
      F = F.Chain;
    }
  }
}

// ---------------------------------------------------------------------------

/** TS-only: DOS.FExpand on an engine (host) path; a trailing separator is kept. */
function FExpand(Path: string): string {
  if (DosView.On) return DosFExpand(Path);
  const u = ToUnicode(UnixPath(Path));
  let r = nodePath.resolve(u);
  if ((u === '' || u.endsWith('/') || u.endsWith(nodePath.sep)) && !r.endsWith(nodePath.sep)) r += nodePath.sep;
  return FromUnicode(r);
}

// DOS file attributes used by SelectDiskFile
const Directory = 0x10;

/** TS-only: DOS.SearchRec of the emulated FindFirst/FindNext. */
interface SearchRec {
  Name: string;
  Attr: number;
  List: { Name: string; Attr: number }[];
  Idx: number;
}
/** TS-only: DOS.DosError after FindFirst/FindNext (0 found, 3 path not found, 18 no more files). */
const Dos = { DosError: 0 };
/** TS-only: read DosError (not narrowed by the compiler). */
function DosError(): number {
  return Dos.DosError;
}

/** TS-only: DOS wildcard match – name and extension are matched separately, so '*.*' matches a
 *  name without an extension too (FandMaskMatch alone is a Unix-style glob). */
function DosMaskMatch(Nm: string, Mask: string): boolean {
  const split = (s: string): [string, string] => {
    const i = s.lastIndexOf('.');
    return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
  };
  if (Nm === '.' || Nm === '..') return Mask === '*.*' || Mask === '*' || Mask === Nm;
  const [n, e] = split(Nm);
  const [mn, me] = split(Mask);
  return FandMaskMatch(n, mn) && FandMaskMatch(e, me);
}
/** TS-only: DOS.FindFirst – node:fs readdir of the directory part, DOS mask match, '.'/'..' for
 *  non-root directories when Attr includes Directory. Names are CP852 byte strings. */
function FindFirst(Path: string, Attr: number, SR: SearchRec): void {
  const d = ref(''), n = ref(''), e = ref('');
  FSplit(Path, d, n, e);
  const mask = n.v + e.v;
  const hostDir = d.v === '' ? '.' : ToUnicode(UnixPath(d.v));
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(hostDir, { withFileTypes: true });
  } catch {
    SR.List = [];
    SR.Idx = 0;
    Dos.DosError = 3;
    return;
  }
  const list: { Name: string; Attr: number }[] = [];
  if ((Attr & Directory) !== 0 && nodePath.resolve(hostDir) !== nodePath.parse(nodePath.resolve(hostDir)).root) {
    if (DosMaskMatch('.', mask)) list.push({ Name: '.', Attr: Directory });
    if (DosMaskMatch('..', mask)) list.push({ Name: '..', Attr: Directory });
  }
  for (const de of names) {
    let isDir = de.isDirectory();
    if (de.isSymbolicLink()) {
      try {
        isDir = fs.statSync(nodePath.join(hostDir, de.name)).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDir && (Attr & Directory) === 0) continue;
    const nm = FromUnicode(de.name);
    if (!DosMaskMatch(nm, mask)) continue;
    list.push({ Name: nm, Attr: isDir ? Directory : 0x20 });
  }
  SR.List = list;
  SR.Idx = 0;
  FindNext(SR);
}
/** TS-only: DOS.FindNext */
function FindNext(SR: SearchRec): void {
  if (SR.Idx >= SR.List.length) {
    Dos.DosError = 18;
    return;
  }
  const it = SR.List[SR.Idx++];
  SR.Name = it.Name;
  SR.Attr = it.Attr;
  Dos.DosError = 0;
}

// PAS: WWMIX.PAS SelectDiskFile
export function SelectDiskFile(Path: string, HdMsg: number, OnFace: boolean): string {
  const ss = WwMixVars.ss;
  const sep = DirectorySeparator;
  const SR: SearchRec = { Name: '', Attr: 0, List: [], Idx: 0 };
  const mask = ref('');
  let s: string;
  let p: PathStr = '';
  const d = ref<DirStr>(''), n = ref<NameStr>(''), e = ref<ExtStr>('');
  let ext: ExtStr = '';
  let ne = '';
  let c1 = 0, r1 = 0, c2 = 22, r2 = 1, c11 = 0, r11 = 0;
  if (OnFace) {
    c1 = 43;
    r1 = 6;
    c2 = 67;
    r2 = 8;
    c11 = 28;
    r11 = 4;
  }
  // label: 1 = prompt for the mask, 3 = list the directory
  let lbl: 1 | 3 = 1;
  if (Path === '') ext = '.*';
  else if (Path[0] === '.') ext = Path;
  else {
    FSplit(FExpand(Path), d, n, e);
    ne = ShortStr(n.v + e.v, 12);
    if (ne === '') ne = '*.*';
    lbl = 3;
  }
  if (lbl === 1) mask.v = '*' + ext;
  for (;;) {
    if (lbl === 1) {
      // 1:
      RdMsg(HdMsg);
      const w = PushWFramed(c1, r1, c2, r2, BaseVars.Colors.sMask, BaseVars.MsgLine, '', WHasFrame + WShadow + WPushPixel);
      let ok = false;
      while (!ok) {
        // 2:
        GotoXY(1, 1);
        EditTxt(mask, 1, 255, 22, 'A', true, false, true, false, 0);
        if (DriversVars.KbdChar === _ESC_) {
          PopW(w);
          return '';
        }
        if (Pos(' ', mask.v) !== 0) {
          WrLLF10Msg(60);
          continue;
        }
        FSplit(FExpand(mask.v), d, n, e);
        if (e.v === '') e.v = ext;
        else if (ext === '.RDB' && e.v !== '.RDB') {
          WrLLF10Msg(5);
          continue;
        }
        ok = true;
      }
      PopW(w);
      if (n.v === '') n.v = '*';
      ne = ShortStr(n.v + e.v, 12);
      if (Pos('*', ne) === 0 && Pos('?', ne) === 0) return d.v + ne;
    }
    // 3:
    p = d.v + ne;
    FindFirst(p, 0, SR);
    if (!(DosError() === 0 || DosError() === 18)) {
      SetMsgPar(p);
      mask.v = p;
      WrLLF10Msg(811);
      lbl = 1;
      continue;
    }
    while (DosError() === 0) {
      PutSelect(SR.Name);
      FindNext(SR);
    }
    FindFirst(d.v + '*.*', Directory, SR);
    while (DosError() === 0) {
      if ((SR.Attr & Directory) !== 0 && (Pos(sep, d.v) !== d.v.length || SR.Name !== '..') && SR.Name !== '.')
        PutSelect(sep + SR.Name);
      FindNext(SR);
    }
    ss.Abcd = true;
    SelectStr(c11, r11, HdMsg, p);
    if (DriversVars.KbdChar === _ESC_) return '';
    s = GetSelect();
    if (s[0] === sep) {
      s = s.slice(1);
      if (s === '..') {
        do d.v = d.v.slice(0, -1);
        while (d.v[d.v.length - 1] !== sep);
      } else d.v = d.v + s + sep;
      lbl = 3;
      continue;
    }
    return d.v + s;
  }
}

// PAS: WWMIX.PAS PromptFilter
export function PromptFilter(Txt: string, Bool: Ref<FrmlPtr>, BoolTxt: Ref<StringPtr>): boolean {
  const av = AccessVars;
  const p = ref<Pointer>(null);
  MarkStore(p);
  let I = 1;
  const er = new ExitRecord();
  NewExit(Ovr, er);
  let result = true;
  let Del = true;
  const txt = ref(Txt);
  try {
    ResetCompilePars();
    const cf = av.CFile;
    for (;;) {
      try {
        // 1:
        PromptLL(113, txt, I, Del);
        Bool.v = null;
        BoolTxt.v = null;
        if (DriversVars.KbdChar === _ESC_) {
          result = false;
          break;
        }
        if (txt.v.length === 0) break;
        SetInpStr(txt);
        RdLex();
        Bool.v = RdBool();
        if (av.Lexem !== _EOF) Error(21);
        BoolTxt.v = txt.v;
        break;
      } catch (e) {
        if (!(e instanceof GoExitSignal)) throw e;
        // 3:
        const Msg = BaseVars.MsgLine;
        I = av.CurrPos;
        SetMsgPar(Msg);
        WrLLF10Msg(110);
        av.IsCompileErr = false;
        ReleaseStore(p.v);
        av.CFile = cf;
        Del = false;
      }
    }
  } finally {
    // 2:
    RestoreExit(er);
  }
  return result;
}

// PAS: WWMIX.PAS PromptLL
export function PromptLL(N: number, Txt: Ref<string>, I: number, Del: boolean): void {
  const dv = DriversVars;
  const w = PushW(1, BaseVars.TxtRows, BaseVars.TxtCols, BaseVars.TxtRows);
  GotoXY(1, BaseVars.TxtRows);
  dv.TextAttr = BaseVars.Colors.pTxt;
  ClrEol();
  RdMsg(N);
  write(BaseVars.MsgLine);
  dv.TextAttr = BaseVars.Colors.pNorm;
  EditTxt(Txt, I, 255, BaseVars.TxtCols - WhereX(), 'A', Del, false, true, false, 0);
  PopW(w);
}

// PAS: WWMIX.PAS PassWord
export function PassWord(TwoTimes: boolean): string {
  const dv = DriversVars;
  const col = (BaseVars.TxtCols - 21) >> 1;
  const w = PushW(col, BaseVars.TxtRows - 2, col + 21, BaseVars.TxtRows - 2);
  let MsgNr = 628;
  const Txt = ref('');
  let Txt1 = '';
  for (;;) {
    // 1:
    dv.TextAttr = BaseVars.Colors.pNorm | 0x80;
    GotoXY(1, 1);
    ClrEol();
    RdMsg(MsgNr);
    const m = BaseVars.MsgLine;
    const width = Math.trunc((m.length + 22) / 2);
    write(m.length < width ? ' '.repeat(width - m.length) + m : m);
    dv.KbdBuffer = chr(ReadKbd() & 0xff) + dv.KbdBuffer;
    dv.TextAttr = BaseVars.Colors.pNorm;
    GotoXY(2, 1);
    Txt.v = '';
    EditTxt(Txt, 1, 20, 20, 'A', true, true, true, false, 0);
    if (dv.KbdChar === _ESC_) {
      Txt.v = '';
      break;
    }
    if (TwoTimes) {
      if (MsgNr === 628) {
        MsgNr = 637;
        Txt1 = Txt.v;
        continue;
      } else if (Txt.v !== Txt1) {
        WrLLF10Msg(638);
        MsgNr = 628;
        continue;
      }
    }
    break;
  }
  // 2:
  PopW(w);
  return ShortStr(Txt.v, 20);
}

// PAS: WWMIX.PAS SetPassword
export function SetPassword(FD: FileDPtr, Nr: number, Pw: string): void {
  const tf = FD!.TF!;
  Pw = ShortStr(Pw, 20);
  const p = new Uint8Array(20).fill(0x40); // '@'
  for (let i = 0; i < Pw.length; i++) p[i] = Pw.charCodeAt(i) & 0xff;
  Code(p, 20);
  const s = String.fromCharCode(...p);
  if (Nr === 1) tf.PwCode = s;
  else tf.Pw2Code = s;
}
// PAS: WWMIX.PAS HasPassword
export function HasPassword(FD: FileDPtr, Nr: number, Pw: string): boolean {
  const tf = FD!.TF!;
  const src = Nr === 1 ? tf.PwCode : tf.Pw2Code;
  const X = new Uint8Array(20);
  for (let i = 0; i < 20; i++) X[i] = src.charCodeAt(i) & 0xff;
  Code(X, 20);
  return ShortStr(Pw, 20) === TrailChar('@', String.fromCharCode(...X));
}
// PAS: WWMIX.PAS HasPasswordAuth – FPC accepts an empty password for Nr 1/2; BP7 (authoritative,
// see PORTING.md 1) is plain HasPassword, which we follow: the FPC shortcut bypasses the task password.
export function HasPasswordAuth(FD: FileDPtr, Nr: number, Pw: string): boolean {
  return HasPassword(FD, Nr, Pw);
}
