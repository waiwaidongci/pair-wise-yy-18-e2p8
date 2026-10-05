const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

let db = null;

async function initDatabase() {
  const SQL = await initSqlJs();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    const buffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  return db;
}

function saveDatabase() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

function runSql(sql) {
  if (!db) throw new Error('database not initialized');
  db.run(sql);
  saveDatabase();
}

function select(sql) {
  if (!db) throw new Error('database not initialized');
  const results = db.exec(sql);
  if (!results.length) return [];
  const { columns, values } = results[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

function getDb() {
  return db;
}

module.exports = { initDatabase, runSql, select, saveDatabase, getDb };
