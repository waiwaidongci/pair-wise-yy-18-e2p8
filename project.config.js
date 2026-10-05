module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱、外借、胶水召回与隔离处置。',
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '待修补', '修补中', '试演中', '不可演出', '已装箱', '待隔离', '隔离中'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '已装箱', '缺损', '遗失', '待隔离', '隔离中'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['puppetHeadId', 'repairType', 'handler', 'materialBatch'],
      titleFields: ['repairType', 'handler'],
      defaults: { materialSupplier: '' }
    },
    tourBoxes: {
      label: '巡演装箱单',
      defaultStatus: '草稿',
      statuses: ['草稿', '已装箱', '巡演中', '返场清点中', '已闭环'],
      required: ['showName', 'venue', 'play', 'headIds', 'accessoryIds'],
      titleFields: ['showName', 'play']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已补齐', '确认为遗失'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    },
    loanRecords: {
      label: '外借登记',
      defaultStatus: '外借中',
      statuses: ['外借中', '已归还', '已归还待复检', '复检合格', '复检不合格'],
      required: ['itemType', 'itemId', 'borrower', 'dueAt'],
      titleFields: ['borrower', 'itemType']
    },
    recallNotices: {
      label: '胶水召回通知',
      defaultStatus: '待处理',
      statuses: ['待处理', '处置中', '已处置'],
      required: ['noticeNo', 'materialBatch', 'supplier'],
      titleFields: ['noticeNo', 'materialBatch']
    },
    quarantineItems: {
      label: '隔离台账',
      defaultStatus: '待隔离',
      statuses: ['待隔离', '待归还', '已占用', '复检合格', '复检不合格', '已解除', '结论失效'],
      required: ['noticeNo', 'materialBatch', 'itemType', 'itemId'],
      titleFields: ['noticeNo', 'itemType']
    }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-2',
      status: '可演出',
      data: {
        role: '铁扇公主',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '正常',
        accessories: ['红缨冠'],
        boxNo: '木箱甲-01',
        currentUsable: true
      },
      note: '在档偶头'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-2',
      status: '在库',
      data: {
        name: '短靠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'repairRecords',
      id: 'repair-seed-1',
      status: '已完成',
      data: {
        puppetHeadId: 'head-seed-1',
        repairType: '粘接口机关',
        handler: '陈师傅',
        materialBatch: 'GLUE-2026-07',
        materialSupplier: '祥瑞化工',
        note: '换胶后试演一场'
      },
      note: '使用批次 GLUE-2026-07'
    },
    {
      collection: 'repairRecords',
      id: 'repair-seed-2',
      status: '补漆中',
      data: {
        puppetHeadId: 'head-seed-2',
        repairType: '补点翠胶',
        handler: '陈师傅',
        materialBatch: 'GLUE-2026-07',
        materialSupplier: '祥瑞化工',
        note: ''
      },
      note: '同批次胶水'
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/repairRecords 创建修补记录（需登记 materialBatch 材料批次）',
    'POST /api/tourBoxes 创建巡演装箱单',
    'POST /api/lossReports 登记返场缺损或遗失',
    'POST /api/recallNotices 登记胶水召回通知（noticeNo 唯一）',
    'POST /api/recallNotices/:noticeNo/process 按批次追溯并处置（同一通知只处理一次）'
  ]
};
