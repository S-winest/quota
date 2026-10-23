/**
 * main.js —— 界面与交互。
 *
 * 对应决策：
 *   D20 单 render()、计算全部走 calc.js、类目是数组常量
 *   D12 首页主数字按天，同时给已消费/月额度、剩余额度、余额
 *   D13 记一笔两步：金额 → 类目
 *   D14 导出 / 导入 JSON，7 天未备份提醒
 *   D16 记录按消费发生日（可补记）
 *   D21 打开时惰性检测跨月，不用定时器
 */

import './style.css';
import {
  formatMoney,
  round2,
  toDateKey,
  monthKeyOf,
  ensureMonth,
  computeView,
  quotaEditAllowed,
  daysSince,
  balanceOf,
} from './calc.js';
import {
  newState,
  loadState,
  saveState,
  clearState,
  exportPayload,
  parseImportPayload,
  buildBackupFilename,
} from './store.js';

const app = document.getElementById('app');
const toastLayer = document.getElementById('toast-layer');
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

let state = loadState() || newState();
if (state.config.setupDone) {
  const next = ensureMonth(state, new Date());
  if (next !== state) {
    state = next;
    saveState(state);
  }
}

let lastDayKey = toDateKey(new Date());

const ui = {
  sheet: null, // 'entry' | 'list' | 'settings'
  entry: null,
  settings: null,
  setup: null,
  confirmTxId: null,
  confirmClear: false,
};

function setupDraft() {
  return {
    balance: '',
    deadline: `${new Date().getFullYear()}-12-31`,
    fixed: [],
    fixedName: '',
    fixedAmount: '',
    error: '',
  };
}

if (!state.config.setupDone) ui.setup = setupDraft();

/* --------------------------------- 小工具 --------------------------------- */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function dateLabel(key) {
  const [year, month, day] = key.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(year, month - 1, day).getDay()];
  return `${month}月${day}日 ${weekday}`;
}

