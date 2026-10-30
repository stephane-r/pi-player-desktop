const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appInfo', {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
});

contextBridge.exposeInMainWorld('player', {
  load: (url, kind) => ipcRenderer.invoke('player:load', { url, kind }),
  pause: () => ipcRenderer.invoke('player:pause'),
  resume: () => ipcRenderer.invoke('player:resume'),
  seek: (seconds) => ipcRenderer.invoke('player:seek', seconds),
  stop: () => ipcRenderer.invoke('player:stop'),
  setAudioTrack: (id) => ipcRenderer.invoke('player:set-audio-track', id),
  setSubtitleTrack: (id) => ipcRenderer.invoke('player:set-subtitle-track', id),

  onState: (cb) => ipcRenderer.on('player:state', (_e, payload) => cb(payload)),
  onLog: (cb) => ipcRenderer.on('player:log', (_e, line) => cb(line)),
  onTracks: (cb) => ipcRenderer.on('player:tracks', (_e, tracks) => cb(tracks)),
  onEnded: (cb) => ipcRenderer.on('player:ended', () => cb()),
  onError: (cb) => ipcRenderer.on('player:error', (_e, message) => cb(message)),
});
