let CURRENT_USER = null;
let CATEGORIES = [];
const view = document.getElementById('view');
let navigationToken = 0;
let liveRefreshTimer = null;
let liveRefreshPending = false;

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
  startLiveUpdates();
  router();
}

function startLiveUpdates() {
  const events = new EventSource('/api/events');
  events.addEventListener('change', scheduleLiveRefresh);
  window.addEventListener('focusout', () => {
    if (liveRefreshPending) scheduleLiveRefresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleLiveRefresh();
  });
  window.setInterval(scheduleLiveRefresh, 5000);
}

function scheduleLiveRefresh() {
  if (document.hidden || document.getElementById('modalOverlay')) {
    liveRefreshPending = true;
    return;
  }
  const active = document.activeElement;
  const liveSearchInput = active?.id === 'invSearch' || active?.id === 'saleSearch';
  if (active && view.contains(active) && active.matches('input, textarea, select') && !liveSearchInput) {
    liveRefreshPending = true;
    return;
  }
  liveRefreshPending = false;
  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(refreshCurrentView, 250);
}

async function refreshCurrentView() {
  const { route, params } = parseHash();
  try {
    if (route === 'dashboard' || !route) return await renderDashboard();
    if (route === 'inventario') {
      const query = document.getElementById('invSearch')?.value || '';
      await Promise.all([loadInventoryTotal(), loadInventoryResults(query)]);
      return;
    }
    if (route === 'producto' && params[0]) return await renderProductDetail(params[0]);
    if (route === 'producto-nuevo') {
      const categorySelect = document.getElementById('pCategory');
      const selectedCategory = categorySelect?.value;
      CATEGORIES = await api.get('/api/categories');
      if (categorySelect) {
        categorySelect.innerHTML = CATEGORIES.map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join('');
        if (CATEGORIES.some((category) => String(category.id) === selectedCategory)) categorySelect.value = selectedCategory;
      }
      return;
    }
    if (route === 'venta') {
      const query = document.getElementById('saleSearch')?.value || '';
      return await loadSaleSearchResults(query);
    }
    if (route === 'historial') return await renderHistory();
    if (route === 'venta-detalle' && params[0]) return await renderSaleDetail(params[0]);
    if (route === 'separados') return await renderSeparatedOrders(document.getElementById('separatedSearch')?.value || '');
    if (route === 'separado-detalle' && params[0]) return await renderSeparatedDetail(params[0]);
    if (route === 'fiados') return await renderCreditSales(document.getElementById('fiadoSearch')?.value || '');
    if (route === 'fiado-detalle' && params[0]) return await renderCreditDetail(params[0]);
    if (route === 'informes') return await renderReports();
    if (route === 'configuracion') return await renderSettings();
  } catch (error) {
    toast('No se pudieron actualizar los datos. Se volverá a intentar.', 'error');
  }
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
  const renderToken = navigationToken;
  const data = await api.get('/api/dashboard');
  if (renderToken !== navigationToken) return;
  const todayLabel = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date());
  const todayCompactLabel = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', day: 'numeric', month: 'short', year: 'numeric',
  }).format(new Date());
  view.innerHTML = `
    <div class="dashboard-heading">
      <div>
        <p class="eyebrow">MARCE BRILLO Y ESTILO <span>·</span> RESUMEN DIARIO</p>
        <h1 class="hello">Hola, Marce</h1>
      </div>
      <div class="dashboard-date">
        <span class="eyebrow">HOY EN TIENDA</span>
        <time><span class="dashboard-date-wide">${escapeHtml(todayLabel)}</span><span class="dashboard-date-compact">${escapeHtml(todayCompactLabel)}</span></time>
      </div>
    </div>
    <section class="dashboard-section" aria-labelledby="dailyMetricsTitle">
      <div class="dashboard-section-heading">
        <div><span class="eyebrow">01 <span>·</span> ACTIVIDAD</span><h2 id="dailyMetricsTitle">La jornada</h2></div>
        <button class="btn btn-primary dashboard-sale-action" onclick="navigate('venta')"><span aria-hidden="true">＋</span> Nueva venta</button>
      </div>
      <div class="stat-grid">
        <div class="card stat-card stat-card-featured">
          <div class="label">Ingresos de hoy</div>
          <div class="value">${fmtMoney(data.incomeToday ?? data.salesToday)}</div>
        </div>
        <div class="card stat-card">
          <div class="label">Productos vendidos</div>
          <div class="value">${data.itemsSoldToday}</div>
        </div>
        <div class="card stat-card">
          <div class="label">Unidades fiadas</div>
          <div class="value">${data.creditUnitsToday || 0}</div>
          <div class="stat-detail">${data.creditAccountsToday || 0} ${Number(data.creditAccountsToday) === 1 ? 'cuenta' : 'cuentas'}</div>
        </div>
        <div class="card stat-card">
          <div class="label">Unidades separadas</div>
          <div class="value">${data.separatedUnitsToday || 0}</div>
          <div class="stat-detail">${data.separatedAccountsToday || 0} ${Number(data.separatedAccountsToday) === 1 ? 'cuenta' : 'cuentas'}</div>
        </div>
        <div class="card stat-card ${data.lowStockCount > 0 ? 'alert' : ''}">
          <div class="label">Poco stock</div>
          <div class="value">${data.lowStockCount}</div>
        </div>
        <div class="card stat-card ${data.expiredSeparatedCount > 0 ? 'alert' : ''}">
          <div class="label">Separados vencidos</div>
          <div class="value">${data.expiredSeparatedCount || 0}</div>
        </div>
        <div class="card stat-card">
          <div class="label">Unidades disponibles</div>
          <div class="value">${data.availableInventoryUnits}</div>
        </div>
        <div class="card stat-card">
          <div class="label">Unidades físicas</div>
          <div class="value">${data.inventoryUnits}</div>
        </div>
      </div>
    </section>
    <section class="dashboard-section" aria-labelledby="storeModulesTitle">
      <div class="dashboard-section-heading">
        <div><span class="eyebrow">02 <span>·</span> PUNTO DE VENTA</span><h2 id="storeModulesTitle">Espacios de trabajo</h2></div>
      </div>
      <div class="nav-grid">
        <button class="nav-tile" onclick="navigate('inventario')"><span class="nav-index">01</span><span class="nav-label">Inventario</span><span class="nav-arrow" aria-hidden="true">↗</span></button>
        <button class="nav-tile" onclick="navigate('separados')"><span class="nav-index">02</span><span class="nav-label">Separados</span><span class="nav-arrow" aria-hidden="true">↗</span></button>
        <button class="nav-tile" onclick="navigate('fiados')"><span class="nav-index">03</span><span class="nav-label">Fiados</span><span class="nav-arrow" aria-hidden="true">↗</span></button>
        <button class="nav-tile" onclick="navigate('producto-nuevo')"><span class="nav-index">04</span><span class="nav-label">Nuevo producto</span><span class="nav-arrow" aria-hidden="true">↗</span></button>
        <button class="nav-tile" onclick="navigate('historial')"><span class="nav-index">05</span><span class="nav-label">Ventas</span><span class="nav-arrow" aria-hidden="true">↗</span></button>
        <button class="nav-tile" onclick="navigate('informes')"><span class="nav-index">06</span><span class="nav-label">Informes</span><span class="nav-arrow" aria-hidden="true">↗</span></button>
        <button class="nav-tile" onclick="navigate('configuracion')"><span class="nav-index">07</span><span class="nav-label">Configuración</span><span class="nav-arrow" aria-hidden="true">↗</span></button>
      </div>
    </section>
  `;
}

