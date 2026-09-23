require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { pool, initSchema, withTransaction } = require('./db');
const { requireAuth, requireAdmin } = require('./auth');
const { getOrCreateVariant, recordMovement, createSale, voidSale, getAvailableQuantityForVariant } = require('./inventoryLogic');
const reports = require('./reports');

const app = express();
app.use(express.json());
app.use(
  session({
    // In-memory session store: fine for this app (single small team, one server instance).
    // Sessions reset if the server restarts, which just means logging in again.
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-env',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8, httpOnly: true, sameSite: 'lax' },
  })
);

// Wraps an async route handler so thrown errors are forwarded to Express instead of crashing.
function h(fn) {
  return (req, res, next) => fn(req, res, next).catch((err) => {
    console.error(`API ${req.method} ${req.originalUrl}`, err);
    const statusCode = Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    res.status(statusCode).json({ error: statusCode < 500 ? err.message : 'Error interno del servidor' });
  });
}

// ---------- AUTH ----------
app.post('/api/login', h(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña son obligatorios' });
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 AND active = TRUE', [username]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.fullName = user.full_name;
  req.session.role = user.role;
  res.json({ ok: true, user: { username: user.username, fullName: user.full_name, role: user.role } });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  res.json({ userId: req.session.userId, username: req.session.username, fullName: req.session.fullName, role: req.session.role });
});

// ---------- USERS (admin only) ----------
app.get('/api/users', requireAuth, requireAdmin, h(async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY full_name');
  res.json(rows);
}));

app.post('/api/users', requireAuth, requireAdmin, h(async (req, res) => {
  const { username, password, fullName, role } = req.body || {};
  if (!username || !password || !fullName) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [username, hash, fullName, role === 'vendedor' ? 'vendedor' : 'admin']
    );
    res.json({ id: rows[0].id });
  } catch (e) {
    if (String(e.message).includes('duplicate key')) return res.status(409).json({ error: 'El usuario ya existe' });
    res.status(500).json({ error: 'Error creando usuario' });
  }
}));

app.patch('/api/users/:id', requireAuth, requireAdmin, h(async (req, res) => {
  const { active } = req.body || {};
  await pool.query('UPDATE users SET active = $1 WHERE id = $2', [!!active, req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/admin/reset-data', requireAuth, requireAdmin, h(async (req, res) => {
  const { withTransaction } = require('./db');
  await withTransaction(async (client) => {
    await client.query(`
      TRUNCATE TABLE
        inventory_movements,
        sale_items,
        sales,
        inventory,
        product_variants,
        products,
        categories
      RESTART IDENTITY CASCADE
    `);
    await client.query(
      `INSERT INTO categories (name) VALUES ($1), ($2), ($3), ($4), ($5)`,
      ['Calzado', 'Bolsos', 'Accesorios', 'Camisetas', 'Otros']
    );
  });
  res.json({ ok: true });
}));

// ---------- CATEGORIES ----------
app.get('/api/categories', requireAuth, h(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categories WHERE active = TRUE ORDER BY name');
  res.json(rows);
}));

app.post('/api/categories', requireAuth, h(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    const { rows } = await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING id, name', [name.trim()]);
    res.json(rows[0]);
  } catch (e) {
    if (String(e.message).includes('duplicate key')) return res.status(409).json({ error: 'La categoría ya existe' });
    res.status(500).json({ error: 'Error creando categoría' });
  }
}));

// ---------- PRODUCTS ----------
async function serializeProduct(product) {
  const variantsRes = await pool.query(
    `SELECT pv.id as variant_id, pv.size, COALESCE(i.quantity, 0) as quantity
     FROM product_variants pv LEFT JOIN inventory i ON i.variant_id = pv.id
     WHERE pv.product_id = $1 ORDER BY pv.id`,
    [product.id]
  );
  const variants = variantsRes.rows;
  const totalStock = variants.reduce((s, v) => s + v.quantity, 0);
  const catRes = await pool.query('SELECT name FROM categories WHERE id = $1', [product.category_id]);
  return {
    ...product,
    price: Number(product.price),
    category_name: catRes.rows[0] ? catRes.rows[0].name : null,
    variants,
    total_stock: totalStock,
  };
}

function formatOrderNumber(prefix, count) {
  return `${prefix}-${String(count + 1).padStart(5, '0')}`;
}

async function getVariantContext(client, variantId) {
  const { rows } = await client.query(
    `SELECT pv.id, pv.product_id, pv.size, p.reference, p.name AS product_name, p.price, p.category_id, p.status
     FROM product_variants pv
     JOIN products p ON p.id = pv.product_id
     WHERE pv.id = $1`,
    [variantId]
  );
  if (!rows[0]) {
    const error = new Error('VARIANTE_NO_ENCONTRADA');
    error.code = 'VARIANTE_NO_ENCONTRADA';
    throw error;
  }
  return rows[0];
}

