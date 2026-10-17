/* ==========================================================
   PRESS MONITOR — 就業時間（始業・終業）
   ・ヘッダーの「始業」ボタン → 勤務区分を選んで始業を記録 → 同じ位置が「終業」ボタンに変わる
   ・始業時刻／勤務区分は後から修正できる（「就業中 hh:mm〜」をタップ）
   ・製造中（製造開始〜製造終了の間）は終業できない
   ・就業中は設備を切り替えられない（updateEquipmentLock が参照）
   ・就業中データはブラウザ更新しても残る（localStorage）。終業の押し忘れは次回起動時に補正を確認する
   ・終業すると 就業時間／所定／残業／早出 を計算して、クラウド（就業時間データ）へ送る
   ========================================================== */

let workSession = null;      // 就業中（始業済み・終業前）のデータ。無ければ null
let sessionHistory = [];     // 終業済みの就業データ（クラウド未送信の再送用）
let sessionModalMode = 'start';   // 'start' | 'edit'
let sessionModalShift = '';       // モーダルで選択中の勤務区分名
let endModalMode = 'end';         // 'end' | 'forgot'
let pendingMfgAfterSession = false; // 「製造開始」→始業確認→（始業後に）製造開始を続行する印
let cancelArmed = false;

/* ---------- 時刻ユーティリティ ---------- */
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtHm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function fmtDateSlash(d) { return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()); }
function fmtDateTimeSlash(d) { return fmtDateSlash(d) + ' ' + fmtHm(d) + ':' + pad2(d.getSeconds()); }
function toLocalInput(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + fmtHm(d); }
function hmToMin(hm) {
  const m = String(hm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : null;
}
function atMinutes(baseDate, dayOffset, minutes) {
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayOffset, 0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h + '時間' + pad2(m) + '分';
}

/* ---------- 勤務区分 ---------- */
function getShiftTypes() {
  return (Array.isArray(masters.shiftTypes) && masters.shiftTypes.length > 0) ? masters.shiftTypes : DEFAULT_MASTERS.shiftTypes;
}
function findShiftType(name) {
  return getShiftTypes().find(t => t.name === name) || null;
}
// 現在時刻に一番近い定時始業の勤務区分を初期選択にする（0:00をまたぐ差も考慮）
function suggestShiftName(now) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let best = null, bestDiff = Infinity;
  getShiftTypes().forEach(t => {
    const sm = hmToMin(t.start);
    if (sm == null) return;
    const raw = Math.abs(nowMin - sm);
    const diff = Math.min(raw, 1440 - raw);
    if (diff < bestDiff) { bestDiff = diff; best = t.name; }
  });
  return best || (getShiftTypes()[0] && getShiftTypes()[0].name) || '';
}

/* 就業の定時（スナップショット）から、実際の日時に直した定時始業／終業／休憩を求める。
   定時始業は「始業時刻に一番近い日」に置く（夜勤で0:00をまたいでも、早出・遅れが正しく出る） */
function plannedDates(sess) {
  const start = new Date(sess.start);
  const sm = hmToMin(sess.plannedStart), em = hmToMin(sess.plannedEnd);
  if (sm == null || em == null) return null;
  let ps = null;
  [-1, 0, 1].forEach(off => {
    const c = atMinutes(start, off, sm);
    if (!ps || Math.abs(c - start) < Math.abs(ps - start)) ps = c;
  });
  const pe = new Date(ps.getTime() + ((em > sm ? em - sm : em + 1440 - sm) * 60000));
  let bs = null, be = null;
  const bsm = hmToMin(sess.breakStart), bem = hmToMin(sess.breakEnd);
  if (bsm != null && bem != null && bsm !== bem) {
    const bOff = bsm >= sm ? 0 : 1; // 開始より前の時刻は翌日側
    bs = atMinutes(ps, bOff, bsm);
    be = new Date(bs.getTime() + ((bem > bsm ? bem - bsm : bem + 1440 - bsm) * 60000));
  }
  return { ps, pe, bs, be };
}

function computeSessionMetrics(sess, endDate) {
  const start = new Date(sess.start);
  const pd = plannedDates(sess);
  const rawSec = Math.max(0, (endDate - start) / 1000);
  let breakOverlapSec = 0, plannedSec = 0, overtimeSec = 0, earlySec = 0, breakMin = 0;
  if (pd) {
    if (pd.bs && pd.be) {
      breakMin = Math.round((pd.be - pd.bs) / 60000);
      const ov = Math.min(endDate, pd.be) - Math.max(start, pd.bs);
      breakOverlapSec = Math.max(0, ov / 1000);
    }
    plannedSec = Math.max(0, (pd.pe - pd.ps) / 1000 - breakMin * 60);
    overtimeSec = Math.max(0, (endDate - pd.pe) / 1000);
    earlySec = Math.max(0, (pd.ps - start) / 1000);
  }
  return {
    workSec: Math.round(Math.max(0, rawSec - breakOverlapSec)),
    plannedSec: Math.round(plannedSec),
    overtimeSec: Math.round(overtimeSec),
    earlySec: Math.round(earlySec),
    breakMin,
  };
}

