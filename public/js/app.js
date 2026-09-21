let CURRENT_USER = null;
let CATEGORIES = [];
const view = document.getElementById('view');
let navigationToken = 0;

async function init() {
  try {
    CURRENT_USER = await api.get('/api/me');
  } catch (e) {
    return; // redirected to login by api.js
  }
  document.getElementById('userPill').textContent = `${CURRENT_USER.fullName} · ${CURRENT_USER.role === 'admin' ? 'Administrador' : 'Vendedor'}`;
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api.post('/api/logout');
    window.location.href = '/login.html';
  });
  try {
    CATEGORIES = await api.get('/api/categories');
  } catch (e) { CATEGORIES = []; }

  window.addEventListener('hashchange', router);
  router();
}

function navigate(hash) { window.location.hash = hash; }

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [route, ...rest] = raw.split('/');
  return { route: route || 'dashboard', params: rest };
}

async function router() {
  const currentToken = ++navigationToken;
  const { route, params } = parseHash();
  view.innerHTML = '<div class="loading">Cargando…</div>';
  try {
    const render = route === 'dashboard' || route === '' ? renderDashboard
      : route === 'inventario' ? renderInventory
      : route === 'producto-nuevo' ? renderProductForm
      : route === 'producto' && params[0] ? () => renderProductDetail(params[0])
      : route === 'venta' ? renderSale
      : route === 'historial' ? renderHistory
      : route === 'venta-detalle' && params[0] ? () => renderSaleDetail(params[0])
      : route === 'separados' ? renderSeparatedOrders
      : route === 'separado-detalle' && params[0] ? () => renderSeparatedDetail(params[0])
      : route === 'fiados' ? renderCreditSales
      : route === 'fiado-detalle' && params[0] ? () => renderCreditDetail(params[0])
      : route === 'configuracion' ? renderSettings
      : route === 'informes' ? renderReports
      : renderDashboard;
    await render();
    if (currentToken !== navigationToken) return;
  } catch (e) {
    if (currentToken !== navigationToken) return;
    view.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function backLink(hash, label) {
  return `<button class="back-link" onclick="navigate('${hash}')">&larr; ${label}</button>`;
}

function normalizeSearchValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

// ---------------- DASHBOARD ----------------
async function renderDashboard() {
  const data = await api.get('/api/dashboard');
  view.innerHTML = `
    <p class="hello">Hola, ${escapeHtml(CURRENT_USER.fullName.split(' ')[0])} 👋</p>
    <div class="stat-grid">
      <div class="card stat-card">
        <div class="label">Ventas de hoy</div>
        <div class="value">${fmtMoney(data.salesToday)}</div>
      </div>
      <div class="card stat-card">
        <div class="label">Productos vendidos hoy</div>
        <div class="value">${data.itemsSoldToday}</div>
      </div>
      <div class="card stat-card ${data.lowStockCount > 0 ? 'alert' : ''}">
        <div class="label">Productos con poco stock</div>
        <div class="value">${data.lowStockCount}</div>
      </div>
      <div class="card stat-card ${data.expiredSeparatedCount > 0 ? 'alert' : ''}">
        <div class="label">Separados vencidos</div>
        <div class="value">${data.expiredSeparatedCount || 0}</div>
      </div>
      <div class="card stat-card">
        <div class="label">Productos en stock</div>
        <div class="value">${data.inventoryUnits}</div>
      </div>
    </div>
    <div class="nav-grid">
      <button class="nav-tile" onclick="navigate('inventario')"><span class="icon">📦</span>Inventario</button>
      <button class="nav-tile" onclick="navigate('venta')"><span class="icon">🛒</span>Registrar venta</button>
      <button class="nav-tile" onclick="navigate('separados')"><span class="icon">📦</span>Separados</button>
      <button class="nav-tile" onclick="navigate('fiados')"><span class="icon">🧾</span>Fiados</button>
      <button class="nav-tile" onclick="navigate('producto-nuevo')"><span class="icon">➕</span>Nuevo producto</button>
      <button class="nav-tile" onclick="navigate('historial')"><span class="icon">📋</span>Ventas</button>
      <button class="nav-tile" onclick="navigate('informes')"><span class="icon">📊</span>Informes</button>
      <button class="nav-tile" onclick="navigate('configuracion')"><span class="icon">⚙️</span>Configuración</button>
    </div>
  `;
}

async function renderSeparatedOrders(searchTerm = '') {
  const list = await api.get('/api/separados' + (searchTerm ? '?q=' + encodeURIComponent(searchTerm) : ''));
  view.innerHTML = `
    ${backLink('dashboard', 'Inicio')}
    <h2 class="section-title">Separados</h2>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px">
      <button class="btn btn-primary" onclick="openSeparatedModal()">➕ Nuevo separado</button>
    </div>
    <div class="searchbar" style="margin-bottom:18px">
      <input id="separatedSearch" placeholder="Buscar por cliente, código o nombre del producto" value="${escapeHtml(searchTerm)}" />
    </div>
    ${list.length === 0 ? '<div class="empty-state"><div class="icon">📦</div><p>No hay separados registrados.</p></div>' : list.map((order) => `
      <div class="product-item" style="cursor:pointer" onclick="navigate('separado-detalle/${order.id}')">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
          <strong>${escapeHtml(order.order_number)}</strong>
          <span class="badge ${order.status === 'activo' ? 'badge-gold' : order.status === 'completado' ? 'badge-ok' : 'badge-danger'}">${escapeHtml(order.status)}</span>
        </div>
        <div class="name">${escapeHtml(order.client_name)}</div>
        <div class="meta">${escapeHtml(order.phone)} · ${new Date(order.created_at).toLocaleDateString('es-CO')} · vence ${new Date(order.due_at).toLocaleDateString('es-CO')}</div>
        <div class="total-stock">Total: ${fmtMoney(order.total)} · Pagado: ${fmtMoney(order.paid_amount)} · Saldo: ${fmtMoney(order.balance || 0)}</div>
      </div>
    `).join('')}
  `;
  const input = document.getElementById('separatedSearch');
  if (input) {
    input.addEventListener('input', () => {
      renderSeparatedOrders(input.value);
    });
  }
}

async function renderSeparatedDetail(id) {
  const order = await api.get('/api/separados/' + id);
  view.innerHTML = `
    ${backLink('separados', 'Separados')}
    <h2 class="section-title">${escapeHtml(order.order_number)}</h2>
    <div class="card" style="margin-bottom:18px">
      <p><strong>Cliente:</strong> ${escapeHtml(order.client_name)}</p>
      <p><strong>Teléfono:</strong> ${escapeHtml(order.phone)}</p>
      <p><strong>Fecha:</strong> ${new Date(order.created_at).toLocaleString('es-CO')}</p>
      <p><strong>Fecha límite:</strong> ${new Date(order.due_at).toLocaleString('es-CO')}</p>
      <p><strong>Estado:</strong> ${escapeHtml(order.status)}</p>
      <p><strong>Total:</strong> ${fmtMoney(order.total)}</p>
      <p><strong>Pagado:</strong> ${fmtMoney(order.paid_amount)}</p>
      <p><strong>Saldo:</strong> ${fmtMoney(order.balance)}</p>
    </div>
    <h3>Productos</h3>
    ${order.items.map((item) => `
      <div class="product-item">
        <div class="ref">${escapeHtml(item.product_reference)}</div>
        <div class="name">${escapeHtml(item.product_name)} ${item.size ? '· talla ' + escapeHtml(item.size) : ''}</div>
        <div class="meta">Cantidad: ${item.quantity} · Retirada: ${item.retired_quantity} · Pendiente: ${item.quantity - item.retired_quantity}</div>
        <div class="meta">${fmtMoney(item.unit_price)} × ${item.quantity} = ${fmtMoney(item.subtotal)}</div>
      </div>
    `).join('')}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin:20px 0">
      <button class="btn btn-primary" onclick="openSeparatedPayment(${order.id})">💰 Abonar</button>
      <button class="btn btn-outline" onclick="openSeparatedRetiro(${order.id})">📦 Retirar</button>
      <button class="btn btn-danger" onclick="openSeparatedCancel(${order.id})">🚫 Anular</button>
    </div>
  `;
}

async function renderCreditSales(searchTerm = '') {
  const list = await api.get('/api/fiados' + (searchTerm ? '?q=' + encodeURIComponent(searchTerm) : ''));
  view.innerHTML = `
    ${backLink('dashboard', 'Inicio')}
    <h2 class="section-title">Fiados</h2>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px">
      <button class="btn btn-primary" onclick="openFiadoModal()">➕ Nuevo fiado</button>
    </div>
    <div class="searchbar" style="margin-bottom:18px">
      <input id="fiadoSearch" placeholder="Buscar por cliente, código o nombre del producto" value="${escapeHtml(searchTerm)}" />
    </div>
    ${list.length === 0 ? '<div class="empty-state"><div class="icon">🧾</div><p>No hay fiados registrados.</p></div>' : list.map((credit) => `
      <div class="product-item" style="cursor:pointer" onclick="navigate('fiado-detalle/${credit.id}')">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
          <strong>${escapeHtml(credit.credit_number)}</strong>
          <span class="badge ${credit.status === 'pendiente' ? 'badge-gold' : credit.status === 'pagado' ? 'badge-ok' : 'badge-danger'}">${escapeHtml(credit.status)}</span>
        </div>
        <div class="name">${escapeHtml(credit.client_name)}</div>
        <div class="meta">${escapeHtml(credit.phone)} · ${new Date(credit.created_at).toLocaleDateString('es-CO')}</div>
        <div class="total-stock">Total: ${fmtMoney(credit.total)} · Pagado: ${fmtMoney(credit.paid_amount)} · Saldo: ${fmtMoney(credit.balance || 0)}</div>
      </div>
    `).join('')}
  `;
  const input = document.getElementById('fiadoSearch');
  if (input) {
    input.addEventListener('input', () => {
      renderCreditSales(input.value);
    });
  }
}

async function renderCreditDetail(id) {
  const credit = await api.get('/api/fiados/' + id);
  view.innerHTML = `
    ${backLink('fiados', 'Fiados')}
    <h2 class="section-title">${escapeHtml(credit.credit_number)}</h2>
    <div class="card" style="margin-bottom:18px">
      <p><strong>Cliente:</strong> ${escapeHtml(credit.client_name)}</p>
      <p><strong>Teléfono:</strong> ${escapeHtml(credit.phone)}</p>
      <p><strong>Fecha:</strong> ${new Date(credit.created_at).toLocaleString('es-CO')}</p>
      <p><strong>Estado:</strong> ${escapeHtml(credit.status)}</p>
      <p><strong>Total:</strong> ${fmtMoney(credit.total)}</p>
      <p><strong>Pagado:</strong> ${fmtMoney(credit.paid_amount)}</p>
      <p><strong>Saldo:</strong> ${fmtMoney(credit.balance)}</p>
    </div>
    <h3>Productos</h3>
    ${credit.items.map((item) => `
      <div class="product-item">
        <div class="ref">${escapeHtml(item.product_reference)}</div>
        <div class="name">${escapeHtml(item.product_name)} ${item.size ? '· talla ' + escapeHtml(item.size) : ''}</div>
        <div class="meta">Cantidad: ${item.quantity} · ${fmtMoney(item.unit_price)} c/u = ${fmtMoney(item.subtotal)}</div>
      </div>
    `).join('')}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin:20px 0">
      <button class="btn btn-primary" onclick="openFiadoPayment(${credit.id})">💰 Abonar</button>
      <button class="btn btn-danger" onclick="openFiadoCancel(${credit.id})">🚫 Anular</button>
    </div>
  `;
}

async function openSeparatedModal() {
  const products = await api.get('/api/products');
  const usableProducts = (products || []).filter((product) => product.status === 'activo');
  showModal(`
    <h3>Nuevo separado</h3>
    <form id="separatedForm">
      <div class="field"><label>Cliente</label><input id="sepClient" required /></div>
      <div class="field"><label>Teléfono</label><input id="sepPhone" required /></div>
      <div class="field">
        <label>Buscar producto</label>
        <input id="sepProductSearch" placeholder="Código, referencia o nombre del producto" autocomplete="off" />
      </div>
      <div id="sepProductResults" class="search-results" style="max-height:210px;overflow:auto;margin-bottom:10px"></div>
      <div id="sepSelectedProduct" class="helper-text" style="margin-bottom:10px">Selecciona un producto para cargar el precio automáticamente.</div>
      <input id="sepVariant" type="hidden" />
      <div class="field"><label>Cantidad</label><input id="sepQty" type="number" min="1" value="1" required /></div>
      <div class="field"><label>Precio unitario</label><input id="sepPrice" type="number" min="0" step="1" value="0" required /></div>
      <div class="field"><label>Abono inicial</label><input id="sepInitialPayment" type="number" min="0" step="1" value="0" /></div>
      <div class="field"><label>Fecha límite</label><input id="sepDueAt" type="date" /></div>
      <button class="btn btn-primary btn-block" type="submit">Guardar separado</button>
    </form>
  `);

  const searchInput = document.getElementById('sepProductSearch');
  const resultsContainer = document.getElementById('sepProductResults');
  const selectedProductLabel = document.getElementById('sepSelectedProduct');
  const productMatches = usableProducts.flatMap((product) => product.variants.map((variant) => ({
    product,
    variant,
    searchText: `${product.reference} ${product.name} ${variant.size || ''}`,
  })));

  const renderProductMatches = (query = '') => {
    const term = normalizeSearchValue(query);
    const matches = !term
      ? productMatches.slice(0, 12)
      : productMatches.filter((entry) => normalizeSearchValue(entry.searchText).includes(term)).slice(0, 12);

    resultsContainer.innerHTML = matches.length === 0 ? '<p class="helper-text">No se encontraron productos.</p>' : matches.map((entry) => `
      <button type="button" class="btn btn-outline" style="display:block;width:100%;text-align:left;margin:6px 0;padding:10px 12px" data-variant-id="${entry.variant.variant_id}">
        <strong>${escapeHtml(entry.product.reference)}</strong>
        ${entry.variant.size ? ' · talla ' + escapeHtml(entry.variant.size) : ''}
        <div class="meta">${escapeHtml(entry.product.name)} · ${fmtMoney(entry.product.price)}</div>
      </button>
    `).join('');

    resultsContainer.querySelectorAll('button[data-variant-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const variantId = Number(button.dataset.variantId);
        const selectedProduct = productMatches.find((entry) => Number(entry.variant.variant_id) === variantId);
        if (!selectedProduct) return;
        document.getElementById('sepVariant').value = String(variantId);
        document.getElementById('sepPrice').value = String(selectedProduct.product.price);
        selectedProductLabel.textContent = `Seleccionado: ${selectedProduct.product.reference}${selectedProduct.variant.size ? ' · talla ' + selectedProduct.variant.size : ''} · ${fmtMoney(selectedProduct.product.price)}`;
        searchInput.value = selectedProduct.product.reference;
      });
    });
  };

  searchInput.addEventListener('input', () => renderProductMatches(searchInput.value));
  renderProductMatches();

  document.getElementById('separatedForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const variantId = Number(document.getElementById('sepVariant').value);
      if (!variantId) throw new Error('Busca y selecciona un producto antes de guardar el separado.');
      await api.post('/api/separados', {
        clientName: document.getElementById('sepClient').value,
        phone: document.getElementById('sepPhone').value,
        items: [{ variantId, quantity: Number(document.getElementById('sepQty').value), unitPrice: Number(document.getElementById('sepPrice').value) }],
        initialPayment: Number(document.getElementById('sepInitialPayment').value || 0),
        dueAt: document.getElementById('sepDueAt').value || null,
      });
      closeModal();
      toast('Separado creado', 'success');
      renderSeparatedOrders();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function openFiadoModal() {
  const products = await api.get('/api/products');
  const usableProducts = (products || []).filter((product) => product.status === 'activo');
  showModal(`
    <h3>Nuevo fiado</h3>
    <form id="fiadoForm">
      <div class="field"><label>Cliente</label><input id="fiaClient" required /></div>
      <div class="field"><label>Teléfono</label><input id="fiaPhone" required /></div>
      <div class="field">
        <label>Buscar producto</label>
        <input id="fiaProductSearch" placeholder="Código, referencia o nombre del producto" autocomplete="off" />
      </div>
      <div id="fiaProductResults" class="search-results" style="max-height:210px;overflow:auto;margin-bottom:10px"></div>
      <div id="fiaSelectedProduct" class="helper-text" style="margin-bottom:10px">Selecciona un producto para cargar el precio automáticamente.</div>
      <input id="fiaVariant" type="hidden" />
      <div class="field"><label>Cantidad</label><input id="fiaQty" type="number" min="1" value="1" required /></div>
      <div class="field"><label>Precio unitario</label><input id="fiaPrice" type="number" min="0" step="1" value="0" required /></div>
      <div class="field"><label>Abono inicial</label><input id="fiaInitialPayment" type="number" min="0" step="1" value="0" /></div>
      <button class="btn btn-primary btn-block" type="submit">Guardar fiado</button>
    </form>
  `);

  const searchInput = document.getElementById('fiaProductSearch');
  const resultsContainer = document.getElementById('fiaProductResults');
  const selectedProductLabel = document.getElementById('fiaSelectedProduct');
  const productMatches = usableProducts.flatMap((product) => product.variants.map((variant) => ({
    product,
    variant,
    searchText: `${product.reference} ${product.name} ${variant.size || ''}`,
  })));

  const renderProductMatches = (query = '') => {
    const term = normalizeSearchValue(query);
    const matches = !term
      ? productMatches.slice(0, 12)
      : productMatches.filter((entry) => normalizeSearchValue(entry.searchText).includes(term)).slice(0, 12);

    resultsContainer.innerHTML = matches.length === 0 ? '<p class="helper-text">No se encontraron productos.</p>' : matches.map((entry) => `
      <button type="button" class="btn btn-outline" style="display:block;width:100%;text-align:left;margin:6px 0;padding:10px 12px" data-variant-id="${entry.variant.variant_id}">
        <strong>${escapeHtml(entry.product.reference)}</strong>
        ${entry.variant.size ? ' · talla ' + escapeHtml(entry.variant.size) : ''}
        <div class="meta">${escapeHtml(entry.product.name)} · ${fmtMoney(entry.product.price)}</div>
      </button>
    `).join('');

    resultsContainer.querySelectorAll('button[data-variant-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const variantId = Number(button.dataset.variantId);
        const selectedProduct = productMatches.find((entry) => Number(entry.variant.variant_id) === variantId);
        if (!selectedProduct) return;
        document.getElementById('fiaVariant').value = String(variantId);
        document.getElementById('fiaPrice').value = String(selectedProduct.product.price);
        selectedProductLabel.textContent = `Seleccionado: ${selectedProduct.product.reference}${selectedProduct.variant.size ? ' · talla ' + selectedProduct.variant.size : ''} · ${fmtMoney(selectedProduct.product.price)}`;
        searchInput.value = selectedProduct.product.reference;
      });
    });
  };

  searchInput.addEventListener('input', () => renderProductMatches(searchInput.value));
  renderProductMatches();

  document.getElementById('fiadoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const variantId = Number(document.getElementById('fiaVariant').value);
      if (!variantId) throw new Error('Busca y selecciona un producto antes de guardar el fiado.');
      await api.post('/api/fiados', {
        clientName: document.getElementById('fiaClient').value,
        phone: document.getElementById('fiaPhone').value,
        items: [{ variantId, quantity: Number(document.getElementById('fiaQty').value), unitPrice: Number(document.getElementById('fiaPrice').value) }],
        initialPayment: Number(document.getElementById('fiaInitialPayment').value || 0),
      });
      closeModal();
      toast('Fiado creado', 'success');
      renderCreditSales();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function openSeparatedPayment(id) {
  showModal(`
    <h3>Abonar separado</h3>
    <form id="sepPaymentForm">
      <div class="field"><label>Valor</label><input id="sepPaymentAmount" type="number" min="1" step="1" required /></div>
      <button class="btn btn-primary btn-block" type="submit">Registrar abono</button>
    </form>
  `);
  document.getElementById('sepPaymentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.post('/api/separados/' + id + '/pagos', { amount: Number(document.getElementById('sepPaymentAmount').value) }); closeModal(); toast('Abono registrado', 'success'); renderSeparatedDetail(id); } catch (err) { toast(err.message, 'error'); }
  });
}

