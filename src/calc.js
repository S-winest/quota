/**
 * calc.js —— 额度模型的全部计算。
 *
 * 对应决策：
 *   D4  两层摊销：月额度 = 余额 ÷ 剩余月份数；日额度 = 本月日常可花剩余 ÷ 本月剩余天数
 *   D5  总额是余额（收入加、支出减）
 *   D7  当月收入只改余额，不改当月额度（额度在月内是常数）
 *   D8  固定支出单独成池，月初先从月额度里扣
 *   D17 退款/报销作为负支出冲减当月已消费
 *   D21 跨月重算由调用方（store）在打开时惰性触发
 *
 * 全部为纯函数：不读写 localStorage、不碰 DOM。
 * 金额内部按“分”聚合，避免 0.1 + 0.2 这类浮点误差；对外返回元。
 */

export const PRESET_CATEGORIES = Object.freeze(['饮食', '娱乐', '出行']);
export const TX_TYPES = Object.freeze(['expense', 'income', 'refund']);

const pad2 = (n) => String(n).padStart(2, '0');
const DAY_MS = 24 * 60 * 60 * 1000;

/* ---------------------------------- 日期 ---------------------------------- */

/** 本地时区的 YYYY-MM-DD（不要用 toISOString，会跨时区偏移） */
export function toDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 接受 Date 或 'YYYY-MM-DD'，返回 'YYYY-MM' */
export function monthKeyOf(value) {
  if (typeof value === 'string') return value.slice(0, 7);
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}`;
}

export function monthStartKey(monthKey) {
  return `${monthKey}-01`;
}

export function daysInMonth(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 本月剩余天数（含今天），最少 1（需求 §8：剩余天数为 0 时按 1 计算） */
export function daysLeftInMonth(monthKey, day) {
  return Math.max(1, daysInMonth(monthKey) - day + 1);
}

/** 当月到截止日期（含当月）的月份数；截止月早于当月时返回 0 或负数 */
export function remainingMonths(monthKey, deadlineKey) {
  if (!deadlineKey) return 0;
  const [year, month] = monthKey.split('-').map(Number);
  const [deadlineYear, deadlineMonth] = deadlineKey.split('-').map(Number);
  return (deadlineYear - year) * 12 + (deadlineMonth - month) + 1;
}

/** 距某个 ISO 时间过去了多少天；无效值返回 null */
export function daysSince(iso, now = new Date()) {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now.getTime() - time) / DAY_MS));
}

/* ---------------------------------- 金额 ---------------------------------- */

export const toCents = (value) => Math.round(Number(value || 0) * 100);
export const fromCents = (cents) => cents / 100;
export const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

/** 这笔记录对余额的影响（分）：支出为负，收入/退款为正 */
export function balanceDeltaCents(tx) {
  const cents = toCents(tx.amount);
  return tx.type === 'expense' ? -cents : cents;
}

/** 这笔记录对“本月已消费”的影响（分）：支出为正，退款为负，收入为 0 */
export function spendDeltaCents(tx) {
  if (tx.type === 'expense') return toCents(tx.amount);
  if (tx.type === 'refund') return -toCents(tx.amount);
  return 0;
}

/** 显示用金额：千分位，有角分才显示两位小数 */
export function formatMoney(value) {
  const amount = round2(Math.abs(Number(value) || 0));
  const hasCents = Math.round(amount * 100) % 100 !== 0;
  return amount.toLocaleString('zh-CN', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

export function fixedTotalOf(fixedExpenses = []) {
  return fromCents(fixedExpenses.reduce((sum, item) => sum + toCents(item.amount), 0));
}

/* --------------------------------- 聚合查询 -------------------------------- */

/** 当前余额 = 初始余额 + 收入 − 支出 + 退款 */
export function balanceOf(state) {
  const base = toCents(state.config.initialBalance);
  return fromCents(state.txs.reduce((sum, tx) => sum + balanceDeltaCents(tx), base));
}

/** 某月 1 号那天的余额：只统计发生在该月之前的记录（用于月额度快照） */
export function balanceAtMonthStart(state, monthKey) {
  const start = monthStartKey(monthKey);
  const base = toCents(state.config.initialBalance);
  return fromCents(
    state.txs.filter((tx) => tx.date < start).reduce((sum, tx) => sum + balanceDeltaCents(tx), base),
  );
}

/** 某月已消费（支出 − 退款） */
export function monthSpent(txs, monthKey) {
  return fromCents(
    txs
      .filter((tx) => monthKeyOf(tx.date) === monthKey)
      .reduce((sum, tx) => sum + spendDeltaCents(tx), 0),
  );
}

export function monthIncome(txs, monthKey) {
  return fromCents(
    txs
      .filter((tx) => tx.type === 'income' && monthKeyOf(tx.date) === monthKey)
      .reduce((sum, tx) => sum + toCents(tx.amount), 0),
  );
}

export function monthRefund(txs, monthKey) {
  return fromCents(
    txs
      .filter((tx) => tx.type === 'refund' && monthKeyOf(tx.date) === monthKey)
      .reduce((sum, tx) => sum + toCents(tx.amount), 0),
  );
}

/** 某月各类目已花金额：{ 饮食: 520, ... }（退款冲减类目） */
export function spentByCategory(txs, monthKey) {
  const result = {};
  for (const tx of txs) {
    if (monthKeyOf(tx.date) !== monthKey) continue;
    if (tx.type === 'income' || !tx.category) continue;
    result[tx.category] = fromCents(toCents(result[tx.category]) + spendDeltaCents(tx));
  }
  return result;
}

/* -------------------------------- 月额度快照 ------------------------------- */

/**
 * 生成当月的额度快照。只在“跨月”或“截止日期刚被修好”时创建，
 * 之后整月冻结，保证月内额度是常数（D7）。
 */
export function createMonthState(state, today = new Date()) {
  const monthKey = monthKeyOf(today);
  const months = remainingMonths(monthKey, state.config.deadline);
  const baseBalance = balanceAtMonthStart(state, monthKey);
  return {
    month: monthKey,
    baseBalance,
    months,
    quota: months > 0 ? round2(baseBalance / months) : null,
    fixedTotal: fixedTotalOf(state.config.fixedExpenses),
    frozenAt: new Date().toISOString(),
  };
}

export function needsMonthRefresh(state, today = new Date()) {
  const monthKey = monthKeyOf(today);
  const snapshot = state.monthState;
  if (!snapshot || snapshot.month !== monthKey) return true;
  // 当月额度曾因“截止日期已过”无法计算，用户修好截止日期后要能立刻补上
  if (snapshot.quota == null && remainingMonths(monthKey, state.config.deadline) > 0) return true;
  return false;
}

/** 惰性跨月重算：需要时返回新 state，否则原样返回（D21） */
export function ensureMonth(state, today = new Date()) {
  return needsMonthRefresh(state, today)
    ? { ...state, monthState: createMonthState(state, today) }
    : state;
}

/* --------------------------------- 视图模型 -------------------------------- */

/**
 * 首页需要的全部数字。纯函数，today 可注入，方便测试。
 */
export function computeView(state, today = new Date()) {
  const todayKey = toDateKey(today);
  const monthKey = monthKeyOf(todayKey);
  const day = Number(todayKey.slice(8, 10));
  const snapshot =
    state.monthState && state.monthState.month === monthKey ? state.monthState : null;

  const months = remainingMonths(monthKey, state.config.deadline);
  const deadlinePassed =
    !state.config.deadline || state.config.deadline < todayKey || months <= 0;

  const monthQuota = snapshot ? snapshot.quota : null;
  const fixedTotal = snapshot ? snapshot.fixedTotal : fixedTotalOf(state.config.fixedExpenses);
  const spent = monthSpent(state.txs, monthKey);
  const dailyBudget = monthQuota == null ? null : round2(monthQuota - fixedTotal);
  const remainingDaily = dailyBudget == null ? null : round2(dailyBudget - spent);
  const daysLeft = daysLeftInMonth(monthKey, day);
  const dailyQuota = remainingDaily == null ? null : round2(remainingDaily / daysLeft);
  const overdraft = dailyQuota != null && dailyQuota < 0;

  const byCategory = spentByCategory(state.txs, monthKey);
  const configured = state.config.categories || [];
  // 已从配置里删掉、但本月仍有记录的类目，也要显示，否则类目合计对不上
  const extraNames = Object.keys(byCategory).filter(
    (name) => !configured.includes(name) && byCategory[name] !== 0,
  );

  return {
    todayKey,
    monthKey,
    day,
    daysInMonth: daysInMonth(monthKey),
    daysLeft,
    months: snapshot && snapshot.months != null ? snapshot.months : months,
    deadlinePassed,
    monthQuota,
    fixedTotal,
    dailyBudget,
    spent,
    remainingDaily,
    dailyQuota,
    overdraft,
    overdraftAmount: overdraft ? round2(-remainingDaily) : 0,
    balance: balanceOf(state),
    income: monthIncome(state.txs, monthKey),
    refund: monthRefund(state.txs, monthKey),
    todaySpent: monthSpent(
      state.txs.filter((tx) => tx.date === todayKey),
      monthKey,
    ),
    categories: [
      ...configured.map((name) => ({ name, amount: byCategory[name] || 0 })),
      ...extraNames.map((name) => ({ name, amount: byCategory[name] || 0 })),
    ],
    txCount: state.txs.filter((tx) => monthKeyOf(tx.date) === monthKey).length,
    totalTxCount: state.txs.length,
  };
}

/* ------------------------------ 额度修改频率 ------------------------------ */

/**
 * D11：总额与类目共用“一个自然月一次”的修改额度；首次修改不计。
 * 返回是否允许，以及本月是否已经用过。
 */
export function quotaEditAllowed(config, today = new Date()) {
  const record = config.quotaEdit;
  if (!record) return { allowed: true, first: true, usedThisMonth: false };
  const monthKey = monthKeyOf(today);
  return { allowed: record.month !== monthKey, first: false, usedThisMonth: record.month === monthKey };
}
