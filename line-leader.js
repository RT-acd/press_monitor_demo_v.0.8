/* ==========================================================
   PRESS MONITOR — ライン長向け閲覧画面ロジック
   クラウド（ライン長向けデータのスプレッドシート）から、ライン（設備）
   ごとの全期間データを取得して、日報・履歴画面と同じ見た目で表示する。
   このページ自体はデータを保存しない（閲覧専用）。
   ========================================================== */

const LINE_LEADER_SETTINGS_KEY = 'pm_lineleader_settings_v1';
const ALL_LINES_OPTION = '全ライン（比較用）';

window.onload = function () {
  const saved = loadLineLeaderSettings();
  document.getElementById('gas-url').value = saved.gasUrl || '';
  document.getElementById('gas-url').addEventListener('change', (e) => {
    saveLineLeaderSettings({ gasUrl: e.target.value.trim() });
    updateCloudStatus();
  });

  renderLineOptions();
  updateCloudStatus();
};

/* ---------- 設定の保存（このブラウザ内のみ） ---------- */
function loadLineLeaderSettings() {
  try {
    const raw = localStorage.getItem(LINE_LEADER_SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { gasUrl: '' };
}
function saveLineLeaderSettings(patch) {
  const current = loadLineLeaderSettings();
  const merged = Object.assign({}, current, patch);
  localStorage.setItem(LINE_LEADER_SETTINGS_KEY, JSON.stringify(merged));
}
function getGasUrl() {
  return document.getElementById('gas-url').value.trim();
}

function updateCloudStatus() {
  const chip = document.getElementById('cloud-status');
  const text = document.getElementById('cloud-status-text');
  const icon = chip.querySelector('i');
  if (getGasUrl()) {
    icon.className = 'fa-solid fa-circle text-emerald-400';
    text.innerText = 'クラウド接続設定済み';
  } else {
    icon.className = 'fa-solid fa-circle-notch text-slate-600';
    text.innerText = 'クラウド未接続';
  }
}

/* ---------- ライン（設備）選択肢 ---------- */
function renderLineOptions() {
  const select = document.getElementById('line-select');
  const equipmentList = (typeof DEFAULT_SETTINGS !== 'undefined' && DEFAULT_SETTINGS.equipmentList) || [];
  const options = [ALL_LINES_OPTION].concat(equipmentList);
  select.innerHTML = options.map(eq => `<option value="${escapeHtmlLL(eq)}">${escapeHtmlLL(eq)}</option>`).join('');
}

/* ---------- クラウド通信 ---------- */
async function gasRequest(payload) {
  const url = getGasUrl();
  if (!url) throw new Error('NO_URL');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function testConnection() {
  const resultEl = document.getElementById('conn-result');
  if (!getGasUrl()) { resultEl.innerHTML = '<span class="text-rose-400">URLを入力してください</span>'; return; }
  resultEl.innerHTML = '<span class="text-slate-400">確認中…</span>';
  try {
    const res = await gasRequest({ action: 'ping' });
    if (res && res.status === 'ok') {
      resultEl.innerHTML = '<span class="text-emerald-400"><i class="fa-solid fa-circle-check mr-1"></i>接続成功しました</span>';
    } else {
      resultEl.innerHTML = '<span class="text-amber-400">応答はありましたが内容が想定外です</span>';
    }
  } catch (e) {
    resultEl.innerHTML = '<span class="text-rose-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>接続できませんでした</span>';
  }
  updateCloudStatus();
}

/* ---------- ラインデータの取得・表示 ---------- */
async function loadLineData() {
  const tbody = document.getElementById('line-history-body');
  const selected = document.getElementById('line-select').value;
  if (!getGasUrl()) {
    tbody.innerHTML = '<tr><td colspan="17" class="p-6 text-center text-rose-400 font-bold">先にクラウド接続設定（Web App URL）を入力してください。</td></tr>';
    return;
  }
  tbody.innerHTML = '<tr><td colspan="17" class="p-6 text-center text-slate-500 font-bold"><i class="fa-solid fa-circle-notch fa-spin mr-1"></i>取得中…</td></tr>';

  try {
    const equipmentParam = selected === ALL_LINES_OPTION ? '' : selected;
    const res = await gasRequest({ action: 'getLineLeaderData', equipment: equipmentParam });
    if (!res || res.status !== 'ok') {
      tbody.innerHTML = `<tr><td colspan="17" class="p-6 text-center text-rose-400 font-bold">取得に失敗しました：${escapeHtmlLL((res && res.message) || '不明なエラー')}</td></tr>`;
      return;
    }
    renderLineHistoryTable(res.records || []);
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="17" class="p-6 text-center text-rose-400 font-bold">取得に失敗しました（URLやネットワーク状況をご確認ください）</td></tr>';
  }
}

function renderLineHistoryTable(records) {
  const tbody = document.getElementById('line-history-body');
  const summaryBox = document.getElementById('summary-box');

  if (!records || records.length === 0) {
    tbody.innerHTML = '<tr><td colspan="17" class="p-6 text-center text-slate-500 font-bold">該当するデータがありません。</td></tr>';
    summaryBox.classList.add('hidden');
    return;
  }

  // 日付・開始時刻の新しい順に並べ替え
  const sorted = records.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return (a.start || '') < (b.start || '') ? 1 : -1;
  });

  tbody.innerHTML = sorted.map(rec => `
    <tr class="row-hover transition-all">
      <td class="p-2 font-mono text-white">${escapeHtmlLL(rec.date)}</td>
      <td class="p-2 font-mono text-sky-300 font-bold">${escapeHtmlLL(rec.equipment || '未設定')}</td>
      <td class="p-2 font-mono text-amber-300 font-bold">${escapeHtmlLL(rec.operator || '未選択')}</td>
      <td class="p-2 font-mono text-center text-amber-200 font-bold">${rec.workerCount || 1}名</td>
      <td class="p-2 font-mono text-emerald-400 font-bold">${escapeHtmlLL(rec.partNo)}</td>
      <td class="p-2 font-mono text-slate-300">${escapeHtmlLL(rec.start)}</td>
      <td class="p-2 font-mono text-slate-300">${escapeHtmlLL(rec.end)}</td>
      <td class="p-2 font-mono font-bold text-white">${rec.count}</td>
      <td class="p-2 font-mono text-rose-300 font-bold">${rec.defectCount || 0}</td>
      <td class="p-2 font-mono text-amber-300 font-bold">${rec.materialCount || 0}</td>
      <td class="p-2 font-mono text-purple-300 font-bold">${rec.scrapCount || 0}</td>
      <td class="p-2 font-mono text-center text-rose-400 font-bold">${rec.abnormalStopCount || 0}件</td>
      <td class="p-2 font-mono">${formatTimeLL(rec.runningSec)}</td>
      <td class="p-2 font-mono text-amber-400">${formatTimeLL(rec.moldSec)}</td>
      <td class="p-2 font-mono text-sky-400">${formatTimeLL(rec.breakSec)}</td>
      <td class="p-2 font-mono text-rose-500">${formatTimeLL(rec.stopSec)}</td>
      <td class="p-2 font-mono font-bold text-emerald-400 text-right text-sm">${rec.perfRate}%</td>
    </tr>`).join('');

  const totalCount = sorted.reduce((s, r) => s + (r.count || 0), 0);
  const avgRate = sorted.reduce((s, r) => s + (parseFloat(r.perfRate) || 0), 0) / sorted.length;
  document.getElementById('summary-count').innerText = sorted.length.toLocaleString();
  document.getElementById('summary-total').innerText = totalCount.toLocaleString();
  document.getElementById('summary-rate').innerText = avgRate.toFixed(1);
  summaryBox.classList.remove('hidden');
}

/* ---------- 共通ヘルパー ---------- */
function formatTimeLL(sec) {
  sec = sec || 0;
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function escapeHtmlLL(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