async function getSeparatedSchemaInfo(client = pool) {
  const { rows } = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_name IN ('separated_orders', 'separated_order_items', 'separated_payments')
  `);
  const tableColumns = new Map();
  for (const row of rows) {
    if (!tableColumns.has(row.table_name)) tableColumns.set(row.table_name, new Set());
    tableColumns.get(row.table_name).add(row.column_name);
  }
  const orders = tableColumns.get('separated_orders') || new Set();
  const items = tableColumns.get('separated_order_items') || new Set();
  const payments = tableColumns.get('separated_payments') || new Set();
  return {
    modern: orders.has('separation_number') && orders.has('customer_name') && orders.has('customer_phone') && orders.has('user_id')
      && items.has('separated_order_id') && items.has('quantity_withdrawn')
      && (!payments.size || payments.has('separated_order_id')),
  };
}

async function ensureAvailableForVariant(client, variantId, quantity, contextLabel = 'Producto') {
  const available = await getAvailableQuantityForVariant(client, variantId);
  if (quantity > available) {
    const error = new Error(`${contextLabel}: no hay suficientes unidades disponibles. Disponible: ${available}`);
    error.code = 'STOCK_INSUFICIENTE';
    error.available = available;
    throw error;
  }
}

async function getSeparatedOrderPayload(client, orderId) {
  const orderRes = await client.query(
    `SELECT o.*, u.full_name AS created_by_name,
            o.customer_name AS client_name,
            o.customer_phone AS phone,
            CASE WHEN o.status = 'activo' AND o.due_at < now() THEN TRUE ELSE FALSE END AS is_expired
     FROM separated_orders o
     JOIN users u ON u.id = o.user_id
     WHERE o.id = $1`,
    [orderId]
  );
  const order = orderRes.rows[0];
  if (!order) return null;
  const itemsRes = await client.query(
    `SELECT soi.*, p.reference, p.name AS product_name
     FROM separated_order_items soi
     JOIN product_variants pv ON pv.id = soi.variant_id
     JOIN products p ON p.id = pv.product_id
     WHERE soi.separated_order_id = $1 ORDER BY soi.id`,
    [orderId]
  );
  const paymentRes = await client.query(
    `SELECT sp.*, u.full_name AS user_name FROM separated_payments sp JOIN users u ON u.id = sp.user_id WHERE sp.separated_order_id = $1 ORDER BY sp.created_at DESC`,
    [orderId]
  );
  const paidAmount = paymentRes.rows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return {
    ...order,
    total: Number(order.total),
    paid_amount: paidAmount,
    balance: Number(order.total) - paidAmount,
    items: itemsRes.rows.map((item) => ({
      ...item,
      unit_price: Number(item.unit_price),
      subtotal: Number(item.subtotal),
      quantity_withdrawn: Number(item.quantity_withdrawn || 0),
      retired_quantity: Number(item.quantity_withdrawn || 0),
    })),
    payments: paymentRes.rows.map((item) => ({ ...item, amount: Number(item.amount) })),
  };
}

async function getCreditSalePayload(client, creditId) {
  const creditRes = await client.query(
    `SELECT cs.*, u.full_name AS created_by_name,
            cs.customer_name AS client_name,
            cs.customer_phone AS phone
     FROM credit_sales cs
     JOIN users u ON u.id = cs.user_id
     WHERE cs.id = $1`,
    [creditId]
  );
  const credit = creditRes.rows[0];
  if (!credit) return null;
  const itemsRes = await client.query(
    `SELECT csi.*, p.reference, p.name AS product_name
     FROM credit_sale_items csi
     JOIN product_variants pv ON pv.id = csi.variant_id
     JOIN products p ON p.id = pv.product_id
     WHERE csi.credit_sale_id = $1 ORDER BY csi.id`,
    [creditId]
  );
  const paymentRes = await client.query(
    `SELECT cp.*, u.full_name AS user_name FROM credit_payments cp JOIN users u ON u.id = cp.user_id WHERE cp.credit_sale_id = $1 ORDER BY cp.created_at DESC`,
    [creditId]
  );
  const paidAmount = paymentRes.rows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return {
    ...credit,
    total: Number(credit.total),
    paid_amount: paidAmount,
    balance: Number(credit.total) - paidAmount,
    items: itemsRes.rows.map((item) => ({ ...item, unit_price: Number(item.unit_price), subtotal: Number(item.subtotal) })),
    payments: paymentRes.rows.map((item) => ({ ...item, amount: Number(item.amount) })),
  };
}

app.get('/api/products', requireAuth, h(async (req, res) => {
  const { q } = req.query;
  const params = [];
  let filter = '';
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    filter = 'WHERE p.reference ILIKE $1 OR p.name ILIKE $1 OR c.name ILIKE $1';
  }
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS category_name,
            COALESCE(
              json_agg(
                json_build_object(
                  'variant_id', pv.id,
                  'size', pv.size,
                  'quantity', COALESCE(i.quantity, 0)
                ) ORDER BY pv.id
              ) FILTER (WHERE pv.id IS NOT NULL), '[]'::json
            ) AS variants,
            COALESCE(SUM(i.quantity), 0)::int AS total_stock
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_variants pv ON pv.product_id = p.id
     LEFT JOIN inventory i ON i.variant_id = pv.id
     ${filter}
     GROUP BY p.id, c.name
     ORDER BY p.name`,
    params
  );
  res.json(rows.map((product) => ({
    ...product,
    price: Number(product.price),
    variants: product.variants || [],
    total_stock: Number(product.total_stock),
  })));
}));

app.get('/api/products/:id', requireAuth, h(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(await serializeProduct(rows[0]));
}));

app.get('/api/separados', requireAuth, h(async (req, res) => {
  const { q } = req.query;
  const { modern } = await getSeparatedSchemaInfo();
  let sql = modern ? `
    SELECT DISTINCT ON (o.id) o.*, u.full_name AS created_by_name,
      o.customer_name AS client_name,
      o.customer_phone AS phone,
      COALESCE((SELECT SUM(sp.amount) FROM separated_payments sp WHERE sp.separated_order_id = o.id), 0)::numeric AS paid_amount,
      CASE WHEN o.status = 'activo' AND o.due_at < now() THEN TRUE ELSE FALSE END AS is_expired
    FROM separated_orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN separated_order_items soi ON soi.separated_order_id = o.id
  ` : `
    SELECT DISTINCT ON (o.id) o.*, u.full_name AS created_by_name,
      o.client_name AS client_name,
      o.phone AS phone,
      COALESCE((SELECT SUM(sp.amount) FROM separated_payments sp WHERE sp.order_id = o.id), 0)::numeric AS paid_amount,
      CASE WHEN o.status = 'activo' AND o.due_at < now() THEN TRUE ELSE FALSE END AS is_expired
    FROM separated_orders o
    JOIN users u ON u.id = o.created_by
    LEFT JOIN separated_order_items soi ON soi.order_id = o.id
  `;
  const params = [];
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    sql += modern
      ? ` WHERE o.customer_name ILIKE $1 OR o.customer_phone ILIKE $1 OR soi.product_reference ILIKE $1 OR soi.product_name ILIKE $1`
      : ` WHERE o.client_name ILIKE $1 OR o.phone ILIKE $1 OR soi.product_reference ILIKE $1 OR soi.product_name ILIKE $1`;
  }
  sql += ' ORDER BY o.id DESC, o.created_at DESC';
  const { rows } = await pool.query(sql, params);
  res.json(rows.map((row) => ({
    ...row,
    total: Number(row.total),
    paid_amount: Number(row.paid_amount),
    balance: Number(row.total) - Number(row.paid_amount || 0),
  })));
}));

