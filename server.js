const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('./project.config');
const { initDatabase, runSql, select, getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || config.port;
const DATA_DIR = path.join(__dirname, 'data');

app.use(express.json({ limit: '2mb' }));

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function now() {
  return new Date().toISOString();
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function insertEvent({ recordId, collection, action, status, actor, note, data }) {
  runSql(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(recordId),
      sqlValue(collection),
      sqlValue(action || '记录'),
      sqlValue(status || ''),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(data || {})),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

async function initDb() {
  await initDatabase();
  runSql(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recall_notices_notice_no
  ON records (json_extract(data, '$.noticeNo'))
  WHERE collection = 'recallNotices';
CREATE UNIQUE INDEX IF NOT EXISTS idx_isolation_conclusions_notice_no
  ON records (json_extract(data, '$.noticeNo'))
  WHERE collection = 'isolationConclusions';
CREATE UNIQUE INDEX IF NOT EXISTS idx_loss_reports_notice_item
  ON records (json_extract(data, '$.sourceNoticeNo'), json_extract(data, '$.itemType'), json_extract(data, '$.itemId'))
  WHERE collection = 'lossReports' AND json_extract(data, '$.sourceNoticeNo') IS NOT NULL;
`);

  const count = select('SELECT COUNT(*) AS count FROM records;')[0].count;
  if (count > 0) return;

  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    runSql(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        sqlValue(id),
        sqlValue(seed.collection),
        sqlValue(status),
        sqlValue(titleFor(collectionConfig, data)),
        sqlValue(JSON.stringify(data)),
        sqlValue(createdAt),
        sqlValue(seed.updatedAt || createdAt)
      ].join(', ') +
      ');'
    );
    insertEvent({
      recordId: id,
      collection: seed.collection,
      action: seed.eventAction || '创建',
      status,
      actor: seed.actor || 'system',
      note: seed.note || '',
      data
    });
  }
}

function loadRecord(collection, id) {
  const rows = select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ' LIMIT 1;'
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

function saveRecord(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  runSql(
    'UPDATE records SET status = ' + sqlValue(status) +
    ', title = ' + sqlValue(titleFor(collectionConfig, data)) +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ';'
  );
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

async function startServer() {
  await initDb();

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: config.title, port: PORT });
  });

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

app.get('/api/:collection', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const rows = select(
      'SELECT * FROM records WHERE collection = ' + sqlValue(req.params.collection) + ' ORDER BY updated_at DESC;'
    ).map(toRecord);
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    if (req.params.collection === 'recallNotices' || req.params.collection === 'isolationConclusions') {
      return next();
    }
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);
    const id = randomUUID();
    const createdAt = now();
    runSql(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        sqlValue(id),
        sqlValue(req.params.collection),
        sqlValue(status),
        sqlValue(titleFor(collectionConfig, data)),
        sqlValue(JSON.stringify(data)),
        sqlValue(createdAt),
        sqlValue(createdAt)
      ].join(', ') +
      ');'
    );
    insertEvent({
      recordId: id,
      collection: req.params.collection,
      action: req.body.action || '创建',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data
    });
    res.status(201).json(loadRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    if (req.params.collection === 'recallNotices') return next();
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    if (req.params.collection === 'recallNotices' || req.params.collection === 'isolationConclusions') {
      return next();
    }
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const oldBatchNo = record.batchNo;
    const oldMaterialBatch = record.materialBatch;
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    saveRecord(req.params.collection, req.params.id, nextData, status);
    if (req.params.collection === 'materialBatches') {
      if (oldBatchNo) invalidateConclusions(oldBatchNo);
      if (nextData.batchNo && nextData.batchNo !== oldBatchNo) invalidateConclusions(nextData.batchNo);
    }
    if (req.params.collection === 'repairRecords') {
      if (oldMaterialBatch) invalidateConclusions(oldMaterialBatch);
      if (nextData.materialBatch && nextData.materialBatch !== oldMaterialBatch) invalidateConclusions(nextData.materialBatch);
    }
    insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || '更新',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    saveRecord(req.params.collection, req.params.id, nextData, status);
    insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || status || '记录',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = select(
      'SELECT * FROM events WHERE record_id = ' + sqlValue(req.params.id) + ' ORDER BY created_at ASC;'
    ).map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
    res.json({ record, events });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    runSql('DELETE FROM records WHERE collection = ' + sqlValue(req.params.collection) + ' AND id = ' + sqlValue(req.params.id) + ';');
    runSql('DELETE FROM events WHERE record_id = ' + sqlValue(req.params.id) + ';');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// --- 召回处置：按批次追溯、隔离确认、复检恢复 ---

function findRecordByField(collection, field, value) {
  const rows = select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) +
    ' AND json_extract(data, ' + sqlValue('$.' + field) + ') = ' + sqlValue(value) +
    ' LIMIT 1;'
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

function findRecallNotice(noticeNo) {
  return findRecordByField('recallNotices', 'noticeNo', noticeNo);
}

function findConclusion(noticeNo) {
  return findRecordByField('isolationConclusions', 'noticeNo', noticeNo);
}

function traceAffectedItems(batchNo) {
  const repairRows = select(
    'SELECT * FROM records WHERE collection = ' + sqlValue('repairRecords') +
    ' AND json_extract(data, \'$.materialBatch\') = ' + sqlValue(batchNo) + ';'
  );
  const affectedHeadIds = new Set();
  const affectedAccessoryIds = new Set();
  for (const row of repairRows) {
    const repair = toRecord(row);
    if (repair.puppetHeadId) affectedHeadIds.add(repair.puppetHeadId);
    if (Array.isArray(repair.accessoryIds)) {
      repair.accessoryIds.forEach((id) => affectedAccessoryIds.add(id));
    }
  }
  for (const headId of affectedHeadIds) {
    const head = loadRecord('puppetHeads', headId);
    if (head && Array.isArray(head.accessories)) {
      for (const accName of head.accessories) {
        const accRows = select(
          'SELECT * FROM records WHERE collection = ' + sqlValue('accessories') +
          ' AND json_extract(data, \'$.name\') = ' + sqlValue(accName) + ';'
        );
        accRows.forEach((r) => affectedAccessoryIds.add(r.id));
      }
    }
  }
  return { headIds: [...affectedHeadIds], accessoryIds: [...affectedAccessoryIds] };
}

function isItemOnLoanOrPacked(item) {
  if (!item) return false;
  if (item.status === '外借' || item.status === '已装箱') return true;
  const boxRows = select(
    'SELECT * FROM records WHERE collection = ' + sqlValue('tourBoxes') +
    ' AND status IN (\'已装箱\', \'巡演中\');'
  );
  for (const box of boxRows) {
    const d = JSON.parse(box.data || '{}');
    const allIds = [...(d.headIds || []), ...(d.accessoryIds || [])];
    if (allIds.includes(item.id)) return true;
  }
  return false;
}

function generateLossReports(noticeNo, batchNo, affectedItems) {
  const generated = [];
  const allItems = [
    ...affectedItems.headIds.map((id) => ({ type: 'puppetHead', id })),
    ...affectedItems.accessoryIds.map((id) => ({ type: 'accessory', id }))
  ];
  for (const { type, id } of allItems) {
    const item = type === 'puppetHead' ? loadRecord('puppetHeads', id) : loadRecord('accessories', id);
    if (!item) continue;
    if (!isItemOnLoanOrPacked(item)) continue;
    const itemName = type === 'puppetHead' ? (item.role + ' / ' + item.play) : item.name;
    const lossId = randomUUID();
    runSql(
      'INSERT OR IGNORE INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        sqlValue(lossId),
        sqlValue('lossReports'),
        sqlValue('待处理'),
        sqlValue(itemName + ' / 材料批次' + batchNo + '召回'),
        sqlValue(JSON.stringify({
          sourceNoticeNo: noticeNo,
          itemType: type,
          itemId: id,
          itemName,
          problem: '材料批次' + batchNo + '召回，物件在外借或装箱中，需追踪回收',
          tourBoxId: null
        })),
        sqlValue(now()),
        sqlValue(now())
      ].join(', ') + ');'
    );
    const existing = select(
      'SELECT * FROM records WHERE collection = ' + sqlValue('lossReports') +
      ' AND json_extract(data, \'$.sourceNoticeNo\') = ' + sqlValue(noticeNo) +
      ' AND json_extract(data, \'$.itemType\') = ' + sqlValue(type) +
      ' AND json_extract(data, \'$.itemId\') = ' + sqlValue(id) + ';'
    );
    if (existing[0]) generated.push(toRecord(existing[0]));
  }
  return generated;
}

function buildConclusionData(noticeNo, batchNo, affectedItems, version) {
  const onLoanItems = [];
  const packedItems = [];
  for (const id of affectedItems.headIds) {
    const item = loadRecord('puppetHeads', id);
    if (item) {
      const entry = { type: 'puppetHead', id, name: item.role + ' / ' + item.play };
      if (item.status === '外借') onLoanItems.push(entry);
      else if (item.status === '已装箱') packedItems.push(entry);
    }
  }
  for (const id of affectedItems.accessoryIds) {
    const item = loadRecord('accessories', id);
    if (item) {
      const entry = { type: 'accessory', id, name: item.name };
      if (item.status === '外借') onLoanItems.push(entry);
      else if (item.status === '已装箱') packedItems.push(entry);
    }
  }
  return {
    noticeNo,
    batchNo,
    status: '有效',
    affectedHeadIds: affectedItems.headIds,
    affectedAccessoryIds: affectedItems.accessoryIds,
    onLoanItems,
    packedItems,
    version: version || 1,
    computedAt: now()
  };
}

function createConclusion(noticeNo, batchNo, affectedItems) {
  const id = randomUUID();
  const createdAt = now();
  runSql(
    'INSERT OR IGNORE INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue('isolationConclusions'),
      sqlValue('有效'),
      sqlValue(noticeNo + ' / ' + batchNo),
      sqlValue(JSON.stringify(buildConclusionData(noticeNo, batchNo, affectedItems, 1))),
      sqlValue(createdAt),
      sqlValue(createdAt)
    ].join(', ') + ');'
  );
  return findConclusion(noticeNo);
}

function recalculateConclusion(noticeNo) {
  const notice = findRecallNotice(noticeNo);
  if (!notice) return null;
  const affectedItems = traceAffectedItems(notice.batchNo);
  generateLossReports(noticeNo, notice.batchNo, affectedItems);
  for (const headId of affectedItems.headIds) setItemIsolated('puppetHead', headId);
  for (const accId of affectedItems.accessoryIds) setItemIsolated('accessory', accId);
  const existing = findConclusion(noticeNo);
  const newVersion = existing ? (existing.version || 1) + 1 : 1;
  const data = buildConclusionData(noticeNo, notice.batchNo, affectedItems, newVersion);
  if (existing) {
    runSql(
      'UPDATE records SET status = ' + sqlValue('有效') +
      ', data = ' + sqlValue(JSON.stringify(data)) +
      ', updated_at = ' + sqlValue(now()) +
      ' WHERE collection = ' + sqlValue('isolationConclusions') +
      ' AND json_extract(data, \'$.noticeNo\') = ' + sqlValue(noticeNo) + ';'
    );
  } else {
    const id = randomUUID();
    const createdAt = now();
    runSql(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        sqlValue(id),
        sqlValue('isolationConclusions'),
        sqlValue('有效'),
        sqlValue(noticeNo + ' / ' + notice.batchNo),
        sqlValue(JSON.stringify(data)),
        sqlValue(createdAt),
        sqlValue(createdAt)
      ].join(', ') + ');'
    );
  }
  return findConclusion(noticeNo);
}

function invalidateConclusions(batchNo) {
  runSql(
    'UPDATE records SET status = ' + sqlValue('已失效') +
    ', data = json_set(data, \'$.status\', ' + sqlValue('已失效') + ')' +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE collection = ' + sqlValue('isolationConclusions') +
    ' AND json_extract(data, \'$.batchNo\') = ' + sqlValue(batchNo) + ';'
  );
}

function setItemIsolated(itemType, itemId) {
  const collection = itemType === 'puppetHead' ? 'puppetHeads' : 'accessories';
  const item = loadRecord(collection, itemId);
  if (!item) return null;
  if (item.status === '隔离中') return item;
  const isolatable = ['可演出', '在库', '外借', '已装箱'];
  if (isolatable.includes(item.status)) {
    item.status = '隔离中';
    saveRecord(collection, itemId, item, '隔离中');
  }
  return item;
}

function restoreItem(itemType, itemId, qualified) {
  const collection = itemType === 'puppetHead' ? 'puppetHeads' : 'accessories';
  const item = loadRecord(collection, itemId);
  if (!item) return null;
  if (qualified) {
    item.status = itemType === 'puppetHead' ? '可演出' : '在库';
  } else {
    item.status = itemType === 'puppetHead' ? '不可演出' : '缺损';
  }
  saveRecord(collection, itemId, item, item.status);
  return item;
}

function markNoticeStage(noticeNo, stage) {
  runSql(
    'UPDATE records SET status = ' + sqlValue(stage) +
    ', data = json_set(data, \'$.status\', ' + sqlValue(stage) + ')' +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE collection = ' + sqlValue('recallNotices') +
    ' AND json_extract(data, \'$.noticeNo\') = ' + sqlValue(noticeNo) + ';'
  );
}

app.post('/api/recallNotices', (req, res, next) => {
  try {
    const { noticeNo, batchNo, supplier, reason, boxNo, actor, note } = req.body;
    if (!noticeNo || !batchNo || !boxNo) {
      return res.status(400).json({ error: 'noticeNo、batchNo、boxNo 为必填项' });
    }
    const existing = findRecallNotice(noticeNo);
    if (existing) {
      return res.status(200).json({
        notice: existing,
        replayed: true,
        message: '通知编号已存在，返回已有记录（幂等重放）'
      });
    }
    const id = randomUUID();
    const createdAt = now();
    runSql(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        sqlValue(id),
        sqlValue('recallNotices'),
        sqlValue('待处理'),
        sqlValue(noticeNo + ' / ' + batchNo),
        sqlValue(JSON.stringify({
          noticeNo,
          batchNo,
          supplier: supplier || '',
          reason: reason || '',
          boxNo,
          status: '待处理',
          version: 1,
          confirmedBy: '',
          confirmedAt: '',
          actor: actor || '',
          note: note || ''
        })),
        sqlValue(createdAt),
        sqlValue(createdAt)
      ].join(', ') + ');'
    );
    const affectedItems = traceAffectedItems(batchNo);
    const lossReports = generateLossReports(noticeNo, batchNo, affectedItems);
    for (const headId of affectedItems.headIds) setItemIsolated('puppetHead', headId);
    for (const accId of affectedItems.accessoryIds) setItemIsolated('accessory', accId);
    const conclusion = createConclusion(noticeNo, batchNo, affectedItems);
    insertEvent({
      recordId: id,
      collection: 'recallNotices',
      action: '召回通知创建',
      status: '待处理',
      actor: actor || '',
      note: note || '',
      data: { noticeNo, batchNo, boxNo, affectedItems, lossReportCount: lossReports.length }
    });
    res.status(201).json({
      notice: findRecallNotice(noticeNo),
      conclusion,
      lossReports,
      replayed: false
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/recallNotices', (req, res, next) => {
  try {
    const rows = select(
      'SELECT * FROM records WHERE collection = ' + sqlValue('recallNotices') + ' ORDER BY created_at DESC;'
    ).map(toRecord);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/recallNotices/:noticeNo', (req, res, next) => {
  try {
    const notice = findRecallNotice(req.params.noticeNo);
    if (!notice) return res.status(404).json({ error: 'not found' });
    res.json(notice);
  } catch (error) {
    next(error);
  }
});

app.post('/api/recallNotices/:noticeNo/confirmIsolation', (req, res, next) => {
  try {
    const notice = findRecallNotice(req.params.noticeNo);
    if (!notice) return res.status(404).json({ error: 'not found' });
    const { actor, note } = req.body;
    if (notice.status !== '待处理') {
      return res.status(409).json({
        error: '隔离已被确认（先到者占用）',
        notice,
        currentBoxNo: notice.boxNo,
        currentStage: notice.status,
        version: notice.version,
        confirmedBy: notice.confirmedBy
      });
    }
    runSql(
      'UPDATE records SET status = ' + sqlValue('已隔离') +
      ', data = json_set(data, ' +
      sqlValue('$.status') + ', ' + sqlValue('已隔离') + ', ' +
      sqlValue('$.confirmedBy') + ', ' + sqlValue(actor || '') + ', ' +
      sqlValue('$.confirmedAt') + ', ' + sqlValue(now()) + ', ' +
      sqlValue('$.version') + ', json_extract(data, ' + sqlValue('$.version') + ') + 1)' +
      ', updated_at = ' + sqlValue(now()) +
      ' WHERE collection = ' + sqlValue('recallNotices') +
      ' AND json_extract(data, ' + sqlValue('$.noticeNo') + ') = ' + sqlValue(req.params.noticeNo) +
      ' AND status = ' + sqlValue('待处理') + ';'
    );
    const updated = findRecallNotice(req.params.noticeNo);
    if (updated.status === '已隔离' && updated.confirmedBy === (actor || '')) {
      insertEvent({
        recordId: notice.id,
        collection: 'recallNotices',
        action: '隔离确认',
        status: '已隔离',
        actor: actor || '',
        note: note || '',
        data: { boxNo: notice.boxNo }
      });
      res.json({ notice: updated, confirmed: true });
    } else {
      res.status(409).json({
        error: '隔离已被确认（先到者占用）',
        notice: updated,
        currentBoxNo: updated.boxNo,
        currentStage: updated.status,
        version: updated.version,
        confirmedBy: updated.confirmedBy
      });
    }
  } catch (error) {
    next(error);
  }
});

app.post('/api/recallNotices/:noticeNo/returnItem', (req, res, next) => {
  try {
    const notice = findRecallNotice(req.params.noticeNo);
    if (!notice) return res.status(404).json({ error: 'not found' });
    const { itemType, itemId, actor, note } = req.body;
    if (!itemType || !itemId) {
      return res.status(400).json({ error: 'itemType、itemId 为必填项' });
    }
    const collection = itemType === 'puppetHead' ? 'puppetHeads' : 'accessories';
    const item = loadRecord(collection, itemId);
    if (!item) return res.status(404).json({ error: 'item not found' });
    if (notice.status === '待处理' || notice.status === '已隔离') {
      markNoticeStage(req.params.noticeNo, '已归还');
    }
    runSql(
      'UPDATE records SET status = ' + sqlValue('已补齐') +
      ', data = json_set(data, ' + sqlValue('$.status') + ', ' + sqlValue('已补齐') + ')' +
      ', updated_at = ' + sqlValue(now()) +
      ' WHERE collection = ' + sqlValue('lossReports') +
      ' AND json_extract(data, ' + sqlValue('$.sourceNoticeNo') + ') = ' + sqlValue(req.params.noticeNo) +
      ' AND json_extract(data, ' + sqlValue('$.itemType') + ') = ' + sqlValue(itemType) +
      ' AND json_extract(data, ' + sqlValue('$.itemId') + ') = ' + sqlValue(itemId) + ';'
    );
    insertEvent({
      recordId: notice.id,
      collection: 'recallNotices',
      action: '物件归还',
      status: '已归还',
      actor: actor || '',
      note: note || '',
      data: { itemType, itemId }
    });
    res.json({ notice: findRecallNotice(req.params.noticeNo), item, returned: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/recallNotices/:noticeNo/reinspect', (req, res, next) => {
  try {
    const notice = findRecallNotice(req.params.noticeNo);
    if (!notice) return res.status(404).json({ error: 'not found' });
    const { itemType, itemId, qualified, inspector, note } = req.body;
    if (!itemType || !itemId) {
      return res.status(400).json({ error: 'itemType、itemId 为必填项' });
    }
    const lossRows = select(
      'SELECT * FROM records WHERE collection = ' + sqlValue('lossReports') +
      ' AND json_extract(data, ' + sqlValue('$.sourceNoticeNo') + ') = ' + sqlValue(req.params.noticeNo) +
      ' AND json_extract(data, ' + sqlValue('$.itemType') + ') = ' + sqlValue(itemType) +
      ' AND json_extract(data, ' + sqlValue('$.itemId') + ') = ' + sqlValue(itemId) + ';'
    );
    const returned = lossRows.some((r) => r.status === '已补齐');
    if (qualified && !returned) {
      return res.status(400).json({
        error: '物件尚未归还，无法恢复可用',
        notice: findRecallNotice(req.params.noticeNo),
        returned: false
      });
    }
    const restored = restoreItem(itemType, itemId, qualified);
    if (!restored) return res.status(404).json({ error: 'item not found' });
    if (notice.status !== '已闭环') {
      markNoticeStage(req.params.noticeNo, '复检中');
    }
    insertEvent({
      recordId: notice.id,
      collection: 'recallNotices',
      action: '复检' + (qualified ? '合格' : '不合格'),
      status: '复检中',
      actor: inspector || '',
      note: note || '',
      data: { itemType, itemId, qualified, returned }
    });
    res.json({
      notice: findRecallNotice(req.params.noticeNo),
      item: restored,
      qualified,
      restored: qualified && returned
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/recallNotices/:noticeNo/conclusion', (req, res, next) => {
  try {
    const notice = findRecallNotice(req.params.noticeNo);
    if (!notice) return res.status(404).json({ error: 'not found' });
    let conclusion = findConclusion(req.params.noticeNo);
    if (!conclusion) {
      const affectedItems = traceAffectedItems(notice.batchNo);
      conclusion = createConclusion(req.params.noticeNo, notice.batchNo, affectedItems);
    } else if (conclusion.status === '已失效') {
      conclusion = recalculateConclusion(req.params.noticeNo);
    }
    res.json(conclusion);
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message || 'server error' });
});

app.listen(PORT, () => {
  console.log(config.title + ' API running at http://localhost:' + PORT);
});

}

startServer().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