/* ---------- 永続化 ---------- */
function persistWorkSession() {
  try {
    if (workSession) localStorage.setItem(STORAGE.WORK_SESSION, JSON.stringify(workSession));
    else localStorage.removeItem(STORAGE.WORK_SESSION);
  } catch (e) {}
}
function persistSessionHistory() {
  try { localStorage.setItem(STORAGE.SESSION_HISTORY, JSON.stringify(sessionHistory)); } catch (e) {}
}
function restoreWorkSession() {
  try {
    const raw = localStorage.getItem(STORAGE.WORK_SESSION);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.id && s.start) workSession = s;
    }
  } catch (e) {}
  try {
    const raw = localStorage.getItem(STORAGE.SESSION_HISTORY);
    if (raw) sessionHistory = JSON.parse(raw) || [];
  } catch (e) {}
  if (workSession && workSession.equipment && getEquipmentList().includes(workSession.equipment)) {
    setEquipment(workSession.equipment, true);
  }
  renderSessionUI();
}

/* ---------- ヘッダー表示 ---------- */
function renderSessionUI() {
  const btn = document.getElementById('session-btn');
  const label = document.getElementById('session-label');
  const labelText = document.getElementById('session-label-text');
  if (!btn) return;
  if (workSession) {
    const st = new Date(workSession.start);
    const sameDay = fmtDateSlash(st) === fmtDateSlash(new Date());
    labelText.innerText = '就業中 ' + (sameDay ? '' : (st.getMonth() + 1) + '/' + st.getDate() + ' ') + fmtHm(st) + '〜';
    label.classList.remove('hidden'); label.classList.add('flex');
    label.title = '始業時刻・勤務区分を修正（' + workSession.shiftType + '）';
    btn.className = 'session-btn-end px-2.5 py-1 rounded-lg text-[11px] font-black bg-rose-600 hover:bg-rose-500 text-white border border-rose-400/60 active:scale-95 transition-all whitespace-nowrap';
    btn.innerHTML = '<i class="fa-solid fa-flag-checkered mr-1"></i>終業';
  } else {
    label.classList.add('hidden'); label.classList.remove('flex');
    btn.className = 'session-btn-start px-2.5 py-1 rounded-lg text-[11px] font-black bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-400/60 active:scale-95 transition-all whitespace-nowrap';
    btn.innerHTML = '<i class="fa-solid fa-sun mr-1"></i>始業';
  }
  updateEquipmentLock();
}

function onSessionButton() {
  if (!workSession) { openSessionModal('start'); return; }
  if (state.isShiftActive) { showModal('session-block-modal'); return; }
  openSessionEndModal('end');
}

/* ---------- 始業／始業修正モーダル ---------- */
function renderSessionShiftButtons() {
  const wrap = document.getElementById('session-shift-list');
  wrap.innerHTML = getShiftTypes().map(t => {
    const on = t.name === sessionModalShift;
    const brk = t.breakStart && t.breakEnd ? `／休憩 ${t.breakStart}-${t.breakEnd}` : '';
    return `<button type="button" data-shift="${escapeHtml(t.name)}" onclick="selectSessionShift(this.dataset.shift)"
      class="${on ? 'border-emerald-400 bg-emerald-500/15 text-emerald-300' : 'border-line bg-panel2 text-slate-300'} border-2 rounded-xl py-2 px-2 text-left active:scale-95 transition-all">
      <span class="block text-sm font-black">${escapeHtml(t.name)}</span>
      <span class="block text-[10px] text-slate-400 font-mono">${escapeHtml(t.start)}〜${escapeHtml(t.end)}${escapeHtml(brk)}</span></button>`;
  }).join('');
}
function selectSessionShift(name) { sessionModalShift = name; renderSessionShiftButtons(); }

