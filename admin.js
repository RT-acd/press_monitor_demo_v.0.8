/* ==========================================================
   PRESS MONITOR — 管理者ページ用ロジック
   Excelファイルを読み取り、列を選んでクラウドへアップロードする。
   ========================================================== */

const ADMIN_SETTINGS_KEY = 'pm_admin_settings_v1';

let partWorkbook = null; // { sheetNames, sheets: { name: [[...],[...]] } }
let opWorkbook = null;
let reasonWorkbook = null;

window.onload = function () {
  const saved = loadAdminSettings();
  document.getElementById('gas-url').value = saved.gasUrl || '';
  document.getElementById('gas-url').addEventListener('change', (e) => {
    saveAdminSettings({ gasUrl: e.target.value.trim() });
  });

  document.getElementById('part-file-input').addEventListener('change', (e) => handleFileSelected(e, 'part'));
  document.getElementById('op-file-input').addEventListener('change', (e) => handleFileSelected(e, 'op'));
  document.getElementById('reason-file-input').addEventListener('change', (e) => handleFileSelected(e, 'reason'));

  document.getElementById('part-sheet-select').addEventListener('change', () => renderPartMappingUI());
  document.getElementById('op-sheet-select').addEventListener('change', () => renderOpMappingUI());
  document.getElementById('reason-sheet-select').addEventListener('change', () => renderReasonMappingUI());
  document.getElementById('part-col-select').addEventListener('change', () => renderPartPreview());
  document.getElementById('spm-col-select').addEventListener('change', () => renderPartPreview());
  document.getElementById('process-col-select').addEventListener('change', () => renderPartPreview());
  document.getElementById('machine-col-select').addEventListener('change', () => renderPartPreview());
  document.getElementById('op-col-select').addEventListener('change', () => renderOpPreview());
  document.getElementById('reason-col-select').addEventListener('change', () => renderReasonPreview());
};

/* ---------- 設定の保存（この管理者PC・ブラウザ内のみ） ---------- */
function loadAdminSettings() {
  try {
    const raw = localStorage.getItem(ADMIN_SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { gasUrl: '' };
}
function saveAdminSettings(patch) {
  const current = loadAdminSettings();
  const merged = Object.assign({}, current, patch);
  localStorage.setItem(ADMIN_SETTINGS_KEY, JSON.stringify(merged));
}
function getGasUrl() {
  return document.getElementById('gas-url').value.trim();
}

/* ---------- クラウド通信共通 ---------- */
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
    resultEl.innerHTML = (res && res.status === 'ok')
      ? '<span class="text-emerald-400"><i class="fa-solid fa-circle-check mr-1"></i>接続成功しました</span>'
      : '<span class="text-amber-400">応答はありましたが内容が想定外です</span>';
  } catch (e) {
    resultEl.innerHTML = '<span class="text-rose-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>接続できませんでした</span>';
  }
}

async function loadCurrentMasters() {
  const el = document.getElementById('current-master-status');
  if (!getGasUrl()) { el.innerHTML = '<span class="text-rose-400">先にWeb App URLを入力してください</span>'; return; }
  el.innerHTML = '取得中…';
  try {
    const res = await gasRequest({ action: 'getMasters' });
    if (res && res.status === 'ok') {
      el.innerHTML = `品番マスタ: <span class="text-emerald-400 font-bold">${res.partMasters.length}件</span>　／　作業員マスタ: <span class="text-emerald-400 font-bold">${res.operators.length}名</span>　／　停止理由マスタ: <span class="text-emerald-400 font-bold">${(res.stopReasons || []).length}件</span>`;
    } else {
      el.innerHTML = '<span class="text-rose-400">取得に失敗しました</span>';
    }
  } catch (e) {
    el.innerHTML = '<span class="text-rose-400">取得に失敗しました（URLをご確認ください）</span>';
  }
}

/* =========================================================
   Excelファイルの読み込み
   ========================================================= */
function readWorkbookFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const sheets = {};
        wb.SheetNames.forEach(name => {
          sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
        });
        resolve({ sheetNames: wb.SheetNames, sheets });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function handleFileSelected(e, kind) {
  const file = e.target.files[0];
  if (!file) return;
  readWorkbookFile(file).then(wb => {
    if (kind === 'part') {
      partWorkbook = wb;
      const sel = document.getElementById('part-sheet-select');
      sel.innerHTML = wb.sheetNames.map(n => `<option value="${escAttr(n)}">${escHtml(n)}</option>`).join('');
      document.getElementById('part-mapping-box').classList.remove('hidden');
      renderPartMappingUI();
    } else if (kind === 'op') {
      opWorkbook = wb;
      const sel = document.getElementById('op-sheet-select');
      sel.innerHTML = wb.sheetNames.map(n => `<option value="${escAttr(n)}">${escHtml(n)}</option>`).join('');
      document.getElementById('op-mapping-box').classList.remove('hidden');
      renderOpMappingUI();
    } else {
      reasonWorkbook = wb;
      const sel = document.getElementById('reason-sheet-select');
      sel.innerHTML = wb.sheetNames.map(n => `<option value="${escAttr(n)}">${escHtml(n)}</option>`).join('');
      document.getElementById('reason-mapping-box').classList.remove('hidden');
      renderReasonMappingUI();
    }
  }).catch(() => {
    showAlertResult(kind, 'ファイルの読み込みに失敗しました。Excel形式(.xlsx)かご確認ください。', true);
  });
}

/* ---------- 見出し名からの自動推測 ---------- */
function guessColumnIndex(headers, candidates) {
  const norm = s => String(s || '').trim().toLowerCase();
  for (const cand of candidates) {
    const idx = headers.findIndex(h => norm(h) === norm(cand));
    if (idx >= 0) return idx;
  }
  return -1;
}

/* =========================================================
   品番マスタ：マッピングUI
   ========================================================= */
function renderPartMappingUI() {
  const sheetName = document.getElementById('part-sheet-select').value;
  const rows = partWorkbook.sheets[sheetName] || [];
  const headers = rows[0] || [];

  const colOptions = headers.map((h, i) => `<option value="${i}">${escHtml(h || '(列' + (i + 1) + ')')}</option>`).join('');
  const optionalOptions = '<option value="-1">（使わない）</option>' + colOptions;
  document.getElementById('part-col-select').innerHTML = colOptions;
  document.getElementById('spm-col-select').innerHTML = colOptions;
  document.getElementById('process-col-select').innerHTML = optionalOptions;
  document.getElementById('machine-col-select').innerHTML = optionalOptions;

  const partGuess = guessColumnIndex(headers, ['納入品番', '品番', '部品番号']);
  const spmGuess = guessColumnIndex(headers, ['SPM', 'spm']);
  // 工程名・充当機は列名が変わる可能性があるため、候補を広めに取って自動推測する（外れた場合は画面で選び直し）
  const processGuess = guessColumnIndex(headers, ['工程名', '工程', '工程区分']);
  const machineGuess = guessColumnIndex(headers, ['充当機', '充当設備', '充当機械', '充当機名', '設備', '設備名']);
  document.getElementById('part-col-select').value = partGuess >= 0 ? partGuess : 0;
  document.getElementById('spm-col-select').value = spmGuess >= 0 ? spmGuess : (headers.length > 1 ? 1 : 0);
  document.getElementById('process-col-select').value = processGuess >= 0 ? processGuess : -1;
  document.getElementById('machine-col-select').value = machineGuess >= 0 ? machineGuess : -1;

  renderPartPreview();
}

function getPartColumnSelection() {
  return {
    partCol: parseInt(document.getElementById('part-col-select').value),
    spmCol: parseInt(document.getElementById('spm-col-select').value),
    processCol: parseInt(document.getElementById('process-col-select').value),
    machineCol: parseInt(document.getElementById('machine-col-select').value),
  };
}

