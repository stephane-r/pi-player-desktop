const state = { host: '', user: '', pass: '' };
// La radio n'existe pas comme action Xtream séparée : ce sont des streams "live" avec
// stream_type === "radio_streams", qu'on extrait après coup (voir switchTab) pour en faire un
// onglet à part plutôt que de les laisser noyés dans la liste des chaînes TV.
const content = {
  live:   { categories: [], items: [], loaded: false, selectedCat: null },
  radio:  { categories: [], items: [], loaded: false, selectedCat: null },
  vod:    { categories: [], items: [], loaded: false, selectedCat: null },
  series: { categories: [], items: [], loaded: false, selectedCat: null }
};
const TAB_ACTIONS = {
  live:   ['get_live_categories', 'get_live_streams'],
  vod:    ['get_vod_categories', 'get_vod_streams'],
  series: ['get_series_categories', 'get_series']
};
const FAVORITES_CAT_ID = '__favorites__';
const HISTORY_CAT_ID = '__history__';
let currentTab = 'live';
let openSeries = null;
let seriesEpisodes = [];
let expandedGroups = new Set();
let playToken = 0;
let currentPlayback = null; // { url, label, kind, tab, key, iconUrl, el } du contenu en cours
let lastHistorySaveAt = 0;

window.appInfo.getVersion().then((version) => {
  document.getElementById('app-version').textContent = `v${version}`;
});

// Statut de mise à jour (vérification/téléchargement) affiché à côté du numéro de version ;
// "prêt à redémarrer" passe en plus par un toast avec action, pas juste du texte discret.
window.appInfo.onUpdateStatus(({ state, version, percent }) => {
  const statusEl = document.getElementById('update-status');
  const labels = {
    checking: 'Vérification des mises à jour…',
    downloading: `Téléchargement de la mise à jour…${percent != null ? ` ${percent}%` : ''}`,
    'up-to-date': '',
    error: '',
    ready: '',
  };
  statusEl.textContent = labels[state] ?? '';

  if (state === 'ready') showUpdateReadyToast(version);
});

function showUpdateReadyToast(version) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'notification is-info';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete';
  deleteBtn.onclick = () => toast.remove();
  toast.appendChild(deleteBtn);

  const strong = document.createElement('strong');
  strong.textContent = `Mise à jour v${version} prête`;
  toast.append(strong, document.createElement('br'), document.createTextNode("Redémarre l'app pour l'appliquer."));

  const restartBtn = document.createElement('button');
  restartBtn.className = 'button is-small is-info';
  restartBtn.style.marginTop = '8px';
  restartBtn.textContent = 'Redémarrer maintenant';
  restartBtn.onclick = () => window.appInfo.installUpdate();
  toast.appendChild(document.createElement('br'));
  toast.appendChild(restartBtn);

  container.appendChild(toast);
}

// Xtream n'a pas de vraie sous-catégorie : les fournisseurs insèrent des "fausses chaînes"
// décoratives (ex: "▼●★ --- |FR| TNT FHD |FR| --- ★●") comme séparateurs/en-têtes visuels.
function isDivider(name) {
  const t = (name || '').trim();
  if (!t) return false;
  return /^[^\p{L}\p{N}]{3,}/u.test(t) && /[^\p{L}\p{N}]{2,}$/u.test(t);
}

function cleanDividerLabel(name) {
  return (name || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ' ').replace(/\s+/g, ' ').trim() || name;
}

function groupByDividers(list) {
  const groups = [{ label: null, items: [] }];
  list.forEach(it => {
    if (isDivider(it.name)) {
      groups.push({ label: it.name, items: [] });
    } else {
      groups[groups.length - 1].items.push(it);
    }
  });
  return groups;
}

// --- Favoris (persistés en local, par type de contenu) ---
function loadFavorites() {
  try { return JSON.parse(localStorage.getItem('iptv_favorites') || '{}'); } catch { return {}; }
}
function saveFavorites(favs) {
  localStorage.setItem('iptv_favorites', JSON.stringify(favs));
}
function favoriteKey(tab, it) {
  return String(tab === 'series' ? it.series_id : it.stream_id);
}
function isFavorite(tab, it) {
  const favs = loadFavorites();
  return (favs[tab] || []).includes(favoriteKey(tab, it));
}
function toggleFavorite(tab, it) {
  const favs = loadFavorites();
  const key = favoriteKey(tab, it);
  const list = favs[tab] || [];
  const idx = list.indexOf(key);
  if (idx === -1) list.push(key); else list.splice(idx, 1);
  favs[tab] = list;
  saveFavorites(favs);
}

