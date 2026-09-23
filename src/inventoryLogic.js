const { pool, withTransaction } = require('./db');

async function genSaleNumber(client) {
  const { rows } = await client.query('SELECT COUNT(*)::int as c FROM sales');
  const n = rows[0].c + 1;
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `V-${ymd}-${String(n).padStart(4, '0')}`;
}

async function getOrCreateVariant(client, productId, size) {
  const normSize = size || null;
  const existing = await client.query(
    'SELECT * FROM product_variants WHERE product_id = $1 AND size IS NOT DISTINCT FROM $2',
    [productId, normSize]
  );
  if (existing.rows[0]) return existing.rows[0];

  const inserted = await client.query(
    'INSERT INTO product_variants (product_id, size) VALUES ($1, $2) RETURNING *',
    [productId, normSize]
  );
  const variant = inserted.rows[0];
  await client.query('INSERT INTO inventory (variant_id, quantity) VALUES ($1, 0)', [variant.id]);
  return variant;
}

// Applies a signed quantity change to a variant's stock and logs the movement.
// Must be called with a client that is inside an active transaction.
async function recordMovement(client, { variantId, type, quantityChange, reason, saleId, userId }) {
  const invRes = await client.query('SELECT quantity FROM inventory WHERE variant_id = $1 FOR UPDATE', [variantId]);
  const current = invRes.rows[0] ? invRes.rows[0].quantity : 0;
  const newQty = current + quantityChange;
  if (newQty < 0) {
    const err = new Error('STOCK_INSUFICIENTE');
    err.code = 'STOCK_INSUFICIENTE';
    err.available = current;
    throw err;
  }

  await client.query('UPDATE inventory SET quantity = $1 WHERE variant_id = $2', [newQty, variantId]);

  const variantRes = await client.query(
    `SELECT pv.size, p.reference FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.id = $1`,
    [variantId]
  );
  const variant = variantRes.rows[0];

  await client.query(
    `INSERT INTO inventory_movements
     (variant_id, product_reference, size, type, quantity_change, resulting_quantity, reason, sale_id, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [variantId, variant.reference, variant.size, type, quantityChange, newQty, reason || null, saleId || null, userId]
  );
  return newQty;
}

// items: [{ variantId, quantity, unitPrice, productReference, productName, size, categoryId }]
async function createSale(items, userId, paymentMethod = 'no_especificado', paymentDestination = null) {
  if (!items || items.length === 0) {
    const err = new Error('CARRITO_VACIO');
    err.code = 'CARRITO_VACIO';
    throw err;
  }
  return withTransaction(async (client) => {
    const total = items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);
    const saleNumber = await genSaleNumber(client);
    const saleRes = await client.query(
      'INSERT INTO sales (sale_number, user_id, total, payment_method, payment_destination, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [saleNumber, userId, total, paymentMethod, paymentDestination, 'completada']
    );
    const saleId = saleRes.rows[0].id;

    for (const it of items) {
      await client.query(
        `INSERT INTO sale_items (sale_id, variant_id, product_reference, product_name, category_id, size, quantity, unit_price, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [saleId, it.variantId, it.productReference, it.productName, it.categoryId || null, it.size || null, it.quantity, it.unitPrice, it.unitPrice * it.quantity]
      );
      await recordMovement(client, {
        variantId: it.variantId,
        type: 'venta',
        quantityChange: -it.quantity,
        reason: `Venta ${saleNumber}`,
        saleId,
        userId,
      });
    }
    return { saleId, saleNumber, total };
  });
}

async function voidSale(saleId, userId, reason) {
  return withTransaction(async (client) => {
    const saleRes = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [saleId]);
    const sale = saleRes.rows[0];
    if (!sale) {
      const err = new Error('VENTA_NO_ENCONTRADA');
      err.code = 'VENTA_NO_ENCONTRADA';
      throw err;
    }
    if (sale.status === 'anulada') {
      const err = new Error('VENTA_YA_ANULADA');
      err.code = 'VENTA_YA_ANULADA';
      throw err;
    }
    const itemsRes = await client.query('SELECT * FROM sale_items WHERE sale_id = $1', [saleId]);
    for (const it of itemsRes.rows) {
      await recordMovement(client, {
        variantId: it.variant_id,
        type: 'devolucion',
        quantityChange: it.quantity,
        reason: `Anulación ${sale.sale_number}`,
        saleId,
        userId,
      });
    }
    await client.query(
      `UPDATE sales SET status = 'anulada', voided_at = now(), voided_by = $1, void_reason = $2 WHERE id = $3`,
      [userId, reason || null, saleId]
    );
    return true;
  });
}

async function getReservedQuantityForVariant(client, variantId) {
  const { rows: schemaRows } = await client.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_name IN ('separated_orders', 'separated_order_items')`
  );
  const tableColumns = new Map();
  for (const row of schemaRows) {
    if (!tableColumns.has(row.table_name)) tableColumns.set(row.table_name, new Set());
    tableColumns.get(row.table_name).add(row.column_name);
  }
  const orders = tableColumns.get('separated_orders') || new Set();
  const items = tableColumns.get('separated_order_items') || new Set();
  const useModernSeparatedSchema = orders.has('separation_number') && orders.has('customer_name')
    && orders.has('customer_phone') && orders.has('user_id')
    && items.has('separated_order_id') && items.has('quantity_withdrawn');
  const query = useModernSeparatedSchema
    ? `SELECT COALESCE(SUM(soi.quantity - soi.quantity_withdrawn), 0)::int AS reserved
       FROM separated_order_items soi
       JOIN separated_orders so ON so.id = soi.separated_order_id
       WHERE soi.variant_id = $1 AND so.status = 'activo'`
    : `SELECT COALESCE(SUM(soi.quantity - soi.retired_quantity), 0)::int AS reserved
       FROM separated_order_items soi
       JOIN separated_orders so ON so.id = soi.order_id
       WHERE soi.variant_id = $1 AND so.status = 'activo'`;
  const { rows } = await client.query(query, [variantId]);
  return Number(rows[0]?.reserved || 0);
}

async function getAvailableQuantityForVariant(client, variantId) {
  const inventoryRes = await client.query('SELECT COALESCE(quantity, 0)::int AS quantity FROM inventory WHERE variant_id = $1', [variantId]);
  const physical = Number(inventoryRes.rows[0]?.quantity || 0);
  const reserved = await getReservedQuantityForVariant(client, variantId);
  return physical - reserved;
}

module.exports = {
  getOrCreateVariant,
  recordMovement,
  createSale,
  voidSale,
  getReservedQuantityForVariant,
  getAvailableQuantityForVariant,
  pool,
};