function fullDateLabel(key) {
  if (!key) return '未设置';
  const [year, month, day] = key.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

function txCompare(a, b) {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  return String(a.ts).localeCompare(String(b.ts));
}

function persist() {
  if (!saveState(state)) toast('保存失败：浏览器存储不可用或已满');
}

/** 带符号的金额（剩余额度可能为负） */
function signedMoney(value) {
  const amount = Number(value) || 0;
  return `${amount < 0 ? '−' : ''}¥${formatMoney(amount)}`;
}

let toastTimer = null;
function toast(message) {
  toastLayer.innerHTML = `<div class="toast">${esc(message)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastLayer.innerHTML = '';
  }, 2200);
}

/* --------------------------------- 渲染 ---------------------------------- */

function render() {
  // 自愈：任何一次渲染前先确认当月快照存在（跨月、时钟回拨、导入旧备份都能兜住）
  if (state.config.setupDone) {
    const next = ensureMonth(state, new Date());
    if (next !== state) {
      state = next;
      saveState(state);
    }
  }

  const previousSheet = document.querySelector('.sheet');
  const scrollTop = previousSheet ? previousSheet.scrollTop : 0;
  const view = state.config.setupDone ? computeView(state, new Date()) : null;

  app.innerHTML = `
    ${state.config.setupDone ? homeHtml(view) : setupHtml()}
    ${ui.sheet ? sheetHtml(view) : ''}
  `;

  document.body.classList.toggle('is-locked', Boolean(ui.sheet));
  const sheet = document.querySelector('.sheet');
  if (sheet) sheet.scrollTop = scrollTop;
}

function homeHtml(view) {
  const now = new Date();
  const backupDays = daysSince(state.config.lastBackupAt || state.config.createdAt, now);
  const showBackup = view.totalTxCount > 0 && backupDays != null && backupDays >= 7;

  return `
    <div class="app">
      <header class="topbar">
        <div class="topbar-date">${dateLabel(view.todayKey)}</div>
        <button class="icon-btn" data-act="settings" aria-label="设置">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
            <circle cx="15" cy="7" r="2.2" />
            <circle cx="9" cy="17" r="2.2" />
          </svg>
        </button>
      </header>

      ${showBackup ? bannerHtml(backupDays) : ''}
      ${heroHtml(view)}
      ${statsHtml(view)}
      ${metaHtml(view)}
      ${categoriesHtml(view)}

      <p class="footnote">额度每月 1 号重算 · 数据只存本机</p>
    </div>

    <footer class="actionbar">
      <button class="btn-primary" data-act="record">记一笔</button>
      <button class="btn-ghost" data-act="list">明细</button>
    </footer>
  `;
}

function bannerHtml(days) {
  return `
    <div class="banner">
      <div class="banner-text">已 ${days} 天没备份。数据只存在这台设备上，清浏览器数据会全部丢失。</div>
      <button class="btn-text" data-act="export">导出备份</button>
    </div>`;
}

function heroHtml(view) {
  if (view.deadlinePassed) {
    return `
      <section class="card hero">
        <div class="hero-label">今日还能花</div>
        <div class="hero-num is-muted">暂停计算</div>
        <div class="hero-sub">截止日期已过，重设后立刻恢复</div>
        <button class="btn-inline" data-act="settings">重设截止日期</button>
      </section>`;
  }
  if (view.overdraft) {
    return `
      <section class="card hero">
        <div class="hero-label">本月已超支</div>
        <div class="hero-num is-over"><span class="hero-cur">¥</span>${formatMoney(view.overdraftAmount)}</div>
        <div class="hero-sub">本月日常可花 ${signedMoney(view.dailyBudget)} 已用完 · 还有 ${view.daysLeft} 天</div>
      </section>`;
  }
  return `
    <section class="card hero">
      <div class="hero-label">今日还能花</div>
      <div class="hero-num"><span class="hero-cur">¥</span>${formatMoney(Math.round(view.dailyQuota))}</div>
      <div class="hero-sub">日常可花剩 ${signedMoney(view.remainingDaily)} · 含今天还有 ${view.daysLeft} 天</div>
    </section>`;
}

function statsHtml(view) {
  const spent = signedMoney(view.spent);
  const quota = view.monthQuota == null ? '—' : signedMoney(view.monthQuota);
  const remainNegative = view.remainingDaily != null && view.remainingDaily < 0;
  const remain = view.remainingDaily == null ? '—' : signedMoney(view.remainingDaily);
  return `
    <section class="stats">
      <div class="stat"><div class="stat-label">本月已消费</div><div class="stat-value">${spent}</div></div>
      <div class="stat"><div class="stat-label">月额度</div><div class="stat-value">${quota}</div></div>
      <div class="stat"><div class="stat-label">本月剩余</div><div class="stat-value ${remainNegative ? 'is-over' : ''}">${remain}</div></div>
    </section>`;
}

function metaHtml(view) {
  const rows = [];
  if (view.fixedTotal > 0) {
    rows.push(rowHtml(view.deadlinePassed ? '固定支出' : '固定支出（已扣）', `¥${formatMoney(view.fixedTotal)}`));
  }
  rows.push(rowHtml('余额', signedMoney(view.balance)));
  rows.push(
    rowHtml(
      '截止日期',
      view.deadlinePassed
        ? `${fullDateLabel(state.config.deadline)} · 已过期`
        : `${fullDateLabel(state.config.deadline)} · 按 ${view.months} 个月摊`,
    ),
  );
  if (view.income > 0) rows.push(rowHtml('本月收入', `¥${formatMoney(view.income)} · 下月生效`));
  if (view.refund > 0) rows.push(rowHtml('本月退款', `¥${formatMoney(view.refund)}`));
  rows.push(rowHtml('今日已花', signedMoney(view.todaySpent)));

  return `<section class="card meta">${rows.join('')}</section>`;
}

function rowHtml(label, value) {
  return `<div class="meta-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
}

function categoriesHtml(view) {
  const chips = view.categories
    .map(
      (item) => `
      <span class="chip">
        <span class="chip-name">${esc(item.name)}</span>
        <span class="chip-amount">${signedMoney(item.amount)}</span>
      </span>`,
    )
    .join('');

  return `
    <section class="card cats">
      <div class="card-title">重点类目</div>
      <div class="chips">${chips || '<span class="hint">还没有类目，去设置里添加</span>'}</div>
    </section>`;
}

/* --------------------------------- 首次设置 -------------------------------- */

function setupHtml() {
  const draft = ui.setup || setupDraft();
  return `
    <div class="app setup">
      <header class="setup-head">
        <h1>先定三件事</h1>
        <p class="lead">这个工具只回答一个问题：<b>今天还能花多少</b>。它不是账本，记账只是喂给它的输入。</p>
      </header>

      <section class="card">
        <label class="field">
          <span class="field-label">当前余额</span>
          <input class="input" type="number" inputmode="decimal" min="0" step="0.01"
                 data-field="setup-balance" value="${esc(draft.balance)}" placeholder="例如 60000" />
          <span class="field-hint">之后收入加、支出减，这个数会自己走</span>
        </label>
        <label class="field">
          <span class="field-label">截止日期</span>
          <input class="input" type="date" data-field="setup-deadline" value="${esc(draft.deadline)}" />
          <span class="field-hint">额度按「到这天还剩几个月」来摊</span>
        </label>
      </section>

      <section class="card">
        <div class="card-title">每月固定支出（可空）</div>
        <p class="hint">房租、订阅、还款。每月先从月额度里扣掉，不算进日常消费。</p>
        ${fixedRowsHtml('setup', draft.fixed)}
        <div class="inline-form">
          <input class="input" data-field="setup-fixed-new-name" value="${esc(draft.fixedName)}" placeholder="名称" aria-label="固定支出名称" />
          <input class="input input-num" type="number" inputmode="decimal" min="0" step="0.01"
                 data-field="setup-fixed-new-amount" value="${esc(draft.fixedAmount)}" placeholder="金额" aria-label="固定支出金额" />
          <button class="btn-ghost small" data-act="add-fixed" data-scope="setup">添加</button>
        </div>
      </section>

      ${draft.error ? `<p class="error">${esc(draft.error)}</p>` : ''}

      <button class="btn-primary block" data-act="setup-submit">开始</button>
      <p class="footnote">数据只保存在这台设备的浏览器里，不会上传。请定期导出备份。</p>
    </div>`;
}

function fixedRowsHtml(scope, list) {
  if (!list.length) return '';
  return `<div class="fixed-list">${list
    .map(
      (item, index) => `
      <div class="fixed-row">
        <input class="input" data-field="${scope}-fixed-name" data-idx="${index}"
               value="${esc(item.name)}" placeholder="名称" aria-label="固定支出名称" />
        <input class="input input-num" type="number" inputmode="decimal" min="0" step="0.01"
               data-field="${scope}-fixed-amount" data-idx="${index}"
               value="${esc(item.amount)}" placeholder="金额" aria-label="固定支出金额" />
        <button class="icon-btn danger" data-act="remove-fixed" data-scope="${scope}" data-idx="${index}" aria-label="删除这一项">×</button>
      </div>`,
    )
    .join('')}</div>`;
}

/* --------------------------------- 弹层外壳 -------------------------------- */

function sheetHtml(view) {
  if (ui.sheet === 'entry') return entrySheetHtml();
  if (ui.sheet === 'list') return listSheetHtml(view);
  if (ui.sheet === 'settings') return settingsSheetHtml(view);
  return '';
}

function sheetShell(title, body, extraHead = '') {
  return `
    <div class="backdrop" data-act="close-sheet"></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grab"></div>
      <header class="sheet-head">
        <h2 class="sheet-title">${esc(title)}</h2>
        ${extraHead}
        <button class="btn-text" data-act="close-sheet">关闭</button>
      </header>
      <div class="sheet-body">${body}</div>
    </section>`;
}

/* ---------------------------------- 记一笔 --------------------------------- */

function entrySheetHtml() {
  const entry = ui.entry;
  const seg = ['expense', 'income', 'refund']
    .map((type) => {
      const label = type === 'expense' ? '支出' : type === 'income' ? '收入' : '退款';
      return `<button class="seg-btn ${entry.type === type ? 'is-on' : ''}" data-act="entry-type" data-type="${type}">${label}</button>`;
    })
    .join('');

  return `
    <div class="backdrop" data-act="close-sheet"></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-label="记一笔">
      <div class="sheet-grab"></div>
      <header class="sheet-head">
        <div class="seg" role="group" aria-label="记录类型">${seg}</div>
        <button class="btn-text" data-act="close-sheet">取消</button>
      </header>
      <div class="sheet-body">${entry.step === 1 ? entryStep1Html() : entryStep2Html()}</div>
    </section>`;
}

function entryStep1Html() {
  const entry = ui.entry;
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'];
  const keypad = keys
    .map((key) =>
      key === 'del'
        ? `<button class="key" data-act="key" data-key="del" aria-label="删除一位">⌫</button>`
        : `<button class="key" data-act="key" data-key="${key}">${key}</button>`,
    )
    .join('');
  const canGo = Number(entry.amountStr) > 0;
  const hint =
    entry.type === 'refund'
      ? '退款会冲减本月已消费'
      : entry.type === 'income'
        ? '收入只加余额，下月 1 号才影响额度'
        : '';

  return `
    <div class="display" aria-live="polite">
      <span class="display-cur">¥</span><span id="entry-amount">${esc(entry.amountStr || '0')}</span>
    </div>
    <div class="keypad">${keypad}</div>
    <button class="btn-primary block" data-act="entry-next" ${canGo ? '' : 'disabled'}>
      ${entry.type === 'income' ? '记下' : '下一步'}
    </button>
    ${hint ? `<p class="hint center">${hint}</p>` : ''}`;
}

function entryStep2Html() {
  const entry = ui.entry;
  const todayKey = toDateKey(new Date());
  const canSave = entry.type === 'income' || Boolean(entry.category);
  const categories = state.config.categories
    .map(
      (name) => `
      <button class="cat-btn ${entry.category === name ? 'is-on' : ''}" data-act="pick-cat" data-cat="${esc(name)}">${esc(name)}</button>`,
    )
    .join('');

  return `
    <div class="display small">
      <span class="display-cur">¥</span>${formatMoney(Number(entry.amountStr || 0))}
    </div>
    ${entry.type === 'income' ? '' : `<div class="cat-grid">${categories}</div>`}
    <label class="field">
      <span class="field-label">日期</span>
      <input class="input" type="date" data-field="entry-date" value="${esc(entry.date)}" max="${todayKey}" />
      <span class="field-hint">补记就把日期改成那一天</span>
    </label>
    <label class="field">
      <span class="field-label">备注（可空）</span>
      <input class="input" type="text" data-field="entry-note" value="${esc(entry.note)}" maxlength="30" placeholder="例如：午饭" />
    </label>
    <div class="sheet-actions">
      <button class="btn-ghost" data-act="entry-back">上一步</button>
      <button class="btn-primary" data-act="entry-save" ${canSave ? '' : 'disabled'}>记下</button>
    </div>
    ${canSave ? '' : '<p class="hint center">先选一个类目</p>'}`;
}

/* ---------------------------------- 明细 ---------------------------------- */

function listSheetHtml(view) {
  const monthTxs = state.txs
    .filter((tx) => monthKeyOf(tx.date) === view.monthKey)
    .sort((a, b) => txCompare(b, a));

  const groups = [];
  for (const tx of monthTxs) {
    const last = groups[groups.length - 1];
    if (!last || last.date !== tx.date) groups.push({ date: tx.date, list: [tx] });
    else last.list.push(tx);
  }

  const body = monthTxs.length
    ? groups
        .map(
          (group) => `
        <div class="tx-group">
          <div class="tx-group-date">${dateLabel(group.date)}</div>
          ${group.list.map(txRowHtml).join('')}
        </div>`,
        )
        .join('')
    : '<p class="empty">本月还没有记录。漏记会让额度虚高，记得补。</p>';

  return sheetShell(
    '本月明细',
    `
    <div class="summary">
      <span>支出 <b>${signedMoney(view.spent)}</b></span>
      <span>收入 <b>¥${formatMoney(view.income)}</b></span>
      <span>退款 <b>¥${formatMoney(view.refund)}</b></span>
    </div>
    ${body}
    <p class="hint">只显示本月。删除后额度会立刻重算（月额度本身到 1 号才变）。</p>`,
  );
}

function txRowHtml(tx) {
  const armed = ui.confirmTxId === tx.id;
  const sign = tx.type === 'expense' ? '−' : '+';
  const title = tx.type === 'income' ? '收入' : tx.category || '未分类';
  const sub = [tx.type === 'refund' ? '退款' : '', tx.note].filter(Boolean).join(' · ') || '　';
  const amountClass = tx.type === 'income' ? 'is-income' : tx.type === 'refund' ? 'is-refund' : '';

  return `
    <div class="tx ${armed ? 'is-armed' : ''}">
      <div class="tx-info">
        <div class="tx-title">${esc(title)}</div>
        <div class="tx-sub">${esc(sub)}</div>
      </div>
      <div class="tx-amt ${amountClass}">${sign}¥${formatMoney(tx.amount)}</div>
      ${
        armed
          ? `<button class="tx-confirm" data-act="del-tx" data-id="${esc(tx.id)}">确认删除</button>`
          : `<button class="tx-del" data-act="del-tx" data-id="${esc(tx.id)}" aria-label="删除这笔">×</button>`
      }
    </div>`;
}

/* ---------------------------------- 设置 ---------------------------------- */

function settingsSheetHtml(view) {
  const s = ui.settings;
  const perm = quotaEditAllowed(state.config, new Date());
  const editNote = perm.first
    ? '首次修改不计次，之后每月限 1 次。'
    : perm.allowed
      ? '本月还可以改 1 次，之后每月限 1 次。'
      : '本月额度修改次数已用完，下月 1 号后可再改。';

  const fixedRows = state.config.fixedExpenses.length
    ? `<div class="fixed-list">${state.config.fixedExpenses
        .map(
          (item, index) => `
        <div class="fixed-row static">
          <span class="fixed-name">${esc(item.name)}</span>
          <span class="fixed-amount">¥${formatMoney(item.amount)}</span>
          <button class="icon-btn danger" data-act="remove-fixed" data-scope="settings" data-idx="${index}" aria-label="删除 ${esc(item.name)}">×</button>
        </div>`,
        )
        .join('')}</div>`
    : '<p class="hint">还没有固定支出项。</p>';

  const categories = state.config.categories
    .map(
      (name) => `
      <span class="chip">
        <span class="chip-name">${esc(name)}</span>
        <button class="chip-x" data-act="remove-category" data-cat="${esc(name)}" aria-label="删除类目 ${esc(name)}">×</button>
      </span>`,
    )
    .join('');

  const backupDays = daysSince(state.config.lastBackupAt, new Date());
  const backupNote =
    state.config.lastBackupAt == null
      ? '还没备份过。换机、清缓存都会丢数据，备份是你唯一的退路。'
      : `上次备份：${backupDays === 0 ? '今天' : `${backupDays} 天前`}。数据只在本机，备份是你唯一的退路。`;

  const body = `
    <section class="sect">
      <div class="sect-title">额度</div>
      <div class="row">
        <span class="row-key">当前余额</span>
        <b class="row-value">${signedMoney(view.balance)}</b>
        ${s.editingBalance ? '' : '<button class="btn-text" data-act="edit-balance">核对</button>'}
      </div>
      ${
        s.editingBalance
          ? `<div class="inline-form">
               <input class="input" type="number" inputmode="decimal" min="0" step="0.01"
                      data-field="settings-balance" value="${esc(s.balance)}" aria-label="当前余额" />
               <button class="btn-primary small" data-act="save-balance">保存</button>
             </div>
             <p class="hint">填成钱包/银行里的实际余额。起始余额 ${signedMoney(state.config.initialBalance)}，之后由收支推算。</p>`
          : ''
      }
      <label class="field">
        <span class="field-label">截止日期</span>
        <div class="inline-form">
          <input class="input" type="date" data-field="settings-deadline" value="${esc(s.deadline)}" aria-label="截止日期" />
          <button class="btn-primary small" data-act="save-deadline">保存</button>
        </div>
        <span class="field-hint">
          当前：${fullDateLabel(state.config.deadline)}${view.deadlinePassed ? '（已过期）' : `，还有 ${view.months} 个月`}
        </span>
      </label>
      <p class="hint">${editNote}改动都在次月 1 号重算时生效，本月额度已冻结。</p>
    </section>

    <section class="sect">
      <div class="sect-title">每月固定支出</div>
      <p class="hint">每月先从月额度里扣掉，不算进日常消费。</p>
      ${fixedRows}
      <div class="inline-form">
        <input class="input" data-field="settings-fixed-name" value="${esc(s.fixedName)}" placeholder="名称" aria-label="固定支出名称" />
        <input class="input input-num" type="number" inputmode="decimal" min="0" step="0.01"
               data-field="settings-fixed-amount" value="${esc(s.fixedAmount)}" placeholder="金额" aria-label="固定支出金额" />
        <button class="btn-ghost small" data-act="add-fixed" data-scope="settings">添加</button>
      </div>
    </section>

    <section class="sect">
      <div class="sect-title">类目</div>
      <p class="hint">预设之外可以自己加，不限二级。</p>
      <div class="chips">${categories}</div>
      <div class="inline-form">
        <input class="input" data-field="settings-new-category" value="${esc(s.newCategory)}" placeholder="新类目名，如 医疗" maxlength="8" aria-label="新类目名" />
        <button class="btn-ghost small" data-act="add-category">添加</button>
      </div>
    </section>

    <section class="sect">
      <div class="sect-title">备份</div>
      <p class="hint">${backupNote} 数据只在本机，备份是你唯一的退路。</p>
      <div class="btn-row">
        <button class="btn-ghost" data-act="export">导出 JSON</button>
        <button class="btn-ghost" data-act="import">导入 JSON</button>
      </div>
    </section>

    <section class="sect">
      <div class="sect-title">其他</div>
      <button class="btn-danger" data-act="clear-data">
        ${ui.confirmClear ? '再点一次，确认清空全部数据' : '清空全部数据'}
      </button>
      <p class="hint">版本 v1.0.0 · 纯本地 · 不联网</p>
    </section>`;

  return sheetShell('设置', body);
}

/* --------------------------------- 交互动作 -------------------------------- */

function openEntry() {
  ui.sheet = 'entry';
  ui.entry = {
    step: 1,
    type: 'expense',
    amountStr: '',
    category: null,
    note: '',
    date: toDateKey(new Date()),
  };
  render();
}

function openList() {
  ui.sheet = 'list';
  ui.confirmTxId = null;
  render();
}

function openSettings() {
  ui.sheet = 'settings';
  ui.settings = {
    balance: String(round2(balanceOf(state))),
    deadline: state.config.deadline,
    editingBalance: false,
    fixedName: '',
    fixedAmount: '',
    newCategory: '',
  };
  ui.confirmClear = false;
  render();
}

function closeSheet() {
  ui.sheet = null;
  ui.entry = null;
  ui.settings = null;
  ui.confirmTxId = null;
  ui.confirmClear = false;
  render();
}

function pressKey(key) {
  const entry = ui.entry;
  if (!entry) return;
  let value = entry.amountStr;

  if (key === 'del') {
    value = value.slice(0, -1);
  } else if (key === '.') {
    if (!value.includes('.')) value = `${value || '0'}.`;
  } else {
    const [integer, decimal] = value.split('.');
    if (decimal !== undefined && decimal.length >= 2) return;
    if (decimal === undefined && integer.length >= 7) return;
    value = value === '0' ? key : value + key;
  }

  entry.amountStr = value;
  const display = document.getElementById('entry-amount');
  if (display) display.textContent = value || '0';
  const button = app.querySelector('[data-act="entry-next"]');
  if (button) button.disabled = !(Number(value) > 0);
}

function gotoStep2() {
  const entry = ui.entry;
  if (!entry) return;
  const amount = Number(entry.amountStr);
  if (!(amount > 0) || !Number.isFinite(amount)) {
    toast('先输入金额');
    return;
  }
  if (entry.type === 'income') {
    saveEntry();
    return;
  }
  if (!entry.category && state.config.categories.length === 1) {
    entry.category = state.config.categories[0];
  }
  entry.step = 2;
  render();
}

function saveEntry() {
  const entry = ui.entry;
  if (!entry) return;
  const amount = round2(Number(entry.amountStr));
  if (!(amount > 0) || !Number.isFinite(amount)) {
    toast('金额要大于 0');
    return;
  }
  if (entry.type !== 'income' && !entry.category) {
    toast('先选一个类目');
    return;
  }

  const todayKey = toDateKey(new Date());
  const date = entry.date && entry.date <= todayKey ? entry.date : todayKey;
  const tx = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    type: entry.type,
    amount,
    category: entry.type === 'income' ? null : entry.category,
    note: (entry.note || '').trim().slice(0, 30),
    date,
    ts: new Date().toISOString(),
  };

  state = { ...state, txs: [...state.txs, tx].sort(txCompare) };
  persist();

  const label = tx.type === 'income' ? '收入' : tx.type === 'refund' ? '退款' : '支出';
  const when = date === todayKey ? '' : `（${dateLabel(date)}）`;
  ui.sheet = null;
  ui.entry = null;
  render();
  toast(`已记${label} ¥${formatMoney(amount)}${when}`);
}