async function renderSeparatedOrders(searchTerm = '') {
  const requestId = (renderSeparatedOrders.lastRequestId || 0) + 1;
  renderSeparatedOrders.lastRequestId = requestId;
  const renderToken = navigationToken;
  const list = await api.get('/api/separados' + (searchTerm ? '?q=' + encodeURIComponent(searchTerm) : ''));
  if (requestId !== renderSeparatedOrders.lastRequestId || renderToken !== navigationToken || parseHash().route !== 'separados') return;
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
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px">
          <div class="total-stock">Total: ${fmtMoney(order.total)} · Pagado: ${fmtMoney(order.paid_amount)} · Saldo: ${fmtMoney(order.balance || 0)}</div>
          ${order.status === 'activo' ? `<button class="btn btn-danger" onclick="event.stopPropagation(); openSeparatedCancel(${order.id});">🚫 Anular</button>` : ''}
        </div>
      </div>
    `).join('')}
  `;
  const input = document.getElementById('separatedSearch');
  if (input) {
    input.addEventListener('input', async () => {
      const value = input.value;
      const cursorPosition = input.selectionStart;
      await renderSeparatedOrders(value);
      const nextInput = document.getElementById('separatedSearch');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(cursorPosition, cursorPosition);
      }
    });
  }
}

async function renderSeparatedDetail(id) {
  const renderToken = navigationToken;
  const order = await api.get('/api/separados/' + id);
  if (renderToken !== navigationToken) return;
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
        <div class="meta">Cantidad: ${item.quantity} · Retirada: ${item.retired_quantity} · Pendiente de retirar: ${item.quantity - item.retired_quantity}</div>
        <div class="meta">${fmtMoney(item.unit_price)} × ${item.quantity} = ${fmtMoney(item.subtotal)} · Abonado a este producto: ${fmtMoney(item.allocated_amount || 0)} · Saldo de producto: ${fmtMoney(item.item_balance ?? item.subtotal)}</div>
      </div>
    `).join('')}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin:20px 0">
      ${order.status !== 'anulado' ? `<button class="btn btn-outline" onclick="openAccountItemsModal('separados', ${order.id})">➕ Agregar productos</button>` : ''}
      ${order.status !== 'anulado' && Number(order.balance) > 0 ? `<button class="btn btn-primary" onclick="openSeparatedPayment(${order.id})">💰 Abonar</button>` : ''}
      ${order.status === 'activo' && order.items.some((item) => item.quantity > item.retired_quantity) ? `<button class="btn btn-outline" onclick="openSeparatedRetiro(${order.id})">📦 Retirar</button>` : ''}
      ${order.status !== 'anulado' && order.items.some((item) => Number(item.retired_quantity) > 0) ? `<button class="btn btn-outline" onclick="openSeparatedReturn(${order.id})">↩️ Devolver producto</button>` : ''}
      ${order.status === 'activo' ? `<button class="btn btn-danger" onclick="openSeparatedCancel(${order.id})">🚫 Anular</button>` : ''}
    </div>
    <h3>Historial de pagos</h3>
    ${order.payments.length ? order.payments.map((payment) => `<div class="product-item"><strong>${fmtMoney(payment.amount)}</strong><div class="meta">${new Date(payment.created_at).toLocaleString('es-CO')} · ${escapeHtml(paymentLabel(payment.payment_method, payment.payment_destination))} · ${payment.allocated_product_reference ? 'Aplicado a ' + escapeHtml(payment.allocated_product_reference) : 'Abono a cuenta completa'}${payment.user_name ? ' · ' + escapeHtml(payment.user_name) : ''}${payment.note ? ' · ' + escapeHtml(payment.note) : ''}</div></div>`).join('') : '<p class="helper-text">Sin abonos registrados.</p>'}
    ${order.refunds?.length ? `<h3>Devoluciones</h3>${order.refunds.map((refund) => `<div class="product-item"><strong>−${fmtMoney(refund.amount)}</strong><div class="meta">${new Date(refund.created_at).toLocaleString('es-CO')} · ${escapeHtml(paymentLabel(refund.payment_method))} · ${escapeHtml(refund.reason)}${refund.user_name ? ' · ' + escapeHtml(refund.user_name) : ''}</div></div>`).join('')}` : ''}
  `;
}

