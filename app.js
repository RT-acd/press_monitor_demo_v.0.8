/* ==========================================================
   PRESS MONITOR — メインロジック（状態管理・画面制御）
   ========================================================== */

let settings = loadSettings();
let masters = loadMasters();

let state = {
  isShiftActive: false,
  status: 'IDLE',
  startTime: null,
  endTime: null,
  runningSeconds: 0,
  moldSeconds: 0,
  breakSeconds: 0,
  stopSeconds: 0,
  accumulatedCount: 0,
  settingSPM: 15.0,
  targetCount: CONFIG.INITIAL_TARGET_COUNT,
  partNo: '',
  segments: [], // 「人数変更を記録」で確定した区間の履歴（シフト内）
  segmentBaseline: { runningSeconds: 0, moldSeconds: 0, breakSeconds: 0, stopSeconds: 0, accumulatedCount: 0 },
  segmentStartTime: null,
  abnormalStopEvents: [], // 異常停止ボタンを押すたびに確定するイベント履歴（シフト内）
  openAbnormalStopEvent: null, // 現在進行中（未確定）の異常停止イベント { start, category, detail, defects }
  defectCount: 0, // 不良数（モニターのカウンター。異常停止時に入力した分も加算される）
};

let historyLogs = [];
let checkedRecordIds = new Set();
let lastTickTime = null;

/* ---------- 要素参照 ---------- */
const rateEl = document.getElementById('perf-rate');
const clockEl = document.getElementById('main-clock');
const countEl = document.getElementById('total-count');
const statusChip = document.getElementById('status-chip');
const clockSub = document.getElementById('clock-sub');
const rateBox = document.getElementById('rate-box');
const timeStartLabel = document.getElementById('time-start-label');
const timeEndLabel = document.getElementById('time-end-label');
const timeMoldEl = document.getElementById('time-mold');
const timeBreakEl = document.getElementById('time-break');
const timeStopEl = document.getElementById('time-stop');
const runBtn = document.getElementById('btn-RUNNING');
const runIcon = document.getElementById('run-icon');
const runText = document.getElementById('run-text');
const btnStartShift = document.getElementById('btn-start-shift');
const btnEndShift = document.getElementById('btn-end-shift');
const partNoSelect = document.getElementById('part-no-select');
const spmSettingInput = document.getElementById('spm-setting');
const targetInput = document.getElementById('target-count');
const targetDisplayVal = document.getElementById('target-val');
const reportEmailInput = document.getElementById('report-email');
const equipmentSelect = document.getElementById('equipment-select');
const equipmentSelectMonitor = document.getElementById('equipment-select-monitor');
const partDatalist = document.getElementById('part-master-list');
const partHintEl = document.getElementById('part-no-hint');
const defectCountEl = document.getElementById('defect-count');
const opSlotInputs = [
  document.getElementById('op-slot-0'),
  document.getElementById('op-slot-1'),
  document.getElementById('op-slot-2'),
  document.getElementById('op-slot-3'),
];

/* =========================================================
   初期化
   ========================================================= */
window.onload = function () {
  applySettingsToUI();
  renderEquipmentOptions();
  renderPartOptions();
  renderOperatorDatalist();
  renderStopReasonOptions();
  renderMasterStatus();

  try {
    const saved = localStorage.getItem(STORAGE.HISTORY);
    if (saved) historyLogs = JSON.parse(saved);
  } catch (e) {}

  spmSettingInput.value = state.settingSPM.toFixed(1);
  targetInput.value = CONFIG.INITIAL_TARGET_COUNT;

  // 部品番号は入力欄＋予測変換。入力中も品番確定（候補と完全一致）したらSPMを自動反映する
  partNoSelect.addEventListener('input', () => { onPartInput(); persistShiftState(); });
  partNoSelect.addEventListener('change', () => { partNoSelect.value = partNoSelect.value.trim(); onPartInput(); persistShiftState(); });

  spmSettingInput.addEventListener('input', (e) => {
    state.settingSPM = parseFloat(e.target.value) || 0.1;
    updateCalculations();
    persistShiftState();
  });

  targetInput.addEventListener('input', (e) => {
    state.targetCount = parseInt(e.target.value) || 1;
    targetDisplayVal.innerText = state.targetCount.toLocaleString();
    persistShiftState();
  });

  reportEmailInput.addEventListener('change', (e) => {
    settings.defaultEmail = e.target.value.trim();
    persistSettings();
  });

  // 設備の切り替え（モニター画面・日報画面のどちらで変更しても連動する）
  equipmentSelect.addEventListener('change', (e) => setEquipment(e.target.value));
  equipmentSelectMonitor.addEventListener('change', (e) => setEquipment(e.target.value));
  const savedEquip = localStorage.getItem('pm_last_equipment_v1');
  if (savedEquip && getEquipmentList().includes(savedEquip)) setEquipment(savedEquip, true);

  // 作業員4窓はタップで名前の一覧（ボタン）から選ぶ方式（キーボードを出さないため）。
  // マスタに一致しない名前（手入力）は枠を赤くする（保存はブロックしない弱い警告）

  // 製造中にブラウザの更新／閉じるボタンが押された場合は、ブラウザ標準の確認ダイアログを出す
  // （表示文言は各ブラウザ固有のもので、こちらから変更はできない仕様）
  window.addEventListener('beforeunload', (e) => {
    if (state.isShiftActive) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });

  // 前回、製造中にブラウザが更新／再読み込みされていた場合はデータを復元する
  restoreShiftState();
  // 製造中の復元がない場合は、前回選択した作業員を自動入力する
  if (!state.isShiftActive) restoreLastOperators();
  // 就業中（始業済み・終業前）の復元。設備も始業時のものに戻す
  restoreWorkSession();
  updateEquipmentLock();
  updateDefectUI();
  // 終業の押し忘れ確認（定時終業＋設定時間を過ぎても終業が未記録の場合）
  checkForgottenSession();

  lastTickTime = Date.now();
  setInterval(updateClock, 1000);
  setInterval(onTimerTick, 1000);
  renderHistoryTable();
  updateCloudStatusChip();
  updateSyncBadge();

  setInterval(() => retryPendingSync(false), CONFIG.SYNC_RETRY_INTERVAL_MS);
  setInterval(() => fetchMastersFromCloud(false), CONFIG.MASTER_AUTO_REFRESH_MS);
  window.addEventListener('online', () => { retryPendingSync(false); fetchMastersFromCloud(false); });

  // 起動時にバックグラウンドで最新マスタを取得（失敗してもキャッシュで動作継続）
  fetchMastersFromCloud(false);
};

/* =========================================================
   設定（ローカル永続化）
   ========================================================= */
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE.SETTINGS);
    if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function persistSettings() {
  localStorage.setItem(STORAGE.SETTINGS, JSON.stringify(settings));
  updateCloudStatusChip();
}

function applySettingsToUI() {
  reportEmailInput.value = settings.defaultEmail || '';
}

/* ---- マスタデータ（品番・作業員）のローカルキャッシュ ---- */
function loadMasters() {
  try {
    const raw = localStorage.getItem(STORAGE.MASTERS);
    if (raw) return Object.assign({}, DEFAULT_MASTERS, JSON.parse(raw));
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_MASTERS));
}
function persistMasters() {
  localStorage.setItem(STORAGE.MASTERS, JSON.stringify(masters));
}

/* =========================================================
   部品番号（入力欄＋予測変換）
   ・工程名が「プレス」の品番のみを候補にする（工程名の列が無い／空欄の品番は対象外にしない）
   ・選択中の設備が「充当機」に含まれる品番に絞り込む（充当機が空欄の品番は全設備で表示）
   ・絞り込みの結果が0件になる場合は、設備名の表記ゆれ等が原因の可能性があるため
     プレス工程の全品番を表示し、注意文を出す
   ========================================================= */