app.get('/api/separados/:id', requireAuth, h(async (req, res) => {
  const { modern } = await getSeparatedSchemaInfo();
  const orderRes = await pool.query(
    modern ? `SELECT o.*, u.full_name AS created_by_name,
            o.customer_name AS client_name,
            o.customer_phone AS phone,
            CASE WHEN o.status = 'activo' AND o.due_at < now() THEN TRUE ELSE FALSE END AS is_expired
     FROM separated_orders o
     JOIN users u ON u.id = o.user_id
     WHERE o.id = $1` : `SELECT o.*, u.full_name AS created_by_name,
            o.client_name AS client_name,
            o.phone AS phone,
            CASE WHEN o.status = 'activo' AND o.due_at < now() THEN TRUE ELSE FALSE END AS is_expired
     FROM separated_orders o
     JOIN users u ON u.id = o.created_by
     WHERE o.id = $1`,
    [req.params.id]
  );
  const order = orderRes.rows[0];
  if (!order) return res.status(404).json({ error: 'Separado no encontrado' });
  const itemsRes = await pool.query(
    modern ? 'SELECT * FROM separated_order_items WHERE separated_order_id = $1 ORDER BY id' : 'SELECT * FROM separated_order_items WHERE order_id = $1 ORDER BY id',
    [req.params.id]
  );
  const paymentsRes = await pool.query(
    modern ? 'SELECT * FROM separated_payments WHERE separated_order_id = $1 ORDER BY created_at DESC' : 'SELECT * FROM separated_payments WHERE order_id = $1 ORDER BY created_at DESC',
    [req.params.id]
  );
  const paidAmount = paymentsRes.rows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  res.json({
    ...order,
    total: Number(order.total),
    paid_amount: paidAmount,
    balance: Number(order.total) - paidAmount,
    items: itemsRes.rows.map((item) => ({
      ...item,
      unit_price: Number(item.unit_price),
      subtotal: Number(item.subtotal),
      retired_quantity: Number((modern ? item.quantity_withdrawn : item.retired_quantity) || 0),
    })),
    payments: paymentsRes.rows.map((item) => ({ ...item, amount: Number(item.amount) })),
  });
}));

