import { describe, it, expect } from 'vitest';
import {
  toDateKey,
  monthKeyOf,
  daysInMonth,
  daysLeftInMonth,
  remainingMonths,
  balanceOf,
  balanceAtMonthStart,
  monthSpent,
  monthIncome,
  spentByCategory,
  fixedTotalOf,
  createMonthState,
  ensureMonth,
  needsMonthRefresh,
  computeView,
  quotaEditAllowed,
  formatMoney,
  round2,
  daysSince,
} from '../src/calc.js';

const BASE_CONFIG = {
  createdAt: '2026-10-01T00:00:00.000Z',
  setupDone: true,
  initialBalance: 60000,
  deadline: '2027-09-30',
  categories: ['饮食', '娱乐', '出行'],
  fixedExpenses: [],
  quotaEdit: null,
  lastBackupAt: null,
};

function makeState({ config = {}, txs = [], monthState = null } = {}) {
  return {
    version: 1,
    config: { ...BASE_CONFIG, ...config },
    monthState,
    txs,
  };
}

let seq = 0;
function tx(type, amount, date, category = null, note = '') {
  seq += 1;
  return { id: `tx-${seq}`, type, amount, date, category, note, ts: `${date}T10:00:00.000Z` };
}

const at = (year, month, day) => new Date(year, month - 1, day);

describe('日期口径（本地时区）', () => {
  it('toDateKey 不走 UTC，月初月末都不偏移', () => {
    expect(toDateKey(at(2026, 10, 1))).toBe('2026-10-01');
    expect(toDateKey(at(2026, 10, 31))).toBe('2026-10-31');
    expect(toDateKey(at(2027, 1, 1))).toBe('2027-01-01');
  });

  it('monthKeyOf 同时接受 Date 和日期字符串', () => {
    expect(monthKeyOf(at(2026, 10, 24))).toBe('2026-10');
    expect(monthKeyOf('2026-10-24')).toBe('2026-10');
    expect(monthKeyOf('2026-10')).toBe('2026-10');
  });

  it('daysInMonth 处理闰年与大小月', () => {
    expect(daysInMonth('2026-10')).toBe(31);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-12')).toBe(31);
  });

  it('本月剩余天数含今天，且最少为 1', () => {
    expect(daysLeftInMonth('2026-10', 1)).toBe(31);
    expect(daysLeftInMonth('2026-10', 7)).toBe(25);
    expect(daysLeftInMonth('2026-10', 30)).toBe(2);
    expect(daysLeftInMonth('2026-10', 31)).toBe(1);
    expect(daysLeftInMonth('2026-10', 32)).toBe(1);
  });

  it('剩余月份数含当月，跨年正确', () => {
    expect(remainingMonths('2026-10', '2027-09-30')).toBe(12);
    expect(remainingMonths('2027-09', '2027-09-30')).toBe(1);
    expect(remainingMonths('2027-10', '2027-09-30')).toBe(0);
    expect(remainingMonths('2028-01', '2027-09-30')).toBe(-3);
    expect(remainingMonths('2026-10', '')).toBe(0);
  });

  it('daysSince 计算备份天数', () => {
    expect(daysSince('2026-10-17T00:00:00.000Z', new Date('2026-10-24T06:00:00.000Z'))).toBe(7);
    expect(daysSince(null)).toBeNull();
    expect(daysSince('not-a-date')).toBeNull();
  });
});

describe('余额与当月已消费（D5 / D17）', () => {
  it('余额 = 初始 + 收入 − 支出 + 退款', () => {
    const state = makeState({
      txs: [tx('expense', 1200, '2026-10-10'), tx('income', 8000, '2026-10-15'), tx('refund', 200, '2026-10-20')],
    });
    expect(balanceOf(state)).toBe(60000 - 1200 + 8000 + 200);
  });

  it('退款冲减当月已消费，收入不冲减', () => {
    const txs = [tx('expense', 1200, '2026-10-10'), tx('refund', 200, '2026-10-11'), tx('income', 8000, '2026-10-12')];
    expect(monthSpent(txs, '2026-10')).toBe(1000);
    expect(monthIncome(txs, '2026-10')).toBe(8000);
  });

  it('只统计当月记录（8 月支出不进 10 月）', () => {
    const txs = [tx('expense', 900, '2026-08-03'), tx('expense', 100, '2026-10-03')];
    expect(monthSpent(txs, '2026-10')).toBe(100);
    expect(monthSpent(txs, '2026-08')).toBe(900);
  });

  it('类目金额按退款冲减，并忽略收入', () => {
    const txs = [
      tx('expense', 520, '2026-10-02', '饮食'),
      tx('expense', 300, '2026-10-03', '娱乐'),
      tx('refund', 120, '2026-10-04', '饮食'),
      tx('income', 8000, '2026-10-05'),
    ];
    expect(spentByCategory(txs, '2026-10')).toEqual({ 饮食: 400, 娱乐: 300 });
  });

  it('月内收入只改余额，不改已消费', () => {
    const txs = [tx('expense', 1000, '2026-10-10'), tx('income', 8000, '2026-10-11')];
    expect(monthSpent(txs, '2026-10')).toBe(1000);
    expect(balanceOf(makeState({ txs }))).toBe(67000);
  });

  it('0.1 + 0.2 不产生浮点尾巴', () => {
    const txs = [tx('expense', 0.1, '2026-10-01'), tx('expense', 0.2, '2026-10-02')];
    expect(monthSpent(txs, '2026-10')).toBe(0.3);
    expect(balanceOf(makeState({ txs }))).toBe(59999.7);
  });

  it('固定支出合计', () => {
    expect(fixedTotalOf([{ name: '房租', amount: 3000 }, { name: '订阅', amount: 99.5 }])).toBe(3099.5);
    expect(fixedTotalOf([])).toBe(0);
  });
});