function normalizeKey(str) {
  return String(str ?? '').replace(/[\s　]/g, '').toLowerCase();
}
function splitMachines(str) {
  return String(str ?? '').split(/[,、，\/／・;；\n]+/).map(x => x.trim()).filter(x => x);
}
function machineMatchesEquipment(machineStr, equipment) {
  const eq = normalizeKey(equipment);
  if (!eq) return true;
  return splitMachines(machineStr).some(m => {
    const k = normalizeKey(m);
    return k === eq || k.includes(eq) || eq.includes(k);
  });
}
function getFilteredParts() {
  const all = masters.partMasters || [];
  const procKey = normalizeKey(CONFIG.PART_PROCESS_FILTER);
  const byProcess = all.filter(p => !p.process || normalizeKey(p.process).includes(procKey));
  const eq = currentEquipmentName();
  const byMachine = byProcess.filter(p => !p.machine || machineMatchesEquipment(p.machine, eq));
  if (byMachine.length === 0 && byProcess.length > 0) {
    return { list: byProcess, note: `「${eq}」に充当された品番が見つからないため、${CONFIG.PART_PROCESS_FILTER}工程の全品番を表示しています` };
  }
  return { list: byMachine, note: '' };
}

function renderPartOptions() {
  const all = masters.partMasters || [];
  if (all.length === 0) {
    partDatalist.innerHTML = '';
    partNoSelect.placeholder = '品番マスタ未取得（手入力可）';
    partHintEl.innerText = '';
    return;
  }
  const { list, note } = getFilteredParts();
  partNoSelect.placeholder = '品番を入力';
  partDatalist.innerHTML = list.map(p => `<option value="${escapeHtml(p.part)}" label="SPM ${escapeHtml(String(p.spm))}"></option>`).join('');
  partHintEl.innerText = note;
  partHintEl.className = 'text-[10px] mt-1 leading-tight truncate ' + (note ? 'text-amber-400' : 'text-slate-500');
  validatePartInput();
}

// 入力中／確定時：マスタと一致すればSPMを反映、一致しなければ警告枠（保存は可能・SPMは手入力）
function onPartInput() {
  const val = partNoSelect.value.trim();
  state.partNo = val;
  const matched = (masters.partMasters || []).find(p => p.part === val);
  if (matched) {
    state.settingSPM = matched.spm;
    spmSettingInput.value = Number(matched.spm).toFixed(1);
    updateCalculations();
  }
  validatePartInput();
}

function validatePartInput() {
  const val = partNoSelect.value.trim();
  const known = (masters.partMasters || []).some(p => p.part === val);
  const warn = val && (masters.partMasters || []).length > 0 && !known;
  partNoSelect.classList.toggle('border-rose-500', !!warn);
  partNoSelect.classList.toggle('ring-2', !!warn);
  partNoSelect.classList.toggle('ring-rose-500/40', !!warn);
}

function renderMasterStatus() {
  const el = document.getElementById('settings-master-status');
  if (!el) return;
  if (!masters.lastSyncedAt) {
    el.innerText = '未取得（クラウド未同期）';
    el.className = 'text-[10px] text-amber-400';
  } else {
    const d = new Date(masters.lastSyncedAt);
    el.innerText = `最終更新: ${d.toLocaleString('ja-JP')}（品番${masters.partMasters.length}件／作業員${masters.operators.length}名／停止理由${(masters.stopReasons || []).length}件）`;
    el.className = 'text-[10px] text-slate-500';
  }
}

// 設備名の一覧。クラウドの「設備マスタ」を使い、未取得（空）の間だけ端末の予備リストを使う。
// 製造中・就業中の設備がマスタから消えていても、その間は選択肢に残す（途中で設備名が変わらないように）。
function getEquipmentList() {
  const list = (Array.isArray(masters.equipments) && masters.equipments.length > 0)
    ? masters.equipments.slice() : settings.equipmentList.slice();
  const inUse = (state.isShiftActive || (typeof workSession !== 'undefined' && workSession)) ? equipmentSelect.value : '';
  if (inUse && !list.includes(inUse)) list.unshift(inUse);
  return list;
}

function renderEquipmentOptions() {
  const current = equipmentSelect.value;
  const list = getEquipmentList();
  const html = list.map(eq => `<option value="${escapeHtml(eq)}">${escapeHtml(eq)}</option>`).join('');
  equipmentSelect.innerHTML = html;
  equipmentSelectMonitor.innerHTML = html;
  const next = list.includes(current) ? current : (list[0] || '');
  equipmentSelect.value = next;
  equipmentSelectMonitor.value = next;
}

function currentEquipmentName() {
  return equipmentSelect.value || getEquipmentList()[0] || '';
}

// 設備を切り替える（モニター画面・日報画面の両方に反映し、部品番号の候補も絞り込み直す）
function setEquipment(value, silent) {
  if (!getEquipmentList().includes(value)) return;
  equipmentSelect.value = value;
  equipmentSelectMonitor.value = value;
  try { localStorage.setItem('pm_last_equipment_v1', value); } catch (e) {}
  renderPartOptions();
  persistShiftState();
  if (!silent) showToast(`設備を「${value}」に切り替えました`);
}

// 製造中・就業中（始業〜終業の間）は設備の切り替えを禁止する（日報の設備名が途中で変わるのを防ぐため）
function updateEquipmentLock() {
  const locked = !!state.isShiftActive || !!workSession;
  const msg = state.isShiftActive
    ? '製造中は設備を切り替えられません（製造終了またはクリア後に変更できます）'
    : '就業中は設備を切り替えられません（終業後に変更できます）';
  [equipmentSelect, equipmentSelectMonitor].forEach(sel => {
    sel.disabled = locked;
    sel.title = locked ? msg : '設備の切り替え';
    sel.classList.toggle('opacity-50', locked);
  });
}

/* ---- 設定モーダル ---- */
function openSettingsModal() {
  document.getElementById('settings-gas-url').value = settings.gasUrl || '';
  document.getElementById('settings-default-email').value = settings.defaultEmail || '';
  document.getElementById('settings-gas-test-result').innerText = '';
  renderMasterStatus();
  renderSettingsEquipmentList();
  showModal('settings-modal');
}
function closeSettingsModal() { hideModal('settings-modal'); }

// 設備名はクラウドの「設備マスタ」で管理するため、設定画面では一覧の表示のみ
function renderSettingsEquipmentList() {
  const box = document.getElementById('settings-equipment-list');
  box.innerHTML = getEquipmentList().map(eq =>
    `<div class="bg-black/30 border border-line rounded-lg px-2.5 py-1.5 text-xs text-slate-200">${escapeHtml(eq)}</div>`
  ).join('') || '<p class="text-[10px] text-slate-500">設備が登録されていません</p>';
}

function saveSettings() {
  settings.gasUrl = document.getElementById('settings-gas-url').value.trim();
  settings.defaultEmail = document.getElementById('settings-default-email').value.trim();
  persistSettings();
  applySettingsToUI();
  renderEquipmentOptions();
  renderPartOptions();
  closeSettingsModal();
  showToast('設定を保存しました');
  retryPendingSync(false);
}

/* =========================================================
   作業員（クラウドマスタから選択）
   ========================================================= */
function renderOperatorDatalist() {
  // マスタ更新後、既存の入力を再チェックし、選択画面が開いていれば一覧も更新する
  opSlotInputs.forEach(input => validateOperatorSlot(input));
  if (pickerSlotIndex !== null) renderOperatorPickerList();
}

/* ---- 作業員の選択（ボタン一覧）---- */
let pickerSlotIndex = null;

function openOperatorPicker(idx) {
  pickerSlotIndex = idx;
  document.getElementById('operator-picker-title').innerText = `作業員${idx + 1}を選択`;
  document.getElementById('operator-picker-manual').classList.add('hidden');
  document.getElementById('operator-picker-manual-input').value = '';
  renderOperatorPickerList();
  showModal('operator-picker-modal');
}