app.post('/api/separados', requireAuth, h(async (req, res) => {
  const { clientName, phone, items, initialPayment = 0, dueAt } = req.body || {};
  if (!clientName || !phone || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Cliente, teléfono y al menos un producto son obligatorios' });
  }
  if (!/^\d{7,15}$/.test(String(phone).replace(/\D/g, ''))) {
    return res.status(400).json({ error: 'El teléfono no es válido' });
  }
  const paymentAmount = Number(initialPayment || 0);
  if (paymentAmount < 0) return res.status(400).json({ error: 'El abono inicial no puede ser negativo' });

  const { modern: useModernSeparatedSchema } = await getSeparatedSchemaInfo();

  const result = await withTransaction(async (client) => {
    let total = 0;
    const preparedItems = [];
    for (const item of items) {
      const qty = Number(item.quantity);
      if (!qty || qty <= 0) throw Object.assign(new Error('Cantidad inválida en el separado'), { statusCode: 400 });
      const variant = await getVariantContext(client, Number(item.variantId));
      await ensureAvailableForVariant(client, variant.id, qty, `${variant.reference}${variant.size ? ' talla ' + variant.size : ''}`);
      const unitPrice = Number(item.unitPrice ?? variant.price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw Object.assign(new Error('Precio inválido para el separado'), { statusCode: 400 });
      const subtotal = qty * unitPrice;
      total += subtotal;
      preparedItems.push({
        variantId: variant.id,
        quantity: qty,
        unitPrice,
        subtotal,
        productReference: variant.reference,
        productName: variant.product_name,
        size: variant.size,
      });
    }
    if (paymentAmount > total) throw Object.assign(new Error('El abono inicial no puede superar el total'), { statusCode: 400 });

    const countRes = await client.query('SELECT COUNT(*)::int AS c FROM separated_orders');
    const dueDate = dueAt ? new Date(dueAt) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const orderNumber = `SEP-${String(countRes.rows[0].c + 1).padStart(5, '0')}`;

    const orderQuery = useModernSeparatedSchema
      ? `INSERT INTO separated_orders (separation_number, customer_name, customer_phone, total, status, due_at, user_id)
         VALUES ($1, $2, $3, $4, 'activo', $5, $6)
         RETURNING id`
      : `INSERT INTO separated_orders (order_number, client_name, phone, total, status, due_at, created_by)
         VALUES ($1, $2, $3, $4, 'activo', $5, $6)
         RETURNING id`;

    const orderValues = useModernSeparatedSchema
      ? [orderNumber, clientName.trim(), phone.trim(), total, dueDate.toISOString(), req.session.userId]
      : [orderNumber, clientName.trim(), phone.trim(), total, dueDate.toISOString(), req.session.userId];

    const orderRes = await client.query(orderQuery, orderValues);
    const orderId = orderRes.rows[0].id;

    for (const item of preparedItems) {
      const itemQuery = useModernSeparatedSchema
        ? `INSERT INTO separated_order_items (separated_order_id, variant_id, product_reference, product_name, size, quantity, quantity_withdrawn, unit_price, subtotal)
           VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)`
        : `INSERT INTO separated_order_items (order_id, variant_id, product_reference, product_name, size, quantity, retired_quantity, unit_price, subtotal)
           VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)`;

      await client.query(itemQuery, [
        orderId,
        item.variantId,
        item.productReference,
        item.productName,
        item.size || null,
        item.quantity,
        item.unitPrice,
        item.subtotal,
      ]);
    }

    if (paymentAmount > 0) {
      const paymentQuery = useModernSeparatedSchema
        ? `INSERT INTO separated_payments (separated_order_id, amount, payment_method, user_id, note)
           VALUES ($1, $2, $3, $4, $5)`
        : `INSERT INTO separated_payments (order_id, amount, payment_method, user_id, note)
           VALUES ($1, $2, $3, $4, $5)`;
      await client.query(paymentQuery, [orderId, paymentAmount, 'efectivo', req.session.userId, 'Abono inicial']);
    }

    return { orderId, orderNumber, total, paidAmount: paymentAmount, status: 'activo', due_at: dueDate.toISOString() };
  });

  res.json(result);
}));

app.post('/api/separados/:id/pagos', requireAuth, h(async (req, res) => {
  const { amount, method = 'efectivo', note } = req.body || {};
  const numericAmount = Number(amount);
  if (!numericAmount || numericAmount <= 0) return res.status(400).json({ error: 'El valor del abono debe ser mayor a cero' });
  const { modern } = await getSeparatedSchemaInfo();
  const order = await pool.query('SELECT * FROM separated_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
  if (!order.rows[0]) return res.status(404).json({ error: 'Separado no encontrado' });
  const currentPaid = Number((await pool.query(
    modern
      ? 'SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM separated_payments WHERE separated_order_id = $1'
      : 'SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM separated_payments WHERE order_id = $1',
    [req.params.id]
  )).rows[0].total || 0);
  const total = Number(order.rows[0].total || 0);
  if (numericAmount > total - currentPaid) return res.status(400).json({ error: 'El abono no puede superar el saldo del separado' });
  const { rows } = await pool.query(
    modern
      ? `INSERT INTO separated_payments (separated_order_id, amount, payment_method, user_id, note)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`
      : `INSERT INTO separated_payments (order_id, amount, payment_method, user_id, note)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.params.id, numericAmount, method, req.session.userId, note || null]
  );
  if (!modern) {
    await pool.query('UPDATE separated_orders SET paid_amount = paid_amount + $1 WHERE id = $2', [numericAmount, req.params.id]);
  }
  res.json({ ok: true, payment: { ...rows[0], amount: Number(rows[0].amount) } });
}));

app.post('/api/separados/:id/retiro', requireAuth, h(async (req, res) => {
  const quantityToRetire = Number(req.body?.quantity ?? 0);
  if (!quantityToRetire || quantityToRetire <= 0) return res.status(400).json({ error: 'La cantidad a retirar debe ser mayor a cero' });

  const result = await withTransaction(async (client) => {
    const { modern } = await getSeparatedSchemaInfo(client);
    const orderRes = await client.query('SELECT * FROM separated_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) throw Object.assign(new Error('Separado no encontrado'), { statusCode: 404 });
    if (order.status === 'anulado') throw Object.assign(new Error('El separado ya está anulado'), { statusCode: 400 });
    const itemsRes = await client.query(
      modern ? 'SELECT * FROM separated_order_items WHERE separated_order_id = $1 ORDER BY id' : 'SELECT * FROM separated_order_items WHERE order_id = $1 ORDER BY id',
      [order.id]
    );
    let remaining = quantityToRetire;
    for (const item of itemsRes) {
      const availableToRetire = Number((modern ? item.quantity - item.quantity_withdrawn : item.quantity - item.retired_quantity) || 0);
      if (availableToRetire <= 0) continue;
      const toRetire = Math.min(remaining, availableToRetire);
      await recordMovement(client, {
        variantId: item.variant_id,
        type: 'ajuste',
        quantityChange: -toRetire,
        reason: `Retiro separado ${modern ? order.separation_number : order.order_number}`,
        userId: req.session.userId,
      });
      await client.query(
        modern
          ? 'UPDATE separated_order_items SET quantity_withdrawn = quantity_withdrawn + $1 WHERE id = $2'
          : 'UPDATE separated_order_items SET retired_quantity = retired_quantity + $1 WHERE id = $2',
        [toRetire, item.id]
      );
      remaining -= toRetire;
      if (remaining <= 0) break;
    }
    if (remaining > 0) throw Object.assign(new Error('No se puede retirar más de lo pendiente en el separado'), { statusCode: 400 });
    const pendingRes = await client.query(
      modern
        ? `SELECT COALESCE(SUM(quantity - quantity_withdrawn), 0)::int AS pending FROM separated_order_items WHERE separated_order_id = $1`
        : `SELECT COALESCE(SUM(quantity - retired_quantity), 0)::int AS pending FROM separated_order_items WHERE order_id = $1`,
      [order.id]
    );
    const pending = Number(pendingRes.rows[0].pending || 0);
    if (pending <= 0) {
      await client.query(
        modern ? "UPDATE separated_orders SET status = 'completado', completed_at = now() WHERE id = $1" : "UPDATE separated_orders SET status = 'completado' WHERE id = $1",
        [order.id]
      );
    }
    return { ok: true, remaining: pending };
  });

  res.json(result);
}));

app.post('/api/separados/:id/anular', requireAuth, h(async (req, res) => {
  const { reason } = req.body || {};
  const { modern } = await getSeparatedSchemaInfo();
  const orderRes = await pool.query('SELECT * FROM separated_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
  if (!orderRes.rows[0]) return res.status(404).json({ error: 'Separado no encontrado' });
  if (orderRes.rows[0].status === 'anulado') return res.status(400).json({ error: 'Este separado ya está anulado' });
  await pool.query(
    modern
      ? `UPDATE separated_orders SET status = 'anulado', voided_at = now(), voided_by = $1, void_reason = $2 WHERE id = $3`
      : `UPDATE separated_orders SET status = 'anulado', canceled_at = now(), canceled_by = $1, cancel_reason = $2 WHERE id = $3`,
    [req.session.userId, reason || null, req.params.id]
  );
  res.json({ ok: true });
}));

app.get('/api/fiados', requireAuth, h(async (req, res) => {
  const { q } = req.query;
  let sql = `
    SELECT DISTINCT ON (cs.id) cs.*, u.full_name AS created_by_name,
      cs.customer_name AS client_name,
      cs.customer_phone AS phone,
      COALESCE((SELECT SUM(cp.amount) FROM credit_payments cp WHERE cp.credit_sale_id = cs.id), 0)::numeric AS paid_amount
    FROM credit_sales cs
    JOIN users u ON u.id = cs.user_id
    LEFT JOIN credit_sale_items csi ON csi.credit_sale_id = cs.id
  `;
  const params = [];
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    sql += ` WHERE cs.customer_name ILIKE $1 OR cs.customer_phone ILIKE $1 OR csi.product_reference ILIKE $1 OR csi.product_name ILIKE $1`;
  }
  sql += ' ORDER BY cs.id DESC, cs.created_at DESC';
  const { rows } = await pool.query(sql, params);
  res.json(rows.map((row) => ({
    ...row,
    total: Number(row.total),
    paid_amount: Number(row.paid_amount),
    balance: Number(row.total) - Number(row.paid_amount || 0),
  })));
}));

app.get('/api/fiados/:id', requireAuth, h(async (req, res) => {
  const creditRes = await pool.query(
    `SELECT cs.*, u.full_name AS created_by_name,
            cs.customer_name AS client_name,
            cs.customer_phone AS phone
     FROM credit_sales cs
     JOIN users u ON u.id = cs.user_id
     WHERE cs.id = $1`,
    [req.params.id]
  );
  const credit = creditRes.rows[0];
  if (!credit) return res.status(404).json({ error: 'Fiado no encontrado' });
  const itemsRes = await pool.query('SELECT * FROM credit_sale_items WHERE credit_sale_id = $1 ORDER BY id', [req.params.id]);
  const paymentsRes = await pool.query('SELECT * FROM credit_payments WHERE credit_sale_id = $1 ORDER BY created_at DESC', [req.params.id]);
  const paidAmount = paymentsRes.rows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  res.json({
    ...credit,
    total: Number(credit.total),
    paid_amount: paidAmount,
    balance: Number(credit.total) - paidAmount,
    items: itemsRes.rows.map((item) => ({ ...item, unit_price: Number(item.unit_price), subtotal: Number(item.subtotal) })),
    payments: paymentsRes.rows.map((item) => ({ ...item, amount: Number(item.amount) })),
  });
}));

app.post('/api/fiados', requireAuth, h(async (req, res) => {
  const { clientName, phone, items, initialPayment = 0 } = req.body || {};
  if (!clientName || !phone || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Cliente, teléfono y al menos un producto son obligatorios' });
  }
  if (!/^\d{7,15}$/.test(String(phone).replace(/\D/g, ''))) {
    return res.status(400).json({ error: 'El teléfono no es válido' });
  }
  const paymentAmount = Number(initialPayment || 0);
  if (paymentAmount < 0) return res.status(400).json({ error: 'El abono inicial no puede ser negativo' });

  const result = await withTransaction(async (client) => {
    let total = 0;
    const preparedItems = [];
    for (const item of items) {
      const qty = Number(item.quantity);
      const unitPrice = Number(item.unitPrice ?? 0);
      if (!qty || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw Object.assign(new Error('Producto o precio inválido en el fiado'), { statusCode: 400 });
      }
      const variant = await getVariantContext(client, Number(item.variantId));
      await ensureAvailableForVariant(client, variant.id, qty, `${variant.reference}${variant.size ? ' talla ' + variant.size : ''}`);
      total += qty * unitPrice;
      preparedItems.push({
        variantId: variant.id,
        quantity: qty,
        unitPrice,
        subtotal: qty * unitPrice,
        productReference: variant.reference,
        productName: variant.product_name,
        size: variant.size,
      });
    }
    if (paymentAmount > total) throw Object.assign(new Error('El abono inicial no puede superar el total del fiado'), { statusCode: 400 });

    const countRes = await client.query('SELECT COUNT(*)::int AS c FROM credit_sales');
    const creditNumber = `FIA-${String(countRes.rows[0].c + 1).padStart(5, '0')}`;
    const creditRes = await client.query(
      `INSERT INTO credit_sales (credit_number, customer_name, customer_phone, total, status, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [creditNumber, clientName.trim(), phone.trim(), total, paymentAmount >= total ? 'pagado' : 'pendiente', req.session.userId]
    );
    const creditId = creditRes.rows[0].id;

    for (const item of preparedItems) {
      await client.query(
        `INSERT INTO credit_sale_items (credit_sale_id, variant_id, product_reference, product_name, size, quantity, unit_price, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [creditId, item.variantId, item.productReference, item.productName, item.size || null, item.quantity, item.unitPrice, item.subtotal]
      );
      await recordMovement(client, {
        variantId: item.variantId,
        type: 'venta',
        quantityChange: -item.quantity,
        reason: `Fiado ${creditNumber}`,
        userId: req.session.userId,
      });
    }

    if (paymentAmount > 0) {
      await client.query(
        `INSERT INTO credit_payments (credit_sale_id, amount, payment_method, user_id, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [creditId, paymentAmount, 'efectivo', req.session.userId, 'Abono inicial']
      );
    }

    return { creditId, creditNumber, total, paidAmount: paymentAmount, status: paymentAmount >= total ? 'pagado' : 'pendiente' };
  });

  res.json(result);
}));

app.post('/api/fiados/:id/pagos', requireAuth, h(async (req, res) => {
  const { amount, method = 'efectivo', note } = req.body || {};
  const numericAmount = Number(amount);
  if (!numericAmount || numericAmount <= 0) return res.status(400).json({ error: 'El valor del abono debe ser mayor a cero' });
  const credit = await pool.query('SELECT * FROM credit_sales WHERE id = $1 FOR UPDATE', [req.params.id]);
  if (!credit.rows[0]) return res.status(404).json({ error: 'Fiado no encontrado' });
  if (credit.rows[0].status === 'anulado') return res.status(400).json({ error: 'Este fiado está anulado' });
  const currentPaid = Number((await pool.query(
    'SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM credit_payments WHERE credit_sale_id = $1',
    [req.params.id]
  )).rows[0].total || 0);
  const total = Number(credit.rows[0].total || 0);
  if (numericAmount > total - currentPaid) return res.status(400).json({ error: 'El abono no puede superar el saldo pendiente' });
  const { rows } = await pool.query(
    `INSERT INTO credit_payments (credit_sale_id, amount, payment_method, user_id, note) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.params.id, numericAmount, method, req.session.userId, note || null]
  );
  const newPaid = currentPaid + numericAmount;
  await pool.query(
    `UPDATE credit_sales SET status = CASE WHEN $1 >= total THEN 'pagado' ELSE 'pendiente' END, paid_at = CASE WHEN $1 >= total THEN now() ELSE paid_at END WHERE id = $2`,
    [newPaid, req.params.id]
  );
  res.json({ ok: true, payment: { ...rows[0], amount: Number(rows[0].amount) } });
}));

app.post('/api/fiados/:id/anular', requireAuth, h(async (req, res) => {
  const { reason } = req.body || {};
  const credit = await pool.query('SELECT * FROM credit_sales WHERE id = $1 FOR UPDATE', [req.params.id]);
  if (!credit.rows[0]) return res.status(404).json({ error: 'Fiado no encontrado' });
  if (credit.rows[0].status === 'anulado') return res.status(400).json({ error: 'Este fiado ya está anulado' });
  await pool.query(
    `UPDATE credit_sales SET status = 'anulado', voided_at = now(), voided_by = $1, void_reason = $2 WHERE id = $3`,
    [req.session.userId, reason || null, req.params.id]
  );
  res.json({ ok: true });
}));

app.post('/api/products', requireAuth, h(async (req, res) => {
  const { reference, name, categoryId, price, description, hasVariants, sizes, initialStock, lowStockThreshold } =
    req.body || {};
  if (!reference || !name || !categoryId || price === undefined) {
    return res.status(400).json({ error: 'Referencia, nombre, categoría y precio son obligatorios' });
  }
  if (Number(price) < 0) return res.status(400).json({ error: 'El precio no puede ser negativo' });

  const { withTransaction } = require('./db');
  try {
    const productId = await withTransaction(async (client) => {
      const insertRes = await client.query(
        `INSERT INTO products (reference, name, category_id, price, description, has_variants, low_stock_threshold)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          reference.trim(),
          name.trim(),
          categoryId,
          price,
          description || null,
          !!hasVariants,
          lowStockThreshold ? Number(lowStockThreshold) : 3,
        ]
      );
      const productId = insertRes.rows[0].id;

      if (hasVariants && Array.isArray(sizes) && sizes.length > 0) {
        for (const s of sizes) {
          const size = String(s.size).trim();
          const qty = Number(s.quantity) || 0;
          const variant = await getOrCreateVariant(client, productId, size);
          if (qty > 0) {
            await recordMovement(client, {
              variantId: variant.id, type: 'entrada', quantityChange: qty, reason: 'Stock inicial', userId: req.session.userId,
            });
          }
        }
      } else {
        const variant = await getOrCreateVariant(client, productId, null);
        const qty = Number(initialStock) || 0;
        if (qty > 0) {
          await recordMovement(client, {
            variantId: variant.id, type: 'entrada', quantityChange: qty, reason: 'Stock inicial', userId: req.session.userId,
          });
        }
      }
      return productId;
    });

    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
    res.json(await serializeProduct(rows[0]));
  } catch (e) {
    if (String(e.message).includes('duplicate key')) return res.status(409).json({ error: 'La referencia ya existe' });
    res.status(500).json({ error: 'Error creando producto: ' + e.message });
  }
}));

