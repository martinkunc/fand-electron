// PAS: KBDWW.PAS – dead include: not {$I}-ed by any unit in either the FPC or the BP7 sources.
//
// Porting notes:
// * It is an older merge of display/message code that now lives elsewhere; nothing to port.
//   Every routine has a live counterpart (same name, same semantics unless noted):
//   - DISPLAY: LenStyleStr, LogToAbsLenStyleStr, SetStyleAttr, WrStyleStr, WrLongStyleStr,
//     RectToPixel -> BASE (common.ts); WrStyleChar and CStyle/CColor are private there.
//   - windows: PushWParam, PopWParam, PushScr, PopScr, PushW1, PushW, PopW, PopW2, WriteWFrame,
//     CenterWw, PushWFramed (WParam, WGrBuf, MaxGrBufSz) -> OBASEWW (obaseww.ts).
//   - MESSAGES: MsgPar, SetMsgPar..Set4MsgPar, WriteMsg, ClearLL -> BASE (common.ts, BaseVars.MsgPar);
//     WrLLMsg, PushWrLLMsg, WrLLMsgTxt, WrLLF10MsgLine, WrLLF10Msg, PromptYN, RunError -> OBASEWW.
//     (KBDWW's RunError also kept RunErrNr; the live one does not.)
// * The only difference from OBASEWW.PopW2 is the BP7 `inc(wofs, sizeof(WParam))` spelling.

export {};
