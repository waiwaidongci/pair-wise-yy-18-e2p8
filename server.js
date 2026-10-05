const express = require('express');
const { randomUUID } = require('crypto');
const config = require('./project.config');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

// 召回处置流水线各阶段（后到保管员看到的"处理阶段"取此口径）
const STAGES = {
  PENDING: '待隔离',
  AWAIT_RETURN: '待归还',
  CLAIMED: '已占用',
  RECHECK_PASS: '复检合格',
  RECHECK_FAIL: '复检不合格',
  RELEASED: '已解除',
  STALE: '结论失效'
};

// 终态/开放态判定
const OPEN_STAGES = new Set([STAGES.PENDING, STAGES.AWAIT_RETURN, STAGES.CLAIMED, STAGES.STALE]);
const CLOSED_STAGES = new Set([STAGES.RECHECK_PASS, STAGES.RECHECK_FAIL, STAGES.RELEASED]);

const ITEM_COLLECTION = {
  puppetHead: 'puppetHeads',
  accessory: 'accessories'
};

function now() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 通用 records / events 封装
// ---------------------------------------------------------------------------

function initSchema() {
  db.execScript(`
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
-- 幂等键：通知级（重放一次）、隔离物件级、缺损追踪级（写入失败恢复不重复）
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  record_id TEXT,
  created_at TEXT NOT NULL
);
-- 隔离占用：同一轮确认先到者占用
CREATE TABLE IF NOT EXISTS quarantine_claims (
  quarantine_item_id TEXT NOT NULL,
  confirm_round INTEGER NOT NULL DEFAULT 1,
  keeper TEXT NOT NULL,
  box_no TEXT,
  stage TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (quarantine_item_id, confirm_round)
);
`);
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

function list(collection) {
  return db
    .query('SELECT * FROM records WHERE collection = :c ORDER BY updated_at DESC;', { ':c': collection })
    .map(toRecord);
}

function findById(collection, id) {
  const row = db.queryOne(
    'SELECT * FROM records WHERE collection = :c AND id = :id LIMIT 1;',
    { ':c': collection, ':id': id }
  );
  return row ? toRecord(row) : null;
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
  return (
    (collectionConfig.titleFields || [])
      .map((field) => data[field])
      .filter(Boolean)
      .join(' / ') || data.name || data.title || data.code || ''
  );
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter(
    (field) => data[field] === undefined || data[field] === ''
  );
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function insertRecord({ collection, id, status, data }) {
  const collectionConfig = findCollection(collection);
  const recordId = id || randomUUID();
  const ts = now();
  db.run(
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (:id, :c, :s, :t, :d, :a, :u);',
    {
      ':id': recordId,
      ':c': collection,
      ':s': status,
      ':t': titleFor(collectionConfig, data),
      ':d': JSON.stringify(data),
      ':a': ts,
      ':u': ts
    }
  );
  return recordId;
}

function updateRecord(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  db.run(
    'UPDATE records SET status = :s, title = :t, data = :d, updated_at = :u WHERE collection = :c AND id = :id;',
    {
      ':s': status,
      ':t': titleFor(collectionConfig, data),
      ':d': JSON.stringify(data),
      ':u': now(),
      ':c': collection,
      ':id': id
    }
  );
}

function insertEvent({ recordId, collection, action, status, actor, note, data }) {
  db.run(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (:id, :r, :c, :a, :s, :by, :n, :d, :t);',
    {
      ':id': randomUUID(),
      ':r': recordId,
      ':c': collection,
      ':s': status || '',
      ':a': action || '记录',
      ':by': actor || '',
      ':n': note || '',
      ':d': JSON.stringify(data || {}),
      ':t': now()
    }
  );
}

function timeline(recordId) {
  return db
    .query('SELECT * FROM events WHERE record_id = :r ORDER BY created_at ASC, rowid ASC;', {
      ':r': recordId
    })
    .map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
}

// 幂等键：存在即返回既有 recordId；不存在则登记。调用方须处于事务中。
function acquireKey(key, scope, recordId) {
  const inserted = db.tryInsert(
    'INSERT INTO idempotency_keys (key, scope, record_id, created_at) VALUES (:k, :s, :r, :t);',
    { ':k': key, ':s': scope, ':r': recordId || '', ':t': now() }
  );
  if (inserted && recordId) {
    db.run('UPDATE idempotency_keys SET record_id = :r WHERE key = :k;', {
      ':r': recordId,
      ':k': key
    });
  }
  if (!inserted) {
    const row = db.queryOne('SELECT record_id FROM idempotency_keys WHERE key = :k;', { ':k': key });
    return { inserted: false, recordId: row ? row.record_id : '' };
  }
  return { inserted: true, recordId: recordId || '' };
}

function keyExists(key) {
  return Boolean(db.queryOne('SELECT 1 FROM idempotency_keys WHERE key = :k;', { ':k': key }));
}

function seedDatabase() {
  const count = db.queryOne('SELECT COUNT(*) AS c FROM records;').c;
  if (count > 0) return;
  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    db.run(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (:id, :c, :s, :t, :d, :a, :u);',
      {
        ':id': id,
        ':c': seed.collection,
        ':s': status,
        ':t': titleFor(collectionConfig, data),
        ':d': JSON.stringify(data),
        ':a': createdAt,
        ':u': seed.updatedAt || createdAt
      }
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
  db.persist();
}

// ---------------------------------------------------------------------------
// 召回追溯：批次 -> 修补记录 -> 偶头/配件；外借/装箱定位
// ---------------------------------------------------------------------------

const ACTIVE_BOX_STATUSES = ['已装箱', '巡演中', '返场清点中'];
const ACTIVE_LOAN_STATUSES = ['外借中', '已归还待复检', '复检不合格'];

function repairRecordsUsingBatch(batch) {
  return list('repairRecords').filter((r) => String(r.materialBatch || '') === String(batch));
}

function traceBatch(batch) {
  const repairs = repairRecordsUsingBatch(batch);
  const headIds = new Set();
  for (const repair of repairs) {
    if (repair.puppetHeadId) headIds.add(repair.puppetHeadId);
  }

  const heads = [];
  const accessoryIds = new Set();
  for (const headId of headIds) {
    const head = findById('puppetHeads', headId);
    if (!head) continue;
    heads.push(head);
    // 供应商撤回时，偶头粘挂的配件一并追到
    for (const name of head.accessories || []) {
      for (const accessory of list('accessories')) {
        if (accessory.name === name) accessoryIds.add(accessory.id);
      }
    }
  }
  // 同剧目同角色的在用配件同样视为批次影响面（胶可能用于配件贴饰）
  for (const accessory of list('accessories')) {
    if (
      heads.some(
        (head) =>
          head.play === accessory.play &&
          head.role === accessory.role &&
          !['遗失', '缺损'].includes(accessory.status)
      )
    ) {
      accessoryIds.add(accessory.id);
    }
  }
  const accessories = [...accessoryIds]
    .map((id) => findById('accessories', id))
    .filter(Boolean);

  return { repairs, heads, accessories };
}

// 定位单个物件当前在哪里
function locateItem(itemType, itemId) {
  for (const box of list('tourBoxes')) {
    if (!ACTIVE_BOX_STATUSES.includes(box.status)) continue;
    const packed =
      (itemType === 'puppetHead' && (box.headIds || []).includes(itemId)) ||
      (itemType === 'accessory' && (box.accessoryIds || []).includes(itemId));
    if (packed) {
      return { location: '巡演装箱', tourBoxId: box.id, boxNo: box.boxNo || box.id, boxStatus: box.status };
    }
  }
  const loan = list('loanRecords').find(
    (l) =>
      l.itemType === itemType &&
      l.itemId === itemId &&
      ACTIVE_LOAN_STATUSES.includes(l.status)
  );
  if (loan) {
    return {
      location: '外借中',
      loanRecordId: loan.id,
      boxNo: '外借：' + loan.borrower,
      loanStatus: loan.status
    };
  }
  const entity = findById(ITEM_COLLECTION[itemType], itemId);
  return {
    location: '戏班库房',
    boxNo: entity ? entity.boxNo || '' : ''
  };
}

function setHeadUsable(headId, usable, reason) {
  const head = findById('puppetHeads', headId);
  if (!head) return;
  if (head.currentUsable !== usable) {
    head.currentUsable = usable;
    updateRecord('puppetHeads', headId, head, head.status);
    insertEvent({
      recordId: headId,
      collection: 'puppetHeads',
      action: usable ? '恢复可用' : '停用待隔离',
      status: head.status,
      actor: 'recall-engine',
      note: reason,
      data: { currentUsable: usable }
    });
  }
}

function syncEntityUsable(itemType, itemId) {
  // 任一通知上仍有未闭环隔离项 => 不可用 / 待隔离
  const open = list('quarantineItems').some(
    (q) => q.itemType === itemType && q.itemId === itemId && OPEN_STAGES.has(q.status)
  );
  if (itemType === 'puppetHead') {
    setHeadUsable(itemId, !open, open ? '存在未闭环召回隔离' : '召回隔离已闭环');
  }
  return open;
}

function markEntityQuarantine(itemType, itemId, lockedAway, noticeNo) {
  const collectionName = ITEM_COLLECTION[itemType];
  const entity = findById(collectionName, itemId);
  if (!entity) return;
  const targetStatus = lockedAway ? '待隔离' : '隔离中';
  const noticeSet = new Set(entity.quarantineNotices || []);
  const firstEverQuarantine = noticeSet.size === 0;
  const firstHitForNotice = !noticeSet.has(noticeNo);
  if (firstHitForNotice) noticeSet.add(noticeNo);
  entity.quarantineNotices = [...noticeSet];
  if (firstEverQuarantine) {
    entity.preQuarantineStatus =
      entity.status === '待隔离' || entity.status === '隔离中'
        ? entity.preQuarantineStatus || config.collections[collectionName].defaultStatus
        : entity.status;
  }

  const statusChanged =
    entity.status !== targetStatus &&
    entity.status !== '已装箱' &&
    !(entity.status === '隔离中' && !lockedAway);
  if (statusChanged) entity.status = targetStatus;
  if (itemType === 'puppetHead') entity.currentUsable = false;
  updateRecord(collectionName, itemId, entity, entity.status);

  // 同一通知只在首次命中或状态真正变化时写流水，幂等重放保持安静
  if (firstHitForNotice || statusChanged) {
    insertEvent({
      recordId: itemId,
      collection: collectionName,
      action: lockedAway ? '召回隔离（在库）' : '召回锁定（在途/外借）',
      status: entity.status,
      actor: 'recall-engine',
      note: '通知 ' + noticeNo + '：' + (lockedAway ? '已停用待保管员确认' : '已受影响但仍可能出场，待归还'),
      data: { noticeNo }
    });
  }
}

function releaseEntity(itemType, itemId, note, actor, noticeNo) {
  const collectionName = ITEM_COLLECTION[itemType];
  const entity = findById(collectionName, itemId);
  if (!entity) return;
  const notices = new Set(entity.quarantineNotices || []);
  if (noticeNo) notices.delete(noticeNo);
  entity.quarantineNotices = [...notices];

  // 仍被其他召回通知罩着：不还原库态
  if (notices.size === 0 && !['已装箱'].includes(entity.status)) {
    entity.status = entity.preQuarantineStatus || config.collections[collectionName].defaultStatus;
    delete entity.preQuarantineStatus;
  }
  updateRecord(collectionName, itemId, entity, entity.status);
  insertEvent({
    recordId: itemId,
    collection: collectionName,
    action: '隔离解除',
    status: entity.status,
    actor: actor || 'recall-engine',
    note,
    data: { noticeNo: noticeNo || null, remainingNotices: [...notices] }
  });
  if (itemType === 'puppetHead') setHeadUsable(itemId, notices.size === 0, note);
}

// 幂等创建缺损追踪（仍装箱的受影响物件）
function ensureLossReport(noticeNo, itemType, itemId, location) {
  const key = 'loss:' + noticeNo + ':' + itemType + ':' + itemId;
  const existing = keyExists(key);
  const entity = findById(ITEM_COLLECTION[itemType], itemId);
  if (existing) {
    const row = db.queryOne("SELECT record_id FROM idempotency_keys WHERE key = :k;", { ':k': key });
    return { id: row.record_id, created: false };
  }
  const id = randomUUID();
  const data = {
    tourBoxId: location.tourBoxId,
    itemType: itemType === 'puppetHead' ? '偶头' : '配件',
    itemRefId: itemId,
    itemName: entity ? entity.role || entity.name : itemId,
    problem: '胶水召回批次影响，随在途装箱单 ' + (location.boxNo || location.tourBoxId) + ' 待返场隔离',
    status: '待处理',
    source: 'recall',
    noticeNo
  };
  insertRecord({ collection: 'lossReports', id, status: '待处理', data });
  insertEvent({
    recordId: id,
    collection: 'lossReports',
    action: '召回自动生成',
    status: '待处理',
    actor: 'recall-engine',
    note: '通知 ' + noticeNo,
    data
  });
  acquireKey(key, 'loss', id);
  return { id, created: true };
}

// 幂等创建/更新一条隔离台账
function ensureQuarantineItem(noticeNo, batch, itemType, itemId) {
  const key = 'quarantine:' + noticeNo + ':' + itemType + ':' + itemId;
  const location = locateItem(itemType, itemId);
  const away = location.location !== '戏班库房';
  const stage = away ? STAGES.AWAIT_RETURN : STAGES.PENDING;

  if (keyExists(key)) {
    const row = db.queryOne("SELECT record_id FROM idempotency_keys WHERE key = :k;", { ':k': key });
    const qid = row.record_id;
    const q = findById('quarantineItems', qid);
    if (q && OPEN_STAGES.has(q.status)) {
      let changed = false;
      let reopened = false;

      // 结论失效后重算命中 -> 重开，确认轮次 +1（旧占用作废，保管员需重新确认）
      if (q.status === STAGES.STALE) {
        q.status = stage;
        q.confirmRound = (q.confirmRound || 1) + 1;
        q.invalidatedAt = null;
        reopened = true;
        changed = true;
      }

      // 定位变化（在途/外借 <-> 库房）才刷新阶段，避免幂等重放刷流水
      if (q.location !== location.location) {
        if (!reopened && q.status !== STAGES.CLAIMED) q.status = stage;
        changed = true;
      }
      q.location = location.location;
      q.currentBoxNo = location.boxNo || '';
      q.tourBoxId = location.tourBoxId || null;
      q.loanRecordId = location.loanRecordId || null;

      if (changed) {
        updateRecord('quarantineItems', qid, q, q.status);
        insertEvent({
          recordId: qid,
          collection: 'quarantineItems',
          action: reopened ? '结论失效后重开' : '定位变更刷新',
          status: q.status,
          actor: 'recall-engine',
          note: reopened
            ? '批次/修补记录变更后重算，确认轮次升至 ' + q.confirmRound
            : '当前位置变为：' + location.location + ' ' + (location.boxNo || ''),
          data: { location: location.location, boxNo: location.boxNo, confirmRound: q.confirmRound }
        });
      }
    }
    markEntityQuarantine(itemType, itemId, !away, noticeNo);
    if (away && location.location === '巡演装箱') ensureLossReport(noticeNo, itemType, itemId, location);
    return { id: qid, created: false };
  }

  const id = randomUUID();
  const entity = findById(ITEM_COLLECTION[itemType], itemId);
  const data = {
    noticeNo,
    materialBatch: batch,
    itemType,
    itemId,
    itemName: entity ? entity.role || entity.name : itemId,
    status: stage,
    location: location.location,
    currentBoxNo: location.boxNo || '',
    tourBoxId: location.tourBoxId || null,
    loanRecordId: location.loanRecordId || null,
    confirmRound: 1,
    claimedBy: null,
    recheckResult: null
  };
  insertRecord({ collection: 'quarantineItems', id, status: stage, data });
  acquireKey(key, 'quarantine', id);
  insertEvent({
    recordId: id,
    collection: 'quarantineItems',
    action: '建立隔离台账',
    status: stage,
    actor: 'recall-engine',
    note: '批次 ' + batch + ' 追溯命中，当前位置：' + location.location + ' ' + (location.boxNo || ''),
    data
  });
  markEntityQuarantine(itemType, itemId, !away, noticeNo);
  if (away && location.location === '巡演装箱') ensureLossReport(noticeNo, itemType, itemId, location);
  return { id, created: true };
}

// 重算单个通知：批次/修补记录改动后调用
function recomputeNotice(notice) {
  const traced = traceBatch(notice.materialBatch);
  const expected = new Map();
  for (const head of traced.heads) expected.set('puppetHead:' + head.id, head.id);
  for (const accessory of traced.accessories) {
    expected.set('accessory:' + accessory.id, accessory.id);
  }

  // 新命中或需要重开的物件
  for (const [key] of expected) {
    const [itemType, itemId] = key.split(':');
    ensureQuarantineItem(notice.noticeNo, notice.materialBatch, itemType, itemId);
  }

  // 已不再命中的物件：开放/失效项标记解除并尝试还原；终态保留作历史
  for (const q of list('quarantineItems').filter((x) => x.noticeNo === notice.noticeNo)) {
    const key = q.itemType + ':' + q.itemId;
    if (!expected.has(key) && OPEN_STAGES.has(q.status)) {
      q.status = STAGES.RELEASED;
      q.releasedAt = now();
      q.releaseReason = '重算后不再命中召回批次';
      updateRecord('quarantineItems', q.id, q, q.status);
      insertEvent({
        recordId: q.id,
        collection: 'quarantineItems',
        action: '自动解除',
        status: q.status,
        actor: 'recall-engine',
        note: q.releaseReason,
        data: {}
      });
      // 其他通知对该物件均无开放隔离项时，还原库态与可用性
      if (
        !list('quarantineItems').some(
          (x) => x.itemType === q.itemType && x.itemId === q.itemId && OPEN_STAGES.has(x.status)
        )
      ) {
        releaseEntity(q.itemType, q.itemId, q.releaseReason, 'recall-engine', q.noticeNo);
      }
    }
    syncEntityUsable(q.itemType, q.itemId);
  }
  for (const [key] of expected) {
    const [itemType, itemId] = key.split(':');
    syncEntityUsable(itemType, itemId);
  }
}

// 通知处置主流程（幂等，可在写入失败后按通知号重放恢复）
function processNotice(noticeNo, actor) {
  const notice = list('recallNotices').find((n) => n.noticeNo === noticeNo);
  if (!notice) {
    const error = new Error('召回通知不存在: ' + noticeNo);
    error.status = 404;
    throw error;
  }
  const processKey = 'notice-processed:' + noticeNo;

  return db.transaction(() => {
    const already = acquireKey(processKey, 'notice', notice.id);

    if (already.inserted) {
      notice.status = '处置中';
      updateRecord('recallNotices', notice.id, notice, '处置中');
      insertEvent({
        recordId: notice.id,
        collection: 'recallNotices',
        action: '开始处置',
        status: '处置中',
        actor: actor || 'recall-engine',
        note: '按批次 ' + notice.materialBatch + ' 追溯',
        data: {}
      });
    }

    // 无论首次还是恢复，都跑一遍重算——所有写入均幂等，崩溃后重放不会重复生成
    const traced = traceBatch(notice.materialBatch);
    for (const head of traced.heads) {
      ensureQuarantineItem(noticeNo, notice.materialBatch, 'puppetHead', head.id);
    }
    for (const accessory of traced.accessories) {
      ensureQuarantineItem(noticeNo, notice.materialBatch, 'accessory', accessory.id);
    }

    notice.status = '已处置';
    notice.processedAt = now();
    notice.processedBy = actor || notice.processedBy || 'recall-engine';
    updateRecord('recallNotices', notice.id, notice, '已处置');
    insertEvent({
      recordId: notice.id,
      collection: 'recallNotices',
      action: already.inserted ? '处置完成' : '重放恢复确认',
      status: '已处置',
      actor: actor || 'recall-engine',
      note: already.inserted
        ? '追溯偶头 ' + traced.heads.length + ' 件、配件 ' + traced.accessories.length + ' 件'
        : '同一通知编号重放，仅核对不重复处置',
      data: {
        headIds: traced.heads.map((h) => h.id),
        accessoryIds: traced.accessories.map((a) => a.id)
      }
    });

    return {
      noticeNo,
      replayed: !already.inserted,
      repaired: traced.repairs.map((r) => r.id),
      heads: traced.heads
        .map((h) => findById('puppetHeads', h.id))
        .map((h) => ({ id: h.id, name: h.role, status: h.status, usable: h.currentUsable })),
      accessories: traced.accessories
        .map((a) => findById('accessories', a.id))
        .map((a) => ({ id: a.id, name: a.name, status: a.status })),
      quarantineItems: list('quarantineItems').filter((q) => q.noticeNo === noticeNo).map((q) => ({
        id: q.id,
        itemType: q.itemType,
        itemId: q.itemId,
        stage: q.status,
        location: q.location,
        currentBoxNo: q.currentBoxNo
      })),
      lossReports: list('lossReports').filter((l) => l.noticeNo === noticeNo).map((l) => l.id)
    };
  });
}

// 材料批次或修补记录被修改：原隔离结论失效，逐通知重算
// extraBatches：改动前的旧批次——物件可能就此脱离旧通知的召回面，旧通知也必须重算
function invalidateForHead(headId, actor, reason, batchChanged, extraBatches) {
  const relatedNotices = new Set();
  const batches = new Set(
    list('repairRecords')
      .filter((r) => r.puppetHeadId === headId)
      .map((r) => r.materialBatch)
      .filter(Boolean)
  );
  for (const b of extraBatches || []) {
    if (b) batches.add(b);
  }
  for (const notice of list('recallNotices')) {
    if (batches.has(notice.materialBatch)) relatedNotices.add(notice.noticeNo);
  }

  db.transaction(() => {
    for (const q of list('quarantineItems')) {
      if (q.itemType !== 'puppetHead' || q.itemId !== headId) continue;
      if (!relatedNotices.has(q.noticeNo)) continue;
      // 批次本身被改：所有结论一律失效重算（含复检合格）；
      // 仅修补内容变更：已归还并复检合格/已解除的结论保持有效
      if (!batchChanged && (q.status === STAGES.RECHECK_PASS || q.status === STAGES.RELEASED)) continue;
      if (q.status === STAGES.STALE) continue;
      q.status = STAGES.STALE;
      q.invalidatedAt = now();
      q.invalidReason = reason;
      updateRecord('quarantineItems', q.id, q, q.status);
      insertEvent({
        recordId: q.id,
        collection: 'quarantineItems',
        action: '结论失效',
        status: q.status,
        actor: actor || 'repair-hook',
        note: reason,
        data: {}
      });
    }

    for (const noticeNo of relatedNotices) {
      const notice = list('recallNotices').find((n) => n.noticeNo === noticeNo);
      if (notice) {
        recomputeNotice(notice);
        insertEvent({
          recordId: notice.id,
          collection: 'recallNotices',
          action: '批次/修补变更触发重算',
          status: notice.status,
          actor: actor || 'repair-hook',
          note: reason,
          data: { headId }
        });
      }
    }
    syncEntityUsable('puppetHead', headId);
  });
}

// ---------------------------------------------------------------------------
// 通用 REST 接口
// ---------------------------------------------------------------------------

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

app.get('/api/:collection', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const filtered = applyQuery(list(req.params.collection), req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = findById(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

const META_FIELDS = ['action', 'actor', 'note'];

// 登记召回通知（须置于通用 POST /api/:collection 之前，否则会被截胡）：
// 同一 noticeNo 重放返回既有通知，不重复建档。
app.post('/api/recallNotices', (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.noticeNo || !body.materialBatch || !body.supplier) {
      return res.status(400).json({
        error: 'missing required fields: noticeNo, materialBatch, supplier'
      });
    }
    const result = db.transaction(() => {
      const existing = list('recallNotices').find((n) => n.noticeNo === body.noticeNo);
      if (existing) {
        insertEvent({
          recordId: existing.id,
          collection: 'recallNotices',
          action: '重复提交已忽略',
          status: existing.status,
          actor: body.actor || '',
          note: '同一通知编号重放，只处理一次',
          data: { replayed: true }
        });
        return { record: existing, replayed: true };
      }
      const data = {
        noticeNo: body.noticeNo,
        materialBatch: body.materialBatch,
        supplier: body.supplier,
        issuedAt: body.issuedAt || now(),
        reason: body.reason || '供应商胶水召回',
        status: '待处理'
      };
      const id = insertRecord({ collection: 'recallNotices', status: '待处理', data });
      insertEvent({
        recordId: id,
        collection: 'recallNotices',
        action: '登记召回通知',
        status: '待处理',
        actor: body.actor || '',
        note: body.note || '',
        data
      });
      return { record: findById('recallNotices', id), replayed: false };
    });
    res.status(result.replayed ? 200 : 201).json({ ...result.record, replayed: result.replayed });
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    for (const field of META_FIELDS) delete data[field];
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);

    const id = db.transaction(() => {
      const recordId = insertRecord({ collection: req.params.collection, status, data });
      insertEvent({
        recordId,
        collection: req.params.collection,
        action: req.body.action || '创建',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data
      });
      return recordId;
    });
    res.status(201).json(findById(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = findById(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });

    const collectionName = req.params.collection;
    const oldMaterialBatch = record.materialBatch;
    const oldHeadId = record.puppetHeadId;

    const patch = { ...req.body };
    for (const field of META_FIELDS) delete patch[field];
    const nextData = { ...record, ...patch };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;

    const result = db.transaction(() => {
      updateRecord(collectionName, req.params.id, nextData, status);
      insertEvent({
        recordId: req.params.id,
        collection: collectionName,
        action: req.body.action || '更新',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: patch
      });
      return findById(collectionName, req.params.id);
    });
    res.json(result);

    // 修补记录改动（材料批次或修补内容）-> 关联偶头原隔离结论失效重算
    if (collectionName === 'repairRecords' && oldHeadId) {
      const COMPARE_FIELDS = ['puppetHeadId', 'repairType', 'handler', 'materialBatch', 'materialSupplier', 'note'];
      const contentChanged =
        oldMaterialBatch !== nextData.materialBatch ||
        COMPARE_FIELDS.some((f) => JSON.stringify(record[f] ?? null) !== JSON.stringify(nextData[f] ?? null));
      if (contentChanged) {
        invalidateForHead(
          oldHeadId,
          req.body.actor || '',
          oldMaterialBatch !== nextData.materialBatch
            ? '材料批次由 ' + oldMaterialBatch + ' 改为 ' + nextData.materialBatch
            : '修补记录内容修改，隔离结论失效重算',
          oldMaterialBatch !== nextData.materialBatch,
          oldMaterialBatch !== nextData.materialBatch ? [oldMaterialBatch] : []
        );
      }
    }
    // 偶头配件清单改动也可能影响配件追溯面
    if (collectionName === 'puppetHeads' && JSON.stringify(record.accessories || []) !== JSON.stringify(nextData.accessories || [])) {
      for (const notice of list('recallNotices')) {
        const headRepairBatches = new Set(
          list('repairRecords').filter((r) => r.puppetHeadId === req.params.id).map((r) => r.materialBatch)
        );
        if (headRepairBatches.has(notice.materialBatch)) {
          db.transaction(() => recomputeNotice(notice));
        }
      }
    }
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const record = findById(req.params.collection, req.params.id);
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

    const oldMaterialBatch = record.materialBatch;

    const result = db.transaction(() => {
      updateRecord(req.params.collection, req.params.id, nextData, status);
      insertEvent({
        recordId: req.params.id,
        collection: req.params.collection,
        action: req.body.action || status || '记录',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
      return findById(req.params.collection, req.params.id);
    });
    res.json(result);

    if (req.params.collection === 'repairRecords' && record.puppetHeadId) {
      if (oldMaterialBatch !== nextData.materialBatch || Object.keys(req.body.fields || {}).length > 0) {
        invalidateForHead(
          record.puppetHeadId,
          req.body.actor || '',
          oldMaterialBatch !== nextData.materialBatch
            ? '材料批次由 ' + oldMaterialBatch + ' 改为 ' + nextData.materialBatch
            : '修补记录流转更新，隔离结论失效重算',
          oldMaterialBatch !== nextData.materialBatch,
          oldMaterialBatch !== nextData.materialBatch ? [oldMaterialBatch] : []
        );
      }
    }
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = findById(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json({ record, events: timeline(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    db.transaction(() => {
      db.run('DELETE FROM records WHERE collection = :c AND id = :id;', {
        ':c': req.params.collection,
        ':id': req.params.id
      });
      db.run('DELETE FROM events WHERE record_id = :id;', { ':id': req.params.id });
      db.run('DELETE FROM quarantine_claims WHERE quarantine_item_id = :id;', { ':id': req.params.id });
      db.run("DELETE FROM idempotency_keys WHERE record_id = :id;", { ':id': req.params.id });
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 召回通知：处置 / 恢复 / 台账
// ---------------------------------------------------------------------------

// 执行处置 / 写入失败后按通知编号恢复（重放安全）
app.post('/api/recallNotices/:noticeNo/process', (req, res, next) => {
  try {
    const summary = processNotice(req.params.noticeNo, (req.body || {}).actor);
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

app.post('/api/recallNotices/:noticeNo/recover', (req, res, next) => {
  try {
    const summary = processNotice(req.params.noticeNo, (req.body || {}).actor || 'recovery');
    res.json({ recovered: true, ...summary });
  } catch (error) {
    next(error);
  }
});

// 召回处置一条账：通知 + 批次追溯 + 隔离台账 + 缺损追踪
app.get('/api/recallNotices/:noticeNo/ledger', (req, res, next) => {
  try {
    const notice = list('recallNotices').find((n) => n.noticeNo === req.params.noticeNo);
    if (!notice) return res.status(404).json({ error: '召回通知不存在' });
    const traced = traceBatch(notice.materialBatch);
    const quarantine = list('quarantineItems').filter((q) => q.noticeNo === notice.noticeNo);
    res.json({
      notice,
      trace: {
        materialBatch: notice.materialBatch,
        repairs: traced.repairs.map((r) => ({
          id: r.id,
          puppetHeadId: r.puppetHeadId,
          repairType: r.repairType,
          materialBatch: r.materialBatch
        })),
        heads: traced.heads.map((h) => ({ id: h.id, role: h.role, play: h.play, status: h.status, currentUsable: h.currentUsable, boxNo: h.boxNo })),
        accessories: traced.accessories.map((a) => ({ id: a.id, name: a.name, status: a.status, boxNo: a.boxNo }))
      },
      quarantineItems: quarantine.map((q) => ({
        id: q.id,
        itemType: q.itemType,
        itemId: q.itemId,
        itemName: q.itemName,
        stage: q.status,
        location: q.location,
        currentBoxNo: q.currentBoxNo,
        claimedBy: q.claimedBy,
        confirmRound: q.confirmRound,
        recheckResult: q.recheckResult
      })),
      lossReports: list('lossReports').filter((l) => l.noticeNo === notice.noticeNo),
      awayItems: quarantine
        .filter((q) => q.location !== '戏班库房')
        .map((q) => ({
          quarantineItemId: q.id,
          itemType: q.itemType,
          itemId: q.itemId,
          location: q.location,
          currentBoxNo: q.currentBoxNo,
          stage: q.status
        }))
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 隔离占用与复检（两名保管员并发：先到者占用）
// ---------------------------------------------------------------------------

app.post('/api/quarantineItems/:id/claim', (req, res, next) => {
  try {
    const keeper = (req.body || {}).keeper;
    const boxNo = (req.body || {}).boxNo;
    if (!keeper) return res.status(400).json({ error: 'missing keeper' });

    const outcome = db.transaction(() => {
      const q = findById('quarantineItems', req.params.id);
      if (!q) return { http: 404, body: { error: '隔离台账不存在' } };

      const round = q.confirmRound || 1;

      // 物件仍在外借/在途装箱：无法确认隔离
      const liveLocation = locateItem(q.itemType, q.itemId);
      q.location = liveLocation.location;
      q.currentBoxNo = liveLocation.boxNo || q.currentBoxNo || '';

      if (liveLocation.location !== '戏班库房' && q.status !== STAGES.CLAIMED) {
        updateRecord('quarantineItems', q.id, q, q.status);
        return {
          http: 409,
          body: {
            error: '物件尚未归还，无法确认隔离',
            currentBoxNo: q.currentBoxNo,
            location: q.location,
            stage: STAGES.AWAIT_RETURN
          }
        };
      }

      const inserted = db.tryInsert(
        'INSERT INTO quarantine_claims (quarantine_item_id, confirm_round, keeper, box_no, stage, note, created_at) VALUES (:id, :r, :k, :b, :s, :n, :t);',
        {
          ':id': q.id,
          ':r': round,
          ':k': keeper,
          ':b': boxNo || q.currentBoxNo || '',
          ':s': STAGES.CLAIMED,
          ':n': (req.body || {}).note || '',
          ':t': now()
        }
      );

      if (!inserted) {
        const claim = db.queryOne(
          'SELECT * FROM quarantine_claims WHERE quarantine_item_id = :id AND confirm_round = :r;',
          { ':id': q.id, ':r': round }
        );
        return {
          http: 409,
          body: {
            error: '已有保管员先占用',
            occupied: true,
            claimedBy: claim.keeper,
            claimedAt: claim.created_at,
            currentBoxNo: claim.box_no || q.currentBoxNo,
            stage: STAGES.CLAIMED,
            confirmRound: round
          }
        };
      }

      q.status = STAGES.CLAIMED;
      q.claimedBy = keeper;
      q.claimedAt = now();
      q.currentBoxNo = boxNo || q.currentBoxNo;
      updateRecord('quarantineItems', q.id, q, STAGES.CLAIMED);
      insertEvent({
        recordId: q.id,
        collection: 'quarantineItems',
        action: '保管员占用',
        status: STAGES.CLAIMED,
        actor: keeper,
        note: '隔离确认，箱号 ' + (q.currentBoxNo || '未填'),
        data: { confirmRound: round, boxNo: q.currentBoxNo }
      });
      return {
        http: 200,
        body: {
          occupied: true,
          claimedBy: keeper,
          currentBoxNo: q.currentBoxNo,
          stage: STAGES.CLAIMED,
          confirmRound: round
        }
      };
    });
    res.status(outcome.http).json(outcome.body);
  } catch (error) {
    next(error);
  }
});

// 复检结论：合格且无其他未闭环通知才恢复可用
app.post('/api/quarantineItems/:id/recheck', (req, res, next) => {
  try {
    const { passed, note, actor } = req.body || {};
    if (passed === undefined) return res.status(400).json({ error: 'missing passed (boolean)' });

    const outcome = db.transaction(() => {
      const q = findById('quarantineItems', req.params.id);
      if (!q) return { http: 404, body: { error: '隔离台账不存在' } };
      if (q.status !== STAGES.CLAIMED) {
        return {
          http: 409,
          body: { error: '仅已占用（保管员确认隔离）的物件可登记复检', stage: q.status, currentBoxNo: q.currentBoxNo }
        };
      }
      q.status = passed ? STAGES.RECHECK_PASS : STAGES.RECHECK_FAIL;
      q.recheckResult = passed ? '合格' : '不合格';
      q.recheckAt = now();
      q.recheckBy = actor || q.claimedBy || '';
      q.recheckNote = note || '';
      updateRecord('quarantineItems', q.id, q, q.status);
      insertEvent({
        recordId: q.id,
        collection: 'quarantineItems',
        action: passed ? '复检合格' : '复检不合格',
        status: q.status,
        actor: actor || q.claimedBy || '',
        note: note || '',
        data: {}
      });

      const othersOpen = list('quarantineItems').some(
        (x) =>
          x.itemType === q.itemType &&
          x.itemId === q.itemId &&
          x.id !== q.id &&
          OPEN_STAGES.has(x.status)
      );
      // 合格且该物件在所有通知上均已闭环：归还恢复可用；否则保持停用等其他通知
      if (passed && !othersOpen) {
        releaseEntity(
          q.itemType,
          q.itemId,
          '已归还并复检合格，恢复可用（通知 ' + q.noticeNo + '）',
          actor || q.claimedBy,
          q.noticeNo
        );
      }
      syncEntityUsable(q.itemType, q.itemId);
      if (!passed) {
        const collectionName = ITEM_COLLECTION[q.itemType];
        const entity = findById(collectionName, q.itemId);
        if (entity) {
          entity.status = q.itemType === 'puppetHead' ? '不可演出' : '缺损';
          updateRecord(collectionName, q.itemId, entity, entity.status);
        }
      }
      return {
        http: 200,
        body: findById('quarantineItems', q.id)
      };
    });
    res.status(outcome.http).json(outcome.body);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 外借归还 / 巡演返场：归还后隔离阶段自动推进
// ---------------------------------------------------------------------------

app.post('/api/loanRecords/:id/return', (req, res, next) => {
  try {
    const { passed, note, actor } = req.body || {};
    const outcome = db.transaction(() => {
      const loan = findById('loanRecords', req.params.id);
      if (!loan) return { http: 404, body: { error: '外借登记不存在' } };

      loan.status = passed === undefined ? '已归还待复检' : passed ? '复检合格' : '复检不合格';
      loan.returnedAt = now();
      updateRecord('loanRecords', loan.id, loan, loan.status);
      insertEvent({
        recordId: loan.id,
        collection: 'loanRecords',
        action: '归还登记',
        status: loan.status,
        actor: actor || '',
        note: note || '',
        data: { passed }
      });

      // 推进该物件在各通知上的待归还隔离项
      const advanced = [];
      for (const q of list('quarantineItems')) {
        if (q.itemType !== loan.itemType || q.itemId !== loan.itemId) continue;
        if (q.status !== STAGES.AWAIT_RETURN) continue;
        // 仍在巡演箱的不算真正回库
        if (locateItem(q.itemType, q.itemId).location !== '戏班库房') continue;
        if (passed === true) {
          q.status = STAGES.RECHECK_PASS;
          q.recheckResult = '合格';
          q.recheckAt = now();
        } else if (passed === false) {
          q.status = STAGES.RECHECK_FAIL;
          q.recheckResult = '不合格';
          q.recheckAt = now();
        } else {
          q.status = STAGES.PENDING;
        }
        q.location = '戏班库房';
        q.currentBoxNo = (findById(ITEM_COLLECTION[q.itemType], q.itemId) || {}).boxNo || q.currentBoxNo;
        updateRecord('quarantineItems', q.id, q, q.status);
        insertEvent({
          recordId: q.id,
          collection: 'quarantineItems',
          action: '外借归还推进',
          status: q.status,
          actor: actor || 'loan-return',
          note: note || '',
          data: {}
        });
        const open = syncEntityUsable(q.itemType, q.itemId);
        if (passed === true && !open) {
          releaseEntity(q.itemType, q.itemId, '已归还并复检合格，恢复可用', actor || 'loan-return', q.noticeNo);
          syncEntityUsable(q.itemType, q.itemId);
        }
        advanced.push({ quarantineItemId: q.id, stage: q.status });
      }
      return { http: 200, body: { loan: findById('loanRecords', loan.id), advanced } };
    });
    res.status(outcome.http).json(outcome.body);
  } catch (error) {
    next(error);
  }
});

// 巡演箱闭环：箱内受影响物件回到库房，待归还 -> 待隔离（等保管员占用）
app.post('/api/tourBoxes/:id/close', (req, res, next) => {
  try {
    const { actor } = req.body || {};
    const outcome = db.transaction(() => {
      const box = findById('tourBoxes', req.params.id);
      if (!box) return { http: 404, body: { error: '装箱单不存在' } };
      box.status = '已闭环';
      box.closedAt = now();
      updateRecord('tourBoxes', box.id, box, '已闭环');
      insertEvent({
        recordId: box.id,
        collection: 'tourBoxes',
        action: '巡演箱闭环',
        status: '已闭环',
        actor: actor || '',
        note: '',
        data: {}
      });

      const advanced = [];
      const members = [
        ...(box.headIds || []).map((id) => ['puppetHead', id]),
        ...(box.accessoryIds || []).map((id) => ['accessory', id])
      ];
      for (const [itemType, itemId] of members) {
        for (const q of list('quarantineItems')) {
          if (q.itemType !== itemType || q.itemId !== itemId) continue;
          if (q.status !== STAGES.AWAIT_RETURN) continue;
          if (locateItem(itemType, itemId).location !== '戏班库房') continue;
          q.status = STAGES.PENDING;
          q.location = '戏班库房';
          const entity = findById(ITEM_COLLECTION[itemType], itemId);
          q.currentBoxNo = (entity || {}).boxNo || q.currentBoxNo;
          updateRecord('quarantineItems', q.id, q, STAGES.PENDING);
          insertEvent({
            recordId: q.id,
            collection: 'quarantineItems',
            action: '返场入库待隔离',
            status: STAGES.PENDING,
            actor: actor || 'box-close',
            note: '巡演箱 ' + box.id + ' 已闭环',
            data: {}
          });
          markEntityQuarantine(itemType, itemId, true, q.noticeNo);
          advanced.push({ quarantineItemId: q.id, stage: STAGES.PENDING });
        }
      }
      return { http: 200, body: { box: findById('tourBoxes', box.id), advanced } };
    });
    res.status(outcome.http).json(outcome.body);
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message || 'server error' });
});

db.init().then(() => {
  initSchema();
  seedDatabase();
  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
    console.log('SQLite file: ' + db.DB_FILE);
  });
});
