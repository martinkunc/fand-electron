// PAS: CHNNEL.PAS – an older copy of unit Channel (CHANNEL.PAS -> channel.ts). NOT PORTED.
//
// Porting notes:
// * No unit uses CHNNEL; FAND.PAS/ACCESS use `channel` (and only with FandSQL, which is off).
// * Differences from CHANNEL.PAS: MaxBlkSz = 546 (not BLOCK_SIZE - BlkHeadSz), AnswerDelay = 109200
//   ticks (~100 min, not ~6 s), ErrText is a typed constant, SQLStream has no PutText/PutData.
// * Kept as a re-export so the module map stays one-to-one with the Pascal sources; the SQLStream
//   of channel.ts is the newer one (its PutText/PutData don't exist in this version).

export * from './channel.ts';
