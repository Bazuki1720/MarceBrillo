# Marce Brillo y Estilo — Sistema de Inventario y Ventas

Calzado y Accesorios que te harán brillar ✨

Aplicación web para gestionar productos, inventario (con y sin tallas), ventas, historial, anulaciones, ajustes de stock e informes de negocio. Pensada para una persona sin experiencia técnica: pantallas simples, botones grandes y mensajes claros.

## Arquitectura

- **Backend:** Node.js + Express, corre en tu computador (o donde tú quieras).
- **Base de datos:** **PostgreSQL en la nube (Neon)**. Toda la información (productos, ventas, inventario) vive ahí, no en tu computador. Así, si cambias de PC, se daña el disco, o necesitas que alguien más revise algo, los datos siguen intactos y accesibles desde el panel de Neon.
- **Frontend:** HTML/CSS/JS puro, sin frameworks ni pasos de compilación. Los archivos están en `public/` y el servidor los sirve directamente; se ven igual en cualquier navegador (Chrome, Edge, Firefox) en computador, tablet o celular.
- **Autenticación:** sesiones de servidor + contraseñas con hash `bcrypt`.

En resumen: la "cara" del programa (lo que ves) sigue siendo simple y local; lo único que cambió es que los datos ahora están respaldados en la nube en vez de en un archivo dentro de tu PC.

## Paso 1: crear la base de datos en Neon (una sola vez)

1. Ve a **https://neon.tech** y crea una cuenta gratuita (puedes usar tu correo o tu cuenta de Google/GitHub).
2. Crea un nuevo proyecto. Ponle de nombre, por ejemplo, `marce-brillo-y-estilo`.
3. Neon crea automáticamente una base de datos (por defecto se llama `neondb`).
4. En el dashboard del proyecto, busca el botón **"Connection string"** (cadena de conexión). Cópiala completa — se ve así:


   ```
   postgresql://usuario:contraseña@ep-algo-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
5. Guarda esa cadena, la vas a necesitar en el paso 3. Trátala como una contraseña: no la compartas ni la subas a internet públicamente.

Con esto ya tienes tu base de datos en la nube lista. Puedes volver a este mismo panel de Neon en cualquier momento para ver las tablas, hacer respaldos o darle acceso a alguien más si necesitas soporte.

## Paso 2: instalar lo necesario en tu computador nuevo

Como acabas de formatear/cambiar de PC, necesitas instalar **Node.js** (el programa que ejecuta el servidor):

1. Ve a **https://nodejs.org** y descarga la versión "LTS" (recomendada) para tu sistema operativo.
2. Instálala normalmente (siguiente, siguiente, finalizar).
3. Abre una terminal (en VS Code: menú **Terminal → New Terminal**) y escribe `node -v`. Si te muestra un número de versión, quedó bien instalado.

## Paso 3: configurar el proyecto

1. Descomprime la carpeta del proyecto (`marce`) donde quieras tenerla, y ábrela en VS Code (**File → Open Folder**).
2. En la terminal de VS Code, dentro de la carpeta del proyecto, instala las dependencias:
   ```bash
   npm install
   ```
3. Copia el archivo de ejemplo de variables de entorno:
   ```bash
   cp .env.example .env
   ```
   (En Windows, si el comando `cp` no existe, simplemente duplica el archivo `.env.example` y renómbralo a `.env` desde el explorador de archivos de VS Code.)
4. Abre el archivo `.env` y reemplaza la línea `DATABASE_URL` por la cadena de conexión que copiaste de Neon en el Paso 1. Debe quedar algo así:
   ```
   DATABASE_URL=postgresql://usuario:contraseña@ep-algo-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
5. Define también, en ese mismo archivo, el usuario y la contraseña que quieres para tu primer ingreso:
   ```
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=UnaClaveSegura123
   ```

## Paso 4: crear las tablas y el usuario administrador

```bash
npm run seed
```

Esto se conecta a tu base de Neon, crea todas las tablas (si no existen) y crea el usuario administrador con las credenciales que pusiste en `.env`. Solo hace falta correrlo una vez (si lo corres de nuevo y ya hay usuarios, no crea uno nuevo, así que es seguro repetirlo).

## Paso 5: iniciar la aplicación

```bash
npm start
```

Abre tu navegador en **http://localhost:3000/login.html** e ingresa con el usuario y contraseña que definiste. Listo.

Cada vez que quieras usar el programa, solo necesitas correr `npm start` desde la carpeta del proyecto y abrir esa dirección en el navegador. La información se lee y se guarda directamente en Neon, así que puedes hacerlo desde cualquier computador que tenga este mismo proyecto configurado con la misma `DATABASE_URL`.

## Informes y reportes

Desde el dashboard, botón **📊 Informes**, encuentras:

- **Resumen del período** (hoy, últimos 7 días, últimos 30 días, o el mes actual): ingresos, número de ventas, productos vendidos, ticket promedio, ventas anuladas, y valor total del inventario actual.
- **Ventas por día**: gráfico de barras simple para ver cómo se mueve el negocio día a día.
- **Productos más vendidos**: cuáles referencias se venden más, en unidades y en pesos.
- **Ventas por categoría**: qué categoría (calzado, bolsos, etc.) genera más ingresos.
- **Movimientos de inventario**: cuántas entradas, ventas, devoluciones y ajustes hubo en el período.

## Variables de entorno

Ver `.env.example`. Las más importantes:

- `DATABASE_URL`: cadena de conexión de tu base de datos Neon (obligatoria).
- `SESSION_SECRET`: clave para firmar las sesiones. Usa un valor largo y aleatorio en producción.
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`: solo se usan una vez, cuando la tabla de usuarios está vacía.
- `PGSSL=disable`: solo para pruebas locales contra un Postgres sin SSL en tu propia máquina; **no la uses con Neon**, que siempre requiere SSL.

## Base de datos

Tablas principales: `users`, `categories`, `products`, `product_variants`, `inventory`, `sales`, `sale_items`, `inventory_movements`.

- Cada producto tiene una o más **variantes** (`product_variants`). Si el producto no maneja tallas, tiene una única variante con talla `NULL` que representa todo su stock.
- El **inventario** vive por variante (`inventory.quantity`), nunca es negativo (se valida dentro de la misma transacción de Postgres).
- Cada movimiento de inventario (entrada, venta, devolución, ajuste) queda registrado en `inventory_movements` con usuario, fecha y motivo — esto es lo que alimenta los informes.
- Las ventas nunca se borran: se **anulan** (cambia el estado y se devuelve el inventario automáticamente).
- Los precios de venta quedan **congelados** en `sale_items.unit_price` al momento de la venta, aunque el precio del producto cambie después.

No hay migraciones separadas: el esquema se crea automáticamente (`CREATE TABLE IF NOT EXISTS…`) la primera vez que corres `npm run seed` o arranca el servidor, en `src/db.js`.

## Pruebas

`tests/run.js` es una batería de 42 pruebas automáticas que ejercitan la API real (no simulada): login/logout, categorías, productos con y sin tallas, entradas de inventario, ajustes, ventas simples y múltiples, stock insuficiente, stock en cero, historial, anulación y devolución de inventario, precio histórico, búsqueda parcial, informes/reportes, usuarios y permisos.

```bash
node src/server.js &         # levanta el servidor (usa la base de datos de tu .env)
node tests/run.js            # corre las pruebas contra http://localhost:3000
```

**Importante:** estas pruebas crean datos de ejemplo (categorías y productos de prueba) en la base de datos contra la que las corras. No las ejecutes contra tu base de datos de producción con datos reales de ventas — usa una base de Neon aparte para pruebas si quieres repetirlas.

## Backup

Como los datos están en Neon, el respaldo más simple es usar la función de **branching / backups** del panel de Neon (Neon guarda automáticamente el historial reciente de tu base y te permite restaurar a un punto en el tiempo). También puedes exportar manualmente con `pg_dump` si instalas las herramientas de Postgres en tu computador:

```bash
pg_dump "TU_DATABASE_URL_DE_NEON" > respaldo-$(date +%Y%m%d).sql
```

## Seguridad implementada

- Contraseñas con hash `bcrypt` (nunca se guardan en texto plano).
- Sesiones de servidor con cookies `httpOnly`.
- Conexión a la base de datos siempre con SSL (obligatorio en Neon).
- Todas las rutas de la API (excepto login) requieren sesión iniciada; las de usuarios requieren rol administrador.
- Validación en el backend de todos los datos críticos (no solo en el frontend).
- Consultas parametrizadas en toda la aplicación (sin concatenar SQL, protegido contra inyección SQL).
- El inventario nunca puede quedar negativo: se valida dentro de la misma transacción que registra la venta (usando bloqueo de fila `FOR UPDATE`, seguro incluso si dos ventas ocurren al mismo tiempo).
- Variables sensibles (`DATABASE_URL`, `SESSION_SECRET`, credenciales) fuera del código, en `.env` (no se sube a git).

## Estructura del proyecto

```
src/
  db.js               conexión a Postgres/Neon y esquema de la base de datos
  auth.js             middlewares de autenticación/autorización
  inventoryLogic.js    lógica transaccional de inventario y ventas
  reports.js            consultas de informes y reportes
  server.js             servidor Express y todas las rutas de la API
  seed.js                crea tablas, categorías por defecto y el usuario administrador
public/
  login.html            pantalla de ingreso
  index.html             estructura de la aplicación (una sola página)
  css/style.css          estilos
  js/api.js               utilidades para llamar a la API
  js/app.js                toda la lógica de pantallas (dashboard, inventario, ventas, informes, etc.)
tests/
  run.js                 pruebas automáticas end-to-end (42 pruebas)
Dockerfile                imagen lista si en el futuro quieres desplegar también el servidor en la nube
.env.example              variables de entorno de ejemplo
```

## Preguntas frecuentes

**¿Qué pasa si se daña este computador?** Nada le pasa a tus datos: viven en Neon. Solo instala el proyecto en otro computador (Pasos 2 y 3), apunta al mismo `DATABASE_URL`, y sigues donde ibas.

**¿Puedo tener el programa abierto en dos computadores al tiempo?** Sí, ambos se conectan a la misma base de datos en Neon. Ten en cuenta que cada uno necesita correr su propio `npm start` (cada computador es su propio "servidor" hablando con la misma base de datos).

**¿Y si en el futuro quiero que el programa esté disponible desde internet, no solo en mi computador?** Es posible usando el `Dockerfile` incluido y un servicio de hosting (Render, Railway, Fly.io, etc.); como la base de datos ya está en Neon, ese paso futuro es sencillo. Dímelo cuando llegue el momento y te ayudo a dejarlo configurado.

## Qué queda pendiente (requiere una decisión o acción tuya)

- **Crear tu cuenta en Neon** y pegar tu `DATABASE_URL` real en `.env` (Pasos 1 y 3 de arriba) — no tengo forma de crear la cuenta por ti.
- **Cambiar la contraseña del administrador inicial** después del primer ingreso (crea tu propio usuario en Configuración y desactiva el `admin` inicial si quieres).