app.put('/api/products/:id', requireAuth, h(async (req, res) => {
  const { name, categoryId, price, description, status, lowStockThreshold } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
  const product = rows[0];
  if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
  await pool.query(
    `UPDATE products SET name = $1, category_id = $2, price = $3, description = $4, status = $5, low_stock_threshold = $6, updated_at = now()
     WHERE id = $7`,
    [
      name ?? product.name,
      categoryId ?? product.category_id,
      price !== undefined ? price : product.price,
      description !== undefined ? description : product.description,
      status ?? product.status,
      lowStockThreshold !== undefined ? lowStockThreshold : product.low_stock_threshold,
      req.params.id,
    ]
  );
  const updated = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
  res.json(await serializeProduct(updated.rows[0]));
}));

app.post('/api/products/:id/clear-stock', requireAuth, requireAdmin, h(async (req, res) => {
  const { withTransaction } = require('./db');
  try {
    await withTransaction(async (client) => {
      const productRes = await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [req.params.id]);
      const product = productRes.rows[0];
      if (!product) {
        const error = new Error('PRODUCTO_NO_ENCONTRADO');
        error.code = 'PRODUCTO_NO_ENCONTRADO';
        throw error;
      }
      const variantsRes = await client.query(
        `SELECT pv.id, i.quantity
         FROM product_variants pv
         LEFT JOIN inventory i ON i.variant_id = pv.id
         WHERE pv.product_id = $1`,
        [product.id]
      );
      for (const variant of variantsRes.rows) {
        if (variant.quantity > 0) {
          await recordMovement(client, {
            variantId: variant.id,
            type: 'ajuste',
            quantityChange: -variant.quantity,
            reason: 'Inventario vaciado manualmente',
            userId: req.session.userId,
          });
        }
      }
    });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'PRODUCTO_NO_ENCONTRADO') return res.status(404).json({ error: 'Producto no encontrado' });
    throw e;
  }
}));