function submitSetup() {
  const draft = ui.setup;
  if (!draft) return;
  const balance = Number(draft.balance);
  if (!String(draft.balance).trim() || !Number.isFinite(balance) || balance < 0) {
    draft.error = '请填写当前余额（可以是 0）';
    render();
    return;
  }
  if (!draft.deadline) {
    draft.error = '请选择截止日期';
    render();
    return;
  }
  if (draft.deadline < toDateKey(new Date())) {
    draft.error = '截止日期不能早于今天';
    render();
    return;
  }

  const fixedExpenses = [];
  for (const item of draft.fixed) {
    const name = String(item.name || '').trim();
    if (!name) continue;
    const amount = Number(item.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      draft.error = `固定支出「${name}」金额不正确`;
      render();
      return;
    }
    if (amount > 0) fixedExpenses.push({ name: name.slice(0, 12), amount: round2(amount) });
  }

  state = {
    ...state,
    config: {
      ...state.config,
      setupDone: true,
      initialBalance: round2(balance),
      deadline: draft.deadline,
      fixedExpenses,
      createdAt: new Date().toISOString(),
    },
  };
  state = ensureMonth(state, new Date());
  persist();
  ui.setup = null;
  render();
  toast('开始记账');
}

function addFixedRow(scope) {
  const isSetup = scope === 'setup';
  const draft = isSetup ? ui.setup : ui.settings;
  if (!draft) return;
  const name = String(draft.fixedName || '').trim();
  const amount = Number(draft.fixedAmount);
  if (!name) {
    toast('先写名称');
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    toast('金额要大于 0');
    return;
  }
  if (isSetup) {
    draft.fixed.push({ name, amount: String(round2(amount)) });
  } else {
    state = {
      ...state,
      config: {
        ...state.config,
        fixedExpenses: [...state.config.fixedExpenses, { name: name.slice(0, 12), amount: round2(amount) }],
      },
    };
    persist();
    toast('已添加，下月 1 号生效');
  }
  draft.fixedName = '';
  draft.fixedAmount = '';
  render();
}

