const Database = require('better-sqlite3');
const os = require('os');
const path = require('path');
const dbPath = path.join(os.homedir(), '.config', 'pos-desktop', 'pos-local.db');
const db = new Database(dbPath);
console.log(db.prepare("SELECT id, name FROM products").all());
