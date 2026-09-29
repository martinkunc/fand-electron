// PAS: WWMENU.PAS – windows and menus: TWindow (framed, shadowed, saved screen), menu boxes and
// menu bars driven by FAND messages (…S: `helpname/head/text1/text2/…` message texts) or by the
// MENUBOX/MENUBAR procedure instructions (…P: Instr with ChoiceD chains), help texts.
//
// Porting notes:
// * asm/DOS: none (Ovr no-op). The FPC branch uses Dispose(w, Done) + MarkStore/ReleaseStore where
//   BP7 calls w^.Done + ReleaseStore(w); both just end the object here.
// * Objects -> classes in this module (TWindow is not derived from DRIVERS' TObject: PORTING.md 5).
//   TObject.Init zeroes the object in TP; `new X()` already does, so leaf constructors skip it.
//   Constructors of classes that have descendants are named Init<Class> (InitWindow, InitMenu,
//   InitMenuBox, InitMenuBar) because the descendants' Init has other parameters (TS overrides must
//   be compatible); Pascal `TWindow.Init(...)` inside a descendant becomes `this.InitWindow(...)`.
//   Virtual methods are ordinary overridden methods; `var` object results are Refs.
// * TRect overlays TWindow.Orig+Size (`R: TRect absolute Orig` in Contains) - build a TRect.
// * Key global state: RdRunVars.MenuX/MenuY (AccessVars word vars; position of the next pull-down
//   box, saved/restored by TMenu.Init/Done), DriversVars.Event/KbdChar, BaseVars colors (mNorm..,
//   palette from PD^.mAttr via SetPalette), AccessVars.HelpFD (help of the message menus).
// * Tricky parts:
//   - TWindow.Init: Assign centres when C1/R1 = 0, shadow (2 cols/1 row, ShadowAttr), PushW1 of the
//     area (+ the last line when SaveLL), frame chars via ScrWrFrameLn (single 0/3/6, double 9/12/15),
//     centred ' top '/' bottom ' texts.
//   - TMenu.HandleEvent: mouse in/out of the box and parents, last-line help (DisplLLHelp with
//     GetHlpName, F1 -> EDITOR.Help), hot keys: ^W-marked letter (FindChar with NoDiakr/upcase).
//   - Exec returns (j shl 8) + i: j = 1/2 for Left/Right under a menu bar, i = 0 for ESC.
//   - CountNTxt evaluates the Choice conditions each time a box opens (Displ/Enabled/DisplEver) and
//     marks the first letter with ^W when the text has no ^W.
//   - TMenuBoxP.ExecItem runs the choice's instructions (RUNPROC.RunInstr) for pull-down menus;
//     ExitP -> I := 255; Loop/BreakP semantics as in MenuBoxProc.
//   - GetHlpText: finds a help record by name (ByName) or number in R^.HelpFD (or the FAND help
//     file), handling the `Name` index text; DisplLLHelp shows its first line in the last line.
//   - `RdbDPtr(HelpFD)`: the FAND help file (a FileD) stands in for an RdbD (TMenuBoxS/TMenuBarS
//     HlpRdb, EDITOR.Help, GetHlpText, DisplLLHelp compare R with HelpFD). TS passes the FileD object
//     itself cast to RdbD (HelpFDAsRdb) and compares identities (IsHelpFDRdb).

import { Pos, Copy, ShortStr, StrI, ValI, StrToBytes, BytesToStr, Lo, Hi, word, UpCase, ref, chr, type Ref } from './pasrt.ts';
import type { LongStrPtr, StringPtr } from './base.ts';
import type { FileDPtr, RdbDPtr, FieldDPtr } from './access.ts';
import type { ChoiceDPtr, InstrPtr } from './rdrun.ts';
import { TPoint } from './drivers.ts';
import {
  BaseVars, RdMsg, PrTab, prName, SetCurrPrinter, MinW, MaxW, MinI, MaxI, CountDLines, GetDLine, MouseInRect,
  ClearLL, LenStyleStr, ReplaceChar, EqualsMask, StoreStr,
} from './base.ts';
import {
  DriversVars, ScrWrFrameLn, ScrWrStr, ScrWrChar, ScrClr, ScrColor, CrsHide, CrsShow, TestEvent, ClrEvent,
  WaitEvent, NoDiakr, ConvToNoDiakr, ConvKamenToCurr, foKamen, evMouseDown, evKeyDown, _M_, _ESC_, _up_, _down_,
  _left_, _right_, _Home_, _End_, _PgUp_, _PgDn_, _F1_, _AltF10_, _AltF2_,
} from './drivers.ts';
import {
  AccessVars, NewLMode, OldLMode, RdMode, GetRecSpace2, ReadRec, _ShortS, _LongS,
} from './access.ts';
import { PushW1, PopW, RunError } from './obaseww.ts';
import { RunBool, RunShortStr, RunInt, RunWordImpl, TrailChar, CopyLine } from './runfrml.ts';
import { RunInstr } from './runproc.ts';
import { Help } from './editor.ts';
import { EditHelpOrCat } from './projmgr1.ts';
import { _menubox } from './rdrun.ts';

export const sfCursorVis = 0x0002;
export const sfCursorBig = 0x0004;
export const sfShadow = 0x0008;
export const sfFramed = 0x0010;
export const sfFrDouble = 0x0020;
export const sfFocused = 0x0040;
export const sfModal = 0x2000;

const _W_ = '\x17'; // ^w: hot-key marker in menu texts

/** TS-only: `RdbDPtr(HelpFD)` – the FAND help file standing in for an RdbD (see the notes). */
export function HelpFDAsRdb(): RdbDPtr {
  return AccessVars.HelpFD as unknown as RdbDPtr;
}
/** TS-only: `R = RdbDPtr(HelpFD)` */
export function IsHelpFDRdb(R: RdbDPtr): boolean {
  return R !== null && (R as unknown) === AccessVars.HelpFD;
}