function removeFixedRow(scope, index) {
  if (scope === 'setup') {
    if (!ui.setup) return;
    ui.setup.fixed.splice(index, 1);
  } else {
    state = {
      ...state,
      config: {
        ...state.config,
        fixedExpenses: state.config.fixedExpenses.filter((_, i) => i !== index),
      },
    };
    persist();
    toast('已删除，下月 1 号生效');
  }
  render();
}

function saveBalance() {
  const settings = ui.settings;
  if (!settings) return;
  const entered = Number(settings.balance);
  if (!String(settings.balance).trim() || !Number.isFinite(entered) || entered < 0) {
    toast('请输入正确的余额');
    return;
  }
  // 用户填的是“现在的真实余额”，反推起始余额，保证首页立刻显示这个数
  const current = round2(balanceOf(state));
  const target = round2(entered);
  if (target === current) {
    toast('余额没有变化');
    return;
  }
  const perm = quotaEditAllowed(state.config, new Date());
  if (!perm.allowed) {
    toast('本月额度修改次数已用完，下月 1 号后再改');
    return;
  }
  state = {
    ...state,
    config: {
      ...state.config,
      initialBalance: round2(state.config.initialBalance + (target - current)),
      quotaEdit: { month: monthKeyOf(new Date()), at: new Date().toISOString() },
    },
  };
  persist();
  ui.settings.editingBalance = false;
  ui.settings.balance = String(target);
  render();
  toast('余额已核对，下月 1 号按新余额重算');
}

