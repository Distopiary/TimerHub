// Stockage des tâches et des dossiers : local (cet appareil) ou cloud (Supabase).
(function () {
  'use strict';

  const PREFIX = 'timerhub.';
  const lsGet = (k, d) => {
    try { const v = localStorage.getItem(PREFIX + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  };
  const lsSet = (k, v) => {
    try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* stockage indisponible */ }
  };

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));

  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  const FIELDS = {
    tasks: ['title', 'kind', 'reset_hour', 'reset_minute', 'reset_weekday', 'interval_minutes',
      'last_done_at', 'prev_done_at', 'links', 'image_url', 'launch_type', 'launch_target', 'notify', 'position', 'folder_id', 'due_at', 'duration_minutes'],
    folders: ['name', 'position'],
  };
  const pick = (table, obj) => {
    const out = {};
    for (const k of FIELDS[table]) if (k in obj) out[k] = obj[k];
    return out;
  };

  // ---------- Stockage local ----------
  class LocalStore {
    constructor() {
      this.isCloud = false;
      this.listeners = [];
      this._onStorage = (e) => {
        if (e.key === PREFIX + 'tasks' || e.key === PREFIX + 'folders') this._emit();
      };
      window.addEventListener('storage', this._onStorage);
    }
    _emit() { this.listeners.forEach((cb) => cb()); }
    async list(table) { return lsGet(table, []); }
    async insert(table, row) {
      const now = new Date().toISOString();
      const full = { ...pick(table, row), id: uuid(), created_at: now, updated_at: now };
      lsSet(table, [...lsGet(table, []), full]);
      return full;
    }
    async update(table, id, patch) {
      const list = lsGet(table, []);
      const i = list.findIndex((r) => r.id === id);
      if (i < 0) throw new Error('Élément introuvable');
      list[i] = { ...list[i], ...pick(table, patch), updated_at: new Date().toISOString() };
      lsSet(table, list);
      return list[i];
    }
    async remove(table, id) {
      lsSet(table, lsGet(table, []).filter((r) => r.id !== id));
      if (table === 'folders') {
        lsSet('tasks', lsGet('tasks', []).map((t) => (t.folder_id === id ? { ...t, folder_id: null } : t)));
      }
    }
    async uploadImage(blob) { return blobToDataUrl(blob); }
    onChange(cb) { this.listeners.push(cb); }
    dispose() { window.removeEventListener('storage', this._onStorage); this.listeners = []; }
  }

  // ---------- Stockage cloud (Supabase) ----------
  class CloudStore {
    constructor(client, user) {
      this.isCloud = true;
      this.client = client;
      this.user = user;
      this.listeners = [];
      const emit = () => this.listeners.forEach((cb) => cb());
      const filter = `user_id=eq.${user.id}`;
      this.channel = client.channel('timerhub-' + user.id)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter }, emit)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'folders', filter }, emit)
        // Validation des comptes (RLS : un membre ne reçoit que sa ligne, l'administrateur toutes)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'members' }, emit)
        .subscribe();
    }
    async list(table) {
      const { data, error } = await this.client.from(table).select('*')
        .order('position', { ascending: true }).order('created_at', { ascending: true });
      const cacheKey = `cache.${this.user.id}.${table}`;
      if (error) {
        const cached = lsGet(cacheKey, null);
        if (cached) { const e = new Error(error.message); e.cached = cached; throw e; }
        throw new Error(error.message);
      }
      lsSet(cacheKey, data);
      return data;
    }
    async insert(table, row) {
      const { data, error } = await this.client.from(table).insert(pick(table, row)).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    async update(table, id, patch) {
      const { data, error } = await this.client.from(table).update(pick(table, patch)).eq('id', id).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    async remove(table, id) {
      const { error } = await this.client.from(table).delete().eq('id', id);
      if (error) throw new Error(error.message);
    }
    async uploadImage(blob) {
      const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const path = `${this.user.id}/${uuid()}.${ext}`;
      const { error } = await this.client.storage.from('task-images')
        .upload(path, blob, { contentType: blob.type, cacheControl: '31536000' });
      if (error) throw new Error(error.message);
      return this.client.storage.from('task-images').getPublicUrl(path).data.publicUrl;
    }
    onChange(cb) { this.listeners.push(cb); }
    dispose() { this.client.removeChannel(this.channel); this.listeners = []; }
  }

  // Redimensionne une image (max 800 px de large) pour limiter le stockage.
  async function resizeImage(file, maxW = 800) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('Image illisible')); i.src = url;
      });
      const scale = Math.min(1, maxW / img.naturalWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function dataUrlToBlob(dataUrl) { return (await fetch(dataUrl)).blob(); }

  window.TimerStore = { LocalStore, CloudStore, lsGet, lsSet, resizeImage, dataUrlToBlob };
})();
