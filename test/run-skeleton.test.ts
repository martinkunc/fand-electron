import { describe, it, expect } from 'vitest';
import { ParamStr, ParamCount, SetParams, NotImplementedError, ref } from '../src/engine/pas/pasrt.ts';
import { TMenuBoxS, TRect, sfShadow, sfFramed } from '../src/engine/pas/wwmenu.ts';
import { WwMixVars, SelMark } from '../src/engine/pas/wwmix.ts';
import { RunEdiPriv, RunEdiVars, CRec, EditFreeTxt } from '../src/engine/pas/runedi.ts';
import { EditDCopiedFields } from '../src/engine/pas/rdrun.ts';
import { EdPriv, EditorVars, IsOddel } from '../src/engine/pas/editor.ts';
import { RunPrologVars } from '../src/engine/pas/runprolg.ts';
import { StoreChptTxt, RunProjPriv } from '../src/engine/pas/runproj.ts';
import { FandMain } from '../src/engine/pas/fand.ts';

describe('run-time unit skeletons', () => {
  it('ParamStr/ParamCount', () => {
    SetParams(['UCTO2026', 'D']);
    expect(ParamCount()).toBe(2);
    expect(ParamStr(1)).toBe('UCTO2026');
    expect(ParamStr(3)).toBe('');
  });

  it('WWMENU objects start zeroed and keep state flags', () => {
    const w = new TMenuBoxS();
    expect(w.Orig.X).toBe(0);
    w.SetState(sfShadow, true);
    w.SetState(sfFramed, true);
    w.SetState(sfShadow, false);
    expect(w.GetState(sfFramed)).toBe(true);
    expect(w.GetState(sfShadow)).toBe(false);
    expect(w.ExecItem(ref(1))).toBe(false);
    expect(new TRect().Size.Y).toBe(0);
  });

  it('unit state objects', () => {
    expect(WwMixVars.ss.Empty).toBe(false);
    expect(SelMark.charCodeAt(0)).toBe(0xf0);
    expect(RunEdiVars.CFld).toBe(null);
    for (const f of EditDCopiedFields) expect(f in RunEdiPriv).toBe(true);
    expect(EditorVars.Insert).toBe(false);
    expect(EdPriv.Part.ColorP).toBe('');
    expect(IsOddel(32) && !IsOddel(65) && IsOddel(96)).toBe(true);
    expect(RunPrologVars.ProlgCallLevel).toBe(0);
    expect(RunProjPriv.nCat).toBe(1);
  });

  it('include routines are re-exported by their unit and are stubs', () => {
    // RUNEDIT1/2 are ported (runedit package): the unit re-exports them
    RunEdiPriv.BaseRec = 3;
    RunEdiPriv.IRec = 2;
    expect(CRec()).toBe(4);
    expect(typeof EditFreeTxt).toBe('function');
    expect(typeof StoreChptTxt).toBe('function'); // RUNPROJ is ported (proj-main package)
  });

  it('FandMain returns the Halt code (BASE halts without FAND.RES)', () => {
    const old = process.env.FANDRES;
    process.env.FANDRES = '/nonexistent-fandres-dir';
    try {
      expect(FandMain(null, [])).toBe(1);
    } finally {
      if (old === undefined) delete process.env.FANDRES;
      else process.env.FANDRES = old;
    }
  });
});