function renderPartPreview() {
  const sheetName = document.getElementById('part-sheet-select').value;
  const rows = partWorkbook.sheets[sheetName] || [];
  const { partCol, spmCol, processCol, machineCol } = getPartColumnSelection();
  const cell = (r, c) => c >= 0 ? escHtml(r[c]) : '<span class="text-slate-600">－</span>';

  const body = rows.slice(1, 9).map(r => `
    <tr class="border-b border-line">
      <td class="p-1.5 font-mono text-emerald-300">${escHtml(r[partCol])}</td>
      <td class="p-1.5 font-mono text-amber-300">${escHtml(r[spmCol])}</td>
      <td class="p-1.5 font-mono text-sky-300">${cell(r, processCol)}</td>
      <td class="p-1.5 font-mono text-purple-300">${cell(r, machineCol)}</td>
    </tr>`).join('');

  document.getElementById('part-preview-table').innerHTML = `
    <thead><tr class="bg-panel text-slate-400"><th class="p-1.5 text-left">品番</th><th class="p-1.5 text-left">SPM</th><th class="p-1.5 text-left">工程名</th><th class="p-1.5 text-left">充当機</th></tr></thead>
    <tbody>${body || '<tr><td class="p-2 text-slate-500" colspan="4">データ行が見つかりません</td></tr>'}</tbody>`;
}

async function uploadPartMaster() {
  const sheetName = document.getElementById('part-sheet-select').value;
  const rows = partWorkbook.sheets[sheetName] || [];
  const { partCol, spmCol, processCol, machineCol } = getPartColumnSelection();

  const dataRows = rows.slice(1)
    .map(r => ({
      part: String(r[partCol] ?? '').trim(),
      spm: parseFloat(r[spmCol]),
      process: processCol >= 0 ? String(r[processCol] ?? '').trim() : '',
      machine: machineCol >= 0 ? String(r[machineCol] ?? '').trim() : '',
    }))
    .filter(r => r.part && !isNaN(r.spm));

  if (dataRows.length === 0) {
    showAlertResult('part', '有効な行がありません。列の選択をご確認ください。', true);
    return;
  }
  if (!getGasUrl()) { showAlertResult('part', 'Web App URLを入力してください', true); return; }

  showAlertResult('part', `送信中…（${dataRows.length}件）`, false);
  try {
    const res = await gasRequest({ action: 'uploadPartMaster', rows: dataRows });
    if (res && res.status === 'ok') {
      showAlertResult('part', `反映しました（${res.count}件）。各iPadは自動的に最新化されます。`, false, true);
    } else {
      showAlertResult('part', '反映に失敗しました：' + (res && res.message ? res.message : '不明なエラー'), true);
    }
  } catch (e) {
    showAlertResult('part', '通信に失敗しました。URLや接続環境をご確認ください。', true);
  }
}

/* =========================================================
   作業員マスタ：マッピングUI
   ========================================================= */
function renderOpMappingUI() {
  const sheetName = document.getElementById('op-sheet-select').value;
  const rows = opWorkbook.sheets[sheetName] || [];
  const headers = rows[0] || [];

  const colOptions = headers.map((h, i) => `<option value="${i}">${escHtml(h || '(列' + (i + 1) + ')')}</option>`).join('');
  document.getElementById('op-col-select').innerHTML = colOptions;

  const nameGuess = guessColumnIndex(headers, ['作業員名', '氏名', '名前', '従業員名']);
  document.getElementById('op-col-select').value = nameGuess >= 0 ? nameGuess : 0;

  renderOpPreview();
}

function renderOpPreview() {
  const sheetName = document.getElementById('op-sheet-select').value;
  const rows = opWorkbook.sheets[sheetName] || [];
  const nameCol = parseInt(document.getElementById('op-col-select').value);

  const body = rows.slice(1, 9).map(r => `
    <tr class="border-b border-line"><td class="p-1.5 font-mono text-emerald-300">${escHtml(r[nameCol])}</td></tr>`).join('');

  document.getElementById('op-preview-table').innerHTML = `
    <thead><tr class="bg-panel text-slate-400"><th class="p-1.5 text-left">作業員名（プレビュー）</th></tr></thead>
    <tbody>${body || '<tr><td class="p-2 text-slate-500">データ行が見つかりません</td></tr>'}</tbody>`;
}