function renderOperatorPickerList() {
  const box = document.getElementById('operator-picker-list');
  const names = masters.operators || [];
  const current = opSlotInputs[pickerSlotIndex].value.trim();
  const usedElsewhere = new Set(opSlotInputs.map((i, k) => k === pickerSlotIndex ? '' : i.value.trim()).filter(n => n));
  if (names.length === 0) {
    box.innerHTML = '<p class="col-span-full text-xs text-slate-500 p-3">作業員マスタが未取得です。「その他（手入力）」で入力するか、マスタを再取得してください。</p>';
    return;
  }
  box.innerHTML = names.map(name => {
    const isCurrent = name === current;
    const isUsed = usedElsewhere.has(name);
    const cls = isCurrent
      ? 'border-emerald-400 bg-emerald-900/50 text-white'
      : (isUsed ? 'border-line bg-black/30 text-slate-600 pointer-events-none' : 'border-line bg-panel2 text-slate-100 hover:bg-slate-700');
    return `<button type="button" data-name="${escapeHtml(name)}" onclick="selectOperatorFromPicker(this.dataset.name)" class="${cls} border-2 rounded-xl py-3 px-2 text-sm font-bold active:scale-95 transition-all truncate">${escapeHtml(name)}${isUsed ? '<span class="block text-[9px] font-normal">選択済み</span>' : ''}</button>`;
  }).join('');
}

function setOperatorSlotValue(idx, value) {
  const input = opSlotInputs[idx];
  input.value = value;
  clearOperatorSlotWarning(input);
  validateOperatorSlot(input);
  persistLastOperators();
  persistShiftState();
}

function selectOperatorFromPicker(name) {
  if (pickerSlotIndex === null) return;
  setOperatorSlotValue(pickerSlotIndex, name);
  closeOperatorPicker();
}

function clearOperatorSlot() {
  if (pickerSlotIndex === null) return;
  setOperatorSlotValue(pickerSlotIndex, '');
  closeOperatorPicker();
}

function toggleManualOperatorInput() {
  const box = document.getElementById('operator-picker-manual');
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) {
    const input = document.getElementById('operator-picker-manual-input');
    input.value = '';
    input.focus(); // 手入力を選んだときだけキーボードを出す
  }
}

function applyManualOperator() {
  if (pickerSlotIndex === null) return;
  const val = document.getElementById('operator-picker-manual-input').value.trim();
  if (!val) { showToast('名前を入力してください', true); return; }
  setOperatorSlotValue(pickerSlotIndex, val);
  closeOperatorPicker();
}

function closeOperatorPicker() {
  pickerSlotIndex = null;
  hideModal('operator-picker-modal');
}

/* ---- 前回選択した作業員の保持（メールアドレスと同様に端末へ保存）---- */
function persistLastOperators() {
  try { localStorage.setItem(STORAGE.LAST_OPERATORS, JSON.stringify(opSlotInputs.map(i => i.value.trim()))); } catch (e) {}
}
function restoreLastOperators() {
  try {
    const raw = localStorage.getItem(STORAGE.LAST_OPERATORS);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    opSlotInputs.forEach((input, idx) => { input.value = arr[idx] || ''; validateOperatorSlot(input); });
  } catch (e) {}
}

/* ---------- 停止理由カテゴリ（マスタ由来） ---------- */
function renderStopReasonOptions() {
  const list = (masters.stopReasons && masters.stopReasons.length) ? masters.stopReasons : ['その他'];
  const optionsHtml = list.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');
  const abnormalSel = document.getElementById('abnormal-stop-category');
  if (abnormalSel) { const cur = abnormalSel.value; abnormalSel.innerHTML = optionsHtml; if (list.includes(cur)) abnormalSel.value = cur; }
}
function clearOperatorSlotWarning(input) {
  input.classList.remove('border-rose-500', 'ring-2', 'ring-rose-500/40');
}
function validateOperatorSlot(input) {
  const val = input.value.trim();
  if (!val) { clearOperatorSlotWarning(input); return; }
  const isMatch = (masters.operators || []).includes(val);
  if (isMatch) clearOperatorSlotWarning(input);
  else { input.classList.add('border-rose-500', 'ring-2', 'ring-rose-500/40'); }
}
function getSelectedOperatorsText() {
  const names = opSlotInputs.map(i => i.value.trim()).filter(n => n);
  return names.length ? names.join('・') : '未選択';
}
function getSelectedOperatorsCount() {
  return opSlotInputs.filter(i => i.value.trim()).length;
}
function clearOperatorSlots() {
  opSlotInputs.forEach(i => { i.value = ''; clearOperatorSlotWarning(i); });
  persistLastOperators();
}

/* =========================================================
   タイマー / 計算
   ========================================================= */
function updateClock() {
  document.getElementById('live-time').innerText = new Date().toTimeString().split(' ')[0];
}

function onTimerTick() {
  const now = Date.now();
  if (!lastTickTime) lastTickTime = now;
  const deltaSec = (now - lastTickTime) / 1000;
  lastTickTime = now;
  if (!state.isShiftActive) return;

  if (state.status === 'RUNNING') {
    state.runningSeconds += deltaSec;
    state.accumulatedCount += (state.settingSPM / 60) * deltaSec;
  } else if (state.status === 'MOLD') {
    state.moldSeconds += deltaSec;
  } else if (state.status === 'BREAK') {
    state.breakSeconds += deltaSec;
  } else if (state.status === 'STOP') {
    state.stopSeconds += deltaSec;
  }

  updateCalculations();
  clockEl.innerText = formatTime(Math.floor(state.runningSeconds));
  countEl.innerText = Math.floor(state.accumulatedCount).toLocaleString();
  timeMoldEl.innerText = formatTime(Math.floor(state.moldSeconds));
  timeBreakEl.innerText = formatTime(Math.floor(state.breakSeconds));
  timeStopEl.innerText = formatTime(Math.floor(state.stopSeconds));
  persistShiftState();
}

function updateCalculations() {
  if (state.settingSPM <= 0) return;
  const activeWorkSec = state.runningSeconds + state.moldSeconds + state.stopSeconds;
  if (activeWorkSec === 0) { rateEl.innerText = '100.0'; rateEl.style.color = '#10b981'; return; }
  const stdCT = 60 / state.settingSPM;
  let rate = ((stdCT * state.accumulatedCount) / activeWorkSec) * 100;
  rate = Math.min(rate, 200.0);
  rateEl.innerText = rate.toFixed(1);
  rateEl.style.color = rate >= CONFIG.PERFORMANCE_GOOD_LIMIT ? '#10b981' : (rate >= CONFIG.PERFORMANCE_NORMAL_LIMIT ? '#f2a93c' : '#f0556a');
}

/* =========================================================
   ステータス制御
   ※ btn-RUNNING の見た目切り替えは classList の個別操作のみで行う。
     className をまるごと書き換えると pointer-events-none が
     誤って残り、ボタンが反応しなくなる不具合の原因になるため禁止。
   ========================================================= */
function setStatus(newStatus) {
  const prevStatus = state.status;
  document.querySelectorAll('.modebtn').forEach(b => b.classList.remove('is-on'));
  statusChip.className = 'status-chip';

  if (state.status === 'RUNNING' && newStatus === 'RUNNING') {
    state.status = 'IDLE';
    statusChip.innerText = '一時停止中';
    statusChip.classList.add('st-IDLE');
    clockSub.innerText = '一時停止中';
    runBtn.classList.remove('mb-pause');
    runBtn.classList.add('mb-running', 'is-on');
    runIcon.className = 'fa-solid fa-circle-play text-3xl sm:text-4xl';
    runText.innerText = '稼働再開';
    persistShiftState();
    return;
  }

  if (state.status === newStatus) {
    state.status = 'IDLE';
    statusChip.innerText = '待機中';
    statusChip.classList.add('st-IDLE');
    clockSub.innerText = '停止中';
    resetRunButton('稼働再開');
  } else {
    state.status = newStatus;
    document.getElementById('btn-' + newStatus).classList.add('is-on');
    const labels = { RUNNING: '生産中', MOLD: '金型交換中', BREAK: '計画停止中', STOP: '異常停止中' };
    statusChip.innerText = labels[newStatus];
    statusChip.classList.add('st-' + newStatus);

    if (newStatus === 'RUNNING') {
      clockSub.innerText = '稼働中';
      runBtn.classList.remove('mb-running');
      runBtn.classList.add('mb-pause', 'is-on');
      runIcon.className = 'fa-solid fa-circle-pause text-3xl sm:text-4xl';
      runText.innerText = '一時停止';
    } else {
      clockSub.innerText = '非稼働（間接作業）';
      resetRunButton('稼働再開');
    }
  }

  // 異常停止の開始／終了を検知し、イベント単位で記録する（復元処理中は発火させない）
  if (!isRestoringShiftState) {
    if (prevStatus === 'STOP' && state.status !== 'STOP') {
      closeOpenAbnormalStopEvent(new Date());
    }
    if (prevStatus !== 'STOP' && state.status === 'STOP') {
      openNewAbnormalStopEvent();
    }
  }

  persistShiftState();
}

