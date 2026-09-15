require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { pool, initSchema } = require('./db');
const { requireAuth, requireAdmin } = require('./auth');
const { getOrCreateVariant, recordMovement, createSale, voidSale } = require('./inventoryLogic');
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
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
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
  for (const it of items) {
    const variantRes = await pool.query(
      `SELECT pv.*, p.reference, p.name as product_name, p.price, p.status, p.category_id
       FROM product_variants pv JOIN products p ON p.id = pv.product_id
       WHERE pv.id = $1`,
      [it.variantId]
    );
    const variant = variantRes.rows[0];
    if (!variant) return res.status(404).json({ error: `Variante no encontrada (id ${it.variantId})` });
    const qty = Number(it.quantity);
    if (!qty || qty <= 0) return res.status(400).json({ error: 'Cantidad inválida en el carrito' });
    const invRes = await pool.query('SELECT quantity FROM inventory WHERE variant_id = $1', [variant.id]);
    const available = invRes.rows[0] ? invRes.rows[0].quantity : 0;
    if (qty > available) {
      return res.status(400).json({
        error: `No hay suficientes unidades de ${variant.reference}${variant.size ? ' talla ' + variant.size : ''}. Disponible: ${available}`,
      });
    }
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

  try {
    const result = await createSale(preparedItems, req.session.userId, paymentMethod, paymentDestination);
    res.json(result);
  } catch (e) {
    if (e.code === 'STOCK_INSUFICIENTE') return res.status(400).json({ error: `Stock insuficiente. Disponible: ${e.available}` });
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
  const [lowStock, inventoryTotal] = await Promise.all([
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
  ]);
  res.json({
    salesToday: t.revenue,
    salesCountToday: t.saleCount,
    itemsSoldToday: t.itemsSold,
    lowStockCount: lowStock.rows[0].c,
    inventoryUnits: inventoryTotal.rows[0].total_units,
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