async function uploadOperatorMaster() {
  const sheetName = document.getElementById('op-sheet-select').value;
  const rows = opWorkbook.sheets[sheetName] || [];
  const nameCol = parseInt(document.getElementById('op-col-select').value);

  const names = rows.slice(1).map(r => String(r[nameCol] ?? '').trim()).filter(n => n);

  if (names.length === 0) {
    showAlertResult('op', '有効な作業員名がありません。列の選択をご確認ください。', true);
    return;
  }
  if (!getGasUrl()) { showAlertResult('op', 'Web App URLを入力してください', true); return; }

  showAlertResult('op', `送信中…（${names.length}名）`, false);
  try {
    const res = await gasRequest({ action: 'uploadOperatorMaster', names });
    if (res && res.status === 'ok') {
      showAlertResult('op', `反映しました（${res.count}名）。各iPadは自動的に最新化されます。`, false, true);
    } else {
      showAlertResult('op', '反映に失敗しました：' + (res && res.message ? res.message : '不明なエラー'), true);
    }
  } catch (e) {
    showAlertResult('op', '通信に失敗しました。URLや接続環境をご確認ください。', true);
  }
}

/* =========================================================
   停止理由マスタ：マッピングUI
   ========================================================= */
function renderReasonMappingUI() {
  const sheetName = document.getElementById('reason-sheet-select').value;
  const rows = reasonWorkbook.sheets[sheetName] || [];
  const headers = rows[0] || [];

  const colOptions = headers.map((h, i) => `<option value="${i}">${escHtml(h || '(列' + (i + 1) + ')')}</option>`).join('');
  document.getElementById('reason-col-select').innerHTML = colOptions;

  const reasonGuess = guessColumnIndex(headers, ['停止理由カテゴリ', '停止理由', 'カテゴリ', '理由']);
  document.getElementById('reason-col-select').value = reasonGuess >= 0 ? reasonGuess : 0;

  renderReasonPreview();
}

function renderReasonPreview() {
  const sheetName = document.getElementById('reason-sheet-select').value;
  const rows = reasonWorkbook.sheets[sheetName] || [];
  const reasonCol = parseInt(document.getElementById('reason-col-select').value);

  const body = rows.slice(1, 9).map(r => `
    <tr class="border-b border-line"><td class="p-1.5 font-mono text-emerald-300">${escHtml(r[reasonCol])}</td></tr>`).join('');

  document.getElementById('reason-preview-table').innerHTML = `
    <thead><tr class="bg-panel text-slate-400"><th class="p-1.5 text-left">停止理由カテゴリ（プレビュー）</th></tr></thead>
    <tbody>${body || '<tr><td class="p-2 text-slate-500">データ行が見つかりません</td></tr>'}</tbody>`;
}

async function uploadStopReasonMaster() {
  const sheetName = document.getElementById('reason-sheet-select').value;
  const rows = reasonWorkbook.sheets[sheetName] || [];
  const reasonCol = parseInt(document.getElementById('reason-col-select').value);

  const reasons = rows.slice(1).map(r => String(r[reasonCol] ?? '').trim()).filter(r => r);

  if (reasons.length === 0) {
    showAlertResult('reason', '有効な停止理由がありません。列の選択をご確認ください。', true);
    return;
  }
  if (!getGasUrl()) { showAlertResult('reason', 'Web App URLを入力してください', true); return; }

  showAlertResult('reason', `送信中…（${reasons.length}件）`, false);
  try {
    const res = await gasRequest({ action: 'uploadStopReasonMaster', reasons });
    if (res && res.status === 'ok') {
      showAlertResult('reason', `反映しました（${res.count}件）。各iPadは自動的に最新化されます。`, false, true);
    } else {
      showAlertResult('reason', '反映に失敗しました：' + (res && res.message ? res.message : '不明なエラー'), true);
    }
  } catch (e) {
    showAlertResult('reason', '通信に失敗しました。URLや接続環境をご確認ください。', true);
  }
}

/* ---------- 共通ヘルパー ---------- */
function showAlertResult(kind, message, isError, isSuccess) {
  const idMap = { part: 'part-upload-result', op: 'op-upload-result', reason: 'reason-upload-result' };
  const el = document.getElementById(idMap[kind] || 'part-upload-result');
  el.className = isError ? 'text-[11px] text-rose-400 font-bold' : (isSuccess ? 'text-[11px] text-emerald-400 font-bold' : 'text-[11px] text-slate-400');
  el.innerText = message;
}

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escAttr(str) { return escHtml(str); }