function resetRunButton(label = '稼働中') {
  runBtn.classList.remove('mb-pause', 'is-on');
  runBtn.classList.add('mb-running');
  runIcon.className = 'fa-solid fa-circle-play text-3xl sm:text-4xl';
  runText.innerText = label;
}

/* =========================================================
   異常停止のイベント管理
   「異常停止」ボタンを押すたびに新しい1件のイベントとして記録する。
   ボタン押下と同時にタイマーの計測は開始し、理由の入力は任意（あとで可）。
   別の状態（稼働中／金型交換／計画停止）に切り替えた時点、または
   製造終了時点で、そのイベントの終了時刻を確定する。
   ========================================================= */
function openNewAbnormalStopEvent() {
  state.openAbnormalStopEvent = { start: new Date(), category: '', detail: '', defects: 0 };
  openAbnormalStopModal();
}

function closeOpenAbnormalStopEvent(endTime) {
  if (!state.openAbnormalStopEvent) return;
  const ev = state.openAbnormalStopEvent;
  const end = endTime || new Date();
  state.abnormalStopEvents.push({
    start: ev.start.toTimeString().split(' ')[0],
    end: end.toTimeString().split(' ')[0],
    category: ev.category || '未入力',
    detail: ev.detail || '',
    defects: ev.defects || 0,
  });
  state.openAbnormalStopEvent = null;
}

function openAbnormalStopModal() {
  renderStopReasonOptions();
  const catSel = document.getElementById('abnormal-stop-category');
  if (catSel) catSel.selectedIndex = 0;
  document.getElementById('abnormal-stop-detail').value = '';
  document.getElementById('abnormal-stop-defect').value = 0;
  const timeLabel = state.openAbnormalStopEvent ? state.openAbnormalStopEvent.start.toTimeString().split(' ')[0] : '--:--:--';
  document.getElementById('abnormal-stop-time').innerText = timeLabel;
  showModal('abnormal-stop-modal');
}

function skipAbnormalStopReason() {
  hideModal('abnormal-stop-modal');
  showToast('停止理由の入力をスキップしました（あとで内容を確認・補足できます）');
}

function saveAbnormalStopReason() {
  if (state.openAbnormalStopEvent) {
    const catSel = document.getElementById('abnormal-stop-category');
    state.openAbnormalStopEvent.category = catSel ? catSel.value : '';
    state.openAbnormalStopEvent.detail = document.getElementById('abnormal-stop-detail').value.trim();
    // 異常停止時に入力した不良数は、モニターの不良数（合計）へ加算する
    const newDefects = Math.max(0, parseInt(document.getElementById('abnormal-stop-defect').value) || 0);
    const delta = newDefects - (state.openAbnormalStopEvent.defects || 0);
    state.openAbnormalStopEvent.defects = newDefects;
    state.defectCount = Math.max(0, state.defectCount + delta);
    updateDefectUI();
    persistShiftState();
  }
  hideModal('abnormal-stop-modal');
  showToast('異常停止の内容を記録しました');
}

function adjustAbnormalDefect(delta) {
  const el = document.getElementById('abnormal-stop-defect');
  el.value = Math.max(0, (parseInt(el.value) || 0) + delta);
}

/* =========================================================
   不良数カウンター（モニター画面）
   ・＋／－で増減（0未満にはならない）
   ・異常停止時に入力した不良数もこの合計へ加算される
   ・最終値は製造終了の確認画面で修正できる
   ========================================================= */
function adjustDefect(delta) {
  if (!state.isShiftActive) { showToast('製造中のみ記録できます', true); return; }
  state.defectCount = Math.max(0, state.defectCount + delta);
  updateDefectUI();
  persistShiftState();
}

function sumAbnormalDefects() {
  const closed = state.abnormalStopEvents.reduce((sum, ev) => sum + (ev.defects || 0), 0);
  return closed + (state.openAbnormalStopEvent ? (state.openAbnormalStopEvent.defects || 0) : 0);
}

function updateDefectUI() {
  if (defectCountEl) defectCountEl.innerText = state.defectCount.toLocaleString();
  const bd = document.getElementById('defect-breakdown');
  if (bd) {
    const fromStops = sumAbnormalDefects();
    bd.innerText = fromStops > 0 ? `うち異常停止時 ${fromStops}` : '';
  }
}

/* =========================================================
   製造中データの永続化（ブラウザ更新対策）
   ・製造中は state を継続的に localStorage へ保存する
   ・ページ読み込み時に復元する（製造中のまま更新された場合のみ）
   ・データが消えるのは「クリア」ボタン、または製造終了の保存が
     完了した時（＝executeResetSilently実行時）のみ
   ========================================================= */
let isRestoringShiftState = false;

function persistShiftState() {
  if (!state.isShiftActive) return;
  try {
    const snapshot = {
      isShiftActive: state.isShiftActive,
      status: state.status,
      startTime: state.startTime ? state.startTime.toISOString() : null,
      endTime: state.endTime ? state.endTime.toISOString() : null,
      runningSeconds: state.runningSeconds,
      moldSeconds: state.moldSeconds,
      breakSeconds: state.breakSeconds,
      stopSeconds: state.stopSeconds,
      accumulatedCount: state.accumulatedCount,
      settingSPM: state.settingSPM,
      targetCount: state.targetCount,
      partNo: state.partNo,
      segments: state.segments,
      segmentBaseline: state.segmentBaseline,
      segmentStartTime: state.segmentStartTime ? state.segmentStartTime.toISOString() : null,
      abnormalStopEvents: state.abnormalStopEvents,
      openAbnormalStopEvent: state.openAbnormalStopEvent ? {
        start: state.openAbnormalStopEvent.start.toISOString(),
        category: state.openAbnormalStopEvent.category || '',
        detail: state.openAbnormalStopEvent.detail || '',
        defects: state.openAbnormalStopEvent.defects || 0,
      } : null,
      defectCount: state.defectCount,
      operatorSlots: opSlotInputs.map(i => i.value),
      equipment: equipmentSelect.value,
    };
    localStorage.setItem(STORAGE.SHIFT_STATE, JSON.stringify(snapshot));
  } catch (e) {}
}

function clearPersistedShiftState() {
  try { localStorage.removeItem(STORAGE.SHIFT_STATE); } catch (e) {}
}

