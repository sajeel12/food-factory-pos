const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
let db;

function initDb() {
  if (db) return db;
  const dbPath = path.join(app.getPath('userData'), 'pos-local.db');
  db = new Database(dbPath);

  console.log(`Initialized local SQLite DB at: ${dbPath}`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sku TEXT UNIQUE NOT NULL,
      price REAL NOT NULL,
      updatedAt TEXT,
      categoryId TEXT,
      isDeal INTEGER DEFAULT 0,
      dealItems TEXT,
      image TEXT
    );

    CREATE TABLE IF NOT EXISTS item_variants (
      id TEXT PRIMARY KEY,
      productId TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      FOREIGN KEY(productId) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      total REAL NOT NULL,
      status TEXT NOT NULL,
      paymentMethod TEXT DEFAULT 'CASH',
      tenderedAmount REAL DEFAULT 0,
      customerName TEXT,
      customerPhone TEXT,
      customerAddress TEXT,
      deliveryFee REAL DEFAULT 0,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      synced INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      orderId TEXT NOT NULL,
      productId TEXT NOT NULL,
      variantId TEXT,
      variantName TEXT,
      quantity INTEGER NOT NULL,
      subtotal REAL NOT NULL,
      FOREIGN KEY(orderId) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      productId TEXT NOT NULL,
      quantity INTEGER DEFAULT 0,
      location TEXT,
      updatedAt TEXT,
      FOREIGN KEY(productId) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS bom (
      id TEXT PRIMARY KEY,
      productId TEXT NOT NULL,
      ingredientId TEXT NOT NULL,
      quantity REAL NOT NULL,
      FOREIGN KEY(productId) REFERENCES products(id),
      FOREIGN KEY(ingredientId) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY,
      openingCash REAL NOT NULL,
      expectedCash REAL,
      actualCash REAL,
      status TEXT DEFAULT 'OPEN',
      startedAt TEXT DEFAULT CURRENT_TIMESTAMP,
      endedAt TEXT,
      synced INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS riders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      status TEXT DEFAULT 'AVAILABLE',
      branchId TEXT
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      address TEXT,
      loyaltyPoints INTEGER DEFAULT 0,
      branchId TEXT
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      branchId TEXT
    );

    CREATE TABLE IF NOT EXISTS vouchers (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT,
      type TEXT NOT NULL,
      value REAL NOT NULL,
      expiryDate TEXT NOT NULL,
      isActive INTEGER DEFAULT 1,
      branchId TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_products_updatedAt ON products(updatedAt);
    CREATE INDEX IF NOT EXISTS idx_orders_synced ON orders(synced);
    CREATE INDEX IF NOT EXISTS idx_order_items_orderId ON order_items(orderId);
    CREATE INDEX IF NOT EXISTS idx_order_items_productId ON order_items(productId);
    CREATE INDEX IF NOT EXISTS idx_inventory_productId ON inventory(productId);
    CREATE INDEX IF NOT EXISTS idx_bom_productId ON bom(productId);
    CREATE INDEX IF NOT EXISTS idx_bom_ingredientId ON bom(ingredientId);
    CREATE INDEX IF NOT EXISTS idx_shifts_synced ON shifts(synced);
    CREATE INDEX IF NOT EXISTS idx_item_variants_productId ON item_variants(productId);
  `);

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN paymentMethod TEXT DEFAULT 'CASH';`);
  } catch (e) {
    // Column might already exist
  }
  try {
    db.exec(`ALTER TABLE orders ADD COLUMN tenderedAmount REAL DEFAULT 0;`);
  } catch (e) {
    // Column might already exist
  }
  try {
    db.exec(`ALTER TABLE orders ADD COLUMN customerName TEXT;`);
  } catch (e) {
    // Column might already exist
  }
  try {
    db.exec(`ALTER TABLE orders ADD COLUMN customerPhone TEXT;`);
  } catch (e) {
    // Column might already exist
  }
  try {
    db.exec(`ALTER TABLE orders ADD COLUMN customerAddress TEXT;`);
  } catch (e) {
    // Column might already exist
  }
  try {
    db.exec(`ALTER TABLE orders ADD COLUMN customerId TEXT;`);
  } catch (e) {
    // Column might already exist
  }
  try {
    db.exec(`ALTER TABLE orders ADD COLUMN deliveryFee REAL DEFAULT 0;`);
  } catch (e) {}

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN voucherId TEXT;`);
  } catch (e) {}

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN discount REAL DEFAULT 0;`);
  } catch (e) {}

  try {
    db.exec(`ALTER TABLE order_items ADD COLUMN variantId TEXT;`);
  } catch (e) {
    // Column might already exist
  }
  try {
    db.exec(`ALTER TABLE order_items ADD COLUMN variantName TEXT;`);
  } catch (e) {
    // Column might already exist
  }

  try {
    db.exec(`ALTER TABLE products ADD COLUMN categoryId TEXT;`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE products ADD COLUMN isDeal INTEGER DEFAULT 0;`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE products ADD COLUMN dealItems TEXT;`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE products ADD COLUMN image TEXT;`);
  } catch (e) {}

  try {
    db.exec(`ALTER TABLE vouchers ADD COLUMN name TEXT;`);
  } catch (e) {}

  return db;
}

function getDb() {
  if (!db) return initDb();
  return db;
}

module.exports = { initDb, getDb };