app.delete('/api/products/:id', requireAuth, requireAdmin, h(async (req, res) => {
  const { withTransaction } = require('./db');
  try {
    await withTransaction(async (client) => {
      const productRes = await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!productRes.rows[0]) {
        const error = new Error('PRODUCTO_NO_ENCONTRADO');
        error.code = 'PRODUCTO_NO_ENCONTRADO';
        throw error;
      }
      const historyRes = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM sale_items si JOIN product_variants pv ON pv.id = si.variant_id WHERE pv.product_id = $1
         ) AS has_sales`,
        [req.params.id]
      );
      if (historyRes.rows[0].has_sales) {
        const error = new Error('PRODUCTO_CON_VENTAS');
        error.code = 'PRODUCTO_CON_VENTAS';
        throw error;
      }
      await client.query(
        `DELETE FROM inventory_movements im
         USING product_variants pv
         WHERE im.variant_id = pv.id AND pv.product_id = $1`,
        [req.params.id]
      );
      await client.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'PRODUCTO_NO_ENCONTRADO') return res.status(404).json({ error: 'Producto no encontrado' });
    if (e.code === 'PRODUCTO_CON_VENTAS') {
      return res.status(409).json({ error: 'No se puede eliminar: el producto tiene ventas registradas. Puedes vaciar su stock y marcarlo como inactivo.' });
    }
    throw e;
  }
}));

// ---------- INVENTORY ----------
app.get('/api/inventory/summary', requireAuth, h(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(quantity), 0)::int AS total_units FROM inventory'
  );
  res.json({ totalUnits: rows[0].total_units });
}));

app.post('/api/inventory/entry', requireAuth, h(async (req, res) => {
  const { variantId, productId, newSize, quantity, reason } = req.body || {};
  const qty = Number(quantity);
  if ((!variantId && !productId) || !qty || qty <= 0) return res.status(400).json({ error: 'Variante y cantidad válida son obligatorias' });
  const { withTransaction } = require('./db');
  try {
    const result = await withTransaction(async (client) => {
      let entryVariantId = variantId;
      if (!entryVariantId) {
        const size = String(newSize || '').trim();
        if (!size) throw new Error('Indica la nueva talla');
        const productRes = await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [productId]);
        if (!productRes.rows[0]) throw new Error('Producto no encontrado');
        const variant = await getOrCreateVariant(client, productId, size);
        entryVariantId = variant.id;
      }
      const newQty = await recordMovement(client, {
        variantId: entryVariantId,
        type: 'entrada',
        quantityChange: qty,
        reason: reason || 'Entrada de mercancía',
        userId: req.session.userId,
      });
      return { newQuantity: newQty, variantId: entryVariantId };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/inventory/adjust', requireAuth, h(async (req, res) => {
  const { variantId, newQuantity, reason } = req.body || {};
  if (!variantId || newQuantity === undefined || newQuantity < 0)
    return res.status(400).json({ error: 'Variante y nueva cantidad válida son obligatorias' });
  const invRes = await pool.query('SELECT quantity FROM inventory WHERE variant_id = $1', [variantId]);
  if (!invRes.rows[0]) return res.status(404).json({ error: 'Variante no encontrada' });
  const diff = Number(newQuantity) - invRes.rows[0].quantity;
  const { withTransaction } = require('./db');
  try {
    const newQty = await withTransaction((client) =>
      recordMovement(client, { variantId, type: 'ajuste', quantityChange: diff, reason: reason || 'Ajuste de inventario', userId: req.session.userId })
    );
    res.json({ ok: true, newQuantity: newQty });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.get('/api/inventory/movements', requireAuth, h(async (req, res) => {
  const { variantId, limit } = req.query;
  let rows;
  if (variantId) {
    const result = await pool.query(
      'SELECT * FROM inventory_movements WHERE variant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [variantId, Number(limit) || 100]
    );
    rows = result.rows;
  } else {
    const result = await pool.query('SELECT * FROM inventory_movements ORDER BY created_at DESC, id DESC LIMIT $1', [Number(limit) || 100]);
    rows = result.rows;
  }
  res.json(rows);
}));

app.get('/api/inventory/low-stock', requireAuth, h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.reference, p.name, p.low_stock_threshold,
            COALESCE(SUM(i.quantity),0)::int as total_stock
     FROM products p
     JOIN product_variants pv ON pv.product_id = p.id
     LEFT JOIN inventory i ON i.variant_id = pv.id
     WHERE p.status = 'activo'
     GROUP BY p.id
     HAVING COALESCE(SUM(i.quantity),0) <= p.low_stock_threshold
     ORDER BY total_stock ASC`
  );
  res.json(rows);
}));

