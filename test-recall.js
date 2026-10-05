const http = require('http');

const BASE = 'http://localhost:3914';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + label);
  } else {
    failed++;
    console.log('  ✗ ' + label);
  }
}

async function runTests() {
  console.log('\n=== 木偶戏班胶水召回处置测试 ===\n');

  // 1. 创建材料批次
  console.log('1. 修补单登记材料批次');
  const batch = await request('POST', '/api/materialBatches', {
    batchNo: 'BATCH-2026-001',
    materialName: '强力胶水',
    supplier: '胶水供应商A',
    receivedDate: '2026-09-01'
  });
  assert(batch.status === 201, '创建材料批次成功');
  assert(batch.body.batchNo === 'BATCH-2026-001', '批次号正确');

  // 2. 创建偶头
  const head = await request('POST', '/api/puppetHeads', {
    role: '武生',
    play: '火焰山',
    paintStatus: '正常',
    mechanism: '正常',
    boxNo: '木箱甲-01',
    accessories: ['红缨冠', '短靠']
  });
  assert(head.status === 201, '创建偶头成功');
  const headId = head.body.id;

  // 3. 创建配件
  const acc = await request('POST', '/api/accessories', {
    name: '红缨冠',
    role: '武生',
    play: '火焰山',
    boxNo: '配件箱-01'
  });
  assert(acc.status === 201, '创建配件成功');
  const accId = acc.body.id;

  // 4. 创建修补记录，登记材料批次
  const repair = await request('POST', '/api/repairRecords', {
    puppetHeadId: headId,
    repairType: '补漆',
    handler: '张师傅',
    materialBatch: 'BATCH-2026-001',
    accessoryIds: [accId]
  });
  assert(repair.status === 201, '创建修补记录成功');
  assert(repair.body.materialBatch === 'BATCH-2026-001', '修补记录登记了材料批次');

  // 5. 将偶头设为外借状态
  await request('PATCH', `/api/puppetHeads/${headId}`, { status: '外借' });
  const headCheck = await request('GET', `/api/puppetHeads/${headId}`);
  assert(headCheck.body.status === '外借', '偶头已设为外借');

  // 6. 创建召回通知
  console.log('\n2. 供应商撤回按批次追溯');
  const notice = await request('POST', '/api/recallNotices', {
    noticeNo: 'NOTICE-2026-001',
    batchNo: 'BATCH-2026-001',
    supplier: '胶水供应商A',
    reason: '胶水批次质量问题',
    boxNo: '隔离箱-01',
    actor: '保管员李'
  });
  assert(notice.status === 201, '创建召回通知成功');
  assert(notice.body.notice.noticeNo === 'NOTICE-2026-001', '通知编号正确');
  assert(notice.body.notice.status === '待处理', '通知状态为待处理');
  assert(notice.body.conclusion !== null, '生成了隔离结论');
  assert(notice.body.conclusion.affectedHeadIds.includes(headId), '追溯到受影响偶头');
  assert(notice.body.conclusion.affectedAccessoryIds.includes(accId), '追溯到受影响配件');
  assert(notice.body.lossReports.length > 0, '生成了缺损追踪（外借物件）');

  // 检查偶头是否被隔离
  const headAfter = await request('GET', `/api/puppetHeads/${headId}`);
  assert(headAfter.body.status === '隔离中', '受影响偶头已隔离');

  // 7. 幂等重放：同一通知编号只处理一次
  console.log('\n3. 同一通知编号重放只处理一次');
  const replay = await request('POST', '/api/recallNotices', {
    noticeNo: 'NOTICE-2026-001',
    batchNo: 'BATCH-2026-001',
    boxNo: '隔离箱-01'
  });
  assert(replay.status === 200, '重放返回200');
  assert(replay.body.replayed === true, '标记为重放');
  assert(replay.body.notice.noticeNo === 'NOTICE-2026-001', '返回已有通知');

  // 8. 隔离确认：先到者占用
  console.log('\n4. 隔离确认先到者占用');
  const confirm1 = await request('POST', '/api/recallNotices/NOTICE-2026-001/confirmIsolation', {
    actor: '保管员王'
  });
  assert(confirm1.status === 200, '第一个保管员确认成功');
  assert(confirm1.body.confirmed === true, '确认标记为true');
  assert(confirm1.body.notice.status === '已隔离', '状态变为已隔离');

  // 9. 隔离确认：后到者看到当前箱号和处理阶段
  const confirm2 = await request('POST', '/api/recallNotices/NOTICE-2026-001/confirmIsolation', {
    actor: '保管员赵'
  });
  assert(confirm2.status === 409, '第二个保管员收到409冲突');
  assert(confirm2.body.error.includes('先到者占用'), '错误信息说明先到者占用');
  assert(confirm2.body.currentBoxNo === '隔离箱-01', '后到者看到当前箱号');
  assert(confirm2.body.currentStage === '已隔离', '后到者看到当前处理阶段');
  assert(confirm2.body.confirmedBy === '保管员王', '后到者看到先到者');

  // 10. 物件归还
  console.log('\n5. 已归还并复检合格才恢复可用');
  const returnItem = await request('POST', '/api/recallNotices/NOTICE-2026-001/returnItem', {
    itemType: 'puppetHead',
    itemId: headId,
    actor: '保管员李'
  });
  assert(returnItem.status === 200, '物件归还成功');
  assert(returnItem.body.returned === true, '归还标记为true');

  // 11. 复检合格前不能恢复可用
  const reinspectNotReturned = await request('POST', '/api/recallNotices/NOTICE-2026-001/reinspect', {
    itemType: 'accessory',
    itemId: accId,
    qualified: true,
    inspector: '质检员陈'
  });
  assert(reinspectNotReturned.status === 400, '配件未归还不能恢复');

  // 12. 复检合格后恢复可用
  const reinspect = await request('POST', '/api/recallNotices/NOTICE-2026-001/reinspect', {
    itemType: 'puppetHead',
    itemId: headId,
    qualified: true,
    inspector: '质检员陈'
  });
  assert(reinspect.status === 200, '复检成功');
  assert(reinspect.body.qualified === true, '复检合格');
  assert(reinspect.body.restored === true, '物件恢复可用');
  assert(reinspect.body.item.status === '可演出', '偶头恢复为可演出');

  // 13. 材料批次修改后隔离结论失效重算
  console.log('\n6. 材料批次修改后隔离结论失效重算');
  const batchUpdate = await request('PATCH', `/api/materialBatches/${batch.body.id}`, {
    supplier: '胶水供应商B'
  });
  assert(batchUpdate.status === 200, '修改材料批次成功');

  const conclusionAfterUpdate = await request('GET', '/api/recallNotices/NOTICE-2026-001/conclusion');
  assert(conclusionAfterUpdate.status === 200, '获取结论成功');
  assert(conclusionAfterUpdate.body.status === '有效', '结论已重算为有效');
  assert(conclusionAfterUpdate.body.version > 1, '结论版本号递增（重算过）');

  // 14. 修补记录修改后隔离结论失效重算
  const repairUpdate = await request('PATCH', `/api/repairRecords/${repair.body.id}`, {
    handler: '张师傅（资深）'
  });
  assert(repairUpdate.status === 200, '修改修补记录成功');

  const conclusionAfterRepair = await request('GET', '/api/recallNotices/NOTICE-2026-001/conclusion');
  assert(conclusionAfterRepair.status === 200, '获取结论成功');
  assert(conclusionAfterRepair.body.status === '有效', '结论已重算为有效');

  // 15. 写入失败后按通知编号恢复，不重复生成缺损追踪
  console.log('\n7. 写入失败后按通知编号恢复');
  const lossReportsBefore = await request('GET', '/api/lossReports?sourceNoticeNo=NOTICE-2026-001');
  const countBefore = lossReportsBefore.body.length;
  // 重新获取结论（模拟恢复）
  const conclusionRecover = await request('GET', '/api/recallNotices/NOTICE-2026-001/conclusion');
  assert(conclusionRecover.status === 200, '恢复获取结论成功');
  const lossReportsAfter = await request('GET', '/api/lossReports?sourceNoticeNo=NOTICE-2026-001');
  assert(lossReportsAfter.body.length === countBefore, '缺损追踪数量不变（不重复生成）');

  console.log('\n=== 测试结果 ===');
  console.log(`通过: ${passed}, 失败: ${failed}`);
  if (failed > 0) {
    console.log('\n有失败的测试，请检查！');
    process.exit(1);
  } else {
    console.log('\n所有测试通过！');
  }
}

runTests().catch((err) => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
