import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MpvPlayer } from './mpv-ipc.js';

// Dev only : recharge le renderer (ou relance l'app si un fichier du main process change) à la
// sauvegarde. Le try/catch est nécessaire : en production le paquet n'est pas installé.
let reloader;
try { reloader = await import('electron-reloader'); } catch { /* absent en prod, normal */ }
reloader?.default(import.meta);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveMpvPath() {
  const candidates = [
    process.env.MPV_PATH,
    'mpv',
    '/opt/homebrew/bin/mpv',
    '/usr/local/bin/mpv',
    '/usr/bin/mpv',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'mpv' || existsSync(candidate)) return candidate;
  }
  return 'mpv';
}

let mainWindow = null;
let mpv = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Empêche le <title> de la page d'écraser le titre : on y ajoute "(dev)" en développement pour
  // distinguer la fenêtre d'une build release installée en parallèle.
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle(app.isPackaged ? 'P.I Player Desktop' : 'P.I Player Desktop (dev)');
  });

  mainWindow.on('closed', () => {
    mpv?.destroy();
    mpv = null;
    mainWindow = null;
  });
}

async function ensureMpv() {
  if (mpv) return mpv;

  const socketPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\piplayer-mpv'
    : path.join(tmpdir(), `piplayer-mpv-${process.pid}.sock`);

  mpv = new MpvPlayer({ mpvPath: resolveMpvPath(), socketPath });

  mpv.on('log', (line) => {
    console.error('[mpv]', line.trim());
    mainWindow?.webContents.send('player:log', line.trim());
  });
  mpv.on('error', (err) => {
    if (err.code === 'ENOENT') {
      dialog.showErrorBox(
        'mpv introuvable',
        "P.I Player Desktop a besoin de mpv pour lire les flux. Installe-le (par ex. `brew install mpv` sur macOS, ou depuis mpv.io sur Windows) puis relance l'application."
      );
      mpv = null;
      return;
    }
    mainWindow?.webContents.send('player:error', err.message);
  });
  mpv.on('playback-error', (message) => mainWindow?.webContents.send('player:error', message));
  mpv.on('exit', ({ code, signal }) => {
    console.log('[mpv] process exited', code, signal);
    mainWindow?.webContents.send('player:log', `mpv process exited (code=${code}, signal=${signal})`);
    mpv = null;
  });
  mpv.on('property-change', (name, value) => {
    if (name === 'time-pos' || name === 'duration' || name === 'pause') {
      mainWindow?.webContents.send('player:state', { name, value });
    }
  });
  mpv.on('tracks', (tracks) => mainWindow?.webContents.send('player:tracks', tracks));
  mpv.on('ended', () => mainWindow?.webContents.send('player:ended'));

  await mpv.start();
  return mpv;
}

ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('player:load', async (_event, { url, kind }) => {
  const player = await ensureMpv();
  await player.loadfile(url, kind);
});

ipcMain.handle('player:pause', () => mpv?.setPause(true));
ipcMain.handle('player:resume', () => mpv?.setPause(false));
ipcMain.handle('player:seek', (_event, seconds) => mpv?.seek(seconds));
ipcMain.handle('player:stop', () => mpv?.command(['stop']));
ipcMain.handle('player:set-audio-track', (_event, id) => mpv?.setAudioTrack(id));
ipcMain.handle('player:set-subtitle-track', (_event, id) => mpv?.setSubtitleTrack(id));

// Vérifie les Releases GitHub (publiées par .github/workflows/release.yml) au démarrage. Pas de
// vérification périodique : une seule fois par lancement suffit pour cet usage. Rien en dev — il
// n'y a pas de releases pour une build non empaquetée, et autoUpdater échouerait de toute façon.
ipcMain.handle('app:install-update', () => autoUpdater.quitAndInstall());

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  const sendStatus = (payload) => mainWindow?.webContents.send('app:update-status', payload);

  autoUpdater.on('checking-for-update', () => sendStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => sendStatus({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => sendStatus({ state: 'up-to-date' }));
  autoUpdater.on('download-progress', (p) => sendStatus({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => sendStatus({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => {
    console.error('[autoUpdater]', err);
    sendStatus({ state: 'error' });
  });

  autoUpdater.checkForUpdates().catch((err) => console.error('[autoUpdater] échec de vérification', err));
}

app.whenReady().then(() => {
  createMainWindow();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  mpv?.destroy();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