function openFiadoPayment(id) {
  showModal(`
    <h3>Abonar fiado</h3>
    <form id="fiaPaymentForm">
      <div class="field"><label>Valor</label><input id="fiaPaymentAmount" type="number" min="1" step="1" required /></div>
      <button class="btn btn-primary btn-block" type="submit">Registrar abono</button>
    </form>
  `);
  document.getElementById('fiaPaymentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.post('/api/fiados/' + id + '/pagos', { amount: Number(document.getElementById('fiaPaymentAmount').value) }); closeModal(); toast('Abono registrado', 'success'); renderCreditDetail(id); } catch (err) { toast(err.message, 'error'); }
  });
}

function openSeparatedRetiro(id) {
  showModal(`
    <h3>Retirar separado</h3>
    <form id="sepRetiroForm">
      <div class="field"><label>Cantidad a retirar</label><input id="sepRetiroQty" type="number" min="1" step="1" required /></div>
      <button class="btn btn-primary btn-block" type="submit">Retirar</button>
    </form>
  `);
  document.getElementById('sepRetiroForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.post('/api/separados/' + id + '/retiro', { quantity: Number(document.getElementById('sepRetiroQty').value) }); closeModal(); toast('Retiro registrado', 'success'); renderSeparatedDetail(id); } catch (err) { toast(err.message, 'error'); }
  });
}