// --- Historique (récemment regardé/écouté + reprise de lecture, persisté en local) ---
// "kind" (pas "tab") détermine si une reprise a du sens : les flux live/radio n'ont pas de position
// à reprendre, seule la VOD (films + épisodes) en garde une.
const HISTORY_MAX = 20;
function loadHistory() {
  try { return JSON.parse(localStorage.getItem('iptv_history') || '[]'); } catch { return []; }
}
function saveHistory(list) {
  localStorage.setItem('iptv_history', JSON.stringify(list));
}
function recordHistoryEntry({ key, tab, kind, label, url, iconUrl }, position, duration) {
  const list = loadHistory().filter(h => h.key !== key);
  list.unshift({ key, tab, kind, label, url, iconUrl, position, duration, updatedAt: Date.now() });
  saveHistory(list.slice(0, HISTORY_MAX));
}
// En dessous de 15s restantes, on considère que c'est terminé : on repart du début plutôt que de
// proposer de "reprendre" les 10 dernières secondes d'un film déjà fini.
function historyResumeSeconds(key) {
  const entry = loadHistory().find(h => h.key === key);
  if (!entry || !entry.duration || entry.duration - entry.position < 15) return 0;
  return entry.position > 5 ? entry.position : 0;
}

// --- EPG (programme en cours / à suivre, chaînes live uniquement) ---
// Chargé à la demande (seulement pour les lignes qui entrent réellement dans le viewport de la
// liste) plutôt que pour toute la liste d'un coup : certaines catégories ont des centaines de
// chaînes, et la qualité/couverture de l'EPG varie beaucoup d'un fournisseur à l'autre de toute
// façon, donc pas la peine de tout précharger.
const epgCache = new Map(); // stream_id -> { now, next, fetchedAt }
const EPG_CACHE_TTL_MS = 5 * 60_000;
const epgStreamIdByEl = new WeakMap();
const epgObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    epgObserver.unobserve(entry.target);
    renderEpgInto(entry.target, epgStreamIdByEl.get(entry.target));
  });
}, { root: document.getElementById('channel-list'), rootMargin: '150px' });

function decodeEpgText(base64) {
  try { return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))); } catch { return ''; }
}

// Les horodatages Xtream ("2026-10-30 19:00:00") sont dans le fuseau du panel, pas forcément celui
// du spectateur : on se contente d'en extraire l'heure affichée telle quelle plutôt que de la
// reconvertir avec Date (ce qui introduirait un décalage selon le fuseau de la machine).
function epgTime(timestamp) {
  return /(\d{2}:\d{2}):\d{2}$/.exec(timestamp || '')?.[1] || '';
}

async function fetchEpg(streamId) {
  const cached = epgCache.get(streamId);
  if (cached && Date.now() - cached.fetchedAt < EPG_CACHE_TTL_MS) return cached;

  const data = await api('get_short_epg', `stream_id=${streamId}&limit=2`);
  const [now, next] = data?.epg_listings || [];
  const result = {
    now: now ? { title: decodeEpgText(now.title), end: now.end } : null,
    next: next ? { title: decodeEpgText(next.title), start: next.start } : null,
    fetchedAt: Date.now(),
  };
  epgCache.set(streamId, result);
  return result;
}

async function renderEpgInto(epgEl, streamId) {
  try {
    const { now, next } = await fetchEpg(streamId);
    if (now) epgEl.textContent = `▶ ${now.title}` + (now.end ? ` (jusqu'à ${epgTime(now.end)})` : '');
    else if (next) epgEl.textContent = `à suivre : ${next.title}` + (next.start ? ` (${epgTime(next.start)})` : '');
    else epgEl.textContent = '';
  } catch {
    epgEl.textContent = ''; // pas d'EPG pour cette chaîne (ou erreur) : pas la peine d'alerter l'utilisateur
  }
}