function restoreShiftState() {
  let snap = null;
  try {
    const raw = localStorage.getItem(STORAGE.SHIFT_STATE);
    if (raw) snap = JSON.parse(raw);
  } catch (e) {}
  if (!snap || !snap.isShiftActive) return;

  state.isShiftActive = true;
  state.startTime = snap.startTime ? new Date(snap.startTime) : new Date();
  state.endTime = null;
  state.runningSeconds = snap.runningSeconds || 0;
  state.moldSeconds = snap.moldSeconds || 0;
  state.breakSeconds = snap.breakSeconds || 0;
  state.stopSeconds = snap.stopSeconds || 0;
  state.accumulatedCount = snap.accumulatedCount || 0;
  state.settingSPM = snap.settingSPM || state.settingSPM;
  state.targetCount = snap.targetCount || state.targetCount;
  state.partNo = snap.partNo || '';
  state.segments = Array.isArray(snap.segments) ? snap.segments : [];
  state.segmentBaseline = snap.segmentBaseline || { runningSeconds: 0, moldSeconds: 0, breakSeconds: 0, stopSeconds: 0, accumulatedCount: 0 };
  state.segmentStartTime = snap.segmentStartTime ? new Date(snap.segmentStartTime) : state.startTime;
  state.abnormalStopEvents = Array.isArray(snap.abnormalStopEvents) ? snap.abnormalStopEvents : [];
  state.openAbnormalStopEvent = snap.openAbnormalStopEvent ? {
    start: new Date(snap.openAbnormalStopEvent.start),
    category: snap.openAbnormalStopEvent.category || '',
    detail: snap.openAbnormalStopEvent.detail || '',
    defects: snap.openAbnormalStopEvent.defects || 0,
  } : null;
  state.defectCount = Math.max(0, parseInt(snap.defectCount) || 0);

  if (snap.equipment && getEquipmentList().includes(snap.equipment)) setEquipment(snap.equipment, true);
  if (Array.isArray(snap.operatorSlots)) {
    opSlotInputs.forEach((input, idx) => { input.value = snap.operatorSlots[idx] || ''; validateOperatorSlot(input); });
  }
  if (state.partNo) { partNoSelect.value = state.partNo; validatePartInput(); }
  spmSettingInput.value = Number(state.settingSPM).toFixed(1);
  targetInput.value = state.targetCount;
  targetDisplayVal.innerText = state.targetCount.toLocaleString();

  timeStartLabel.innerText = state.startTime.toTimeString().split(' ')[0];
  timeEndLabel.innerText = '製造中…';
  btnStartShift.classList.add('opacity-50', 'pointer-events-none');
  btnEndShift.classList.remove('opacity-50', 'pointer-events-none');
  document.querySelectorAll('.modebtn').forEach(b => b.classList.remove('pointer-events-none'));
  document.getElementById('btn-record-segment').classList.remove('pointer-events-none', 'opacity-50');
  updateSegmentStatusLabel();

  // setStatus内の異常停止イベント自動生成フックは、復元時には動かさない
  // （すでに snap.openAbnormalStopEvent / abnormalStopEvents として復元済みのため）
  const restoredStatus = snap.status || 'IDLE';
  state.status = 'IDLE';
  isRestoringShiftState = true;
  setStatus(restoredStatus);
  isRestoringShiftState = false;

  clockEl.innerText = formatTime(Math.floor(state.runningSeconds));
  countEl.innerText = Math.floor(state.accumulatedCount).toLocaleString();
  timeMoldEl.innerText = formatTime(Math.floor(state.moldSeconds));
  timeBreakEl.innerText = formatTime(Math.floor(state.breakSeconds));
  timeStopEl.innerText = formatTime(Math.floor(state.stopSeconds));
  updateCalculations();
  updateDefectUI();
  updateEquipmentLock();

  showToast('前回作業中のデータを復元しました（ブラウザ更新対策）');
}

/* =========================================================
   製造開始 / 終了
   ========================================================= */
function startMfg(skipSessionPrompt) {
  if (state.isShiftActive) return;
  // 始業が未記録なら、先に「始業を記録しますか？」を確認する
  if (skipSessionPrompt !== true && !workSession) { openSessionPrompt(); return; }
  state.isShiftActive = true;
  state.startTime = new Date();
  lastTickTime = Date.now();

  timeStartLabel.innerText = state.startTime.toTimeString().split(' ')[0];
  timeEndLabel.innerText = '製造中…';
  btnStartShift.classList.add('opacity-50', 'pointer-events-none');
  btnEndShift.classList.remove('opacity-50', 'pointer-events-none');

  document.querySelectorAll('.modebtn').forEach(b => b.classList.remove('pointer-events-none'));

  setStatus('IDLE');
  clockSub.innerText = '稼働開始ボタンを押してください';

  state.segments = [];
  state.segmentBaseline = { runningSeconds: 0, moldSeconds: 0, breakSeconds: 0, stopSeconds: 0, accumulatedCount: 0 };
  state.segmentStartTime = state.startTime;
  state.abnormalStopEvents = [];
  state.openAbnormalStopEvent = null;
  state.defectCount = 0;
  document.getElementById('btn-record-segment').classList.remove('pointer-events-none', 'opacity-50');
  updateSegmentStatusLabel();
  updateDefectUI();
  updateEquipmentLock();
  persistShiftState();

  showToast(partNoSelect.value.trim() ? '製造を開始しました' : '製造を開始しました（部品番号が未入力です）');
}

function openEndShiftModal() {
  if (!state.isShiftActive) return;
  document.getElementById('modal-end-time').innerText = new Date().toTimeString().split(' ')[0];
  document.getElementById('modal-actual-count').value = Math.floor(state.accumulatedCount);
  document.getElementById('modal-material-count').value = 0;
  document.getElementById('modal-scrap-count').value = 0;
  document.getElementById('modal-defect-count').value = state.defectCount;
  const fromStops = sumAbnormalDefects();
  document.getElementById('modal-defect-note').innerText = fromStops > 0 ? `うち異常停止時の入力 ${fromStops}pcs（合計に含む）` : 'モニターの不良数を基に修正可能';
  const abnormalCount = state.abnormalStopEvents.length + (state.openAbnormalStopEvent ? 1 : 0);
  document.getElementById('modal-abnormal-count').innerText = abnormalCount;
  const workerText = getSelectedOperatorsText();
  const workerCount = getSelectedOperatorsCount();
  document.getElementById('modal-worker-preview').innerText = `${workerText}（${workerCount}名）`;
  showModal('end-shift-modal');
}
function closeEndShiftModal() { hideModal('end-shift-modal'); }

function confirmEndMfg() {
  state.endTime = new Date();
  const actualCount = parseInt(document.getElementById('modal-actual-count').value) || 0;
  const materialCount = parseInt(document.getElementById('modal-material-count').value) || 0;
  const scrapCount = parseInt(document.getElementById('modal-scrap-count').value) || 0;
  const defectCount = Math.max(0, parseInt(document.getElementById('modal-defect-count').value) || 0);
  if (defectCount > actualCount) {
    showToast('不良数が生産数（不良品を含む）を超えています。ご確認ください', true);
    return;
  }

  // 製造終了時点でまだ進行中の異常停止イベントがあれば、終了時刻で確定する
  if (state.openAbnormalStopEvent) {
    closeOpenAbnormalStopEvent(state.endTime);
  }

  closeEndShiftModal();
  saveCurrentToHistory(actualCount, materialCount, scrapCount, defectCount);
  noteMfgEndForSession(state.endTime); // 押し忘れ補正の初期値（就業中の最後の製造終了）に使う
  executeResetSilently();
}

function executeResetSilently() {
  clearPersistedShiftState();
  state.status = 'IDLE';
  state.isShiftActive = false;
  state.startTime = null;
  state.endTime = null;
  state.runningSeconds = 0;
  state.moldSeconds = 0;
  state.breakSeconds = 0;
  state.stopSeconds = 0;
  state.accumulatedCount = 0;
  state.defectCount = 0;
  // 作業員は前回値として保持する（クリアしない）
  state.segments = [];
  state.segmentBaseline = { runningSeconds: 0, moldSeconds: 0, breakSeconds: 0, stopSeconds: 0, accumulatedCount: 0 };
  state.segmentStartTime = null;
  state.abnormalStopEvents = [];
  state.openAbnormalStopEvent = null;
  document.getElementById('btn-record-segment').classList.add('pointer-events-none', 'opacity-50');
  document.getElementById('segment-status').innerText = '';

  document.querySelectorAll('.modebtn').forEach(b => { b.classList.remove('is-on'); b.classList.add('pointer-events-none'); });
  statusChip.className = 'status-chip st-IDLE';
  statusChip.innerText = '待機中';
  clockSub.innerText = '製造開始ボタンを押してください';
  timeStartLabel.innerText = '未記録';
  timeEndLabel.innerText = '未記録';
  clockEl.innerText = '00:00:00';
  countEl.innerText = '0';
  timeMoldEl.innerText = '00:00:00';
  timeBreakEl.innerText = '00:00:00';
  timeStopEl.innerText = '00:00:00';
  rateEl.innerText = '100.0';
  rateEl.style.color = '#10b981';
  btnStartShift.classList.remove('opacity-50', 'pointer-events-none');
  btnEndShift.classList.add('opacity-50', 'pointer-events-none');
  resetRunButton('稼働中');
  updateDefectUI();
  updateEquipmentLock();
}

function openResetModal() { showModal('reset-modal'); }
function closeResetModal() { hideModal('reset-modal'); }
function confirmReset() { closeResetModal(); executeResetSilently(); showToast('本日の稼働データをリセットしました'); }

/* =========================================================
   人数変更の区間管理
   「人数変更を記録」ボタンが押されるたびに、それまでの区間を1件として確定し、
   そこから新しい区間の集計を始める。ボタンを一度も押さない場合は、
   シフト全体で1区間として扱われる（従来動作との互換性）。
   ========================================================= */
