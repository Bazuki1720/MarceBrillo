const { pool } = require('./db');

function businessDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(day, amount) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

// Normalizes optional from/to query params into a safe date range.
// Defaults to the last 30 days (inclusive of today) when not provided.
function resolveRange(from, to) {
  const today = businessDate();
  for (const day of [from, to].filter(Boolean)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
      const error = new Error('El rango de fechas no es válido');
      error.statusCode = 400;
      throw error;
    }
  }
  const toDay = to || today;
  const fromDay = from || shiftDate(toDay, -29);
  if (fromDay > toDay) {
    const error = new Error('La fecha inicial no puede ser posterior a la fecha final');
    error.statusCode = 400;
    throw error;
  }
  return {
    fromDate: new Date(`${fromDay}T00:00:00-05:00`),
    toDate: new Date(`${toDay}T23:59:59.999-05:00`),
  };
}

async function salesSummary(from, to, groupBy) {
  const { fromDate, toDate } = resolveRange(from, to);
  const bucket = groupBy === 'month' ? 'month' : groupBy === 'week' ? 'week' : 'day';
  const { rows } = await pool.query(
    `WITH income_events AS (
       SELECT created_at AS occurred_at, total AS amount
       FROM sales WHERE status = 'completada'
       UNION ALL
       SELECT created_at AS occurred_at, amount FROM separated_payments
       UNION ALL
       SELECT created_at AS occurred_at, amount FROM credit_payments
     )
     SELECT date_trunc($3, occurred_at AT TIME ZONE 'America/Bogota') as period,
            COALESCE(SUM(amount), 0) as total,
            COUNT(*)::int as transaction_count
     FROM income_events
     WHERE occurred_at BETWEEN $1 AND $2
     GROUP BY period
     ORDER BY period ASC`,
    [fromDate, toDate, bucket]
  );
  return rows.map((r) => ({ period: r.period, total: Number(r.total), transactionCount: r.transaction_count }));
}

async function totals(from, to) {
  const { fromDate, toDate } = resolveRange(from, to);
  const [salesRes, paymentsRes, itemsRes, voidedRes] = await Promise.all([
    pool.query(
    `SELECT COALESCE(SUM(total),0) as total, COUNT(*)::int as count
     FROM sales WHERE status = 'completada' AND created_at BETWEEN $1 AND $2`,
    [fromDate, toDate]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0) AS total
       FROM (
         SELECT amount, created_at FROM separated_payments
         UNION ALL
         SELECT amount, created_at FROM credit_payments
       ) payments
       WHERE created_at BETWEEN $1 AND $2`,
      [fromDate, toDate]
    ),
    pool.query(
    `SELECT COALESCE(SUM(si.quantity),0)::int as qty
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.status = 'completada' AND s.created_at BETWEEN $1 AND $2`,
    [fromDate, toDate]
    ),
    pool.query(
    `SELECT COUNT(*)::int as count, COALESCE(SUM(total),0) as total
     FROM sales WHERE status = 'anulada' AND created_at BETWEEN $1 AND $2`,
    [fromDate, toDate]
    ),
  ]);
  const directSalesRevenue = Number(salesRes.rows[0].total);
  const paymentRevenue = Number(paymentsRes.rows[0].total);
  return {
    revenue: directSalesRevenue + paymentRevenue,
    directSalesRevenue,
    paymentRevenue,
    paymentCount: paymentsRes.rows[0].count,
    saleCount: salesRes.rows[0].count,
    itemsSold: itemsRes.rows[0].qty,
    avgTicket: salesRes.rows[0].count > 0 ? directSalesRevenue / salesRes.rows[0].count : 0,
    voidedCount: voidedRes.rows[0].count,
    voidedTotal: Number(voidedRes.rows[0].total),
  };
}

async function topProducts(from, to, limit) {
  const { fromDate, toDate } = resolveRange(from, to);
  const { rows } = await pool.query(
    `SELECT si.product_reference, si.product_name,
            SUM(si.quantity)::int as units_sold,
            SUM(si.subtotal) as revenue
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.status = 'completada' AND s.created_at BETWEEN $1 AND $2
     GROUP BY si.product_reference, si.product_name
     ORDER BY units_sold DESC
     LIMIT $3`,
    [fromDate, toDate, limit || 10]
  );
  return rows.map((r) => ({ reference: r.product_reference, name: r.product_name, unitsSold: r.units_sold, revenue: Number(r.revenue) }));
}

async function byCategory(from, to) {
  const { fromDate, toDate } = resolveRange(from, to);
  const { rows } = await pool.query(
    `SELECT c.name as category_name,
            SUM(si.quantity)::int as units_sold,
            SUM(si.subtotal) as revenue
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     LEFT JOIN categories c ON c.id = si.category_id
     WHERE s.status = 'completada' AND s.created_at BETWEEN $1 AND $2
     GROUP BY c.name
     ORDER BY revenue DESC`,
    [fromDate, toDate]
  );
  return rows.map((r) => ({ category: r.category_name || 'Sin categoría', unitsSold: r.units_sold, revenue: Number(r.revenue) }));
}

async function paymentSummary(from, to) {
  const { fromDate, toDate } = resolveRange(from, to);
  const { rows } = await pool.query(
    `WITH payment_events AS (
       SELECT CASE
                WHEN payment_method = 'transferencia' AND payment_destination IS NOT NULL THEN payment_destination
                ELSE payment_method
              END AS payment_method,
              NULL::text AS payment_destination, total AS amount, created_at
       FROM sales WHERE status = 'completada'
       UNION ALL
       SELECT payment_method, NULL::text AS payment_destination, amount, created_at FROM separated_payments
       UNION ALL
       SELECT payment_method, NULL::text AS payment_destination, amount, created_at FROM credit_payments
     )
     SELECT payment_method, payment_destination,
            COUNT(*)::int as transaction_count, COALESCE(SUM(amount), 0) as total
     FROM payment_events
     WHERE created_at BETWEEN $1 AND $2
     GROUP BY payment_method, payment_destination
     ORDER BY total DESC`,
    [fromDate, toDate]
  );
  return rows.map((r) => ({
    method: r.payment_method,
    destination: r.payment_destination,
    transactionCount: r.transaction_count,
    total: Number(r.total),
  }));
}

async function movementsSummary(from, to) {
  const { fromDate, toDate } = resolveRange(from, to);
  const { rows } = await pool.query(
    `SELECT type, COUNT(*)::int as movement_count, SUM(quantity_change)::int as net_change
     FROM inventory_movements
     WHERE created_at BETWEEN $1 AND $2
     GROUP BY type`,
    [fromDate, toDate]
  );
  return rows.map((r) => ({ type: r.type, movementCount: r.movement_count, netChange: r.net_change }));
}

async function inventoryValue() {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(i.quantity * p.price), 0) as total_value,
            COALESCE(SUM(i.quantity), 0)::int as total_units
     FROM inventory i
     JOIN product_variants pv ON pv.id = i.variant_id
     JOIN products p ON p.id = pv.product_id
     WHERE p.status = 'activo'`
  );
  return { totalValue: Number(rows[0].total_value), totalUnits: rows[0].total_units };
}

module.exports = { salesSummary, totals, topProducts, byCategory, paymentSummary, movementsSummary, inventoryValue, resolveRange, businessDate };