// PAS: WWMENU.PAS TRect
export class TRect {
  get A(): TPoint {
    return (this._A ??= new TPoint());
  }
  set A(v: TPoint) {
    this._A = v;
  }
  get Size(): TPoint {
    return (this._Size ??= new TPoint());
  }
  set Size(v: TPoint) {
    this._Size = v;
  }
  private _A: TPoint | undefined;
  private _Size: TPoint | undefined;
  // PAS: WWMENU.PAS TRect.Contains
  Contains(P: TPoint): boolean {
    return P.X >= this.A.X && P.X < this.A.X + this.Size.X && P.Y >= this.A.Y && P.Y < this.A.Y + this.Size.Y;
  }
}

// PAS: WWMENU.PAS TWindow
export class TWindow {
  // lazily created so that no DRIVERS export is used at module top level (PORTING.md 5)
  get Orig(): TPoint {
    return (this._Orig ??= new TPoint());
  }
  get Size(): TPoint {
    return (this._Size ??= new TPoint());
  }
  get Shadow(): TPoint {
    return (this._Shadow ??= new TPoint());
  }
  private _Orig: TPoint | undefined;
  private _Size: TPoint | undefined;
  private _Shadow: TPoint | undefined;
  SavedW = 0;
  SavedLLW = 0;
  State = 0;
  WasCrsEnabled = false;

  // PAS: WWMENU.PAS TWindow.Init (constructor)
  InitWindow(C1: number, R1: number, C2: number, R2: number, Attr: number, top: string, bottom: string,
    SaveLL: boolean): this {
    const bv = BaseVars;
    const colors = bv.Colors;
    this.Assign(C1, R1, C2, R2);
    if (this.GetState(sfShadow)) {
      this.Shadow.X = MinW(2, bv.TxtCols - this.Col2());
      this.Shadow.Y = MinW(1, bv.TxtRows - this.Row2());
    }
    this.WasCrsEnabled = DriversVars.Crs.Enabled;
    CrsHide();
    this.SavedW = PushW1(this.Orig.X + 1, this.Orig.Y + 1, this.Orig.X + this.Size.X + this.Shadow.X,
      this.Orig.Y + this.Size.Y + this.Shadow.Y, true, false);
    if (SaveLL) this.SavedLLW = PushW1(1, bv.TxtRows, bv.TxtCols, bv.TxtRows, true, false);
    else this.SavedLLW = 0;
    if (this.Shadow.Y === 1) ScrColor(this.Orig.X + 2, this.Row2(), this.Size.X + this.Shadow.X - 2, colors.ShadowAttr);
    if (this.Shadow.X > 0) for (let i = this.Row1(); i <= this.Row2(); i++) ScrColor(this.Col2(), i, this.Shadow.X, colors.ShadowAttr);
    if (this.GetState(sfFramed)) {
      let n = 0;
      if (this.GetState(sfFrDouble)) n = 9;
      ScrWrFrameLn(this.Orig.X, this.Orig.Y, n, this.Size.X, Attr);
      for (let i = 1; i <= this.Size.Y - 2; i++) ScrWrFrameLn(this.Orig.X, this.Orig.Y + i, n + 6, this.Size.X, Attr);
      ScrWrFrameLn(this.Orig.X, this.Orig.Y + this.Size.Y - 1, n + 3, this.Size.X, Attr);
      const m = this.Size.X - 2;
      let s: string; // string[80]; l: byte absolute s
      if (top.length !== 0) {
        s = ShortStr(' ' + top + ' ', 80);
        s = s.slice(0, MinW(s.length, m));
        ScrWrStr(this.Col1() + Math.trunc((m - s.length) / 2), this.Orig.Y, s, Attr);
      }
      if (bottom.length !== 0) {
        s = ShortStr(' ' + bottom + ' ', 80);
        s = s.slice(0, MinW(s.length, m));
        ScrWrStr(this.Col1() + Math.trunc((m - s.length) / 2), this.Row2() - 1, s, Attr);
      }
    } else ScrClr(this.Orig.X, this.Orig.Y, this.Size.X, this.Size.Y, ' ', Attr);
    return this;
  }
  // PAS: WWMENU.PAS TWindow.Done (virtual destructor)
  Done(): void {
    if (this.SavedLLW !== 0) PopW(this.SavedLLW);
    PopW(this.SavedW);
    if (this.WasCrsEnabled) CrsShow();
    // inherited Done: TObject.Done does nothing
  }
  // PAS: WWMENU.PAS TWindow.Assign
  Assign(C1: number, R1: number, C2: number, R2: number): void {
    const bv = BaseVars;
    let m = 0;
    if (this.GetState(sfFramed)) m = 2;
    let cols = C2 + m;
    if (C1 !== 0) cols = C2 - C1 + 1;
    cols = MaxI(m + 1, MinI(cols, bv.TxtCols));
    if (C1 === 0) this.Orig.X = Math.trunc((bv.TxtCols - cols) / 2);
    else this.Orig.X = MinI(C1 - 1, bv.TxtCols - cols);
    let rows = R2 + m;
    if (R1 !== 0) rows = R2 - R1 + 1;
    rows = MaxI(m + 1, MinI(rows, bv.TxtRows));
    if (R1 === 0) this.Orig.Y = Math.trunc((bv.TxtRows - rows) / 2);
    else this.Orig.Y = MinI(R1 - 1, bv.TxtRows - rows);
    this.Size.Assign(cols, rows);
  }
  // PAS: WWMENU.PAS TWindow.Col1
  Col1(): number {
    return this.Orig.X + 1;
  }
  // PAS: WWMENU.PAS TWindow.Row1
  Row1(): number {
    return this.Orig.Y + 1;
  }
  // PAS: WWMENU.PAS TWindow.Col2
  Col2(): number {
    return this.Orig.X + this.Size.X;
  }
  // PAS: WWMENU.PAS TWindow.Row2
  Row2(): number {
    return this.Orig.Y + this.Size.Y;
  }
  // PAS: WWMENU.PAS TWindow.Contains – R: TRect absolute Orig (Orig + Size)
  Contains(T: TPoint): boolean {
    const R = new TRect();
    R.A = this.Orig;
    R.Size = this.Size;
    return R.Contains(T);
  }
  // PAS: WWMENU.PAS TWindow.GetState
  GetState(Flag: number): boolean {
    return (this.State & Flag) === Flag;
  }
  // PAS: WWMENU.PAS TWindow.SetState
  SetState(Flag: number, On: boolean): void {
    if (On) this.State |= Flag;
    else this.State &= ~Flag & 0xffff;
  }
}