async function renderCreditSales(searchTerm = '') {
  const requestId = (renderCreditSales.lastRequestId || 0) + 1;
  renderCreditSales.lastRequestId = requestId;
  const renderToken = navigationToken;
  const list = await api.get('/api/fiados' + (searchTerm ? '?q=' + encodeURIComponent(searchTerm) : ''));
  if (requestId !== renderCreditSales.lastRequestId || renderToken !== navigationToken || parseHash().route !== 'fiados') return;
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
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px">
          <div class="total-stock">Total: ${fmtMoney(credit.total)} · Pagado: ${fmtMoney(credit.paid_amount)} · Saldo: ${fmtMoney(credit.balance || 0)}</div>
          ${credit.status !== 'anulado' ? `<button class="btn btn-danger" onclick="event.stopPropagation(); openFiadoCancel(${credit.id});">🚫 Anular</button>` : ''}
        </div>
      </div>
    `).join('')}
  `;
  const input = document.getElementById('fiadoSearch');
  if (input) {
    input.addEventListener('input', async () => {
      const value = input.value;
      const cursorPosition = input.selectionStart;
      await renderCreditSales(value);
      const nextInput = document.getElementById('fiadoSearch');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(cursorPosition, cursorPosition);
      }
    });
  }
}

async function renderCreditDetail(id) {
  const renderToken = navigationToken;
  const credit = await api.get('/api/fiados/' + id);
  if (renderToken !== navigationToken) return;
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
        <div class="meta">Cantidad: ${item.quantity} · ${fmtMoney(item.unit_price)} c/u = ${fmtMoney(item.subtotal)} · Abonado a este producto: ${fmtMoney(item.allocated_amount || 0)} · Saldo de producto: ${fmtMoney(item.item_balance ?? item.subtotal)}</div>
      </div>
    `).join('')}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin:20px 0">
      ${credit.status !== 'anulado' ? `<button class="btn btn-outline" onclick="openAccountItemsModal('fiados', ${credit.id})">➕ Agregar productos</button>` : ''}
      ${credit.status !== 'anulado' && Number(credit.balance) > 0 ? `<button class="btn btn-primary" onclick="openFiadoPayment(${credit.id})">💰 Abonar</button>` : ''}
      ${credit.status !== 'anulado' ? `<button class="btn btn-danger" onclick="openFiadoCancel(${credit.id})">🚫 Anular</button>` : ''}
    </div>
    <h3>Historial de pagos</h3>
    ${credit.payments.length ? credit.payments.map((payment) => `<div class="product-item"><strong>${fmtMoney(payment.amount)}</strong><div class="meta">${new Date(payment.created_at).toLocaleString('es-CO')} · ${escapeHtml(paymentLabel(payment.payment_method, payment.payment_destination))} · ${payment.allocated_product_reference ? 'Aplicado a ' + escapeHtml(payment.allocated_product_reference) : 'Abono a cuenta completa'}${payment.user_name ? ' · ' + escapeHtml(payment.user_name) : ''}${payment.note ? ' · ' + escapeHtml(payment.note) : ''}</div></div>`).join('') : '<p class="helper-text">Sin abonos registrados.</p>'}
    ${credit.refunds?.length ? `<h3>Devoluciones</h3>${credit.refunds.map((refund) => `<div class="product-item"><strong>−${fmtMoney(refund.amount)}</strong><div class="meta">${new Date(refund.created_at).toLocaleString('es-CO')} · ${escapeHtml(paymentLabel(refund.payment_method))} · ${escapeHtml(refund.reason)}${refund.user_name ? ' · ' + escapeHtml(refund.user_name) : ''}</div></div>`).join('')}` : ''}
  `;
}

