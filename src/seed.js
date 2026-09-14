require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, initSchema } = require('./db');

async function seed() {
  await initSchema();

  const defaultCategories = ['Calzado', 'Bolsos', 'Accesorios', 'Camisetas', 'Otros'];
  for (const c of defaultCategories) {
    await pool.query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [c]);
  }

  const { rows } = await pool.query('SELECT COUNT(*)::int as c FROM users');
  if (rows[0].c === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'CambiarClave123';
    const hash = bcrypt.hashSync(password, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4)',
      [username, hash, 'Administrador', 'admin']
    );
    console.log(`Usuario administrador creado: ${username} / ${password}`);
    console.log('IMPORTANTE: cambia esta contraseña después del primer ingreso.');
  } else {
    console.log('Ya existen usuarios, no se creó administrador nuevo.');
  }
  console.log('Categorías por defecto listas.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Error ejecutando el seed:', err.message);
  process.exit(1);
});
