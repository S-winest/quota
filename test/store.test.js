import { describe, it, expect } from 'vitest';
import {
  APP_ID,
  buildBackupFilename,
  exportPayload,
  newState,
  normalizeState,
  parseImportPayload,
} from '../src/store.js';

const tx = (over = {}) => ({
  id: 'tx-1',
  type: 'expense',
  amount: 35,
  category: '饮食',
  note: '午饭',
  date: '2026-10-24',
  ts: '2026-10-24T04:00:00.000Z',
  ...over,
});

function state(over = {}) {
  const base = newState();
  return {
    ...base,
    config: {
      ...base.config,
      setupDone: true,
      initialBalance: 60000,
      deadline: '2027-09-30',
      ...(over.config || {}),
    },
    txs: over.txs || [],
    monthState: over.monthState ?? null,
  };
}

describe('newState', () => {
  it('默认未设置，只有预设类目', () => {
    const s = newState();
    expect(s.config.setupDone).toBe(false);
    expect(s.config.categories).toEqual(['饮食', '娱乐', '出行']);
    expect(s.txs).toEqual([]);
    expect(s.monthState).toBeNull();
  });
});

describe('normalizeState', () => {
  it('损坏的记录被丢弃，好的保留', () => {
    const s = normalizeState(
      state({
        txs: [
          tx(),
          tx({ id: 'bad-type', type: 'unknown' }),
          tx({ id: 'bad-date', date: '2026/10/24' }),
          tx({ id: 'bad-amount', amount: -5 }),
          tx({ id: 'zero', amount: 0 }),
          tx({ id: 'ok2', amount: 12.5, category: null, note: undefined }),
        ],
      }),
    );
    expect(s.txs.map((t) => t.id)).toEqual(['tx-1', 'ok2']);
    expect(s.txs[1].category).toBeNull();
    expect(s.txs[1].note).toBe('');
  });

  it('类目去重、去空、无类目时回落到预设', () => {
    expect(normalizeState(state({ config: { categories: ['饮食', ' 饮食', '医疗', ''] } })).config.categories).toEqual(['饮食', '医疗']);
    expect(normalizeState(state({ config: { categories: [] } })).config.categories).toEqual(['饮食', '娱乐', '出行']);
  });

  it('固定支出只留正数并补齐名称', () => {
    const s = normalizeState(
      state({
        config: {
          fixedExpenses: [
            { name: '房租', amount: 2000 },
            { name: '  ', amount: 300 },
            { name: '零', amount: 0 },
          ],
        },
      }),
    );
    expect(s.config.fixedExpenses).toEqual([{ name: '房租', amount: 2000 }]);
  });

  it('有截止日期但缺 setupDone 的旧数据视为已设置', () => {
    const s = normalizeState({ config: { deadline: '2027-09-30', initialBalance: 100 } });
    expect(s.config.setupDone).toBe(true);
  });

  it('保留月额度快照，非法月份丢弃', () => {
    const s = normalizeState(
      state({
        monthState: { month: '2026-10', baseBalance: 60000, months: 12, quota: 5000, fixedTotal: 2000 },
      }),
    );
    expect(s.monthState.quota).toBe(5000);
    expect(normalizeState(state({ monthState: { month: 'x' } })).monthState).toBeNull();
  });

  it('不是对象时返回 null', () => {
    expect(normalizeState(null)).toBeNull();
    expect(normalizeState([])).toBeNull();
    expect(normalizeState({ foo: 1 })).toBeNull();
  });
});

describe('备份文件', () => {
  it('导出包带应用标识与导出时间', () => {
    const payload = exportPayload(state({ txs: [tx()] }));
    expect(payload.app).toBe(APP_ID);
    expect(payload.version).toBe(1);
    expect(payload.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.data.txs).toHaveLength(1);
  });

  it('文件名带日期（D22）', () => {
    expect(buildBackupFilename(new Date(2026, 9, 24))).toBe('额度备份-2026-10-24.json');
    expect(buildBackupFilename(new Date(2027, 0, 5))).toBe('额度备份-2027-01-05.json');
  });

  it('导入自己的备份能还原账目', () => {
    const original = state({ txs: [tx(), tx({ id: 'tx-2', type: 'income', amount: 8000, category: null })] });
    const result = parseImportPayload(JSON.stringify(exportPayload(original)));
    expect(result.ok).toBe(true);
    expect(result.state.txs).toHaveLength(2);
    expect(result.state.config.initialBalance).toBe(60000);
  });

  it('导入裸 state 也接受', () => {
    const result = parseImportPayload(JSON.stringify(state({ txs: [tx()] })));
    expect(result.ok).toBe(true);
  });

  it('拒绝非 JSON、别家文件、空备份', () => {
    expect(parseImportPayload('not json').ok).toBe(false);
    expect(parseImportPayload('[]').ok).toBe(false);
    expect(parseImportPayload(JSON.stringify({ app: 'other-app', data: { config: {} } })).ok).toBe(false);
    expect(parseImportPayload(JSON.stringify({ app: APP_ID, data: { config: { deadline: '' } } })).ok).toBe(false);
  });
});