export type PMenu = TMenu | null;
export type PMenuBox = TMenuBox | null;

// PAS: WWMENU.PAS TMenu
export class TMenu extends TWindow {
  Parent: PMenu = null;
  iTxt = 0;
  nTxt = 0;
  mx = 0;
  my = 0;
  HlpRdb: RdbDPtr = null;
  Palette = [0, 0, 0, 0]; // [0..3] norm, curr, char, disabled
  IsBoxS = false;

  // PAS: WWMENU.PAS TMenu.Init (constructor) – saves MenuX/MenuY
  InitMenu(): this {
    this.mx = AccessVars.MenuX;
    this.my = AccessVars.MenuY;
    return this;
  }
  // PAS: WWMENU.PAS TMenu.Done (virtual destructor) – restores MenuX/MenuY
  override Done(): void {
    AccessVars.MenuX = this.mx;
    AccessVars.MenuY = this.my;
    super.Done();
  }
  // PAS: WWMENU.PAS TMenu.ClearHlp
  ClearHlp(): void {
    if (this.HlpRdb !== null) ClearLL(BaseVars.Colors.uNorm);
  }
  // PAS: WWMENU.PAS TMenu.Enabled (virtual)
  Enabled(I: number): boolean {
    return true;
  }
  // PAS: WWMENU.PAS TMenu.ExecItem (virtual) – true: stay in the menu
  ExecItem(I: Ref<number>): boolean {
    return false;
  }
  // PAS: WWMENU.PAS TMenu.FindChar
  FindChar(): boolean {
    const i = this.iTxt;
    for (let j = 1; j <= this.nTxt; j++) {
      if (this.Enabled(j)) {
        const s = ShortStr(this.GetText(j), 80);
        if (s.length > 0) {
          const k = Pos(_W_, s);
          let c2: string;
          if (k !== 0) c2 = s[k] ?? '\0'; // s[k+1]
          else c2 = s[0];
          if (UpCase(NoDiakr(c2)) === UpCase(NoDiakr(chr(DriversVars.KbdChar & 0xff)))) {
            this.iTxt = j;
            this.WrText(i);
            return true;
          }
        }
      }
    }
    return false;
  }
  // PAS: WWMENU.PAS TMenu.GetHlpName (virtual)
  GetHlpName(): string {
    return '';
  }
  // PAS: WWMENU.PAS TMenu.GetItemRect (virtual)
  GetItemRect(I: number, R: TRect): void {}
  // PAS: WWMENU.PAS TMenu.GetText (virtual) – 0 = head line
  GetText(I: number): string {
    return '';
  }
  // PAS: WWMENU.PAS TMenu.HandleEvent – waits for a key/mouse event, result in KbdChar
  HandleEvent(): void {
    const dv = DriversVars;
    const bv = BaseVars;
    this.WrText(this.iTxt);
    const i = this.iTxt;
    let frst = true;
    const hlp = ShortStr(this.GetHlpName(), 40);
    TestEvent();
    for (;;) {
      // label 1
      dv.KbdChar = 0;
      const Event = dv.Event;
      let f1 = false; // goto 2
      switch (Event.What) {
        case evMouseDown:
          if (this.Contains(Event.Where)) {
            dv.KbdChar = _M_;
            this.LeadIn(Event.Where);
          } else if (MouseInRect(0, bv.TxtRows - 1, bv.TxtCols, 1)) f1 = true;
          else if (this.ParentsContain(Event.Where)) {
            dv.KbdChar = _ESC_;
            return;
          }
          break;
        case evKeyDown:
          switch (Event.KeyCode) {
            case _Home_:
            case _PgUp_:
              this.iTxt = 0;
              this.Next();
              this.WrText(i);
              break;
            case _End_:
            case _PgDn_:
              this.iTxt = this.nTxt + 1;
              this.Prev();
              this.WrText(i);
              break;
            case _F1_:
              f1 = true;
              break;
            case _AltF10_:
              ClrEvent();
              Help(null, '', false);
              dv.KbdChar = 0;
              break;
            case _AltF2_:
              if (AccessVars.IsTestRun && !this.IsBoxS) {
                ClrEvent();
                EditHelpOrCat(_AltF2_, 2, hlp);
                dv.KbdChar = 0;
              }
              break;
            default:
              dv.KbdChar = Event.KeyCode;
          }
          break;
        default:
          if (frst) {
            DisplLLHelp(this.HlpRdb, hlp, false);
            frst = false;
          }
          ClrEvent();
          WaitEvent(0);
          continue;
      }
      if (f1) {
        // label 2
        ClrEvent();
        if (this.HlpRdb !== null) Help(this.HlpRdb, hlp, false);
        dv.KbdChar = 0;
      }
      break;
    }
    ClrEvent();
  }
  // PAS: WWMENU.PAS TMenu.IsMenuBar
  IsMenuBar(): boolean {
    return this.Size.Y === 1;
  }
  // PAS: WWMENU.PAS TMenu.LeadIn – select the item under the mouse point T
  LeadIn(T: TPoint): void {
    const i = this.iTxt;
    const r = new TRect();
    for (let j = 1; j <= this.nTxt; j++) {
      this.GetItemRect(j, r);
      if (r.Contains(T) && this.Enabled(j) && this.GetText(j) !== '') {
        this.iTxt = j;
        this.WrText(i);
        this.WrText(j);
        return;
      }
    }
    DriversVars.KbdChar = 0;
  }
  // PAS: WWMENU.PAS TMenu.Next
  Next(): void {
    do {
      if (this.iTxt < this.nTxt) this.iTxt++;
      else this.iTxt = 1;
    } while (!(this.Enabled(this.iTxt) && this.GetText(this.iTxt) !== ''));
  }
  // PAS: WWMENU.PAS TMenu.ParentsContain
  ParentsContain(T: TPoint): boolean {
    let P = this.Parent;
    while (P !== null) {
      if (P.Contains(T)) return true;
      P = P.Parent;
    }
    return false;
  }
  // PAS: WWMENU.PAS TMenu.Prev
  Prev(): void {
    do {
      if (this.iTxt > 1) this.iTxt--;
      else this.iTxt = this.nTxt;
    } while (!(this.Enabled(this.iTxt) && this.GetText(this.iTxt) !== ''));
  }
  // PAS: WWMENU.PAS TMenu.UnderMenuBar
  UnderMenuBar(): boolean {
    return this.Parent !== null && this.Parent.IsMenuBar();
  }
  // PAS: WWMENU.PAS TMenu.WrText – draw item I (current/disabled/hot-key colours)
  WrText(I: number): void {
    const s = ShortStr(this.GetText(I), 80);
    if (s.length === 0) {
      // menubox only
      ScrWrFrameLn(this.Orig.X, this.Orig.Y + I, 18, this.Size.X, this.Palette[0]);
      return;
    }
    const r = new TRect();
    this.GetItemRect(I, r);
    let x = r.A.X;
    const y = r.A.Y;
    const x2 = x + r.Size.X;
    const ena = this.Enabled(I);
    let attr: number;
    if (I === this.iTxt) attr = this.Palette[1];
    else if (ena) attr = this.Palette[0];
    else attr = this.Palette[3];
    const posw = Pos(_W_, s);
    ScrWrChar(x, y, ' ', attr);
    x++;
    let red = false;
    for (let j = 1; j <= s.length; j++) {
      const c = s[j - 1];
      if (c === _W_ || (posw === 0 && (j === 1 || j === 2))) {
        if (ena && I !== this.iTxt) {
          if (red) {
            attr = this.Palette[0];
            red = false;
          } else {
            attr = this.Palette[2];
            red = true;
          }
        }
      }
      if (c !== _W_) {
        ScrWrChar(x, y, c, attr);
        x++;
      }
    }
    while (x < x2) {
      ScrWrChar(x, y, ' ', attr);
      x++;
    }
  }
  // PAS: WWMENU.PAS TMenu.SetPalette – from aPD^.mAttr formulas or colors.mNorm..
  SetPalette(aPD: InstrPtr): void {
    const colors = BaseVars.Colors;
    const pd = aPD!;
    this.Palette[0] = RunWordImpl(pd.mAttr[0], colors.mNorm) & 0xff;
    this.Palette[1] = RunWordImpl(pd.mAttr[1], colors.mHili) & 0xff;
    this.Palette[2] = RunWordImpl(pd.mAttr[2], colors.mFirst) & 0xff;
    this.Palette[3] = RunWordImpl(pd.mAttr[3], colors.mDisabled) & 0xff;
  }
}

