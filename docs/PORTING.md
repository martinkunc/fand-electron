# Porting PC FAND Pascal to TypeScript

Rules for everyone porting a PC FAND unit to `src/engine/pas/`. The foundation
(`pasrt.ts` and the typed skeletons of BASE, DRIVERS, ACCESS with its includes, RDRUN)
already follows them. Read `src/engine/pas/pasrt.ts` along with this file.

## 1. Sources and precedence

| Source | Role |
|---|---|
| `vendor/reference/standa_pcfand/pas` (branch `fpc-migration`) | **Primary.** The asm and DOS code is already rewritten in Pascal. |
| `vendor/reference/alisoss_pcfand/pas` (BP7, MIT) | Cross-check, especially in `{$ifdef FPC}` places. |
| `vendor/reference/spainhell_cppfand` | Read only, to understand the code. No license, so never copy from it. |

Build flags (`SWITCHES.PAS`): `FandNetV`, `FandDML`, `FandProlog`, `FandLProc` are defined;
`FandSQL`, `FandGraph`, `FandDemo`, `FandRunV`, `FandAng`, `Trial`, `Coproc` are not.
Port only the active branches. For `FPC` versus not-`FPC`, follow the FPC branch.

**BP7 wins where observable behaviour or on-disk formats differ.** Účto data must stay
usable by the Windows `UFAND.EXE`, which is a BP7 build. Known FPC-port deviations:

* `XString.StoreD` moves 6 bytes of a *double*. BP7 stores the Real48, so .X keys on R/D fields must be Real48.
* `CompLexStr`/`CompLexLongStr`/`CompLexLongShortStr` and `XString.StoreA` (CompLex): BP7
  `TranslateOrd` treats Czech **ch** as one letter sorted after H (`$4A`). The FPC code dropped this.
* `TFile.TimeStmp` and `WDaysFirst/Last`: the FPC code moves raw double bytes. They are Real48.
* `ReplaceChar(S, ...)`: the BP7 asm version changes the caller's string, so it takes a `Ref`.
* `Round`: BP7 (software Real48) rounds halves away from zero. `pasrt.Round` does this.

The reference FAND binary (docs/REFERENCE.md) is the FPC build. When it disagrees with BP7
in these places, it is the reference that is wrong.

## 2. Modules

* One module per Pascal source file, in lowercase, in `src/engine/pas/`: `ACCESS.PAS` becomes `access.ts`,
  `RUNEDIT1.PAS` becomes `runedit1.ts`.
* **Include files** (`{$I ...}`) get their own modules, and the unit re-exports them with
  `export * from './fileacc.ts'`. Examples: BASE includes `common.ts`, `handle.ts` and `memory.ts`;
  DRIVERS includes `keybd.ts`; ACCESS includes `type.ts`, `fileacc.ts`, `index.ts` and `recacc.ts`.
  Their state lives in the unit's state object. Callers import from the unit module only.
* An FPC rewrite `XxxFPC.PAS` of an include uses the base name: `COMMONFPC.PAS` becomes `common.ts`,
  and `DISKFPC.PAS` becomes `disk.ts`.
* `index.ts` is the INDEX.PAS module, not a directory index. Always import it as `./index.ts`.
* Object types (`= object`) live in the module that implements their methods, and the unit
  re-exports them. Examples: TFile/FileD are in `fileacc.ts`; XString, XItem, XPage, XWFile, XFile, XKey, XWKey
  and XScan are in `index.ts`.
* Relative imports always carry the `.ts` extension. Node runs the sources through **type
  stripping**, so `enum`, `namespace`, parameter properties (`constructor(public x)`) and
  other non-erasable syntax are forbidden. `declare` fields are fine.
* Style: 2-space indent, single quotes, short comments that say why.

## 3. Identifiers and origin comments

Keep Pascal identifiers verbatim (`CFile`, `CRecPtr`, `RdPrefix`, `FileD`, `_ShortS`, `S_`),
including their case. Every ported routine, method and type has an origin comment:

```ts
// PAS: FILEACC.PAS TFile.RdPrefix
RdPrefix(Chk: boolean): void { ... }
```

A helper that has no Pascal counterpart is marked `TS-only`.

## 4. Unit state: `<Unit>Vars`

ES module bindings can't be assigned from other modules. Each unit therefore exports **one**
mutable object that holds all of its interface variables and **typed constants** (typed
constants are variables in TP):

```ts
export const AccessVars = {
  CFile: null as FileDPtr,
  CRecPtr: null as Uint8Array | null,
  EdBreak: 0,
  ...
};
// use: AccessVars.CFile = FD;  const cf = AccessVars.CFile!;
```

The names are `BaseVars`, `DriversVars`, `AccessVars` and `RdRunVars`. New units follow the same
pattern: `RunFrmlVars`, `CompileVars` and so on. For example, `COMPILE.PAS` gets `CompileVars`.

* **Untyped constants** (`const X = 5`, `_equ = #1`) are plain `export const`.
* **Private globals** of an implementation section are module-level `let`/`const`.
* **`absolute` overlays** become accessors. `Chpt` is a getter/setter on `AccessVars` that
  aliases `FileDRoot`. `WordVarArr` (words over `RprtLine..UserCode`) is a Proxy with the
  same names, plus the helpers `GetWordVar`/`SetWordVar`.
* A state field that holds an instance of a class from another module is a **lazy getter**,
  for example `AccessVars.TWork` and `RdRunVars.OldMXStr`. See section 5.
* **Unit initialization** (`begin ... end.` of a unit) becomes `export function Init<Unit>()`,
  for example `InitBase`. The engine start-up calls these in Pascal unit order. Never do I/O at import time.

## 5. Imports and cycles

Pascal units use each other circularly in their implementations, and so do our modules.
This works as long as **no module uses another ported module's export at module top level**.
Use them only inside functions, methods, field initialisers and lazy getters.
The following are safe at top level:

* `pasrt.ts`, `src/engine/console/*`, `src/engine/fand/*` (leaf modules),
* `import type` (erased),
* `class A extends B` only when both are in the **same** module. That is why `XScan` doesn't
  `extend` DRIVERS' `TObject`: it has its own `Done()`.

## 6. Type mapping