function openSessionModal(mode, focusTime) {
  sessionModalMode = mode;
  cancelArmed = false;
  const now = new Date();
  const isEdit = mode === 'edit' && workSession;
  document.getElementById('session-modal-title').innerText = isEdit ? '始業の修正' : '始業を記録';
  document.getElementById('session-ok-btn').innerText = isEdit ? '修正する' : '始業する';
  document.getElementById('session-time-input').value = toLocalInput(isEdit ? new Date(workSession.start) : now);
  sessionModalShift = isEdit ? workSession.shiftType : suggestShiftName(now);
  document.getElementById('session-error').innerText = '';
  const cancelBtn = document.getElementById('session-cancel-record-btn');
  cancelBtn.classList.toggle('hidden', !isEdit);
  cancelBtn.innerHTML = '<i class="fa-solid fa-trash-can mr-1"></i>この始業を取り消す';
  renderSessionShiftButtons();
  showModal('session-modal');
  if (focusTime) { try { document.getElementById('session-time-input').focus(); } catch (e) {} }
}
function openSessionEditModal() { if (workSession) openSessionModal('edit'); }
function closeSessionModal() {
  hideModal('session-modal');
  pendingMfgAfterSession = false; // 始業せずに閉じた場合は、製造開始も行わない
}

function sessionError(msg) { document.getElementById('session-error').innerText = msg; }

function confirmSessionModal() {
  const t = findShiftType(sessionModalShift);
  if (!t) { sessionError('勤務区分を選んでください'); return; }
  const v = document.getElementById('session-time-input').value;
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d)) { sessionError('始業時刻を入力してください'); return; }
  if (d.getTime() > Date.now() + 60000) { sessionError('始業時刻が未来になっています'); return; }

  if (sessionModalMode === 'edit' && workSession) {
    workSession.start = d.toISOString();
    if (workSession.shiftType !== t.name) applyShiftSnapshot(workSession, t);
    persistWorkSession();
    renderSessionUI();
    hideModal('session-modal');
    showToast('始業を修正しました（' + workSession.shiftType + ' ' + fmtHm(d) + '〜）');
    return;
  }
  hideModal('session-modal');
  beginSession(d, t);
}

function applyShiftSnapshot(sess, t) {
  sess.shiftType = t.name;
  sess.plannedStart = t.start; sess.plannedEnd = t.end;
  sess.breakStart = t.breakStart || ''; sess.breakEnd = t.breakEnd || '';
}

function beginSession(startDate, shiftType) {
  const sess = {
    id: 'S' + Date.now(),
    equipment: currentEquipmentName(),
    start: startDate.toISOString(),
    lastMfgEnd: null,
    kind: '実績',
  };
  applyShiftSnapshot(sess, shiftType);
  workSession = sess;
  persistWorkSession();
  renderSessionUI();
  showToast('始業を記録しました（' + sess.shiftType + ' ' + fmtHm(startDate) + '〜）');
  if (pendingMfgAfterSession) { pendingMfgAfterSession = false; startMfg(true); }
}

// 始業を取り消す（誤って押した場合）。2回タップで確定
function cancelSessionRecord() {
  if (!workSession) return;
  if (state.isShiftActive) { sessionError('製造中は取り消せません。製造終了後に操作してください'); return; }
  const btn = document.getElementById('session-cancel-record-btn');
  if (!cancelArmed) {
    cancelArmed = true;
    btn.innerHTML = '<i class="fa-solid fa-triangle-exclamation mr-1"></i>もう一度タップで取り消し';
    return;
  }
  workSession = null;
  persistWorkSession();
  renderSessionUI();
  hideModal('session-modal');
  showToast('始業の記録を取り消しました');
}

/* ---------- 製造開始時：始業が未記録の場合の確認 ---------- */
function openSessionPrompt() { showModal('session-prompt-modal'); }
function sessionPromptNow() {
  hideModal('session-prompt-modal');
  const now = new Date();
  const t = findShiftType(suggestShiftName(now));
  if (!t) { startMfg(true); return; }
  pendingMfgAfterSession = true;
  beginSession(now, t);
}
function sessionPromptSpecify() {
  hideModal('session-prompt-modal');
  pendingMfgAfterSession = true;
  openSessionModal('start', true);
}
function sessionPromptSkip() {
  hideModal('session-prompt-modal');
  startMfg(true);
}
function sessionPromptCancel() { hideModal('session-prompt-modal'); }

/* ---------- 終業モーダル（通常／押し忘れ補正） ---------- */
function openSessionEndModal(mode) {
  if (!workSession) return;
  endModalMode = mode;
  const st = new Date(workSession.start);
  const isForgot = mode === 'forgot';
  document.getElementById('session-end-title').innerText = isForgot ? '前回の終業が未記録です' : '終業を記録';
  document.getElementById('session-end-lead').innerText = isForgot
    ? '終業ボタンが押されないまま時間が経っています。終業時刻を確認してください（補正として記録されます）。'
    : 'お疲れさまでした。終業時刻を確認して「終業する」を押してください。';
  document.getElementById('session-end-ok-btn').innerText = isForgot ? 'この時刻で終業を記録' : '終業する';
  document.getElementById('session-end-later-btn').innerText = isForgot ? 'あとで' : 'キャンセル';
  document.getElementById('session-end-start').innerText =
    workSession.shiftType + '　' + fmtDateSlash(st) + ' ' + fmtHm(st) + '〜';

  let def = new Date();
  if (isForgot) {
    const last = workSession.lastMfgEnd ? new Date(workSession.lastMfgEnd) : null;
    if (last && last > st) def = last;
    else { const pd = plannedDates(workSession); if (pd) def = pd.pe; }
  }
  const hint = document.getElementById('session-end-hint');
  hint.innerText = isForgot
    ? (workSession.lastMfgEnd ? '初期値は、この就業中の最後の「製造終了」時刻です。' : '初期値は、定時終業の時刻です（この就業中の製造終了の記録がありません）。')
    : '';
  document.getElementById('session-end-input').value = toLocalInput(def);
  document.getElementById('session-end-error').innerText = '';
  updateSessionEndPreview();
  showModal('session-end-modal');
}
function closeSessionEndModal() { hideModal('session-end-modal'); }

