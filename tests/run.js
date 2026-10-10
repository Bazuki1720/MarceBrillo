// End-to-end tests against a running server (see tests/README or npm test wrapper).
require('dotenv').config();
process.env.DATABASE_URL ||= 'postgresql://unit:unit@127.0.0.1:1/unit';
const BASE = process.env.TEST_BASE_URL;
const TEST_RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_ADMIN_USERNAME = process.env.TEST_ADMIN_USERNAME || process.env.ADMIN_USERNAME || 'admin';
const TEST_ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'CambiarClave123';
const TEST_CATEGORY_NAME = `Cinturones-Test-${TEST_RUN_ID}`;
const TEST_PRODUCT_REFERENCE = `AJ-${TEST_RUN_ID}`;
const TEST_BAG_REFERENCE = `BOL-${TEST_RUN_ID}`;
const TEST_PRICE_REFERENCE = `PRC-${TEST_RUN_ID}`;
const TEST_CENTS_REFERENCE = `PRCC-${TEST_RUN_ID}`;
const TEST_SELLER_USERNAME = `vendedora-${TEST_RUN_ID}`;
const reports = require('../src/reports');
const { businessDate, resolveRange } = reports;
const { pool } = require('../src/db');
const { toCents, fromCents } = require('../src/money');
const { orderItemsByVariantId, recordMovement } = require('../src/inventoryLogic');