function saveDeadline() {
  const settings = ui.settings;
  if (!settings) return;
  const deadline = settings.deadline;
  if (!deadline) {
    toast('请选择截止日期');
    return;
  }
  if (deadline < toDateKey(new Date())) {
    toast('截止日期不能早于今天');
    return;
  }
  const deadlineBlocked = !state.monthState || state.monthState.quota == null;
  state = { ...state, config: { ...state.config, deadline } };
  state = ensureMonth(state, new Date()); // 之前因过期而算不出额度的，这里补上
  persist();
  render();
  toast(deadlineBlocked ? '截止日期已更新，额度已重算' : '截止日期已更新，下月 1 号重算生效');
}

function addCategory() {
  const settings = ui.settings;
  if (!settings) return;
  const name = String(settings.newCategory || '').trim().slice(0, 8);
  if (!name) {
    toast('先写类目名');
    return;
  }
  if (state.config.categories.includes(name)) {
    toast('这个类目已经有了');
    return;
  }
  const perm = quotaEditAllowed(state.config, new Date());
  if (!perm.allowed) {
    toast('本月额度修改次数已用完，下月 1 号后再改');
    return;
  }
  state = {
    ...state,
    config: {
      ...state.config,
      categories: [...state.config.categories, name],
      quotaEdit: { month: monthKeyOf(new Date()), at: new Date().toISOString() },
    },
  };
  persist();
  settings.newCategory = '';
  render();
  toast('类目已添加');
}

