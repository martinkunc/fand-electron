import { contextBridge, ipcRenderer } from 'electron';
import type { ScreenDiff } from '../engine/console/screen.ts';

const api = {
  sendKey: (code: number, shift: number) => ipcRenderer.send('fand:key', code, shift),
  onScreen: (fn: (d: ScreenDiff) => void) => {
    const h = (_e: unknown, d: ScreenDiff) => fn(d);
    ipcRenderer.on('fand:screen', h);
    return () => ipcRenderer.off('fand:screen', h);
  },
  onError: (fn: (msg: string) => void) => {
    const h = (_e: unknown, m: string) => fn(m);
    ipcRenderer.on('fand:error', h);
    return () => ipcRenderer.off('fand:error', h);
  },
};

export type FandApi = typeof api;
contextBridge.exposeInMainWorld('fand', api);