| Pascal | TypeScript |
|---|---|
| `byte, shortint, word, integer, longint` | `number`. Wrap explicitly where overflow matters: `byte() word() int16() int32() uint32()` |
| `real, float, double, extended, comp` | `number`. Real48 only when stored (`fand/numbers.ts` `readReal48`/`writeReal48`). |
| `boolean` | `boolean` (stored as 0/1, and 0xFF is also false in 'B' fields) |
| `char` | 1-char **byte string** (`'\x1b'`, `chr(n)`, `ord(c)`) |
| `string`, `string[N]`, `ShortString` | **byte string**: a JS string whose char codes are CP852 bytes 0..255. Truncate with `ShortStr(s, N)` where Pascal truncates. |
| `StringPtr` (`^string`) | `string \| null` (the string itself; `StoreStr(s)` returns `s`) |
| `LongStr`, `LongStrPtr` | `Uint8Array` whose length is `LL`. `LongStrPtr \| null` where nil occurs. `S^.A[i]` becomes `S[i-1]`. |
| `CharArr`/`CharArrPtr` (`array[1..]`) | `Uint8Array`, where Pascal `A[i]` becomes `u8[i-1]`. `InpArrPtr` is the same array as the LongStr it came from. |
| record buffer (`CRecPtr`, `RecPtr`, `pointer` to data) | `Uint8Array` of `RecLen+2` bytes. Use `getWord/setWord/getInteger/getLongint/setLongint` (LE) from `pasrt` and the codecs in `fand/numbers.ts`. A pointer into a record is a `subarray()` view. |
| `^Record` (`FileDPtr`, `FrmlPtr`, ...) | `X \| null`. Each `XxxPtr` type alias is declared next to its class. |
| `^byte`, `^word`, `FloatPtr`, other typed scalar pointers | `Ref<number> \| null` |
| untyped `pointer` with a varying target | `Pointer` (`unknown`), cast at use. Heap marks are always `Pointer`. |
| `array[1..N] of T` | JS array of length N+1. **Index 0 is unused**, so Pascal indices stay verbatim (`MsgPar[1]`, `IDA[i]`, `XPath[i]`, `TArg[N]`, `Arg[i]`). Open-ended `[1..1]`/`[1..2]` arrays grow as needed. |
| `array[0..N] of T` | normal 0-based JS array |
| `array[char] of char` (`UpcCharTab`, `CharOrdTab`) | `Uint8Array(256)`, where `UpcCharTab[c]` becomes `chr(tab[ord(c)])` (or `UpcaseStr(s, tab)`) |
| enumerations | `export type LockMode = number` and one `export const` per value, in declaration order (`NullMode = 0`, ...). Keep the ordinals, because code compares and indexes with them (`LockModeTxt[md]`). `PInstrCodeNames` maps back to names. |
| `set of ...` | explicit comparisons, or a `Set<number>` |
| procedural types | function types `\| null` (`RdFldNameFrml: ((FTyp: Ref<string>) => FrmlPtr) \| null`) |
| `text` | `pasrt.TextFile`. The unit that writes it (reports, the CRT) implements the I/O. |
| DOS `PathStr/DirStr/NameStr/ExtStr` | `string` (byte strings) |
| screen cell buffers (`ScrPush`, `ScrWrBuf`, `ScrRdBuf`) | `Uint16Array`, one word per cell: low byte = CP852 char, high byte = attribute. `ScrPush` returns `[SizeX, SizeY, cells...]`. |

## 7. Records

* A record is a **class with zero-initialised fields**. `new X()` is `GetZStore(sizeof(X))`.
* A record allocated with trailing data gets extra fields:
  * `Name: string[1] {curr. length}` becomes `Name: string`.
  * The mask after a FieldDescr name is `FieldDescr.Mask`, and `FieldDMask(F)` returns it.
  * The bytes after a StringListEl (ViewNames user codes) are `StringListEl.After`.
  * The `GetOp(Op, BytesAfter)` inline data is `FrmlElem.Inline: Uint8Array` (FPC `FrmlInline`).
  * Variable-length pointer arrays are JS arrays: `FrmlElem.Arg[1..]`, `Instr.TArg[1..N]`.
* **Big variant records** (`FrmlElem`, `Instr`, `AssignD`) declare every variant field with
  `declare` and get prototype defaults via `defineDefaults`. Every field reads as its
  zero value until set, but an instance stores only the fields that were assigned. Embedded records and
  arrays (`Instr.WD`, `Instr.W`, `Instr.PPos`, `FrmlElem.Arg`) are created per instance on first access.
* **Same-type fields at the same Pascal offset** in different variants are accessor aliases
  (`defineAliases`), so a write through one name is visible through the other:
  * FrmlElem: `P1 = PP1 = P011 = Frml = PPP1 = PPPP1 = PPPPP1 = PPPPPP1 = EvalP1 = ownBool`, `P2 = PP2 = PPP2 = PPPP2 = ownSum`, `P3 = PP3`
  * Instr: `Frml0..3 = Frml`, `Add1/Add2 = Add`, `AssLV2 = AssLV`, `TxtPath1/2 = TxtPath`, `TxtCatIRec1/2 = TxtCatIRec`, `W2 = W`, `Attr2 = Attr`
  * AssignD: `Add1/Add2 = Add`, `Frml1/Frml2 = Frml`

  Different-type overlays (bytes N01.. over pointers, TypAndFrml `Name` over `RecPtr`) are
  separate fields. The class comment says what to test instead of the overlay.