async function openSeparatedModal() {
  const products = await api.get('/api/products');
  const usableProducts = (products || []).filter((product) => product.status === 'activo')
    .map((product) => ({ ...product, variants: product.variants.filter((variant) => variant.available_quantity > 0) }))
    .filter((product) => product.variants.length > 0);
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
      <button id="sepAddItem" class="btn btn-outline btn-block" type="button">Agregar producto</button>
      <div id="sepItems" class="search-results" style="margin:10px 0"></div>
      <div class="field"><label>Abono inicial</label><input id="sepInitialPayment" type="number" min="0" step="1" value="0" /></div>
      <div class="field"><label>Método del abono inicial</label><select id="sepInitialMethod">${accountPaymentMethodOptions()}</select></div>
      <div class="field"><label>Fecha límite</label><input id="sepDueAt" type="date" /></div>
      <button class="btn btn-primary btn-block" type="submit">Guardar separado</button>
    </form>
  `);

  const searchInput = document.getElementById('sepProductSearch');
  const resultsContainer = document.getElementById('sepProductResults');
  const selectedProductLabel = document.getElementById('sepSelectedProduct');
  const selectedItems = [];
  let selectedEntry = null;
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
        selectedEntry = selectedProduct;
        selectedProductLabel.textContent = `Seleccionado: ${selectedProduct.product.reference}${selectedProduct.variant.size ? ' · talla ' + selectedProduct.variant.size : ''} · ${fmtMoney(selectedProduct.product.price)}`;
        searchInput.value = selectedProduct.product.reference;
      });
    });
  };

  searchInput.addEventListener('input', () => renderProductMatches(searchInput.value));
  renderProductMatches();

  const renderSelectedItems = () => {
    document.getElementById('sepItems').innerHTML = selectedItems.length === 0
      ? '<p class="helper-text">Agrega los productos del separado.</p>'
      : selectedItems.map((item, index) => `<div class="product-item" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px"><span>${escapeHtml(item.label)} · ${item.quantity} × ${fmtMoney(item.unitPrice)}</span><button type="button" class="btn btn-danger" data-remove-sep="${index}">Quitar</button></div>`).join('');
    document.querySelectorAll('[data-remove-sep]').forEach((button) => {
      button.addEventListener('click', () => { selectedItems.splice(Number(button.dataset.removeSep), 1); renderSelectedItems(); });
    });
  };
  renderSelectedItems();
  document.getElementById('sepAddItem').addEventListener('click', () => {
    const variantId = Number(document.getElementById('sepVariant').value);
    const quantity = Number(document.getElementById('sepQty').value);
    const unitPrice = Number(document.getElementById('sepPrice').value);
    if (!variantId || !selectedEntry) return toast('Busca y selecciona un producto antes de agregarlo.', 'error');
    if (!quantity || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) return toast('Revisa la cantidad y el precio del producto.', 'error');
    selectedItems.push({ variantId, quantity, unitPrice, label: `${selectedEntry.product.reference}${selectedEntry.variant.size ? ' · talla ' + selectedEntry.variant.size : ''}` });
    renderSelectedItems();
    selectedEntry = null;
    document.getElementById('sepVariant').value = '';
    selectedProductLabel.textContent = 'Producto agregado. Selecciona otro para continuar.';
    searchInput.value = '';
  });

  document.getElementById('separatedForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (selectedItems.length === 0) throw new Error('Agrega al menos un producto antes de guardar el separado.');
      await api.post('/api/separados', {
        clientName: document.getElementById('sepClient').value,
        phone: document.getElementById('sepPhone').value,
        items: selectedItems.map(({ label, ...item }) => item),
        initialPayment: Number(document.getElementById('sepInitialPayment').value || 0),
        initialPaymentMethod: document.getElementById('sepInitialMethod').value,
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
  const usableProducts = (products || []).filter((product) => product.status === 'activo')
    .map((product) => ({ ...product, variants: product.variants.filter((variant) => variant.available_quantity > 0) }))
    .filter((product) => product.variants.length > 0);
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
      <button id="fiaAddItem" class="btn btn-outline btn-block" type="button">Agregar producto</button>
      <div id="fiaItems" class="search-results" style="margin:10px 0"></div>
      <div class="field"><label>Abono inicial</label><input id="fiaInitialPayment" type="number" min="0" step="1" value="0" /></div>
      <div class="field"><label>Método del abono inicial</label><select id="fiaInitialMethod">${accountPaymentMethodOptions()}</select></div>
      <button class="btn btn-primary btn-block" type="submit">Guardar fiado</button>
    </form>
  `);

  const searchInput = document.getElementById('fiaProductSearch');
  const resultsContainer = document.getElementById('fiaProductResults');
  const selectedProductLabel = document.getElementById('fiaSelectedProduct');
  const selectedItems = [];
  let selectedEntry = null;
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
        selectedEntry = selectedProduct;
        selectedProductLabel.textContent = `Seleccionado: ${selectedProduct.product.reference}${selectedProduct.variant.size ? ' · talla ' + selectedProduct.variant.size : ''} · ${fmtMoney(selectedProduct.product.price)}`;
        searchInput.value = selectedProduct.product.reference;
      });
    });
  };

  searchInput.addEventListener('input', () => renderProductMatches(searchInput.value));
  renderProductMatches();

  const renderSelectedItems = () => {
    document.getElementById('fiaItems').innerHTML = selectedItems.length === 0
      ? '<p class="helper-text">Agrega los productos del fiado.</p>'
      : selectedItems.map((item, index) => `<div class="product-item" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px"><span>${escapeHtml(item.label)} · ${item.quantity} × ${fmtMoney(item.unitPrice)}</span><button type="button" class="btn btn-danger" data-remove-fia="${index}">Quitar</button></div>`).join('');
    document.querySelectorAll('[data-remove-fia]').forEach((button) => {
      button.addEventListener('click', () => { selectedItems.splice(Number(button.dataset.removeFia), 1); renderSelectedItems(); });
    });
  };
  renderSelectedItems();
  document.getElementById('fiaAddItem').addEventListener('click', () => {
    const variantId = Number(document.getElementById('fiaVariant').value);
    const quantity = Number(document.getElementById('fiaQty').value);
    const unitPrice = Number(document.getElementById('fiaPrice').value);
    if (!variantId || !selectedEntry) return toast('Busca y selecciona un producto antes de agregarlo.', 'error');
    if (!quantity || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) return toast('Revisa la cantidad y el precio del producto.', 'error');
    selectedItems.push({ variantId, quantity, unitPrice, label: `${selectedEntry.product.reference}${selectedEntry.variant.size ? ' · talla ' + selectedEntry.variant.size : ''}` });
    renderSelectedItems();
    selectedEntry = null;
    document.getElementById('fiaVariant').value = '';
    selectedProductLabel.textContent = 'Producto agregado. Selecciona otro para continuar.';
    searchInput.value = '';
  });

  document.getElementById('fiadoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (selectedItems.length === 0) throw new Error('Agrega al menos un producto antes de guardar el fiado.');
      await api.post('/api/fiados', {
        clientName: document.getElementById('fiaClient').value,
        phone: document.getElementById('fiaPhone').value,
        items: selectedItems.map(({ label, ...item }) => item),
        initialPayment: Number(document.getElementById('fiaInitialPayment').value || 0),
        initialPaymentMethod: document.getElementById('fiaInitialMethod').value,
      });
      closeModal();
      toast('Fiado creado', 'success');
      renderCreditSales();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function openSeparatedPayment(id) { openAccountPayment('separados', id); }
function openFiadoPayment(id) { openAccountPayment('fiados', id); }

async function openAccountPayment(type, id) {
  try {
    const account = await api.get(`/api/${type}/${id}`);
    const isSeparated = type === 'separados';
    const route = isSeparated ? 'separados' : 'fiados';
    const itemOptions = account.items.map((item) => `
      <option value="${item.id}" data-balance="${Math.max(Number(item.subtotal) - Number(item.allocated_amount || 0), 0)}">
        ${escapeHtml(item.product_reference)}${item.size ? ' · talla ' + escapeHtml(item.size) : ''} · saldo sin asignar ${fmtMoney(Math.max(Number(item.subtotal) - Number(item.allocated_amount || 0), 0))}
      </option>
    `).join('');
    showModal(`
      <h3>Registrar abono</h3>
      <p class="helper-text">Saldo de la cuenta: <strong>${fmtMoney(account.balance)}</strong></p>
      <form id="accountPaymentForm">
        <div class="field"><label>Aplicar abono a</label><select id="accountPaymentTarget"><option value="">Cuenta completa</option>${itemOptions}</select></div>
        <div class="field"><label>Valor</label><input id="accountPaymentAmount" type="number" min="0.01" step="0.01" max="${account.balance}" required /></div>
        <div id="accountPaymentLimit" class="helper-text" style="margin:-8px 0 14px">Máximo de la cuenta: ${fmtMoney(account.balance)}</div>
        <div class="field"><label>Método de pago</label><select id="accountPaymentMethod">${accountPaymentMethodOptions()}</select></div>
        <button class="btn btn-primary btn-block" type="submit">Registrar abono</button>
      </form>
    `);
    const target = document.getElementById('accountPaymentTarget');
    const amount = document.getElementById('accountPaymentAmount');
    const limit = document.getElementById('accountPaymentLimit');
    const updateLimit = () => {
      const option = target.selectedOptions[0];
      const max = option?.dataset.balance ? Math.min(Number(option.dataset.balance), Number(account.balance)) : Number(account.balance);
      amount.max = String(max);
      limit.textContent = `Máximo para ${target.value ? 'este producto' : 'la cuenta'}: ${fmtMoney(max)}`;
    };
    target.addEventListener('change', updateLimit);
    updateLimit();
    document.getElementById('accountPaymentForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        amount: Number(amount.value),
        method: document.getElementById('accountPaymentMethod').value,
        ...(target.value ? { itemId: Number(target.value) } : {}),
      };
      try {
        await api.post(`/api/${route}/${id}/pagos`, payload);
        closeModal();
        toast('Abono registrado', 'success');
        if (isSeparated) await renderSeparatedDetail(id);
        else await renderCreditDetail(id);
      } catch (error) { toast(error.message, 'error'); }
    });
  } catch (error) { toast(error.message, 'error'); }
}

async function openAccountItemsModal(type, id) {
  const products = await api.get('/api/products');
  const entries = (products || []).filter((product) => product.status === 'activo').flatMap((product) =>
    (product.variants || []).filter((variant) => Number(variant.available_quantity) > 0).map((variant) => ({ product, variant }))
  );
  if (!entries.length) return toast('No hay productos disponibles para agregar.', 'error');
  const selectedItems = [];
  showModal(`
    <h3>Agregar productos a la cuenta</h3>
    <form id="accountItemsForm">
      <div class="field"><label>Buscar en inventario</label><input id="accountItemSearch" type="search" placeholder="Referencia, nombre o talla" autocomplete="off" /></div>
      <div id="accountItemResults" class="search-results" style="max-height:240px;overflow:auto;margin-bottom:14px"></div>
      <div id="accountItemSelected" class="helper-text" style="margin-bottom:12px">Busca y selecciona un producto para agregarlo.</div>
      <input id="accountItemVariant" type="hidden" />
      <div class="field"><label>Cantidad</label><input id="accountItemQuantity" type="number" min="1" step="1" value="1" required /></div>
      <div class="field"><label>Precio unitario</label><input id="accountItemPrice" type="number" min="0" step="1" required /></div>
      <button id="accountItemAdd" class="btn btn-outline btn-block" type="button">Agregar a la lista</button>
      <div id="accountItemList" class="search-results" style="margin:10px 0"></div>
      <button class="btn btn-primary btn-block" type="submit">Guardar productos</button>
    </form>
  `);
  const searchInput = document.getElementById('accountItemSearch');
  const results = document.getElementById('accountItemResults');
  const selectedLabel = document.getElementById('accountItemSelected');
  const variantInput = document.getElementById('accountItemVariant');
  const priceInput = document.getElementById('accountItemPrice');
  const list = document.getElementById('accountItemList');
  let selectedEntry = null;
  const renderMatches = (query = '') => {
    const term = normalizeSearchValue(query);
    const matches = entries.filter(({ product, variant }) => normalizeSearchValue(
      `${product.reference} ${product.name} ${variant.size || ''}`
    ).includes(term)).slice(0, 20);
    results.innerHTML = matches.length ? matches.map(({ product, variant }) => `
      <button type="button" class="btn btn-outline" style="display:block;width:100%;text-align:left;margin:6px 0;padding:10px 12px" data-account-variant="${variant.variant_id}">
        <strong>${escapeHtml(product.reference)}</strong>${variant.size ? ' · talla ' + escapeHtml(variant.size) : ''}
        <div class="meta">${escapeHtml(product.name)} · ${fmtMoney(product.price)} · ${variant.available_quantity} disponibles</div>
      </button>
    `).join('') : '<p class="helper-text">No hay productos que coincidan con la búsqueda.</p>';
    results.querySelectorAll('[data-account-variant]').forEach((button) => button.addEventListener('click', () => {
      selectedEntry = entries.find(({ variant }) => Number(variant.variant_id) === Number(button.dataset.accountVariant));
      if (!selectedEntry) return;
      variantInput.value = String(selectedEntry.variant.variant_id);
      priceInput.value = String(selectedEntry.product.price);
      selectedLabel.textContent = `Seleccionado: ${selectedEntry.product.reference}${selectedEntry.variant.size ? ' · talla ' + selectedEntry.variant.size : ''} · ${fmtMoney(selectedEntry.product.price)}`;
    }));
  };
  searchInput.addEventListener('input', () => renderMatches(searchInput.value));
  renderMatches();
  const renderItems = () => {
    list.innerHTML = selectedItems.length
      ? selectedItems.map((item, index) => `<div class="product-item" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px"><span>${escapeHtml(item.label)} · ${item.quantity} × ${fmtMoney(item.unitPrice)}</span><button type="button" class="btn btn-danger" data-remove-account-item="${index}">Quitar</button></div>`).join('')
      : '<p class="helper-text">Aún no hay productos seleccionados.</p>';
    list.querySelectorAll('[data-remove-account-item]').forEach((button) => button.addEventListener('click', () => {
      selectedItems.splice(Number(button.dataset.removeAccountItem), 1);
      renderItems();
    }));
  };
  renderItems();
  document.getElementById('accountItemAdd').addEventListener('click', () => {
    const quantity = Number(document.getElementById('accountItemQuantity').value);
    const unitPrice = Number(priceInput.value);
    if (!selectedEntry) return toast('Busca y selecciona un producto.', 'error');
    if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) return toast('Revisa la cantidad y el precio.', 'error');
    selectedItems.push({
      variantId: Number(selectedEntry.variant.variant_id),
      quantity,
      unitPrice,
      label: `${selectedEntry.product.reference}${selectedEntry.variant.size ? ' · talla ' + selectedEntry.variant.size : ''}`,
    });
    renderItems();
    selectedEntry = null;
    variantInput.value = '';
    selectedLabel.textContent = 'Producto agregado. Busca otro para continuar.';
    searchInput.value = '';
    renderMatches();
  });
  document.getElementById('accountItemsForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      if (!selectedItems.length) throw new Error('Agrega al menos un producto.');
      await api.post(`/api/${type}/${id}/items`, { items: selectedItems.map(({ label, ...item }) => item) });
      closeModal();
      toast('Productos agregados a la cuenta', 'success');
      if (type === 'separados') await renderSeparatedDetail(id);
      else await renderCreditDetail(id);
    } catch (error) { toast(error.message, 'error'); }
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

async function openSeparatedReturn(id) {
  try {
    const order = await api.get('/api/separados/' + id);
    const returnableItems = order.items.filter((item) => Number(item.retired_quantity) > 0);
    if (!returnableItems.length) return toast('No hay productos retirados pendientes de devolución.', 'error');
    showModal(`
      <h3>Devolver producto al inventario</h3>
      <form id="sepReturnForm">
        <div class="field"><label>Producto</label><select id="sepReturnItem" required>${returnableItems.map((item) => `<option value="${item.id}" data-max="${item.retired_quantity}">${escapeHtml(item.product_reference)}${item.size ? ' · talla ' + escapeHtml(item.size) : ''} · ${escapeHtml(item.product_name)} · retiradas: ${item.retired_quantity}</option>`).join('')}</select></div>
        <div class="field"><label>Cantidad devuelta</label><input id="sepReturnQuantity" type="number" min="1" step="1" required /></div>
        <button class="btn btn-primary btn-block" type="submit">Registrar devolución física</button>
      </form>
    `);
    const itemSelect = document.getElementById('sepReturnItem');
    const quantityInput = document.getElementById('sepReturnQuantity');
    const updateMax = () => {
      const max = Number(itemSelect.selectedOptions[0]?.dataset.max || 0);
      quantityInput.max = String(max);
      quantityInput.value = String(max > 0 ? 1 : 0);
    };
    itemSelect.addEventListener('change', updateMax);
    updateMax();
    document.getElementById('sepReturnForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api.post(`/api/separados/${id}/devolucion`, { itemId: Number(itemSelect.value), quantity: Number(quantityInput.value) });
        closeModal();
        toast('Inventario actualizado con la devolución', 'success');
        await renderSeparatedDetail(id);
      } catch (error) { toast(error.message, 'error'); }
    });
  } catch (error) { toast(error.message, 'error'); }
}