// ---------- SALES ----------
app.post('/api/sales', requireAuth, h(async (req, res) => {
  const { items, paymentMethod = 'no_especificado', paymentDestination = null } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'El carrito está vacío' });
  if (!['efectivo', 'transferencia', 'addi', 'no_especificado'].includes(paymentMethod)) {
    return res.status(400).json({ error: 'Método de pago inválido' });
  }
  if (paymentMethod === 'transferencia' && !['nequi', 'qr', 'daviplata'].includes(paymentDestination)) {
    return res.status(400).json({ error: 'Indica dónde llegó la transferencia' });
  }
  if (paymentMethod !== 'transferencia' && paymentDestination !== null) {
    return res.status(400).json({ error: 'El destino solo aplica para transferencias' });
  }

  const preparedItems = [];
  const { withTransaction } = require('./db');
  try {
    await withTransaction(async (client) => {
      for (const it of items) {
        const variant = await getVariantContext(client, Number(it.variantId));
        const qty = Number(it.quantity);
        if (!qty || qty <= 0) throw Object.assign(new Error('Cantidad inválida en el carrito'), { statusCode: 400 });
        await ensureAvailableForVariant(client, variant.id, qty, `${variant.reference}${variant.size ? ' talla ' + variant.size : ''}`);
        preparedItems.push({
          variantId: variant.id,
          quantity: qty,
          unitPrice: Number(variant.price),
          productReference: variant.reference,
          productName: variant.product_name,
          categoryId: variant.category_id,
          size: variant.size,
        });
      }
    });
    const result = await createSale(preparedItems, req.session.userId, paymentMethod, paymentDestination);
    res.json(result);
  } catch (e) {
    if (e.code === 'STOCK_INSUFICIENTE') return res.status(400).json({ error: `Stock insuficiente. Disponible: ${e.available}` });
    if (e.statusCode === 400) return res.status(400).json({ error: e.message });
    if (e.code === 'VARIANTE_NO_ENCONTRADA') return res.status(404).json({ error: `Variante no encontrada (id ${req.body.items[0]?.variantId})` });
    res.status(500).json({ error: 'Error registrando la venta: ' + e.message });
  }
}));