* Small variant records simply have all the fields of all variants.
* **Record assignment copies** in Pascal (`A := B`, and `Pos := Z^.Pos` for RdbPos). Objects are
  references, so use `CopyRec(b)`, or `AssignRec(a, b)` into an existing object, whenever the
  copy could later be mutated independently. Embedded records need their own copy.
* **`FrmlPtr(@X^.Op)`**: some records double as formula nodes: LocVar (`Op`, `BPOfs`),
  SumElem (`Op`, `R`), InpD (`Op`/`Count`, `OpErr`/`Error`, `OpWarn`/`Warning`) and
  `MergOpGroup`. Use `FrmlAt(x, { Op: 'Op', R: 'Count' })`, which returns a cached live view.
* A block `Move` over a range of fields (e.g. RUNEDIT1 copies the `EditD` fields
  `FirstEmptyFld..SelMode` to and from globals) becomes a field-by-field copy. `EditDCopiedFields`
  lists these fields.

## 8. Objects (`= object`)

* Objects become classes, and methods become methods. Pascal `private` members are plain fields and methods,
  since they are visible to the whole unit.
* `constructor Init(...)` becomes a method `Init(...): this`, so `New(P, Init(a))` becomes
  `P = new XScan().Init(a)`. A destructor `Done` becomes `Done()`.
* Pascal object inheritance maps to `extends`, but only within one module (see section 5).
* Page and item objects that Pascal overlays on raw bytes are views. `XPage.Raw` is the page, and
  `IsLeaf`, `GreaterPage`, `NItems` and `A` are accessors. `XItem` is a cursor `(Pg, Ofs)`. `XPageOfs`
  values are offsets from the page start (`A` starts at 7).

## 9. Parameters

* **Value parameters** are passed as they are. Strings and numbers are immutable anyway.
* A **`var`/`out` parameter of a scalar, string, boolean or pointer type** becomes `Ref<T>` (`{ v: T }`):
  ```ts
  // procedure SplitDate(R:float; var d,m,y:word)
  export function SplitDate(R: float, d: Ref<number>, m: Ref<number>, y: Ref<number>): void
  const d = ref(0), m = ref(0), y = ref(0); SplitDate(r, d, m, y); use(d.v);
  ```
  To pass a field or array element, use `fref(obj, 'Field')` or `aref(arr, i)`, for example
  `ChainLast(fref(FD, 'Keys'), K)` for `ChainLast(FD^.Keys, K)`.
* A **`var` parameter of a record or object type** that the callee only mutates is passed as the object
  itself (`SearchKey(XX: XString, ...)`, `NewExit(POvr, Buf: ExitRecord)`). Use `Ref` only when the
  callee replaces the whole variable.
* **Untyped `var Buf`** (with a length) becomes `Uint8Array`. Pascal `P(A[i], n)` becomes
  `P(a.subarray(i-1), n)` or a view at the field. Strings passed as buffers are converted
  (`StrToBytes`/`BytesToStr`). A routine that is mostly called with strings may get an extra `...Str`
  variant that returns the new string.
* A **function result variable** becomes a local `let result`. `exit` becomes `return`.

## 10. Heap

`GetStore/GetZStore/GetStore2/GetZStore2(n)` return a fresh `Uint8Array(n)`. Records are
created with `new`. `MarkStore*/ReleaseStore*/ReleaseBoth/ReleaseAfterLongStr` are no-ops,
and a mark is a `Ref<Pointer>` set to `null`. `StoreAvail`, and `MemAvail`/`MaxAvail` wherever
they appear, return `BigStoreAvail`. Overlays and XMS are ignored.

## 11. Non-local exits and errors

