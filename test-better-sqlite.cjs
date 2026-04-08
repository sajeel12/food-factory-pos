const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE products (id TEXT PRIMARY KEY);');
db.exec('CREATE TABLE inventory (id TEXT PRIMARY KEY, productId TEXT NOT NULL, FOREIGN KEY(productId) REFERENCES products(id));');
db.prepare('INSERT INTO products (id) VALUES ("p1")').run();
db.prepare('INSERT INTO inventory (id, productId) VALUES ("i1", "p1")').run();
try {
  db.prepare('DELETE FROM products').run();
  console.log("Delete succeeded without Pragma ON");
} catch(e) {
  console.error("Delete failed:", e);
}
