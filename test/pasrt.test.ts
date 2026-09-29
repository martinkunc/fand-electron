import { describe, it, expect } from 'vitest';
import {
  ref, fref, aref, notImpl, NotImplementedError, GoExitSignal, FandRunError, HaltSignal, Halt,
  byte, word, int16, int32, shortint, uint32, Hi, Lo, Swap, Div, Mod, Round, Trunc, Frac, Int,
  ord, chr, Copy, Pos, Delete, Insert, StrDelete, StrInsert, UpCase, UPCASE_852, UpcaseStr, ShortStr,
  ToUnicode, FromUnicode, StrToBytes, BytesToStr, GetPStr, SetPStr, FillChar, Move,
  getWord, setWord, getInteger, getLongint, setLongint,
  StrI, StrR, ValI, ValR, Clock, GetDate, GetTime, FSplit, defineDefaults, defineAliases,
} from '../src/engine/pas/pasrt.ts';

describe('pasrt refs', () => {
  it('boxes, field and array refs', () => {
    const r = ref(1);
    r.v++;
    expect(r.v).toBe(2);
    const o = { a: 'x' };
    const f = fref(o, 'a');
    f.v = 'y';
    expect(o.a).toBe('y');
    const arr = [0, 1, 2];
    const e = aref(arr, 1);
    e.v = 7;
    expect(arr).toEqual([0, 7, 2]);
  });
});

describe('pasrt exceptions', () => {
  it('notImpl and signals', () => {
    expect(() => notImpl('X.Y')).toThrow(NotImplementedError);
    expect(() => Halt(3)).toThrow(HaltSignal);
    expect(new FandRunError(200).code).toBe(200);
    expect(new GoExitSignal()).toBeInstanceOf(Error);
    expect(() => Div(1, 0)).toThrow(FandRunError);
  });
});

describe('pasrt integers', () => {
  it('wraps like Pascal', () => {
    expect(byte(257)).toBe(1);
    expect(word(-1)).toBe(0xffff);
    expect(int16(0x8000)).toBe(-32768);
    expect(shortint(0xff)).toBe(-1);
    expect(int32(0x80000000)).toBe(-2147483648);
    expect(uint32(-1)).toBe(0xffffffff);
    expect(Hi(0x1234)).toBe(0x12);
    expect(Lo(0x1234)).toBe(0x34);
    expect(Swap(0x1234)).toBe(0x3412);
    expect(Div(-7, 2)).toBe(-3);
    expect(Mod(-7, 2)).toBe(-1);
  });
  it('reals', () => {
    expect(Round(2.5)).toBe(3);
    expect(Round(-2.5)).toBe(-3);
    expect(Round(1.4)).toBe(1);
    expect(Trunc(-1.7)).toBe(-1);
    expect(Int(-1.7)).toBe(-1);
    expect(Frac(1.25)).toBeCloseTo(0.25);
  });
});

describe('pasrt strings', () => {
  it('Copy/Pos/Delete/Insert', () => {
    expect(Copy('abcdef', 2, 3)).toBe('bcd');
    expect(Copy('abcdef', 0, 2)).toBe('ab');
    expect(Copy('abc', 5, 2)).toBe('');
    expect(Copy('abc', 2, 99)).toBe('bc');
    expect(Pos('cd', 'abcdef')).toBe(3);
    expect(Pos('x', 'abc')).toBe(0);
    expect(Pos('', 'abc')).toBe(0);
    const s = ref('abcdef');
    Delete(s, 2, 2);
    expect(s.v).toBe('adef');
    Delete(s, 10, 1);
    expect(s.v).toBe('adef');
    Insert('XY', s, 2);
    expect(s.v).toBe('aXYdef');
    expect(StrInsert('!', 'ab', 99)).toBe('ab!');
    expect(StrDelete('abc', 3, 5)).toBe('ab');
    expect(ShortStr('x'.repeat(300)).length).toBe(255);
    expect(StrInsert('z', 'y'.repeat(255), 1).length).toBe(255);
  });
  it('ord/chr/UpCase', () => {
    expect(ord('A')).toBe(65);
    expect(chr(0x1ff)).toBe('\xff');
    expect(UpCase('a')).toBe('A');
    expect(UpCase('\xa7')).toBe('\xa7'); // System.UpCase leaves national letters
    // CP852: ž 0xA7 -> Ž 0xA6, ř 0xFD -> Ř 0xFC, á 0xA0 -> Á 0xB5
    expect(UPCASE_852[0xa7]).toBe(0xa6);
    expect(UPCASE_852[0xfd]).toBe(0xfc);
    expect(UPCASE_852[0xa0]).toBe(0xb5);
    expect(UpcaseStr('ab\xfd')).toBe('AB\xfc');
  });
  it('CP852 byte strings', () => {
    const b = FromUnicode('Účto ř');
    expect(b.length).toBe(6);
    expect(b.charCodeAt(5)).toBe(0xfd);
    expect(ToUnicode(b)).toBe('Účto ř');
    expect(BytesToStr(StrToBytes(b))).toBe(b);
    const buf = new Uint8Array(10);
    SetPStr(buf, 2, 'abc');
    expect(buf[2]).toBe(3);
    expect(GetPStr(buf, 2)).toBe('abc');
  });
});