| Pascal | TypeScript |
|---|---|
| `GoExit` (BASE) | `GoExit()`: restores `ExitP/BreakP/MyBP` from `BaseVars.ExitBuf` and throws `GoExitSignal`. With no armed NewExit it throws `HaltSignal(2)`, as FPC does. |
| FAND `RunError(N)` (OBASEWW: shows message N, `EdBreak:=3`, `GoExit`) | port OBASEWW.RunError; it ends in `GoExit()` |
| `System.RunError(n)`, RTL errors (div by 0, ...) | `SysRunError(n)` throws `FandRunError(n)`. It is fatal and unwinds the task. |
| `Halt(n)` | `Halt(n)` throws `HaltSignal(n)` |
| engine shutdown (window closed) | `EngineShutdown` (console/crt.ts), thrown by `Crt.readKey` |

The `NewExit` pattern replaces `NewExit(Ovr, er); ... goto label on GoExit ... RestoreExit(er)`:

```ts
const er = new ExitRecord();
NewExit(null, er);
try {
  ... // body; any GoExit() below jumps to the catch
} catch (e) {
  if (!(e instanceof GoExitSignal)) throw e; // never swallow other errors
  ... // code at the Pascal label (GoExitFired = true)
} finally {
  RestoreExit(er);
}
```

A `catch` only catches `GoExitSignal`, or the specific error it handles. `EngineShutdown`,
`HaltSignal`, `FandRunError` and `NotImplementedError` must propagate. A `goto` becomes structured
control flow: labelled loops, `break`/`continue`, flags, or a local function.

## 12. Byte strings at the boundaries

* **Screen:** only DRIVERS touches the `Crt`/`Screen` (bound once with `SetDriversCrt(crt)`).
  Screen cells hold Unicode characters, so DRIVERS converts each byte with `byteToChar`
  (console/cp852.ts) when it writes, and back with `charToByte` in `ScrRdBuf`/`ScrPush`. Everything
  above DRIVERS works with CP852 byte strings and attributes, exactly like Pascal.
  ```ts
  // PAS: DRIVERS.PAS ScrWrStr
  export function ScrWrStr(X: number, Y: number, S: string, Color: number): void {
    const scr = GetDriversCrt().screen;
    for (let i = 0; i < S.length; i++) scr.setCell(X + i, Y, byteToChar(S.charCodeAt(i)), Color);
  }
  ```
* **Keyboard:** `Crt.readKey()` returns a `KeyEvent` whose `code` is the BIOS word with the
  CP852 char in the low byte, which is what `ReadKey`/`KbdChar` expect. `Crt.keyPressed()` is
  `KeyPressed`. The Scr* routines use absolute 0-based coordinates, as `Screen.setCell` does.
