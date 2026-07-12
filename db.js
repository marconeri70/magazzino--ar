(() => {
  'use strict';

  const DB_NAME = 'magazzino-ar-db';
  const DB_VERSION = 1;
  const STORES = ['products', 'locations', 'movements', 'settings'];

  class WarehouseDB {
    constructor() {
      this.db = null;
      this.mutationHandler = null;
      this.suppressMutations = false;
    }

    setMutationHandler(handler) {
      this.mutationHandler = typeof handler === 'function' ? handler : null;
    }

    setMutationSuppressed(value) {
      this.suppressMutations = Boolean(value);
    }

    emitMutation(mutation, options = {}) {
      if (options.silent || this.suppressMutations || !this.mutationHandler) return;
      try {
        const result = this.mutationHandler(mutation);
        if (result?.catch) result.catch(error => console.debug('Sincronizzazione cloud:', error));
      } catch (error) {
        console.debug('Sincronizzazione cloud:', error);
      }
    }

    async open() {
      if (this.db) return this.db;
      this.db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;

          if (!db.objectStoreNames.contains('products')) {
            const store = db.createObjectStore('products', { keyPath: 'id' });
            store.createIndex('barcode', 'barcode', { unique: true });
            store.createIndex('name', 'name', { unique: false });
            store.createIndex('locationId', 'locationId', { unique: false });
          }

          if (!db.objectStoreNames.contains('locations')) {
            const store = db.createObjectStore('locations', { keyPath: 'id' });
            store.createIndex('code', 'code', { unique: true });
          }

          if (!db.objectStoreNames.contains('movements')) {
            const store = db.createObjectStore('movements', { keyPath: 'id' });
            store.createIndex('productId', 'productId', { unique: false });
            store.createIndex('timestamp', 'timestamp', { unique: false });
            store.createIndex('type', 'type', { unique: false });
          }

          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'key' });
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Impossibile aprire il database.'));
        request.onblocked = () => reject(new Error('Database bloccato da un’altra scheda.'));
      });

      this.db.onversionchange = () => {
        this.db.close();
        this.db = null;
      };

      return this.db;
    }

    async getAll(storeName) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    }

    async get(storeName, key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    }

    async getByIndex(storeName, indexName, value) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).index(indexName).get(value);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    }

    async put(storeName, value, options = {}) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const request = tx.objectStore(storeName).put(value);
        request.onsuccess = () => {
          resolve(value);
          this.emitMutation({ action: 'put', storeName, id: value?.id ?? value?.key, value }, options);
        };
        request.onerror = () => reject(request.error);
      });
    }

    async add(storeName, value, options = {}) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const request = tx.objectStore(storeName).add(value);
        request.onsuccess = () => {
          resolve(value);
          this.emitMutation({ action: 'put', storeName, id: value?.id ?? value?.key, value }, options);
        };
        request.onerror = () => reject(request.error);
      });
    }

    async delete(storeName, key, options = {}) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const request = tx.objectStore(storeName).delete(key);
        request.onsuccess = () => {
          resolve(true);
          this.emitMutation({ action: 'delete', storeName, id: key }, options);
        };
        request.onerror = () => reject(request.error);
      });
    }

    async clear(storeName, options = {}) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const request = tx.objectStore(storeName).clear();
        request.onsuccess = () => {
          resolve(true);
          this.emitMutation({ action: 'clear-store', storeName }, options);
        };
        request.onerror = () => reject(request.error);
      });
    }

    async clearAll(options = {}) {
      this.setMutationSuppressed(true);
      try {
        for (const store of STORES) await this.clear(store, { silent: true });
      } finally {
        this.setMutationSuppressed(false);
      }
      this.emitMutation({ action: 'clear-all' }, options);
    }

    async exportAll() {
      return {
        version: DB_VERSION,
        exportedAt: new Date().toISOString(),
        products: await this.getAll('products'),
        locations: await this.getAll('locations'),
        movements: await this.getAll('movements'),
        settings: await this.getAll('settings')
      };
    }

    async importAll(payload, options = {}) {
      if (!payload || typeof payload !== 'object') throw new Error('File di backup non valido.');

      this.setMutationSuppressed(true);
      try {
        for (const storeName of STORES) {
          if (!Array.isArray(payload[storeName])) continue;
          await this.clear(storeName, { silent: true });
          for (const item of payload[storeName]) await this.put(storeName, item, { silent: true });
        }
      } finally {
        this.setMutationSuppressed(false);
      }

      if (!options.silent) this.emitMutation({ action: 'replace-all' });
    }
  }

  window.warehouseDB = new WarehouseDB();
})();