function openSeparatedCancel(id) {
  showModal(`
    <h3>Anular separado</h3>
    <form id="sepCancelForm">
      <div class="field"><label>Motivo</label><input id="sepCancelReason" required /></div>
      <button class="btn btn-danger btn-block" type="submit">Confirmar anulación</button>
    </form>
  `);
  document.getElementById('sepCancelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.post('/api/separados/' + id + '/anular', { reason: document.getElementById('sepCancelReason').value }); closeModal(); toast('Separado anulado', 'success'); renderSeparatedOrders(); } catch (err) { toast(err.message, 'error'); }
  });
}

function openFiadoCancel(id) {
  showModal(`
    <h3>Anular fiado</h3>
    <form id="fiaCancelForm">
      <div class="field"><label>Motivo</label><input id="fiaCancelReason" required /></div>
      <button class="btn btn-danger btn-block" type="submit">Confirmar anulación</button>
    </form>
  `);
  document.getElementById('fiaCancelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.post('/api/fiados/' + id + '/anular', { reason: document.getElementById('fiaCancelReason').value }); closeModal(); toast('Fiado anulado', 'success'); renderCreditSales(); } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------------- INVENTORY LIST ----------------
async function renderInventory(query) {
  view.innerHTML = `
    ${backLink('dashboard', 'Inicio')}
    <h2 class="section-title">Inventario</h2>
    <div class="searchbar">
      <input id="invSearch" placeholder="Buscar por referencia, nombre o categoría (ej: AJ)" value="${escapeHtml(query || '')}" />
      <button class="btn btn-outline" onclick="navigate('producto-nuevo')">➕ Nuevo</button>
    </div>
    <div id="inventoryTotal" class="card inventory-total loading">Calculando existencias totales…</div>
    <div id="invResults" class="loading">Cargando…</div>
  `;
  const input = document.getElementById('invSearch');
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => loadInventoryResults(input.value), 250);
  });
  input.focus();
  loadInventoryTotal();
  loadInventoryResults(query || '');
}