function itemIconUrl(it) {
  return (currentTab === 'series' ? it.cover : it.stream_icon) || '';
}

function createSpinner() {
  const span = document.createElement('span');
  span.className = 'row-spinner';
  return span;
}

function renderItemRow(el, it) {
  const wrapper = document.createElement('div');
  wrapper.className = 'item-row';

  const main = document.createElement('div');
  main.className = 'item-row-main';

  const iconUrl = itemIconUrl(it);
  if (iconUrl) {
    const icon = document.createElement('img');
    icon.className = 'item-icon';
    icon.src = iconUrl;
    icon.loading = 'lazy';
    icon.alt = '';
    icon.onerror = () => icon.remove(); // logo cassé/injoignable : on retombe sur le texte seul
    main.appendChild(icon);
  }

  const label = document.createElement('span');
  label.className = 'item-label';
  label.textContent = (it.stream_type === 'radio_streams' ? '🎵 ' : '') + it.name;
  main.appendChild(label);
  main.appendChild(createSpinner());

  const favBtn = document.createElement('button');
  favBtn.className = 'fav-btn' + (isFavorite(currentTab, it) ? ' active' : '');
  favBtn.textContent = isFavorite(currentTab, it) ? '★' : '☆';
  favBtn.title = 'Ajouter/retirer des favoris';
  favBtn.onclick = (e) => {
    e.stopPropagation();
    toggleFavorite(currentTab, it);
    renderItems();
    renderCategories(); // le compteur "⭐ Favoris" doit se mettre à jour dans tous les cas
  };
  main.appendChild(favBtn);
  wrapper.appendChild(main);

  wrapper.onclick = () => {
    if (currentTab === 'live' || currentTab === 'radio') playChannel(it, wrapper);
    else if (currentTab === 'vod') playMovie(it, wrapper);
    else openSeriesHandler(it, wrapper);
  };

  if (currentTab === 'live' && it.stream_type !== 'radio_streams') {
    const epgEl = document.createElement('div');
    epgEl.className = 'item-epg';
    epgEl.textContent = '…';
    epgStreamIdByEl.set(epgEl, it.stream_id);
    epgObserver.observe(epgEl);
    wrapper.appendChild(epgEl);
  }

  el.appendChild(wrapper);
}

function renderHistoryRow(el, entry) {
  const wrapper = document.createElement('div');
  wrapper.className = 'item-row';

  const main = document.createElement('div');
  main.className = 'item-row-main';

  if (entry.iconUrl) {
    const icon = document.createElement('img');
    icon.className = 'item-icon';
    icon.src = entry.iconUrl;
    icon.loading = 'lazy';
    icon.alt = '';
    icon.onerror = () => icon.remove();
    main.appendChild(icon);
  }

  const label = document.createElement('span');
  label.className = 'item-label';
  label.textContent = entry.label;
  main.appendChild(label);
  main.appendChild(createSpinner());
  wrapper.appendChild(main);

  if (entry.kind === 'vod' && entry.duration > 0) {
    const progress = document.createElement('div');
    progress.className = 'item-epg';
    const finished = entry.duration - entry.position < 15;
    progress.textContent = finished ? 'Terminé' : `Repris à ${formatTime(entry.position)} / ${formatTime(entry.duration)}`;
    wrapper.appendChild(progress);
  }

  wrapper.onclick = () => {
    markActive(wrapper);
    startPlayback({
      url: entry.url, label: entry.label, kind: entry.kind, tab: entry.tab,
      key: entry.key, iconUrl: entry.iconUrl, el: wrapper,
      resumeSeconds: historyResumeSeconds(entry.key),
    });
  };

  el.appendChild(wrapper);
}