let cookie = '';
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}`); }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

async function waitForChangeEvent(reader, timeoutMs = 3000) {
  const decoder = new TextDecoder();
  let buffer = '';
  let timeout;
  const readUntilChange = (async () => {
    while (!buffer.includes('event: change')) {
      const { done, value } = await reader.read();
      if (done) return false;
      buffer += decoder.decode(value, { stream: true });
    }
    return true;
  })();
  try {
    return await Promise.race([
      readUntilChange,
      new Promise((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function testMissingInventoryRow() {
  let quantity = null;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push(sql);
      if (sql.startsWith('INSERT INTO inventory')) {
        if (quantity === null) quantity = 0;
        return { rows: [] };
      }
      if (sql.startsWith('SELECT quantity FROM inventory')) {
        return { rows: quantity === null ? [] : [{ quantity }] };
      }
      if (sql.startsWith('UPDATE inventory')) {
        quantity = params[0];
        return { rows: [] };
      }
      if (sql.includes('SELECT pv.size, p.reference')) {
        return { rows: [{ size: null, reference: 'MOCK-STOCK' }] };
      }
      if (sql.startsWith('INSERT INTO inventory_movements')) return { rows: [] };
      throw new Error(`Consulta inesperada en la prueba: ${sql}`);
    },
  };
  const updatedQuantity = await recordMovement(client, {
    variantId: 1,
    type: 'entrada',
    quantityChange: 1,
    reason: 'Prueba aislada',
    userId: 1,
  });
  assert(updatedQuantity === 1 && quantity === 1 && calls[0].startsWith('INSERT INTO inventory'), 'Un movimiento reconstruye una fila de stock faltante sin conexión a datos reales');
}

async function testReportsIncludeAccountPayments() {
  const originalQuery = pool.query;
  const queries = [];
  pool.query = async (sql) => {
    queries.push(sql);
    if (sql.includes('WITH payment_events')) return { rows: [{ payment_method: 'efectivo', payment_destination: null, transaction_count: 4, total: '120' }] };
    if (sql.includes('WITH income_events')) return { rows: [{ period: '2026-10-01', total: '160', transaction_count: 4 }] };
    if (sql.includes("FROM sales WHERE status = 'completada'")) return { rows: [{ total: '100', count: 2 }] };
    if (sql.includes('FROM sale_items si')) return { rows: [{ qty: 4 }] };
    if (sql.includes("status = 'anulada'")) return { rows: [{ count: 1, total: '20' }] };
    if (sql.includes('FROM separated_payments') && sql.includes('UNION ALL')) return { rows: [{ count: 3, total: '70', refund_total: '20' }] };
    throw new Error(`Consulta inesperada en prueba de reportes: ${sql}`);
  };
  try {
    const totals = await reports.totals('2026-10-01', '2026-10-01');
    assert(totals.revenue === 170 && totals.directSalesRevenue === 100 && totals.paymentRevenue === 70 && totals.refundTotal === 20, 'Ingresos incluyen pagos netos de devoluciones sin duplicar ni descontar dos veces');
    assert(totals.saleCount === 2 && totals.paymentCount === 3 && totals.avgTicket === 50 && totals.itemsSold === 4, 'Métricas de ventas directas siguen separadas del número de abonos');
    const summary = await reports.paymentSummary('2026-10-01', '2026-10-01');
    assert(summary[0].transactionCount === 4 && summary[0].total === 120, 'Resumen por método agrega operaciones de pago');
    const timeline = await reports.salesSummary('2026-10-01', '2026-10-01', 'day');
    assert(timeline[0].total === 160 && timeline[0].transactionCount === 4, 'La cronología diaria incluye abonos recibidos');
    assert(queries.some((sql) => sql.includes("payment_method = 'transferencia' AND payment_destination IS NOT NULL")), 'El resumen normaliza canales de transferencia entre ventas y abonos');
    assert(queries.some((sql) => sql.includes('FROM credit_payments')) && queries.some((sql) => sql.includes('FROM separated_payments')), 'Los reportes consultan pagos de fiados y separados');
  } finally {
    pool.query = originalQuery;
  }
}

async function testAccountActivityReport() {
  const originalQuery = pool.query;
  let modernSchema = true;
  const queries = [];
  pool.query = async (sql) => {
    queries.push(sql);
    if (sql.includes('information_schema.columns')) {
      return {
        rows: modernSchema
          ? [
            { table_name: 'separated_order_items', column_name: 'separated_order_id' },
            { table_name: 'separated_payments', column_name: 'separated_order_id' },
          ]
          : [
            { table_name: 'separated_order_items', column_name: 'order_id' },
            { table_name: 'separated_payments', column_name: 'order_id' },
          ],
      };
    }
    if (sql.includes('FROM credit_sales cs')) {
      return { rows: [{ accounts_created: 2, units_added: 3, product_lines: 2, products_value: '250', payment_count: 1, payments_received: '70', refunds_issued: '10', open_balance: '420' }] };
    }
    if (sql.includes('FROM separated_orders so')) {
      return { rows: [{ accounts_created: 1, units_added: 4, product_lines: 3, products_value: '300', payment_count: 2, payments_received: '120', refunds_issued: '20', open_balance: '180' }] };
    }
    throw new Error(`Consulta inesperada en prueba de actividad de cuentas: ${sql}`);
  };
  try {
    const modern = await reports.accountActivity('2026-10-01', '2026-10-01');
    assert(modern.fiados.accountsCreated === 2 && modern.fiados.unitsAdded === 3 && modern.fiados.productsValue === 250, 'Informe de fiados calcula cuentas, unidades y valor del rango');
    assert(modern.fiados.netCollected === 60 && modern.fiados.openBalance === 420, 'Informe de fiados separa recaudo neto del saldo abierto actual');
    assert(modern.separados.unitsAdded === 4 && modern.separados.netCollected === 100, 'Informe de separados calcula unidades y recaudo descontando devoluciones');
    assert(queries.some((sql) => sql.includes('soi.separated_order_id')) && queries.some((sql) => sql.includes('p.separated_order_id = so.id')), 'La consulta utiliza llaves del esquema moderno de separados');

    modernSchema = false;
    queries.length = 0;
    await reports.accountActivity('2026-10-01', '2026-10-01');
    assert(queries.some((sql) => sql.includes('soi.order_id')) && queries.some((sql) => sql.includes('p.order_id = so.id')), 'La consulta también admite el esquema antiguo de separados');
  } finally {
    pool.query = originalQuery;
  }
}

async function run() {
  console.log('--- LOCAL DATE AND MONEY ---');
  assert(businessDate(new Date('2026-10-02T02:00:00Z')) === '2026-10-01', 'La fecha de negocio respeta la zona horaria de Colombia');
  const dateRange = resolveRange('2026-10-01', '2026-10-02');
  assert(dateRange.fromDate.toISOString() === '2026-10-01T05:00:00.000Z' && dateRange.toDate.toISOString() === '2026-10-03T04:59:59.999Z', 'Los rangos incluyen el día completo de Colombia');
  let invalidRangeRejected = false;
  try { resolveRange('2026-10-03', '2026-10-02'); } catch (error) { invalidRangeRejected = error.statusCode === 400; }
  assert(invalidRangeRejected, 'Los informes rechazan rangos de fechas invertidos');
  assert(fromCents(toCents(100000.25)) === 100000.25, 'La conversión monetaria conserva centavos');
  const unorderedItems = [{ variantId: 20 }, { variantId: 3 }];
  const orderedItems = orderItemsByVariantId(unorderedItems);
  assert(orderedItems[0].variantId === 3 && unorderedItems[0].variantId === 20, 'El orden global de locks es estable y no muta el carrito');
  await testMissingInventoryRow();
  await testReportsIncludeAccountPayments();
  await testAccountActivityReport();
  if (!process.argv.includes('--e2e')) {
    console.log(`\n${passed} pruebas locales pasaron.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }
  if (!BASE || process.env.ALLOW_E2E_TEST_WRITES !== 'true') {
    console.error('E2E cancelado: define TEST_BASE_URL y ALLOW_E2E_TEST_WRITES=true solo para un servidor conectado a una base de pruebas desechable.');
    process.exitCode = 1;
    return;
  }

  console.log('--- LOGIN ---');
  let r = await req('POST', '/api/login', { username: 'nope', password: 'wrong' });
  assert(r.status === 401, 'Login con credenciales incorrectas es rechazado');

  r = await req('POST', '/api/login', { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD });
  assert(r.status === 200, 'Login con credenciales correctas funciona');

  r = await req('GET', '/api/me');
  assert(r.status === 200 && r.data.username === 'admin', 'Sesión activa devuelve el usuario');
  const adminUserId = r.data.userId;

  console.log('--- CATEGORIES ---');
  r = await req('GET', '/api/categories');
  assert(r.status === 200 && r.data.length >= 5, 'Categorías por defecto existen');

  const liveController = new AbortController();
  const liveResponse = await fetch(BASE + '/api/events', {
    headers: { ...(cookie ? { Cookie: cookie } : {}) },
    signal: liveController.signal,
  });
  assert(liveResponse.status === 200 && liveResponse.headers.get('content-type')?.includes('text/event-stream'), 'Canal de actualizaciones en tiempo real requiere sesión y conecta');
  const liveReader = liveResponse.ok ? liveResponse.body.getReader() : null;
  if (liveReader) await liveReader.read();

  r = await req('GET', '/api/inventory/summary');
  assert(r.status === 200 && Number.isInteger(r.data.totalUnits) && Number.isInteger(r.data.availableUnits) && Number.isInteger(r.data.productCount), 'Resumen devuelve unidades físicas, disponibles y cantidad de productos');

  r = await req('GET', '/api/dashboard');
  assert(r.status === 200 && Number.isInteger(r.data.inventoryUnits) && Number.isInteger(r.data.availableInventoryUnits), 'Dashboard devuelve unidades físicas y disponibles');
  assert(Number.isInteger(r.data.creditUnitsToday) && Number.isInteger(r.data.separatedUnitsToday), 'Dashboard devuelve unidades fiadas y separadas hoy');

  r = await req('POST', '/api/categories', { name: TEST_CATEGORY_NAME });
  assert(r.status === 200, 'Crear categoría nueva funciona');
  if (liveReader) assert(await waitForChangeEvent(liveReader), 'Los cambios confirmados llegan por el canal en tiempo real');
  liveController.abort();
  const catId = r.data.id;

  r = await req('POST', '/api/products', {
    reference: `TALLAS-EMPTY-${TEST_RUN_ID}`, name: 'Producto sin tallas', categoryId: catId, price: 1000,
    hasVariants: true, sizes: [],
  });
  assert(r.status === 400, 'No permite crear productos con tallas sin variantes');

  r = await req('POST', '/api/categories', { name: TEST_CATEGORY_NAME });
  assert(r.status === 409, 'No permite categorías duplicadas');

  console.log('--- PRODUCTS ---');
  r = await req('POST', '/api/products', {
    reference: TEST_PRODUCT_REFERENCE, name: 'Sandalia test', categoryId: catId, price: 150000,
    hasVariants: true, sizes: [{ size: '35', quantity: 2 }, { size: '36', quantity: 3 }],
  });
  assert(r.status === 200, 'Crear producto con tallas funciona');
  const productWithSizes = r.data;
  const variant35 = productWithSizes.variants.find((v) => v.size === '35');
  const variant36 = productWithSizes.variants.find((v) => v.size === '36');
  assert(productWithSizes.total_stock === 5, 'Stock inicial con tallas es correcto (2+3=5)');
  assert(productWithSizes.total_available === 5 && productWithSizes.variants.every((variant) => Number.isInteger(variant.available_quantity)), 'Inventario expone disponibilidad de todas las variantes');
  r = await req('GET', '/api/inventory/movements?productId=' + productWithSizes.id);
  assert(r.status === 200 && r.data.some((movement) => movement.variant_id === variant35.variant_id) && r.data.some((movement) => movement.variant_id === variant36.variant_id), 'Movimientos de producto incluyen todas sus variantes');

  r = await req('POST', '/api/products', {
    reference: TEST_PRODUCT_REFERENCE, name: 'Duplicado', categoryId: catId, price: 1000, hasVariants: false, initialStock: 1,
  });
  assert(r.status === 409, 'No permite referencias duplicadas');

  r = await req('POST', '/api/products', {
    reference: TEST_BAG_REFERENCE, name: 'Bolso test', categoryId: catId, price: 90000,
    hasVariants: false, initialStock: 5,
  });
  assert(r.status === 200, 'Crear producto sin tallas funciona');
  const productNoSizes = r.data;
  assert(productNoSizes.total_stock === 5, 'Stock inicial sin tallas es correcto');
  assert(productNoSizes.variants.length === 1 && productNoSizes.variants[0].size === null, 'Producto sin tallas tiene una única variante sin talla');

  console.log('--- INVENTORY ENTRY ---');
  r = await req('POST', '/api/inventory/entry', { variantId: variant35.variant_id, quantity: 4, reason: 'Reposición' });
  assert(r.status === 200 && r.data.newQuantity === 6, 'Entrada de inventario suma correctamente (2+4=6)');

  console.log('--- ADJUSTMENTS ---');
  r = await req('POST', '/api/inventory/adjust', { variantId: variant35.variant_id, newQuantity: 4, reason: 'Conteo físico' });
  assert(r.status === 200 && r.data.newQuantity === 4, 'Ajuste de inventario corrige a la cantidad indicada');
  r = await req('POST', '/api/inventory/adjust', { variantId: variant35.variant_id, newQuantity: 1.5, reason: 'Cantidad inválida' });
  assert(r.status === 400, 'El inventario rechaza cantidades fraccionarias');

  console.log('--- SALES: single item ---');
  r = await req('POST', '/api/sales', { items: [{ variantId: variant36.variant_id, quantity: 1 }] });
  assert(r.status === 200, 'Venta simple se registra correctamente');
  const saleId1 = r.data.saleId;

  r = await req('GET', '/api/products/' + productWithSizes.id);
  const v36after = r.data.variants.find((v) => v.size === '36');
  assert(v36after.quantity === 2, 'El stock se descuenta tras la venta (3-1=2)');

  console.log('--- SALES: insufficient stock ---');
  r = await req('POST', '/api/sales', { items: [{ variantId: variant36.variant_id, quantity: 999 }] });
  assert(r.status === 400, 'Venta con stock insuficiente es rechazada');
  assert(/Disponible/i.test(r.data.error || ''), 'Mensaje de error indica la disponibilidad');

  console.log('--- SALES: multi-product ---');
  r = await req('POST', '/api/sales', {
    items: [
      { variantId: variant35.variant_id, quantity: 2 },
      { variantId: productNoSizes.variants[0].variant_id, quantity: 1 },
    ],
  });
  assert(r.status === 200, 'Venta con múltiples productos se registra');
  assert(r.data.total === (productWithSizes.price * 2 + productNoSizes.price * 1), 'El total de la venta multiproducto es correcto');

  console.log('--- SALE ZERO STOCK ---');
  r = await req('POST', '/api/inventory/adjust', { variantId: productNoSizes.variants[0].variant_id, newQuantity: 0, reason: 'test cero' });
  r = await req('POST', '/api/sales', { items: [{ variantId: productNoSizes.variants[0].variant_id, quantity: 1 }] });
  assert(r.status === 400, 'Venta con stock en cero es rechazada');

  console.log('--- HISTORY ---');
  r = await req('GET', '/api/sales');
  assert(r.status === 200 && r.data.length >= 2, 'Historial de ventas lista las ventas');

  r = await req('GET', '/api/sales/' + saleId1);
  assert(r.status === 200 && r.data.items.length === 1, 'Detalle de venta muestra los items');

  console.log('--- VOID / RETURN ---');
  r = await req('GET', '/api/products/' + productWithSizes.id);
  const v36beforeVoid = r.data.variants.find((v) => v.size === '36').quantity;

  r = await req('POST', `/api/sales/${saleId1}/void`, { reason: 'Prueba de anulación' });
  assert(r.status === 200, 'Anular venta funciona');

  r = await req('GET', '/api/products/' + productWithSizes.id);
  const v36afterVoid = r.data.variants.find((v) => v.size === '36').quantity;
  assert(v36afterVoid === v36beforeVoid + 1, 'El inventario se restaura tras anular la venta');

  r = await req('POST', `/api/sales/${saleId1}/void`, { reason: 'Doble anulación' });
  assert(r.status === 400, 'No permite anular una venta ya anulada');

  console.log('--- PRICE HISTORY (historical price on sale) ---');
  r = await req('POST', '/api/products', {
    reference: TEST_PRICE_REFERENCE, name: 'Producto precio', categoryId: catId, price: 100000, hasVariants: false, initialStock: 10,
  });
  const priceProduct = r.data;
  r = await req('POST', '/api/sales', { items: [{ variantId: priceProduct.variants[0].variant_id, quantity: 1 }] });
  const saleAtOldPrice = r.data.saleId;
  await req('PUT', '/api/products/' + priceProduct.id, { price: 170000 });
  r = await req('GET', '/api/sales/' + saleAtOldPrice);
  assert(r.data.items[0].unit_price === 100000, 'La venta conserva el precio histórico aunque el precio actual cambie');

  r = await req('POST', '/api/products', {
    reference: TEST_CENTS_REFERENCE, name: 'Producto con centavos', categoryId: catId, price: 100000.25, hasVariants: false, initialStock: 1,
  });
  r = await req('POST', '/api/sales', { items: [{ variantId: r.data.variants[0].variant_id, quantity: 1 }] });
  assert(r.status === 200 && r.data.total === 100000.25, 'La venta conserva correctamente los centavos en su total');

  console.log('--- SEARCH ---');
  r = await req('GET', '/api/products?q=' + encodeURIComponent(TEST_PRODUCT_REFERENCE.slice(0, 3)));
  assert(r.data.some((p) => p.reference === TEST_PRODUCT_REFERENCE), 'Búsqueda parcial por referencia funciona');

  console.log('--- REPORTS ---');
  r = await req('GET', '/api/reports/overview');
  assert(r.status === 200 && typeof r.data.revenue === 'number', 'Informe general (overview) responde con ingresos numéricos');
  assert(r.data.accountActivity?.fiados && r.data.accountActivity?.separados, 'Informe general incluye actividad separada de fiados y separados');
  assert(r.data.saleCount >= 2, 'Informe general cuenta las ventas completadas del rango');

  r = await req('GET', '/api/reports/sales-timeline?groupBy=day');
  assert(r.status === 200 && Array.isArray(r.data), 'Línea de tiempo de ventas devuelve un arreglo');

  r = await req('GET', '/api/reports/top-products?limit=5');
  assert(r.status === 200 && Array.isArray(r.data) && r.data.length > 0, 'Top de productos devuelve resultados');
  assert(r.data[0].unitsSold >= r.data[r.data.length - 1].unitsSold, 'Top de productos viene ordenado de mayor a menor');

  r = await req('GET', '/api/reports/by-category');
  assert(r.status === 200 && Array.isArray(r.data) && r.data.length > 0, 'Informe por categoría devuelve resultados');

  r = await req('GET', '/api/reports/movements');
  assert(r.status === 200 && Array.isArray(r.data), 'Informe de movimientos devuelve un arreglo');
  assert(r.data.some((m) => m.type === 'venta'), 'Informe de movimientos incluye ventas registradas');

  console.log('--- USERS & PERMISSIONS ---');
  r = await req('POST', '/api/users', { username: TEST_SELLER_USERNAME, password: 'clave123', fullName: 'Vendedora Uno', role: 'vendedor' });
  assert(r.status === 200, 'Admin puede crear usuarios');
  const sellerId = r.data.id;

  const adminCookie = cookie;
  r = await req('PATCH', `/api/users/${adminUserId}`, { active: false });
  assert(r.status === 400, 'Un administrador no puede desactivar su propia cuenta');
  cookie = '';
  r = await req('POST', '/api/login', { username: TEST_SELLER_USERNAME, password: 'clave123' });
  assert(r.status === 200, 'Vendedora puede iniciar sesión');

  r = await req('GET', '/api/users');
  assert(r.status === 403, 'Vendedor sin rol admin no puede listar usuarios');

  r = await req('POST', '/api/sales', { items: [{ variantId: priceProduct.variants[0].variant_id, quantity: 1 }] });
  assert(r.status === 200, 'Vendedor sí puede registrar ventas');

  console.log('--- SEPARADOS ---');
  const separatedProduct = priceProduct;
  r = await req('POST', '/api/separados', {
    clientName: 'Ana Gómez',
    phone: '3001112222',
    items: [
      { variantId: separatedProduct.variants[0].variant_id, quantity: 2, unitPrice: 90000 },
      { variantId: variant35.variant_id, quantity: 1, unitPrice: 150000 },
    ],
  });
  assert(r.status === 200, 'Crear separado guarda múltiples productos y la reserva sin descontar inventario');
  assert(r.data.orderNumber.startsWith('SEP-'), 'El separado obtiene un número legible');
  const separatedId = r.data.orderId;

  r = await req('GET', '/api/separados?q=' + encodeURIComponent('ana'));
  assert(r.status === 200 && r.data.some((order) => order.client_name && order.client_name.toLowerCase().includes('ana')), 'La búsqueda de separados filtra por nombre del cliente sin distinguir mayúsculas');

  r = await req('GET', '/api/separados?q=' + encodeURIComponent(separatedProduct.reference));
  assert(r.status === 200 && r.data.some((order) => order.id === separatedId), 'La búsqueda de separados también filtra por código del producto');

  r = await req('GET', '/api/products/' + separatedProduct.id);
  assert(r.data.variants[0].quantity === 8, 'La reserva de separado no descuenta el inventario físico');

  r = await req('POST', '/api/sales', { items: [{ variantId: separatedProduct.variants[0].variant_id, quantity: 7 }] });
  assert(r.status === 400, 'La venta normal respeta las reservas activas del separado');

  r = await req('POST', `/api/separados/${separatedId}/retiro`, { quantity: 1 });
  assert(r.status === 200, 'Retiro parcial del separado se procesa correctamente');
  r = await req('GET', '/api/separados/' + separatedId);
  assert(r.status === 200 && r.data.items.reduce((sum, item) => sum + Number(item.retired_quantity || 0), 0) === 1, 'El retiro parcial queda reflejado en sus artículos');

  r = await req('POST', `/api/separados/${separatedId}/anular`, { reason: 'Prueba de liberación' });
  assert(r.status === 400, 'No permite anular un separado con retiros ya registrados');
  r = await req('GET', `/api/separados/${separatedId}`);
  const returnedItem = r.data.items.find((item) => Number(item.retired_quantity) > 0);
  const stockBeforePhysicalReturn = (await req('GET', `/api/products/${separatedProduct.id}`)).data.variants[0].quantity;
  r = await req('POST', `/api/separados/${separatedId}/devolucion`, { itemId: returnedItem.id, quantity: 1 });
  assert(r.status === 200 && r.data.remainingWithdrawn === 0, 'Devolver mercancía retirada restaura el estado del artículo');
  r = await req('GET', `/api/products/${separatedProduct.id}`);
  assert(r.data.variants[0].quantity === stockBeforePhysicalReturn + 1, 'La devolución física repone exactamente una unidad al inventario');
  r = await req('POST', `/api/separados/${separatedId}/anular`, { reason: 'Anulación después de devolución física' });
  assert(r.status === 200, 'El separado puede anularse tras devolver físicamente sus productos');

  r = await req('POST', '/api/separados', {
    clientName: 'Pedro',
    phone: '3200001111',
    items: [{ variantId: separatedProduct.variants[0].variant_id, quantity: 99, unitPrice: 90000 }],
  });
  assert(r.status === 400, 'No permite reservar más de la disponibilidad real');

  r = await req('POST', '/api/separados', {
    clientName: 'Cliente individual',
    phone: '3200002222',
    items: [{ variantId: separatedProduct.variants[0].variant_id, quantity: 1, unitPrice: 90000 }],
  });
  assert(r.status === 200 && r.data.orderId, 'Crear separado con un solo producto funciona');
  if (r.status === 200) {
    r = await req('POST', `/api/separados/${r.data.orderId}/anular`, { reason: 'Prueba de artículo único' });
    assert(r.status === 200, 'Anular separado sin abonos ni retiros libera sus reservas');
  }

  const reportDay = businessDate();
  const separatedIncomeBefore = (await req('GET', `/api/reports/overview?from=${reportDay}&to=${reportDay}`)).data;
  r = await req('POST', '/api/separados', {
    clientName: 'Cuenta ampliada', phone: '3200003333',
    items: [{ variantId: variant36.variant_id, quantity: 1, unitPrice: 150000 }],
    initialPayment: 10000, initialPaymentMethod: 'daviplata',
  });
  assert(r.status === 200, 'El abono inicial de un separado acepta método de pago');
  const expandableSeparatedId = r.data.orderId;
  r = await req('POST', `/api/separados/${expandableSeparatedId}/items`, {
    items: [{ variantId: variant36.variant_id, quantity: 1, unitPrice: 140000 }],
  });
  assert(r.status === 200 && r.data.total === 290000, 'Agregar productos amplía el total de la misma cuenta separada');
  r = await req('POST', `/api/separados/${expandableSeparatedId}/pagos`, { amount: 20000, method: 'nequi' });
  assert(r.status === 200, 'Un separado registra abonos posteriores con su método');
  r = await req('GET', `/api/separados/${expandableSeparatedId}`);
  assert(r.status === 200 && r.data.items.length === 2 && r.data.payments.some((payment) => payment.payment_method === 'daviplata') && r.data.payments.some((payment) => payment.payment_method === 'nequi'), 'El detalle conserva productos y canales de pago de la cuenta ampliada');
  const separatedIncomeAfter = (await req('GET', `/api/reports/overview?from=${reportDay}&to=${reportDay}`)).data;
  assert(separatedIncomeAfter.revenue - separatedIncomeBefore.revenue === 30000 && separatedIncomeAfter.paymentCount - separatedIncomeBefore.paymentCount === 2, 'Los ingresos diarios reflejan solo los abonos recibidos en separados');
  r = await req('POST', `/api/separados/${expandableSeparatedId}/anular`, { reason: 'Reembolso prueba' });
  assert(r.status === 400, 'Anular un separado con abonos exige registrar método de devolución');
  r = await req('POST', `/api/separados/${expandableSeparatedId}/anular`, { reason: 'Reembolso prueba', refundMethod: 'daviplata' });
  assert(r.status === 200 && r.data.refundedAmount === 30000, 'Anular un separado devuelve y audita el total abonado');
  const separatedIncomeAfterRefund = (await req('GET', `/api/reports/overview?from=${reportDay}&to=${reportDay}`)).data;
  assert(separatedIncomeAfterRefund.revenue === separatedIncomeBefore.revenue && separatedIncomeAfterRefund.refundTotal - separatedIncomeBefore.refundTotal === 30000, 'El reembolso de separado revierte el ingreso neto sin borrar el historial');

  console.log('--- FIADOS ---');
  const creditIncomeBefore = (await req('GET', `/api/reports/overview?from=${reportDay}&to=${reportDay}`)).data;
  r = await req('GET', '/api/products/' + productWithSizes.id);
  const stockBeforeCredit = r.data.variants.find((v) => v.size === '35').quantity;
  r = await req('POST', '/api/fiados', {
    clientName: 'Lucía',
    phone: '3117778888',
    items: [{ variantId: variant35.variant_id, quantity: 1, unitPrice: 150000 }],
    initialPayment: 10000, initialPaymentMethod: 'qr',
  });
  assert(r.status === 200, 'Crear fiado descuenta inventario y guarda crédito');
  assert(r.data.creditNumber.startsWith('FIA-'), 'El fiado obtiene un número legible');
  const creditId = r.data.creditId;
  r = await req('GET', '/api/products/' + productWithSizes.id);
  const stockAfterCredit = r.data.variants.find((v) => v.size === '35').quantity;
  assert(stockAfterCredit === stockBeforeCredit - 1, 'El fiado descuenta exactamente su inventario');

  r = await req('GET', '/api/fiados?q=' + encodeURIComponent('lucia'));
  assert(r.status === 200 && r.data.some((credit) => credit.client_name && credit.client_name.toLowerCase().includes('lucía') || credit.client_name && credit.client_name.toLowerCase().includes('lucia')), 'La búsqueda de fiados filtra por nombre del cliente sin distinguir mayúsculas');

  r = await req('GET', '/api/fiados?q=' + encodeURIComponent(TEST_PRODUCT_REFERENCE));
  assert(r.status === 200 && r.data.some((credit) => credit.id === creditId), 'La búsqueda de fiados filtra por código del producto');

  const priceStockBeforeCreditAdd = (await req('GET', `/api/products/${priceProduct.id}`)).data.variants[0].quantity;
  r = await req('POST', `/api/fiados/${creditId}/items`, {
    items: [{ variantId: priceProduct.variants[0].variant_id, quantity: 1, unitPrice: 170000 }],
  });
  assert(r.status === 200 && r.data.total === 320000, 'Agregar productos amplía la deuda en el mismo fiado existente');
  r = await req('GET', `/api/fiados/${creditId}`);
  assert(r.status === 200 && r.data.items.length === 2 && r.data.paid_amount === 10000 && r.data.balance === 310000, 'La cuenta ampliada conserva el abono y recalcula el saldo');
  const targetCreditItem = r.data.items.find((item) => item.product_reference === TEST_PRODUCT_REFERENCE);
  const priceStockAfterCreditAdd = (await req('GET', `/api/products/${priceProduct.id}`)).data.variants[0].quantity;
  assert(priceStockAfterCreditAdd === priceStockBeforeCreditAdd - 1, 'Agregar al fiado descuenta el inventario del nuevo producto');

  r = await req('POST', `/api/fiados/${creditId}/pagos`, { amount: 50000, method: 'addi', itemId: targetCreditItem.id });
  assert(r.status === 200, 'Registrar abono del fiado funciona');
  r = await req('GET', `/api/fiados/${creditId}`);
  assert(r.data.payments.some((payment) => payment.payment_method === 'qr') && r.data.payments.some((payment) => payment.payment_method === 'addi' && payment.allocated_item_id === targetCreditItem.id), 'El historial conserva método y producto al que se asignó el abono');
  const creditIncomeAfter = (await req('GET', `/api/reports/overview?from=${reportDay}&to=${reportDay}`)).data;
  assert(creditIncomeAfter.revenue - creditIncomeBefore.revenue === 60000 && creditIncomeAfter.paymentCount - creditIncomeBefore.paymentCount === 2, 'Los abonos inicial y posterior del fiado se reflejan como ingresos diarios');
  r = await req('GET', '/api/dashboard');
  assert(r.status === 200 && r.data.incomeToday === creditIncomeAfter.revenue, 'Dashboard y reporte coinciden en ingresos del día');

  r = await req('POST', `/api/fiados/${creditId}/anular`, { reason: 'Prueba de devolución', itemsReturned: true });
  assert(r.status === 400, 'Anular un fiado con pagos exige método de devolución');
  r = await req('POST', `/api/fiados/${creditId}/anular`, { reason: 'Prueba de devolución', refundMethod: 'transferencia', itemsReturned: true });
  assert(r.status === 200 && r.data.refundedAmount === 60000, 'Anular el fiado reembolsa y registra todos los abonos recibidos');
  r = await req('GET', '/api/products/' + productWithSizes.id);
  const stockAfterCreditVoid = r.data.variants.find((v) => v.size === '35').quantity;
  assert(stockAfterCreditVoid === stockAfterCredit + 1, 'Anular un fiado devuelve sus productos al inventario');
  r = await req('GET', `/api/products/${priceProduct.id}`);
  assert(r.data.variants[0].quantity === priceStockAfterCreditAdd + 1, 'La anulación devuelve también productos anexados posteriormente');
  const creditIncomeAfterRefund = (await req('GET', `/api/reports/overview?from=${reportDay}&to=${reportDay}`)).data;
  assert(creditIncomeAfterRefund.revenue === creditIncomeBefore.revenue && creditIncomeAfterRefund.refundTotal - creditIncomeBefore.refundTotal === 60000, 'El reembolso del fiado ajusta una vez el ingreso neto diario');

  r = await req('POST', '/api/fiados', {
    clientName: 'Fiado sin abono', phone: '3117778899',
    items: [{ variantId: variant35.variant_id, quantity: 1, unitPrice: 150000 }],
  });
  const unpaidCreditId = r.data.creditId;
  r = await req('POST', '/api/fiados/' + unpaidCreditId + '/anular', { reason: 'Prueba de devolución sin pago', itemsReturned: false });
  assert(r.status === 400, 'La anulación de fiado exige confirmar devolución física');
  r = await req('POST', '/api/fiados/' + unpaidCreditId + '/anular', { reason: 'Prueba de devolución sin pago', itemsReturned: true });
  assert(r.status === 200, 'Anular fiado sin pagos devuelve sus productos al inventario');
  r = await req('GET', '/api/products/' + productWithSizes.id);
  assert(r.data.variants.find((v) => v.size === '35').quantity === stockBeforeCredit, 'La anulación limpia restaura exactamente el inventario');

  r = await req('GET', '/api/fiados');
  assert(r.status === 200 && Array.isArray(r.data), 'Lista fiados responde correctamente');

  const sellerCookie = cookie;
  cookie = adminCookie;
  r = await req('PATCH', `/api/users/${sellerId}`, { active: false });
  assert(r.status === 200, 'Admin puede desactivar una cuenta de vendedor');
  cookie = sellerCookie;
  r = await req('GET', '/api/me');
  assert(r.status === 401, 'Una sesión de usuario desactivado pierde acceso inmediatamente');
  cookie = adminCookie;

  console.log('--- LOGOUT ---');
  r = await req('POST', '/api/logout');
  assert(r.status === 200, 'Logout funciona');
  r = await req('GET', '/api/me');
  assert(r.status === 401, 'Tras logout la sesión ya no es válida');

  console.log(`\n${passed} pruebas pasaron, ${failed} fallaron.`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Error ejecutando pruebas:', e); process.exit(1); });