function buildSegmentFromBaseline(endTime) {
  const b = state.segmentBaseline;
  const runningSec = Math.max(0, Math.round(state.runningSeconds - b.runningSeconds));
  const moldSec = Math.max(0, Math.round(state.moldSeconds - b.moldSeconds));
  const breakSec = Math.max(0, Math.round(state.breakSeconds - b.breakSeconds));
  const stopSec = Math.max(0, Math.round(state.stopSeconds - b.stopSeconds));
  const count = Math.max(0, Math.round(state.accumulatedCount - b.accumulatedCount));
  const activeSec = runningSec + moldSec + stopSec;
  let perfRate = '100.0';
  if (activeSec > 0 && state.settingSPM > 0) {
    const stdCT = 60 / state.settingSPM;
    perfRate = Math.min((stdCT * count) / activeSec * 100, 200.0).toFixed(1);
  }
  return {
    start: state.segmentStartTime ? state.segmentStartTime.toTimeString().split(' ')[0] : '未記録',
    end: endTime.toTimeString().split(' ')[0],
    operator: getSelectedOperatorsText(),
    workerCount: getSelectedOperatorsCount(),
    partNo: state.partNo || (partNoSelect ? partNoSelect.value : '') || '未設定',
    runningSec, moldSec, breakSec, stopSec, count, perfRate,
  };
}

function recordSegmentChange() {
  if (!state.isShiftActive) { showToast('製造中のみ記録できます', true); return; }
  const now = new Date();
  const seg = buildSegmentFromBaseline(now);
  state.segments.push(seg);
  state.segmentBaseline = {
    runningSeconds: state.runningSeconds,
    moldSeconds: state.moldSeconds,
    breakSeconds: state.breakSeconds,
    stopSeconds: state.stopSeconds,
    accumulatedCount: state.accumulatedCount,
  };
  state.segmentStartTime = now;
  updateSegmentStatusLabel();
  persistShiftState();
  showToast(`区間を記録しました（${seg.start}〜${seg.end}／${seg.workerCount}名／稼働率${seg.perfRate}%）`);
}

function updateSegmentStatusLabel() {
  const el = document.getElementById('segment-status');
  if (!el) return;
  const doneCount = state.segments.length;
  const currentStart = state.segmentStartTime ? state.segmentStartTime.toTimeString().split(' ')[0] : '--:--:--';
  el.innerText = doneCount > 0
    ? `記録済み区間: ${doneCount}件／現在の区間: ${currentStart}〜`
    : `現在の区間: ${currentStart}〜`;
}


function saveCurrentToHistory(finalCount, materialCount, scrapCount, defectCount) {
  const today = new Date();
  const dateStr = today.getFullYear() + '/' + String(today.getMonth() + 1).padStart(2, '0') + '/' + String(today.getDate()).padStart(2, '0');
  const countValue = finalCount ?? Math.floor(state.accumulatedCount);
  const totalActiveSec = state.runningSeconds + state.moldSeconds + state.stopSeconds;

  let calculatedRate = '100.0';
  if (totalActiveSec > 0 && state.settingSPM > 0) {
    const stdCT = 60 / state.settingSPM;
    calculatedRate = Math.min(((stdCT * countValue) / totalActiveSec) * 100, 200.0).toFixed(1);
  }

  const record = {
    id: Date.now(),
    date: dateStr,
    // 就業時間との紐づけ。始業を記録していない場合は就業IDが空、勤務日は日報の日付と同じ
    sessionId: workSession ? workSession.id : '',
    workDate: workSession ? fmtDateSlash(new Date(workSession.start)) : dateStr,
    equipment: currentEquipmentName() || '未設定',
    operator: getSelectedOperatorsText(),
    workerCount: getSelectedOperatorsCount(),
    partNo: state.partNo || partNoSelect.value || '未設定',
    start: state.startTime ? state.startTime.toTimeString().split(' ')[0] : '未記録',
    end: state.endTime ? state.endTime.toTimeString().split(' ')[0] : '未記録',
    settingSPM: state.settingSPM.toFixed(1),
    count: countValue,
    materialCount: materialCount || 0,
    scrapCount: scrapCount || 0,
    defectCount: defectCount || 0, // 不良数（生産数は不良品を含む。良品数＝生産数−不良数）
    // 異常停止の詳細理由は「異常停止イベントデータ」側で管理する。
    // 日報データ側は分析用に件数のみを保持する（本文の重複を避けるため）。
    abnormalStopCount: state.abnormalStopEvents.length,
    abnormalStopEvents: [...state.abnormalStopEvents],
    runningSec: Math.floor(state.runningSeconds),
    moldSec: Math.floor(state.moldSeconds),
    breakSec: Math.floor(state.breakSeconds),
    stopSec: Math.floor(state.stopSeconds),
    perfRate: calculatedRate,
    syncStatus: 'pending',
    // 「人数変更を記録」で確定済みの区間 + シフト終了時点までの最終区間
    // ※ 区間ごとの生産数は自動集計ベース。上のcount（confirmEndMfgでの手動補正後の確定値）とは
    //   一致しない場合がある（最終区間のみ誤差が乗る想定）。
    segments: [...state.segments, buildSegmentFromBaseline(state.endTime || new Date())],
  };

  historyLogs.unshift(record);
  checkedRecordIds.add(record.id);
  persistHistory();
  renderHistoryTable();
  updateSyncBadge();
  showToast(`日報データ（${record.partNo}：生産数 ${countValue}pcs）を保存しました`);

  syncRecordToCloud(record);
}

function persistHistory() {
  try { localStorage.setItem(STORAGE.HISTORY, JSON.stringify(historyLogs)); } catch (e) {}
}

/* =========================================================
   選択・履歴テーブル
   ========================================================= */
function toggleSelectAll(master) {
  if (master.checked) historyLogs.forEach(r => checkedRecordIds.add(r.id));
  else checkedRecordIds.clear();
  renderHistoryTable();
}
function toggleRecordCheck(id, checkbox) {
  if (checkbox.checked) checkedRecordIds.add(id); else checkedRecordIds.delete(id);
  updateMasterCheckboxState();
}
function updateMasterCheckboxState() {
  const master = document.getElementById('check-all');
  if (master && historyLogs.length > 0) master.checked = checkedRecordIds.size === historyLogs.length;
}

function syncStatusIcon(rec) {
  if (rec.syncStatus === 'synced') return '<i class="fa-solid fa-cloud-check sync-ok" title="クラウド同期済み"></i>';
  if (rec.syncStatus === 'error') return '<i class="fa-solid fa-triangle-exclamation sync-err" title="送信エラー"></i>';
  return '<i class="fa-solid fa-clock sync-pending" title="同期待ち"></i>';
}

