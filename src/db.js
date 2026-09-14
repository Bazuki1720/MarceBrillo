const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: falta la variable de entorno DATABASE_URL (cadena de conexión de Postgres/Neon).');
  console.error('Copia .env.example a .env y coloca ahí tu cadena de conexión de Neon.');
  process.exit(1);
}

// Neon requiere SSL. Para una base de datos Postgres local en desarrollo (sin SSL),
// define PGSSL=disable en tu .env.
const useSSL = process.env.PGSSL !== 'disable';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de conexiones a la base de datos:', err.message);
});

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

CREATE INDEX IF NOT EXISTS idx_products_reference ON products(reference);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_category ON sale_items(category_id);
CREATE INDEX IF NOT EXISTS idx_movements_variant ON inventory_movements(variant_id);
CREATE INDEX IF NOT EXISTS idx_movements_created ON inventory_movements(created_at);

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
`;

async function initSchema() {
  await pool.query(SCHEMA_SQL);
}

module.exports = { pool, query, withTransaction, initSchema };