app.get('/api/sales', requireAuth, h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, u.full_name as user_name FROM sales s JOIN users u ON u.id = s.user_id
     ORDER BY s.created_at DESC, s.id DESC LIMIT 200`
  );
  res.json(rows.map((r) => ({ ...r, total: Number(r.total) })));
}));

app.get('/api/sales/:id', requireAuth, h(async (req, res) => {
  const saleRes = await pool.query(
    `SELECT s.*, u.full_name as user_name FROM sales s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [req.params.id]
  );
  const sale = saleRes.rows[0];
  if (!sale) return res.status(404).json({ error: 'Venta no encontrada' });
  const itemsRes = await pool.query('SELECT * FROM sale_items WHERE sale_id = $1', [sale.id]);
  res.json({
    ...sale,
    total: Number(sale.total),
    items: itemsRes.rows.map((it) => ({ ...it, unit_price: Number(it.unit_price), subtotal: Number(it.subtotal) })),
  });
}));

app.post('/api/sales/:id/void', requireAuth, h(async (req, res) => {
  const { reason } = req.body || {};
  try {
    await voidSale(Number(req.params.id), req.session.userId, reason);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'VENTA_YA_ANULADA') return res.status(400).json({ error: 'Esta venta ya fue anulada' });
    if (e.code === 'VENTA_NO_ENCONTRADA') return res.status(404).json({ error: 'Venta no encontrada' });
    res.status(500).json({ error: 'Error anulando la venta: ' + e.message });
  }
}));

// ---------- DASHBOARD ----------
app.get('/api/dashboard', requireAuth, h(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const t = await reports.totals(today, today);
  const [lowStock, inventoryTotal, expiredSeparated] = await Promise.all([
    pool.query(
    `SELECT COUNT(*)::int as c FROM (
       SELECT p.id, COALESCE(SUM(i.quantity),0) as total_stock
       FROM products p JOIN product_variants pv ON pv.product_id = p.id
       LEFT JOIN inventory i ON i.variant_id = pv.id
       WHERE p.status = 'activo'
       GROUP BY p.id HAVING COALESCE(SUM(i.quantity),0) <= p.low_stock_threshold
     ) x`
    ),
    pool.query('SELECT COALESCE(SUM(quantity), 0)::int AS total_units FROM inventory'),
    pool.query("SELECT COUNT(*)::int AS c FROM separated_orders WHERE status = 'activo' AND due_at < now()"),
  ]);
  res.json({
    salesToday: t.revenue,
    salesCountToday: t.saleCount,
    itemsSoldToday: t.itemsSold,
    lowStockCount: lowStock.rows[0].c,
    inventoryUnits: inventoryTotal.rows[0].total_units,
    expiredSeparatedCount: expiredSeparated.rows[0].c,
  });
}));

// ---------- REPORTS ----------
app.get('/api/reports/overview', requireAuth, h(async (req, res) => {
  const { from, to } = req.query;
  const [t, inv] = await Promise.all([reports.totals(from, to), reports.inventoryValue()]);
  res.json({ ...t, inventoryValue: inv.totalValue, inventoryUnits: inv.totalUnits });
}));

app.get('/api/reports/sales-timeline', requireAuth, h(async (req, res) => {
  const { from, to, groupBy } = req.query;
  res.json(await reports.salesSummary(from, to, groupBy));
}));

app.get('/api/reports/top-products', requireAuth, h(async (req, res) => {
  const { from, to, limit } = req.query;
  res.json(await reports.topProducts(from, to, Number(limit) || 10));
}));

app.get('/api/reports/by-category', requireAuth, h(async (req, res) => {
  const { from, to } = req.query;
  res.json(await reports.byCategory(from, to));
}));

app.get('/api/reports/payment-summary', requireAuth, h(async (req, res) => {
  const { from, to } = req.query;
  res.json(await reports.paymentSummary(from, to));
}));

app.get('/api/reports/movements', requireAuth, h(async (req, res) => {
  const { from, to } = req.query;
  res.json(await reports.movementsSummary(from, to));
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  initSchema()
    .then(() => {
      app.listen(PORT, () => console.log(`Marce Brillo y Estilo escuchando en puerto ${PORT}`));
    })
    .catch((err) => {
      console.error('No se pudo inicializar la base de datos:', err.message);
      process.exit(1);
    });
}

module.exports = app;
