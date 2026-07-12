(() => {
  'use strict';

  const CONFIG_KEY = 'magazzino-ar-cloud-config-v2';
  const LEGACY_CONFIG_KEY = 'magazzino-ar-cloud-config-v1';
  const QUEUE_KEY = 'magazzino-ar-cloud-queue-v1';
  const ALLOWED_STORES = ['products', 'locations', 'movements', 'settings'];

  class MagazzinoCloudSync {
    constructor() {
      this.db = null;
      this.onStatus = null;
      this.onRemoteApplied = null;
      this.flushing = false;
      this.syncing = false;
    }

    init({ db, onStatus, onRemoteApplied } = {}) {
      this.db = db || null;
      this.onStatus = typeof onStatus === 'function' ? onStatus : null;
      this.onRemoteApplied = typeof onRemoteApplied === 'function' ? onRemoteApplied : null;
      this.migrateLegacyConfig();
      this.emitStatus(this.isConfigured() ? 'idle' : 'disabled');
    }

    migrateLegacyConfig() {
      if (localStorage.getItem(CONFIG_KEY)) return;
      try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_CONFIG_KEY) || '{}');
        const apiUrl = String(legacy.apiUrl || '').trim().replace(/\/+$/, '');
        if (apiUrl) localStorage.setItem(CONFIG_KEY, JSON.stringify({ apiUrl }));
      } catch {
        // Ignora una configurazione precedente danneggiata.
      }
    }

    getConfig() {
      try {
        const parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
        return { apiUrl: String(parsed.apiUrl || '').trim().replace(/\/+$/, '') };
      } catch {
        return { apiUrl: '' };
      }
    }

    saveConfig(config) {
      const normalized = {
        apiUrl: String(config?.apiUrl || '').trim().replace(/\/+$/, '')
      };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(normalized));
      this.emitStatus(this.isConfigured() ? 'idle' : 'disabled');
      return normalized;
    }

    clearConfig() {
      localStorage.removeItem(CONFIG_KEY);
      localStorage.removeItem(LEGACY_CONFIG_KEY);
      localStorage.removeItem(QUEUE_KEY);
      this.emitStatus('disabled');
    }

    isConfigured() {
      return Boolean(this.getConfig().apiUrl);
    }

    getQueue() {
      try {
        const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
        return Array.isArray(queue) ? queue : [];
      } catch {
        return [];
      }
    }

    saveQueue(queue) {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-2000)));
    }

    enqueue(mutation) {
      if (!this.isConfigured() || !mutation) return;
      let queue = this.getQueue();

      if (mutation.action === 'replace-all') {
        queue = [{ action: 'replace-all', queuedAt: new Date().toISOString() }];
      } else if (mutation.action === 'clear-all') {
        queue = [{ action: 'clear-all', queuedAt: new Date().toISOString() }];
      } else if (mutation.action === 'clear-store') {
        queue = queue.filter(item => item.storeName !== mutation.storeName);
        queue.push({ action: 'clear-store', storeName: mutation.storeName, queuedAt: new Date().toISOString() });
      } else if ((mutation.action === 'put' || mutation.action === 'delete') && ALLOWED_STORES.includes(mutation.storeName)) {
        const id = String(mutation.id || '');
        if (!id) return;
        queue = queue.filter(item => !(item.storeName === mutation.storeName && item.id === id));
        queue.push({
          action: mutation.action,
          storeName: mutation.storeName,
          id,
          value: mutation.action === 'put' ? this.prepareRecord(mutation.value) : undefined,
          queuedAt: new Date().toISOString()
        });
      }

      this.saveQueue(queue);
      this.emitStatus(navigator.onLine ? 'pending' : 'offline', `${queue.length} modifiche in attesa`);
      if (navigator.onLine) setTimeout(() => this.flush().catch(() => {}), 80);
    }

    prepareRecord(value) {
      if (!value || typeof value !== 'object') return value;
      const copy = typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
      const json = JSON.stringify(copy);
      if (json.length > 1750000 && copy.imageData) {
        copy.imageData = '';
        copy.cloudImageOmitted = true;
      }
      return copy;
    }

    async request(path, options = {}) {
      const config = this.getConfig();
      if (!this.isConfigured()) throw new Error('Cloudflare non configurato.');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 18000);

      try {
        const response = await fetch(`${config.apiUrl}${path}`, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
          },
          signal: controller.signal
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Errore cloud ${response.status}`);
        return payload;
      } finally {
        clearTimeout(timeout);
      }
    }

    async testConnection() {
      this.emitStatus('syncing', 'Verifica Cloudflare…');
      const result = await this.request('/api/health', { method: 'GET' });
      this.emitStatus('online', 'Cloudflare collegato');
      return result;
    }

    async flush() {
      if (!this.isConfigured() || !navigator.onLine) return false;
      if (this.flushing) {
        for (let attempt = 0; attempt < 180 && this.flushing; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return !this.getQueue().length;
      }
      this.flushing = true;
      this.emitStatus('syncing', 'Invio modifiche…');

      try {
        let queue = this.getQueue();
        while (queue.length) {
          const item = queue[0];
          if (item.action === 'replace-all') {
            await this.request('/api/warehouse', { method: 'DELETE' });
            queue.shift();
            this.saveQueue(queue);
            await this.enqueueCurrentSnapshot(false);
            queue = this.getQueue();
            continue;
          }
          await this.sendMutation(item);
          queue.shift();
          this.saveQueue(queue);
        }
        this.emitStatus('online', 'Dati salvati su Cloudflare');
        return true;
      } catch (error) {
        console.error('Cloudflare flush:', error);
        this.emitStatus(navigator.onLine ? 'error' : 'offline', error.message || 'Sincronizzazione non riuscita');
        throw error;
      } finally {
        this.flushing = false;
      }
    }

    async sendMutation(item) {
      const common = { storeName: item.storeName, id: item.id };
      if (item.action === 'put') {
        return this.request('/api/record', { method: 'PUT', body: JSON.stringify({ ...common, data: item.value }) });
      }
      if (item.action === 'delete') {
        return this.request('/api/record', { method: 'DELETE', body: JSON.stringify(common) });
      }
      if (item.action === 'clear-store') {
        return this.request('/api/store', { method: 'DELETE', body: JSON.stringify({ storeName: item.storeName }) });
      }
      if (item.action === 'clear-all') {
        return this.request('/api/warehouse', { method: 'DELETE' });
      }
      return null;
    }

    async enqueueCurrentSnapshot(flushAfter = true) {
      if (!this.db) return;
      const snapshot = await this.db.exportAll();
      let queue = this.getQueue().filter(item => item.action !== 'replace-all');
      for (const storeName of ALLOWED_STORES) {
        for (const value of snapshot[storeName] || []) {
          const id = String(value?.id ?? value?.key ?? '');
          if (!id) continue;
          queue = queue.filter(item => !(item.storeName === storeName && item.id === id));
          queue.push({ action: 'put', storeName, id, value: this.prepareRecord(value), queuedAt: new Date().toISOString() });
        }
      }
      this.saveQueue(queue);
      if (flushAfter) await this.flush();
    }

    async fetchRemote() {
      return this.request('/api/sync', { method: 'GET' });
    }

    async syncNow() {
      if (this.syncing) return false;
      if (!this.isConfigured()) throw new Error('Inserisci prima il collegamento Cloudflare nelle Impostazioni.');
      if (!navigator.onLine) throw new Error('Connessione Internet non disponibile.');
      this.syncing = true;
      this.emitStatus('syncing', 'Sincronizzazione completa…');

      try {
        const flushed = await this.flush();
        if (flushed === false && this.getQueue().length) throw new Error('Modifiche locali ancora in attesa.');

        const remote = await this.fetchRemote();
        const stores = remote.stores || { products: [], locations: [], movements: [], settings: [] };
        const local = await this.db.exportAll();
        const localCount = ALLOWED_STORES.reduce((sum, name) => sum + (local[name]?.length || 0), 0);

        if (!remote.initialized && localCount) {
          await this.enqueueCurrentSnapshot(true);
          this.emitStatus('online', 'Archivio caricato su Cloudflare');
          return true;
        }

        if (remote.initialized) {
          await this.db.importAll(stores, { silent: true });
          await this.onRemoteApplied?.();
        }

        this.emitStatus('online', remote.initialized ? 'Dati aggiornati da Cloudflare' : 'Cloudflare pronto');
        return true;
      } catch (error) {
        console.error('Cloudflare sync:', error);
        this.emitStatus('error', error.message || 'Sincronizzazione non riuscita');
        throw error;
      } finally {
        this.syncing = false;
      }
    }

    emitStatus(status, message = '') {
      this.onStatus?.({ status, message, configured: this.isConfigured(), pending: this.getQueue().length });
    }
  }

  window.magazzinoCloud = new MagazzinoCloudSync();
})();