describe('月额度快照（D4 / D7 / D21）', () => {
  it('需求 §2.4 示例：60000 / 截止 2027-09-30 → 10 月额度 5000', () => {
    const state = ensureMonth(makeState(), at(2026, 10, 1));
    expect(state.monthState.quota).toBe(5000);
    expect(state.monthState.months).toBe(12);
    expect(state.monthState.baseBalance).toBe(60000);
  });

  it('月额度分母用“进入当月时的余额”，不含当月支出', () => {
    const state = makeState({ txs: [tx('expense', 1000, '2026-10-01')] });
    const snapshot = createMonthState(state, at(2026, 11, 1));
    // 11 月到 2027-09 共 11 个月；11/1 的余额 = 60000 − 1000
    expect(snapshot.months).toBe(11);
    expect(snapshot.quota).toBe(round2(59000 / 11));
    expect(balanceAtMonthStart(state, '2026-11')).toBe(59000);
  });

  it('快照在月内冻结：收入/补记都不改当月额度', () => {
    const base = ensureMonth(makeState(), at(2026, 10, 1));
    const state = {
      ...base,
      txs: [tx('income', 8000, '2026-10-05'), tx('expense', 1200, '2026-10-06'), tx('expense', 300, '2026-09-20')],
    };
    expect(needsMonthRefresh(state, at(2026, 10, 20))).toBe(false);
    expect(computeView(state, at(2026, 10, 20)).monthQuota).toBe(5000);
    expect(balanceOf(state)).toBe(66500);
  });

  it('跨月才重建快照', () => {
    const october = ensureMonth(makeState(), at(2026, 10, 1));
    const novemberState = ensureMonth({ ...october, txs: [tx('expense', 4000, '2026-10-31')] }, at(2026, 11, 1));
    expect(novemberState.monthState.month).toBe('2026-11');
    expect(novemberState.monthState.quota).toBe(round2(56000 / 11));
  });

  it('需求 §2.4 自稳性：按额度花，下月额度不变', () => {
    const october = ensureMonth(makeState(), at(2026, 10, 1));
    const spent = { ...october, txs: [tx('expense', 5000, '2026-10-15')] };
    const november = ensureMonth(spent, at(2026, 11, 1));
    expect(november.monthState.quota).toBe(5000);
  });

  it('同一月重复 ensureMonth 不重算（返回同一个对象）', () => {
    const once = ensureMonth(makeState(), at(2026, 10, 24));
    const twice = ensureMonth(once, at(2026, 10, 31));
    expect(twice).toBe(once);
  });

  it('截止日期已过：额度为 null，并提示重设', () => {
    const state = ensureMonth(makeState({ config: { deadline: '2026-09-30' } }), at(2026, 10, 24));
    expect(state.monthState.quota).toBeNull();
    const view = computeView(state, at(2026, 10, 24));
    expect(view.deadlinePassed).toBe(true);
    expect(view.dailyQuota).toBeNull();
  });

  it('截止日期修好后同月内能补上额度', () => {
    const broken = ensureMonth(makeState({ config: { deadline: '2026-09-30' } }), at(2026, 10, 24));
    const fixed = { ...broken, config: { ...broken.config, deadline: '2027-09-30' } };
    expect(needsMonthRefresh(fixed, at(2026, 10, 24))).toBe(true);
    const view = computeView(ensureMonth(fixed, at(2026, 10, 24)), at(2026, 10, 24));
    expect(view.monthQuota).toBe(round2(60000 / 12));
    expect(view.deadlinePassed).toBe(false);
  });
});