// Notification in-app (toast), utile quand l'utilisateur regarde la fenêtre mpv (séparée) plutôt
// que le catalogue au moment où l'erreur survient. Bulma fournit le style (.notification), pas le
// comportement (empilement, fermeture, auto-disparition), qu'on gère nous-mêmes.
const TOAST_DURATION_MS = 8000;
function notify(title, body, retry) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'notification is-danger';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete';
  deleteBtn.onclick = () => toast.remove();
  toast.appendChild(deleteBtn);

  const strong = document.createElement('strong');
  strong.textContent = title;
  toast.append(strong, document.createElement('br'), document.createTextNode(body));

  if (retry) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'button is-small is-light';
    retryBtn.style.marginTop = '8px';
    retryBtn.textContent = 'Réessayer';
    retryBtn.onclick = () => { toast.remove(); retry(); };
    toast.append(document.createElement('br'), retryBtn);
  }

  container.appendChild(toast);
  // Avec un bouton d'action, on laisse l'utilisateur fermer lui-même plutôt que de le faire
  // disparaître avant qu'il ait eu le temps de cliquer dessus.
  if (!retry) setTimeout(() => toast.remove(), TOAST_DURATION_MS);
}

function api(action, extra) {
  let url = `http://${state.host}/player_api.php?username=${encodeURIComponent(state.user)}&password=${encodeURIComponent(state.pass)}`;
  if (action) url += `&action=${action}`;
  if (extra) url += `&${extra}`;
  return fetch(url).then(r => r.json());
}

async function connect() {
  const host = document.getElementById('f-host').value.trim();
  const user = document.getElementById('f-user').value.trim();
  const pass = document.getElementById('f-pass').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  if (!host || !user || !pass) {
    errEl.textContent = 'Remplis tous les champs.';
    return;
  }

  state.host = host; state.user = user; state.pass = pass;

  try {
    const info = await api(null);
    if (!info.user_info || info.user_info.auth !== 1) {
      errEl.textContent = 'Identifiants refusés par le serveur.';
      return;
    }
    await finishLogin(host, user, pass, info);
  } catch (e) {
    errEl.textContent = 'Erreur réseau: ' + e.message;
  }
}

async function finishLogin(host, user, pass, info) {
  state.host = host; state.user = user; state.pass = pass;

  document.getElementById('account-label').textContent =
    `${user} — statut: ${info.user_info.status} — expire: ${new Date(info.user_info.exp_date * 1000).toLocaleDateString()}`;

  localStorage.setItem('iptv_creds', JSON.stringify({ host, user, pass }));

  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  await switchTab('live');
}

async function switchTab(tab) {
  currentTab = tab;
  openSeries = null;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));

  const fetchTab = tab === 'radio' ? 'live' : tab; // la radio se déduit du fetch "live"
  if (!content[fetchTab].loaded) {
    document.getElementById('categories').innerHTML = '<div class="loading">Chargement...</div>';
    document.getElementById('now-playing').textContent = 'Chargement du contenu...';
    const [catAction, itemAction] = TAB_ACTIONS[fetchTab];
    try {
      const [cats, items] = await Promise.all([api(catAction), api(itemAction)]);
      const allCats = Array.isArray(cats) ? cats : [];
      const allItems = Array.isArray(items) ? items : [];
      if (fetchTab === 'live') {
        // Mêmes catégories des deux côtés : renderCategories() masque déjà celles à 0 élément,
        // donc une catégorie purement radio disparaît naturellement de l'onglet TV, et vice-versa.
        content.live.items = allItems.filter(it => it.stream_type !== 'radio_streams');
        content.radio.items = allItems.filter(it => it.stream_type === 'radio_streams');
        content.live.categories = allCats;
        content.radio.categories = allCats;
        content.live.loaded = true;
        content.radio.loaded = true;
      } else {
        content[fetchTab].categories = allCats;
        content[fetchTab].items = allItems;
        content[fetchTab].loaded = true;
      }
      document.getElementById('now-playing').textContent = 'Sélectionne un contenu';
    } catch (e) {
      document.getElementById('categories').innerHTML = '';
      document.getElementById('now-playing').textContent = `Erreur de chargement: ${e.message}`;
      notify('Erreur serveur', `Impossible de charger le contenu "${tab}" : ${e.message}`);
      return;
    }
  }
  renderCategories();
  renderItems();
}

function logout() {
  localStorage.removeItem('iptv_creds');
  location.reload();
}