function renderHistoryTable() {
  const tbody = document.getElementById('history-body');
  if (historyLogs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="20" class="p-6 text-center text-slate-500 font-bold">保存された日報データはありません。</td></tr>';
    return;
  }
  tbody.innerHTML = historyLogs.map(rec => {
    const isChecked = checkedRecordIds.has(rec.id);
    const hasSegments = Array.isArray(rec.segments) && rec.segments.length > 1;
    const abnormalEvents = Array.isArray(rec.abnormalStopEvents) ? rec.abnormalStopEvents : [];
    const hasAbnormalEvents = abnormalEvents.length > 0;
    const hasDetail = hasSegments || hasAbnormalEvents;
    const toggleCell = hasDetail
      ? `<button onclick="toggleSegmentDetail(${rec.id})" id="seg-toggle-${rec.id}" class="text-emerald-400 hover:text-emerald-300 w-full text-center"><i class="fa-solid fa-caret-right"></i></button>`
      : `<span class="text-slate-700 block text-center">－</span>`;
    const mainRow = `
      <tr class="row-hover transition-all ${isChecked ? 'bg-white/5' : ''}">
        <td class="p-2 text-center" onclick="event.stopPropagation()"><input type="checkbox" value="${rec.id}" ${isChecked ? 'checked' : ''} onclick="toggleRecordCheck(${rec.id}, this)" class="w-4 h-4 rounded border-slate-700 bg-black text-emerald-500"></td>
        <td class="p-2 text-center" onclick="event.stopPropagation()">${toggleCell}</td>
        <td class="p-2 font-mono text-white">${rec.date}</td>
        <td class="p-2 font-mono text-amber-300 font-bold">${escapeHtml(rec.operator || '未選択')}</td>
        <td class="p-2 font-mono text-center text-amber-200 font-bold">${rec.workerCount || 1}名</td>
        <td class="p-2 font-mono text-emerald-400 font-bold">${escapeHtml(rec.partNo)}</td>
        <td class="p-2 font-mono text-slate-300">${rec.start}</td>
        <td class="p-2 font-mono text-slate-300">${rec.end}</td>
        <td class="p-2 font-mono font-bold text-white">${rec.count}</td>
        <td class="p-2 font-mono text-rose-300 font-bold">${rec.defectCount || 0}</td>
        <td class="p-2 font-mono text-amber-300 font-bold">${rec.materialCount || 0}</td>
        <td class="p-2 font-mono text-purple-300 font-bold">${rec.scrapCount || 0}</td>
        <td class="p-2 font-mono text-center text-rose-400 font-bold">${rec.abnormalStopCount != null ? rec.abnormalStopCount : abnormalEvents.length}件</td>
        <td class="p-2 font-mono">${formatTime(rec.runningSec)}</td>
        <td class="p-2 font-mono text-amber-400">${formatTime(rec.moldSec)}</td>
        <td class="p-2 font-mono text-sky-400">${formatTime(rec.breakSec)}</td>
        <td class="p-2 font-mono text-rose-500">${formatTime(rec.stopSec)}</td>
        <td class="p-2 font-mono font-bold text-emerald-400 text-right text-sm">${rec.perfRate}%</td>
        <td class="p-2 text-center text-sm">${syncStatusIcon(rec)}</td>
        <td class="p-2 text-center">
          <div class="flex justify-center gap-1.5" onclick="event.stopPropagation()">
            <button class="bg-amber-950/60 hover:bg-amber-900 text-amber-300 p-1.5 rounded active:scale-90" onclick="openEditRecordModal(${rec.id})" title="全項目修正"><i class="fa-solid fa-pen-to-square"></i></button>
            <button class="bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 p-1.5 rounded active:scale-90" onclick="openDeleteModal(${rec.id})" title="削除"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </td>
      </tr>`;
    const segmentTableHtml = hasSegments ? `
          <p class="text-[10px] font-black text-emerald-400 mb-1"><i class="fa-solid fa-people-group mr-1"></i>人数変更の区間内訳（${rec.segments.length}件）</p>
          <table class="w-full text-[11px] border-collapse mb-3">
            <thead><tr class="text-slate-500 border-b border-line">
              <th class="p-1 text-left">開始</th><th class="p-1 text-left">終了</th><th class="p-1 text-left">作業員</th>
              <th class="p-1 text-center">人数</th><th class="p-1 text-right">生産数</th><th class="p-1 text-right">性能稼働率</th>
            </tr></thead>
            <tbody>
              ${rec.segments.map(seg => `
                <tr class="border-b border-line/50">
                  <td class="p-1 font-mono">${seg.start}</td>
                  <td class="p-1 font-mono">${seg.end}</td>
                  <td class="p-1 font-mono text-amber-300">${escapeHtml(seg.operator || '未選択')}</td>
                  <td class="p-1 text-center font-mono text-amber-200">${seg.workerCount || 1}名</td>
                  <td class="p-1 text-right font-mono">${seg.count}</td>
                  <td class="p-1 text-right font-mono text-emerald-400 font-bold">${seg.perfRate}%</td>
                </tr>`).join('')}
            </tbody>
          </table>` : '';
    const abnormalTableHtml = hasAbnormalEvents ? `
          <p class="text-[10px] font-black text-rose-400 mb-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i>異常停止の内訳（${abnormalEvents.length}件）</p>
          <table class="w-full text-[11px] border-collapse">
            <thead><tr class="text-slate-500 border-b border-line">
              <th class="p-1 text-left">開始</th><th class="p-1 text-left">終了</th><th class="p-1 text-left">カテゴリ</th><th class="p-1 text-left">補足</th><th class="p-1 text-right">不良数</th>
            </tr></thead>
            <tbody>
              ${abnormalEvents.map(ev => `
                <tr class="border-b border-line/50">
                  <td class="p-1 font-mono">${ev.start || '未記録'}</td>
                  <td class="p-1 font-mono">${ev.end || '未記録'}</td>
                  <td class="p-1 text-rose-300">${escapeHtml(ev.category || '未入力')}</td>
                  <td class="p-1 text-slate-400">${escapeHtml(ev.detail || '')}</td>
                  <td class="p-1 text-right font-mono text-rose-300">${ev.defects || 0}</td>
                </tr>`).join('')}
            </tbody>
          </table>` : '';
    const detailRow = hasDetail ? `
      <tr class="hidden bg-black/40" id="seg-detail-${rec.id}">
        <td></td>
        <td colspan="19" class="p-2">
          ${segmentTableHtml}${abnormalTableHtml}
        </td>
      </tr>` : '';
    return mainRow + detailRow;
  }).join('');
  updateMasterCheckboxState();
}

function toggleSegmentDetail(id) {
  const row = document.getElementById('seg-detail-' + id);
  const icon = document.querySelector(`#seg-toggle-${id} i`);
  if (!row) return;
  row.classList.toggle('hidden');
  if (icon) icon.className = row.classList.contains('hidden') ? 'fa-solid fa-caret-right' : 'fa-solid fa-caret-down';
}

/* ---- 編集モーダル ---- */
function openEditRecordModal(id) {
  const rec = historyLogs.find(l => l.id === id);
  if (!rec) return;
  document.getElementById('edit-record-id').value = rec.id;
  document.getElementById('edit-date').value = rec.date || '';
  document.getElementById('edit-operator').value = rec.operator || '';
  document.getElementById('edit-partno').value = rec.partNo || '';
  document.getElementById('edit-count').value = rec.count || 0;
  document.getElementById('edit-material-count').value = rec.materialCount || 0;
  document.getElementById('edit-scrap-count').value = rec.scrapCount || 0;
  document.getElementById('edit-defect-count').value = rec.defectCount || 0;
  document.getElementById('edit-abnormal-count-info').innerText = rec.abnormalStopCount != null ? rec.abnormalStopCount : (Array.isArray(rec.abnormalStopEvents) ? rec.abnormalStopEvents.length : 0);
  document.getElementById('edit-spm').value = rec.settingSPM || 15.0;
  document.getElementById('edit-start').value = rec.start || '';
  document.getElementById('edit-end').value = rec.end || '';
  document.getElementById('edit-running-min').value = Math.round(rec.runningSec / 60);
  document.getElementById('edit-mold-min').value = Math.round(rec.moldSec / 60);
  document.getElementById('edit-break-min').value = Math.round(rec.breakSec / 60);
  document.getElementById('edit-stop-min').value = Math.round(rec.stopSec / 60);
  showModal('edit-record-modal');
}
function closeEditRecordModal() { hideModal('edit-record-modal'); }

