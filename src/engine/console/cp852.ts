// Code page 852 (Latin-2, DOS) <-> Unicode. All Účto data is stored in CP852.
// Lower half 0x00-0x1F uses the IBM PC glyphs (as the VGA text mode shows them).

const LOW =
  '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼';
const HIGH =
  'ÇüéâäůćçłëŐőîŹÄĆÉĹĺôöĽľŚśÖÜŤťŁ×č' +
  'áíóúĄąŽžĘę¬źČş«»░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐' +
  '└┴┬├─┼Ăă╚╔╩╦╠═╬¤đĐĎËďŇÍÎě┘┌█▄ŢŮ▀' +
  'ÓßÔŃńňŠšŔÚŕŰýÝţ´­˝˛ˇ˘§÷¸°¨˙űŘř■ ';

export const CP852_TO_UNICODE: string[] = [];
for (let i = 0; i < 256; i++) {
  if (i < 0x20) CP852_TO_UNICODE[i] = LOW[i];
  else if (i < 0x7f) CP852_TO_UNICODE[i] = String.fromCharCode(i);
  else if (i === 0x7f) CP852_TO_UNICODE[i] = '⌂';
  else CP852_TO_UNICODE[i] = HIGH[i - 0x80];
}

const UNICODE_TO_CP852 = new Map<string, number>();
for (let i = 255; i >= 0; i--) UNICODE_TO_CP852.set(CP852_TO_UNICODE[i], i);
// Plain control characters map to themselves when encoding text.
for (const c of ['\r', '\n', '\t', '\b', '\x1b']) UNICODE_TO_CP852.set(c, c.charCodeAt(0));

/** Decode CP852 bytes to a JS string. Control bytes <0x20 become their glyphs unless keepControls. */
export function decode852(bytes: Uint8Array, keepControls = false): string {
  let s = '';
  for (const b of bytes) {
    s += b < 0x20 && keepControls ? String.fromCharCode(b) : CP852_TO_UNICODE[b];
  }
  return s;
}

export function encode852(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = UNICODE_TO_CP852.get(text[i]) ?? 0x3f;
  return out;
}

export function byteToChar(b: number): string {
  return CP852_TO_UNICODE[b & 0xff];
}

export function charToByte(c: string): number {
  return UNICODE_TO_CP852.get(c) ?? 0x3f;
}
