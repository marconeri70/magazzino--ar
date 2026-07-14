(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const state = {
    products: [],
    locations: [],
    movements: [],
    settings: { company: '', operator: 'Operatore' },
    currentView: 'dashboard',
    scannerCallback: null,
    scannerControls: null,
    scannerReader: null,
    scannerStream: null,
    scannerLoop: null,
    scannerBusy: false,
    cameras: [],
    cameraIndex: 0,
    torchOn: false,
    currentImageData: '',
    selectedFindId: null,
    arStream: null,
    arProductId: null,
    deferredPrompt: null,
    qrPreview: { dataUrl: '', filename: '', title: '' },
    settingsUnlocked: false,
    pinResolver: null,
    pinPurpose: '',
    currentDetailProductId: null,
    currentDetailLocationId: null,
    cloudStatus: { status: 'disabled', message: '', configured: false, pending: 0 }
  };

  const ADMIN_PIN_HASH_KEY = 'magazzino-ar-admin-pin-hash-v1';
  const DEFAULT_ADMIN_PIN = '1234';

  const movementLabels = {
    IN: 'Entrata',
    OUT: 'Uscita',
    MOVE: 'Spostamento',
    ADJUST: 'Rettifica'
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindEvents();
    registerServiceWorker();
    updateConnectionStatus();
    renderCompatibility();

    try {
      await ensureDefaultPin();
      await window.warehouseDB.open();
      window.magazzinoCloud?.init({
        db: window.warehouseDB,
        onStatus: updateCloudStatus,
        onRemoteApplied: async () => {
          await loadState();
          renderAll();
        }
      });
      window.warehouseDB.setMutationHandler(mutation => window.magazzinoCloud?.enqueue(mutation));
      await loadState();
      renderAll();

      if (window.magazzinoCloud?.isConfigured() && navigator.onLine) {
        window.magazzinoCloud.syncNow().catch(error => console.debug('Sincronizzazione iniziale:', error));
      }
    } catch (error) {
      console.error(error);
      notify('Non è stato possibile aprire l’archivio locale.', 'error');
    }
  }

  async function loadState() {
    const [products, locations, movements, settingsRows] = await Promise.all([
      warehouseDB.getAll('products'),
      warehouseDB.getAll('locations'),
      warehouseDB.getAll('movements'),
      warehouseDB.getAll('settings')
    ]);

    state.products = products.sort((a, b) => String(a.name).localeCompare(String(b.name), 'it'));
    state.locations = locations.sort((a, b) => String(a.code).localeCompare(String(b.code), 'it'));
    state.movements = movements.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const companyRow = settingsRows.find(item => item.key === 'company');
    const operatorRow = settingsRows.find(item => item.key === 'operator');
    state.settings.company = companyRow?.value || '';
    state.settings.operator = operatorRow?.value || 'Operatore';
  }

  function bindEvents() {
    $$('.nav-btn, .mobile-nav[data-view]').forEach(button => {
      button.addEventListener('click', () => switchView(button.dataset.view));
    });

    $$('[data-view-link]').forEach(button => {
      button.addEventListener('click', () => switchView(button.dataset.viewLink));
    });

    $('#quickScanBtn').addEventListener('click', quickScan);
    $('#mobileScanBtn').addEventListener('click', quickScan);
    $('#addProductBtn').addEventListener('click', () => openProductForm());
    $('#addProductHeroBtn').addEventListener('click', () => openProductForm());
    $('#addLocationBtn').addEventListener('click', () => openLocationForm());
    $('#newMovementBtn').addEventListener('click', () => openMovementForm());

    $('#productSearch').addEventListener('input', renderProducts);
    $('#productFilter').addEventListener('change', renderProducts);
    $('#locationSearch').addEventListener('input', renderLocations);
    $('#movementSearch').addEventListener('input', renderMovements);
    $('#movementFilter').addEventListener('change', renderMovements);
    $('#findSearch').addEventListener('input', renderFindResults);

    $('#scanProductSearchBtn').addEventListener('click', () => {
      openScanner('Cerca prodotto', raw => {
        const product = resolveScannedProduct(raw);
        $('#productSearch').value = product ? product.barcode : raw;
        switchView('products');
        renderProducts();
        if (product) notify(`Trovato: ${product.name}`, 'success');
      });
    });

    $('#scanLocationSearchBtn').addEventListener('click', () => {
      openScanner('Leggi QR area', raw => {
        $('#locationSearch').value = parseLocationCode(raw);
        switchView('locations');
        renderLocations();
      });
    });

    $('#scanProductFieldBtn').addEventListener('click', () => {
      openScanner('Codice del prodotto', raw => {
        $('#productBarcode').value = normalizeCode(raw);
        const existing = getProductByBarcode(raw);
        if (existing && existing.id !== $('#productId').value) {
          notify('Questo codice è già associato a un prodotto.', 'error');
        }
      });
    });

    $('#scanProductLocationBtn').addEventListener('click', () => {
      openScanner('Scansiona il QR dell’area di stoccaggio', raw => {
        const location = getLocationByCode(parseLocationCode(raw));
        if (!location) {
          notify('Area non registrata. Creala prima nella sezione Posizioni.', 'error');
          return;
        }
        $('#productLocation').value = location.id;
        syncProductLocationFields();
        notify(`Area selezionata: ${locationDisplayName(location)}`, 'success');
      });
    });

    $('#scanMovementProductBtn').addEventListener('click', () => {
      openScanner('Prodotto da movimentare', raw => {
        const product = resolveScannedProduct(raw);
        if (!product) {
          notify('Prodotto non ancora registrato.', 'error');
          return;
        }
        $('#movementProduct').value = product.id;
        syncMovementFields();
      });
    });

    $('#scanMovementLocationBtn').addEventListener('click', () => {
      openScanner('Nuova area di stoccaggio', raw => {
        const location = getLocationByCode(parseLocationCode(raw));
        if (!location) {
          notify('Area non registrata.', 'error');
          return;
        }
        $('#movementDestination').value = location.id;
        syncMovementDestinationFields(true);
        notify(`Area selezionata: ${locationDisplayName(location)}`, 'success');
      });
    });

    $('#productForm').addEventListener('submit', saveProduct);
    $('#locationForm').addEventListener('submit', saveLocation);
    $('#movementForm').addEventListener('submit', saveMovement);
    $('#settingsForm').addEventListener('submit', saveSettings);
    $('#cloudForm').addEventListener('submit', saveCloudSettings);
    $('#testCloudBtn').addEventListener('click', testCloudConnection);
    $('#syncCloudBtn').addEventListener('click', syncCloudNow);
    $('#changePinBtn').addEventListener('click', changeAdminPin);
    $('#lockSettingsBtn').addEventListener('click', lockSettings);
    $('#pinForm').addEventListener('submit', submitPinChallenge);
    $('#pinDialog').addEventListener('close', finishCancelledPinChallenge);

    const productQrBtn = $('#productQrBtn');
    if (productQrBtn) {
      productQrBtn.addEventListener('click', () => {
        const product = getProduct($('#productId').value);
        if (product) printProductLabel(product);
      });
    }

    const locationQrBtn = $('#locationQrBtn');
    if (locationQrBtn) {
      locationQrBtn.addEventListener('click', () => {
        const location = getLocation($('#locationId').value);
        if (location) printLocationLabel(location);
      });
    }

    $('#detailProductQrBtn').addEventListener('click', detailProductQr);
    $('#detailProductFindBtn').addEventListener('click', detailProductFind);
    $('#detailProductMoveBtn').addEventListener('click', detailProductMove);
    $('#detailProductEditBtn').addEventListener('click', detailProductEdit);
    $('#detailLocationQrBtn').addEventListener('click', detailLocationQr);
    $('#detailLocationEditBtn').addEventListener('click', detailLocationEdit);
    $('#locationDetailContent').addEventListener('click', openProductFromLocationDetail);

    $('#downloadQrBtn').addEventListener('click', downloadQrImage);
    $('#shareQrBtn').addEventListener('click', shareQrImage);
    $('#printQrBtn').addEventListener('click', printQrImage);

    $('#productImage').addEventListener('change', handleProductImage);
    $('#productLocation').addEventListener('change', syncProductLocationFields);
    $('#movementType').addEventListener('change', syncMovementFields);
    $('#movementProduct').addEventListener('change', syncMovementFields);
    $('#movementDestination').addEventListener('change', () => syncMovementDestinationFields(true));

    $('#productList').addEventListener('click', handleProductAction);
    $('#productList').addEventListener('keydown', handleProductCardKeydown);
    $('#locationList').addEventListener('click', handleLocationAction);
    $('#locationList').addEventListener('keydown', handleLocationCardKeydown);
    $('#findResults').addEventListener('click', handleFindSelection);
    $('#findSelected').addEventListener('click', handleFindAction);

    $$('.action-tile').forEach(button => {
      button.addEventListener('click', () => handleQuickAction(button.dataset.action));
    });

    $$('[data-close-dialog]').forEach(button => {
      button.addEventListener('click', () => closeDialog(button.dataset.closeDialog));
    });

    $('#scannerDialog').addEventListener('close', stopScanner);
    $('#manualCodeBtn').addEventListener('click', useManualCode);
    $('#manualCodeInput').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        useManualCode();
      }
    });
    $('#switchCameraBtn').addEventListener('click', switchCamera);
    $('#torchBtn').addEventListener('click', toggleTorch);

    $('#exportBtn').addEventListener('click', exportBackup);
    $('#importInput').addEventListener('change', importBackup);
    $('#demoBtn').addEventListener('click', loadDemoData);
    $('#resetBtn').addEventListener('click', resetAllData);

    $('#closeArBtn').addEventListener('click', closeArGuide);
    $('#calibrateArBtn').addEventListener('click', calibrateArGuide);
    $('#completeFindBtn').addEventListener('click', () => {
      notify('Posizione verificata. Operazione completata.', 'success');
      closeArGuide();
    });
    $('#arDialog').addEventListener('close', stopArCamera);

    $('#installBtn').addEventListener('click', installPwa);
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      state.deferredPrompt = event;
      $('#installBtn').classList.remove('hidden');
    });
    window.addEventListener('appinstalled', () => {
      state.deferredPrompt = null;
      $('#installBtn').classList.add('hidden');
      notify('Applicazione installata.', 'success');
    });

    window.addEventListener('online', handleConnectionChange);
    window.addEventListener('offline', handleConnectionChange);
  }

  function renderAll() {
    renderDashboard();
    renderProducts();
    renderLocations();
    renderMovements();
    renderFindResults();
    if (state.settingsUnlocked) renderSettings();
    populateSelects();
  }

  function switchView(view) {
    if (view === 'settings' && !state.settingsUnlocked) {
      requestSettingsAccess();
      return;
    }
    if (state.currentView === 'settings' && view !== 'settings') state.settingsUnlocked = false;

    state.currentView = view;
    $$('.view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
    $$('.nav-btn, .mobile-nav[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (view === 'dashboard') renderDashboard();
    if (view === 'products') renderProducts();
    if (view === 'locations') renderLocations();
    if (view === 'movements') renderMovements();
    if (view === 'find') renderFindResults();
    if (view === 'settings') renderSettings();
  }

  function renderDashboard() {
    $('#statProducts').textContent = formatNumber(state.products.length);
    $('#statQuantity').textContent = formatNumber(state.products.reduce((sum, product) => sum + Number(product.quantity || 0), 0));
    $('#statLowStock').textContent = formatNumber(state.products.filter(isLowStock).length);
    $('#statLocations').textContent = formatNumber(state.locations.length);

    const recent = state.movements.slice(0, 6);
    const container = $('#recentMovements');
    if (!recent.length) {
      container.className = 'activity-list empty-state';
      container.textContent = 'Nessun movimento registrato.';
      return;
    }

    container.className = 'activity-list';
    container.innerHTML = recent.map(movement => {
      const product = getProduct(movement.productId);
      const symbol = movement.type === 'IN' ? '↓' : movement.type === 'OUT' ? '↑' : movement.type === 'MOVE' ? '⇄' : '≈';
      const qtyPrefix = movement.type === 'OUT' ? '−' : movement.type === 'IN' ? '+' : '';
      return `
        <div class="activity-item">
          <div class="activity-icon">${symbol}</div>
          <div><strong>${escapeHtml(product?.name || movement.productName || 'Prodotto eliminato')}</strong><small>${movementLabels[movement.type]} · ${formatDateTime(movement.timestamp)}</small></div>
          <div class="activity-qty">${qtyPrefix}${formatNumber(movement.quantity)}</div>
        </div>`;
    }).join('');
  }

  function renderProducts() {
    const query = normalizeText($('#productSearch')?.value || '');
    const filter = $('#productFilter')?.value || 'all';
    const now = new Date();
    const limit = new Date(now);
    limit.setDate(limit.getDate() + 30);

    const products = state.products.filter(product => {
      const location = getLocation(product.locationId);
      const haystack = normalizeText([
        product.name, product.barcode, product.sku, product.category, product.lot, product.id,
        location?.code, baseLocationPath(location), productLocationPath(product)
      ].join(' '));
      if (query && !haystack.includes(query)) return false;
      if (filter === 'low' && !isLowStock(product)) return false;
      if (filter === 'unassigned' && product.locationId) return false;
      if (filter === 'expiring') {
        if (!product.expiry) return false;
        const expiry = new Date(`${product.expiry}T23:59:59`);
        if (expiry < now || expiry > limit) return false;
      }
      return true;
    });

    const container = $('#productList');
    if (!products.length) {
      container.innerHTML = emptyBlock('Nessun prodotto trovato', 'Aggiungi un prodotto oppure modifica i filtri di ricerca.', '▣');
      return;
    }

    container.innerHTML = products.map(product => {
      const location = getLocation(product.locationId);
      const low = isLowStock(product);
      const expired = product.expiry && new Date(`${product.expiry}T23:59:59`) < new Date();
      return `
        <article class="product-card clickable-card" data-product-open="${product.id}" tabindex="0" role="button" aria-label="Apri scheda ${escapeHtml(product.name)}">
          <div class="product-thumb">${product.imageData ? `<img src="${product.imageData}" alt="Foto ${escapeHtml(product.name)}">` : '▦'}</div>
          <div class="product-main">
            <div class="product-title-row">
              <h3>${escapeHtml(product.name)}</h3>
              ${low ? '<span class="chip low">Sotto scorta</span>' : ''}
              ${expired ? '<span class="chip danger">Scaduto</span>' : ''}
            </div>
            <p>${escapeHtml(product.description || product.category || 'Nessuna descrizione')}</p>
            <div class="meta-row">
              ${product.barcode ? `<span class="chip">Barcode ${escapeHtml(product.barcode)}</span>` : '<span class="chip">QR interno</span>'}
              ${product.lot ? `<span class="chip">Lotto ${escapeHtml(product.lot)}</span>` : ''}
              ${product.expiry ? `<span class="chip">Scad. ${formatDate(product.expiry)}</span>` : ''}
              <span class="chip">⌖ ${escapeHtml(location ? productLocationPath(product) : 'Senza posizione')}</span>
            </div>
          </div>
          <div class="product-side">
            <div class="quantity-block"><strong>${formatNumber(product.quantity)}</strong><small>${escapeHtml(product.unit || 'pz')}</small></div>
            <div class="menu-actions">
              <button class="mini-btn qr-product-btn" data-product-action="qr" data-id="${product.id}" title="Crea e stampa QR prodotto">QR</button>
              <button class="mini-btn" data-product-action="find" data-id="${product.id}" title="Trova">➤</button>
              <button class="mini-btn" data-product-action="move" data-id="${product.id}" title="Movimenta">⇄</button>
              <button class="mini-btn" data-product-action="edit" data-id="${product.id}" title="Modifica">✎</button>
              <button class="mini-btn" data-product-action="delete" data-id="${product.id}" title="Elimina">⌫</button>
            </div>
          </div>
        </article>`;
    }).join('');
  }

  function renderLocations() {
    const query = normalizeText($('#locationSearch')?.value || '');
    const locations = state.locations.filter(location => {
      return normalizeText([
        location.code,
        locationDisplayName(location),
        locationType(location),
        location.zone,
        location.note,
        location.warehouse,
        location.aisle,
        location.rack,
        location.shelf,
        location.bin
      ].join(' ')).includes(query);
    });

    const container = $('#locationList');
    if (!locations.length) {
      container.innerHTML = emptyBlock('Nessuna area trovata', 'Crea il primo magazzino, Cardex, scaffale o altra area di stoccaggio.', '⌖');
      return;
    }

    container.innerHTML = locations.map(location => {
      const products = state.products.filter(product => product.locationId === location.id);
      const count = products.length;
      const occupied = products.filter(product => Number(product.quantity || 0) > 0).length;
      return `
        <article class="location-card clickable-card" data-location-open="${location.id}" tabindex="0" role="button" aria-label="Apri area ${escapeHtml(location.code)}">
          <div class="location-card-head">
            <div><h3>${escapeHtml(locationDisplayName(location))}</h3><div class="location-code">${escapeHtml(location.code)}</div></div>
            <button class="mini-btn" data-location-action="print" data-id="${location.id}" title="Stampa QR area">▦</button>
          </div>
          <div class="location-path">
            ${pathCell('Tipo', locationType(location))}
            ${pathCell('Zona / reparto', location.zone)}
            ${pathCell('Prodotti', count)}
            ${pathCell('Con giacenza', occupied)}
          </div>
          ${location.note ? `<p>${escapeHtml(location.note)}</p>` : ''}
          <div class="location-footer">
            <span class="location-count">${count} prodott${count === 1 ? 'o' : 'i'} collegat${count === 1 ? 'o' : 'i'}</span>
            <div class="menu-actions">
              <button class="mini-btn" data-location-action="edit" data-id="${location.id}" title="Modifica">✎</button>
              <button class="mini-btn" data-location-action="delete" data-id="${location.id}" title="Elimina">⌫</button>
            </div>
          </div>
        </article>`;
    }).join('');
  }

  function renderMovements() {
    const query = normalizeText($('#movementSearch')?.value || '');
    const filter = $('#movementFilter')?.value || 'all';
    const movements = state.movements.filter(movement => {
      const product = getProduct(movement.productId);
      const location = getLocation(movement.toLocationId || movement.fromLocationId);
      const haystack = normalizeText([
        product?.name,
        movement.productName,
        movement.operator,
        movement.note,
        movement.fromLocationText,
        movement.toLocationText,
        baseLocationPath(location)
      ].join(' '));
      return (!query || haystack.includes(query)) && (filter === 'all' || movement.type === filter);
    });

    const body = $('#movementTableBody');
    if (!movements.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty-state">Nessun movimento trovato.</td></tr>';
      return;
    }

    body.innerHTML = movements.map(movement => {
      const product = getProduct(movement.productId);
      const from = getLocation(movement.fromLocationId);
      const to = getLocation(movement.toLocationId);
      const fromText = movement.fromLocationText || baseLocationPath(from) || '—';
      const toText = movement.toLocationText || baseLocationPath(to) || fromText || '—';
      let position = toText;
      if (movement.type === 'MOVE') position = `${fromText} → ${toText}`;
      return `
        <tr>
          <td>${formatDateTime(movement.timestamp)}</td>
          <td><strong>${escapeHtml(product?.name || movement.productName || 'Prodotto eliminato')}</strong><br><small>${escapeHtml(movement.note || '')}</small></td>
          <td><span class="type-badge type-${movement.type}">${movementLabels[movement.type]}</span></td>
          <td>${formatNumber(movement.quantity)}</td>
          <td>${escapeHtml(position)}</td>
          <td>${escapeHtml(movement.operator || '—')}</td>
        </tr>`;
    }).join('');
  }

  function renderFindResults() {
    const query = normalizeText($('#findSearch')?.value || '');
    const products = state.products
      .filter(product => normalizeText([product.name, product.barcode, product.lot, product.sku, productLocationPath(product)].join(' ')).includes(query))
      .slice(0, 60);

    const container = $('#findResults');
    if (!products.length) {
      container.innerHTML = '<div class="empty-state">Nessun prodotto trovato.</div>';
    } else {
      container.innerHTML = products.map(product => {
        const location = getLocation(product.locationId);
        return `<button class="find-item ${state.selectedFindId === product.id ? 'active' : ''}" data-find-id="${product.id}" type="button"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.barcode || 'QR interno')} · ${escapeHtml(location ? productLocationPath(product) : 'Senza posizione')}</small></button>`;
      }).join('');
    }

    renderFindSelected();
  }

  function renderFindSelected() {
    const product = getProduct(state.selectedFindId);
    const empty = $('#findEmpty');
    const selected = $('#findSelected');

    if (!product) {
      empty.classList.remove('hidden');
      selected.classList.add('hidden');
      selected.innerHTML = '';
      return;
    }

    const location = getLocation(product.locationId);
    const exact = productExactLocation(product, location);
    empty.classList.add('hidden');
    selected.classList.remove('hidden');
    selected.innerHTML = `
      <div class="selected-product">
        <div class="selected-head">
          <div class="product-thumb">${product.imageData ? `<img src="${product.imageData}" alt="">` : '▦'}</div>
          <div><h2>${escapeHtml(product.name)}</h2><p>${escapeHtml(product.barcode || 'QR interno')} · ${formatNumber(product.quantity)} ${escapeHtml(product.unit || 'pz')}</p></div>
        </div>
        <div class="route-box">
          <small>AREA E COLLOCAZIONE REGISTRATA</small>
          <strong>${escapeHtml(location ? productLocationPath(product) : 'Posizione non assegnata')}</strong>
          ${location ? `<div class="route-steps">
            ${routeStep('Area', locationDisplayName(location))}
            ${routeStep('Tipo', locationType(location))}
            ${routeStep('Zona', location.zone)}
            ${routeStep('Corsia/colonna', exact.aisle)}
            ${routeStep('Scaffale/cassetto', exact.rack)}
            ${routeStep('Ripiano', exact.shelf)}
            ${routeStep('Posto/casella', exact.bin)}
          </div>` : ''}
        </div>
        ${location?.note ? `<div class="inline-message">Per raggiungere l’area: ${escapeHtml(location.note)}</div>` : ''}
        ${exact.note ? `<div class="inline-message">Collocazione precisa: ${escapeHtml(exact.note)}</div>` : ''}
        <button class="btn btn-primary" data-find-action="guide" data-id="${product.id}" ${location ? '' : 'disabled'} type="button">📷 Apri guida con fotocamera</button>
        <button class="btn btn-secondary" data-find-action="qr" data-id="${product.id}" type="button">▦ Crea e stampa QR prodotto</button>
        <button class="btn btn-secondary" data-find-action="move" data-id="${product.id}" type="button">⇄ Registra movimento</button>
      </div>`;
  }

  function renderSettings() {
    $('#settingCompany').value = state.settings.company || '';
    $('#settingOperator').value = state.settings.operator || 'Operatore';
    const cloud = window.magazzinoCloud?.getConfig?.() || { apiUrl: '' };
    $('#cloudApiUrl').value = cloud.apiUrl || '';
    updateCloudStatus(state.cloudStatus);
  }

  async function ensureDefaultPin() {
    if (!localStorage.getItem(ADMIN_PIN_HASH_KEY)) {
      localStorage.setItem(ADMIN_PIN_HASH_KEY, await hashPin(DEFAULT_ADMIN_PIN));
    }
  }

  async function hashPin(pin) {
    const value = String(pin || '');
    if (globalThis.crypto?.subtle) {
      const data = new TextEncoder().encode(value);
      const digest = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(digest)].map(item => item.toString(16).padStart(2, '0')).join('');
    }
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fallback-${(hash >>> 0).toString(16)}`;
  }

  function requestSettingsAccess() {
    requireAdminPin('Inserisci il PIN per accedere alle impostazioni.').then(authorized => {
      if (!authorized) return;
      state.settingsUnlocked = true;
      switchView('settings');
    });
  }

  function requireAdminPin(message = 'Inserisci il PIN amministratore.') {
    if (state.pinResolver) return Promise.resolve(false);
    $('#pinMessage').textContent = message;
    $('#pinInput').value = '';
    $('#pinDialog').showModal();
    setTimeout(() => $('#pinInput').focus(), 80);
    return new Promise(resolve => {
      state.pinResolver = resolve;
      state.pinPurpose = message;
    });
  }

  async function submitPinChallenge(event) {
    event.preventDefault();
    const entered = $('#pinInput').value;
    const expected = localStorage.getItem(ADMIN_PIN_HASH_KEY) || await hashPin(DEFAULT_ADMIN_PIN);
    const valid = entered.length >= 4 && await hashPin(entered) === expected;
    if (!valid) {
      notify('PIN non corretto.', 'error');
      $('#pinInput').select();
      return;
    }
    const resolver = state.pinResolver;
    state.pinResolver = null;
    state.pinPurpose = '';
    $('#pinDialog').close();
    resolver?.(true);
  }

  function finishCancelledPinChallenge() {
    if (!state.pinResolver) return;
    const resolver = state.pinResolver;
    state.pinResolver = null;
    state.pinPurpose = '';
    resolver(false);
  }

  async function changeAdminPin() {
    const first = $('#newPin').value.trim();
    const second = $('#confirmNewPin').value.trim();
    if (!/^\d{4,12}$/.test(first)) {
      notify('Il PIN deve contenere da 4 a 12 cifre.', 'error');
      return;
    }
    if (first !== second) {
      notify('I due PIN non coincidono.', 'error');
      return;
    }
    localStorage.setItem(ADMIN_PIN_HASH_KEY, await hashPin(first));
    $('#newPin').value = '';
    $('#confirmNewPin').value = '';
    notify('PIN modificato correttamente.', 'success');
  }

  function lockSettings() {
    state.settingsUnlocked = false;
    if (state.currentView === 'settings') switchView('dashboard');
    notify('Impostazioni bloccate.', 'success');
  }

  function updateCloudStatus(info = {}) {
    state.cloudStatus = {
      status: info.status || state.cloudStatus.status || 'disabled',
      message: info.message || '',
      configured: info.configured ?? window.magazzinoCloud?.isConfigured?.() ?? false,
      pending: Number(info.pending ?? window.magazzinoCloud?.getQueue?.().length ?? 0)
    };
    const badge = $('#cloudStatusBadge');
    const text = $('#cloudStatusText');
    const labels = {
      disabled: 'Non configurato',
      pending: 'Da sincronizzare',
      syncing: 'Sincronizzazione…',
      online: 'Cloud attivo',
      offline: 'Offline',
      error: 'Errore cloud',
      idle: 'Configurato'
    };
    if (badge) {
      badge.className = `cloud-status ${state.cloudStatus.status}`;
      badge.textContent = labels[state.cloudStatus.status] || 'Cloudflare';
    }
    if (text) {
      const pending = state.cloudStatus.pending ? ` · ${state.cloudStatus.pending} modifiche in attesa` : '';
      text.textContent = (state.cloudStatus.message || (state.cloudStatus.configured ? 'Sincronizzazione Cloudflare configurata.' : 'Inserisci il collegamento del Worker Cloudflare.')) + pending;
    }
    updateConnectionStatus();
  }

  async function saveCloudSettings(event) {
    event.preventDefault();
    const config = window.magazzinoCloud.saveConfig({
      apiUrl: $('#cloudApiUrl').value
    });
    if (!config.apiUrl) {
      notify('Inserisci il collegamento Cloudflare Worker.', 'error');
      return;
    }
    try {
      await window.magazzinoCloud.testConnection();
      await window.magazzinoCloud.syncNow();
      notify('Cloudflare collegato e archivio sincronizzato.', 'success');
    } catch (error) {
      notify(error.message || 'Collegamento Cloudflare non riuscito.', 'error');
    }
  }

  async function testCloudConnection() {
    window.magazzinoCloud.saveConfig({
      apiUrl: $('#cloudApiUrl').value
    });
    try {
      const result = await window.magazzinoCloud.testConnection();
      notify(`Cloudflare raggiungibile. Record presenti: ${result.records || 0}.`, 'success');
    } catch (error) {
      notify(error.message || 'Verifica Cloudflare non riuscita.', 'error');
    }
  }

  async function syncCloudNow() {
    try {
      await window.magazzinoCloud.syncNow();
      await loadState();
      renderAll();
      notify('Sincronizzazione completata.', 'success');
    } catch (error) {
      notify(error.message || 'Sincronizzazione non riuscita.', 'error');
    }
  }

  function renderCompatibility() {
    const checks = [
      ['Fotocamera', Boolean(navigator.mediaDevices?.getUserMedia)],
      ['Archivio offline', 'indexedDB' in window],
      ['Installazione PWA', 'serviceWorker' in navigator],
      ['Lettura barcode nativa', 'BarcodeDetector' in window],
      ['Generatore QR locale v6.2', Boolean(window.QRCode?.toCanvas)],
      ['Sincronizzazione Cloudflare', Boolean(window.magazzinoCloud)],
      ['Guida AR con fotocamera', Boolean(navigator.mediaDevices?.getUserMedia)],
      ['WebXR avanzato', 'xr' in navigator]
    ];
    $('#compatibilityList').innerHTML = checks.map(([label, ok]) => `<li><span class="${ok ? 'check-ok' : 'check-no'}">${ok ? '✓' : '—'}</span>${escapeHtml(label)}</li>`).join('');
  }

  function populateSelects() {
    const locationOptions = state.locations.map(location => `<option value="${location.id}">${escapeHtml(location.code)} — ${escapeHtml(baseLocationPath(location))}</option>`).join('');
    const productOptions = state.products.map(product => `<option value="${product.id}">${escapeHtml(product.name)} — ${escapeHtml(product.barcode || 'QR interno')}</option>`).join('');
    $('#productLocation').innerHTML = `<option value="">Nessuna area</option>${locationOptions}`;
    $('#movementDestination').innerHTML = `<option value="">Seleziona area</option>${locationOptions}`;
    $('#movementProduct').innerHTML = `<option value="">Seleziona prodotto</option>${productOptions}`;
  }

  async function quickScan() {
    openScanner('Scansiona prodotto o area', async raw => {
      const locationCode = parseLocationCode(raw);
      const location = getLocationByCode(locationCode);
      const knownProduct = resolveScannedProduct(raw);
      if ((raw.startsWith('MAGAR:LOC:') || raw.startsWith('LOC:') || location) && !knownProduct) {
        if (location) {
          $('#locationSearch').value = location.code;
          switchView('locations');
          renderLocations();
        } else {
          openLocationForm(null, locationCode);
        }
        return;
      }

      const product = knownProduct;
      if (product) {
        state.selectedFindId = product.id;
        switchView('find');
        $('#findSearch').value = product.barcode;
        renderFindResults();
        notify(`Trovato: ${product.name}`, 'success');
      } else if (parseProductId(raw)) {
        notify('Il QR appartiene a un prodotto che non è presente in questo archivio.', 'error');
      } else {
        openProductForm(null, raw);
      }
    });
  }

  function handleQuickAction(action) {
    if (action === 'find') {
      switchView('find');
      return;
    }

    const type = action === 'scan-in' ? 'IN' : action === 'scan-out' ? 'OUT' : 'MOVE';
    openScanner(type === 'IN' ? 'Prodotto da caricare' : type === 'OUT' ? 'Prodotto da prelevare' : 'Prodotto da spostare', raw => {
      const product = resolveScannedProduct(raw);
      if (!product) {
        if (type === 'IN') openProductForm(null, raw);
        else notify('Prodotto non registrato.', 'error');
        return;
      }
      openMovementForm(product.id, type);
    });
  }

  function openProductForm(product = null, barcode = '') {
    populateSelects();
    $('#productForm').reset();
    $('#productId').value = product?.id || '';
    $('#productDialogTitle').textContent = product ? 'Modifica prodotto' : 'Nuovo prodotto';
    $('#productBarcode').value = product?.barcode || normalizeCode(barcode);
    $('#productName').value = product?.name || '';
    $('#productSku').value = product?.sku || '';
    $('#productCategory').value = product?.category || '';
    $('#productQuantity').value = product?.quantity ?? 0;
    $('#productUnit').value = product?.unit || 'pz';
    $('#productMinStock').value = product?.minStock ?? 0;
    $('#productLot').value = product?.lot || '';
    $('#productExpiry').value = product?.expiry || '';
    $('#productLocation').value = product?.locationId || '';

    const legacyLocation = getLocation(product?.locationId);
    const exact = productExactLocation(product || {}, legacyLocation);
    $('#productLocationAisle').value = exact.aisle || '';
    $('#productLocationRack').value = exact.rack || '';
    $('#productLocationShelf').value = exact.shelf || '';
    $('#productLocationBin').value = exact.bin || '';
    $('#productLocationNote').value = exact.note || '';

    $('#productDescription').value = product?.description || '';
    $('#productImage').value = '';
    state.currentImageData = product?.imageData || '';
    updateImagePreview();
    syncProductLocationFields();
    $('#productQrBtn')?.classList.toggle('hidden', !product);
    const saveProductQrBtn = $('#saveProductQrBtn');
    if (saveProductQrBtn) saveProductQrBtn.textContent = product ? 'Salva e aggiorna QR' : 'Salva e crea QR';
    $('#productDialog').showModal();
    setTimeout(() => (product ? $('#productName') : ($('#productBarcode').value ? $('#productBarcode') : $('#productName'))).focus(), 80);
  }

  function syncProductLocationFields() {
    const enabled = Boolean($('#productLocation').value);
    const group = $('#productExactLocationFields');
    group.classList.toggle('is-disabled', !enabled);
    ['#productLocationAisle', '#productLocationRack', '#productLocationShelf', '#productLocationBin', '#productLocationNote'].forEach(selector => {
      $(selector).disabled = !enabled;
      if (!enabled) $(selector).value = '';
    });
  }

  async function saveProduct(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const afterSave = event.submitter?.dataset.afterSave || '';
    const id = $('#productId').value || uid();
    const existing = getProduct(id);
    const barcode = normalizeCode($('#productBarcode').value);
    const duplicate = barcode ? state.products.find(product => normalizeCode(product.barcode) === barcode && product.id !== id) : null;
    if (duplicate) {
      notify(`Il codice è già usato da “${duplicate.name}”.`, 'error');
      return;
    }

    const quantity = toNumber($('#productQuantity').value);
    const now = new Date().toISOString();
    const locationId = $('#productLocation').value;
    const product = {
      id,
      barcode,
      name: $('#productName').value.trim(),
      sku: $('#productSku').value.trim(),
      category: $('#productCategory').value.trim(),
      quantity,
      unit: $('#productUnit').value,
      minStock: toNumber($('#productMinStock').value),
      lot: $('#productLot').value.trim(),
      expiry: $('#productExpiry').value,
      locationId,
      locationAisle: locationId ? $('#productLocationAisle').value.trim() : '',
      locationRack: locationId ? $('#productLocationRack').value.trim() : '',
      locationShelf: locationId ? $('#productLocationShelf').value.trim() : '',
      locationBin: locationId ? $('#productLocationBin').value.trim() : '',
      locationNote: locationId ? $('#productLocationNote').value.trim() : '',
      description: $('#productDescription').value.trim(),
      imageData: state.currentImageData || '',
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    const oldPositionText = existing ? productLocationPath(existing) : '';
    const newPositionText = productLocationPath(product);

    try {
      await warehouseDB.put('products', product);
      if (!existing && quantity > 0) {
        await createMovementRecord(product, 'IN', quantity, null, product.locationId, 'Giacenza iniziale', { toText: newPositionText });
      } else if (existing) {
        if (quantity !== Number(existing.quantity || 0)) {
          await createMovementRecord(product, 'ADJUST', quantity, existing.locationId, product.locationId, `Rettifica da ${formatNumber(existing.quantity)} a ${formatNumber(quantity)}`, { fromText: oldPositionText, toText: newPositionText });
        }
        if (oldPositionText !== newPositionText) {
          await createMovementRecord(product, 'MOVE', quantity, existing.locationId, product.locationId, 'Collocazione modificata dalla scheda prodotto', { fromText: oldPositionText, toText: newPositionText });
        }
      }
      await loadState();
      renderAll();
      form.closest('dialog').close();
      notify(existing ? 'Prodotto aggiornato.' : 'Prodotto salvato. Il QR interno è pronto.', 'success');
      if (afterSave === 'qr') {
        const savedProduct = getProduct(product.id) || product;
        setTimeout(() => printProductLabel(savedProduct), 180);
      }
    } catch (error) {
      console.error(error);
      notify('Errore durante il salvataggio del prodotto.', 'error');
    }
  }

  async function handleProductImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      state.currentImageData = await resizeImage(file, 800, .68);
      updateImagePreview();
    } catch (error) {
      console.error(error);
      notify('Impossibile elaborare la foto.', 'error');
    }
  }

  function updateImagePreview() {
    const preview = $('#productImagePreview');
    if (!state.currentImageData) {
      preview.classList.add('hidden');
      preview.innerHTML = '';
      return;
    }
    preview.classList.remove('hidden');
    preview.innerHTML = `<img src="${state.currentImageData}" alt="Anteprima confezione">`;
  }

  function openLocationForm(location = null, code = '') {
    $('#locationForm').reset();
    $('#locationId').value = location?.id || '';
    $('#locationDialogTitle').textContent = location ? 'Modifica area' : 'Nuova area';
    $('#locationCode').value = location?.code || code || '';
    $('#locationName').value = locationDisplayName(location) === 'Area di stoccaggio' ? '' : locationDisplayName(location);
    $('#locationType').value = locationType(location) || 'Magazzino';
    $('#locationZone').value = location?.zone || '';
    $('#locationNote').value = location?.note || '';
    $('#locationQrBtn')?.classList.toggle('hidden', !location);
    const saveLocationQrBtn = $('#saveLocationQrBtn');
    if (saveLocationQrBtn) saveLocationQrBtn.textContent = location ? 'Salva e aggiorna QR' : 'Salva e crea QR';
    $('#locationDialog').showModal();
  }

  async function saveLocation(event) {
    event.preventDefault();
    const afterSave = event.submitter?.dataset.afterSave || '';
    const id = $('#locationId').value || uid();
    const name = $('#locationName').value.trim();
    const type = $('#locationType').value;
    const code = parseLocationCode($('#locationCode').value.trim()) || generateLocationCode(name, type);
    const duplicate = state.locations.find(location => normalizeText(location.code) === normalizeText(code) && location.id !== id);
    if (duplicate) {
      notify('Esiste già un’area con questo codice.', 'error');
      return;
    }

    const existing = getLocation(id);
    const now = new Date().toISOString();
    const location = {
      id,
      code,
      name,
      type,
      zone: $('#locationZone').value.trim(),
      note: $('#locationNote').value.trim(),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    try {
      await warehouseDB.put('locations', location);
      await loadState();
      renderAll();
      $('#locationDialog').close();
      notify('Area salvata. Il QR dell’area è pronto.', 'success');
      if (afterSave === 'qr') {
        const savedLocation = getLocation(location.id) || location;
        setTimeout(() => printLocationLabel(savedLocation), 180);
      }
    } catch (error) {
      console.error(error);
      notify('Errore durante il salvataggio dell’area.', 'error');
    }
  }

  function openMovementForm(productId = '', type = 'IN') {
    populateSelects();
    $('#movementForm').reset();
    $('#movementProduct').value = productId;
    $('#movementType').value = type;
    $('#movementQuantity').value = 1;
    $('#movementDestination').value = '';
    $('#movementLocationAisle').value = '';
    $('#movementLocationRack').value = '';
    $('#movementLocationShelf').value = '';
    $('#movementLocationBin').value = '';
    $('#movementLocationNote').value = '';
    $('#movementNote').value = '';
    syncMovementFields();
    $('#movementDialog').showModal();
  }

  function syncMovementFields() {
    const type = $('#movementType').value;
    const product = getProduct($('#movementProduct').value);
    const destinationField = $('#movementDestinationField');
    const exactFields = $('#movementExactFields');
    const quantity = $('#movementQuantity');
    const warning = $('#movementWarning');
    const moving = type === 'MOVE';

    destinationField.classList.toggle('hidden', !moving);
    exactFields.classList.toggle('hidden', !moving);
    $('#movementDestination').required = moving;
    quantity.disabled = false;
    quantity.min = '0';

    if (moving) {
      quantity.value = product ? product.quantity : 0;
      quantity.disabled = true;
      if (product && !$('#movementDestination').value) {
        $('#movementDestination').value = product.locationId || '';
        const exact = productExactLocation(product);
        $('#movementLocationAisle').value = exact.aisle;
        $('#movementLocationRack').value = exact.rack;
        $('#movementLocationShelf').value = exact.shelf;
        $('#movementLocationBin').value = exact.bin;
        $('#movementLocationNote').value = exact.note;
      }
      syncMovementDestinationFields(false);
      warning.textContent = 'Lo spostamento trasferisce tutta la giacenza. Puoi cambiare area oppure soltanto scaffale, ripiano o posto nella stessa area.';
      warning.classList.remove('hidden');
    } else if (type === 'ADJUST') {
      quantity.value = product ? product.quantity : 0;
      warning.textContent = 'Per la rettifica inserisci la nuova quantità totale, non la differenza.';
      warning.classList.remove('hidden');
    } else {
      warning.classList.add('hidden');
    }
  }

  function syncMovementDestinationFields(resetExact = false) {
    const enabled = Boolean($('#movementDestination').value);
    const product = getProduct($('#movementProduct').value);
    const changedArea = enabled && product && $('#movementDestination').value !== product.locationId;
    ['#movementLocationAisle', '#movementLocationRack', '#movementLocationShelf', '#movementLocationBin', '#movementLocationNote'].forEach(selector => {
      $(selector).disabled = !enabled;
      if (!enabled || (resetExact && changedArea)) $(selector).value = '';
    });
  }

  async function saveMovement(event) {
    event.preventDefault();
    const product = getProduct($('#movementProduct').value);
    if (!product) {
      notify('Seleziona un prodotto valido.', 'error');
      return;
    }

    const type = $('#movementType').value;
    const entered = toNumber($('#movementQuantity').value);
    const destinationId = $('#movementDestination').value;
    let newQuantity = Number(product.quantity || 0);
    let movementQuantity = entered;
    let updatedProduct = { ...product };
    const fromText = productLocationPath(product);

    if (type === 'IN') {
      if (entered <= 0) return notify('La quantità deve essere maggiore di zero.', 'error');
      newQuantity += entered;
      updatedProduct.quantity = newQuantity;
    } else if (type === 'OUT') {
      if (entered <= 0) return notify('La quantità deve essere maggiore di zero.', 'error');
      if (entered > newQuantity) return notify('Quantità insufficiente per il prelievo.', 'error');
      newQuantity -= entered;
      updatedProduct.quantity = newQuantity;
    } else if (type === 'ADJUST') {
      if (entered < 0) return notify('La quantità non può essere negativa.', 'error');
      newQuantity = entered;
      updatedProduct.quantity = newQuantity;
    } else if (type === 'MOVE') {
      if (!destinationId) return notify('Seleziona o scansiona la nuova area.', 'error');
      movementQuantity = Number(product.quantity || 0);
      updatedProduct = {
        ...product,
        locationId: destinationId,
        locationAisle: $('#movementLocationAisle').value.trim(),
        locationRack: $('#movementLocationRack').value.trim(),
        locationShelf: $('#movementLocationShelf').value.trim(),
        locationBin: $('#movementLocationBin').value.trim(),
        locationNote: $('#movementLocationNote').value.trim()
      };
      const candidateText = productLocationPath(updatedProduct);
      if (candidateText === fromText) return notify('La nuova collocazione coincide con quella attuale.', 'error');
    }

    updatedProduct.updatedAt = new Date().toISOString();
    const toText = productLocationPath(updatedProduct);

    try {
      await warehouseDB.put('products', updatedProduct);
      await createMovementRecord(updatedProduct, type, movementQuantity, product.locationId, updatedProduct.locationId, $('#movementNote').value.trim(), { fromText, toText });
      await loadState();
      renderAll();
      $('#movementDialog').close();
      notify('Movimento registrato.', 'success');
    } catch (error) {
      console.error(error);
      notify('Errore durante la registrazione del movimento.', 'error');
    }
  }

  async function createMovementRecord(product, type, quantity, fromLocationId, toLocationId, note = '', position = {}) {
    const from = getLocation(fromLocationId);
    const to = getLocation(toLocationId);
    const movement = {
      id: uid(),
      productId: product.id,
      productName: product.name,
      type,
      quantity: Number(quantity || 0),
      fromLocationId: fromLocationId || '',
      toLocationId: toLocationId || '',
      fromLocationText: position.fromText || baseLocationPath(from) || '',
      toLocationText: position.toText || productLocationPath(product) || baseLocationPath(to) || '',
      operator: state.settings.operator || 'Operatore',
      note,
      timestamp: new Date().toISOString()
    };
    await warehouseDB.put('movements', movement);
    return movement;
  }

  async function handleProductAction(event) {
    const button = event.target.closest('[data-product-action]');
    if (!button) {
      const card = event.target.closest('[data-product-open]');
      if (card) openProductDetail(card.dataset.productOpen);
      return;
    }
    event.stopPropagation();
    const product = getProduct(button.dataset.id);
    if (!product) return;

    if (button.dataset.productAction === 'edit') openProductForm(product);
    if (button.dataset.productAction === 'qr') printProductLabel(product);
    if (button.dataset.productAction === 'move') openMovementForm(product.id, 'MOVE');
    if (button.dataset.productAction === 'find') {
      state.selectedFindId = product.id;
      switchView('find');
      renderFindResults();
    }
    if (button.dataset.productAction === 'delete') {
      const authorized = await requireAdminPin('Inserisci il PIN per eliminare questo prodotto.');
      if (!authorized) return;
      const confirmed = await askConfirmation('Elimina prodotto', `Vuoi eliminare “${product.name}”? Lo storico dei movimenti resterà disponibile.`);
      if (!confirmed) return;
      await warehouseDB.delete('products', product.id);
      await loadState();
      renderAll();
      notify('Prodotto eliminato.', 'success');
    }
  }

  function handleProductCardKeydown(event) {
    if (!['Enter', ' '].includes(event.key) || event.target.closest('button')) return;
    const card = event.target.closest('[data-product-open]');
    if (!card) return;
    event.preventDefault();
    openProductDetail(card.dataset.productOpen);
  }

  async function handleLocationAction(event) {
    const button = event.target.closest('[data-location-action]');
    if (!button) {
      const card = event.target.closest('[data-location-open]');
      if (card) openLocationDetail(card.dataset.locationOpen);
      return;
    }
    event.stopPropagation();
    const location = getLocation(button.dataset.id);
    if (!location) return;

    if (button.dataset.locationAction === 'edit') openLocationForm(location);
    if (button.dataset.locationAction === 'print') printLocationLabel(location);
    if (button.dataset.locationAction === 'delete') {
      const count = state.products.filter(product => product.locationId === location.id).length;
      if (count) {
        notify(`Non puoi eliminare l’area: contiene ${count} prodott${count === 1 ? 'o' : 'i'}.`, 'error');
        return;
      }
      const authorized = await requireAdminPin('Inserisci il PIN per eliminare questa area.');
      if (!authorized) return;
      const confirmed = await askConfirmation('Elimina area', `Vuoi eliminare l’area ${locationDisplayName(location)} (${location.code})?`);
      if (!confirmed) return;
      await warehouseDB.delete('locations', location.id);
      await loadState();
      renderAll();
      notify('Area eliminata.', 'success');
    }
  }

  function handleLocationCardKeydown(event) {
    if (!['Enter', ' '].includes(event.key) || event.target.closest('button')) return;
    const card = event.target.closest('[data-location-open]');
    if (!card) return;
    event.preventDefault();
    openLocationDetail(card.dataset.locationOpen);
  }

  function openProductDetail(productId) {
    const product = getProduct(productId);
    if (!product) return;
    const location = getLocation(product.locationId);
    const exact = productExactLocation(product, location);
    state.currentDetailProductId = product.id;
    $('#productDetailTitle').textContent = product.name;
    $('#productDetailContent').innerHTML = `
      <div class="detail-layout">
        <div class="detail-photo">${product.imageData ? `<img src="${product.imageData}" alt="Foto ${escapeHtml(product.name)}">` : '▦'}</div>
        <div class="detail-grid">
          ${detailField('Nome prodotto', product.name, true)}
          ${detailField('Quantità', `${formatNumber(product.quantity)} ${product.unit || 'pz'}`)}
          ${detailField('Categoria', product.category || '—')}
          ${detailField('Barcode', product.barcode || 'QR interno')}
          ${detailField('Codice interno / SKU', product.sku || '—')}
          ${detailField('Lotto', product.lot || '—')}
          ${detailField('Scadenza', product.expiry ? formatDate(product.expiry) : '—')}
          ${detailField('Scorta minima', `${formatNumber(product.minStock)} ${product.unit || 'pz'}`)}
          ${detailField('Area di stoccaggio', location ? baseLocationPath(location) : 'Non assegnata', true)}
          ${detailField('Corsia / colonna', exact.aisle || '—')}
          ${detailField('Scaffale / cassetto', exact.rack || '—')}
          ${detailField('Ripiano', exact.shelf || '—')}
          ${detailField('Posto / casella', exact.bin || '—')}
          ${detailField('Indicazione precisa', exact.note || '—', true)}
          ${detailField('Posizione completa', location ? productLocationPath(product) : 'Non assegnata', true)}
          ${detailField('Descrizione', product.description || 'Nessuna descrizione', true)}
          ${detailField('Ultimo aggiornamento', formatDateTime(product.updatedAt || product.createdAt), true)}
        </div>
      </div>`;
    $('#detailProductFindBtn').disabled = !location;
    $('#productDetailDialog').showModal();
  }

  function openLocationDetail(locationId) {
    const location = getLocation(locationId);
    if (!location) return;
    const products = state.products.filter(product => product.locationId === location.id);
    state.currentDetailLocationId = location.id;
    $('#locationDetailTitle').textContent = locationDisplayName(location);
    $('#locationDetailContent').innerHTML = `
      <div class="detail-grid">
        ${detailField('Codice area', location.code, true)}
        ${detailField('Nome area', locationDisplayName(location), true)}
        ${detailField('Tipo', locationType(location))}
        ${detailField('Zona / reparto', location.zone || '—')}
        ${detailField('Prodotti collegati', String(products.length))}
        ${detailField('Indicazioni per raggiungerla', location.note || 'Nessuna indicazione', true)}
      </div>
      <div class="location-products">
        <h3>Prodotti in questa area</h3>
        ${products.length ? products.map(product => `
          <button class="location-product-link" data-detail-product="${product.id}" type="button">
            <span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(productLocationPath(product))}</small></span>
            <b>${formatNumber(product.quantity)} ${escapeHtml(product.unit || 'pz')}</b>
          </button>`).join('') : '<div class="empty-state">Nessun prodotto assegnato a questa area.</div>'}
      </div>`;
    $('#locationDetailDialog').showModal();
  }

  function detailField(label, value, full = false) {
    return `<div class="detail-field ${full ? 'full' : ''}"><small>${escapeHtml(label)}</small><strong>${escapeHtml(String(value ?? '—'))}</strong></div>`;
  }

  function detailProductQr() {
    const product = getProduct(state.currentDetailProductId);
    if (product) printProductLabel(product);
  }

  function detailProductFind() {
    const product = getProduct(state.currentDetailProductId);
    if (!product) return;
    closeDialog('productDetailDialog');
    state.selectedFindId = product.id;
    switchView('find');
    renderFindResults();
  }

  function detailProductMove() {
    const product = getProduct(state.currentDetailProductId);
    if (!product) return;
    closeDialog('productDetailDialog');
    openMovementForm(product.id, 'MOVE');
  }

  function detailProductEdit() {
    const product = getProduct(state.currentDetailProductId);
    if (!product) return;
    closeDialog('productDetailDialog');
    openProductForm(product);
  }

  function detailLocationQr() {
    const location = getLocation(state.currentDetailLocationId);
    if (location) printLocationLabel(location);
  }

  function detailLocationEdit() {
    const location = getLocation(state.currentDetailLocationId);
    if (!location) return;
    closeDialog('locationDetailDialog');
    openLocationForm(location);
  }

  function openProductFromLocationDetail(event) {
    const button = event.target.closest('[data-detail-product]');
    if (!button) return;
    closeDialog('locationDetailDialog');
    openProductDetail(button.dataset.detailProduct);
  }

  function handleFindSelection(event) {
    const button = event.target.closest('[data-find-id]');
    if (!button) return;
    state.selectedFindId = button.dataset.findId;
    renderFindResults();
  }

  function handleFindAction(event) {
    const button = event.target.closest('[data-find-action]');
    if (!button) return;
    const product = getProduct(button.dataset.id);
    if (!product) return;
    if (button.dataset.findAction === 'guide') openArGuide(product.id);
    if (button.dataset.findAction === 'qr') printProductLabel(product);
    if (button.dataset.findAction === 'move') openMovementForm(product.id, 'MOVE');
  }

  async function printLocationLabel(location) {
    try {
      const lines = [
        `Nome: ${locationDisplayName(location)}`,
        `Tipo: ${locationType(location)}`,
        location.zone ? `Zona / reparto: ${location.zone}` : '',
        location.note || ''
      ].filter(Boolean);

      await openQrPreview({
        qrText: `MAGAR:LOC:${location.code}`,
        kicker: 'AREA DI STOCCAGGIO',
        title: location.code,
        lines,
        filename: `area-${safeFilename(location.code)}.png`,
        description: `QR dell’area ${locationDisplayName(location)}. Scansionalo quando assegni o sposti un prodotto.`
      });
    } catch (error) {
      console.error('QR area:', error);
      notify(`Errore QR area: ${error.message || 'generazione non riuscita'}`, 'error');
    }
  }

  async function printProductLabel(product) {
    try {
      const location = getLocation(product.locationId);
      const lines = [
        product.sku ? `Codice interno: ${product.sku}` : '',
        product.barcode ? `Barcode: ${product.barcode}` : 'Prodotto senza barcode: usa questo QR interno',
        product.lot ? `Lotto: ${product.lot}` : '',
        product.expiry ? `Scadenza: ${formatDate(product.expiry)}` : '',
        `Posizione: ${location ? productLocationPath(product) : 'Non assegnata'}`
      ].filter(Boolean);

      await openQrPreview({
        qrText: `MAGAR:PROD:${product.id}`,
        kicker: 'ETICHETTA PRODOTTO',
        title: product.name,
        lines,
        filename: `prodotto-${safeFilename(product.name || product.id)}.png`,
        description: `QR interno del prodotto “${product.name}”. La scheda mostrerà sempre l’ultima collocazione salvata.`
      });
    } catch (error) {
      console.error('QR prodotto:', error);
      notify(`Errore QR prodotto: ${error.message || 'generazione non riuscita'}`, 'error');
    }
  }

  async function openQrPreview(options) {
    const qrCanvas = await createQrCanvas(options.qrText, 560);
    const labelCanvas = buildLabelCanvas(qrCanvas, options);
    const dataUrl = labelCanvas.toDataURL('image/png');

    state.qrPreview = {
      dataUrl,
      filename: options.filename || 'magazzino-ar-qr.png',
      title: options.title || 'QR'
    };

    $('#qrPreviewTitle').textContent = options.title || 'QR';
    $('#qrPreviewDescription').textContent = options.description || 'Etichetta QR pronta.';
    $('#qrPreviewImage').src = dataUrl;

    const dialog = $('#qrPreviewDialog');
    if (dialog.open) dialog.close();
    dialog.showModal();
  }

  async function createQrCanvas(text, size = 560) {
    if (!window.QRCode || typeof window.QRCode.toCanvas !== 'function') {
      throw new Error('il generatore QR locale non è stato caricato');
    }

    const canvas = document.createElement('canvas');
    await window.QRCode.toCanvas(canvas, text, {
      width: size,
      margin: 3,
      errorCorrectionLevel: 'M',
      colorDark: '#000000',
      colorLight: '#ffffff'
    });
    return canvas;
  }

  function buildLabelCanvas(qrCanvas, options) {
    const width = 700;
    const height = 980;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas non supportato dal dispositivo');

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.strokeStyle = '#000000';
    context.lineWidth = 5;
    context.strokeRect(3, 3, width - 6, height - 6);

    const qrSize = 540;
    const qrX = Math.round((width - qrSize) / 2);
    const qrY = 28;
    context.imageSmoothingEnabled = false;
    context.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);

    let y = qrY + qrSize + 36;
    context.fillStyle = '#000000';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.font = '700 24px Arial, sans-serif';
    context.fillText(String(options.kicker || 'MAGAZZINO AR'), width / 2, y);
    y += 42;

    context.font = '700 42px Arial, sans-serif';
    y = drawWrappedCanvasText(context, String(options.title || 'QR'), width / 2, y, width - 70, 50, 2);
    y += 12;

    context.font = '28px Arial, sans-serif';
    for (const line of options.lines || []) {
      if (y > height - 92) break;
      y = drawWrappedCanvasText(context, String(line), width / 2, y, width - 70, 36, 2);
      y += 5;
    }

    context.font = '700 20px Arial, sans-serif';
    context.fillText('SCANSIONA CON MAGAZZINO AR', width / 2, height - 52);
    return canvas;
  }

  function drawWrappedCanvasText(context, text, x, y, maxWidth, lineHeight, maxLines) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';

    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (context.measureText(test).width <= maxWidth || !line) {
        line = test;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);

    const visible = lines.slice(0, maxLines);
    if (lines.length > maxLines && visible.length) {
      let last = visible[visible.length - 1];
      while (last.length > 1 && context.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
      visible[visible.length - 1] = `${last}…`;
    }

    for (const item of visible) {
      context.fillText(item, x, y);
      y += lineHeight;
    }
    return y;
  }

  function downloadQrImage() {
    const { dataUrl, filename } = state.qrPreview;
    if (!dataUrl) {
      notify('Nessuna etichetta QR disponibile.', 'error');
      return;
    }
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename || 'magazzino-ar-qr.png';
    document.body.appendChild(link);
    link.click();
    link.remove();
    notify('Etichetta QR scaricata.', 'success');
  }

  async function shareQrImage() {
    const { dataUrl, filename, title } = state.qrPreview;
    if (!dataUrl) {
      notify('Nessuna etichetta QR disponibile.', 'error');
      return;
    }

    try {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const file = new File([blob], filename || 'magazzino-ar-qr.png', { type: 'image/png' });
      if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        await navigator.share({ title: title || 'QR Magazzino AR', files: [file] });
        return;
      }
      downloadQrImage();
      notify('Condivisione non disponibile: il PNG è stato scaricato.', 'success');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.error(error);
      downloadQrImage();
    }
  }

  async function printQrImage() {
    const { dataUrl } = state.qrPreview;
    if (!dataUrl) {
      notify('Nessuna etichetta QR disponibile.', 'error');
      return;
    }
    if (typeof window.print !== 'function') {
      notify('La stampa diretta non è disponibile: usa “Scarica PNG” e aprilo in iBleem.', 'error');
      return;
    }

    const label = document.createElement('div');
    label.className = 'print-label print-image-label';
    const image = document.createElement('img');
    image.src = dataUrl;
    image.alt = 'Etichetta QR da stampare';
    label.appendChild(image);
    document.body.appendChild(label);

    try {
      await waitForPrintAssets();
      window.print();
    } catch (error) {
      console.error(error);
      notify('Stampa diretta non disponibile: scarica il PNG e stampalo con iBleem.', 'error');
    } finally {
      setTimeout(() => label.remove(), 1200);
    }
  }

  function safeFilename(value) {
    const result = String(value || 'qr')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70);
    return result || 'qr';
  }

  function waitForPrintAssets() {
    return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 220)));
  }

  async function saveSettings(event) {
    event.preventDefault();
    state.settings.company = $('#settingCompany').value.trim();
    state.settings.operator = $('#settingOperator').value.trim() || 'Operatore';
    await warehouseDB.put('settings', { key: 'company', value: state.settings.company });
    await warehouseDB.put('settings', { key: 'operator', value: state.settings.operator });
    notify('Impostazioni salvate.', 'success');
  }

  async function exportBackup() {
    try {
      const data = await warehouseDB.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `magazzino-ar-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      notify('Backup esportato.', 'success');
    } catch (error) {
      console.error(error);
      notify('Esportazione non riuscita.', 'error');
    }
  }

  async function importBackup(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const authorized = await requireAdminPin('Inserisci il PIN per sostituire l’archivio con un backup.');
    if (!authorized) return;
    const confirmed = await askConfirmation('Importa backup', 'L’archivio attuale verrà sostituito dai dati del file selezionato.');
    if (!confirmed) return;

    try {
      const payload = JSON.parse(await file.text());
      await warehouseDB.importAll(payload);
      await loadState();
      renderAll();
      notify('Backup importato correttamente.', 'success');
    } catch (error) {
      console.error(error);
      notify('File di backup non valido.', 'error');
    }
  }

  async function loadDemoData() {
    const confirmed = await askConfirmation('Carica dati dimostrativi', 'Verranno aggiunti alcuni prodotti e aree di stoccaggio di esempio.');
    if (!confirmed) return;

    const suffix = String(Date.now()).slice(-5);
    const now = new Date().toISOString();
    const locations = [
      { id: uid(), code: `CARDEX-01-${suffix}`, name: 'Cardex 1', type: 'Cardex', zone: 'Reparto CH24', note: 'Lato ingresso reparto, vicino alla porta 2', createdAt: now, updatedAt: now },
      { id: uid(), code: `SCAFF-A-${suffix}`, name: 'Scaffalatura A', type: 'Scaffalatura', zone: 'Magazzino ricambi', note: 'Prima scaffalatura sulla sinistra', createdAt: now, updatedAt: now },
      { id: uid(), code: `MAG-TEC-${suffix}`, name: 'Magazzino tecnico', type: 'Magazzino', zone: 'Zona B', note: 'Locale dietro la linea principale', createdAt: now, updatedAt: now }
    ];
    for (const location of locations) await warehouseDB.put('locations', location);
    await loadState();

    const products = [
      { id: uid(), barcode: `8000000${suffix}1`, name: 'Cuscinetto dimostrativo 6204', sku: 'CUS-6204', category: 'Cuscinetti', quantity: 48, unit: 'pz', minStock: 20, lot: 'L26-A1', expiry: '', locationId: locations[0].id, locationAisle: 'Colonna B', locationRack: 'Cassetto 18', locationShelf: '', locationBin: 'Casella 3', locationNote: 'Scomparto anteriore', description: 'Confezione cuscinetti per linea produttiva', imageData: '', createdAt: now, updatedAt: now },
      { id: uid(), barcode: `8000000${suffix}2`, name: 'Anello OR 42 mm', sku: 'OR-042', category: 'Guarnizioni', quantity: 12, unit: 'pz', minStock: 15, lot: 'OR2607', expiry: '', locationId: locations[1].id, locationAisle: 'Corsia 1', locationRack: 'Modulo 2', locationShelf: 'Ripiano 3', locationBin: 'Contenitore blu', locationNote: 'Lato destro', description: 'Anello di tenuta in gomma', imageData: '', createdAt: now, updatedAt: now },
      { id: uid(), barcode: `8000000${suffix}3`, name: 'Lubrificante tecnico', sku: 'LUB-500', category: 'Lubrificanti', quantity: 8, unit: 'confezioni', minStock: 4, lot: 'LB-778', expiry: nextDate(240), locationId: locations[2].id, locationAisle: 'Corsia 3', locationRack: 'Scaffale 5', locationShelf: 'Ripiano 2', locationBin: 'Posto 4', locationNote: 'Vaschetta di contenimento', description: 'Flacone da 500 ml', imageData: '', createdAt: now, updatedAt: now }
    ];
    for (const product of products) {
      await warehouseDB.put('products', product);
      await createMovementRecord(product, 'IN', product.quantity, null, product.locationId, 'Dato dimostrativo', { toText: productLocationPath(product) });
    }

    await loadState();
    renderAll();
    notify('Dati dimostrativi caricati.', 'success');
  }

  async function resetAllData() {
    const authorized = await requireAdminPin('Inserisci il PIN per cancellare tutti i dati locali e Cloudflare.');
    if (!authorized) return;
    const confirmed = await askConfirmation('Cancella tutto', 'Questa operazione elimina prodotti, posizioni, movimenti e impostazioni anche dal cloud configurato.');
    if (!confirmed) return;
    await warehouseDB.clearAll();
    await loadState();
    state.selectedFindId = null;
    renderAll();
    notify('Archivio cancellato.', 'success');
  }

  function openScanner(title, callback) {
    state.scannerCallback = callback;
    state.scannerBusy = false;
    $('#scannerTitle').textContent = title || 'Scansiona codice';
    $('#manualCodeInput').value = '';
    $('#scannerStatus').textContent = 'Avvio fotocamera…';
    $('#torchBtn').classList.add('hidden');
    $('#scannerDialog').showModal();
    setTimeout(startScanner, 120);
  }

  async function startScanner() {
    await stopScanner();
    const video = $('#scannerVideo');

    try {
      if (window.ZXingBrowser?.BrowserMultiFormatReader) {
        state.cameras = await ZXingBrowser.BrowserCodeReader.listVideoInputDevices();
        if (!state.cameras.length) throw new Error('Nessuna fotocamera disponibile.');

        if (!state.cameraIndex) {
          const rearIndex = state.cameras.findIndex(camera => /back|rear|environment|posteriore/i.test(camera.label));
          state.cameraIndex = rearIndex >= 0 ? rearIndex : Math.max(0, state.cameras.length - 1);
        }

        const camera = state.cameras[state.cameraIndex % state.cameras.length];
        state.scannerReader = new ZXingBrowser.BrowserMultiFormatReader();
        state.scannerControls = await state.scannerReader.decodeFromVideoDevice(camera.deviceId, video, (result, error) => {
          if (result && !state.scannerBusy) finishScan(result.getText());
          if (error && error.name && !['NotFoundException', 'ChecksumException', 'FormatException'].includes(error.name)) {
            console.debug('Scanner:', error);
          }
        });
        $('#scannerStatus').textContent = 'Inquadra il codice all’interno del riquadro.';
        detectTorchSupport(video.srcObject);
        return;
      }

      if ('BarcodeDetector' in window) {
        await startNativeScanner(video);
        return;
      }

      throw new Error('Scanner non supportato dal browser.');
    } catch (error) {
      console.error(error);
      $('#scannerStatus').textContent = 'Fotocamera non disponibile. Inserisci il codice manualmente.';
    }
  }

  async function startNativeScanner(video) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    state.scannerStream = stream;
    video.srcObject = stream;
    await video.play();
    const detector = new BarcodeDetector();
    $('#scannerStatus').textContent = 'Inquadra il codice all’interno del riquadro.';
    detectTorchSupport(stream);

    const scanFrame = async () => {
      if (!state.scannerStream || state.scannerBusy || !$('#scannerDialog').open) return;
      try {
        if (video.readyState >= 2) {
          const codes = await detector.detect(video);
          if (codes.length) {
            finishScan(codes[0].rawValue);
            return;
          }
        }
      } catch (error) {
        console.debug(error);
      }
      state.scannerLoop = setTimeout(scanFrame, 220);
    };
    scanFrame();
  }

  async function stopScanner() {
    if (state.scannerLoop) clearTimeout(state.scannerLoop);
    state.scannerLoop = null;
    try { state.scannerControls?.stop(); } catch (_) { /* no-op */ }
    state.scannerControls = null;
    state.scannerReader = null;

    const stream = state.scannerStream || $('#scannerVideo')?.srcObject;
    if (stream?.getTracks) stream.getTracks().forEach(track => track.stop());
    state.scannerStream = null;
    if ($('#scannerVideo')) $('#scannerVideo').srcObject = null;
    state.torchOn = false;
  }

  async function finishScan(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value || state.scannerBusy) return;
    state.scannerBusy = true;
    if (navigator.vibrate) navigator.vibrate(80);
    const callback = state.scannerCallback;
    await stopScanner();
    $('#scannerDialog').close();
    state.scannerCallback = null;
    setTimeout(() => callback?.(value), 80);
  }

  function useManualCode() {
    const value = $('#manualCodeInput').value.trim();
    if (!value) return notify('Inserisci un codice.', 'error');
    finishScan(value);
  }

  async function switchCamera() {
    if (state.cameras.length > 1) state.cameraIndex = (state.cameraIndex + 1) % state.cameras.length;
    else state.cameraIndex = 0;
    $('#scannerStatus').textContent = 'Cambio fotocamera…';
    await startScanner();
  }

  function detectTorchSupport(stream) {
    const track = stream?.getVideoTracks?.()[0];
    const capabilities = track?.getCapabilities?.();
    $('#torchBtn').classList.toggle('hidden', !capabilities?.torch);
  }

  async function toggleTorch() {
    const stream = $('#scannerVideo').srcObject || state.scannerStream;
    const track = stream?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      state.torchOn = !state.torchOn;
      await track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
      $('#torchBtn').textContent = state.torchOn ? '🔦 Spegni torcia' : '🔦 Torcia';
    } catch (error) {
      state.torchOn = false;
      notify('Torcia non disponibile.', 'error');
    }
  }

  async function openArGuide(productId, calibratedLocationId = null, wrongCode = '') {
    const product = getProduct(productId);
    const location = getLocation(product?.locationId);
    if (!product || !location) return notify('Il prodotto non ha un’area valida.', 'error');

    state.arProductId = productId;
    $('#arProductName').textContent = product.name;
    $('#arLocationPath').textContent = productLocationPath(product);
    const exact = productExactLocation(product, location);
    $('#arLocationNote').textContent = [location.note, exact.note].filter(Boolean).join(' · ') || 'Raggiungi l’area, scansiona il suo QR e segui i dettagli di ripiano e posto.';
    $('#arTargetLabel').textContent = 'Scansiona il QR dell’area';
    $('#arLockBadge').textContent = 'Da calibrare';
    $('#arLockBadge').classList.remove('locked');
    $('#completeFindBtn').classList.add('hidden');
    $('#calibrateArBtn').classList.remove('hidden');

    if (calibratedLocationId === location.id) {
      $('#arTargetLabel').textContent = `Area confermata: ${location.code} · ${productLocationExactText(product) || 'segui i dettagli indicati'}`;
      $('#arLockBadge').textContent = 'Area verificata';
      $('#arLockBadge').classList.add('locked');
      $('#completeFindBtn').classList.remove('hidden');
      $('#calibrateArBtn').classList.add('hidden');
      if (navigator.vibrate) navigator.vibrate([80, 50, 80]);
    } else if (wrongCode) {
      $('#arTargetLabel').textContent = `QR errato: ${wrongCode}. Cerca ${location.code}`;
      $('#arLockBadge').textContent = 'Area errata';
    }

    $('#arDialog').showModal();
    try {
      state.arStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      $('#arVideo').srcObject = state.arStream;
      await $('#arVideo').play();
    } catch (error) {
      console.error(error);
      $('#arTargetLabel').textContent = 'Fotocamera non disponibile: usa il percorso testuale.';
    }
  }

  function calibrateArGuide() {
    const productId = state.arProductId;
    closeArGuide();
    openScanner('Scansiona QR dell’area', raw => {
      const code = parseLocationCode(raw);
      const location = getLocationByCode(code);
      openArGuide(productId, location?.id || null, code);
    });
  }

  function closeArGuide() {
    stopArCamera();
    if ($('#arDialog').open) $('#arDialog').close();
  }

  function stopArCamera() {
    state.arStream?.getTracks?.().forEach(track => track.stop());
    state.arStream = null;
    if ($('#arVideo')) $('#arVideo').srcObject = null;
  }

  async function askConfirmation(title, message) {
    const dialog = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmMessage').textContent = message;
    dialog.returnValue = 'cancel';
    dialog.showModal();
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    });
  }

  async function installPwa() {
    if (!state.deferredPrompt) {
      notify('Usa il menu del browser e scegli “Installa app” o “Aggiungi a schermata Home”.');
      return;
    }
    state.deferredPrompt.prompt();
    await state.deferredPrompt.userChoice;
    state.deferredPrompt = null;
    $('#installBtn').classList.add('hidden');
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js?v=6.0.0', { updateViaCache: 'none' })
        .then(registration => registration.update())
        .catch(error => console.debug('Service worker:', error));
    });
  }

  function updateConnectionStatus() {
    const label = $('#connectionStatus');
    if (!label) return;
    const cloudConfigured = window.magazzinoCloud?.isConfigured?.();
    if (!navigator.onLine) {
      label.textContent = cloudConfigured ? 'Offline · salvataggio locale attivo' : 'Archivio locale · offline';
      return;
    }
    if (cloudConfigured) {
      const status = state.cloudStatus.status;
      label.textContent = status === 'syncing' ? 'Cloudflare · sincronizzazione…'
        : status === 'error' ? 'Cloudflare · errore sincronizzazione'
        : state.cloudStatus.pending ? `Cloudflare · ${state.cloudStatus.pending} in attesa`
        : 'Cloudflare · dati sincronizzati';
      return;
    }
    label.textContent = 'Archivio locale · online';
  }

  function handleConnectionChange() {
    updateConnectionStatus();
    if (navigator.onLine && window.magazzinoCloud?.isConfigured?.()) {
      window.magazzinoCloud.syncNow().catch(error => console.debug('Sincronizzazione al ritorno online:', error));
    } else if (!navigator.onLine) {
      updateCloudStatus({ status: 'offline', message: 'Connessione assente: le modifiche restano sul dispositivo.', configured: window.magazzinoCloud?.isConfigured?.(), pending: window.magazzinoCloud?.getQueue?.().length || 0 });
    }
  }

  function getProduct(id) {
    return state.products.find(product => product.id === id) || null;
  }

  function getProductByBarcode(barcode) {
    const normalized = normalizeCode(barcode);
    if (!normalized) return null;
    return state.products.find(product => normalizeCode(product.barcode) === normalized) || null;
  }

  function resolveScannedProduct(value) {
    const productId = parseProductId(value);
    return productId ? getProduct(productId) : getProductByBarcode(value);
  }

  function getLocation(id) {
    return state.locations.find(location => location.id === id) || null;
  }

  function getLocationByCode(code) {
    const normalized = normalizeText(code);
    return state.locations.find(location => normalizeText(location.code) === normalized) || null;
  }

  function locationDisplayName(location) {
    if (!location) return 'Area di stoccaggio';
    return String(location.name || location.warehouse || location.code || 'Area di stoccaggio').trim();
  }

  function locationType(location) {
    if (!location) return '';
    return String(location.type || (location.warehouse ? 'Magazzino' : 'Area')).trim();
  }

  function baseLocationPath(location) {
    if (!location) return '';
    const pieces = [
      locationDisplayName(location),
      locationType(location) && locationType(location) !== locationDisplayName(location) ? locationType(location) : '',
      location.zone && `Zona/Reparto ${location.zone}`
    ].filter(Boolean);
    return pieces.join(' › ');
  }

  function productExactLocation(product, location = getLocation(product?.locationId)) {
    if (!product) return { aisle: '', rack: '', shelf: '', bin: '', note: '' };
    return {
      aisle: String(product.locationAisle || location?.aisle || '').trim(),
      rack: String(product.locationRack || location?.rack || '').trim(),
      shelf: String(product.locationShelf || location?.shelf || '').trim(),
      bin: String(product.locationBin || location?.bin || '').trim(),
      note: String(product.locationNote || '').trim()
    };
  }

  function productLocationExactText(product) {
    const exact = productExactLocation(product);
    const pieces = [
      exact.aisle && `Corsia/Colonna ${exact.aisle}`,
      exact.rack && `Scaffale/Cassetto ${exact.rack}`,
      exact.shelf && `Ripiano ${exact.shelf}`,
      exact.bin && `Posto/Casella ${exact.bin}`,
      exact.note
    ].filter(Boolean);
    return pieces.join(' › ');
  }

  function productLocationPath(product) {
    if (!product?.locationId) return '';
    const location = getLocation(product.locationId);
    if (!location) return '';
    const exact = productLocationExactText(product);
    return [baseLocationPath(location), exact].filter(Boolean).join(' › ');
  }

  function generateLocationCode(name, type) {
    const base = `${type || 'AREA'}-${name || 'STOCCAGGIO'}`
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || 'AREA';
    let code = base;
    let counter = 2;
    while (state.locations.some(location => normalizeText(location.code) === normalizeText(code))) {
      code = `${base}-${counter}`;
      counter += 1;
    }
    return code;
  }

  function pathCell(label, value) {
    return `<div class="path-cell"><small>${label}</small><strong>${escapeHtml(String(value || '—'))}</strong></div>`;
  }

  function routeStep(label, value) {
    return `<div class="route-step"><small>${label}</small><b>${escapeHtml(String(value || '—'))}</b></div>`;
  }

  function isLowStock(product) {
    return Number(product.minStock || 0) > 0 && Number(product.quantity || 0) <= Number(product.minStock || 0);
  }

  function normalizeCode(value) {
    return String(value || '').trim().replace(/\s+/g, '');
  }

  function parseLocationCode(value) {
    return String(value || '').trim().replace(/^MAGAR:LOC:/i, '').replace(/^LOC:/i, '').trim();
  }

  function parseProductId(value) {
    const match = String(value || '').trim().match(/^MAGAR:PROD:(.+)$/i);
    return match ? match[1].trim() : '';
  }

  function normalizeText(value) {
    return String(value || '').toLocaleLowerCase('it').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  }

  function toNumber(value) {
    const number = Number(String(value ?? '').replace(',', '.'));
    return Number.isFinite(number) ? number : 0;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 }).format(Number(value || 0));
  }

  function formatDate(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('it-IT').format(new Date(`${value}T12:00:00`));
  }

  function formatDateTime(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  }

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function nextDate(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function closeDialog(id) {
    const dialog = document.getElementById(id);
    if (dialog?.open) dialog.close();
  }

  function emptyBlock(title, text, icon) {
    return `<div class="empty-illustration"><div class="big-icon">${icon}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></div>`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function notify(message, type = '') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`.trim();
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.className = 'toast', 3200);
  }

  function resizeImage(file, maxSize, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error('Immagine non valida.'));
        image.onload = () => {
          const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
})();
