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
    deferredPrompt: null
  };

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
      await window.warehouseDB.open();
      await loadState();
      renderAll();
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
      openScanner('Leggi QR posizione', raw => {
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
      openScanner('Nuova posizione', raw => {
        const location = getLocationByCode(parseLocationCode(raw));
        if (!location) {
          notify('Posizione non registrata.', 'error');
          return;
        }
        $('#movementDestination').value = location.id;
      });
    });

    $('#productForm').addEventListener('submit', saveProduct);
    $('#locationForm').addEventListener('submit', saveLocation);
    $('#movementForm').addEventListener('submit', saveMovement);
    $('#settingsForm').addEventListener('submit', saveSettings);

    $('#productImage').addEventListener('change', handleProductImage);
    $('#movementType').addEventListener('change', syncMovementFields);
    $('#movementProduct').addEventListener('change', syncMovementFields);

    $('#productList').addEventListener('click', handleProductAction);
    $('#locationList').addEventListener('click', handleLocationAction);
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

    window.addEventListener('online', updateConnectionStatus);
    window.addEventListener('offline', updateConnectionStatus);
  }

  function renderAll() {
    renderDashboard();
    renderProducts();
    renderLocations();
    renderMovements();
    renderFindResults();
    renderSettings();
    populateSelects();
  }

  function switchView(view) {
    state.currentView = view;
    $$('.view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
    $$('.nav-btn, .mobile-nav[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (view === 'dashboard') renderDashboard();
    if (view === 'products') renderProducts();
    if (view === 'locations') renderLocations();
    if (view === 'movements') renderMovements();
    if (view === 'find') renderFindResults();
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
        product.name, product.barcode, product.sku, product.category, product.lot,
        location?.code, locationPath(location)
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
        <article class="product-card">
          <div class="product-thumb">${product.imageData ? `<img src="${product.imageData}" alt="Foto ${escapeHtml(product.name)}">` : '▦'}</div>
          <div class="product-main">
            <div class="product-title-row">
              <h3>${escapeHtml(product.name)}</h3>
              ${low ? '<span class="chip low">Sotto scorta</span>' : ''}
              ${expired ? '<span class="chip danger">Scaduto</span>' : ''}
            </div>
            <p>${escapeHtml(product.description || product.category || 'Nessuna descrizione')}</p>
            <div class="meta-row">
              <span class="chip">Barcode ${escapeHtml(product.barcode)}</span>
              ${product.lot ? `<span class="chip">Lotto ${escapeHtml(product.lot)}</span>` : ''}
              ${product.expiry ? `<span class="chip">Scad. ${formatDate(product.expiry)}</span>` : ''}
              <span class="chip">⌖ ${escapeHtml(location ? locationPath(location) : 'Senza posizione')}</span>
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
      return normalizeText([location.code, location.warehouse, location.zone, location.aisle, location.rack, location.shelf, location.bin, location.note].join(' ')).includes(query);
    });

    const container = $('#locationList');
    if (!locations.length) {
      container.innerHTML = emptyBlock('Nessuna posizione trovata', 'Crea il primo scaffale o modifica la ricerca.', '⌖');
      return;
    }

    container.innerHTML = locations.map(location => {
      const count = state.products.filter(product => product.locationId === location.id).length;
      return `
        <article class="location-card">
          <div class="location-card-head">
            <div><h3>${escapeHtml(location.warehouse || 'Magazzino')}</h3><div class="location-code">${escapeHtml(location.code)}</div></div>
            <button class="mini-btn" data-location-action="print" data-id="${location.id}" title="Stampa QR">▦</button>
          </div>
          <div class="location-path">
            ${pathCell('Zona', location.zone)}
            ${pathCell('Corsia', location.aisle)}
            ${pathCell('Scaffale', location.rack)}
            ${pathCell('Ripiano', location.shelf)}
            ${pathCell('Posto', location.bin)}
            ${pathCell('Prodotti', count)}
          </div>
          ${location.note ? `<p>${escapeHtml(location.note)}</p>` : ''}
          <div class="location-footer">
            <span class="location-count">${count} prodott${count === 1 ? 'o' : 'i'}</span>
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
      const haystack = normalizeText([product?.name, movement.productName, movement.operator, movement.note, locationPath(location)].join(' '));
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
      let position = locationPath(to || from) || '—';
      if (movement.type === 'MOVE') position = `${locationPath(from) || '—'} → ${locationPath(to) || '—'}`;
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
      .filter(product => normalizeText([product.name, product.barcode, product.lot, product.sku].join(' ')).includes(query))
      .slice(0, 60);

    const container = $('#findResults');
    if (!products.length) {
      container.innerHTML = '<div class="empty-state">Nessun prodotto trovato.</div>';
    } else {
      container.innerHTML = products.map(product => {
        const location = getLocation(product.locationId);
        return `<button class="find-item ${state.selectedFindId === product.id ? 'active' : ''}" data-find-id="${product.id}" type="button"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.barcode)} · ${escapeHtml(location ? locationPath(location) : 'Senza posizione')}</small></button>`;
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
    empty.classList.add('hidden');
    selected.classList.remove('hidden');
    selected.innerHTML = `
      <div class="selected-product">
        <div class="selected-head">
          <div class="product-thumb">${product.imageData ? `<img src="${product.imageData}" alt="">` : '▦'}</div>
          <div><h2>${escapeHtml(product.name)}</h2><p>${escapeHtml(product.barcode)} · ${formatNumber(product.quantity)} ${escapeHtml(product.unit || 'pz')}</p></div>
        </div>
        <div class="route-box">
          <small>POSIZIONE REGISTRATA</small>
          <strong>${escapeHtml(location ? locationPath(location) : 'Posizione non assegnata')}</strong>
          ${location ? `<div class="route-steps">
            ${routeStep('Magazzino', location.warehouse)}
            ${routeStep('Zona', location.zone)}
            ${routeStep('Corsia', location.aisle)}
            ${routeStep('Scaffale', location.rack)}
            ${routeStep('Ripiano', location.shelf)}
            ${routeStep('Posto', location.bin)}
          </div>` : ''}
        </div>
        ${location?.note ? `<div class="inline-message">Indicazione: ${escapeHtml(location.note)}</div>` : ''}
        <button class="btn btn-primary" data-find-action="guide" data-id="${product.id}" ${location ? '' : 'disabled'} type="button">📷 Apri guida con fotocamera</button>
        <button class="btn btn-secondary" data-find-action="qr" data-id="${product.id}" type="button">▦ Crea e stampa QR prodotto</button>
        <button class="btn btn-secondary" data-find-action="move" data-id="${product.id}" type="button">⇄ Registra movimento</button>
      </div>`;
  }

  function renderSettings() {
    $('#settingCompany').value = state.settings.company || '';
    $('#settingOperator').value = state.settings.operator || 'Operatore';
  }

  function renderCompatibility() {
    const checks = [
      ['Fotocamera', Boolean(navigator.mediaDevices?.getUserMedia)],
      ['Archivio offline', 'indexedDB' in window],
      ['Installazione PWA', 'serviceWorker' in navigator],
      ['Lettura barcode nativa', 'BarcodeDetector' in window],
      ['Guida AR con fotocamera', Boolean(navigator.mediaDevices?.getUserMedia)],
      ['WebXR avanzato', 'xr' in navigator]
    ];
    $('#compatibilityList').innerHTML = checks.map(([label, ok]) => `<li><span class="${ok ? 'check-ok' : 'check-no'}">${ok ? '✓' : '—'}</span>${escapeHtml(label)}</li>`).join('');
  }

  function populateSelects() {
    const locationOptions = state.locations.map(location => `<option value="${location.id}">${escapeHtml(location.code)} — ${escapeHtml(locationPath(location))}</option>`).join('');
    const productOptions = state.products.map(product => `<option value="${product.id}">${escapeHtml(product.name)} — ${escapeHtml(product.barcode)}</option>`).join('');
    $('#productLocation').innerHTML = `<option value="">Nessuna posizione</option>${locationOptions}`;
    $('#movementDestination').innerHTML = `<option value="">Seleziona posizione</option>${locationOptions}`;
    $('#movementProduct').innerHTML = `<option value="">Seleziona prodotto</option>${productOptions}`;
  }

  async function quickScan() {
    openScanner('Scansiona prodotto o posizione', async raw => {
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
    $('#productDescription').value = product?.description || '';
    $('#productImage').value = '';
    state.currentImageData = product?.imageData || '';
    updateImagePreview();
    $('#productDialog').showModal();
    setTimeout(() => (product ? $('#productName') : $('#productBarcode')).focus(), 80);
  }

  async function saveProduct(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const id = $('#productId').value || uid();
    const existing = getProduct(id);
    const barcode = normalizeCode($('#productBarcode').value);
    const duplicate = state.products.find(product => normalizeCode(product.barcode) === barcode && product.id !== id);
    if (duplicate) {
      notify(`Il codice è già usato da “${duplicate.name}”.`, 'error');
      return;
    }

    const quantity = toNumber($('#productQuantity').value);
    const now = new Date().toISOString();
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
      locationId: $('#productLocation').value,
      description: $('#productDescription').value.trim(),
      imageData: state.currentImageData || '',
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    try {
      await warehouseDB.put('products', product);
      if (!existing && quantity > 0) {
        await createMovementRecord(product, 'IN', quantity, null, product.locationId, 'Giacenza iniziale');
      } else if (existing) {
        if (quantity !== Number(existing.quantity || 0)) {
          await createMovementRecord(product, 'ADJUST', quantity, existing.locationId, product.locationId, `Rettifica da ${formatNumber(existing.quantity)} a ${formatNumber(quantity)}`);
        }
        if (existing.locationId !== product.locationId) {
          await createMovementRecord(product, 'MOVE', quantity, existing.locationId, product.locationId, 'Posizione modificata dalla scheda prodotto');
        }
      }
      await loadState();
      renderAll();
      form.closest('dialog').close();
      notify(existing ? 'Prodotto aggiornato.' : 'Prodotto salvato. Premi QR nella scheda per stampare l’etichetta.', 'success');
    } catch (error) {
      console.error(error);
      notify('Errore durante il salvataggio del prodotto.', 'error');
    }
  }

  async function handleProductImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      state.currentImageData = await resizeImage(file, 1100, .78);
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
    $('#locationDialogTitle').textContent = location ? 'Modifica posizione' : 'Nuova posizione';
    $('#locationCode').value = location?.code || code || '';
    $('#locationWarehouse').value = location?.warehouse || '';
    $('#locationZone').value = location?.zone || '';
    $('#locationAisle').value = location?.aisle || '';
    $('#locationRack').value = location?.rack || '';
    $('#locationShelf').value = location?.shelf || '';
    $('#locationBin').value = location?.bin || '';
    $('#locationNote').value = location?.note || '';
    $('#locationDialog').showModal();
  }

  async function saveLocation(event) {
    event.preventDefault();
    const id = $('#locationId').value || uid();
    const code = parseLocationCode($('#locationCode').value.trim());
    const duplicate = state.locations.find(location => normalizeText(location.code) === normalizeText(code) && location.id !== id);
    if (duplicate) {
      notify('Esiste già una posizione con questo codice.', 'error');
      return;
    }

    const existing = getLocation(id);
    const now = new Date().toISOString();
    const location = {
      id,
      code,
      warehouse: $('#locationWarehouse').value.trim(),
      zone: $('#locationZone').value.trim(),
      aisle: $('#locationAisle').value.trim(),
      rack: $('#locationRack').value.trim(),
      shelf: $('#locationShelf').value.trim(),
      bin: $('#locationBin').value.trim(),
      note: $('#locationNote').value.trim(),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    try {
      await warehouseDB.put('locations', location);
      await loadState();
      renderAll();
      $('#locationDialog').close();
      notify('Posizione salvata. Puoi stampare il relativo QR.', 'success');
    } catch (error) {
      console.error(error);
      notify('Errore durante il salvataggio della posizione.', 'error');
    }
  }

  function openMovementForm(productId = '', type = 'IN') {
    populateSelects();
    $('#movementForm').reset();
    $('#movementProduct').value = productId;
    $('#movementType').value = type;
    $('#movementQuantity').value = 1;
    $('#movementNote').value = '';
    syncMovementFields();
    $('#movementDialog').showModal();
  }

  function syncMovementFields() {
    const type = $('#movementType').value;
    const product = getProduct($('#movementProduct').value);
    const destinationField = $('#movementDestinationField');
    const quantity = $('#movementQuantity');
    const warning = $('#movementWarning');

    destinationField.classList.toggle('hidden', type !== 'MOVE');
    $('#movementDestination').required = type === 'MOVE';
    quantity.disabled = false;
    quantity.min = '0';

    if (type === 'MOVE') {
      quantity.value = product ? product.quantity : 0;
      quantity.disabled = true;
      warning.textContent = 'Nella prima versione lo spostamento trasferisce tutta la giacenza del prodotto nella nuova posizione.';
      warning.classList.remove('hidden');
    } else if (type === 'ADJUST') {
      quantity.value = product ? product.quantity : 0;
      warning.textContent = 'Per la rettifica inserisci la nuova quantità totale, non la differenza.';
      warning.classList.remove('hidden');
    } else {
      warning.classList.add('hidden');
    }
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
    let newLocationId = product.locationId || '';

    if (type === 'IN') {
      if (entered <= 0) return notify('La quantità deve essere maggiore di zero.', 'error');
      newQuantity += entered;
    } else if (type === 'OUT') {
      if (entered <= 0) return notify('La quantità deve essere maggiore di zero.', 'error');
      if (entered > newQuantity) return notify('Quantità insufficiente per il prelievo.', 'error');
      newQuantity -= entered;
    } else if (type === 'ADJUST') {
      if (entered < 0) return notify('La quantità non può essere negativa.', 'error');
      newQuantity = entered;
    } else if (type === 'MOVE') {
      if (!destinationId) return notify('Seleziona la nuova posizione.', 'error');
      if (destinationId === product.locationId) return notify('Il prodotto è già in questa posizione.', 'error');
      movementQuantity = Number(product.quantity || 0);
      newLocationId = destinationId;
    }

    const updatedProduct = { ...product, quantity: newQuantity, locationId: newLocationId, updatedAt: new Date().toISOString() };

    try {
      await warehouseDB.put('products', updatedProduct);
      await createMovementRecord(updatedProduct, type, movementQuantity, product.locationId, newLocationId, $('#movementNote').value.trim());
      await loadState();
      renderAll();
      $('#movementDialog').close();
      notify('Movimento registrato.', 'success');
    } catch (error) {
      console.error(error);
      notify('Errore durante la registrazione del movimento.', 'error');
    }
  }

  async function createMovementRecord(product, type, quantity, fromLocationId, toLocationId, note = '') {
    const movement = {
      id: uid(),
      productId: product.id,
      productName: product.name,
      type,
      quantity: Number(quantity || 0),
      fromLocationId: fromLocationId || '',
      toLocationId: toLocationId || '',
      operator: state.settings.operator || 'Operatore',
      note,
      timestamp: new Date().toISOString()
    };
    await warehouseDB.put('movements', movement);
    return movement;
  }

  async function handleProductAction(event) {
    const button = event.target.closest('[data-product-action]');
    if (!button) return;
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
      const confirmed = await askConfirmation('Elimina prodotto', `Vuoi eliminare “${product.name}”? Lo storico dei movimenti resterà disponibile.`);
      if (!confirmed) return;
      await warehouseDB.delete('products', product.id);
      await loadState();
      renderAll();
      notify('Prodotto eliminato.', 'success');
    }
  }

  async function handleLocationAction(event) {
    const button = event.target.closest('[data-location-action]');
    if (!button) return;
    const location = getLocation(button.dataset.id);
    if (!location) return;

    if (button.dataset.locationAction === 'edit') openLocationForm(location);
    if (button.dataset.locationAction === 'print') printLocationLabel(location);
    if (button.dataset.locationAction === 'delete') {
      const count = state.products.filter(product => product.locationId === location.id).length;
      if (count) {
        notify(`Non puoi eliminare la posizione: contiene ${count} prodott${count === 1 ? 'o' : 'i'}.`, 'error');
        return;
      }
      const confirmed = await askConfirmation('Elimina posizione', `Vuoi eliminare la posizione ${location.code}?`);
      if (!confirmed) return;
      await warehouseDB.delete('locations', location.id);
      await loadState();
      renderAll();
      notify('Posizione eliminata.', 'success');
    }
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
    const label = document.createElement('div');
    label.className = 'print-label print-location-label';
    const qrBox = document.createElement('div');
    qrBox.className = 'print-qr';
    const text = document.createElement('div');
    text.className = 'print-copy';
    text.innerHTML = `<div class="print-kicker">POSIZIONE DI MAGAZZINO</div><h1>${escapeHtml(location.code)}</h1><p><strong>${escapeHtml(location.warehouse || '')}</strong></p><p>${escapeHtml(locationPath(location))}</p><p>${escapeHtml(location.note || '')}</p>`;
    label.append(qrBox, text);
    document.body.appendChild(label);

    try {
      await createQrCode(qrBox, `MAGAR:LOC:${location.code}`, 420);
      await waitForPrintAssets();
      window.print();
    } catch (error) {
      console.error(error);
      notify('Impossibile creare il QR della posizione.', 'error');
    } finally {
      setTimeout(() => label.remove(), 700);
    }
  }

  async function printProductLabel(product) {
    const location = getLocation(product.locationId);
    const label = document.createElement('div');
    label.className = 'print-label print-product-label';

    const qrBox = document.createElement('div');
    qrBox.className = 'print-qr';

    const text = document.createElement('div');
    text.className = 'print-copy';
    const details = [
      product.sku ? `Codice interno: ${escapeHtml(product.sku)}` : '',
      product.barcode ? `Barcode: ${escapeHtml(product.barcode)}` : '',
      product.lot ? `Lotto: ${escapeHtml(product.lot)}` : '',
      product.expiry ? `Scadenza: ${escapeHtml(formatDate(product.expiry))}` : ''
    ].filter(Boolean).map(value => `<p>${value}</p>`).join('');

    text.innerHTML = `
      <div class="print-kicker">ETICHETTA PRODOTTO</div>
      <h1>${escapeHtml(product.name)}</h1>
      ${details}
      <p class="print-location"><strong>Posizione attuale:</strong><br>${escapeHtml(location ? locationPath(location) : 'Non assegnata')}</p>
      <p class="print-hint">Scansiona il QR nell’app per vedere la posizione aggiornata.</p>`;

    label.append(qrBox, text);
    document.body.appendChild(label);

    try {
      await createQrCode(qrBox, `MAGAR:PROD:${product.id}`, 420);
      await waitForPrintAssets();
      window.print();
    } catch (error) {
      console.error(error);
      notify('Impossibile creare il QR del prodotto.', 'error');
    } finally {
      setTimeout(() => label.remove(), 700);
    }
  }

  async function createQrCode(container, text, size = 420) {
    if (!window.QRCode) throw new Error('Generatore QR non disponibile');

    if (typeof window.QRCode.toCanvas === 'function') {
      const canvas = document.createElement('canvas');
      container.appendChild(canvas);
      await window.QRCode.toCanvas(canvas, text, {
        width: size,
        margin: 1,
        errorCorrectionLevel: 'M'
      });
      return;
    }

    if (typeof window.QRCode === 'function') {
      new window.QRCode(container, {
        text,
        width: size,
        height: size,
        correctLevel: window.QRCode.CorrectLevel?.M
      });
      return;
    }

    throw new Error('Formato libreria QR non riconosciuto');
  }

  function waitForPrintAssets() {
    return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 180)));
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
    const confirmed = await askConfirmation('Carica dati dimostrativi', 'Verranno aggiunti alcuni prodotti e posizioni di esempio.');
    if (!confirmed) return;

    const suffix = String(Date.now()).slice(-5);
    const now = new Date().toISOString();
    const locations = [
      { id: uid(), code: `M1-A-01-01-01-${suffix}`, warehouse: 'Magazzino 1', zone: 'A', aisle: '01', rack: '01', shelf: '01', bin: '01', note: 'Ingresso corsia, lato sinistro', createdAt: now, updatedAt: now },
      { id: uid(), code: `M1-A-01-02-02-${suffix}`, warehouse: 'Magazzino 1', zone: 'A', aisle: '01', rack: '02', shelf: '02', bin: '01', note: 'Secondo modulo', createdAt: now, updatedAt: now },
      { id: uid(), code: `M1-B-03-05-03-${suffix}`, warehouse: 'Magazzino 1', zone: 'B', aisle: '03', rack: '05', shelf: '03', bin: '02', note: 'Lato destro', createdAt: now, updatedAt: now }
    ];
    for (const location of locations) await warehouseDB.put('locations', location);

    const products = [
      { id: uid(), barcode: `8000000${suffix}1`, name: 'Cuscinetto dimostrativo 6204', sku: 'CUS-6204', category: 'Cuscinetti', quantity: 48, unit: 'pz', minStock: 20, lot: 'L26-A1', expiry: '', locationId: locations[0].id, description: 'Confezione cuscinetti per linea produttiva', imageData: '', createdAt: now, updatedAt: now },
      { id: uid(), barcode: `8000000${suffix}2`, name: 'Anello OR 42 mm', sku: 'OR-042', category: 'Guarnizioni', quantity: 12, unit: 'pz', minStock: 15, lot: 'OR2607', expiry: '', locationId: locations[1].id, description: 'Anello di tenuta in gomma', imageData: '', createdAt: now, updatedAt: now },
      { id: uid(), barcode: `8000000${suffix}3`, name: 'Lubrificante tecnico', sku: 'LUB-500', category: 'Lubrificanti', quantity: 8, unit: 'confezioni', minStock: 4, lot: 'LB-778', expiry: nextDate(240), locationId: locations[2].id, description: 'Flacone da 500 ml', imageData: '', createdAt: now, updatedAt: now }
    ];
    for (const product of products) {
      await warehouseDB.put('products', product);
      await createMovementRecord(product, 'IN', product.quantity, null, product.locationId, 'Dato dimostrativo');
    }

    await loadState();
    renderAll();
    notify('Dati dimostrativi caricati.', 'success');
  }

  async function resetAllData() {
    const confirmed = await askConfirmation('Cancella tutto', 'Questa operazione elimina prodotti, posizioni, movimenti e impostazioni dal dispositivo.');
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
    if (!product || !location) return notify('Il prodotto non ha una posizione valida.', 'error');

    state.arProductId = productId;
    $('#arProductName').textContent = product.name;
    $('#arLocationPath').textContent = locationPath(location);
    $('#arLocationNote').textContent = location.note || 'Raggiungi la posizione e scansiona il suo QR.';
    $('#arTargetLabel').textContent = 'Scansiona il QR della posizione';
    $('#arLockBadge').textContent = 'Da calibrare';
    $('#arLockBadge').classList.remove('locked');
    $('#completeFindBtn').classList.add('hidden');
    $('#calibrateArBtn').classList.remove('hidden');

    if (calibratedLocationId === location.id) {
      $('#arTargetLabel').textContent = `Posizione confermata: ${location.code}`;
      $('#arLockBadge').textContent = 'Posizione verificata';
      $('#arLockBadge').classList.add('locked');
      $('#completeFindBtn').classList.remove('hidden');
      $('#calibrateArBtn').classList.add('hidden');
      if (navigator.vibrate) navigator.vibrate([80, 50, 80]);
    } else if (wrongCode) {
      $('#arTargetLabel').textContent = `QR errato: ${wrongCode}. Cerca ${location.code}`;
      $('#arLockBadge').textContent = 'Posizione errata';
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
    openScanner('Scansiona QR della posizione', raw => {
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
      navigator.serviceWorker.register('./sw.js').catch(error => console.debug('Service worker:', error));
    });
  }

  function updateConnectionStatus() {
    $('#connectionStatus').textContent = navigator.onLine ? 'Archivio locale · online' : 'Archivio locale · offline';
  }

  function getProduct(id) {
    return state.products.find(product => product.id === id) || null;
  }

  function getProductByBarcode(barcode) {
    const normalized = normalizeCode(barcode);
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

  function locationPath(location) {
    if (!location) return '';
    const pieces = [
      location.warehouse,
      location.zone && `Zona ${location.zone}`,
      location.aisle && `Corsia ${location.aisle}`,
      location.rack && `Scaffale ${location.rack}`,
      location.shelf && `Ripiano ${location.shelf}`,
      location.bin && `Posto ${location.bin}`
    ].filter(Boolean);
    return pieces.join(' › ');
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
