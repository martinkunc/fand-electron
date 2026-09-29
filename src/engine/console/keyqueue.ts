// Keyboard ring buffer shared between the UI side (producer) and the engine worker
// (consumer). The engine blocks in Atomics.wait like BIOS INT 16h, so the ported
// Pascal code can keep its synchronous ReadKey/KeyPressed structure.

const HEAD = 0; // next slot to read (consumer)
const TAIL = 1; // next slot to write (producer)
const CLOSED = 2;
const HDR = 4;
const SLOTS = 256;

export class KeyQueue {
  readonly sab: SharedArrayBuffer;
  private a: Int32Array;

  constructor(sab?: SharedArrayBuffer) {
    this.sab = sab ?? new SharedArrayBuffer((HDR + SLOTS * 2) * 4);
    this.a = new Int32Array(this.sab);
  }

  /** Producer: enqueue a key (drops the key when the buffer is full, like the BIOS beep). */
  push(code: number, shift = 0): boolean {
    const tail = Atomics.load(this.a, TAIL);
    const head = Atomics.load(this.a, HEAD);
    if ((tail + 1) % SLOTS === head) return false;
    this.a[HDR + tail * 2] = code;
    this.a[HDR + tail * 2 + 1] = shift;
    Atomics.store(this.a, TAIL, (tail + 1) % SLOTS);
    Atomics.notify(this.a, TAIL);
    return true;
  }

  close(): void {
    Atomics.store(this.a, CLOSED, 1);
    Atomics.notify(this.a, TAIL);
  }

  get closed(): boolean {
    return Atomics.load(this.a, CLOSED) === 1;
  }

  /** Consumer: is a key waiting? (KeyPressed) */
  available(): boolean {
    return Atomics.load(this.a, HEAD) !== Atomics.load(this.a, TAIL);
  }

  /** Consumer: peek without removing. */
  peek(): { code: number; shift: number } | null {
    const head = Atomics.load(this.a, HEAD);
    if (head === Atomics.load(this.a, TAIL)) return null;
    return { code: this.a[HDR + head * 2], shift: this.a[HDR + head * 2 + 1] };
  }

  /**
   * Consumer: blocking read (ReadKey). Returns null when the queue is closed or the
   * timeout (ms) expires. Must only be called off the main thread.
   */
  read(timeoutMs = Infinity): { code: number; shift: number } | null {
    const deadline = timeoutMs === Infinity ? Infinity : Date.now() + timeoutMs;
    for (;;) {
      const head = Atomics.load(this.a, HEAD);
      const tail = Atomics.load(this.a, TAIL);
      if (head !== tail) {
        const k = { code: this.a[HDR + head * 2], shift: this.a[HDR + head * 2 + 1] };
        Atomics.store(this.a, HEAD, (head + 1) % SLOTS);
        return k;
      }
      if (this.closed) return null;
      const wait = deadline === Infinity ? Infinity : deadline - Date.now();
      if (wait <= 0) return null;
      Atomics.wait(this.a, TAIL, tail, wait);
    }
  }
}
