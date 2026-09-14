// End-to-end tests against a running server (see tests/README or npm test wrapper).
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

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

async function run() {
  console.log('--- LOGIN ---');
  let r = await req('POST', '/api/login', { username: 'nope', password: 'wrong' });
  assert(r.status === 401, 'Login con credenciales incorrectas es rechazado');

  r = await req('POST', '/api/login', { username: 'admin', password: 'Marce2026!' });
  assert(r.status === 200, 'Login con credenciales correctas funciona');

  r = await req('GET', '/api/me');
  assert(r.status === 200 && r.data.username === 'admin', 'Sesión activa devuelve el usuario');

  console.log('--- CATEGORIES ---');
  r = await req('GET', '/api/categories');
  assert(r.status === 200 && r.data.length >= 5, 'Categorías por defecto existen');

  r = await req('POST', '/api/categories', { name: 'Cinturones-Test' });
  assert(r.status === 200, 'Crear categoría nueva funciona');
  const catId = r.data.id;

  r = await req('POST', '/api/categories', { name: 'Cinturones-Test' });
  assert(r.status === 409, 'No permite categorías duplicadas');

  console.log('--- PRODUCTS ---');
  r = await req('POST', '/api/products', {
    reference: 'AJ-TEST-45', name: 'Sandalia test', categoryId: catId, price: 150000,
    hasVariants: true, sizes: [{ size: '35', quantity: 2 }, { size: '36', quantity: 3 }],
  });
  assert(r.status === 200, 'Crear producto con tallas funciona');
  const productWithSizes = r.data;
  assert(productWithSizes.total_stock === 5, 'Stock inicial con tallas es correcto (2+3=5)');

  r = await req('POST', '/api/products', {
    reference: 'AJ-TEST-45', name: 'Duplicado', categoryId: catId, price: 1000, hasVariants: false, initialStock: 1,
  });
  assert(r.status === 409, 'No permite referencias duplicadas');

  r = await req('POST', '/api/products', {
    reference: 'BOL-TEST-12', name: 'Bolso test', categoryId: catId, price: 90000,
    hasVariants: false, initialStock: 5,
  });
  assert(r.status === 200, 'Crear producto sin tallas funciona');
  const productNoSizes = r.data;
  assert(productNoSizes.total_stock === 5, 'Stock inicial sin tallas es correcto');
  assert(productNoSizes.variants.length === 1 && productNoSizes.variants[0].size === null, 'Producto sin tallas tiene una única variante sin talla');

  console.log('--- INVENTORY ENTRY ---');
  const variant35 = productWithSizes.variants.find((v) => v.size === '35');
  r = await req('POST', '/api/inventory/entry', { variantId: variant35.variant_id, quantity: 4, reason: 'Reposición' });
  assert(r.status === 200 && r.data.newQuantity === 6, 'Entrada de inventario suma correctamente (2+4=6)');

  console.log('--- ADJUSTMENTS ---');
  r = await req('POST', '/api/inventory/adjust', { variantId: variant35.variant_id, newQuantity: 4, reason: 'Conteo físico' });
  assert(r.status === 200 && r.data.newQuantity === 4, 'Ajuste de inventario corrige a la cantidad indicada');

  console.log('--- SALES: single item ---');
  const variant36 = productWithSizes.variants.find((v) => v.size === '36');
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
    reference: 'PRC-TEST', name: 'Producto precio', categoryId: catId, price: 100000, hasVariants: false, initialStock: 10,
  });
  const priceProduct = r.data;
  r = await req('POST', '/api/sales', { items: [{ variantId: priceProduct.variants[0].variant_id, quantity: 1 }] });
  const saleAtOldPrice = r.data.saleId;
  await req('PUT', '/api/products/' + priceProduct.id, { price: 170000 });
  r = await req('GET', '/api/sales/' + saleAtOldPrice);
  assert(r.data.items[0].unit_price === 100000, 'La venta conserva el precio histórico aunque el precio actual cambie');

  console.log('--- SEARCH ---');
  r = await req('GET', '/api/products?q=AJ');
  assert(r.data.some((p) => p.reference === 'AJ-TEST-45'), 'Búsqueda parcial por referencia funciona');

  console.log('--- REPORTS ---');
  r = await req('GET', '/api/reports/overview');
  assert(r.status === 200 && typeof r.data.revenue === 'number', 'Informe general (overview) responde con ingresos numéricos');
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
  r = await req('POST', '/api/users', { username: 'vendedora1', password: 'clave123', fullName: 'Vendedora Uno', role: 'vendedor' });
  assert(r.status === 200, 'Admin puede crear usuarios');

  const adminCookie = cookie;
  cookie = '';
  r = await req('POST', '/api/login', { username: 'vendedora1', password: 'clave123' });
  assert(r.status === 200, 'Vendedora puede iniciar sesión');

  r = await req('GET', '/api/users');
  assert(r.status === 403, 'Vendedor sin rol admin no puede listar usuarios');

  r = await req('POST', '/api/sales', { items: [{ variantId: priceProduct.variants[0].variant_id, quantity: 1 }] });
  assert(r.status === 200, 'Vendedor sí puede registrar ventas');

  console.log('--- LOGOUT ---');
  r = await req('POST', '/api/logout');
  assert(r.status === 200, 'Logout funciona');
  r = await req('GET', '/api/me');
  assert(r.status === 401, 'Tras logout la sesión ya no es válida');

  cookie = adminCookie;

  console.log(`\n${passed} pruebas pasaron, ${failed} fallaron.`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Error ejecutando pruebas:', e); process.exit(1); });
