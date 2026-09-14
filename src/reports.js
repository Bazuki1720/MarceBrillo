const { pool } = require('./db');

// Normalizes optional from/to query params into a safe date range.
// Defaults to the last 30 days (inclusive of today) when not provided.
function resolveRange(from, to) {
  const toDate = to ? new Date(to + 'T23:59:59') : new Date();
  const fromDate = from ? new Date(from + 'T00:00:00') : new Date(toDate.getTime() - 29 * 24 * 60 * 60 * 1000);
  return { fromDate, toDate };
}

async function salesSummary(from, to, groupBy) {
  const { fromDate, toDate } = resolveRange(from, to);
  const bucket = groupBy === 'month' ? 'month' : groupBy === 'week' ? 'week' : 'day';
  const { rows } = await pool.query(
    `SELECT date_trunc($3, created_at) as period,
            COALESCE(SUM(total), 0) as total,
            COUNT(*)::int as sale_count
     FROM sales
     WHERE status = 'completada' AND created_at BETWEEN $1 AND $2
     GROUP BY period
     ORDER BY period ASC`,
    [fromDate, toDate, bucket]
  );
  return rows.map((r) => ({ period: r.period, total: Number(r.total), saleCount: r.sale_count }));
}

async function totals(from, to) {
  const { fromDate, toDate } = resolveRange(from, to);
  const salesRes = await pool.query(
    `SELECT COALESCE(SUM(total),0) as total, COUNT(*)::int as count
     FROM sales WHERE status = 'completada' AND created_at BETWEEN $1 AND $2`,
    [fromDate, toDate]
  );
  const itemsRes = await pool.query(
    `SELECT COALESCE(SUM(si.quantity),0)::int as qty
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.status = 'completada' AND s.created_at BETWEEN $1 AND $2`,
    [fromDate, toDate]
  );
  const voidedRes = await pool.query(
    `SELECT COUNT(*)::int as count, COALESCE(SUM(total),0) as total
     FROM sales WHERE status = 'anulada' AND created_at BETWEEN $1 AND $2`,
    [fromDate, toDate]
  );
  return {
    revenue: Number(salesRes.rows[0].total),
    saleCount: salesRes.rows[0].count,
    itemsSold: itemsRes.rows[0].qty,
    avgTicket: salesRes.rows[0].count > 0 ? Number(salesRes.rows[0].total) / salesRes.rows[0].count : 0,
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
    `SELECT payment_method, payment_destination,
            COUNT(*)::int as sale_count, COALESCE(SUM(total), 0) as total
     FROM sales
     WHERE status = 'completada' AND created_at BETWEEN $1 AND $2
     GROUP BY payment_method, payment_destination
     ORDER BY total DESC`,
    [fromDate, toDate]
  );
  return rows.map((r) => ({
    method: r.payment_method,
    destination: r.payment_destination,
    saleCount: r.sale_count,
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

module.exports = { salesSummary, totals, topProducts, byCategory, paymentSummary, movementsSummary, inventoryValue, resolveRange };