function removeCategory(name) {
  const perm = quotaEditAllowed(state.config, new Date());
  if (!perm.allowed) {
    toast('本月额度修改次数已用完，下月 1 号后再改');
    return;
  }
  if (state.config.categories.length <= 1) {
    toast('至少保留一个类目');
    return;
  }
  state = {
    ...state,
    config: {
      ...state.config,
      categories: state.config.categories.filter((item) => item !== name),
      quotaEdit: { month: monthKeyOf(new Date()), at: new Date().toISOString() },
    },
  };
  persist();
  render();
  toast('类目已删除，旧记录不受影响');
}

function deleteTx(id) {
  if (!ui.confirmTxId) {
    ui.confirmTxId = id;
    render();
    setTimeout(() => {
      if (ui.confirmTxId === id) {
        ui.confirmTxId = null;
        render();
      }
    }, 3000);
    return;
  }
  if (ui.confirmTxId !== id) return;
  state = { ...state, txs: state.txs.filter((tx) => tx.id !== id) };
  persist();
  ui.confirmTxId = null;
  render();
  toast('已删除');
}

function doExport() {
  const payload = exportPayload(state);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = buildBackupFilename(new Date());
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  state = { ...state, config: { ...state.config, lastBackupAt: new Date().toISOString() } };
  persist();
  render();
  toast('备份已导出');
}

function doImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    let text = '';
    try {
      text = await file.text();
    } catch {
      toast('读不到这个文件');
      return;
    }
    const result = parseImportPayload(text);
    if (!result.ok) {
      toast(result.error);
      return;
    }
    if (!window.confirm('导入会覆盖当前全部数据，确定继续？')) return;

    state = ensureMonth(result.state, new Date());
    persist();
    ui.sheet = null;
    ui.entry = null;
    ui.settings = null;
    ui.setup = state.config.setupDone ? null : setupDraft();
    render();
    toast('已从备份恢复');
  });
  input.click();
}

function clearAll() {
  if (!ui.confirmClear) {
    ui.confirmClear = true;
    render();
    setTimeout(() => {
      if (ui.confirmClear) {
        ui.confirmClear = false;
        render();
      }
    }, 4000);
    return;
  }
  clearState();
  ui.sheet = null;
  ui.settings = null;
  ui.entry = null;
  ui.confirmClear = false;
  ui.setup = setupDraft();
  state = newState();
  render();
  toast('已清空');
}

/* ------------------------------- 跨天/跨月检测 ------------------------------ */

function syncClock() {
  if (!state.config.setupDone) return;
  const now = new Date();
  const todayKey = toDateKey(now);
  const monthChanged = ensureMonth(state, now) !== state;
  if (!monthChanged && todayKey === lastDayKey) return;

  lastDayKey = todayKey;
  render(); // render 内部会补上新的月度快照
}