// PAS: WWMENU.PAS TMenuBox
export class TMenuBox extends TMenu {
  // PAS: WWMENU.PAS TMenuBox.Init (constructor)
  InitMenuBox(C1: number, R1: number): this {
    const bv = BaseVars;
    this.InitMenu();
    const hd = ShortStr(this.GetText(0), 80);
    let cols = hd.length;
    for (let i = 1; i <= this.nTxt; i++) {
      const l = LenStyleStr(this.GetText(i));
      if (l > cols) cols = l;
    }
    cols += 4;
    if (cols + 2 > bv.TxtCols || this.nTxt + 2 > bv.TxtRows) RunError(636);
    let c2 = cols;
    let r2 = this.nTxt;
    if (C1 !== 0) c2 += C1 + 1;
    if (R1 !== 0) r2 += R1 + 1;
    this.SetState(sfFramed, true);
    this.InitWindow(C1, R1, c2, r2, this.Palette[0], hd, '', this.HlpRdb !== null);
    for (let i = 1; i <= this.nTxt; i++) this.WrText(i);
    return this;
  }
  // PAS: WWMENU.PAS TMenuBox.Exec – (j shl 8) + item; 0 = ESC
  Exec(IStart: number): number {
    const dv = DriversVars;
    const av = AccessVars;
    if (this.nTxt === 0) return 0;
    let j = 0;
    this.iTxt = IStart;
    if (this.iTxt === 0) this.iTxt = 1;
    this.Prev();
    this.Next(); // get valid iTxt
    for (;;) {
      // label 1
      this.HandleEvent(); // TMenu.HandleEvent
      let i = this.iTxt;
      let lbl = 0; // 0 = goto 1, 2, 3, 4
      switch (dv.KbdChar) {
        case _M_:
          lbl = 2;
          break;
        case _ESC_:
          i = 0;
          lbl = 3;
          break;
        case _up_:
          this.Prev();
          this.WrText(i);
          break;
        case _down_:
          this.Next();
          this.WrText(i);
          break;
        case _left_:
          if (this.UnderMenuBar()) {
            j = 1;
            lbl = 4;
          }
          break;
        case _right_:
          if (this.UnderMenuBar()) {
            j = 2;
            lbl = 4;
          }
          break;
        default:
          if (!this.FindChar()) continue;
          this.WrText(this.iTxt);
          lbl = 2;
      }
      if (lbl === 2) {
        i = this.iTxt;
        av.MenuX = word(this.Orig.X + 4);
        av.MenuY = word(this.Orig.Y + i + 2);
        lbl = 3;
      }
      if (lbl === 3) {
        this.ClearHlp();
        const ri = ref(i);
        const stay = this.ExecItem(ri);
        i = ri.v;
        if (!stay) lbl = 4;
      }
      if (lbl === 4) return word((j << 8) + i);
    }
  }
  // PAS: WWMENU.PAS TMenuBox.GetItemRect (virtual)
  override GetItemRect(I: number, R: TRect): void {
    R.A.X = this.Orig.X + 2;
    R.A.Y = this.Orig.Y + I;
    R.Size.X = this.Size.X - 4;
    R.Size.Y = 1;
  }
}