function openSeparatedCancel(id) { openAccountCancellation('separados', id); }
function openFiadoCancel(id) { openAccountCancellation('fiados', id); }

async function openAccountCancellation(type, id) {
  try {
    const account = await api.get(`/api/${type}/${id}`);
    const isSeparated = type === 'separados';
    const withdrawn = isSeparated ? account.items.reduce((sum, item) => sum + Number(item.retired_quantity || 0), 0) : 0;
    const paidAmount = Number(account.paid_amount || 0);
    const refundField = paidAmount > 0 ? `
      <div class="field"><label>Devolver ${fmtMoney(paidAmount)} por</label><select id="accountRefundMethod" required>${accountPaymentMethodOptions()}</select></div>
    ` : '';
    const physicalReturnField = !isSeparated ? '<div class="field"><label><input id="accountItemsReturned" type="checkbox" required style="width:auto;margin-right:8px" />Confirmo que recibí físicamente todos los productos</label></div>' : '';
    showModal(`
      <h3>Anular ${isSeparated ? 'separado' : 'fiado'}</h3>
      <p class="helper-text">${isSeparated && withdrawn > 0
        ? `Hay ${withdrawn} producto(s) retirado(s). Registra primero la devolución física para anular la cuenta.`
        : paidAmount > 0
          ? `La anulación devolverá el total abonado (${fmtMoney(paidAmount)}) y quedará registrada en caja.`
          : 'Esta acción cancelará la cuenta y actualizará el inventario.'}</p>
      <form id="accountCancelForm">
        <div class="field"><label>Motivo</label><input id="accountCancelReason" required /></div>
        ${refundField}
        ${physicalReturnField}
        <button class="btn btn-danger btn-block" type="submit" ${withdrawn > 0 ? 'disabled' : ''}>Confirmar anulación</button>
      </form>
    `);
    document.getElementById('accountCancelForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = { reason: document.getElementById('accountCancelReason').value.trim() };
      if (paidAmount > 0) payload.refundMethod = document.getElementById('accountRefundMethod').value;
      if (!isSeparated) payload.itemsReturned = document.getElementById('accountItemsReturned').checked;
      try {
        const result = await api.post(`/api/${type}/${id}/anular`, payload);
        closeModal();
        toast(result.refundedAmount > 0 ? `Cuenta anulada · devolución ${fmtMoney(result.refundedAmount)} registrada` : 'Cuenta anulada', 'success');
        if (isSeparated) await renderSeparatedOrders();
        else await renderCreditSales();
      } catch (error) { toast(error.message, 'error'); }
    });
  } catch (error) { toast(error.message, 'error'); }
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
    container.innerHTML = `<span class="label">Inventario total</span><strong>${summary.availableUnits}</strong><span class="helper-text">Unidades disponibles · ${summary.totalUnits} físicas · ${summary.productCount} productos</span>`;
  } catch (err) {
    container.className = 'card inventory-total error-text';
    container.textContent = 'No se pudo cargar el total del inventario.';
  }
}

