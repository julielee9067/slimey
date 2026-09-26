const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onState: (handler) => ipcRenderer.on('state', (_e, s) => handler(s)),
  open: (url) => ipcRenderer.send('open', url),
  move: (dx, dy) => ipcRenderer.send('move', dx, dy),
  throw: (vx, vy) => ipcRenderer.send('throw', vx, vy),
  stop: () => ipcRenderer.send('stop'),
  list: (open) => ipcRenderer.send('list', open),
  onList: (handler) => ipcRenderer.on('list', (_e, open) => handler(open)),
  onBounce: (handler) => ipcRenderer.on('bounce', (_e, hit, impact) => handler(hit, impact)),
});
