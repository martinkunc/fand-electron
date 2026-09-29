// Engine worker thread: runs the (synchronous) FAND engine off the UI thread.
// Messages in:  { type: 'start', sab, appDir, project?, cols?, rows? }
// Messages out: { type: 'screen', diff } | { type: 'exit', code } | { type: 'error', message }

import { parentPort } from 'node:worker_threads';
import { KeyQueue } from './console/keyqueue.ts';
import { Crt, EngineShutdown } from './console/crt.ts';
import { runFand, type RunOptions } from './runtime/fand.ts';
import { setHostPost } from './hostbridge.ts';

export interface StartMessage extends RunOptions {
  type: 'start';
  sab: SharedArrayBuffer;
  cols?: number;
  rows?: number;
}

parentPort!.once('message', (msg: StartMessage) => {
  setHostPost((req) => parentPort!.postMessage(req));
  const crt = new Crt(new KeyQueue(msg.sab), (diff) => parentPort!.postMessage({ type: 'screen', diff }), msg.cols ?? 80, msg.rows ?? 25);
  let code = 0;
  try {
    code = runFand(crt, msg);
  } catch (e) {
    if (!(e instanceof EngineShutdown)) {
      parentPort!.postMessage({ type: 'error', message: (e as Error).stack ?? String(e) });
      code = 1;
    }
  }
  crt.flush();
  parentPort!.postMessage({ type: 'exit', code });
});