/* --------------------------------- 事件绑定 -------------------------------- */

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]');
  if (!target) return;
  const action = target.dataset.act;

  switch (action) {
    case 'record':
      openEntry();
      break;
    case 'close-sheet':
      closeSheet();
      break;
    case 'entry-type':
      if (ui.entry && ui.entry.type !== target.dataset.type) {
        ui.entry.type = target.dataset.type;
        ui.entry.category = null;
        render();
      }
      break;
    case 'key':
      pressKey(target.dataset.key);
      break;
    case 'entry-next':
      gotoStep2();
      break;
    case 'entry-back':
      if (ui.entry) {
        ui.entry.step = 1;
        render();
      }
      break;
    case 'entry-save':
      saveEntry();
      break;
    case 'pick-cat':
      if (ui.entry) {
        ui.entry.category = target.dataset.cat;
        render();
      }
      break;
    case 'settings':
      openSettings();
      break;
    case 'list':
      openList();
      break;
    case 'del-tx':
      deleteTx(target.dataset.id);
      break;
    case 'export':
      doExport();
      break;
    case 'import':
      doImport();
      break;
    case 'setup-submit':
      submitSetup();
      break;
    case 'add-fixed':
      addFixedRow(target.dataset.scope);
      break;
    case 'remove-fixed':
      removeFixedRow(target.dataset.scope, Number(target.dataset.idx));
      break;
    case 'edit-balance':
      if (ui.settings) {
        ui.settings.editingBalance = true;
        render();
      }
      break;
    case 'save-balance':
      saveBalance();
      break;
    case 'save-deadline':
      saveDeadline();
      break;
    case 'add-category':
      addCategory();
      break;
    case 'remove-category':
      removeCategory(target.dataset.cat);
      break;
    case 'clear-data':
      clearAll();
      break;
    default:
      break;
  }
});

document.addEventListener('input', (event) => {
  const el = event.target;
  const field = el.dataset ? el.dataset.field : null;
  if (!field) return;
  const index = el.dataset.idx != null ? Number(el.dataset.idx) : null;

  switch (field) {
    case 'setup-balance':
      ui.setup.balance = el.value;
      break;
    case 'setup-deadline':
      ui.setup.deadline = el.value;
      break;
    case 'setup-fixed-name':
      if (ui.setup && index != null) ui.setup.fixed[index].name = el.value;
      break;
    case 'setup-fixed-amount':
      if (ui.setup && index != null) ui.setup.fixed[index].amount = el.value;
      break;
    case 'setup-fixed-new-name':
      ui.setup.fixedName = el.value;
      break;
    case 'setup-fixed-new-amount':
      ui.setup.fixedAmount = el.value;
      break;
    case 'settings-balance':
      ui.settings.balance = el.value;
      break;
    case 'settings-deadline':
      ui.settings.deadline = el.value;
      break;
    case 'settings-fixed-name':
      ui.settings.fixedName = el.value;
      break;
    case 'settings-fixed-amount':
      ui.settings.fixedAmount = el.value;
      break;
    case 'settings-new-category':
      ui.settings.newCategory = el.value;
      break;
    case 'entry-note':
      if (ui.entry) ui.entry.note = el.value;
      break;
    case 'entry-date':
      if (ui.entry) ui.entry.date = el.value;
      break;
    default:
      break;
  }
});

document.addEventListener('keydown', (event) => {
  if (!ui.sheet) return;
  if (event.key === 'Escape') {
    closeSheet();
    return;
  }
  if (ui.sheet !== 'entry' || !ui.entry || ui.entry.step !== 1) return;
  const tag = event.target && event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (/^[0-9]$/.test(event.key)) {
    pressKey(event.key);
    event.preventDefault();
  } else if (event.key === '.') {
    pressKey('.');
    event.preventDefault();
  } else if (event.key === 'Backspace') {
    pressKey('del');
    event.preventDefault();
  } else if (event.key === 'Enter') {
    gotoNext();
  }
});

function gotoNext() {
  const button = app.querySelector('[data-act="entry-next"]');
  if (button && !button.disabled) gotoStep2();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) syncClock();
});
window.addEventListener('focus', syncClock);

render();
