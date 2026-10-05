# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱、外借、胶水召回与隔离处置。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 数据存储

使用纯 WASM 的 [sql.js](https://github.com/sql-js/sql.js)（无需系统 sqlite3），
数据库文件在首次启动时创建到 `data/app.db`，每个写事务提交后落盘。

## 胶水召回处置：一条账

召回处置把「修补记录 → 材料批次 → 偶头/配件 → 外借/在途装箱 → 隔离 → 复检」串成一条可重放的账：

1. **登记材料批次**：`repairRecords` 必填 `materialBatch`（材料批次），可带 `materialSupplier`。
2. **登记召回通知**：`POST /api/recallNotices`，`noticeNo` 唯一；同一通知编号重复提交返回既有记录（`replayed: true`），不重复建档。
3. **执行处置**：`POST /api/recallNotices/:noticeNo/process`
   - 按批次追到所有修补记录 → 偶头（及粘挂配件、同剧同角色在用配件）；
   - 定位每件物件当前位置：戏班库房 / 外借中 / 巡演装箱；
   - 在库的置「待隔离」，在外借或在途装箱的置「待归还」并锁定（`currentUsable=false`，防止受影响偶头仍被排出场）；
   - 仍在巡演箱内的物件自动生成缺损追踪（`lossReports`，按 通知+物件 幂等，重放不重复）。
4. **恢复**：`POST /api/recallNotices/:noticeNo/recover`。通知级、隔离物件级、缺损追踪级各有幂等键，
   写入失败/半完成崩溃后按通知编号重放即可恢复，**不会重复生成缺损追踪**。
5. **查询一条账**：`GET /api/recallNotices/:noticeNo/ledger`
   返回通知、批次追溯、隔离台账（阶段/当前箱号/占用保管员）、缺损追踪、`awayItems`（仍在外借或装箱的物件）。

### 保管员隔离确认（并发先到者占用）

- `POST /api/quarantineItems/:id/claim`，body `{ "keeper": "赵保管", "boxNo": "隔离柜-A1" }`。
- 两名保管员同时确认时，以 `(隔离项, 确认轮次)` 唯一约束抢占：先到者 200 占用；
  后到者收到 409，内含**当前箱号** `currentBoxNo`、**处理阶段** `stage=已占用`、先占者与时间。
- 物件尚未归还（外借/在途装箱）时占用返回 409，并带当前箱号与 `stage=待归还`。

### 归还与复检（已归还并复检合格才恢复可用）

- `POST /api/loanRecords/:id/return` `{ "passed": true|false }`：外借归还，自动推进对应隔离项。
- `POST /api/tourBoxes/:id/close`：巡演箱闭环，箱内待归还物件回到「待隔离」等保管员确认。
- `POST /api/quarantineItems/:id/recheck` `{ "passed": true|false }`：
  仅已占用项可复检；合格且该物件在**所有**召回通知上均闭环才解除隔离、恢复可用；
  不合格置偶头「不可演出」/配件「缺损」。

### 批次或修补记录修改 → 原结论失效重算

- `PATCH /api/repairRecords/:id` 改 `materialBatch` 或修补内容后：
  关联偶头在相关通知上的隔离结论自动置「结论失效」并重算（材料批次本身被改时，复检合格结论也失效）；
  新命中的物件重开隔离（确认轮次 +1，旧占用作废）；不再命中的自动解除。
- 通知处置全程对修补记录、偶头、配件、台账写事件流水，可用
  `GET /api/:collection/:id/timeline` 审计。

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`（需 `puppetHeadId/repairType/handler/materialBatch`）
- `POST /api/tourBoxes`、`POST /api/tourBoxes/:id/close`
- `POST /api/loanRecords`、`POST /api/loanRecords/:id/return`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`
