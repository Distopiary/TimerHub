// Interface principale de TimerHub (partagée entre l'app PC et la version téléphone).
(function () {
  'use strict';

  const { LocalStore, CloudStore, lsGet, lsSet, resizeImage, dataUrlToBlob } = window.TimerStore;
  const S = window.Schedule;

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const desktop = window.timerhub || null;
  const cfg = window.TIMERHUB_CONFIG || {};
  const cloudConfigured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);

  const state = {
    tasks: [],
    folders: [],
    member: null,     // ligne "membre" du compte connecté
    members: [],      // liste complète (administrateur uniquement)
    pending: false,   // compte en attente de validation
    view: lsGet('view', 'tasks'),
    collapsed: lsGet('collapsed', {}),
    filter: lsGet('filter', 'all'),
    store: null,
    client: null,
    user: null,
    sig: '',
    form: null,
  };

  const content = $('#content');
  const toolbar = $('#toolbar');

  // ---------------- Démarrage ----------------
  async function init() {
    if (desktop) {
      document.body.classList.add('desktop');
      desktop.onUpdateReady(showUpdateBanner);
      desktop.getUpdate().then((u) => { state.appVersion = u.version; if (u.pending) showUpdateBanner(u.pending); }).catch(() => {});
    }
    bindStatic();

    if (cloudConfigured) {
      state.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      });
      try {
        const { data } = await state.client.auth.getSession();
        state.user = data.session ? data.session.user : null;
      } catch { state.user = null; }
      state.client.auth.onAuthStateChange((_evt, session) => {
        const u = session ? session.user : null;
        if ((u && u.id) !== (state.user && state.user.id)) {
          state.user = u;
          setTimeout(setupStore, 0);
        }
      });
    }

    await setupStore();
    setInterval(tick, 1000);
    setInterval(checkNotifications, 15000);
    setInterval(reload, 5 * 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reload(); });

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !desktop) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  function showUpdateBanner(version) {
    const el = $('#update-banner');
    el.innerHTML = `🎁 La version <b>${esc(version)}</b> de TimerHub est prête.
      <button class="btn btn-primary btn-sm" data-update-install>Redémarrer et mettre à jour</button>
      <span class="muted">(sinon elle s'installera à la prochaine fermeture)</span>`;
    el.classList.remove('hidden');
    $('[data-update-install]', el).addEventListener('click', () => desktop.installUpdate());
  }

  async function setupStore() {
    if (state.store) state.store.dispose();
    state.store = state.user ? new CloudStore(state.client, state.user) : new LocalStore();
    state.store.onChange(() => reload());
    state.member = null; state.members = []; state.pending = false;
    renderSync();
    await reload();
    if (state.user && !state.pending) await maybeImportLocal();
  }

  async function loadMembership() {
    const { data, error } = await state.client.from('members').select('*').eq('user_id', state.user.id).maybeSingle();
    if (error) {
      // Table absente (ancien schéma) : on ne bloque pas l'utilisateur
      if (/members|relation|schema cache/i.test(error.message)) { state.member = null; state.pending = false; return; }
      throw new Error(error.message);
    }
    const wasPending = state.pending;
    state.member = data;
    state.pending = !data || !data.approved;
    if (wasPending && !state.pending) toast('Ton compte a été validé, bienvenue ! 🎉', 'success', 6000);
    if (data && data.is_admin) {
      const res = await state.client.from('members').select('*').order('created_at', { ascending: true });
      if (!res.error) state.members = res.data;
    } else {
      state.members = [];
      if (state.view === 'admin') state.view = 'tasks';
    }
  }

  async function reload() {
    if (state.user) {
      try { await loadMembership(); } catch (e) { toast('Impossible de vérifier le compte : ' + e.message, 'error'); }
      if (state.pending) { state.tasks = []; state.folders = []; render(); return; }
    }
    try {
      state.tasks = await state.store.list('tasks');
    } catch (e) {
      if (e.cached) { state.tasks = e.cached; toast('Hors ligne : affichage de la dernière copie', 'warn'); }
      else toast('Impossible de charger les tâches : ' + e.message, 'error');
    }
    try {
      state.folders = await state.store.list('folders');
    } catch (e) {
      if (e.cached) state.folders = e.cached;
      else toast('Impossible de charger les dossiers : ' + e.message, 'error');
    }
    render();
  }

  // ---------------- Identifiants ----------------
  // Supabase exige une adresse e-mail : l'identifiant est converti en adresse interne (jamais utilisée pour écrire).
  const LOGIN_DOMAIN = 'timerhub.local';
  const loginToEmail = (login) => (login.includes('@') ? login : `${login}@${LOGIN_DOMAIN}`);
  const displayName = (user) => {
    const email = (user && user.email) || '';
    return email.endsWith('@' + LOGIN_DOMAIN) ? email.slice(0, -(LOGIN_DOMAIN.length + 1)) : email;
  };

  // ---------------- Rendu ----------------
  function sorted(tasks, now) {
    return tasks
      .map((t) => ({ t, s: S.status(t, now) }))
      .sort((a, b) => {
        if (a.s.done !== b.s.done) return a.s.done ? 1 : -1;
        const ta = a.s.target ? a.s.target.getTime() : 0;
        const tb = b.s.target ? b.s.target.getTime() : 0;
        if (!a.s.done && a.t.kind === 'interval' && b.t.kind !== 'interval') return -1;
        if (!b.s.done && b.t.kind === 'interval' && a.t.kind !== 'interval') return 1;
        return ta - tb || a.t.title.localeCompare(b.t.title);
      });
  }

  function hue(str) {
    let h = 0;
    for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }

  function initials(title) {
    const words = String(title).trim().split(/[\s\-_:]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    const s = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
    return s.toUpperCase();
  }

  function cardHtml({ t, s }, now, opts = {}) {
    const kindLabel = { daily: 'Journalière', weekly: 'Hebdo', interval: 'Timer' }[t.kind];
    const canLaunch = t.launch_type && t.launch_type !== 'none' && t.launch_target;
    const media = t.image_url
      ? `<div class="card-media" style="background-image:url('${esc(t.image_url)}')"></div>`
      : `<div class="card-media placeholder" style="--h:${hue(t.title)}"><span>${esc(initials(t.title))}</span></div>`;
    const links = (t.links || []).filter((l) => l && l.url).map((l, i) =>
      `<button class="chip" data-link="${i}" title="${esc(l.url)}">🔗 ${esc(l.label || hostOf(l.url))}</button>`).join('');
    const launchLabel = { steam: 'Lancer sur Steam', exe: 'Lancer le jeu', url: 'Ouvrir le site' }[t.launch_type] || '';
    const folder = opts.showFolder && t.folder_id ? state.folders.find((f) => f.id === t.folder_id) : null;
    const foot = (links || canLaunch) ? `
        <div class="card-foot">
          <div class="links">${links}</div>
          ${canLaunch ? `<button class="launch-btn" data-action="launch" title="${esc(launchLabel)}">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>${esc(launchLabel)}</button>` : ''}
        </div>` : '';
    return `
      <article class="card ${s.done ? 'done' : 'ready'} kind-${t.kind}" data-id="${esc(t.id)}" ${opts.draggable ? 'draggable="true"' : ''}>
        <div class="card-top">
          ${media}
          <span class="badge badge-${t.kind}">${kindLabel}</span>
          ${folder ? `<span class="folder-tag">📁 ${esc(folder.name)}</span>` : ''}
          <button class="icon-btn edit" data-action="edit" title="Modifier" aria-label="Modifier">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          </button>
        </div>
        <div class="card-body">
          <button class="check" data-action="toggle" role="checkbox" aria-checked="${s.done}" title="${s.done ? 'Annuler la validation' : 'Marquer comme fait'}">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="info">
            <h3 title="${esc(t.title)}">${esc(t.title)}</h3>
            <div class="meta">${esc(S.describe(t))}</div>
          </div>
        </div>
        <div class="timer">${esc(S.timerText(t, s, now))}</div>
        <div class="progress"><span style="width:${(S.progress(t, s, now) * 100).toFixed(1)}%"></span></div>
        ${foot}
      </article>`;
  }

  function render() {
    const now = new Date();
    const all = sorted(state.tasks, now);
    const counts = { all: all.length, todo: all.filter((x) => !x.s.done).length, done: all.filter((x) => x.s.done).length };

    const isAdmin = !!(state.member && state.member.is_admin);
    if (state.view === 'admin' && !isAdmin) state.view = 'tasks';
    $('#tab-admin').classList.toggle('hidden', !isAdmin || state.pending);
    $('#admin-count').textContent = isAdmin ? (state.members.filter((m) => !m.approved).length || '') : '';
    $('#tabs').classList.toggle('hidden', state.pending);
    $('#btn-add').classList.toggle('hidden', state.pending);
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
    $$('[data-count]').forEach((el) => { el.textContent = counts[el.dataset.count] || ''; });

    const empty = $('#empty');
    if (state.pending) {
      empty.classList.add('hidden');
      toolbar.classList.add('hidden');
      renderPending();
      state.sig = signature(now);
      document.title = 'TimerHub';
      return;
    }
    if (state.view === 'admin') {
      empty.classList.add('hidden');
      toolbar.classList.remove('hidden');
      renderAdmin();
      state.sig = signature(now);
      return;
    }
    const noData = all.length === 0 && (state.view === 'tasks' || state.folders.length === 0);
    empty.classList.toggle('hidden', !noData);
    toolbar.classList.toggle('hidden', noData);

    if (state.view === 'storage') renderStorage(all, now);
    else renderTasks(all, counts, now);

    state.sig = signature(now);
    document.title = counts.todo ? `(${counts.todo}) TimerHub` : 'TimerHub';
  }

  function renderTasks(all, counts, now) {
    toolbar.innerHTML = `
      <div class="filters">
        ${[['all', 'Tout'], ['todo', 'À faire'], ['done', 'Faites']].map(([k, label]) =>
          `<button data-filter="${k}" class="${state.filter === k ? 'active' : ''}">${label} <span class="count">${counts[k] || ''}</span></button>`).join('')}
      </div>`;
    const visible = all.filter((x) => state.filter === 'all' || (state.filter === 'done' ? x.s.done : !x.s.done));
    if (all.length > 0 && visible.length === 0) {
      content.innerHTML = `<p class="muted center">${state.filter === 'done' ? 'Rien de validé pour le moment.' : 'Tout est fait, bravo ! 🎉'}</p>`;
      return;
    }
    content.innerHTML = `<div class="grid">${visible.map((x) => cardHtml(x, now, { showFolder: true })).join('')}</div>`;
  }

  function folderSection(id, name, items, now, isReal) {
    const collapsed = !!state.collapsed[id];
    const todo = items.filter((x) => !x.s.done).length;
    return `
      <section class="folder ${collapsed ? 'collapsed' : ''}" data-folder="${esc(id)}">
        <header class="folder-head" data-action="toggle-folder">
          <svg class="chevron" viewBox="0 0 24 24" width="18" height="18"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="folder-icon">${isReal ? (collapsed ? '📁' : '📂') : '🗂️'}</span>
          <h2>${esc(name)}</h2>
          <span class="folder-count">${items.length ? `${todo ? `<b>${todo}</b> à faire · ` : ''}${items.length} tâche${items.length > 1 ? 's' : ''}` : 'vide'}</span>
          <span class="spacer"></span>
          <button class="icon-btn" data-action="folder-add" title="Nouvelle tâche dans ce dossier" aria-label="Nouvelle tâche dans ce dossier">+</button>
          ${isReal ? `
            <button class="icon-btn" data-action="folder-rename" title="Renommer" aria-label="Renommer">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
            </button>
            <button class="icon-btn" data-action="folder-delete" title="Supprimer le dossier" aria-label="Supprimer le dossier">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>
            </button>` : ''}
        </header>
        ${collapsed ? '' : `<div class="folder-body">${items.length
          ? `<div class="grid">${items.map((x) => cardHtml(x, now, { draggable: true })).join('')}</div>`
          : `<p class="folder-empty">Glisse des tâches ici, ou choisis ce dossier dans une tâche.</p>`}</div>`}
      </section>`;
  }

  function renderPending() {
    content.innerHTML = `
      <div class="pending-card">
        <div class="pending-icon">⏳</div>
        <h2>Compte en attente de validation</h2>
        <p>Bonjour <b>${esc(displayName(state.user))}</b> ! Ton inscription a bien été enregistrée.<br>
        L'administrateur doit la valider avant que tu puisses utiliser la synchro.<br>
        Cette page se mettra à jour toute seule dès que ce sera fait.</p>
        <div class="row-buttons center-buttons">
          <button class="btn" data-action="recheck">Vérifier maintenant</button>
          <button class="btn btn-ghost" data-action="logout">Se déconnecter</button>
        </div>
      </div>`;
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
  }

  function renderAdmin() {
    const list = [...state.members].sort((a, b) => (a.approved - b.approved) || (new Date(b.created_at) - new Date(a.created_at)));
    const pendingCount = list.filter((m) => !m.approved).length;
    toolbar.innerHTML = `<p class="muted toolbar-text">${pendingCount
      ? `<b>${pendingCount}</b> inscription${pendingCount > 1 ? 's' : ''} en attente de validation.`
      : 'Aucune inscription en attente.'} ${list.length} compte${list.length > 1 ? 's' : ''} au total.</p>`;
    const row = (m) => {
      const self = state.user && m.user_id === state.user.id;
      const status = m.is_admin ? '<span class="pill pill-admin">Admin</span>'
        : m.approved ? '<span class="pill pill-ok">Validé</span>' : '<span class="pill pill-wait">En attente</span>';
      let actions = '';
      if (!m.is_admin && !self) {
        actions = m.approved
          ? `<button class="btn" data-admin="revoke">Retirer l'accès</button>
             <button class="btn btn-danger" data-admin="delete">Supprimer</button>`
          : `<button class="btn btn-primary" data-admin="approve">Valider</button>
             <button class="btn btn-danger" data-admin="delete">Refuser</button>`;
      }
      return `
        <div class="member ${m.approved ? '' : 'is-pending'}" data-member="${esc(m.user_id)}">
          <div class="avatar" style="--h:${hue(m.username)}">${esc(initials(m.username))}</div>
          <div class="member-info">
            <div class="member-name">${esc(m.username)} ${self ? '<span class="muted">(toi)</span>' : ''}</div>
            <div class="meta">Inscrit le ${esc(fmtDate(m.created_at))}</div>
          </div>
          ${status}
          <div class="member-actions">${actions}</div>
        </div>`;
    };
    content.innerHTML = `<div class="members">${list.map(row).join('') || '<p class="muted center">Aucun compte.</p>'}</div>`;
  }

  async function adminAction(action, userId) {
    const m = state.members.find((x) => x.user_id === userId);
    if (!m) return;
    try {
      if (action === 'approve' || action === 'revoke') {
        if (action === 'revoke' && !window.confirm(`Retirer l'accès de « ${m.username} » ? Ses tâches sont conservées mais il ne pourra plus les voir.`)) return;
        const { error } = await state.client.rpc('admin_set_approved', { target: userId, value: action === 'approve' });
        if (error) throw error;
        toast(action === 'approve' ? `${m.username} est validé` : `Accès retiré à ${m.username}`, 'success');
      } else if (action === 'delete') {
        const verb = m.approved ? 'Supprimer' : 'Refuser';
        if (!window.confirm(`${verb} le compte « ${m.username} » ? Le compte et toutes ses tâches seront définitivement supprimés.`)) return;
        const { error } = await state.client.rpc('admin_delete_user', { target: userId });
        if (error) throw error;
        toast(`Compte ${m.username} supprimé`, 'success');
      }
      reload();
    } catch (e) {
      toast('Action impossible : ' + e.message, 'error');
    }
  }

  function renderStorage(all, now) {
    toolbar.innerHTML = `
      <button class="btn" data-action="folder-new">+ Nouveau dossier</button>
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-action="expand-all">Tout ouvrir</button>
      <button class="btn btn-ghost" data-action="collapse-all">Tout fermer</button>`;
    const folderIds = new Set(state.folders.map((f) => f.id));
    const sections = state.folders.map((f) =>
      folderSection(f.id, f.name, all.filter((x) => x.t.folder_id === f.id), now, true));
    const loose = all.filter((x) => !x.t.folder_id || !folderIds.has(x.t.folder_id));
    sections.push(folderSection('none', 'Sans dossier', loose, now, false));
    content.innerHTML = `<div class="folders">${sections.join('')}</div>`;
  }

  function signature(now) {
    return state.tasks.map((t) => t.id + (S.status(t, now).done ? '1' : '0')).join('|');
  }

  function tick() {
    const now = new Date();
    if (signature(now) !== state.sig) { render(); return; }
    for (const t of state.tasks) {
      const el = content.querySelector(`[data-id="${CSS.escape(t.id)}"]`);
      if (!el) continue;
      const s = S.status(t, now);
      el.querySelector('.timer').textContent = S.timerText(t, s, now);
      el.querySelector('.progress span').style.width = (S.progress(t, s, now) * 100).toFixed(1) + '%';
    }
  }

  function renderSync() {
    const el = $('#sync');
    const banner = $('#banner');
    if (state.user) {
      el.className = 'sync on';
      el.title = 'Synchronisé : ' + displayName(state.user);
      el.textContent = '☁ Synchro';
      banner.classList.add('hidden');
    } else {
      el.className = 'sync off';
      el.title = cloudConfigured ? 'Non connecté : données sur cet appareil uniquement' : 'Mode local';
      el.textContent = 'Local';
      if (cloudConfigured && !lsGet('bannerDismissed', false)) {
        banner.innerHTML = 'Mode local : connecte-toi pour synchroniser tes tâches entre ton PC et ton téléphone. <button class="link" data-open="settings">Se connecter</button> <button class="link muted" data-dismiss>Masquer</button>';
        banner.classList.remove('hidden');
      } else banner.classList.add('hidden');
    }
  }

  // ---------------- Actions ----------------
  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }

  function openUrl(url) {
    if (!/^https?:\/\//i.test(url)) { toast('Lien invalide : ' + url, 'error'); return; }
    if (desktop) desktop.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  }

  async function launch(t) {
    if (!t.launch_type || t.launch_type === 'none' || !t.launch_target) return;
    if (t.launch_type === 'url') { openUrl(t.launch_target); return; }
    if (!desktop) {
      if (t.launch_type === 'steam') { window.location.href = 'steam://rungameid/' + String(t.launch_target).replace(/\D/g, ''); return; }
      toast('Le lancement de ce jeu est disponible sur le PC', 'warn');
      return;
    }
    const r = await desktop.launch(t.launch_type, t.launch_target);
    if (r && r.ok) toast(`Lancement de ${t.title}…`);
    else toast((r && r.error) || 'Lancement impossible', 'error');
  }

  async function toggleDone(t) {
    const s = S.status(t, new Date());
    const patch = s.done
      ? { last_done_at: t.prev_done_at || null, prev_done_at: null }
      : { prev_done_at: t.last_done_at || null, last_done_at: new Date().toISOString() };
    Object.assign(t, patch);
    render();
    try {
      await state.store.update('tasks', t.id, patch);
    } catch (e) {
      toast('Échec de la sauvegarde : ' + e.message, 'error');
      reload();
    }
  }

  // ---------------- Dossiers ----------------
  function setCollapsed(id, value) {
    if (value) state.collapsed[id] = true; else delete state.collapsed[id];
    lsSet('collapsed', state.collapsed);
  }

  function openFolderForm(folder) {
    openModal(`
      <form id="folder-form" autocomplete="off">
        <div class="modal-head">
          <h2>${folder ? 'Renommer le dossier' : 'Nouveau dossier'}</h2>
          <button type="button" class="icon-btn" data-close aria-label="Fermer">✕</button>
        </div>
        <div class="modal-body">
          <label class="field"><span>Nom du dossier</span>
            <input name="name" required maxlength="60" placeholder="Ex. Genshin Impact" value="${esc(folder ? folder.name : '')}" autofocus>
          </label>
        </div>
        <div class="modal-foot">
          <span class="spacer"></span>
          <button type="button" class="btn btn-ghost" data-close>Annuler</button>
          <button type="submit" class="btn btn-primary">${folder ? 'Renommer' : 'Créer'}</button>
        </div>
      </form>`, (root) => {
      $('#folder-form', root).addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = e.target.elements.name.value.trim();
        if (!name) return;
        try {
          if (folder) await state.store.update('folders', folder.id, { name });
          else await state.store.insert('folders', { name, position: state.folders.length });
          closeModal();
          reload();
        } catch (err) { toast('Impossible d\'enregistrer le dossier : ' + err.message, 'error'); }
      });
    });
  }

  async function deleteFolder(folder) {
    const n = state.tasks.filter((t) => t.folder_id === folder.id).length;
    const msg = n
      ? `Supprimer le dossier « ${folder.name} » ? Ses ${n} tâche(s) ne seront pas supprimées : elles iront dans « Sans dossier ».`
      : `Supprimer le dossier « ${folder.name} » ?`;
    if (!window.confirm(msg)) return;
    try {
      // Sort d'abord les tâches du dossier (utile si la base n'a pas encore la règle "on delete set null")
      for (const t of state.tasks.filter((x) => x.folder_id === folder.id)) {
        await state.store.update('tasks', t.id, { folder_id: null });
      }
      await state.store.remove('folders', folder.id);
      setCollapsed(folder.id, false);
      reload();
    } catch (e) { toast('Suppression impossible : ' + e.message, 'error'); }
  }

  async function moveTask(taskId, folderId) {
    const t = state.tasks.find((x) => x.id === taskId);
    const target = folderId === 'none' ? null : folderId;
    if (!t || (t.folder_id || null) === target) return;
    t.folder_id = target;
    render();
    try {
      await state.store.update('tasks', t.id, { folder_id: target });
    } catch (e) {
      toast('Déplacement impossible : ' + e.message, 'error');
      reload();
    }
  }

  // ---------------- Notifications ----------------
  function notify(title, body) {
    if (desktop) { desktop.notify(title, body); return; }
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body, icon: 'icons/icon-192.png' }); } catch { /* non supporté */ }
    }
  }

  function checkNotifications() {
    if (!lsGet('notifications', true)) return;
    const now = Date.now();
    const sent = lsGet('notified', {});
    for (const t of state.tasks) {
      if (t.notify === false) continue;
      const s = S.status(t, new Date(now));
      if (s.done) continue;
      let key; let msg;
      if (t.kind === 'interval') {
        if (!s.target) continue;
        key = s.target.getTime();
        msg = 'Le timer est terminé, c\'est prêt !';
      } else {
        key = s.start.getTime();
        msg = 'Réinitialisée : la tâche est de nouveau disponible.';
      }
      if (now < key || now - key > 10 * 60000) continue;
      const k = t.id + ':' + key;
      if (sent[k]) continue;
      sent[k] = now;
      notify(t.title, msg);
    }
    for (const k of Object.keys(sent)) if (now - sent[k] > 8 * 86400000) delete sent[k];
    lsSet('notified', sent);
  }

  // ---------------- Import des tâches locales vers le cloud ----------------
  async function maybeImportLocal() {
    const local = lsGet('tasks', []);
    const flag = 'imported.' + state.user.id;
    if (!local.length || lsGet(flag, false)) return;
    lsSet(flag, true);
    if (!window.confirm(`Tu as ${local.length} tâche(s) enregistrée(s) sur cet appareil. Les envoyer dans ton compte synchronisé ?`)) return;
    const folderMap = {};
    for (const f of lsGet('folders', [])) {
      try { folderMap[f.id] = (await state.store.insert('folders', f)).id; } catch (e) { toast(`Import du dossier « ${f.name} » impossible : ${e.message}`, 'error'); }
    }
    let ok = 0;
    for (const t of local) {
      try {
        const copy = { ...t, folder_id: t.folder_id ? (folderMap[t.folder_id] || null) : null };
        if (copy.image_url && copy.image_url.startsWith('data:')) {
          copy.image_url = await state.store.uploadImage(await dataUrlToBlob(copy.image_url));
        }
        await state.store.insert('tasks', copy);
        ok++;
      } catch (e) { toast(`Import de « ${t.title} » impossible : ${e.message}`, 'error'); }
    }
    if (ok === local.length) { lsSet('tasks', []); lsSet('folders', []); }
    toast(`${ok} tâche(s) importée(s)`, 'success');
    reload();
  }

  // ---------------- Modale ----------------
  const backdrop = $('#modal-backdrop');
  const modal = $('#modal');

  function openModal(html, onBind) {
    modal.innerHTML = html;
    backdrop.classList.remove('hidden');
    requestAnimationFrame(() => backdrop.classList.add('open'));
    if (onBind) onBind(modal);
    const first = modal.querySelector('[autofocus]');
    if (first) setTimeout(() => first.focus(), 50);
  }
  function closeModal() {
    backdrop.classList.remove('open');
    backdrop.classList.add('hidden');
    modal.innerHTML = '';
    if (state.form && state.form.previewUrl) URL.revokeObjectURL(state.form.previewUrl);
    state.form = null;
  }

  // ----- Éditeur de tâche -----
  const steamImage = (id) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`;
  const steamId = (v) => (String(v || '').match(/\d{2,}/) || [''])[0];

  function openEditor(task, defaults = {}) {
    const t = task ? { ...task } : {
      title: '', kind: 'daily', reset_hour: 4, reset_minute: 0, reset_weekday: 1, interval_minutes: 480,
      links: [], image_url: null, launch_type: 'none', launch_target: '', notify: true, folder_id: null, ...defaults,
    };
    state.form = { id: task ? task.id : null, image: t.image_url || null, blob: null, previewUrl: null, links: (t.links || []).map((l) => ({ ...l })) };
    const time = `${S.pad(t.reset_hour)}:${S.pad(t.reset_minute)}`;
    const ih = Math.floor(t.interval_minutes / 60);
    const im = t.interval_minutes % 60;

    openModal(`
      <form id="task-form" autocomplete="off">
        <div class="modal-head">
          <h2>${task ? 'Modifier la tâche' : 'Nouvelle tâche'}</h2>
          <button type="button" class="icon-btn" data-close aria-label="Fermer">✕</button>
        </div>
        <div class="modal-body">
          <label class="field">
            <span>Nom</span>
            <input name="title" required maxlength="80" placeholder="Ex. Quêtes journalières Genshin" value="${esc(t.title)}" autofocus>
          </label>

          <label class="field">
            <span>Dossier</span>
            <select name="folder_id">
              <option value="">Sans dossier</option>
              ${state.folders.map((f) => `<option value="${esc(f.id)}" ${f.id === t.folder_id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
            </select>
          </label>

          <div class="field">
            <span>Répétition</span>
            <div class="segmented" data-name="kind">
              <button type="button" data-value="daily">Journalière</button>
              <button type="button" data-value="weekly">Hebdomadaire</button>
              <button type="button" data-value="interval">Timer</button>
            </div>
          </div>

          <div class="row kind-only" data-kind="daily weekly">
            <label class="field kind-only" data-kind="weekly">
              <span>Jour du reset</span>
              <select name="reset_weekday">
                ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<option value="${d}" ${d === t.reset_weekday ? 'selected' : ''}>${S.WEEKDAYS[d][0].toUpperCase() + S.WEEKDAYS[d].slice(1)}</option>`).join('')}
              </select>
            </label>
            <label class="field">
              <span>Heure du reset</span>
              <input type="time" name="reset_time" value="${time}" required>
            </label>
          </div>

          <div class="kind-only" data-kind="interval">
            <div class="row">
              <label class="field"><span>Heures</span><input type="number" name="ih" min="0" max="999" value="${ih}"></label>
              <label class="field"><span>Minutes</span><input type="number" name="im" min="0" max="59" value="${im}"></label>
            </div>
            <div class="presets">
              ${[1, 4, 8, 12, 20, 24, 48].map((h) => `<button type="button" class="chip" data-preset="${h}">${h}h</button>`).join('')}
            </div>
            <p class="hint">Valider la tâche relance le timer à partir de maintenant.</p>
          </div>

          <div class="field">
            <span>Bouton « Lancer »</span>
            <select name="launch_type">
              <option value="none">Aucun</option>
              <option value="steam">Jeu Steam</option>
              <option value="exe">Programme (.exe)</option>
              <option value="url">Page web</option>
            </select>
          </div>
          <div class="launch-only" data-launch="steam">
            <label class="field">
              <span>ID du jeu Steam</span>
              <div class="input-group">
                <input name="steam_id" inputmode="numeric" placeholder="Ex. 1245620 (ou colle le lien Steam)" value="${t.launch_type === 'steam' ? esc(t.launch_target) : ''}">
                <button type="button" class="btn" data-steam-image>Image Steam</button>
              </div>
            </label>
            <p class="hint">L'ID se trouve dans l'adresse de la page du jeu : store.steampowered.com/app/<b>ID</b>/…</p>
          </div>
          <div class="launch-only" data-launch="exe">
            <label class="field">
              <span>Chemin du programme</span>
              <div class="input-group">
                <input name="exe_path" placeholder="C:\\Jeux\\MonJeu\\jeu.exe" value="${t.launch_type === 'exe' ? esc(t.launch_target) : ''}">
                ${desktop ? '<button type="button" class="btn" data-pick-exe>Parcourir…</button>' : ''}
              </div>
            </label>
          </div>
          <div class="launch-only" data-launch="url">
            <label class="field"><span>Adresse</span><input name="launch_url" type="url" placeholder="https://…" value="${t.launch_type === 'url' ? esc(t.launch_target) : ''}"></label>
          </div>

          <div class="field">
            <span>Image</span>
            <div class="image-picker">
              <div class="image-preview" id="image-preview"></div>
              <div class="image-actions">
                <label class="btn">Choisir une image…<input type="file" accept="image/*" id="image-file" hidden></label>
                <input name="image_link" type="url" placeholder="…ou colle l'URL d'une image">
                <button type="button" class="btn btn-ghost" data-image-clear>Retirer l'image</button>
              </div>
            </div>
          </div>

          <div class="field">
            <span>Liens</span>
            <div id="links-list" class="links-list"></div>
            <button type="button" class="btn btn-ghost" data-add-link>+ Ajouter un lien</button>
          </div>

          <label class="switch-row">
            <input type="checkbox" name="notify" ${t.notify !== false ? 'checked' : ''}>
            <span class="switch"></span>
            <span>Me notifier quand la tâche est disponible</span>
          </label>
        </div>
        <div class="modal-foot">
          ${task ? '<button type="button" class="btn btn-danger" data-delete>Supprimer</button>' : ''}
          <span class="spacer"></span>
          <button type="button" class="btn btn-ghost" data-close>Annuler</button>
          <button type="submit" class="btn btn-primary">Enregistrer</button>
        </div>
      </form>`, (root) => bindEditor(root, t));
  }

  function bindEditor(root, t) {
    const form = $('#task-form', root);
    let kind = t.kind;

    const setKind = (k) => {
      kind = k;
      $$('.segmented[data-name="kind"] button', root).forEach((b) => b.classList.toggle('active', b.dataset.value === k));
      $$('.kind-only', root).forEach((el) => el.classList.toggle('hidden', !el.dataset.kind.split(' ').includes(k)));
    };
    setKind(kind);
    $$('.segmented[data-name="kind"] button', root).forEach((b) => b.addEventListener('click', () => setKind(b.dataset.value)));

    const launchSel = form.elements.launch_type;
    launchSel.value = t.launch_type || 'none';
    const setLaunch = () => $$('.launch-only', root).forEach((el) => el.classList.toggle('hidden', el.dataset.launch !== launchSel.value));
    setLaunch();
    launchSel.addEventListener('change', setLaunch);

    $$('[data-preset]', root).forEach((b) => b.addEventListener('click', () => {
      form.elements.ih.value = b.dataset.preset; form.elements.im.value = 0;
    }));

    // Image
    const preview = $('#image-preview', root);
    const showImage = () => {
      const src = state.form.previewUrl || state.form.image;
      preview.style.backgroundImage = src ? `url('${src.replace(/'/g, '%27')}')` : '';
      preview.classList.toggle('empty', !src);
      preview.textContent = src ? '' : 'Aucune image';
    };
    showImage();
    $('#image-file', root).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const blob = await resizeImage(file);
        if (state.form.previewUrl) URL.revokeObjectURL(state.form.previewUrl);
        state.form.blob = blob;
        state.form.previewUrl = URL.createObjectURL(blob);
        showImage();
      } catch (err) { toast(err.message, 'error'); }
    });
    form.elements.image_link.addEventListener('change', (e) => {
      const v = e.target.value.trim();
      if (v && !/^https?:\/\//i.test(v)) { toast('URL d\'image invalide', 'error'); return; }
      state.form.blob = null; state.form.previewUrl = null; state.form.image = v || null; showImage();
    });
    $('[data-image-clear]', root).addEventListener('click', () => {
      state.form.blob = null; state.form.previewUrl = null; state.form.image = null;
      form.elements.image_link.value = ''; showImage();
    });
    $('[data-steam-image]', root).addEventListener('click', () => {
      const id = steamId(form.elements.steam_id.value);
      if (!id) { toast('Indique d\'abord l\'ID Steam', 'warn'); return; }
      state.form.blob = null; state.form.previewUrl = null; state.form.image = steamImage(id); showImage();
    });
    const pick = $('[data-pick-exe]', root);
    if (pick) pick.addEventListener('click', async () => {
      const p = await desktop.pickExe();
      if (p) form.elements.exe_path.value = p;
    });

    // Liens
    const list = $('#links-list', root);
    const renderLinks = () => {
      list.innerHTML = state.form.links.map((l, i) => `
        <div class="link-row" data-i="${i}">
          <input placeholder="Nom (optionnel)" data-k="label" value="${esc(l.label || '')}">
          <input placeholder="https://…" type="url" data-k="url" value="${esc(l.url || '')}">
          <button type="button" class="icon-btn" data-rm="${i}" aria-label="Retirer">✕</button>
        </div>`).join('');
    };
    renderLinks();
    list.addEventListener('input', (e) => {
      const row = e.target.closest('.link-row');
      if (row && e.target.dataset.k) state.form.links[+row.dataset.i][e.target.dataset.k] = e.target.value;
    });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rm]');
      if (b) { state.form.links.splice(+b.dataset.rm, 1); renderLinks(); }
    });
    $('[data-add-link]', root).addEventListener('click', () => {
      state.form.links.push({ label: '', url: '' }); renderLinks();
      const inputs = $$('.link-row:last-child input', list); if (inputs[0]) inputs[0].focus();
    });

    // Suppression
    const del = $('[data-delete]', root);
    if (del) del.addEventListener('click', async () => {
      if (!window.confirm(`Supprimer « ${t.title} » ?`)) return;
      try {
        await state.store.remove('tasks', state.form.id);
        closeModal(); toast('Tâche supprimée'); reload();
      } catch (e) { toast('Suppression impossible : ' + e.message, 'error'); }
    });

    // Enregistrement
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = form.elements;
      const [hh, mm] = (f.reset_time.value || '00:00').split(':').map(Number);
      const interval = (parseInt(f.ih.value, 10) || 0) * 60 + (parseInt(f.im.value, 10) || 0);
      if (kind === 'interval' && interval < 1) { toast('Le timer doit durer au moins 1 minute', 'error'); return; }

      const launchType = f.launch_type.value;
      let target = null;
      if (launchType === 'steam') {
        target = steamId(f.steam_id.value);
        if (!target) { toast('ID Steam invalide', 'error'); return; }
      } else if (launchType === 'exe') {
        target = f.exe_path.value.trim().replace(/^"|"$/g, '');
        if (!target) { toast('Indique le chemin du programme', 'error'); return; }
      } else if (launchType === 'url') {
        target = f.launch_url.value.trim();
        if (!/^https?:\/\//i.test(target)) { toast('Adresse web invalide', 'error'); return; }
      }

      const links = state.form.links.map((l) => ({ label: (l.label || '').trim(), url: (l.url || '').trim() })).filter((l) => l.url);
      const bad = links.find((l) => !/^https?:\/\//i.test(l.url));
      if (bad) { toast('Lien invalide : ' + bad.url, 'error'); return; }

      const submit = $('button[type="submit"]', form);
      submit.disabled = true; submit.textContent = 'Enregistrement…';
      try {
        let image = state.form.image;
        if (state.form.blob) image = await state.store.uploadImage(state.form.blob);
        const data = {
          title: f.title.value.trim(),
          kind,
          reset_hour: hh || 0,
          reset_minute: mm || 0,
          reset_weekday: parseInt(f.reset_weekday.value, 10),
          interval_minutes: kind === 'interval' ? interval : (t.interval_minutes || 480),
          links,
          image_url: image || null,
          launch_type: launchType,
          launch_target: target,
          notify: f.notify.checked,
          folder_id: f.folder_id.value || null,
        };
        if (state.form.id) await state.store.update('tasks', state.form.id, data);
        else await state.store.insert('tasks', { ...data, position: state.tasks.length });
        closeModal();
        toast('Tâche enregistrée', 'success');
        reload();
      } catch (err) {
        toast('Enregistrement impossible : ' + err.message, 'error');
        submit.disabled = false; submit.textContent = 'Enregistrer';
      }
    });
  }

  // ----- Paramètres -----
  async function openSettings() {
    const dset = desktop ? await desktop.getSettings() : null;
    const notifOn = lsGet('notifications', true);
    const webNotif = !desktop && 'Notification' in window;

    let account;
    if (!cloudConfigured) {
      account = `<p class="muted">La synchro cloud n'est pas configurée : renseigne la clé Supabase dans <code>web/config.js</code>. Les tâches sont enregistrées sur cet appareil.</p>`;
    } else if (state.user) {
      account = `
        <p>Connecté : <b>${esc(displayName(state.user))}</b></p>
        <p class="muted">Tes tâches sont synchronisées entre le PC et le téléphone.</p>
        <button type="button" class="btn" data-logout>Se déconnecter</button>`;
    } else {
      account = `
        <form id="auth-form" class="auth">
          <p class="muted">Connecte-toi avec le même compte sur le PC et le téléphone pour synchroniser tes tâches.</p>
          <label class="field"><span>Identifiant</span><input name="login" required minlength="3" maxlength="30"
            autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Ex. yann"></label>
          <p class="hint">Lettres, chiffres, point, tiret ou tiret bas (majuscules ignorées).</p>
          <label class="field"><span>Mot de passe</span><input name="password" type="password" required minlength="6" autocomplete="current-password"></label>
          <div class="row-buttons">
            <button type="submit" class="btn btn-primary" data-mode="signin">Se connecter</button>
            <button type="submit" class="btn" data-mode="signup">Créer un compte</button>
          </div>
        </form>`;
    }

    openModal(`
      <div class="modal-head">
        <h2>Paramètres</h2>
        <button type="button" class="icon-btn" data-close aria-label="Fermer">✕</button>
      </div>
      <div class="modal-body">
        <h3 class="section-title">Compte et synchro</h3>
        ${account}
        <h3 class="section-title">Notifications</h3>
        <label class="switch-row">
          <input type="checkbox" data-setting="notifications" ${notifOn ? 'checked' : ''}>
          <span class="switch"></span><span>Activer les notifications</span>
        </label>
        ${webNotif ? `<button type="button" class="btn" data-perm>${Notification.permission === 'granted' ? 'Notifications autorisées ✓' : 'Autoriser les notifications'}</button>
          <p class="hint">Sur téléphone, les notifications s'affichent tant que l'app est ouverte.</p>` : ''}
        ${desktop ? `
          <h3 class="section-title">Windows</h3>
          <label class="switch-row">
            <input type="checkbox" data-dsetting="openAtLogin" ${dset.openAtLogin ? 'checked' : ''}>
            <span class="switch"></span><span>Lancer TimerHub au démarrage de Windows</span>
          </label>
          ${dset.isPackaged ? '' : '<p class="hint">Le lancement au démarrage ne s\'applique qu\'à la version installée.</p>'}
          <label class="switch-row">
            <input type="checkbox" data-dsetting="closeToTray" ${dset.closeToTray ? 'checked' : ''}>
            <span class="switch"></span><span>Fermer la fenêtre réduit dans la zone de notification</span>
          </label>
          <p class="hint">TimerHub ${esc(state.appVersion || '')} · les mises à jour s'installent automatiquement.</p>` : ''}
      </div>`, bindSettings);
  }

  function bindSettings(root) {
    const notif = $('[data-setting="notifications"]', root);
    notif.addEventListener('change', () => lsSet('notifications', notif.checked));

    $$('[data-dsetting]', root).forEach((el) => el.addEventListener('change', () =>
      desktop.setSettings({ [el.dataset.dsetting]: el.checked })));

    const perm = $('[data-perm]', root);
    if (perm) perm.addEventListener('click', async () => {
      const r = await Notification.requestPermission();
      perm.textContent = r === 'granted' ? 'Notifications autorisées ✓' : 'Notifications refusées';
    });

    const logout = $('[data-logout]', root);
    if (logout) logout.addEventListener('click', async () => {
      await state.client.auth.signOut();
      closeModal();
    });

    const auth = $('#auth-form', root);
    if (auth) {
      let mode = 'signin';
      $$('button[data-mode]', auth).forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; }));
      auth.addEventListener('submit', async (e) => {
        e.preventDefault();
        const login = auth.elements.login.value.trim().toLowerCase();
        if (!login.includes('@') && !/^[a-z0-9._-]{3,30}$/.test(login)) {
          toast('Identifiant invalide : 3 à 30 caractères (lettres, chiffres, . _ -)', 'error');
          return;
        }
        const email = loginToEmail(login);
        const password = auth.elements.password.value;
        const buttons = $$('button', auth); buttons.forEach((b) => { b.disabled = true; });
        try {
          if (mode === 'signup') {
            const { data, error } = await state.client.auth.signUp({ email, password });
            if (error) throw error;
            if (!data.session) {
              toast('Compte créé, mais Supabase demande une confirmation par e-mail : désactive « Confirm email » dans Supabase (Authentication → Sign In / Providers → Email), puis connecte-toi.', 'warn', 12000);
              buttons.forEach((b) => { b.disabled = false; });
              return;
            }
          } else {
            const { error } = await state.client.auth.signInWithPassword({ email, password });
            if (error) throw error;
          }
          closeModal();
          toast(mode === 'signup' ? 'Compte créé' : 'Connecté', 'success');
        } catch (err) {
          const msg = /Invalid login/i.test(err.message) ? 'Identifiant ou mot de passe incorrect'
            : /already registered|already exists/i.test(err.message) ? 'Cet identifiant est déjà pris'
            : /not confirmed/i.test(err.message) ? 'Compte pas encore confirmé : désactive « Confirm email » dans Supabase'
            : err.message;
          toast(msg, 'error');
          buttons.forEach((b) => { b.disabled = false; });
        }
      });
    }
  }

  // ---------------- Toasts ----------------
  function toast(msg, type = 'info', ms = 3500) {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
  }

  // ---------------- Événements ----------------
  function bindStatic() {
    $('#btn-add').addEventListener('click', () => openEditor(null));
    $('#empty').addEventListener('click', (e) => {
      if (e.target.closest('[data-action="folder-new"]')) openFolderForm(null);
    });
    $('#btn-add-empty').addEventListener('click', () => openEditor(null));
    $('#btn-settings').addEventListener('click', openSettings);

    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (!b) return;
      state.view = b.dataset.view; lsSet('view', state.view); render();
    });

    toolbar.addEventListener('click', (e) => {
      const f = e.target.closest('button[data-filter]');
      if (f) { state.filter = f.dataset.filter; lsSet('filter', state.filter); render(); return; }
      const a = e.target.closest('[data-action]');
      if (!a) return;
      if (a.dataset.action === 'folder-new') openFolderForm(null);
      else if (a.dataset.action === 'expand-all') { state.collapsed = {}; lsSet('collapsed', {}); render(); }
      else if (a.dataset.action === 'collapse-all') {
        state.collapsed = { none: true };
        state.folders.forEach((x) => { state.collapsed[x.id] = true; });
        lsSet('collapsed', state.collapsed); render();
      }
    });

    // Glisser-déposer des tâches entre dossiers (onglet Rangement)
    content.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.card[draggable]');
      if (!card) return;
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
      content.classList.add('drag-active');
    });
    content.addEventListener('dragend', (e) => {
      const card = e.target.closest('.card');
      if (card) card.classList.remove('dragging');
      content.classList.remove('drag-active');
      $$('.folder.drop-over', content).forEach((x) => x.classList.remove('drop-over'));
    });
    content.addEventListener('dragover', (e) => {
      const sec = e.target.closest('.folder');
      if (!sec) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      $$('.folder.drop-over', content).forEach((x) => { if (x !== sec) x.classList.remove('drop-over'); });
      sec.classList.add('drop-over');
    });
    content.addEventListener('drop', (e) => {
      const sec = e.target.closest('.folder');
      if (!sec) return;
      e.preventDefault();
      sec.classList.remove('drop-over');
      const id = e.dataTransfer.getData('text/plain');
      if (id) moveTask(id, sec.dataset.folder);
    });

    $('#banner').addEventListener('click', (e) => {
      if (e.target.closest('[data-open="settings"]')) openSettings();
      if (e.target.closest('[data-dismiss]')) { lsSet('bannerDismissed', true); renderSync(); }
    });

    content.addEventListener('click', (e) => {
      const adminBtn = e.target.closest('[data-admin]');
      if (adminBtn) { adminAction(adminBtn.dataset.admin, adminBtn.closest('[data-member]').dataset.member); return; }
      const pendingBtn = e.target.closest('.pending-card [data-action]');
      if (pendingBtn) {
        if (pendingBtn.dataset.action === 'recheck') reload();
        else if (pendingBtn.dataset.action === 'logout') state.client.auth.signOut();
        return;
      }
      const head = e.target.closest('.folder-head');
      if (head) {
        const sec = head.closest('.folder');
        const id = sec.dataset.folder;
        const folder = state.folders.find((x) => x.id === id);
        const btn = e.target.closest('[data-action]');
        const act = btn ? btn.dataset.action : 'toggle-folder';
        if (act === 'folder-add') openEditor(null, { folder_id: folder ? folder.id : null });
        else if (act === 'folder-rename' && folder) openFolderForm(folder);
        else if (act === 'folder-delete' && folder) deleteFolder(folder);
        else { setCollapsed(id, !state.collapsed[id]); render(); }
        return;
      }
      const card = e.target.closest('.card');
      if (!card) return;
      const t = state.tasks.find((x) => x.id === card.dataset.id);
      if (!t) return;
      const linkBtn = e.target.closest('[data-link]');
      if (linkBtn) { openUrl(t.links[+linkBtn.dataset.link].url); return; }
      const action = e.target.closest('[data-action]');
      if (!action) return;
      if (action.dataset.action === 'edit') openEditor(t);
      else if (action.dataset.action === 'toggle') toggleDone(t);
      else if (action.dataset.action === 'launch') launch(t);
    });

    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
    modal.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) closeModal();
      else if (e.key.toLowerCase() === 'n' && (e.ctrlKey || e.metaKey) && backdrop.classList.contains('hidden')) { e.preventDefault(); openEditor(null); }
    });
  }

  init();
})();