describe('日额度（D4 / §2.3 / §8）', () => {
  it('10/1 无支出：5000 ÷ 31', () => {
    const state = ensureMonth(makeState(), at(2026, 10, 1));
    const view = computeView(state, at(2026, 10, 1));
    expect(view.daysLeft).toBe(31);
    expect(view.dailyQuota).toBe(round2(5000 / 31));
  });

  it('需求 §2.4 示例：10/10 已花 1200 → (5000−1200) ÷ 22', () => {
    const state = ensureMonth(makeState({ txs: [tx('expense', 1200, '2026-10-10')] }), at(2026, 10, 1));
    const view = computeView(state, at(2026, 10, 10));
    expect(view.daysLeft).toBe(22);
    expect(view.spent).toBe(1200);
    expect(view.remainingDaily).toBe(3800);
    expect(view.dailyQuota).toBe(round2(3800 / 22));
  });

  it('固定支出先从月额度扣掉', () => {
    const state = ensureMonth(
      makeState({ config: { fixedExpenses: [{ name: '房租', amount: 2000 }] } }),
      at(2026, 10, 1),
    );
    const view = computeView(state, at(2026, 10, 1));
    expect(view.fixedTotal).toBe(2000);
    expect(view.dailyBudget).toBe(3000);
    expect(view.dailyQuota).toBe(round2(3000 / 31));
  });

  it('月末最后一天分母为 1', () => {
    const state = ensureMonth(makeState(), at(2026, 10, 1));
    const view = computeView(state, at(2026, 10, 31));
    expect(view.daysLeft).toBe(1);
    expect(view.dailyQuota).toBe(5000);
  });

  it('日额度为负 → 标记超支，金额为正数展示', () => {
    const state = ensureMonth(makeState({ txs: [tx('expense', 5200, '2026-10-05')] }), at(2026, 10, 1));
    const view = computeView(state, at(2026, 10, 10));
    expect(view.overdraft).toBe(true);
    expect(view.overdraftAmount).toBe(200);
    expect(view.dailyQuota).toBeLessThan(0);
  });

  it('退款让日额度回升', () => {
    const state = ensureMonth(
      makeState({ txs: [tx('expense', 1200, '2026-10-05'), tx('refund', 200, '2026-10-06')] }),
      at(2026, 10, 1),
    );
    const view = computeView(state, at(2026, 10, 10));
    expect(view.spent).toBe(1000);
    expect(view.remainingDaily).toBe(4000);
    expect(view.dailyQuota).toBe(round2(4000 / 22));
  });

  it('今日已花只算今天的记录', () => {
    const txs = [
      tx('expense', 100, '2026-10-09'),
      tx('expense', 30, '2026-10-10', '饮食'),
      tx('refund', 10, '2026-10-10', '饮食'),
    ];
    const state = ensureMonth(makeState({ txs }), at(2026, 10, 1));
    expect(computeView(state, at(2026, 10, 10)).todaySpent).toBe(20);
  });
});

describe('类目展示（D3 / D18）', () => {
  it('预设顺序不变，缺失记为 0', () => {
    const state = ensureMonth(makeState({ txs: [tx('expense', 520, '2026-10-02', '饮食')] }), at(2026, 10, 1));
    expect(computeView(state, at(2026, 10, 2)).categories).toEqual([
      { name: '饮食', amount: 520 },
      { name: '娱乐', amount: 0 },
      { name: '出行', amount: 0 },
    ]);
  });

  it('已移除但仍有钱的类目也会显示，避免金额对不上', () => {
    const state = ensureMonth(
      makeState({
        config: { categories: ['饮食', '娱乐'] },
        txs: [tx('expense', 300, '2026-10-02', '出行')],
      }),
      at(2026, 10, 1),
    );
    expect(computeView(state, at(2026, 10, 2)).categories).toContainEqual({ name: '出行', amount: 300 });
  });
});

describe('额度修改频率（D11）', () => {
  it('首次修改不计次', () => {
    expect(quotaEditAllowed({ quotaEdit: null }, at(2026, 10, 24))).toEqual({
      allowed: true,
      first: true,
      usedThisMonth: false,
    });
  });

  it('同一自然月内第二次修改被拒绝', () => {
    expect(quotaEditAllowed({ quotaEdit: { month: '2026-10' } }, at(2026, 10, 31))).toMatchObject({
      allowed: false,
      usedThisMonth: true,
    });
  });

  it('下个自然月恢复', () => {
    expect(quotaEditAllowed({ quotaEdit: { month: '2026-10' } }, at(2026, 11, 1)).allowed).toBe(true);
  });
});

describe('显示格式', () => {
  it('有角分才补两位，整数不补零', () => {
    expect(formatMoney(1200)).toBe('1,200');
    expect(formatMoney(1200.5)).toBe('1,200.50');
    expect(formatMoney(0)).toBe('0');
    expect(formatMoney(-58.25)).toBe('58.25');
  });

  it('round2 四舍五入到分', () => {
    expect(round2(5818.181818)).toBe(5818.18);
    expect(round2(0.005)).toBe(0.01);
  });
});