function readEndInput() {
  const v = document.getElementById('session-end-input').value;
  const d = v ? new Date(v) : null;
  return (d && !isNaN(d)) ? d : null;
}
function updateSessionEndPreview() {
  const el = document.getElementById('session-end-preview');
  if (!workSession) return;
  const d = readEndInput();
  if (!d || d <= new Date(workSession.start)) { el.innerHTML = ''; return; }
  const m = computeSessionMetrics(workSession, d);
  el.innerHTML =
    `<span class="text-slate-400">就業時間</span> <b class="text-white">${fmtDuration(m.workSec)}</b>` +
    `<span class="mx-2 text-slate-600">|</span><span class="text-slate-400">残業</span> <b class="${m.overtimeSec > 0 ? 'text-amber-300' : 'text-slate-300'}">${fmtDuration(m.overtimeSec)}</b>` +
    (m.earlySec > 0 ? `<span class="mx-2 text-slate-600">|</span><span class="text-slate-400">早出</span> <b class="text-sky-300">${fmtDuration(m.earlySec)}</b>` : '');
}

function confirmSessionEnd() {
  if (!workSession) return;
  if (state.isShiftActive) { closeSessionEndModal(); showModal('session-block-modal'); return; }
  const d = readEndInput();
  const err = document.getElementById('session-end-error');
  if (!d) { err.innerText = '終業時刻を入力してください'; return; }
  if (d <= new Date(workSession.start)) { err.innerText = '終業時刻は始業より後にしてください'; return; }
  if (d.getTime() > Date.now() + 60000) { err.innerText = '終業時刻が未来になっています'; return; }

  const sess = workSession;
  const m = computeSessionMetrics(sess, d);
  const isForgot = endModalMode === 'forgot';
  const rec = {
    id: sess.id,
    workDate: fmtDateSlash(new Date(sess.start)),
    shiftType: sess.shiftType,
    equipment: sess.equipment,
    start: fmtDateTimeSlash(new Date(sess.start)),
    end: fmtDateTimeSlash(d),
    workSec: m.workSec, plannedSec: m.plannedSec, overtimeSec: m.overtimeSec, earlySec: m.earlySec,
    breakMin: m.breakMin,
    kind: isForgot ? '補正' : '実績',
    plannedStart: sess.plannedStart, plannedEnd: sess.plannedEnd,
    breakStart: sess.breakStart || '', breakEnd: sess.breakEnd || '',
    note: isForgot ? '終業の押し忘れを次回起動時に補正' : '',
    syncStatus: 'pending',
  };
  sessionHistory.unshift(rec);
  if (sessionHistory.length > 200) sessionHistory.length = 200;
  persistSessionHistory();

  workSession = null;
  persistWorkSession();
  closeSessionEndModal();
  renderSessionUI();
  updateSyncBadge();
  updateCloudStatusChip();
  showToast(`終業を記録しました（就業 ${fmtDuration(m.workSec)}／残業 ${fmtDuration(m.overtimeSec)}）`);
  syncSessionToCloud(rec);
}

/* ---------- 製造終了との連携 ---------- */
function noteMfgEndForSession(endDate) {
  if (!workSession || !endDate) return;
  workSession.lastMfgEnd = endDate.toISOString();
  persistWorkSession();
}

/* ---------- 押し忘れ確認（起動時） ---------- */
function checkForgottenSession() {
  if (!workSession || state.isShiftActive) return;
  const pd = plannedDates(workSession);
  if (!pd) return;
  const hours = Number(masters.forgotConfirmHours) > 0 ? Number(masters.forgotConfirmHours) : 4;
  if (Date.now() >= pd.pe.getTime() + hours * 3600000) openSessionEndModal('forgot');
}

/* ---------- 未送信の就業データ ---------- */
function pendingSessionCount() {
  return sessionHistory.filter(r => r.syncStatus !== 'synced').length;
}