export type PMenuBoxS = TMenuBoxS | null;
// PAS: WWMENU.PAS TMenuBoxS – menu box from a message text 'helpname/head/text1/...'
export class TMenuBoxS extends TMenuBox {
  MsgTxt: StringPtr = null;
  // PAS: WWMENU.PAS TMenuBoxS.Init (constructor)
  Init(C1: number, R1: number, Msg: StringPtr): this {
    const colors = BaseVars.Colors;
    this.MsgTxt = StoreStr(Msg ?? '');
    this.HlpRdb = HelpFDAsRdb();
    this.IsBoxS = true;
    const m = StrToBytes(this.MsgTxt ?? '');
    this.nTxt = word(CountDLines(m, m.length, '/') - 2);
    // Move(colors.mNorm, Palette, 3)
    this.Palette[0] = colors.mNorm;
    this.Palette[1] = colors.mHili;
    this.Palette[2] = colors.mFirst;
    this.SetState(sfShadow, true);
    this.InitMenuBox(C1, R1);
    return this;
  }
  // PAS: WWMENU.PAS TMenuBoxS.GetHlpName (virtual) – '<helpname>_<iTxt>'
  override GetHlpName(): string {
    return ShortStr(this.GetText(-1) + '_' + StrI(this.iTxt));
  }
  // PAS: WWMENU.PAS TMenuBoxS.GetText (virtual)
  override GetText(I: number): string {
    // helpname/head/text1/text2/...
    const m = StrToBytes(this.MsgTxt ?? '');
    return GetDLine(m, m.length, '/', I + 2);
  }
}

// PAS: WWMENU.PAS Menu – message menu MsgNr (TMenuBoxS centred), returns the Exec result
export function Menu(MsgNr: number, IStart: number): number {
  RdMsg(MsgNr);
  const w = new TMenuBoxS().Init(0, 0, BaseVars.MsgLine);
  const result = w.Exec(IStart);
  w.Done();
  return result;
}

// PAS: WWMENU.PAS PrinterMenu – choose the current printer (SetCurrPrinter)
export function PrinterMenu(Msg: number): boolean {
  const bv = BaseVars;
  RdMsg(Msg);
  const j = bv.prCurr;
  for (bv.prCurr = 0; bv.prCurr <= bv.prMax - 1; bv.prCurr++) {
    const i = bv.printer[bv.prCurr].Lpti;
    const nr = ShortStr(StrI(i), 3);
    const nm = ref(PrTab(prName));
    ReplaceChar(nm, '/', '-');
    let lpt = '(LPT' + nr + ')';
    if (bv.printer[bv.prCurr].ToMgr) lpt = '';
    bv.MsgLine = ShortStr(bv.MsgLine + '/' + nm.v + Copy('      ', 1, MaxI(0, 9 - nm.v.length)) + lpt);
  }
  bv.prCurr = j;
  const w = new TMenuBoxS().Init(0, 0, bv.MsgLine);
  const i = w.Exec(word(bv.prCurr + 1));
  if (i > 0) SetCurrPrinter(i - 1);
  w.Done();
  return i > 0;
}

// PAS: WWMENU.PAS CI (private) – the I-th displayed choice
function CI(C: ChoiceDPtr, I: number): ChoiceDPtr {
  for (;;) {
    if (C!.Displ) I--;
    if (I === 0) return C;
    C = C!.Chain;
  }
}
// PAS: WWMENU.PAS CountNTxt (private) – evaluate the choice conditions and texts
function CountNTxt(C: ChoiceDPtr, IsMenuBar: boolean): number {
  let n = 0;
  let nValid = 0;
  while (C !== null) {
    let b = RunBool(C.Bool);
    C.Displ = false;
    if (b || C.DisplEver) {
      C.Displ = true;
      n++;
      let s = RunShortStr(C.TxtFrml);
      if (s.length !== 0) {
        s = s.slice(0, MinI(s.length, BaseVars.TxtCols - 6));
        if (Pos(_W_, s) === 0) s = ShortStr(_W_ + s[0] + _W_ + Copy(s, 2, 255));
      } else if (IsMenuBar) s = ' ';
      C.Txt = StoreStr(s);
      if (s === '') b = false;
      if (b) nValid++;
    }
    C.Enabled = b;
    C = C.Chain;
  }
  if (nValid === 0) n = 0;
  return n;
}

