/**
 * store.js —— 本地存储（localStorage）与备份文件读写。
 *
 * 对应决策：
 *   D2  数据纯本地，无账号、无同步
 *   D14 手动导出 / 导入 JSON，不依赖任何云端
 *   D22 备份文件名带日期
 *
 * 只有这一层接触 localStorage，其余模块都是纯函数。
 */

import { PRESET_CATEGORIES, TX_TYPES, round2, remainingMonths } from './calc.js';

export const APP_ID = 'daily-quota-ledger';
export const STORAGE_VERSION = 1;
export const STORAGE_KEY = 'daily-quota-ledger.v1';

const nowIso = () => new Date().toISOString();
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isDateKey = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

export function newState() {
  return {
    version: STORAGE_VERSION,
    config: {
      createdAt: nowIso(),
      setupDone: false,
      initialBalance: 0,
      deadline: '',
      categories: [...PRESET_CATEGORIES],
      fixedExpenses: [],
      quotaEdit: null,
      lastBackupAt: null,
    },
    monthState: null,
    txs: [],
  };
}

function sanitizeFixedExpenses(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => isPlainObject(item) && typeof item.name === 'string' && item.name.trim())
    .map((item) => ({
      name: item.name.trim().slice(0, 12),
      amount: Math.max(0, round2(item.amount)),
    }))
    .filter((item) => item.amount > 0);
}

function sanitizeCategories(input) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().slice(0, 8);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.length ? out : [...PRESET_CATEGORIES];
}

function sanitizeTransactions(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (!isPlainObject(raw)) continue;
    if (!TX_TYPES.includes(raw.type)) continue;
    if (!isDateKey(raw.date)) continue;
    const amount = round2(raw.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    out.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `tx-${out.length}-${Date.now()}`,
      type: raw.type,
      amount,
      category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : null,
      note: typeof raw.note === 'string' ? raw.note.slice(0, 60) : '',
      date: raw.date,
      ts: typeof raw.ts === 'string' ? raw.ts : new Date().toISOString(),
    });
  }
  return out.sort((a, b) => (a.date === b.date ? a.ts.localeCompare(b.ts) : a.date.localeCompare(b.date)));
}

/**
 * 把任意来源的数据（本地存储、备份文件）整理成当前版本的 state。
 * 宽容：缺字段补默认值，坏记录丢弃，保证旧备份也能恢复。
 */
export function normalizeState(raw) {
  if (!isPlainObject(raw)) return null;
  const source = isPlainObject(raw.data) ? raw.data : raw;
  if (!isPlainObject(source.config)) return null;

  const config = source.config;
  const state = {
    version: STORAGE_VERSION,
    config: {
      createdAt: typeof config.createdAt === 'string' ? config.createdAt : nowIso(),
      setupDone: Boolean(config.setupDone) || Boolean(config.deadline),
      initialBalance: Math.max(0, round2(config.initialBalance)),
      deadline: isDateKey(config.deadline) ? config.deadline : '',
      categories: sanitizeCategories(config.categories),
      fixedExpenses: sanitizeFixedExpenses(config.fixedExpenses),
      quotaEdit:
        isPlainObject(config.quotaEdit) && typeof config.quotaEdit.month === 'string'
          ? { month: config.quotaEdit.month, at: String(config.quotaEdit.at || '') }
          : null,
      lastBackupAt: typeof config.lastBackupAt === 'string' ? config.lastBackupAt : null,
    },
    monthState: null,
    txs: sanitizeTransactions(source.txs),
  };

  const snapshot = source.monthState;
  if (
    isPlainObject(snapshot) &&
    typeof snapshot.month === 'string' &&
    /^\d{4}-\d{2}$/.test(snapshot.month)
  ) {
    const months = remainingMonths(snapshot.month, state.config.deadline);
    state.monthState = {
      month: snapshot.month,
      baseBalance: round2(snapshot.baseBalance),
      months: Number.isFinite(snapshot.months) ? snapshot.months : months,
      quota:
        snapshot.quota == null || !Number.isFinite(snapshot.quota) ? null : round2(snapshot.quota),
      fixedTotal: round2(snapshot.fixedTotal),
      frozenAt: typeof snapshot.frozenAt === 'string' ? snapshot.frozenAt : nowIso(),
    };
  }

  return state;
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 隐私模式下可能失败，忽略 */
  }
}

/* --------------------------------- 备份文件 -------------------------------- */

export function exportPayload(state) {
  return {
    app: APP_ID,
    version: STORAGE_VERSION,
    exportedAt: nowIso(),
    data: state,
  };
}

export function buildBackupFilename(today = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `额度备份-${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.json`;
}

/** 解析导入文本；返回 { ok, state } 或 { ok: false, error } */
export function parseImportPayload(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件不是有效的 JSON' };
  }
  if (!isPlainObject(raw)) return { ok: false, error: '文件内容不是本工具的备份' };
  if (raw.app && raw.app !== APP_ID) return { ok: false, error: '这不是本工具的备份文件' };
  const state = normalizeState(raw);
  if (!state) return { ok: false, error: '备份里没有可用的配置数据' };
  if (!state.config.setupDone && state.txs.length === 0) {
    return { ok: false, error: '备份是空的' };
  }
  return { ok: true, state };
}


