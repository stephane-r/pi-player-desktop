import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { existsSync, unlinkSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// mpv utilise en interne les mêmes démultiplexeurs ffmpeg/libavformat que notre ancien relais :
// les mêmes options de reconnexion s'appliquent, passées via --stream-lavf-o.
const MPV_SOURCE_ARGS = [
  '--user-agent=VLC/3.0.20 LibVLC/3.0.20',
];

const LAVF_RECONNECT_LIVE = 'reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5';
const LAVF_RECONNECT_VOD = `${LAVF_RECONNECT_LIVE},reconnect_at_eof=1`;

// Pilote un process mpv unique via son IPC JSON (socket Unix / pipe nommé Windows). mpv décode
// nativement AC3/DTS/etc. et gère lui-même le seek réseau : plus besoin de transcoder/segmenter
// côté serveur.
//
// mpv s'ouvre dans sa propre fenêtre système normale (barre de titre, redimensionnable, plein
// écran natif, OSD/raccourcis clavier mpv) — l'intégration "dans" la fenêtre Electron (--wid)
// n'est pas fiable sur macOS, et une fenêtre libre est de toute façon plus pratique à l'usage.
// Nos propres contrôles (play/pause, seek, pistes) restent utilisables en plus via l'IPC.
export class MpvPlayer extends EventEmitter {
  constructor({ mpvPath, socketPath }) {
    super();
    this.mpvPath = mpvPath;
    this.socketPath = socketPath;
    this.proc = null;
    this.socket = null;
    this.buffer = '';
    this.nextRequestId = 1;
    this.pending = new Map();
    this.nextObserveId = 1;
  }

  get pid() {
    return this.proc?.pid ?? null;
  }

  async start() {
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* déjà absent */ }
    }

    const args = [
      `--input-ipc-server=${this.socketPath}`,
      '--idle=yes',
      '--keep-open=yes',
      '--msg-level=all=warn',
      ...MPV_SOURCE_ARGS,
    ];

    // mpv écrit ses messages (--msg-level) sur stdout, pas stderr.
    this.proc = spawn(this.mpvPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (chunk) => this.emit('log', chunk.toString()));
    this.proc.stderr.on('data', (chunk) => this.emit('log', chunk.toString()));
    this.proc.on('exit', (code, signal) => this.emit('exit', { code, signal }));
    this.proc.on('error', (err) => this.emit('error', err));

    const deadline = Date.now() + 5000;
    while (!existsSync(this.socketPath)) {
      if (Date.now() > deadline) throw new Error('mpv: timeout de création du socket IPC');
      await sleep(50);
    }
    await this.#connect();
    await this.observeProperty('time-pos');
    await this.observeProperty('duration');
    await this.observeProperty('pause');
    await this.observeProperty('volume');
    this.on('mpv-event', (event, raw) => {
      if (event === 'file-loaded') this.#refreshTracks();
      if (event === 'end-file') {
        // reason: "eof" (fin normale), "error" (échec réseau/décodage), "stop"/"quit"/"redirect"
        // (transitions internes, ex. notre propre loadfile "replace") — seules les deux premières
        // doivent remonter jusqu'à l'utilisateur.
        if (raw.reason === 'error') this.emit('playback-error', raw.file_error || 'erreur de lecture mpv');
        else if (raw.reason === 'eof') this.emit('ended');
      }
    });
  }

  async #connect() {
    for (let attempt = 0; attempt < 30 && !this.socket; attempt++) {
      try {
        const socket = createConnection(this.socketPath);
        await once(socket, 'connect');
        this.socket = socket;
      } catch {
        await sleep(100);
      }
    }
    if (!this.socket) throw new Error('mpv: connexion IPC impossible');
    this.socket.on('data', (chunk) => this.#onData(chunk));
    this.socket.on('close', () => this.emit('socket-close'));
    this.socket.on('error', (err) => this.emit('error', err));
  }

  #onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.request_id && this.pending.has(msg.request_id)) {
        const { resolve, reject } = this.pending.get(msg.request_id);
        this.pending.delete(msg.request_id);
        if (msg.error && msg.error !== 'success') reject(new Error(msg.error));
        else resolve(msg.data);
        continue;
      }
      if (msg.event === 'property-change') {
        this.emit('property-change', msg.name, msg.data);
        continue;
      }
      if (msg.event) this.emit('mpv-event', msg.event, msg);
    }
  }

  async #refreshTracks() {
    try {
      const tracks = await this.getProperty('track-list');
      this.emit('tracks', {
        audio: tracks.filter((t) => t.type === 'audio').map((t) => ({ id: t.id, lang: t.lang || null, title: t.title || null, selected: !!t.selected })),
        subtitle: tracks.filter((t) => t.type === 'sub').map((t) => ({ id: t.id, lang: t.lang || null, title: t.title || null, selected: !!t.selected })),
      });
    } catch (err) {
      this.emit('log', `échec récupération des pistes: ${err.message}\n`);
    }
  }

  command(args) {
    if (!this.socket) return Promise.reject(new Error('mpv: non connecté'));
    return new Promise((resolve, reject) => {
      const request_id = this.nextRequestId++;
      const timer = setTimeout(() => {
        if (this.pending.has(request_id)) {
          this.pending.delete(request_id);
          reject(new Error('mpv: timeout de commande IPC'));
        }
      }, 10000);
      this.pending.set(request_id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.socket.write(JSON.stringify({ command: args, request_id }) + '\n');
    });
  }

  async observeProperty(name) {
    const id = this.nextObserveId++;
    await this.command(['observe_property', id, name]);
    return id;
  }

  getProperty(name) { return this.command(['get_property', name]); }
  setProperty(name, value) { return this.command(['set_property', name, value]); }

  async loadfile(url, kind = 'vod') {
    // reconnect_at_eof est fait pour un gros fichier (VOD) coupé en plein milieu par l'anti-abus du
    // panel ; sur un flux live HLS, chaque playlist/segment se termine normalement très vite, et ce
    // flag ferait croire à mpv qu'il s'agit d'une coupure à chaque fois → boucle de reconnexion
    // infinie. On ne l'active donc que pour la VOD.
    const lavfo = kind === 'live' ? LAVF_RECONNECT_LIVE : LAVF_RECONNECT_VOD;
    await this.setProperty('stream-lavf-o', lavfo);
    return this.command(['loadfile', url, 'replace']);
  }
  seek(seconds) { return this.command(['seek', seconds, 'absolute']); }
  seekRelative(seconds) { return this.command(['seek', seconds, 'relative']); }
  setPause(paused) { return this.setProperty('pause', paused); }
  setVolume(volume) { return this.setProperty('volume', volume); }
  setAudioTrack(id) { return this.setProperty('aid', id); }
  setSubtitleTrack(id) { return this.setProperty('sid', id ?? 'no'); }

  destroy() {
    try { this.socket?.destroy(); } catch { /* ignore */ }
    if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL');
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
    }
  }
}