export type PMenuBoxP = TMenuBoxP | null;
// PAS: WWMENU.PAS TMenuBoxP – the MENUBOX instruction
export class TMenuBoxP extends TMenuBox {
  PD: InstrPtr = null;
  CRoot: ChoiceDPtr = null;
  HdTxt: StringPtr = null;
  // PAS: WWMENU.PAS TMenuBoxP.Init (constructor)
  Init(C1: number, R1: number, aParent: PMenu, aPD: InstrPtr): this {
    const pd = aPD!;
    this.PD = aPD;
    this.Parent = aParent;
    let s = RunShortStr(pd.HdLine);
    s = s.slice(0, MinI(s.length, BaseVars.TxtCols - 6));
    this.HdTxt = StoreStr(s);
    this.HlpRdb = pd.HelpRdb;
    this.CRoot = pd.Choices;
    this.nTxt = CountNTxt(this.CRoot, false);
    this.SetPalette(aPD);
    if (pd.X !== null) {
      C1 = word(RunInt(pd.X));
      R1 = word(RunInt(pd.Y));
    } else if (pd.PullDown && aParent === null) {
      C1 = AccessVars.MenuX;
      R1 = AccessVars.MenuY;
    }
    if (pd.Shdw) this.SetState(sfShadow, true);
    this.InitMenuBox(C1, R1);
    return this;
  }
  // PAS: WWMENU.PAS TMenuBoxP.Enabled (virtual)
  override Enabled(I: number): boolean {
    return CI(this.CRoot, I)!.Enabled;
  }
  // PAS: WWMENU.PAS TMenuBoxP.ExecItem (virtual)
  override ExecItem(I: Ref<number>): boolean {
    const bv = BaseVars;
    const pd = this.PD!;
    if (!pd.PullDown) return false;
    if (I.v === 0) {
      if (DriversVars.Event.What === evMouseDown || !pd.WasESCBranch) return false;
      RunInstr(pd.ESCInstr);
    } else RunInstr(CI(this.CRoot, I.v)!.Instr);
    if (bv.ExitP) {
      I.v = 255;
      return false;
    }
    I.v = 0;
    if (pd.Loop) {
      if (bv.BreakP) {
        bv.BreakP = false;
        return false;
      }
      return true;
    } else if (bv.BreakP) {
      bv.BreakP = false;
      I.v = 255;
    }
    return false;
  }
  // PAS: WWMENU.PAS TMenuBoxP.GetHlpName (virtual)
  override GetHlpName(): string {
    const S = CI(this.CRoot, this.iTxt)!.HelpName;
    if (S !== null) return S;
    return '';
  }
  // PAS: WWMENU.PAS TMenuBoxP.GetText (virtual)
  override GetText(I: number): string {
    if (I === 0) return this.HdTxt ?? '';
    return CI(this.CRoot, I)!.Txt ?? '';
  }
}

// PAS: WWMENU.PAS MenuBoxProc – the MENUBOX instruction
export function MenuBoxProc(PD: InstrPtr): void {
  const bv = BaseVars;
  const pd = PD!;
  let i = 1;
  for (;;) {
    // label 1
    const w = new TMenuBoxP().Init(0, 0, null, PD);
    i = w.Exec(i);
    w.Done();
    if (pd.PullDown) return;
    if (i === 0) {
      if (!pd.WasESCBranch) return;
      RunInstr(pd.ESCInstr);
    } else RunInstr(CI(pd.Choices, i)!.Instr);
    if (bv.BreakP || bv.ExitP) {
      if (pd.Loop) bv.BreakP = false;
      return;
    }
    if (!pd.Loop) return;
  }
}

export type PMenuBar = TMenuBar | null;
// PAS: WWMENU.PAS TMenuBar
export class TMenuBar extends TMenu {
  nBlks = 0;
  DownI: number[] = new Array(31).fill(0); // [1..30]
  // PAS: WWMENU.PAS TMenuBar.Init (constructor)
  InitMenuBar(C1: number, R1: number, Cols: number): this {
    this.InitMenu();
    let l = 0;
    for (let i = 1; i <= this.nTxt; i++) l = l + LenStyleStr(this.GetText(i)) + 2;
    if (l > BaseVars.TxtCols) RunError(636);
    Cols = MaxW(l, Cols);
    if (this.nTxt === 0) this.nBlks = 0;
    else this.nBlks = Math.trunc((Cols - l) / this.nTxt);
    while (Cols - l - this.nBlks * this.nTxt < this.nBlks) this.nBlks--;
    let c2 = Cols;
    if (C1 !== 0) c2 += C1 - 1;
    let r2 = 1;
    if (R1 !== 0) r2 = R1;
    this.InitWindow(C1, R1, c2, r2, this.Palette[0], '', '', this.HlpRdb !== null);
    return this;
  }
  // PAS: WWMENU.PAS TMenuBar.Exec
  Exec(): number {
    const dv = DriversVars;
    const av = AccessVars;
    if (this.nTxt === 0) return 0;
    let down = false;
    this.iTxt = 1;
    this.Prev();
    this.Next(); // get valid iTxt
    for (let i = 1; i <= this.nTxt; i++) this.WrText(i);
    outer: for (;;) {
      // label 1
      this.HandleEvent();
      let i = this.iTxt;
      let enter = false;
      let lbl = 0; // 0 = goto 1, 2, 3, 4
      switch (dv.KbdChar) {
        case _M_:
          enter = true;
          lbl = 2;
          break;
        case _ESC_:
          i = 0;
          lbl = 4;
          break;
        case _down_:
          lbl = 3;
          break;
        case _left_:
          this.Prev();
          this.WrText(i);
          if (down) lbl = 2;
          break;
        case _right_:
          this.Next();
          this.WrText(i);
          if (down) lbl = 2;
          break;
        default:
          if (!this.FindChar()) continue outer;
          enter = true;
          lbl = 2;
      }
      while (lbl === 2 || lbl === 3) {
        if (lbl === 2) this.WrText(this.iTxt);
        // label 3
        const r = new TRect();
        this.GetItemRect(this.iTxt, r);
        av.MenuX = word(r.A.X + 1);
        av.MenuY = word(r.A.Y + 2);
        const w = ref<PMenuBox>(null);
        if (this.GetDownMenu(w)) {
          i = w.v!.Exec(this.DownI[this.iTxt]);
          w.v!.Done();
          this.DownI[this.iTxt] = Lo(i);
          enter = false;
          down = true;
          if (Hi(i) === 1) {
            i = this.iTxt;
            this.Prev();
            this.WrText(i);
            lbl = 2;
            continue;
          }
          if (Hi(i) === 2) {
            i = this.iTxt;
            this.Next();
            this.WrText(i);
            lbl = 2;
            continue;
          }
          down = false;
          if (i === 0) continue outer;
          return word((this.iTxt << 8) + i);
        }
        if (enter) {
          i = this.iTxt;
          lbl = 4;
        } else lbl = 0;
      }
      if (lbl === 4) {
        this.ClearHlp();
        const ri = ref(i);
        if (!this.ExecItem(ri)) return word(ri.v << 8);
      }
    }
  }
  // PAS: WWMENU.PAS TMenuBar.GetDownMenu (virtual)
  GetDownMenu(W: Ref<PMenuBox>): boolean {
    return false;
  }
  // PAS: WWMENU.PAS TMenuBar.GetItemRect (virtual)
  override GetItemRect(I: number, R: TRect): void {
    let x = this.Orig.X + this.nBlks;
    for (let j = 1; j <= I - 1; j++) x += LenStyleStr(this.GetText(j)) + 2 + this.nBlks;
    R.A.X = x;
    R.A.Y = this.Orig.Y;
    R.Size.X = LenStyleStr(this.GetText(I)) + 2;
    R.Size.Y = 1;
  }
}