function downloadM3U() {
  if (!content.live.loaded) { alert('Charge l\'onglet TV d\'abord.'); return; }
  const catMap = {};
  content.live.categories.forEach(c => catMap[c.category_id] = c.category_name);

  const lines = ['#EXTM3U'];
  content.live.items.forEach(ch => {
    const cat = catMap[ch.category_id] || 'Uncategorized';
    const url = `http://${state.host}/live/${state.user}/${state.pass}/${ch.stream_id}.m3u8`;
    lines.push(`#EXTINF:-1 tvg-id="${ch.epg_channel_id || ''}" tvg-logo="${ch.stream_icon || ''}" group-title="${cat}",${ch.name}`);
    lines.push(url);
  });

  const blob = new Blob([lines.join('\n') + '\n'], { type: 'audio/x-mpegurl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.user}_playlist.m3u`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function renderCategories() {
  const el = document.getElementById('categories');
  el.innerHTML = '';
  const { categories, items, selectedCat } = content[currentTab];

  const allDiv = document.createElement('div');
  allDiv.className = 'item' + (selectedCat === null ? ' active' : '');
  allDiv.textContent = `Toutes (${items.length})`;
  allDiv.onclick = () => selectCategory(null, allDiv);
  el.appendChild(allDiv);

  const favs = loadFavorites();
  const favCount = (favs[currentTab] || []).length;
  const favDiv = document.createElement('div');
  favDiv.className = 'item' + (selectedCat === FAVORITES_CAT_ID ? ' active' : '');
  favDiv.textContent = `⭐ Favoris (${favCount})`;
  favDiv.onclick = () => selectCategory(FAVORITES_CAT_ID, favDiv);
  el.appendChild(favDiv);

  const histCount = loadHistory().filter(h => h.tab === currentTab).length;
  const histDiv = document.createElement('div');
  histDiv.className = 'item' + (selectedCat === HISTORY_CAT_ID ? ' active' : '');
  histDiv.textContent = `🕘 Récemment regardé (${histCount})`;
  histDiv.onclick = () => selectCategory(HISTORY_CAT_ID, histDiv);
  el.appendChild(histDiv);

  categories.forEach(cat => {
    const count = items.filter(c => c.category_id === cat.category_id).length;
    if (count === 0) return;
    const div = document.createElement('div');
    div.className = 'item' + (selectedCat === cat.category_id ? ' active' : '');
    div.textContent = `${cat.category_name} (${count})`;
    div.onclick = () => selectCategory(cat.category_id, div);
    el.appendChild(div);
  });
}

function selectCategory(catId, el) {
  document.querySelectorAll('#categories .item').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
  content[currentTab].selectedCat = catId;
  openSeries = null;
  renderItems();
}

function renderItems() {
  const el = document.getElementById('channel-list');
  const search = document.getElementById('search');
  el.innerHTML = '';

  // Vue "épisodes" d'une série ouverte
  if (currentTab === 'series' && openSeries) {
    const back = document.createElement('div');
    back.className = 'item';
    back.style.fontWeight = '600';
    back.textContent = `← Retour (${openSeries.name})`;
    back.onclick = () => { openSeries = null; renderItems(); };
    el.appendChild(back);

    const query = search.value.toLowerCase();
    let eps = seriesEpisodes;
    if (query) eps = eps.filter(e => (e.title || '').toLowerCase().includes(query));

    eps.forEach(ep => {
      const div = document.createElement('div');
      div.className = 'item';
      const label = document.createElement('span');
      label.className = 'item-label';
      label.textContent = `S${ep.season} E${ep.episode_num}${ep.title ? ' - ' + ep.title : ''}`;
      div.appendChild(label);
      div.appendChild(createSpinner());
      div.onclick = () => playEpisode(ep, div);
      el.appendChild(div);
    });
    return;
  }

  const { items, selectedCat } = content[currentTab];
  const query = search.value.toLowerCase();

  // Favoris : liste plate, toutes catégories confondues.
  if (selectedCat === FAVORITES_CAT_ID) {
    let list = items.filter(it => isFavorite(currentTab, it));
    if (query) list = list.filter(it => (it.name || '').toLowerCase().includes(query));
    if (list.length === 0) {
      const note = document.createElement('div');
      note.className = 'loading';
      note.textContent = 'Aucun favori dans cet onglet pour le moment.';
      el.appendChild(note);
      return;
    }
    list.forEach(it => renderItemRow(el, it));
    return;
  }

  // Historique : liste plate, toutes catégories confondues, la plus récente en premier.
  if (selectedCat === HISTORY_CAT_ID) {
    let hist = loadHistory().filter(h => h.tab === currentTab);
    if (query) hist = hist.filter(h => (h.label || '').toLowerCase().includes(query));
    if (hist.length === 0) {
      const note = document.createElement('div');
      note.className = 'loading';
      note.textContent = 'Rien dans l\'historique pour cet onglet.';
      el.appendChild(note);
      return;
    }
    hist.forEach(h => renderHistoryRow(el, h));
    return;
  }

  let list = selectedCat ? items.filter(c => c.category_id === selectedCat) : items;

  // Aucune catégorie sélectionnée (et pas de recherche) : juste le message, aucun item affiché.
  if (!selectedCat && !query) {
    const note = document.createElement('div');
    note.className = 'loading';
    note.textContent = 'Sélectionne une catégorie pour voir ses sous-catégories.';
    el.appendChild(note);
    return;
  }

  // Recherche active : liste plate sur toutes les catégories, pas de sous-groupes.
  if (query) {
    list = list.filter(c => !isDivider(c.name) && (c.name || '').toLowerCase().includes(query));
    list.slice(0, 500).forEach(it => renderItemRow(el, it));
    return;
  }

  // Une catégorie précise est sélectionnée : on regroupe par séparateurs, repliables.
  list = [...list].sort((a, b) => (a.num || 0) - (b.num || 0));
  const groups = groupByDividers(list);

  groups.forEach(group => {
    if (group.label) {
      const key = `${currentTab}:${selectedCat}:${group.label}`;
      const expanded = expandedGroups.has(key);
      const header = document.createElement('div');
      header.className = 'item group-header';
      header.textContent = `${expanded ? '▾' : '▸'} ${cleanDividerLabel(group.label)} (${group.items.length})`;
      header.onclick = () => {
        if (expanded) expandedGroups.delete(key); else expandedGroups.add(key);
        renderItems();
      };
      el.appendChild(header);
      if (!expanded) return;
    }
    group.items.forEach(it => renderItemRow(el, it));
  });
}

async function openSeriesHandler(series, el) {
  markActive(el);
  const status = document.getElementById('now-playing');
  status.textContent = `Chargement des épisodes de ${series.name}...`;
  try {
    const info = await api('get_series_info', `series_id=${series.series_id}`);
    const episodesBySeason = info.episodes || {};
    seriesEpisodes = [];
    Object.keys(episodesBySeason)
      .sort((a, b) => Number(a) - Number(b))
      .forEach(season => {
        episodesBySeason[season].forEach(ep => {
          seriesEpisodes.push({
            season,
            episode_num: ep.episode_num,
            title: ep.title,
            id: ep.id,
            container_extension: ep.container_extension,
            duration_secs: ep.info?.duration_secs
          });
        });
      });
    openSeries = series;
    status.textContent = `${seriesEpisodes.length} épisode(s) — choisis-en un`;
    renderItems();
  } catch (e) {
    status.textContent = `Erreur chargement épisodes: ${e.message}`;
    notify('Erreur serveur', `Impossible de charger les épisodes de "${series.name}" : ${e.message}`);
  }
}

// --- Lecture (mpv, dans sa propre fenêtre, piloté via le pont IPC exposé par preload.cjs) ---

function markActive(el) {
  // .item-row : chaînes/films/séries (rendues par renderItemRow) ; .item : épisodes et bouton retour.
  document.querySelectorAll('#channels .item-row, #channels .item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
}

// Petit spinner sur la ligne cliquée, le temps que mpv démarre (ou échoue) — couvre le délai
// perceptible du premier lancement de mpv, avant que sa fenêtre ne prenne le relais visuellement.
let loadingRowEl = null;
function setRowLoading(el) {
  // "row-loading", pas "loading" : cette dernière classe existe déjà pour les messages
  // "Chargement..." (padding différent) et s'appliquait en même temps par coïncidence de nom.
  loadingRowEl?.classList.remove('row-loading');
  loadingRowEl = el || null;
  loadingRowEl?.classList.add('row-loading');
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

let playerDuration = 0;
let playerPaused = false;
let seekBarDragging = false;
let seekBarReleaseTimer = null;
let volumeSliderDragging = false;
let volumeSliderReleaseTimer = null;

window.player.onState(({ name, value }) => {
  if (name === 'duration' && typeof value === 'number') {
    playerDuration = value;
  }
  if (name === 'time-pos' && typeof value === 'number' && !seekBarDragging) {
    const bar = document.getElementById('seek-bar');
    bar.value = playerDuration > 0 ? String(Math.round((value / playerDuration) * 1000)) : '0';
    document.getElementById('time-label').textContent = `${formatTime(value)} / ${formatTime(playerDuration)}`;
  }
  // Sauvegarde périodique de la position pour la reprise de lecture (VOD uniquement, un live n'a
  // pas de position à reprendre). Limité à une écriture toutes les 5s, pas la peine de persister à
  // chaque tick.
  if (name === 'time-pos' && typeof value === 'number' && currentPlayback?.kind === 'vod'
    && playerDuration > 0 && Date.now() - lastHistorySaveAt > 5000) {
    lastHistorySaveAt = Date.now();
    recordHistoryEntry(currentPlayback, value, playerDuration);
  }
  if (name === 'pause' && typeof value === 'boolean') {
    playerPaused = value;
    document.getElementById('btn-playpause').textContent = value ? '▶' : '⏸';
  }
  // Reflète aussi un changement de volume fait directement dans la fenêtre mpv (raccourcis clavier
  // mpv 9/0/molette), pas seulement ceux déclenchés depuis notre propre slider.
  if (name === 'volume' && typeof value === 'number' && !volumeSliderDragging) {
    document.getElementById('volume-slider').value = String(Math.round(value));
  }
});

window.player.onTracks(({ audio, subtitle }) => {
  const audioSelect = document.getElementById('audio-track-select');
  const subSelect = document.getElementById('sub-track-select');
  audioSelect.innerHTML = '';
  subSelect.innerHTML = '';

  audio.forEach(t => {
    const opt = document.createElement('option');
    opt.value = String(t.id);
    opt.textContent = t.title || t.lang || `Piste ${t.id}`;
    if (t.selected) opt.selected = true;
    audioSelect.appendChild(opt);
  });

  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'Aucun';
  subSelect.appendChild(noneOpt);
  subtitle.forEach(t => {
    const opt = document.createElement('option');
    opt.value = String(t.id);
    opt.textContent = t.title || t.lang || `Piste ${t.id}`;
    if (t.selected) opt.selected = true;
    subSelect.appendChild(opt);
  });
});

window.player.onEnded(() => {
  document.getElementById('now-playing').textContent = 'Lecture terminée';
});

window.player.onError((message) => {
  document.getElementById('now-playing').textContent = `Erreur de lecture: ${message}`;
  // Couvre aussi les erreurs qui surviennent en cours de lecture (ex: coupure réseau, 503 côté
  // flux), pas seulement l'échec initial — currentPlayback garde le contexte du contenu en cours.
  notify('Erreur de lecture', message, currentPlayback ? () => startPlayback({ ...currentPlayback }) : undefined);
});

window.player.onLog((line) => console.log('[mpv]', line));

function togglePause() {
  if (playerPaused) window.player.resume(); else window.player.pause();
}

function onSeekBarInput() {
  seekBarDragging = true;
  const bar = document.getElementById('seek-bar');
  if (playerDuration > 0) {
    const seconds = (Number(bar.value) / 1000) * playerDuration;
    window.player.seek(seconds);
  }
  clearTimeout(seekBarReleaseTimer);
  seekBarReleaseTimer = setTimeout(() => { seekBarDragging = false; }, 300);
}

function onAudioTrackChange() {
  const value = document.getElementById('audio-track-select').value;
  if (value !== '') window.player.setAudioTrack(Number(value));
}

function onSubtitleTrackChange() {
  const value = document.getElementById('sub-track-select').value;
  window.player.setSubtitleTrack(value === '' ? null : Number(value));
}

function onVolumeChange() {
  volumeSliderDragging = true;
  window.player.setVolume(Number(document.getElementById('volume-slider').value));
  clearTimeout(volumeSliderReleaseTimer);
  volumeSliderReleaseTimer = setTimeout(() => { volumeSliderDragging = false; }, 300);
}

function changeVolume(delta) {
  const slider = document.getElementById('volume-slider');
  const next = Math.max(0, Math.min(100, Number(slider.value) + delta));
  slider.value = String(next);
  window.player.setVolume(next);
}

// --- Raccourcis clavier (espace = pause, flèches = seek/volume) ---
// Désactivés tant qu'on n'est pas connecté, et ignorés si un champ texte/select a le focus (sinon
// "espace" dans le champ de recherche ou un <select> de piste deviendrait inutilisable).
document.addEventListener('keydown', (e) => {
  if (document.getElementById('app').style.display !== 'flex') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePause();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      window.player.seekRelative(-10);
      break;
    case 'ArrowRight':
      e.preventDefault();
      window.player.seekRelative(10);
      break;
    case 'ArrowUp':
      e.preventDefault();
      changeVolume(5);
      break;
    case 'ArrowDown':
      e.preventDefault();
      changeVolume(-5);
      break;
  }
});

async function startPlayback({ url, label, kind, tab, key, iconUrl, el, resumeSeconds = 0 }) {
  const myToken = ++playToken;
  const status = document.getElementById('now-playing');
  status.textContent = `Préparation du flux: ${label}...`;
  playerDuration = 0;
  document.getElementById('audio-track-select').innerHTML = '<option value="">Audio</option>';
  document.getElementById('sub-track-select').innerHTML = '<option value="">Sous-titres</option>';
  setRowLoading(el);

  try {
    await window.player.load(url, kind);
  } catch (e) {
    if (myToken !== playToken) return;
    status.textContent = `Erreur de lecture (${label}): ${e.message}`;
    notify('Erreur de lecture', `${label} : ${e.message}`, () => startPlayback({ url, label, kind, tab, key, iconUrl, el, resumeSeconds }));
    setRowLoading(null);
    return;
  }
  if (myToken !== playToken) { window.player.stop(); return; }

  if (resumeSeconds > 0) window.player.seek(resumeSeconds);
  currentPlayback = { url, label, kind, tab, key, iconUrl, el };
  recordHistoryEntry(currentPlayback, resumeSeconds, 0);
  if (tab === currentTab) renderCategories(); // met à jour le compteur "Récemment regardé" tout de suite

  status.textContent = resumeSeconds > 0 ? `Lecture: ${label} (reprise à ${formatTime(resumeSeconds)})` : `Lecture: ${label}`;
  setRowLoading(null);
}

function playChannel(ch, el) {
  markActive(el);
  const url = `http://${state.host}/live/${state.user}/${state.pass}/${ch.stream_id}.m3u8`;
  startPlayback({ url, label: ch.name, kind: 'live', tab: currentTab, key: `${currentTab}:${ch.stream_id}`, iconUrl: itemIconUrl(ch), el });
}

function playMovie(movie, el) {
  markActive(el);
  const key = `vod:${movie.stream_id}`;
  const ext = movie.container_extension || 'mp4';
  const url = `http://${state.host}/movie/${state.user}/${state.pass}/${movie.stream_id}.${ext}`;
  startPlayback({ url, label: movie.name, kind: 'vod', tab: 'vod', key, iconUrl: itemIconUrl(movie), el, resumeSeconds: historyResumeSeconds(key) });
}

function playEpisode(ep, el) {
  markActive(el);
  const key = `episode:${ep.id}`;
  const ext = ep.container_extension || 'mp4';
  const label = `${openSeries.name} S${ep.season}E${ep.episode_num}`;
  const url = `http://${state.host}/series/${state.user}/${state.pass}/${ep.id}.${ext}`;
  startPlayback({ url, label, kind: 'vod', tab: 'series', key, iconUrl: openSeries.cover, el, resumeSeconds: historyResumeSeconds(key) });
}

// auto-login si des identifiants sont déjà sauvegardés
(function () {
  const saved = localStorage.getItem('iptv_creds');
  if (saved) {
    const { host, user, pass } = JSON.parse(saved);
    document.getElementById('f-host').value = host;
    document.getElementById('f-user').value = user;
    document.getElementById('f-pass').value = pass;
    document.getElementById('login-error').textContent = 'Reconnexion automatique...';
    connect();
  }
})();
