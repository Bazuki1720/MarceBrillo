const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: falta la variable de entorno DATABASE_URL (cadena de conexión de Postgres/Neon).');
  console.error('Copia .env.example a .env y coloca ahí tu cadena de conexión de Neon.');
  process.exit(1);
}

// Neon requiere SSL. Para una base de datos Postgres local en desarrollo (sin SSL),
// define PGSSL=disable en tu .env.
const useSSL = process.env.PGSSL !== 'disable';
const listenerConnectionString = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
const changeNotificationsSupported = !/-pooler(?:\.|$)/i.test(new URL(listenerConnectionString).hostname);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,
});

const changeListenerPool = process.env.DATABASE_URL_DIRECT
  ? new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 1,
  })
  : pool;

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de conexiones a la base de datos:', err.message);
});
if (changeListenerPool !== pool) {
  changeListenerPool.on('error', (err) => {
    console.error('Error en la conexión directa para cambios en tiempo real:', err.message);
  });
}

async function query(text, params) {
  return pool.query(text, params);
}

// Runs `fn` inside a single client with a transaction (BEGIN/COMMIT/ROLLBACK).
// `fn` receives a client whose `.query(...)` must be used for all statements in the transaction.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','vendedor')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  description TEXT,
  image_path TEXT,
  has_variants BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','inactivo')),
  low_stock_threshold INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every product has at least one variant row. If has_variants=false, the single
-- variant has size = NULL and represents the whole product's stock.
CREATE TABLE IF NOT EXISTS product_variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size TEXT,
  UNIQUE(product_id, size)
);

CREATE TABLE IF NOT EXISTS inventory (
  variant_id INTEGER PRIMARY KEY REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0)
);

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  sale_number TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'no_especificado' CHECK (payment_method IN ('efectivo','transferencia','addi','no_especificado')),
  payment_destination TEXT CHECK (payment_destination IN ('nequi','qr','daviplata')),
  status TEXT NOT NULL DEFAULT 'completada' CHECK (status IN ('completada','anulada')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT
);

CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  product_reference TEXT NOT NULL,
  product_name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  size TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL,
  subtotal NUMERIC(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id SERIAL PRIMARY KEY,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  product_reference TEXT NOT NULL,
  size TEXT,
  type TEXT NOT NULL CHECK (type IN ('entrada','venta','devolucion','ajuste')),
  quantity_change INTEGER NOT NULL,
  resulting_quantity INTEGER NOT NULL,
  reason TEXT,
  sale_id INTEGER REFERENCES sales(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS separated_orders (
  id SERIAL PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  client_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','completado','anulado')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at TIMESTAMPTZ NOT NULL,
  canceled_at TIMESTAMPTZ,
  canceled_by INTEGER REFERENCES users(id),
  cancel_reason TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS separated_order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES separated_orders(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  product_reference TEXT NOT NULL,
  product_name TEXT NOT NULL,
  size TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  retired_quantity INTEGER NOT NULL DEFAULT 0 CHECK (retired_quantity >= 0),
  unit_price NUMERIC(12,2) NOT NULL,
  subtotal NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS separated_payments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES separated_orders(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL DEFAULT 'efectivo' CHECK (payment_method IN ('efectivo','transferencia','addi','nequi','qr','daviplata')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT
);

CREATE TABLE IF NOT EXISTS credit_sales (
  id SERIAL PRIMARY KEY,
  credit_number TEXT UNIQUE NOT NULL,
  client_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','pagado','anulado')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NOT NULL REFERENCES users(id),
  canceled_at TIMESTAMPTZ,
  canceled_by INTEGER REFERENCES users(id),
  cancel_reason TEXT
);

CREATE TABLE IF NOT EXISTS credit_sale_items (
  id SERIAL PRIMARY KEY,
  credit_sale_id INTEGER NOT NULL REFERENCES credit_sales(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  product_reference TEXT NOT NULL,
  product_name TEXT NOT NULL,
  size TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL,
  subtotal NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_payments (
  id SERIAL PRIMARY KEY,
  credit_sale_id INTEGER NOT NULL REFERENCES credit_sales(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL DEFAULT 'efectivo' CHECK (payment_method IN ('efectivo','transferencia','addi','nequi','qr','daviplata')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT
);

CREATE TABLE IF NOT EXISTS separated_payment_allocations (
  id SERIAL PRIMARY KEY,
  separated_payment_id INTEGER NOT NULL REFERENCES separated_payments(id) ON DELETE CASCADE,
  separated_order_item_id INTEGER NOT NULL REFERENCES separated_order_items(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (separated_payment_id)
);

CREATE TABLE IF NOT EXISTS credit_payment_allocations (
  id SERIAL PRIMARY KEY,
  credit_payment_id INTEGER NOT NULL REFERENCES credit_payments(id) ON DELETE CASCADE,
  credit_sale_item_id INTEGER NOT NULL REFERENCES credit_sale_items(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (credit_payment_id)
);

CREATE TABLE IF NOT EXISTS account_refunds (
  id SERIAL PRIMARY KEY,
  separated_order_id INTEGER REFERENCES separated_orders(id),
  credit_sale_id INTEGER REFERENCES credit_sales(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('efectivo','transferencia','addi','nequi','qr','daviplata')),
  reason TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((separated_order_id IS NOT NULL)::int + (credit_sale_id IS NOT NULL)::int = 1)
);

CREATE OR REPLACE FUNCTION notify_marce_brillo_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('marce_brillo_changes', TG_TABLE_NAME);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'categories', 'users', 'products', 'product_variants', 'inventory',
    'sales', 'sale_items', 'inventory_movements', 'separated_orders',
    'separated_order_items', 'separated_payments', 'credit_sales',
    'credit_sale_items', 'credit_payments', 'separated_payment_allocations',
    'credit_payment_allocations', 'account_refunds'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS marce_brillo_change ON %I', table_name);
    EXECUTE format(
      'CREATE TRIGGER marce_brillo_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION notify_marce_brillo_change()',
      table_name
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_reference ON products(reference);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_category ON sale_items(category_id);
CREATE INDEX IF NOT EXISTS idx_movements_variant ON inventory_movements(variant_id);
CREATE INDEX IF NOT EXISTS idx_movements_created ON inventory_movements(created_at);
CREATE INDEX IF NOT EXISTS idx_separated_orders_status ON separated_orders(status);
CREATE INDEX IF NOT EXISTS idx_separated_order_items_variant ON separated_order_items(variant_id);
CREATE INDEX IF NOT EXISTS idx_separated_payments_created ON separated_payments(created_at);
CREATE INDEX IF NOT EXISTS idx_separated_allocations_item ON separated_payment_allocations(separated_order_item_id);
CREATE INDEX IF NOT EXISTS idx_credit_sales_status ON credit_sales(status);
CREATE INDEX IF NOT EXISTS idx_credit_sale_items_variant ON credit_sale_items(variant_id);
CREATE INDEX IF NOT EXISTS idx_credit_payments_created ON credit_payments(created_at);
CREATE INDEX IF NOT EXISTS idx_credit_allocations_item ON credit_payment_allocations(credit_sale_item_id);
CREATE INDEX IF NOT EXISTS idx_account_refunds_created ON account_refunds(created_at);

-- Migration safety net: add category_id to sale_items if it didn't exist yet
-- (older databases created before reports were added).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sale_items' AND column_name = 'category_id'
  ) THEN
    ALTER TABLE sale_items ADD COLUMN category_id INTEGER REFERENCES categories(id);
  END IF;
END $$;

-- Migration safety net: preserve existing sales when payment methods are added.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales' AND column_name = 'payment_method'
  ) THEN
    ALTER TABLE sales
      ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'no_especificado'
      CHECK (payment_method IN ('efectivo','transferencia','addi','no_especificado'));
  END IF;
END $$;

-- Migration safety net: add the transfer destination without changing old sales.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales' AND column_name = 'payment_destination'
  ) THEN
    ALTER TABLE sales
      ADD COLUMN payment_destination TEXT
      CHECK (payment_destination IN ('nequi','qr','daviplata'));
  END IF;
END $$;

-- Backfill item timestamps in databases created before account item dates existed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'credit_sale_items' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE credit_sale_items ADD COLUMN created_at TIMESTAMPTZ;
  END IF;
  UPDATE credit_sale_items csi
  SET created_at = cs.created_at
  FROM credit_sales cs
  WHERE cs.id = csi.credit_sale_id AND csi.created_at IS NULL;
  ALTER TABLE credit_sale_items ALTER COLUMN created_at SET DEFAULT now();
  ALTER TABLE credit_sale_items ALTER COLUMN created_at SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'separated_order_items' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE separated_order_items ADD COLUMN created_at TIMESTAMPTZ;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'separated_order_items' AND column_name = 'separated_order_id'
  ) THEN
    UPDATE separated_order_items soi
    SET created_at = so.created_at
    FROM separated_orders so
    WHERE so.id = soi.separated_order_id AND soi.created_at IS NULL;
  ELSE
    UPDATE separated_order_items soi
    SET created_at = so.created_at
    FROM separated_orders so
    WHERE so.id = soi.order_id AND soi.created_at IS NULL;
  END IF;
  ALTER TABLE separated_order_items ALTER COLUMN created_at SET DEFAULT now();
  ALTER TABLE separated_order_items ALTER COLUMN created_at SET NOT NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_credit_sale_items_created ON credit_sale_items(created_at);
CREATE INDEX IF NOT EXISTS idx_separated_order_items_created ON separated_order_items(created_at);
`;

async function initSchema() {
  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [1874500]);
    await client.query(SCHEMA_SQL);
  });
}

module.exports = { pool, changeListenerPool, changeNotificationsSupported, query, withTransaction, initSchema };