export type PMenuBarS = TMenuBarS | null;
// PAS: WWMENU.PAS TMenuBarS – menu bar from a message text
export class TMenuBarS extends TMenuBar {
  MsgTxt: StringPtr = null;
  // PAS: WWMENU.PAS TMenuBarS.Init (constructor)
  Init(MsgNr: number): this {
    const bv = BaseVars;
    RdMsg(MsgNr);
    this.MsgTxt = StoreStr(bv.MsgLine);
    this.HlpRdb = HelpFDAsRdb();
    const m = StrToBytes(this.MsgTxt ?? '');
    this.nTxt = Math.trunc(word(CountDLines(m, m.length, '/') - 1) / 2);
    this.Palette[0] = bv.Colors.mNorm; // Move(colors.mNorm, Palette, 3)
    this.Palette[1] = bv.Colors.mHili;
    this.Palette[2] = bv.Colors.mFirst;
    this.InitMenuBar(1, 1, bv.TxtCols);
    return this;
  }
  // PAS: WWMENU.PAS TMenuBarS.GetDownMenu (virtual)
  override GetDownMenu(W: Ref<PMenuBox>): boolean {
    const TNr = ShortStr(this.GetText(this.nTxt + this.iTxt), 10);
    const n = ref(0);
    const err = ref(0);
    ValI(TNr, n, err);
    if (TNr.length === 0 || err.v !== 0) return false;
    RdMsg(word(n.v));
    const p = new TMenuBoxS().Init(AccessVars.MenuX, AccessVars.MenuY, BaseVars.MsgLine);
    p.Parent = this;
    W.v = p;
    return true;
  }
  // PAS: WWMENU.PAS TMenuBarS.GetHlpName (virtual)
  override GetHlpName(): string {
    return ShortStr(this.GetText(0) + '_' + StrI(this.iTxt));
  }
  // PAS: WWMENU.PAS TMenuBarS.GetText (virtual)
  override GetText(I: number): string {
    // helpname/text1/text2/...subnr1/subnr2/...
    const m = StrToBytes(this.MsgTxt ?? '');
    return GetDLine(m, m.length, '/', I + 1);
  }
}

export type PMenuBarP = TMenuBarP | null;
// PAS: WWMENU.PAS TMenuBarP – the MENUBAR instruction
export class TMenuBarP extends TMenuBar {
  PD: InstrPtr = null;
  CRoot: ChoiceDPtr = null;
  // PAS: WWMENU.PAS TMenuBarP.Init (constructor)
  Init(aPD: InstrPtr): this {
    this.PD = aPD;
    const pd = aPD!;
    this.HlpRdb = pd.HelpRdb;
    this.CRoot = pd.Choices;
    this.nTxt = CountNTxt(this.CRoot, true);
    this.SetPalette(aPD);
    let y1 = 1;
    if (pd.Y !== null) y1 = word(RunInt(pd.Y));
    let x1 = 1;
    let l1 = BaseVars.TxtCols;
    if (pd.X !== null) {
      x1 = word(RunInt(pd.X));
      l1 = word(RunInt(pd.XSz));
    }
    this.InitMenuBar(x1, y1, l1);
    return this;
  }
  // PAS: WWMENU.PAS TMenuBarP.Enabled (virtual)
  override Enabled(I: number): boolean {
    return CI(this.CRoot, I)!.Enabled;
  }
  // PAS: WWMENU.PAS TMenuBarP.ExecItem (virtual)
  override ExecItem(I: Ref<number>): boolean {
    const bv = BaseVars;
    const pd = this.PD!;
    if (I.v === 0) {
      if (!pd.WasESCBranch) return false;
      RunInstr(pd.ESCInstr);
    } else RunInstr(CI(this.CRoot, I.v)!.Instr);
    I.v = 0;
    if (bv.BreakP || bv.ExitP) {
      bv.BreakP = false;
      return false;
    }
    return true;
  }
  // PAS: WWMENU.PAS TMenuBarP.GetDownMenu (virtual)
  override GetDownMenu(W: Ref<PMenuBox>): boolean {
    const PD1 = CI(this.CRoot, this.iTxt)!.Instr;
    if (PD1 === null || PD1.Chain !== null || PD1.Kind !== _menubox || !PD1.PullDown) return false;
    W.v = new TMenuBoxP().Init(AccessVars.MenuX, AccessVars.MenuY, this, PD1);
    return true;
  }
  // PAS: WWMENU.PAS TMenuBarP.GetHlpName (virtual)
  override GetHlpName(): string {
    const S = CI(this.CRoot, this.iTxt)!.HelpName;
    if (S !== null) return S;
    return '';
  }
  // PAS: WWMENU.PAS TMenuBarP.GetText (virtual)
  override GetText(I: number): string {
    return CI(this.CRoot, I)!.Txt ?? '';
  }
}

