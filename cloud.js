/* ==========================================================
   PRESS MONITOR — クラウド通信（Google Apps Script連携）
   日報の同期、マスタデータ取得、メール送信依頼を担当します。
   ========================================================== */

/**
 * GASウェブアプリへPOSTリクエストを送る共通関数。
 * Content-Type を text/plain にすることでCORSのプリフライトを回避しています
 * （GAS側は e.postData.contents を自前でJSON.parseするため問題ありません）。
 */
async function gasRequest(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (e) {}
    throw new Error('HTTP ' + res.status + (detail ? ': ' + detail.slice(0, 300) : ''));
  }
  return res.json();
}

/* ---------- 接続テスト ---------- */
async function testGasConnection() {
  const url = document.getElementById('settings-gas-url').value.trim();
  const resultEl = document.getElementById('settings-gas-test-result');
  if (!url) { resultEl.innerHTML = '<span class="text-rose-400">URLを入力してください</span>'; return; }
  resultEl.innerHTML = '<span class="text-slate-400">接続確認中…</span>';
  try {
    const res = await gasRequest(url, { action: 'ping' });
    if (res && res.status === 'ok') {
      resultEl.innerHTML = '<span class="text-emerald-400"><i class="fa-solid fa-circle-check mr-1"></i>接続成功しました</span>';
    } else {
      resultEl.innerHTML = '<span class="text-amber-400">応答はありましたが内容が想定外です</span>';
    }
  } catch (e) {
    resultEl.innerHTML = '<span class="text-rose-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>接続できませんでした（URLやデプロイ設定をご確認ください）</span>';
  }
}

/* ---------- 日報1件のクラウド保存 ---------- */
async function syncRecordToCloud(record) {
  if (!settings.gasUrl) { updateCloudStatusChip(); return; }
  try {
    const res = await gasRequest(settings.gasUrl, { action: 'saveRecord', record });
    record.syncStatus = (res && res.status === 'ok') ? 'synced' : 'error';
  } catch (e) {
    record.syncStatus = 'pending';
  }
  persistHistory();
  renderHistoryTable();
  updateSyncBadge();
  updateCloudStatusChip();
}

async function retryPendingSync(showFeedback) {
  if (!settings.gasUrl) {
    if (showFeedback) showToast('クラウドURLが未設定です。設定画面から入力してください', true);
    return;
  }
  const pending = historyLogs.filter(r => r.syncStatus !== 'synced');
  if (pending.length === 0) {
    if (showFeedback) showToast('未送信の日報はありません');
    updateCloudStatusChip();
    return;
  }
  if (showFeedback) showToast(`${pending.length}件を同期しています…`);
  for (const rec of pending) {
    await syncRecordToCloud(rec);
  }
  if (showFeedback) showToast('同期が完了しました');
}

function updateSyncBadge() {
  const pending = historyLogs.filter(r => r.syncStatus !== 'synced').length;
  const badge = document.getElementById('sync-badge');
  document.getElementById('sync-badge-count').innerText = pending;
  if (pending > 0) { badge.classList.remove('hidden'); badge.classList.add('flex'); }
  else { badge.classList.add('hidden'); badge.classList.remove('flex'); }
}

function updateCloudStatusChip() {
  const el = document.getElementById('cloud-status');
  const icon = el.querySelector('i');
  const text = document.getElementById('cloud-status-text');
  if (!settings.gasUrl) {
    icon.className = 'fa-solid fa-circle-notch text-slate-600';
    text.innerText = 'クラウド未接続';
    text.className = 'text-slate-500';
    return;
  }
  const pending = historyLogs.filter(r => r.syncStatus !== 'synced').length;
  if (pending === 0) {
    icon.className = 'fa-solid fa-cloud-check sync-ok';
    text.innerText = 'クラウド同期済み';
    text.className = 'sync-ok';
  } else {
    icon.className = 'fa-solid fa-cloud-arrow-up sync-pending';
    text.innerText = `未送信 ${pending}件`;
    text.className = 'sync-pending';
  }
}

/* ---------- 品番・作業員マスタの取得 ---------- */
async function fetchMastersFromCloud(showFeedback) {
  if (!settings.gasUrl) {
    if (showFeedback) showToast('クラウドURLが未設定です。設定画面から入力してください', true);
    return;
  }
  if (showFeedback) showToast('マスタデータを取得しています…');
  try {
    const res = await gasRequest(settings.gasUrl, { action: 'getMasters' });
    if (res && res.status === 'ok') {
      masters.partMasters = Array.isArray(res.partMasters) ? res.partMasters : [];
      masters.operators = Array.isArray(res.operators) ? res.operators : [];
      masters.stopReasons = Array.isArray(res.stopReasons) ? res.stopReasons : masters.stopReasons;
      masters.lastSyncedAt = new Date().toISOString();
      persistMasters();
      renderPartOptions();
      renderOperatorDatalist();
      renderStopReasonOptions();
      renderMasterStatus();
      if (showFeedback) showToast(`マスタデータを更新しました（品番${masters.partMasters.length}件／作業員${masters.operators.length}名／停止理由${masters.stopReasons.length}件）`);
    } else {
      if (showFeedback) showToast('マスタデータの取得に失敗しました：' + (res && res.message ? res.message : '不明なエラー'), true);
    }
  } catch (e) {
    console.error('fetchMastersFromCloud failed:', e);
    if (showFeedback) showToast('マスタデータの取得に失敗しました（通信環境をご確認ください。詳細はブラウザのコンソールに出力しています）', true);
  }
}

/* ---------- 選択した日報のメール送信依頼 ---------- */
async function sendSelectedReport() {
  const selected = historyLogs.filter(l => checkedRecordIds.has(l.id));
  if (selected.length === 0) { showToast('送信対象の日報にチェックを入れてください', true); return; }
  if (!settings.gasUrl) { showToast('クラウドURLが未設定です。設定画面から入力してください', true); openSettingsModal(); return; }

  const email = reportEmailInput.value.trim() || settings.defaultEmail;
  if (!email) { showToast('送信先メールアドレスを入力してください', true); return; }

  const currentEquip = equipmentSelect.value || settings.equipmentList[0] || '未設定';
  showToast('メールを送信しています…');

  try {
    const res = await gasRequest(settings.gasUrl, {
      action: 'sendReport',
      email,
      equipment: currentEquip,
      records: selected,
    });
    if (res && res.status === 'ok') {
      showToast(`日報（${selected.length}件）をメール送信しました`);
    } else {
      showToast('送信に失敗しました：' + (res && res.message ? res.message : '不明なエラー'), true);
    }
  } catch (e) {
    showToast('送信に失敗しました。通信環境をご確認のうえ再度お試しください', true);
  }
}