* **Host file names and messages:** use `ToUnicode(path)` and `FromUnicode(u)` at the `node:fs` boundary
  (HANDLE). Every path goes through `UnixPath` before `node:fs` sees it. `UnixPath` maps DOS-style
  input (`\`, `C:`, any case) to the host: drive roots come from `FAND_DRIVE_x`, and each component
  is looked up case-insensitively.
* **DOS view of paths (BP7 wins):** FAND programs parse paths as on DOS. For example, Účto's
  `LogName` does `EndTxt('\',F.Path)`, and its code appends `'\'` to directories. So on
  macOS/Linux, `fand.ts` `main` turns on `HANDLE.DosView`, and the task sees DOS paths:
  * `C:` is the parent of the application directory (`C:\UCTO\...`), and `Z:` is `/`.
  * `DirectorySeparator` is `'\'`.
  * `GetDirDos`, the `FExpand` copies (`DosFExpand`), `FandDir`, `MyFExpand` and the catalogue paths
    are all DOS paths.
  * `HostToDos` converts a host path, for example from the environment or from a catalogue written
    by an older run.

  Code that works on host directories itself (RUNBATCH `--source-in`, helpers) keeps host paths.
  Helpers map DOS arguments with `dosToHost`, which uses `FAND_DRIVE_x`.

  The view is off where `main` doesn't run (unit tests of single units), on Windows, and with
  `FAND_DOSPATHS=0`. The bring-up turns it off to compare with the FPC reference, which uses host
  paths.
* **Environment:** `GetEnv` returns a byte string.

## 13. Numbers and text conversion

* `Str(i:w)` becomes `StrI(i, w)`. `Str(r:w:d)` becomes `StrR(r, w, d)`, and `StrR(r)` / `StrR(r, w)` give
  BP7 scientific output (`' 1.2345000000E+02'`). `Val` becomes `ValI(s, v, code)` for integer types
  and `ValR(s, v, code)` for reals. `code` is the 1-based position of the error, or 0.
* `div`/`mod` become `Div`/`Mod` (they truncate, and division by zero is RunError 200), or plain `Math.trunc(a/b)` and `a % b`
  when the divisor can't be 0. `Round` rounds halves away from zero. `Trunc`, `Int` and `Frac` are also available.
* `shl`/`shr` on longint become `<<` and `>>>` (TP `shr` is logical). Mask to the Pascal width when the
  result is stored in a word or byte.
* FAND computed in software Real48 (about 11–12 significant digits). We compute in double, so results can
  differ in the last digits. The digits only matter when they are stored (Real48/F fields round) or
  printed (`StrR` rounds on 15 significant digits).
* Dates: FAND day numbers (`RDate`/`SplitDate` in common.ts). The host clock is `pasrt.GetDate/GetTime`,
  and tests can replace `Clock.now`.

## 14. Local variables of procedures

The Pascal frame `ProcStkD` + `LVBD.Size` bytes becomes a `ProcStkD` whose values live in
`V: (number | boolean)[]`, **indexed by `LocVar.BPOfs`**. 'S' holds a TWork position, 'R' a number and 'B' a boolean.
`LocVarAd(LV)` returns a `Ref` to that slot in `BaseVars.MyBP`. `ResetLVBD` starts `Size` at 8, so
BPOfs values are the same as in BP7. `PushProcStk` must set each slot to its typed zero (0 or false)
before it evaluates the `Init` formulas. Record and index variables ('r', 'i', 'f') live in `LocVar.RecPtr`/`FD`
and never in the frame.

## 15. Files, locking, OS

* Files use the synchronous `node:fs` APIs behind the HANDLE handle table. Handles are small numbers, and `$FF` means none.
  `HandleError` holds DOS error codes (see `DosErrH` in HANDLE.PAS).
* Record/file locking uses in-process, single-user semantics: `TryLockH` always succeeds, as in the
  FPC port. Mark this with `// TODO network locking` where it matters.
* Everything is synchronous. The engine runs in a worker, and blocking waits use `Atomics.wait`
  (`Crt.readKey`, `Crt.delay`).

## 16. Not ported now

The following get typed stubs that call `notSupported('UNIT.Name')`: BGI graphics (GR*.PAS, RUNGRAPH),
SQL/channels (CHANNEL, CHNNEL), DML/FANDDML and IPX. Prolog (RDPROLG, RUNPROLG) **is** needed
and will be ported. GRAPH instructions are still parsed (the `FandGraphParse` flag is on in FPC), so
their record types exist in rdrun.ts.

## 17. Stubs

Every routine that isn't implemented yet keeps its exact Pascal signature:

```ts
// PAS: RECACC.PAS _R
export function _R(F: FieldDPtr): float {
  return notImpl('ACCESS._R');
}
```

The name is `UNIT.Routine` (or `UNIT.Object.Method`) and uses the unit name, even when the code is in an include.
When you port a routine, replace the body and keep the origin comment. Trivial routines of the
skeletons are already implemented: chains, Min/Max, message parameters, compare functions,
record flags, heap and exits, and a few others.

## 18. Tests

Use `npx vitest run` and `npx tsc -p .` (both must pass). Unit tests go in `test/<unit>.test.ts`.
Behaviour is checked end-to-end against the reference FAND with `src/engine/testing/refdriver.ts`
(docs/REFERENCE.md). Never modify `vendor/extracted` or `work/ucto`. When you need a writable
Účto copy, make your own under `work/tmp-<name>/`.