async function loadInventoryResults(q) {
  const container = document.getElementById('invResults');
  if (!container) return;
  const requestId = ++loadInventoryResults.lastRequestId;
  let products;
  try {
    products = await api.get('/api/products?q=' + encodeURIComponent(q || ''));
  } catch (error) {
    if (requestId === loadInventoryResults.lastRequestId && document.getElementById('invResults')) {
      container.innerHTML = '<div class="empty-state"><p>No se pudo cargar el inventario. Intenta de nuevo.</p><button class="btn btn-outline" onclick="loadInventoryResults(document.getElementById(\'invSearch\')?.value || \'\')">Reintentar</button></div>';
    }
    return;
  }
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
      const low = v.available_quantity <= (p.low_stock_threshold ?? 3);
      const label = v.size ? v.size : 'Stock';
      return `<span class="size-chip ${low ? 'low' : ''}">${escapeHtml(label)}: ${v.available_quantity} disp. (${v.quantity} físicas)</span>`;
    })
    .join('');
  return `
    <div class="product-item" onclick="navigate('producto/${p.id}')" style="cursor:pointer">
      <div class="ref">${escapeHtml(p.reference)}</div>
      <div class="name">${escapeHtml(p.name)} ${p.status === 'inactivo' ? '<span class="badge badge-danger">Inactivo</span>' : ''}</div>
      <div class="meta">${escapeHtml(p.category_name || '')} · ${fmtMoney(p.price)}</div>
      <div class="size-chip-row">${chips}</div>
      <div class="total-stock">${p.total_available} disponibles · ${p.total_stock} físicas</div>
    </div>
  `;
}