// PAS: WWMENU.PAS MenuBarProc – the MENUBAR instruction
export function MenuBarProc(PD: InstrPtr): void {
  const w = new TMenuBarP().Init(PD);
  w.Exec();
  w.Done();
}

// PAS: WWMENU.PAS GetHlpText – help text S (by name or record number IRec) of R's help file
export function GetHlpText(R: RdbDPtr, S: string, ByName: boolean, IRec: Ref<number>): LongStrPtr | null {
  const av = AccessVars;
  const bv = BaseVars;
  const cr = av.CRecPtr;
  let T: LongStrPtr | null = null;
  let r = R;
  let md = 0;
  // label 5: CRecPtr := cr; GetHlpText := T
  const done = (): LongStrPtr | null => {
    av.CRecPtr = cr;
    return T;
  };
  if (ByName) {
    if (R === null) return done();
    av.CFile = R as unknown as FileDPtr;
    if (av.CFile === av.HelpFD) {
      if (av.CFile!.Handle === 0xff) return done();
    } else {
      av.CFile = R.HelpFD;
      if (av.CFile === null) return done();
    }
    const sb = StrToBytes(S);
    ConvToNoDiakr(sb, sb.length, bv.Fonts.VFont);
    S = BytesToStr(sb);
  }
  for (;;) {
    // label 1
    md = NewLMode(RdMode);
    if (av.CFile!.Handle === 0xff) return done();
    av.CRecPtr = GetRecSpace2();
    const NmF: FieldDPtr = av.CFile!.FldD;
    const TxtF: FieldDPtr = NmF!.Chain;
    // label 2: T := _LongS(TxtF) ... (returns true when found)
    const lbl2 = (i: number): boolean => {
      for (;;) {
        T = _LongS(TxtF);
        if (!ByName || T.length > 0 || i === av.CFile!.NRecs) {
          if (av.CFile === av.HelpFD) ConvKamenToCurr(T, T.length);
          IRec.v = i;
          return true;
        }
        i++;
        ReadRec(i);
      }
    };
    if (!ByName) {
      const i = MaxW(1, MinW(IRec.v, av.CFile!.NRecs));
      ReadRec(i);
      lbl2(i);
    } else {
      const n = av.CFile!.NRecs;
      for (let i = 1; i <= n; i++) {
        ReadRec(i);
        let Nm = TrailChar(' ', _ShortS(NmF));
        const fo = av.CFile === av.HelpFD ? foKamen : bv.Fonts.VFont;
        const nb = StrToBytes(Nm);
        ConvToNoDiakr(nb, nb.length, fo);
        Nm = BytesToStr(nb);
        if (EqualsMask(StrToBytes(S), S.length, Nm)) {
          lbl2(i);
          break;
        }
      }
    }
    // label 3
    OldLMode(md);
    if (T === null && av.CFile !== av.HelpFD) {
      // label 4
      let again = false;
      for (;;) {
        r = r!.ChainBack;
        if (r === null) break;
        if (r.HelpFD !== null && r.HelpFD !== av.CFile) {
          av.CFile = r.HelpFD;
          again = true;
          break;
        }
      }
      if (again) continue;
    }
    return done();
  }
}

// PAS: WWMENU.PAS DisplLLHelp – first help line in the last line (R24: row 24 instead)
export function DisplLLHelp(R: RdbDPtr, Name: string, R24: boolean): void {
  const av = AccessVars;
  const bv = BaseVars;
  if (R === null || (!IsHelpFDRdb(R) && R.HelpFD === null)) return;
  const cf = av.CFile;
  let found = false;
  if (Name !== '') {
    const iRec = ref(0);
    let s = GetHlpText(R, Name, true, iRec);
    if (s !== null) {
      s = CopyLine(s, 1, 1);
      let ml = BytesToStr(s, 0, MinW(s.length, 255));
      if (ml.length > 0 && ml[0] === '{') {
        ml = Copy(ml, 2, 255);
        const i = Pos('}', ml);
        if (i > 0) ml = ml.slice(0, i - 1);
      }
      bv.MsgLine = ml.slice(0, MinW(bv.TxtCols, ml.length));
      found = true;
    }
  }
  if (!found) bv.MsgLine = '';
  // label 1
  let y = bv.TxtRows - 1;
  if (R24) y--;
  ScrWrStr(0, y, bv.MsgLine, bv.Colors.nNorm);
  ScrClr(bv.MsgLine.length, y, bv.TxtCols - bv.MsgLine.length, 1, ' ', bv.Colors.nNorm);
  av.CFile = cf;
}
