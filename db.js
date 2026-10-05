const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const config = require('./project.config');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

let db = null;

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function init() {
  const SQL = initSqlJs();
  // initSqlJs resolves synchronously in practice but keep the async contract honest.
  return SQL.then((sql) => {
    if (fs.existsSync(DB_FILE)) {
      db = new sql.Database(fs.readFileSync(DB_FILE));
    } else {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      db = new sql.Database();
    }
    db.run('PRAGMA foreign_keys = ON;');
    return db;
  });
}

function execScript(sql) {
  db.run(sql);
}

// Named-parameter statement runner. Params: { name: value } -> binds :name.
function run(sql, params = {}) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    stmt.step();
  } finally {
    stmt.free();
  }
}

function query(sql, params = {}) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

function queryOne(sql, params = {}) {
  return query(sql, params)[0] || null;
}

let transactionDepth = 0;
let txnLocked = false;

// 所有写事务串行执行。处理器全部为同步代码，等待锁时不会有其他请求的
// 写事务交叠（同步自旋期间事件循环不切换），因此唯一约束抢占就是可靠的
// 并发裁决；嵌套事务用 SAVEPOINT 实现。
function transaction(fn) {
  while (txnLocked) {
    // 同步等待外层请求的事务收尾
  }
  if (transactionDepth === 0) {
    txnLocked = true;
    db.run('BEGIN IMMEDIATE;');
    transactionDepth = 1;
    try {
      const result = fn();
      db.run('COMMIT;');
      transactionDepth = 0;
      txnLocked = false;
      persist();
      return result;
    } catch (error) {
      transactionDepth = 0;
      txnLocked = false;
      try {
        db.run('ROLLBACK;');
      } catch (rollbackError) {
        // transaction already finished; ignore
      }
      throw error;
    }
  }
  // 嵌套：savepoint
  const name = 'sp_' + transactionDepth;
  transactionDepth += 1;
  db.run('SAVEPOINT ' + name + ';');
  try {
    const result = fn();
    db.run('RELEASE SAVEPOINT ' + name + ';');
    transactionDepth -= 1;
    return result;
  } catch (error) {
    try {
      db.run('ROLLBACK TO SAVEPOINT ' + name + ';');
      db.run('RELEASE SAVEPOINT ' + name + ';');
    } catch (rollbackError) {
      // ignore
    }
    transactionDepth -= 1;
    throw error;
  }
}

// INSERT ... relying on a UNIQUE constraint; returns true when inserted, false on conflict.
function tryInsert(sql, params = {}) {
  try {
    run(sql, params);
    return true;
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) return false;
    throw error;
  }
}

const isUniqueError = (error) => String(error.message).includes('UNIQUE constraint failed');

module.exports = {
  init,
  execScript,
  run,
  query,
  queryOne,
  transaction,
  tryInsert,
  isUniqueError,
  persist,
  DB_FILE
};