// ---------------- PRODUCT DETAIL ----------------
async function renderProductDetail(id) {
  const renderToken = navigationToken;
  const p = await api.get('/api/products/' + id);
  const movements = await api.get('/api/inventory/movements?productId=' + encodeURIComponent(id) + '&limit=100');
  if (renderToken !== navigationToken) return;
  view.innerHTML = `
    ${backLink('inventario', 'Inventario')}
    <h2 class="section-title">${escapeHtml(p.name)}</h2>
    <div class="card" style="margin-bottom:18px">
      <div class="ref">${escapeHtml(p.reference)}</div>
      <p class="meta">${escapeHtml(p.category_name)} · ${fmtMoney(p.price)} ${p.status === 'inactivo' ? '<span class="badge badge-danger">Inactivo</span>' : '<span class="badge badge-ok">Activo</span>'}</p>
      ${p.description ? `<p>${escapeHtml(p.description)}</p>` : ''}
      <div class="size-chip-row" style="margin-top:10px">
        ${p.variants.map((v) => `<span class="size-chip ${v.available_quantity <= p.low_stock_threshold ? 'low' : ''}">${escapeHtml(v.size || 'Stock')}: ${v.available_quantity} disp. (${v.quantity} físicas)</span>`).join('')}
      </div>
      <p class="total-stock">${p.total_available} disponibles · ${p.total_stock} físicas</p>
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
  return ({ efectivo: 'Efectivo', transferencia: 'Transferencia', addi: 'Addi', nequi: 'Transferencia · Nequi', qr: 'Transferencia · QR', daviplata: 'Transferencia · Daviplata' }[method] || 'No especificado');
}
function paymentDestinationLabel(destination) {
  return ({ nequi: 'Nequi', qr: 'QR', daviplata: 'Daviplata' }[destination] || '');
}
function paymentLabel(method, destination) {
  const label = paymentMethodLabel(method);
  return method === 'transferencia' && destination ? `${label} · ${paymentDestinationLabel(destination)}` : label;
}
function accountPaymentMethodOptions() {
  return '<option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option><option value="nequi">Transferencia · Nequi</option><option value="qr">Transferencia · QR</option><option value="daviplata">Transferencia · Daviplata</option><option value="addi">Addi</option>';
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
  const renderToken = navigationToken;
  CATEGORIES = await api.get('/api/categories');
  if (renderToken !== navigationToken) return;
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
  if (!container) return;
  const requestId = ++loadSaleSearchResults.lastRequestId;
  if (!q || !q.trim()) { container.innerHTML = ''; return; }
  let products;
  try {
    products = await api.get('/api/products?q=' + encodeURIComponent(q));
  } catch (error) {
    if (requestId === loadSaleSearchResults.lastRequestId && document.getElementById('saleResults')) {
      container.innerHTML = '<p class="helper-text">No se pudo buscar. Intenta de nuevo.</p>';
    }
    return;
  }
  if (requestId !== loadSaleSearchResults.lastRequestId || !document.getElementById('saleResults')) return;
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
        ${p.variants.filter((v) => v.available_quantity > 0).map((v) => `
          <button type="button" class="btn btn-outline" style="padding:8px 14px;font-size:14px"
            onclick='addToCart(${JSON.stringify({ variantId: v.variant_id, size: v.size, reference: p.reference, name: p.name, price: p.price, available: v.available_quantity }).replace(/'/g, "&#39;")})'>
            ${escapeHtml(v.size || 'Agregar')} ${v.size ? '(' + v.available_quantity + ')' : ''}
          </button>
        `).join('')}
      </div>
    </div>
  `).join('');
}
loadSaleSearchResults.lastRequestId = 0;

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
  const renderToken = navigationToken;
  const sales = await api.get('/api/sales');
  if (renderToken !== navigationToken) return;
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
  const renderToken = navigationToken;
  const sale = await api.get('/api/sales/' + id);
  if (renderToken !== navigationToken) return;
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
  const renderToken = navigationToken;
  let usersHtml = '';
  if (CURRENT_USER.role === 'admin') {
    const users = await api.get('/api/users');
    if (renderToken !== navigationToken) return;
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
    ${CURRENT_USER.role === 'admin' && CURRENT_USER.canResetData ? `
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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(today);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const todayKey = `${values.year}-${values.month}-${values.day}`;
  const shiftedDay = (amount) => {
    const date = new Date(`${todayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
  };
  if (preset === 'today') return { from: todayKey, to: todayKey };
  if (preset === '7d') return { from: shiftedDay(-6), to: todayKey };
  if (preset === 'month') return { from: `${todayKey.slice(0, 7)}-01`, to: todayKey };
  return { from: shiftedDay(-29), to: todayKey };
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
  await loadReportBody();
}

function setReportPreset(preset) {
  reportRange = { ...computePresetRange(preset), preset };
  renderReports();
}

async function loadReportBody() {
  const { from, to } = reportRange;
  const renderToken = navigationToken;
  const qs = `?from=${from}&to=${to}`;
  let overview; let timeline; let topProducts; let byCategory; let paymentSummary; let movements;
  try {
    [overview, timeline, topProducts, byCategory, paymentSummary, movements] = await Promise.all([
      api.get('/api/reports/overview' + qs),
      api.get('/api/reports/sales-timeline' + qs + '&groupBy=day'),
      api.get('/api/reports/top-products' + qs + '&limit=8'),
      api.get('/api/reports/by-category' + qs),
      api.get('/api/reports/payment-summary' + qs),
      api.get('/api/reports/movements' + qs),
    ]);
  } catch (error) {
    const failedContainer = document.getElementById('reportBody');
    if (failedContainer && renderToken === navigationToken && from === reportRange.from && to === reportRange.to) {
      failedContainer.innerHTML = '<div class="empty-state"><p>No se pudieron cargar los informes.</p><button class="btn btn-outline" onclick="loadReportBody()">Reintentar</button></div>';
    }
    return;
  }

  const container = document.getElementById('reportBody');
  if (!container || renderToken !== navigationToken || from !== reportRange.from || to !== reportRange.to) return;
  const creditActivity = overview.accountActivity?.fiados || {};
  const separatedActivity = overview.accountActivity?.separados || {};
  const accountActivityRows = [
    { label: 'Fiados', activity: creditActivity },
    { label: 'Separados', activity: separatedActivity },
  ];
  container.innerHTML = `
    <div class="stat-grid">
      <div class="card stat-card"><div class="label">Ingresos</div><div class="value">${fmtMoney(overview.revenue)}</div></div>
      <div class="card stat-card"><div class="label">Ventas</div><div class="value">${overview.saleCount}</div></div>
      <div class="card stat-card"><div class="label">Productos vendidos</div><div class="value">${overview.itemsSold}</div></div>
      <div class="card stat-card"><div class="label">Ticket promedio</div><div class="value">${fmtMoney(overview.avgTicket)}</div></div>
      <div class="card stat-card ${overview.voidedCount > 0 ? 'alert' : ''}"><div class="label">Ventas anuladas</div><div class="value">${overview.voidedCount}</div></div>
      <div class="card stat-card"><div class="label">Valor del inventario</div><div class="value">${fmtMoney(overview.inventoryValue)}</div></div>
    </div>

    <h3>Informe de fiados y separados</h3>
    <div class="card" style="margin-bottom:24px;overflow-x:auto">
      <table style="width:100%;min-width:900px;border-collapse:collapse;text-align:right">
        <thead><tr style="border-bottom:1px solid var(--line)">
          <th style="padding:10px;text-align:left">Tipo</th>
          <th style="padding:10px">Cuentas creadas</th>
          <th style="padding:10px">Unidades agregadas</th>
          <th style="padding:10px">Valor de productos</th>
          <th style="padding:10px">Abonos del período</th>
          <th style="padding:10px">Devoluciones</th>
          <th style="padding:10px">Recaudo neto</th>
          <th style="padding:10px">Saldo abierto actual</th>
        </tr></thead>
        <tbody>${accountActivityRows.map(({ label, activity }) => `
          <tr style="border-bottom:1px solid var(--line)">
            <th scope="row" style="padding:12px 10px;text-align:left">${label}</th>
            <td style="padding:12px 10px">${activity.accountsCreated || 0}</td>
            <td style="padding:12px 10px">${activity.unitsAdded || 0} <span class="meta">(${activity.productLines || 0} líneas)</span></td>
            <td style="padding:12px 10px">${fmtMoney(activity.productsValue || 0)}</td>
            <td style="padding:12px 10px">${fmtMoney(activity.paymentsReceived || 0)} <span class="meta">(${activity.paymentCount || 0})</span></td>
            <td style="padding:12px 10px">${fmtMoney(activity.refundsIssued || 0)}</td>
            <td style="padding:12px 10px;font-weight:700">${fmtMoney(activity.netCollected || 0)}</td>
            <td style="padding:12px 10px;font-weight:700">${fmtMoney(activity.openBalance || 0)}</td>
          </tr>
        `).join('')}</tbody>
      </table>
      <p class="helper-text" style="margin:12px 10px 0">La actividad y los abonos corresponden al período seleccionado; el saldo abierto es el actual de todas las cuentas vigentes.</p>
    </div>

    <h3>¿Cómo entró el dinero?</h3>
    <div class="card" style="margin-bottom:24px">
      ${paymentSummary.length === 0 ? '<p class="helper-text">Sin ventas en este período.</p>' : paymentSummary.map((p, i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;${i > 0 ? 'border-top:1px solid var(--line)' : ''}">
          <div>
            <div style="font-weight:700">${escapeHtml(paymentLabel(p.method, p.destination))}</div>
            <div class="meta">${p.transactionCount} ${p.transactionCount === 1 ? 'ingreso' : 'ingresos'}${p.refundTotal > 0 ? ` · Devoluciones: ${fmtMoney(p.refundTotal)}` : ''}</div>
          </div>
          <div style="font-weight:700">${fmtMoney(p.total)}</div>
        </div>
      `).join('')}
    </div>

    <h3>Ingresos por día</h3>
    <div class="card" style="margin-bottom:24px">
      ${timeline.length === 0 ? '<p class="helper-text">No hay ingresos en este período.</p>' : barChartSvg(timeline)}
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
  const totals = timeline.map((entry) => Number(entry.total));
  const min = Math.min(...totals, 0);
  const max = Math.max(...totals, 0);
  const valueRange = max - min || 1;
  const chartHeight = height - padding - 14;
  const baseline = padding + (max / valueRange) * chartHeight;
  const scale = chartHeight / valueRange;
  const barWidth = (width - padding) / timeline.length;
  const bars = timeline.map((t, i) => {
    const value = Number(t.total);
    const barHeight = Math.abs(value) * scale;
    const x = padding + i * barWidth;
    const y = value >= 0 ? baseline - barHeight : baseline;
    const dateParts = String(t.period).slice(0, 10).split('-');
    const label = dateParts.length === 3 ? `${dateParts[2]}/${dateParts[1]}` : '';
    return `
      <rect x="${x + 2}" y="${y}" width="${Math.max(barWidth - 4, 2)}" height="${barHeight}" fill="#6d1f3f" rx="3"></rect>
      <text x="${x + barWidth / 2}" y="${height - 6}" font-size="9" text-anchor="middle" fill="#6b5a62">${label}</text>
    `;
  }).join('');
  return `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto" xmlns="http://www.w3.org/2000/svg">
      <line x1="${padding}" y1="${baseline}" x2="${width}" y2="${baseline}" stroke="#ead9df" />
      ${bars}
    </svg>
  `;
}