function saveEditedRecord() {
  const id = parseInt(document.getElementById('edit-record-id').value);
  const rec = historyLogs.find(l => l.id === id);
  if (!rec) return;

  rec.date = document.getElementById('edit-date').value.trim() || rec.date;
  rec.operator = document.getElementById('edit-operator').value.trim() || '未登録';
  rec.partNo = document.getElementById('edit-partno').value.trim() || '未設定';
  rec.count = parseInt(document.getElementById('edit-count').value) || 0;
  rec.materialCount = parseInt(document.getElementById('edit-material-count').value) || 0;
  rec.scrapCount = parseInt(document.getElementById('edit-scrap-count').value) || 0;
  rec.defectCount = Math.max(0, parseInt(document.getElementById('edit-defect-count').value) || 0);
  // 異常停止の理由詳細はこのモーダルでは編集しない（履歴一覧の内訳表示のみ）
  rec.settingSPM = (parseFloat(document.getElementById('edit-spm').value) || 0.1).toFixed(1);
  rec.start = document.getElementById('edit-start').value.trim() || rec.start;
  rec.end = document.getElementById('edit-end').value.trim() || rec.end;
  rec.runningSec = (parseInt(document.getElementById('edit-running-min').value) || 0) * 60;
  rec.moldSec = (parseInt(document.getElementById('edit-mold-min').value) || 0) * 60;
  rec.breakSec = (parseInt(document.getElementById('edit-break-min').value) || 0) * 60;
  rec.stopSec = (parseInt(document.getElementById('edit-stop-min').value) || 0) * 60;

  const totalActiveSec = rec.runningSec + rec.moldSec + rec.stopSec;
  if (totalActiveSec > 0 && parseFloat(rec.settingSPM) > 0) {
    const stdCT = 60 / parseFloat(rec.settingSPM);
    rec.perfRate = Math.min((stdCT * rec.count) / totalActiveSec * 100, 200.0).toFixed(1);
  } else {
    rec.perfRate = '100.0';
  }

  rec.syncStatus = 'pending'; // 修正後は再同期が必要
  persistHistory();
  renderHistoryTable();
  updateSyncBadge();
  closeEditRecordModal();
  showToast('日報データを修正しました。クラウドへ再同期します');
  syncRecordToCloud(rec);
}

/* ---- 削除 ---- */
function openDeleteModal(id) { document.getElementById('delete-record-id').value = id; showModal('delete-confirm-modal'); }
function closeDeleteModal() { hideModal('delete-confirm-modal'); }
function confirmDeleteHistory() {
  const id = parseInt(document.getElementById('delete-record-id').value);
  historyLogs = historyLogs.filter(l => l.id !== id);
  checkedRecordIds.delete(id);
  persistHistory();
  renderHistoryTable();
  updateSyncBadge();
  closeDeleteModal();
  showToast('実績データを削除しました（クラウド側は残ります）');
}

/* =========================================================
   Excel生成（ローカルバックアップ用）
   ========================================================= */
function generateExcelWorkbook(selectedLogs, currentEquip) {
  const sheetData = [
    [`【${currentEquip}】 プレス生産作業日報`],
    [
      '出力日時: ' + new Date().toLocaleString('ja-JP'),
      '選択件数: ' + selectedLogs.length + '件',
      '総生産数: ' + selectedLogs.reduce((s, r) => s + r.count, 0) + ' pcs',
      '平均性能稼働率: ' + (selectedLogs.reduce((s, r) => s + parseFloat(r.perfRate), 0) / (selectedLogs.length || 1)).toFixed(1) + '%',
    ],
    ['日付', '設備名', '作業員', '作業人数', '部品番号', '製造開始', '製造終了', '生産数(pcs)', '不良数(pcs)', '材料交換(回)', 'スクラップ交換(回)', '異常停止件数', '実生産稼働時間', '金型交換時間', '計画停止時間', '異常停止時間', '性能稼働率(%)'],
  ];
  selectedLogs.forEach(rec => {
    sheetData.push([
      rec.date, rec.equipment || currentEquip, rec.operator || '未選択', rec.workerCount || 1, rec.partNo,
      rec.start, rec.end, rec.count, rec.defectCount || 0, rec.materialCount || 0, rec.scrapCount || 0,
      rec.abnormalStopCount != null ? rec.abnormalStopCount : (rec.abnormalStopEvents || []).length,
      formatTime(rec.runningSec), formatTime(rec.moldSec), formatTime(rec.breakSec), formatTime(rec.stopSec), parseFloat(rec.perfRate),
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  ws['!cols'] = [12,16,18,10,16,12,12,12,12,12,14,12,14,14,14,14,14].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '作業日報');

  // 区間内訳シート（人数変更を記録した内容。未使用の記録は1区間のみ＝シフト全体として出力される）
  const segSheetData = [
    ['作業員区間内訳（人数変更の記録単位）'],
    ['日付', '設備名', '部品番号', '区間開始', '区間終了', '作業員', '人数', '生産数(pcs)', '性能稼働率(%)'],
  ];
  selectedLogs.forEach(rec => {
    (rec.segments && rec.segments.length ? rec.segments : []).forEach(seg => {
      segSheetData.push([
        rec.date, rec.equipment || currentEquip, seg.partNo || rec.partNo, seg.start, seg.end,
        seg.operator || '未選択', seg.workerCount || 1, seg.count || 0, parseFloat(seg.perfRate) || 0,
      ]);
    });
  });
  const segWs = XLSX.utils.aoa_to_sheet(segSheetData);
  segWs['!cols'] = [12,16,14,10,10,18,8,12,14].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, segWs, '作業員区間データ');

  // 異常停止イベントシート（「異常停止」ボタンを押すたびに1件記録される）
  const abnormalSheetData = [
    ['異常停止イベント内訳（ボタン押下単位）'],
    ['日付', '設備名', '部品番号', '開始', '終了', '停止理由カテゴリ', '補足', '不良数(pcs)'],
  ];
  selectedLogs.forEach(rec => {
    (rec.abnormalStopEvents && rec.abnormalStopEvents.length ? rec.abnormalStopEvents : []).forEach(ev => {
      abnormalSheetData.push([
        rec.date, rec.equipment || currentEquip, rec.partNo, ev.start || '', ev.end || '',
        ev.category || '未入力', ev.detail || '', ev.defects || 0,
      ]);
    });
  });
  const abnormalWs = XLSX.utils.aoa_to_sheet(abnormalSheetData);
  abnormalWs['!cols'] = [12,16,14,10,10,18,28,12].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, abnormalWs, '異常停止イベントデータ');

  return wb;
}

function exportExcelLocalBackup() {
  const selected = historyLogs.filter(l => checkedRecordIds.has(l.id));
  const target = selected.length > 0 ? selected : historyLogs;
  if (target.length === 0) { showToast('出力対象の日報データがありません', true); return; }
  const wb = generateExcelWorkbook(target, equipmentSelect.value);
  XLSX.writeFile(wb, `プレス作業日報_${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast(`ローカルにExcel保存しました（${target.length}件）`);
}

/* =========================================================
   共通UIヘルパー
   ========================================================= */
function switchView(name) {
  const dash = document.getElementById('view-dashboard');
  const hist = document.getElementById('view-history');
  const tabDash = document.getElementById('tab-dashboard');
  const tabHist = document.getElementById('tab-history');
  if (name === 'dashboard') {
    dash.classList.remove('hidden'); dash.classList.add('flex');
    hist.classList.add('hidden'); hist.classList.remove('flex');
    tabDash.className = 'px-3 py-1.5 text-[11px] font-bold rounded-lg transition-all text-white bg-panel2';
    tabHist.className = 'px-3 py-1.5 text-[11px] font-bold rounded-lg transition-all text-slate-400';
  } else {
    dash.classList.add('hidden'); dash.classList.remove('flex');
    hist.classList.remove('hidden'); hist.classList.add('flex');
    tabDash.className = 'px-3 py-1.5 text-[11px] font-bold rounded-lg transition-all text-slate-400';
    tabHist.className = 'px-3 py-1.5 text-[11px] font-bold rounded-lg transition-all text-white bg-panel2';
    renderHistoryTable();
    updateCloudStatusChip();
  }
}

function showModal(id) { document.getElementById(id).classList.remove('opacity-0', 'pointer-events-none'); }
function hideModal(id) { document.getElementById(id).classList.add('opacity-0', 'pointer-events-none'); }

function showToast(message, isError) {
  const toast = document.getElementById('toast');
  const icon = document.getElementById('toast-icon');
  document.getElementById('toast-text').innerText = message;
  toast.classList.remove('bg-emerald-600', 'border-emerald-400', 'bg-rose-600', 'border-rose-400');
  if (isError) { toast.classList.add('bg-rose-600', 'border-rose-400'); icon.className = 'fa-solid fa-circle-exclamation'; }
  else { toast.classList.add('bg-emerald-600', 'border-emerald-400'); icon.className = 'fa-solid fa-circle-check'; }
  toast.classList.remove('opacity-0', 'pointer-events-none');
  toast.classList.add('opacity-100');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    toast.classList.remove('opacity-100');
    toast.classList.add('opacity-0', 'pointer-events-none');
  }, 3200);
}

function formatTime(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