describe('pasrt memory', () => {
  it('FillChar/Move and LE accessors', () => {
    const b = new Uint8Array(8);
    FillChar(b, 3, 'x', 1);
    expect([...b.subarray(0, 5)]).toEqual([0, 120, 120, 120, 0]);
    Move(b, b, 4, 0, 2); // overlapping
    expect([...b.subarray(0, 6)]).toEqual([0, 120, 0, 120, 120, 120]);
    setWord(b, 0, 0xfffe);
    expect(getWord(b, 0)).toBe(0xfffe);
    expect(getInteger(b, 0)).toBe(-2);
    setLongint(b, 4, -5);
    expect(getLongint(b, 4)).toBe(-5);
  });
});

describe('pasrt Str/Val', () => {
  it('StrI', () => {
    expect(StrI(42)).toBe('42');
    expect(StrI(-42, 5)).toBe('  -42');
  });
  it('StrR fixed', () => {
    expect(StrR(3.14159, 0, 2)).toBe('3.14');
    expect(StrR(2.675, 8, 2)).toBe('    2.68');
    expect(StrR(-1.5, 0, 0)).toBe('-2');
    expect(StrR(0.5, 0, 0)).toBe('1');
    expect(StrR(9.99, 0, 1)).toBe('10.0');
    expect(StrR(0.006, 0, 2)).toBe('0.01');
    expect(StrR(0.0004, 0, 2)).toBe('0.00');
    expect(StrR(0.00123, 0, 4)).toBe('0.0012');
    expect(StrR(0, 5, 2)).toBe(' 0.00');
    expect(StrR(1234567.891, 0, 2)).toBe('1234567.89');
    expect(StrR(1e22, 0, 0)).toBe('10000000000000000000000');
    expect(StrR(0.1 + 0.2, 0, 20)).toBe('0.30000000000000000000');
  });
  it('StrR scientific', () => {
    expect(StrR(123.45)).toBe(' 1.2345000000E+02');
    expect(StrR(-0.001)).toBe('-1.0000000000E-03');
    expect(StrR(0)).toBe(' 0.0000000000E+00');
    expect(StrR(1.5, 10)).toBe(' 1.500E+00');
    expect(StrR(1.5, 1)).toBe(' 1.5E+00');
    expect(StrR(9.99999999999)).toBe(' 1.0000000000E+01');
  });
  it('ValI', () => {
    const v = ref(0);
    const c = ref(0);
    ValI('  123', v, c);
    expect([v.v, c.v]).toEqual([123, 0]);
    ValI('-$1F', v, c);
    expect([v.v, c.v]).toEqual([-31, 0]);
    ValI('12x', v, c);
    expect(c.v).toBe(3);
    ValI('', v, c);
    expect(c.v).toBe(1);
    ValI('2147483648', v, c);
    expect(c.v).not.toBe(0);
    ValI('-2147483648', v, c);
    expect([v.v, c.v]).toEqual([-2147483648, 0]);
  });
  it('ValR', () => {
    const v = ref(0);
    const c = ref(0);
    ValR(' 1.5e3', v, c);
    expect([v.v, c.v]).toEqual([1500, 0]);
    ValR('-.25', v, c);
    expect([v.v, c.v]).toEqual([-0.25, 0]);
    ValR('1,5', v, c);
    expect(c.v).toBe(2);
    ValR('1e', v, c);
    expect(c.v).toBe(3);
    ValR('-', v, c);
    expect(c.v).toBe(2);
  });
});

describe('pasrt DOS', () => {
  it('GetDate/GetTime use the replaceable clock', () => {
    const saved = Clock.now;
    Clock.now = () => new Date(2026, 8, 28, 13, 45, 7, 560);
    try {
      const y = ref(0), m = ref(0), d = ref(0), w = ref(0);
      GetDate(y, m, d, w);
      expect([y.v, m.v, d.v, w.v]).toEqual([2026, 9, 28, 1]);
      GetTime(y, m, d, w);
      expect([y.v, m.v, d.v, w.v]).toEqual([13, 45, 7, 56]);
    } finally {
      Clock.now = saved;
    }
  });
  it('FSplit', () => {
    const d = ref(''), n = ref(''), e = ref('');
    FSplit('C:\\UCTO\\DATA.000', d, n, e);
    expect([d.v, n.v, e.v]).toEqual(['C:\\UCTO\\', 'DATA', '.000']);
    FSplit('/tmp/x', d, n, e);
    expect([d.v, n.v, e.v]).toEqual(['/tmp/', 'x', '']);
  });
});

describe('pasrt variant records', () => {
  it('prototype zero defaults, lazy embedded values and aliases', () => {
    class R {
      declare P1: R | null;
      declare N: number;
      declare Arr: number[];
      declare PP1: R | null;
    }
    defineDefaults(R, { P1: null, N: 0, Arr: () => [0, 0] });
    defineAliases(R, { PP1: 'P1' });
    const a = new R();
    const b = new R();
    expect(a.P1).toBeNull();
    expect(a.N).toBe(0);
    a.Arr[1] = 5;
    expect(b.Arr[1]).toBe(0);
    expect(a.Arr[1]).toBe(5);
    a.PP1 = b;
    expect(a.P1).toBe(b);
    expect(Object.keys(new R())).toEqual([]);
  });
});
