/** 合成发布任务评测。node scripts/benchmark-privacy.js [基线提交] [--json] */
'use strict';

const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const current = require('../services/localDetector');

// 用片段直接标注类型和原文区间，支持重复字段、全角字符和 UTF-16 偏移。
function sample(id, group, ...parts) {
  let text = '';
  const expected = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      text += part;
    } else {
      const [type, value] = part;
      const start = text.length;
      text += value;
      expected.push({ type, start, end: text.length });
    }
  }
  return { id, group, text, expected };
}

const corpus = [
  sample('N01', '拆分号码', '📣 报名遇到问题请联系 ', ['phone', '139\n0013\t9000'], '，晚上九点前均可。'),
  sample('N02', '拆分号码', '志愿者群公告里请删掉登记号 ', ['id', '110105\t19491231\u202f002-X'], '。'),
  sample('N03', '拆分号码', '活动退费登记 ', ['bankcard', '4111—1111\n1111\t1111'], '，请私下核对。'),
  sample('N04', '拆分号码', '旧版值班通知：', ['phone', '１３９.００１３.９０００'], '，目前仍有效。'),
  sample('N05', '拆分号码', '表格两列复制出来是 ', ['phone', '139001\u00a039000'], '，请删除这一列。'),
  sample('N06', '拆分号码', '旧手机号 ', ['phone', '139\n0013\n9000'], '\n新手机号 ', ['phone', '137\n0013\n7000']),
  sample('N07', '拆分号码', '两行连续复制：\n', ['phone', '139\n00139000'], '\n', ['phone', '137\n00137000']),
  sample('N08', '拆分号码', '口述版本：手机号是', ['phone', '一三九零零一三九零零零'], '，记得私聊。'),
  sample('N09', '拆分号码', '照片说明：手机号写成了 ', ['phone', '139（0013）9000'], '。'),
  sample('B01', '常规字段', '测试联络方式 ', ['phone', '13700137000'], '，回执发 ', ['email', 'club@example.com'], '。'),
  sample('B02', '常规字段', '文件里误带验证码：', ['otp', '583624'], '，请删掉。'),
  sample('B03', '常规字段', '内部调试地址 ', ['ip', '192.168.12.42'], '，可在局域网访问。'),
  sample('B04', '常规字段', '联系人：', ['name', '林小满'], '，今晚值班。'),
  sample('S01', '姓名住址', ['name', '周星禾'], '负责汇总报名表，请把记录交给她。'),
  sample('S02', '姓名住址', '钥匙先送到', ['address', '杭州市云杉路18号'], '，签收后通知。'),
  sample('S03', '姓名住址', '收件人：', ['name', '沈青禾'], '；收件地址：', ['address', '云杉街道春雨路17号2栋502室'], '。'),
  sample('S04', '姓名住址', '紧急联系人写的是', ['name', '许知远'], '，方便时请联系本人。'),
  sample('F01', '正常文案', '通知版本 v139.0013.9000，开放报名。'),
  sample('F02', '正常文案', '赛题样例小数 139.00139000，保留全部小数位。'),
  sample('F03', '正常文案', '成绩导出 139\n0013\n9000 三行，分别表示序号、分组和总分。'),
  sample('F04', '正常文案', '订单号 202608120000000123，编号由日期和流水号组成。'),
  sample('F05', '正常文案', '本周在杭州参加创客活动，公开场地见学校通知。'),
  sample('F06', '正常文案', '表格代码 139\n\n0013\t9000，空行表示下一组。'),
  sample('F07', '正常文案', '开发文档 https://139.0013.9000.example，供志愿者参考。'),
  sample('F08', '正常文案', '联系人是值班老师，请通过活动页面提问。'),
  sample('F09', '正常文案', '用 AI 整理这份值班通知，保留时间和活动地点。'),
];

function loadBaseline(ref) {
  const root = path.join(__dirname, '..');
  const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
    cwd: root, encoding: 'utf8',
  }).trim();
  const show = (file) => execFileSync('git', ['show', `${commit}:services/${file}`], {
    cwd: root, encoding: 'utf8',
  });
  // 旧引擎和 schema 取同一提交。隔离加载以免混用工作区的规则或类型定义。
  const context = vm.createContext({});
  vm.runInContext(show('schema.js'), context, { filename: `${commit}:schema.js` });
  vm.runInContext(show('localDetector.js'), context, { filename: `${commit}:localDetector.js` });
  return { commit, detector: context.PSLocal };
}

const spanKey = ({ type, start, end }) => `${type}:${start}:${end}`;
const counter = () => ({ tp: 0, fp: 0, fn: 0 });
const ratio = (part, total) => total === 0 ? null : part / total;

function measure(detector) {
  const all = counter();
  const byGroup = {};
  const byType = {};
  const issues = [];
  let clean = 0;
  let cleanWithAlerts = 0;
  let incompleteCoverage = 0;

  for (const { id, group, text, expected } of corpus) {
    const actual = detector.detect(text);
    const remaining = new Map(expected.map((item) => [spanKey(item), item]));
    const groupCounts = byGroup[group] ??= counter();
    const record = (type, result) => {
      const typeCounts = byType[type] ??= counter();
      for (const counts of [all, groupCounts, typeCounts]) counts[result]++;
    };
    if (expected.length === 0) {
      clean++;
      if (actual.length > 0) cleanWithAlerts++;
    }
    for (const item of actual) {
      if (remaining.delete(spanKey(item))) {
        record(item.type, 'tp');
      } else {
        record(item.type, 'fp');
        issues.push({ id, issue: 'unexpected', span: spanKey(item) });
      }
    }
    for (const item of remaining.values()) {
      record(item.type, 'fn');
      issues.push({ id, issue: 'missed', span: spanKey(item) });
    }
    for (const item of expected) {
      if (!actual.some((hit) => hit.start <= item.start && hit.end >= item.end)) incompleteCoverage++;
    }
  }
  const metrics = ({ tp, fp, fn }) => ({ tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) });
  const summarize = (counts) => Object.fromEntries(Object.entries(counts).map(([name, data]) => [name, metrics(data)]));
  return {
    overall: metrics(all), byGroup: summarize(byGroup), byType: summarize(byType),
    clean, cleanWithAlerts, cleanAlertRate: ratio(cleanWithAlerts, clean), incompleteCoverage, issues,
  };
}

const args = process.argv.slice(2);
const ref = args.find((arg) => arg !== '--json') || 'e5ef92a';
const { commit, detector } = loadBaseline(ref);
const report = { corpus: 'campus-posts-v1', samples: corpus.length, baselineCommit: commit,
  baseline: measure(detector), current: measure(current) };

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${report.corpus} · ${report.samples} 条合成发布文案 · 基线 ${commit.slice(0, 7)}`);
  const percent = (value) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
  for (const [label, result] of [['旧规则', report.baseline], ['当前规则', report.current]]) {
    console.log(`\n${label} · 精确率 ${percent(result.overall.precision)} · 召回率 ${percent(result.overall.recall)}`);
    console.table(result.byGroup);
    console.log(`正常文案触发提醒 ${result.cleanWithAlerts}/${result.clean} · 未完整覆盖 ${result.incompleteCoverage} 个标注区间`);
    console.log(result.issues.map(({ id, issue, span }) => `${id} ${issue} ${span}`).join('\n'));
  }
}
