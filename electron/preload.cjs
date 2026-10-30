const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appInfo', {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  onUpdateStatus: (cb) => ipcRenderer.on('app:update-status', (_e, payload) => cb(payload)),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
});

contextBridge.exposeInMainWorld('player', {
  load: (url, kind) => ipcRenderer.invoke('player:load', { url, kind }),
  pause: () => ipcRenderer.invoke('player:pause'),
  resume: () => ipcRenderer.invoke('player:resume'),
  seek: (seconds) => ipcRenderer.invoke('player:seek', seconds),
  seekRelative: (seconds) => ipcRenderer.invoke('player:seek-relative', seconds),
  stop: () => ipcRenderer.invoke('player:stop'),
  setAudioTrack: (id) => ipcRenderer.invoke('player:set-audio-track', id),
  setSubtitleTrack: (id) => ipcRenderer.invoke('player:set-subtitle-track', id),
  setVolume: (volume) => ipcRenderer.invoke('player:set-volume', volume),

  onState: (cb) => ipcRenderer.on('player:state', (_e, payload) => cb(payload)),
  onLog: (cb) => ipcRenderer.on('player:log', (_e, line) => cb(line)),
  onTracks: (cb) => ipcRenderer.on('player:tracks', (_e, tracks) => cb(tracks)),
  onEnded: (cb) => ipcRenderer.on('player:ended', () => cb()),
  onError: (cb) => ipcRenderer.on('player:error', (_e, message) => cb(message)),
});