async function loadInventoryTotal() {
  const container = document.getElementById('inventoryTotal');
  if (!container) return;
  try {
    const summary = await api.get('/api/inventory/summary');
    if (!document.getElementById('inventoryTotal')) return;
    container.className = 'card inventory-total';
    container.innerHTML = `<span class="label">Productos en inventario</span><strong>${summary.totalUnits}</strong><span class="helper-text">Unidades disponibles en total</span>`;
  } catch (err) {
    container.className = 'card inventory-total error-text';
    container.textContent = 'No se pudo cargar el total del inventario.';
  }
}

async function loadInventoryResults(q) {
  const container = document.getElementById('invResults');
  if (!container) return;
  const requestId = ++loadInventoryResults.lastRequestId;
  const products = await api.get('/api/products?q=' + encodeURIComponent(q || ''));
  if (requestId !== loadInventoryResults.lastRequestId || !document.getElementById('invResults')) return;
  if (products.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🔍</div><p>No se encontraron productos.</p></div>`;
    return;
  }
  container.innerHTML = products.map(productCardHtml).join('');
}
loadInventoryResults.lastRequestId = 0;

function productCardHtml(p) {
  const chips = p.variants
    .map((v) => {
      const low = v.quantity <= (p.low_stock_threshold || 3);
      const label = v.size ? v.size : 'Stock';
      return `<span class="size-chip ${low ? 'low' : ''}">${escapeHtml(label)}: ${v.quantity}</span>`;
    })
    .join('');
  return `
    <div class="product-item" onclick="navigate('producto/${p.id}')" style="cursor:pointer">
      <div class="ref">${escapeHtml(p.reference)}</div>
      <div class="name">${escapeHtml(p.name)} ${p.status === 'inactivo' ? '<span class="badge badge-danger">Inactivo</span>' : ''}</div>
      <div class="meta">${escapeHtml(p.category_name || '')} · ${fmtMoney(p.price)}</div>
      <div class="size-chip-row">${chips}</div>
      <div class="total-stock">Total: ${p.total_stock} disponibles</div>
    </div>
  `;
}

// ---------------- PRODUCT DETAIL ----------------
async function renderProductDetail(id) {
  const p = await api.get('/api/products/' + id);
  const movements = await api.get('/api/inventory/movements?variantId=' + (p.variants[0] ? p.variants[0].variant_id : ''));
  view.innerHTML = `
    ${backLink('inventario', 'Inventario')}
    <h2 class="section-title">${escapeHtml(p.name)}</h2>
    <div class="card" style="margin-bottom:18px">
      <div class="ref">${escapeHtml(p.reference)}</div>
      <p class="meta">${escapeHtml(p.category_name)} · ${fmtMoney(p.price)} ${p.status === 'inactivo' ? '<span class="badge badge-danger">Inactivo</span>' : '<span class="badge badge-ok">Activo</span>'}</p>
      ${p.description ? `<p>${escapeHtml(p.description)}</p>` : ''}
      <div class="size-chip-row" style="margin-top:10px">
        ${p.variants.map((v) => `<span class="size-chip ${v.quantity <= p.low_stock_threshold ? 'low' : ''}">${escapeHtml(v.size || 'Stock')}: ${v.quantity}</span>`).join('')}
      </div>
      <p class="total-stock">Total: ${p.total_stock} disponibles</p>
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">
      <button class="btn btn-primary" onclick="openEntryModal(${p.id})">📥 Agregar mercancía</button>
      <button class="btn btn-outline" onclick="openAdjustModal(${p.id})">🛠 Ajustar inventario</button>
      <button class="btn btn-ghost" onclick="openEditProductModal(${p.id})">✏️ Editar producto</button>
      ${CURRENT_USER.role === 'admin' ? `
        <button class="btn btn-outline" onclick='confirmClearStock(${p.id}, ${JSON.stringify(p.reference).replace(/'/g, "&#39;")})'>🗑 Vaciar inventario</button>
        <button class="btn btn-danger" onclick='confirmDeleteProduct(${p.id}, ${JSON.stringify(p.reference).replace(/'/g, "&#39;")})'>Eliminar producto</button>
      ` : ''}
    </div>

    <h3>Movimientos recientes</h3>
    <div id="movList">
      ${movements.length === 0 ? '<p class="helper-text">Sin movimientos aún.</p>' : movements.map(movementRow).join('')}
    </div>
  `;
}

function confirmClearStock(productId, reference) {
  showModal(`
    <h3>¿Vaciar inventario?</h3>
    <p class="helper-text">Se pondrá en cero todo el stock de <strong>${reference}</strong>. El historial se conservará y esta acción no se puede deshacer.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">No, cancelar</button>
      <button class="btn btn-danger" onclick="clearProductStock(${productId})">Sí, vaciar inventario</button>
    </div>
  `);
}

async function clearProductStock(productId) {
  try {
    await api.post(`/api/products/${productId}/clear-stock`);
    closeModal();
    toast('Inventario vaciado', 'success');
    renderProductDetail(productId);
  } catch (err) { toast(err.message, 'error'); }
}

function confirmDeleteProduct(productId, reference) {
  showModal(`
    <h3>¿Eliminar producto?</h3>
    <p class="helper-text">Se eliminará <strong>${reference}</strong> junto con sus variantes, inventario y movimientos de prueba. Esta acción no se puede deshacer. Solo se bloquea si el producto ya tiene ventas.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">No, conservar</button>
      <button class="btn btn-danger" onclick="deleteProduct(${productId})">Sí, eliminar</button>
    </div>
  `);
}

async function deleteProduct(productId) {
  try {
    await api.request('DELETE', `/api/products/${productId}`);
    closeModal();
    toast('Producto eliminado', 'success');
    navigate('inventario');
  } catch (err) { toast(err.message, 'error'); }
}

function movementRow(m) {
  const icons = { entrada: '📥', venta: '🛒', devolucion: '↩️', ajuste: '🛠' };
  const sign = m.quantity_change > 0 ? '+' : '';
  return `
    <div class="movement-item">
      <div>${icons[m.type] || ''} <strong>${capitalize(m.type)}</strong> ${m.size ? '· talla ' + escapeHtml(m.size) : ''}</div>
      <div class="meta">${sign}${m.quantity_change} → quedaron ${m.resulting_quantity} · ${escapeHtml(m.reason || '')}</div>
      <div class="meta">${new Date(m.created_at).toLocaleString('es-CO')}</div>
    </div>
  `;
}
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function paymentMethodLabel(method) {
  return ({ efectivo: 'Efectivo', transferencia: 'Transferencia', addi: 'Addi' }[method] || 'No especificado');
}
function paymentDestinationLabel(destination) {
  return ({ nequi: 'Nequi', qr: 'QR', daviplata: 'Daviplata' }[destination] || '');
}
function paymentLabel(method, destination) {
  const label = paymentMethodLabel(method);
  return method === 'transferencia' && destination ? `${label} · ${paymentDestinationLabel(destination)}` : label;
}

function openEntryModal(productId) {
  api.get('/api/products/' + productId).then((p) => {
    showModal(`
      <h3>Agregar mercancía</h3>
      <p class="helper-text">${escapeHtml(p.reference)} — ${escapeHtml(p.name)}</p>
      <form id="entryForm">
        <div class="field">
          <label>Variante</label>
          <select id="entryVariant" onchange="toggleNewEntrySize()">
            ${p.variants.map((v) => `<option value="${v.variant_id}">${escapeHtml(v.size || 'Único')} (actual: ${v.quantity})</option>`).join('')}
            ${p.has_variants ? '<option value="new">+ Nueva talla</option>' : ''}
          </select>
        </div>
        ${p.has_variants ? `
          <div class="field" id="newEntrySizeField" style="display:none">
            <label>Nueva talla</label>
            <input id="entryNewSize" placeholder="Ej: 35" />
          </div>
        ` : ''}
        <div class="field">
          <label>Cantidad recibida</label>
          <input id="entryQty" type="number" min="1" required />
        </div>
        <button class="btn btn-primary btn-block" type="submit">Registrar entrada</button>
      </form>
    `);
    document.getElementById('entryForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const selectedVariant = document.getElementById('entryVariant').value;
        await api.post('/api/inventory/entry', {
          variantId: selectedVariant === 'new' ? null : Number(selectedVariant),
          productId: selectedVariant === 'new' ? productId : null,
          newSize: selectedVariant === 'new' ? document.getElementById('entryNewSize').value.trim() : null,
          quantity: Number(document.getElementById('entryQty').value),
          reason: 'Entrada de mercancía',
        });
        closeModal();
        toast('Mercancía agregada correctamente', 'success');
        renderProductDetail(productId);
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

function toggleNewEntrySize() {
  const variant = document.getElementById('entryVariant');
  const field = document.getElementById('newEntrySizeField');
  if (variant && field) field.style.display = variant.value === 'new' ? 'block' : 'none';
}

function openAdjustModal(productId) {
  api.get('/api/products/' + productId).then((p) => {
    showModal(`
      <h3>Ajustar inventario</h3>
      <p class="helper-text">Usa esto para corregir diferencias tras un conteo físico.</p>
      <form id="adjustForm">
        <div class="field">
          <label>Variante</label>
          <select id="adjustVariant">
            ${p.variants.map((v) => `<option value="${v.variant_id}" data-current="${v.quantity}">${escapeHtml(v.size || 'Único')} (actual: ${v.quantity})</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Cantidad real (conteo físico)</label>
          <input id="adjustQty" type="number" min="0" required />
        </div>
        <div class="field">
          <label>Motivo</label>
          <input id="adjustReason" placeholder="Ej: Conteo físico" value="Conteo físico" />
        </div>
        <button class="btn btn-primary btn-block" type="submit">Guardar ajuste</button>
      </form>
    `);
    document.getElementById('adjustForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api.post('/api/inventory/adjust', {
          variantId: Number(document.getElementById('adjustVariant').value),
          newQuantity: Number(document.getElementById('adjustQty').value),
          reason: document.getElementById('adjustReason').value,
        });
        closeModal();
        toast('Inventario ajustado', 'success');
        renderProductDetail(productId);
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

function openEditProductModal(productId) {
  api.get('/api/products/' + productId).then((p) => {
    showModal(`
      <h3>Editar producto</h3>
      <form id="editForm">
        <div class="field"><label>Nombre</label><input id="editName" value="${escapeHtml(p.name)}" required /></div>
        <div class="field"><label>Categoría</label>
          <select id="editCategory">${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === p.category_id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Precio</label><input id="editPrice" type="number" min="0" step="1" value="${p.price}" required /></div>
        <div class="field"><label>Descripción</label><textarea id="editDesc" rows="3">${escapeHtml(p.description || '')}</textarea></div>
        <div class="field"><label>Estado</label>
          <select id="editStatus">
            <option value="activo" ${p.status === 'activo' ? 'selected' : ''}>Activo</option>
            <option value="inactivo" ${p.status === 'inactivo' ? 'selected' : ''}>Inactivo</option>
          </select>
        </div>
        <button class="btn btn-primary btn-block" type="submit">Guardar cambios</button>
      </form>
    `);
    document.getElementById('editForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api.put('/api/products/' + productId, {
          name: document.getElementById('editName').value,
          categoryId: Number(document.getElementById('editCategory').value),
          price: Number(document.getElementById('editPrice').value),
          description: document.getElementById('editDesc').value,
          status: document.getElementById('editStatus').value,
        });
        closeModal();
        toast('Producto actualizado', 'success');
        renderProductDetail(productId);
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// ---------------- MODAL ----------------
function showModal(innerHtml) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modalOverlay';
  overlay.innerHTML = `<div class="modal-sheet">${innerHtml}<button class="btn btn-ghost btn-block" onclick="closeModal()" style="margin-top:8px">Cancelar</button></div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.body.appendChild(overlay);
}
function closeModal() {
  const el = document.getElementById('modalOverlay');
  if (el) el.remove();
}

// ---------------- NEW PRODUCT ----------------
let sizeRowCount = 0;

async function renderProductForm() {
  CATEGORIES = await api.get('/api/categories');
  view.innerHTML = `
    ${backLink('inventario', 'Inventario')}
    <h2 class="section-title">Nuevo producto</h2>
    <form id="productForm" class="card">
      <div class="field">
        <label>Referencia única</label>
        <input id="pReference" placeholder="Ej: AJ-45" required />
      </div>
      <div class="field">
        <label>Nombre del producto</label>
        <input id="pName" placeholder="Ej: Sandalia cuero café" required />
      </div>
      <div class="field">
        <label>Categoría</label>
        <div style="display:flex;gap:8px">
          <select id="pCategory" style="flex:1">
            ${CATEGORIES.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-outline" onclick="promptNewCategory()">➕ Categoría</button>
        </div>
      </div>
      <div class="field">
        <label>Precio de venta</label>
        <input id="pPrice" type="number" min="0" step="1" placeholder="Ej: 150000" required />
      </div>
      <div class="field">
        <label>Descripción (opcional)</label>
        <textarea id="pDescription" rows="2"></textarea>
      </div>

      <div class="field">
        <label>
          <input type="checkbox" id="pHasVariants" style="width:auto;display:inline-block" onchange="toggleVariantMode()" />
          Este producto tiene tallas
        </label>
      </div>

      <div id="noVariantBlock" class="field">
        <label>Stock inicial</label>
        <input id="pInitialStock" type="number" min="0" step="1" value="0" />
      </div>

      <div id="variantBlock" style="display:none">
        <label>Tallas y cantidades</label>
        <div id="sizeRows"></div>
        <button type="button" class="btn btn-ghost" onclick="addSizeRow()">➕ Agregar talla</button>
      </div>

      <button class="btn btn-primary btn-block btn-lg" type="submit" style="margin-top:20px">Guardar producto</button>
    </form>
  `;
  document.getElementById('productForm').addEventListener('submit', submitNewProduct);
}

function toggleVariantMode() {
  const has = document.getElementById('pHasVariants').checked;
  document.getElementById('variantBlock').style.display = has ? 'block' : 'none';
  document.getElementById('noVariantBlock').style.display = has ? 'none' : 'block';
  if (has && document.getElementById('sizeRows').children.length === 0) {
    addSizeRow(); addSizeRow(); addSizeRow();
  }
}

function addSizeRow() {
  sizeRowCount++;
  const div = document.createElement('div');
  div.className = 'size-input-row';
  div.innerHTML = `
    <input class="size-name" placeholder="Talla (ej: 36)" />
    <input class="size-qty" type="number" min="0" placeholder="Cant." value="0" />
    <button type="button" class="remove-row-btn" onclick="this.parentElement.remove()">✕</button>
  `;
  document.getElementById('sizeRows').appendChild(div);
}

function promptNewCategory() {
  showModal(`
    <h3>Nueva categoría</h3>
    <form id="catForm">
      <div class="field"><label>Nombre</label><input id="catName" required /></div>
      <button class="btn btn-primary btn-block" type="submit">Crear</button>
    </form>
  `);
  document.getElementById('catForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const cat = await api.post('/api/categories', { name: document.getElementById('catName').value });
      CATEGORIES.push(cat);
      const select = document.getElementById('pCategory');
      const opt = document.createElement('option');
      opt.value = cat.id; opt.textContent = cat.name; opt.selected = true;
      select.appendChild(opt);
      closeModal();
      toast('Categoría creada', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function submitNewProduct(e) {
  e.preventDefault();
  const form = e.currentTarget;
  if (form.dataset.submitting === 'true') return;
  const hasVariants = document.getElementById('pHasVariants').checked;
  const payload = {
    reference: document.getElementById('pReference').value.trim(),
    name: document.getElementById('pName').value.trim(),
    categoryId: Number(document.getElementById('pCategory').value),
    price: Number(document.getElementById('pPrice').value),
    description: document.getElementById('pDescription').value,
    hasVariants,
  };
  if (hasVariants) {
    const rows = Array.from(document.querySelectorAll('#sizeRows .size-input-row'));
    payload.sizes = rows
      .map((r) => ({ size: r.querySelector('.size-name').value.trim(), quantity: r.querySelector('.size-qty').value }))
      .filter((s) => s.size);
    if (payload.sizes.length === 0) return toast('Agrega al menos una talla', 'error');
  } else {
    payload.initialStock = Number(document.getElementById('pInitialStock').value);
  }
  form.dataset.submitting = 'true';
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = 'Guardando...';
  try {
    const product = await api.post('/api/products', payload);
    toast('Producto creado correctamente', 'success');
    navigate('producto/' + product.id);
  } catch (err) { toast(err.message, 'error'); }
  finally {
    form.dataset.submitting = 'false';
    submitButton.disabled = false;
    submitButton.textContent = 'Guardar producto';
  }
}

// ---------------- SALE (POS) ----------------
let CART = [];

async function renderSale() {
  CART = [];
  view.innerHTML = `
    ${backLink('dashboard', 'Inicio')}
    <h2 class="section-title">Registrar venta</h2>
    <div class="searchbar">
      <input id="saleSearch" placeholder="Buscar referencia o nombre" autofocus />
    </div>
    <div id="saleResults"></div>
    <div id="cartSection" style="margin-top:24px"></div>
  `;
  const input = document.getElementById('saleSearch');
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => loadSaleSearchResults(input.value), 250);
  });
  renderCart();
}

function togglePaymentDestination() {
  const method = document.getElementById('paymentMethod');
  const field = document.getElementById('paymentDestinationField');
  if (method && field) field.style.display = method.value === 'transferencia' ? 'block' : 'none';
}

async function loadSaleSearchResults(q) {
  const container = document.getElementById('saleResults');
  if (!q || !q.trim()) { container.innerHTML = ''; return; }
  const products = await api.get('/api/products?q=' + encodeURIComponent(q));
  const active = products.filter((p) => p.status === 'activo');
  if (active.length === 0) {
    container.innerHTML = `<p class="helper-text">No se encontraron productos.</p>`;
    return;
  }
  container.innerHTML = active.map((p) => `
    <div class="product-item">
      <div class="ref">${escapeHtml(p.reference)}</div>
      <div class="name">${escapeHtml(p.name)}</div>
      <div class="meta">${fmtMoney(p.price)}</div>
      <div class="size-chip-row">
        ${p.variants.map((v) => `
          <button type="button" class="btn btn-outline" style="padding:8px 14px;font-size:14px"
            onclick='addToCart(${JSON.stringify({ variantId: v.variant_id, size: v.size, reference: p.reference, name: p.name, price: p.price, available: v.quantity }).replace(/'/g, "&#39;")})'
            ${v.quantity <= 0 ? 'disabled' : ''}>
            ${escapeHtml(v.size || 'Agregar')} ${v.size ? '(' + v.quantity + ')' : (v.quantity <= 0 ? '(Sin stock)' : '')}
          </button>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function addToCart(item) {
  const existing = CART.find((c) => c.variantId === item.variantId);
  if (existing) {
    if (existing.quantity + 1 > item.available) return toast(`No hay suficientes unidades. Disponible: ${item.available}`, 'error');
    existing.quantity += 1;
  } else {
    if (item.available <= 0) return toast('No hay stock disponible', 'error');
    CART.push({ ...item, quantity: 1 });
  }
  renderCart();
  toast(`${item.name} agregado`, 'success');
}

function changeCartQty(variantId, delta) {
  const item = CART.find((c) => c.variantId === variantId);
  if (!item) return;
  const newQty = item.quantity + delta;
  if (newQty <= 0) { CART = CART.filter((c) => c.variantId !== variantId); }
  else if (newQty > item.available) { return toast(`No hay suficientes unidades. Disponible: ${item.available}`, 'error'); }
  else { item.quantity = newQty; }
  renderCart();
}

function renderCart() {
  const section = document.getElementById('cartSection');
  if (!section) return;
  if (CART.length === 0) {
    section.innerHTML = `<div class="empty-state"><div class="icon">🛒</div><p>El carrito está vacío. Busca un producto arriba para agregarlo.</p></div>`;
    return;
  }
  const total = CART.reduce((s, c) => s + c.price * c.quantity, 0);
  section.innerHTML = `
    <h3>Carrito</h3>
    ${CART.map((c) => `
      <div class="product-item">
        <div class="ref">${escapeHtml(c.reference)}</div>
        <div class="name">${escapeHtml(c.name)} ${c.size ? '· talla ' + escapeHtml(c.size) : ''}</div>
        <div class="meta">${fmtMoney(c.price)} c/u</div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
          <div class="qty-control">
            <button type="button" onclick="changeCartQty(${c.variantId}, -1)">−</button>
            <span>${c.quantity}</span>
            <button type="button" onclick="changeCartQty(${c.variantId}, 1)">+</button>
          </div>
          <strong>${fmtMoney(c.price * c.quantity)}</strong>
        </div>
      </div>
    `).join('')}
    <div class="payment-panel">
      <div class="field">
        <label for="paymentMethod">¿Cómo pagó el cliente?</label>
        <select id="paymentMethod" onchange="togglePaymentDestination()">
          <option value="efectivo">Efectivo</option>
          <option value="transferencia">Transferencia</option>
          <option value="addi">Addi</option>
        </select>
      </div>
      <div id="paymentDestinationField" class="field" style="display:none">
        <label for="paymentDestination">¿A dónde llegó?</label>
        <select id="paymentDestination">
          <option value="nequi">Nequi</option>
          <option value="qr">QR</option>
          <option value="daviplata">Daviplata</option>
        </select>
      </div>
    </div>
    <div class="cart-bar">
      <div>
        <div class="total-label">Total</div>
        <div class="total-value">${fmtMoney(total)}</div>
      </div>
      <button class="btn btn-primary btn-lg" onclick="confirmSale()">Confirmar venta</button>
    </div>
  `;
}

async function confirmSale() {
  if (CART.length === 0) return;
  const items = CART.map((c) => ({ variantId: c.variantId, quantity: c.quantity }));
  const paymentMethod = document.getElementById('paymentMethod').value;
  const paymentDestination = paymentMethod === 'transferencia'
    ? document.getElementById('paymentDestination').value
    : null;
  try {
    const result = await api.post('/api/sales', { items, paymentMethod, paymentDestination });
    toast(`Venta ${result.saleNumber} registrada correctamente`, 'success');
    CART = [];
    navigate('venta-detalle/' + result.saleId);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------- HISTORY ----------------
async function renderHistory() {
  const sales = await api.get('/api/sales');
  view.innerHTML = `
    ${backLink('dashboard', 'Inicio')}
    <h2 class="section-title">Historial de ventas</h2>
    ${sales.length === 0 ? `<div class="empty-state"><div class="icon">📋</div><p>Aún no hay ventas registradas.</p></div>` :
      sales.map((s) => `
        <div class="sale-item" style="cursor:pointer" onclick="navigate('venta-detalle/${s.id}')">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${escapeHtml(s.sale_number)}</strong>
            <span class="badge ${s.status === 'anulada' ? 'badge-danger' : 'badge-ok'}">${s.status === 'anulada' ? 'Anulada' : 'Completada'}</span>
          </div>
          <div class="meta">${new Date(s.created_at).toLocaleString('es-CO')} · ${escapeHtml(s.user_name)} · ${paymentLabel(s.payment_method, s.payment_destination)}</div>
          <div class="total-stock">${fmtMoney(s.total)}</div>
        </div>
      `).join('')}
  `;
}

async function renderSaleDetail(id) {
  const sale = await api.get('/api/sales/' + id);
  view.innerHTML = `
    ${backLink('historial', 'Historial')}
    <h2 class="section-title">${escapeHtml(sale.sale_number)}</h2>
    <div class="card" style="margin-bottom:18px">
      <p class="meta">${new Date(sale.created_at).toLocaleString('es-CO')} · Vendido por ${escapeHtml(sale.user_name)} · Pago: ${paymentLabel(sale.payment_method, sale.payment_destination)}</p>
      <span class="badge ${sale.status === 'anulada' ? 'badge-danger' : 'badge-ok'}">${sale.status === 'anulada' ? 'Anulada' : 'Completada'}</span>
      ${sale.status === 'anulada' ? `<p class="meta">Motivo: ${escapeHtml(sale.void_reason || '—')}</p>` : ''}
    </div>
    <h3>Productos</h3>
    ${sale.items.map((it) => `
      <div class="product-item">
        <div class="ref">${escapeHtml(it.product_reference)}</div>
        <div class="name">${escapeHtml(it.product_name)} ${it.size ? '· talla ' + escapeHtml(it.size) : ''}</div>
        <div class="meta">${it.quantity} × ${fmtMoney(it.unit_price)} = ${fmtMoney(it.subtotal)}</div>
      </div>
    `).join('')}
    <div class="card" style="margin-top:18px;text-align:right">
      <span class="total-stock" style="font-size:20px">Total: ${fmtMoney(sale.total)}</span>
    </div>
    ${sale.status === 'completada' ? `
      <button class="btn btn-danger btn-block" style="margin-top:20px" onclick="promptVoidSale(${sale.id})">Anular venta</button>
    ` : ''}
  `;
}

function promptVoidSale(saleId) {
  showModal(`
    <h3>Anular venta</h3>
    <p class="helper-text">Esto devolverá los productos al inventario. Esta acción no se puede deshacer.</p>
    <form id="voidForm">
      <div class="field"><label>Motivo</label><input id="voidReason" placeholder="Ej: Cliente se arrepintió" required /></div>
      <button class="btn btn-danger btn-block" type="submit">Confirmar anulación</button>
    </form>
  `);
  document.getElementById('voidForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post(`/api/sales/${saleId}/void`, { reason: document.getElementById('voidReason').value });
      closeModal();
      toast('Venta anulada, inventario restaurado', 'success');
      renderSaleDetail(saleId);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------------- SETTINGS ----------------
async function renderSettings() {
  let usersHtml = '';
  if (CURRENT_USER.role === 'admin') {
    const users = await api.get('/api/users');
    usersHtml = `
      <h3>Usuarios</h3>
      ${users.map((u) => `
        <div class="product-item">
          <div class="name">${escapeHtml(u.full_name)} <span class="badge badge-gold">${u.role}</span> ${u.active ? '' : '<span class="badge badge-danger">Inactivo</span>'}</div>
          <div class="meta">@${escapeHtml(u.username)}</div>
          ${u.id !== CURRENT_USER.userId ? `<button class="btn btn-ghost" onclick="toggleUserActive(${u.id}, ${u.active ? 0 : 1})">${u.active ? 'Desactivar' : 'Activar'}</button>` : ''}
        </div>
      `).join('')}
      <button class="btn btn-outline" onclick="promptNewUser()">➕ Nuevo usuario</button>
    `;
  }
  view.innerHTML = `
    ${backLink('dashboard', 'Inicio')}
    <h2 class="section-title">Configuración</h2>
    <div class="card" style="margin-bottom:20px">
      <p><strong>${escapeHtml(CURRENT_USER.fullName)}</strong></p>
      <p class="meta">Usuario: @${escapeHtml(CURRENT_USER.username)} · Rol: ${CURRENT_USER.role}</p>
    </div>
    ${CURRENT_USER.role === 'admin' ? `
      <div class="card danger-zone" style="margin-bottom:20px">
        <h3>Restablecer datos de prueba</h3>
        <p class="helper-text">Borra productos, inventario, ventas, movimientos y categorías actuales. Conserva los usuarios para que puedas volver a entrar y restaura las categorías iniciales.</p>
        <button class="btn btn-danger" onclick="confirmFactoryReset()">🗑 Dejar datos como de fábrica</button>
      </div>
    ` : ''}
    ${usersHtml}
  `;
}

function confirmFactoryReset() {
  showModal(`
    <h3>¿Borrar todos los datos de prueba?</h3>
    <p class="helper-text">Esta acción eliminará definitivamente todos los productos, existencias, ventas y movimientos. No borra los usuarios administradores.</p>
    <form id="factoryResetForm">
      <div class="field">
        <label for="resetConfirmation">Escribe REINICIAR para continuar</label>
        <input id="resetConfirmation" autocomplete="off" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">No, cancelar</button>
        <button class="btn btn-danger" type="submit">Sí, borrar todo</button>
      </div>
    </form>
  `);
  document.getElementById('factoryResetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (document.getElementById('resetConfirmation').value.trim() !== 'REINICIAR') {
      return toast('Escribe REINICIAR exactamente para confirmar', 'error');
    }
    try {
      await api.post('/api/admin/reset-data');
      closeModal();
      CATEGORIES = await api.get('/api/categories');
      toast('Los datos fueron restablecidos', 'success');
      renderSettings();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function promptNewUser() {
  showModal(`
    <h3>Nuevo usuario</h3>
    <form id="newUserForm">
      <div class="field"><label>Nombre completo</label><input id="nuFullName" required /></div>
      <div class="field"><label>Usuario</label><input id="nuUsername" required /></div>
      <div class="field"><label>Contraseña</label><input id="nuPassword" type="password" required /></div>
      <div class="field"><label>Rol</label>
        <select id="nuRole"><option value="vendedor">Vendedor</option><option value="admin">Administrador</option></select>
      </div>
      <button class="btn btn-primary btn-block" type="submit">Crear usuario</button>
    </form>
  `);
  document.getElementById('newUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/users', {
        fullName: document.getElementById('nuFullName').value,
        username: document.getElementById('nuUsername').value,
        password: document.getElementById('nuPassword').value,
        role: document.getElementById('nuRole').value,
      });
      closeModal();
      toast('Usuario creado', 'success');
      renderSettings();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function toggleUserActive(id, active) {
  try {
    await api.patch(`/api/users/${id}`, { active: !!active });
    toast('Usuario actualizado', 'success');
    renderSettings();
  } catch (err) { toast(err.message, 'error'); }
}

init();

// ---------------- REPORTS ----------------
let reportRange = { from: null, to: null, preset: '30d' };

function computePresetRange(preset) {
  const today = new Date();
  const toStr = (d) => d.toISOString().slice(0, 10);
  if (preset === 'today') return { from: toStr(today), to: toStr(today) };
  if (preset === '7d') { const f = new Date(today); f.setDate(f.getDate() - 6); return { from: toStr(f), to: toStr(today) }; }
  if (preset === 'month') { const f = new Date(today.getFullYear(), today.getMonth(), 1); return { from: toStr(f), to: toStr(today) }; }
  const f = new Date(today); f.setDate(f.getDate() - 29); return { from: toStr(f), to: toStr(today) };
}

async function renderReports() {
  if (!reportRange.from) Object.assign(reportRange, computePresetRange('30d'));
  view.innerHTML = `
    ${backLink('dashboard', 'Inicio')}
    <h2 class="section-title">Informes y reportes</h2>
    <div class="tab-row">
      <button class="tab-btn ${reportRange.preset === 'today' ? 'active' : ''}" onclick="setReportPreset('today')">Hoy</button>
      <button class="tab-btn ${reportRange.preset === '7d' ? 'active' : ''}" onclick="setReportPreset('7d')">Últimos 7 días</button>
      <button class="tab-btn ${reportRange.preset === '30d' ? 'active' : ''}" onclick="setReportPreset('30d')">Últimos 30 días</button>
      <button class="tab-btn ${reportRange.preset === 'month' ? 'active' : ''}" onclick="setReportPreset('month')">Este mes</button>
    </div>
    <div id="reportBody" class="loading">Cargando…</div>
  `;
  loadReportBody();
}

function setReportPreset(preset) {
  reportRange = { ...computePresetRange(preset), preset };
  renderReports();
}

async function loadReportBody() {
  const { from, to } = reportRange;
  const qs = `?from=${from}&to=${to}`;
  const [overview, timeline, topProducts, byCategory, paymentSummary, movements] = await Promise.all([
    api.get('/api/reports/overview' + qs),
    api.get('/api/reports/sales-timeline' + qs + '&groupBy=day'),
    api.get('/api/reports/top-products' + qs + '&limit=8'),
    api.get('/api/reports/by-category' + qs),
    api.get('/api/reports/payment-summary' + qs),
    api.get('/api/reports/movements' + qs),
  ]);

  const container = document.getElementById('reportBody');
  container.innerHTML = `
    <div class="stat-grid">
      <div class="card stat-card"><div class="label">Ingresos</div><div class="value">${fmtMoney(overview.revenue)}</div></div>
      <div class="card stat-card"><div class="label">Ventas</div><div class="value">${overview.saleCount}</div></div>
      <div class="card stat-card"><div class="label">Productos vendidos</div><div class="value">${overview.itemsSold}</div></div>
      <div class="card stat-card"><div class="label">Ticket promedio</div><div class="value">${fmtMoney(overview.avgTicket)}</div></div>
      <div class="card stat-card ${overview.voidedCount > 0 ? 'alert' : ''}"><div class="label">Ventas anuladas</div><div class="value">${overview.voidedCount}</div></div>
      <div class="card stat-card"><div class="label">Valor del inventario</div><div class="value">${fmtMoney(overview.inventoryValue)}</div></div>
    </div>

    <h3>¿Cómo entró el dinero?</h3>
    <div class="card" style="margin-bottom:24px">
      ${paymentSummary.length === 0 ? '<p class="helper-text">Sin ventas en este período.</p>' : paymentSummary.map((p, i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;${i > 0 ? 'border-top:1px solid var(--line)' : ''}">
          <div>
            <div style="font-weight:700">${escapeHtml(paymentLabel(p.method, p.destination))}</div>
            <div class="meta">${p.saleCount} ${p.saleCount === 1 ? 'venta' : 'ventas'}</div>
          </div>
          <div style="font-weight:700">${fmtMoney(p.total)}</div>
        </div>
      `).join('')}
    </div>

    <h3>Ventas por día</h3>
    <div class="card" style="margin-bottom:24px">
      ${timeline.length === 0 ? '<p class="helper-text">No hay ventas en este período.</p>' : barChartSvg(timeline)}
    </div>

    <h3>Productos más vendidos</h3>
    <div class="card" style="margin-bottom:24px">
      ${topProducts.length === 0 ? '<p class="helper-text">Sin datos en este período.</p>' : topProducts.map((p, i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;${i > 0 ? 'border-top:1px solid var(--line)' : ''}">
          <div>
            <div style="font-weight:700">${escapeHtml(p.name)}</div>
            <div class="meta">${escapeHtml(p.reference)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:700">${p.unitsSold} und.</div>
            <div class="meta">${fmtMoney(p.revenue)}</div>
          </div>
        </div>
      `).join('')}
    </div>

    <h3>Ventas por categoría</h3>
    <div class="card" style="margin-bottom:24px">
      ${byCategory.length === 0 ? '<p class="helper-text">Sin datos en este período.</p>' : byCategory.map((c, i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;${i > 0 ? 'border-top:1px solid var(--line)' : ''}">
          <div style="font-weight:700">${escapeHtml(c.category)}</div>
          <div style="text-align:right">
            <div style="font-weight:700">${fmtMoney(c.revenue)}</div>
            <div class="meta">${c.unitsSold} unidades</div>
          </div>
        </div>
      `).join('')}
    </div>

    <h3>Movimientos de inventario</h3>
    <div class="card">
      ${movements.length === 0 ? '<p class="helper-text">Sin movimientos en este período.</p>' : movements.map((m) => `
        <div class="size-chip" style="margin:4px">${capitalize(m.type)}: ${m.movementCount} (${m.netChange > 0 ? '+' : ''}${m.netChange} unidades)</div>
      `).join('')}
    </div>
  `;
}

function barChartSvg(timeline) {
  const width = 320, height = 140, padding = 24;
  const max = Math.max(...timeline.map((t) => t.total), 1);
  const barWidth = (width - padding) / timeline.length;
  const bars = timeline.map((t, i) => {
    const barHeight = (t.total / max) * (height - padding - 10);
    const x = padding + i * barWidth;
    const y = height - padding - barHeight;
    const label = new Date(t.period).toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit' });
    return `
      <rect x="${x + 2}" y="${y}" width="${Math.max(barWidth - 4, 2)}" height="${barHeight}" fill="#6d1f3f" rx="3"></rect>
      <text x="${x + barWidth / 2}" y="${height - 6}" font-size="9" text-anchor="middle" fill="#6b5a62">${label}</text>
    `;
  }).join('');
  return `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto" xmlns="http://www.w3.org/2000/svg">
      <line x1="${padding}" y1="${height - padding}" x2="${width}" y2="${height - padding}" stroke="#ead9df" />
      ${bars}
    </svg>
  `;
}
