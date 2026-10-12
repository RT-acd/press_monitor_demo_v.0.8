/**
 * PRESS MONITOR — クラウド連携バックエンド (Google Apps Script)
 *
 * 役割:
 *  1) iPadアプリから送られてくる日報1件ずつを、このスクリプトに紐づく
 *     Googleスプレッドシートへ自動保存する（管理者はいつでもシートを開いて閲覧可能）
 *  2) iPadアプリで「選択中の日報をメール送信」を押した際、選択された日報を
 *     Excel(.xlsx)添付ファイル付きメールとして指定の宛先へ自動送信する
 *
 * セットアップ手順は同梱の SETUP_GUIDE.md を参照してください。
 * このファイルは「コンテナバインドスクリプト」として、
 * Googleスプレッドシートの [拡張機能] > [Apps Script] から貼り付けて使う前提です。
 */

const SHEET_NAME = '日報データ';
const SEGMENT_SHEET_NAME = '作業員区間データ';
const ABNORMAL_STOP_SHEET_NAME = '異常停止イベントデータ';
const PART_MASTER_SHEET = '品番マスタ';
const OPERATOR_MASTER_SHEET = '作業員マスタ';
const STOP_REASON_MASTER_SHEET = '停止理由マスタ';

/**
 * スプレッドシート3分割構成（マスタデータ／日報の全体データ／ライン長向けデータ）
 *
 * ・日報の全体データ：このスクリプトが紐づく既存のスプレッドシート（従来通り）
 * ・マスタデータ　　：品番・作業員・停止理由マスタを置く新しいスプレッドシート（別ファイル）
 * ・ライン長向けデータ：ラインごとにタブを分けた全期間データを置く新しいスプレッドシート（別ファイル）
 *
 * 下の2つのIDが未設定（空文字）の間は、従来通り全て同じスプレッドシート（このスクリプトの
 * 紐づき先）を使う後方互換動作になる。マスタ／ライン長向けの別ファイルを用意したら、
 * そのスプレッドシートのURLに含まれるID部分をここに貼り付けてください。
 * （例: https://docs.google.com/spreadsheets/d/【ここがID】/edit ）
 */
const MASTER_SPREADSHEET_ID = '';
const LINE_LEADER_SPREADSHEET_ID = '';

function getReportSpreadsheet_() {
  // 日報の全体データは、このスクリプトが紐づく既存ファイルをそのまま使い続ける
  return SpreadsheetApp.getActiveSpreadsheet();
}
function getMasterSpreadsheet_() {
  if (!MASTER_SPREADSHEET_ID) return SpreadsheetApp.getActiveSpreadsheet();
  return SpreadsheetApp.openById(MASTER_SPREADSHEET_ID);
}
function getLineLeaderSpreadsheet_() {
  if (!LINE_LEADER_SPREADSHEET_ID) return SpreadsheetApp.getActiveSpreadsheet();
  return SpreadsheetApp.openById(LINE_LEADER_SPREADSHEET_ID);
}

// 「停止理由」「停止理由カテゴリ」列は過去データ保持のため残すが、
// 異常停止ボタンをイベント化して以降は新規に値を書き込まない（'なし'固定）。
// 詳細な理由は 異常停止イベントデータ シート側で管理する。
// 分析用に「異常停止件数」列だけを末尾に追加する。
const HEADER_ROW = [
  '受信日時', 'レコードID', '日付', '設備名', '作業員', '作業人数', '部品番号(品番)',
  '製造開始時間', '製造終了時間', '設定SPM', '生産数(pcs)', '材料交換(回)', 'スクラップ交換(回)',
  '停止理由', '稼働時間(秒)', '金型交換時間(秒)', '計画停止時間(秒)', '異常停止時間(秒)', '性能稼働率(%)',
  '停止理由カテゴリ', '異常停止件数', '不良数(pcs)',
];

/* =========================================================
   エントリポイント
   ========================================================= */
function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ status: 'error', message: '不正なリクエスト形式です' });
  }

  try {
    switch (payload.action) {
      case 'ping':
        return jsonResponse({ status: 'ok', message: 'pong' });
      case 'saveRecord':
        return handleSaveRecord(payload.record);
      case 'sendReport':
        return handleSendReport(payload.email, payload.equipment, payload.records);
      case 'getMasters':
        return handleGetMasters();
      case 'uploadPartMaster':
        return handleUploadPartMaster(payload.rows);
      case 'uploadOperatorMaster':
        return handleUploadOperatorMaster(payload.names);
      case 'uploadStopReasonMaster':
        return handleUploadStopReasonMaster(payload.reasons);
      case 'getLineLeaderData':
        return handleGetLineLeaderData(payload.equipment);
      default:
        return jsonResponse({ status: 'error', message: '不明なアクションです: ' + payload.action });
    }
  } catch (err) {
    return jsonResponse({ status: 'error', message: String(err) });
  }
}

function doGet(e) {
  return jsonResponse({ status: 'ok', message: 'PRESS MONITOR backend is running.' });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================
   1) 日報1件をスプレッドシートへ保存
   ========================================================= */
function handleSaveRecord(record) {
  if (!record) return jsonResponse({ status: 'error', message: 'record がありません' });

  const sheet = getOrCreateSheet();
  const row = recordToRow(record);

  // 同一レコードID（iPad側で採番したid）が既にあれば上書き、なければ追記
  const idColIndex = 2; // B列 = レコードID
  const data = sheet.getDataRange().getValues();
  let targetRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idColIndex - 1]) === String(record.id)) { targetRow = i + 1; break; }
  }

  if (targetRow > 0) {
    sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }

  writeSegmentRows(record);
  writeAbnormalStopEventRows(record);

  return jsonResponse({ status: 'ok', id: record.id });
}

/**
 * 「人数変更を記録」で確定した区間データを、別シート（作業員区間データ）へ書き込む。
 * 同じレコードIDの既存行があれば一旦削除してから書き直す（日報の編集・再送信に対応）。
 */
const SEGMENT_HEADER_ROW = [
  '受信日時', '元レコードID', '日付', '設備名', '部品番号', '区間開始', '区間終了', '作業員', '人数', '生産数(pcs)', '性能稼働率(%)',
  '稼働時間(秒)', '金型交換時間(秒)', '計画停止時間(秒)', '異常停止時間(秒)',
];

function writeSegmentRows(record) {
  if (!record.segments || record.segments.length === 0) return;

  const ss = getReportSpreadsheet_();
  let sheet = ss.getSheetByName(SEGMENT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SEGMENT_SHEET_NAME);
    sheet.appendRow(SEGMENT_HEADER_ROW);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, SEGMENT_HEADER_ROW.length).setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
  } else {
    // 既存シートに新しい列（稼働時間内訳等）が無ければ、末尾に自動で追記する
    const currentLen = sheet.getLastColumn();
    if (currentLen < SEGMENT_HEADER_ROW.length) {
      const missing = SEGMENT_HEADER_ROW.slice(currentLen);
      const range = sheet.getRange(1, currentLen + 1, 1, missing.length);
      range.setValues([missing]);
      range.setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
    }
  }

  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][1]) === String(record.id)) sheet.deleteRow(i + 1);
  }

  record.segments.forEach(seg => {
    sheet.appendRow([
      new Date(), record.id, record.date, record.equipment || '', seg.partNo || record.partNo || '',
      seg.start, seg.end, seg.operator || '未選択', seg.workerCount || 1, seg.count || 0, seg.perfRate || '',
      seg.runningSec || 0, seg.moldSec || 0, seg.breakSec || 0, seg.stopSec || 0,
    ]);
  });
}

/**
 * 「異常停止」ボタンを押すたびに1件記録されるイベントを、別シート
 * （異常停止イベントデータ）へ書き込む。日報データ本体には件数のみを持たせ、
 * 詳細な理由（カテゴリ・補足）はこちらのシートだけで管理する。
 * 同じレコードIDの既存行があれば一旦削除してから書き直す（日報の編集・再送信に対応）。
 */
const ABNORMAL_STOP_HEADER_ROW = [
  '受信日時', '元レコードID', '日付', '設備名', '部品番号', '開始', '終了', '停止理由カテゴリ', '補足', '不良数(pcs)',
];

function writeAbnormalStopEventRows(record) {
  if (!record.abnormalStopEvents || record.abnormalStopEvents.length === 0) return;

  const ss = getReportSpreadsheet_();
  let sheet = ss.getSheetByName(ABNORMAL_STOP_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ABNORMAL_STOP_SHEET_NAME);
    sheet.appendRow(ABNORMAL_STOP_HEADER_ROW);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, ABNORMAL_STOP_HEADER_ROW.length).setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
  } else {
    // 既存シートに新しい列（不良数）が無ければ、末尾に自動で追記する
    const currentLen = sheet.getLastColumn();
    if (currentLen < ABNORMAL_STOP_HEADER_ROW.length) {
      const missing = ABNORMAL_STOP_HEADER_ROW.slice(currentLen);
      const range = sheet.getRange(1, currentLen + 1, 1, missing.length);
      range.setValues([missing]);
      range.setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
    }
  }

  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][1]) === String(record.id)) sheet.deleteRow(i + 1);
  }

  record.abnormalStopEvents.forEach(ev => {
    sheet.appendRow([
      new Date(), record.id, record.date, record.equipment || '', record.partNo || '',
      ev.start || '', ev.end || '', ev.category || '未入力', ev.detail || '', ev.defects || 0,
    ]);
  });
}

function recordToRow(rec) {
  return [
    new Date(),
    rec.id,
    rec.date,
    rec.equipment || '',
    rec.operator || '未選択',
    rec.workerCount || 1,
    rec.partNo || '',
    rec.start || '',
    rec.end || '',
    rec.settingSPM || '',
    rec.count || 0,
    rec.materialCount || 0,
    rec.scrapCount || 0,
    rec.stopReason || 'なし',
    rec.runningSec || 0,
    rec.moldSec || 0,
    rec.breakSec || 0,
    rec.stopSec || 0,
    rec.perfRate || '',
    rec.stopReasonCategory || 'なし',
    rec.abnormalStopCount != null ? rec.abnormalStopCount : (rec.abnormalStopEvents ? rec.abnormalStopEvents.length : 0),
    rec.defectCount || 0,
  ];
}

function getOrCreateSheet() {
  const ss = getReportSpreadsheet_();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADER_ROW);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADER_ROW.length).setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
  } else {
    // 既存シートに新しい列（停止理由カテゴリ等）が無ければ、末尾に自動で追記する
    const currentLen = sheet.getLastColumn();
    if (currentLen < HEADER_ROW.length) {
      const missing = HEADER_ROW.slice(currentLen);
      const range = sheet.getRange(1, currentLen + 1, 1, missing.length);
      range.setValues([missing]);
      range.setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
    }
  }
  return sheet;
}

/* =========================================================
   3) 品番マスタ・作業員マスタの取得
   管理者は「品番マスタ」「作業員マスタ」シートをExcelのように
   直接編集するだけで、iPad側に反映されます（列の並びは固定）。
   ========================================================= */
function handleGetMasters() {
  return jsonResponse({
    status: 'ok',
    partMasters: readPartMasterSheet(),
    operators: readOperatorMasterSheet(),
    stopReasons: readStopReasonMasterSheet(),
  });
}

/**
 * 品番マスタを読み込む。
 * 列は「品番／SPM」が先頭2列、「工程名」「充当機」は見出し名で探す（列の並びや見出しが変わっても読めるようにするため）。
 * 見出しが見つからない場合は、3列目＝工程名、4列目＝充当機として扱う。列が無ければ空文字。
 */
const PART_PROCESS_HEADER_CANDIDATES = ['工程名', '工程', '工程区分'];
const PART_MACHINE_HEADER_CANDIDATES = ['充当機', '充当設備', '充当機械', '充当機名', '設備', '設備名'];

function findHeaderIndex_(headers, candidates, fallbackIdx) {
  const norm = v => String(v || '').replace(/[\s　]/g, '').toLowerCase();
  for (let c = 0; c < candidates.length; c++) {
    const idx = headers.findIndex(h => norm(h) === norm(candidates[c]));
    if (idx >= 0) return idx;
  }
  return fallbackIdx < headers.length ? fallbackIdx : -1;
}

function readPartMasterSheet() {
  const ss = getMasterSpreadsheet_();
  let sheet = ss.getSheetByName(PART_MASTER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PART_MASTER_SHEET);
    sheet.appendRow(['品番', 'SPM', '工程名', '充当機']);
    sheet.appendRow(['SP-200', 15, 'プレス', '']);
    sheet.appendRow(['SP-210', 18, 'プレス', '']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
  }
  const data = sheet.getDataRange().getValues();
  const headers = data[0] || [];
  const processIdx = findHeaderIndex_(headers, PART_PROCESS_HEADER_CANDIDATES, 2);
  const machineIdx = findHeaderIndex_(headers, PART_MACHINE_HEADER_CANDIDATES, 3);
  const result = [];
  for (let i = 1; i < data.length; i++) {
    const part = String(data[i][0] || '').trim();
    const spm = parseFloat(data[i][1]);
    if (part && !isNaN(spm)) {
      result.push({
        part: part,
        spm: spm,
        process: processIdx >= 0 ? String(data[i][processIdx] || '').trim() : '',
        machine: machineIdx >= 0 ? String(data[i][machineIdx] || '').trim() : '',
      });
    }
  }
  return result;
}

function readOperatorMasterSheet() {
  const ss = getMasterSpreadsheet_();
  let sheet = ss.getSheetByName(OPERATOR_MASTER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(OPERATOR_MASTER_SHEET);
    sheet.appendRow(['作業員名']);
    sheet.appendRow(['山田']);
    sheet.appendRow(['佐藤']);
    sheet.appendRow(['鈴木']);
    sheet.appendRow(['田中']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 1).setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
  }
  const data = sheet.getDataRange().getValues();
  const result = [];
  for (let i = 1; i < data.length; i++) {
    const name = String(data[i][0] || '').trim();
    if (name) result.push(name);
  }
  return result;
}

function readStopReasonMasterSheet() {
  const ss = getMasterSpreadsheet_();
  let sheet = ss.getSheetByName(STOP_REASON_MASTER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(STOP_REASON_MASTER_SHEET);
    sheet.appendRow(['停止理由カテゴリ']);
    ['なし', '段取り替え', '材料待ち', '品質確認・不良対応', '設備トラブル', '人員不足・応援待ち', '朝礼・清掃・保全', 'その他']
      .forEach(r => sheet.appendRow([r]));
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 1).setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
  }
  const data = sheet.getDataRange().getValues();
  const result = [];
  for (let i = 1; i < data.length; i++) {
    const reason = String(data[i][0] || '').trim();
    if (reason) result.push(reason);
  }
  return result;
}

/* =========================================================
   5) 管理者ページ(admin.html)からのマスタ上書き保存
   Excelファイルを解析した結果（品番+SPMの配列 / 作業員名の配列）を
   受け取り、品番マスタ・作業員マスタシートの中身を丸ごと置き換える。
   ========================================================= */
function handleUploadPartMaster(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return jsonResponse({ status: 'error', message: 'アップロードするデータがありません' });
  }
  const cleaned = rows
    .map(r => ({
      part: String(r.part || '').trim(),
      spm: parseFloat(r.spm),
      process: String(r.process || '').trim(),
      machine: String(r.machine || '').trim(),
    }))
    .filter(r => r.part && !isNaN(r.spm));
  if (cleaned.length === 0) {
    return jsonResponse({ status: 'error', message: '有効な行が1件もありませんでした（品番またはSPMを確認してください）' });
  }

  const ss = getMasterSpreadsheet_();
  let sheet = ss.getSheetByName(PART_MASTER_SHEET);
  if (sheet) { ss.deleteSheet(sheet); }
  sheet = ss.insertSheet(PART_MASTER_SHEET);
  sheet.appendRow(['品番', 'SPM', '工程名', '充当機']);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
  const values = cleaned.map(r => [r.part, r.spm, r.process, r.machine]);
  sheet.getRange(2, 1, values.length, 4).setValues(values);

  return jsonResponse({ status: 'ok', count: cleaned.length });
}

function handleUploadOperatorMaster(names) {
  if (!Array.isArray(names) || names.length === 0) {
    return jsonResponse({ status: 'error', message: 'アップロードするデータがありません' });
  }
  const cleaned = [...new Set(names.map(n => String(n || '').trim()).filter(n => n))];
  if (cleaned.length === 0) {
    return jsonResponse({ status: 'error', message: '有効な作業員名が1件もありませんでした' });
  }

  const ss = getMasterSpreadsheet_();
  let sheet = ss.getSheetByName(OPERATOR_MASTER_SHEET);
  if (sheet) { ss.deleteSheet(sheet); }
  sheet = ss.insertSheet(OPERATOR_MASTER_SHEET);
  sheet.appendRow(['作業員名']);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, 1).setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
  const values = cleaned.map(n => [n]);
  sheet.getRange(2, 1, values.length, 1).setValues(values);

  return jsonResponse({ status: 'ok', count: cleaned.length });
}

function handleUploadStopReasonMaster(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return jsonResponse({ status: 'error', message: 'アップロードするデータがありません' });
  }
  const cleaned = [...new Set(reasons.map(r => String(r || '').trim()).filter(r => r))];
  if (cleaned.length === 0) {
    return jsonResponse({ status: 'error', message: '有効な停止理由が1件もありませんでした' });
  }

  const ss = getMasterSpreadsheet_();
  let sheet = ss.getSheetByName(STOP_REASON_MASTER_SHEET);
  if (sheet) { ss.deleteSheet(sheet); }
  sheet = ss.insertSheet(STOP_REASON_MASTER_SHEET);
  sheet.appendRow(['停止理由カテゴリ']);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, 1).setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
  const values = cleaned.map(r => [r]);
  sheet.getRange(2, 1, values.length, 1).setValues(values);

  return jsonResponse({ status: 'ok', count: cleaned.length });
}
function handleSendReport(email, equipment, records) {
  if (!email) return jsonResponse({ status: 'error', message: '送信先メールアドレスがありません' });
  if (!records || records.length === 0) return jsonResponse({ status: 'error', message: '送信対象データがありません' });

  const subject = `【${equipment || '設備'} 作業日報】${records[0].date || Utilities.formatDate(new Date(), 'JST', 'yyyy/MM/dd')}`;
  const excelBlob = buildExcelBlob(records, equipment);

  const totalCount = records.reduce((s, r) => s + (r.count || 0), 0);
  const avgRate = (records.reduce((s, r) => s + parseFloat(r.perfRate || 0), 0) / records.length).toFixed(1);

  let body = `関係者各位\n\nお疲れ様です。${equipment || ''} の作業実績（全${records.length}件）を報告します。\n\n` +
    `----------------------------------------\n` +
    `総生産数: ${totalCount} pcs / 平均性能稼働率: ${avgRate}%\n` +
    `----------------------------------------\n`;

  records.forEach((rec, idx) => {
    const abnormalCount = rec.abnormalStopCount != null ? rec.abnormalStopCount : (rec.abnormalStopEvents || []).length;
    body += `[${idx + 1}/${records.length}] 日付:${rec.date} | 部品:${rec.partNo} | 作業員:${rec.operator || '未選択'}\n` +
      `   時間:${rec.start}〜${rec.end} | 生産数:${rec.count}pcs（不良:${rec.defectCount || 0}pcs） | 材料交換:${rec.materialCount || 0}回 | ` +
      `スクラップ:${rec.scrapCount || 0}回 | 異常停止:${abnormalCount}件 | 稼働率:${rec.perfRate}%\n`;
  });

  body += `----------------------------------------\n添付のExcelファイルに詳細データを記載しています。\n以上、よろしくお願いいたします。\n\n（本メールはPRESS MONITORアプリから自動送信されています）`;

  GmailApp.sendEmail(email, subject, body, { attachments: [excelBlob], name: 'PRESS MONITOR' });

  return jsonResponse({ status: 'ok', sent: records.length });
}

/**
 * 一時的なGoogleスプレッドシートを作成してExcel(.xlsx)形式のBlobとして書き出す。
 * 生成後は一時ファイルをゴミ箱へ移動して片付ける。
 */
function buildExcelBlob(records, equipment) {
  const currentEquip = equipment || '設備';
  const tempName = 'PressReport_tmp_' + new Date().getTime();
  const tempSs = SpreadsheetApp.create(tempName);
  const sheet = tempSs.getSheets()[0];
  sheet.setName('作業日報');

  const totalCount = records.reduce((s, r) => s + (r.count || 0), 0);
  const avgRate = (records.reduce((s, r) => s + parseFloat(r.perfRate || 0), 0) / records.length).toFixed(1);

  const header = ['日付', '設備名', '作業員', '作業人数', '部品番号(品番)', '製造開始時間', '製造終了時間',
    '生産数(pcs)', '不良数(pcs)', '材料交換(回)', 'スクラップ交換(回)', '異常停止件数', '実生産稼働時間', '金型交換時間',
    '計画停止時間', '異常停止時間', '性能稼働率(%)'];

  const rows = [
    [`【${currentEquip}】 プレス生産作業日報`],
    [`出力日時: ${Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss')}`, `件数: ${records.length}件`, `総生産数: ${totalCount}pcs`, `平均性能稼働率: ${avgRate}%`],
    header,
  ];

  records.forEach(rec => {
    const abnormalCount = rec.abnormalStopCount != null ? rec.abnormalStopCount : (rec.abnormalStopEvents || []).length;
    rows.push([
      rec.date, rec.equipment || currentEquip, rec.operator || '未選択', rec.workerCount || 1, rec.partNo,
      rec.start, rec.end, rec.count, rec.defectCount || 0, rec.materialCount || 0, rec.scrapCount || 0, abnormalCount,
      secToHms(rec.runningSec), secToHms(rec.moldSec), secToHms(rec.breakSec), secToHms(rec.stopSec), parseFloat(rec.perfRate),
    ]);
  });

  sheet.getRange(1, 1, rows.length, header.length).setValues(
    rows.map(r => { const row = r.slice(); while (row.length < header.length) row.push(''); return row; })
  );
  sheet.getRange(3, 1, 1, header.length).setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
  sheet.autoResizeColumns(1, header.length);

  // 区間内訳シート（人数変更の記録単位。未記録の日報は1区間＝シフト全体として出力される）
  const segSheet = tempSs.insertSheet('作業員区間データ');
  const segHeader = ['日付', '設備名', '部品番号', '区間開始', '区間終了', '作業員', '人数', '生産数(pcs)', '性能稼働率(%)'];
  const segRows = [segHeader];
  records.forEach(rec => {
    (rec.segments || []).forEach(seg => {
      segRows.push([
        rec.date, rec.equipment || currentEquip, seg.partNo || rec.partNo, seg.start, seg.end,
        seg.operator || '未選択', seg.workerCount || 1, seg.count || 0, parseFloat(seg.perfRate) || 0,
      ]);
    });
  });
  if (segRows.length > 1) {
    segSheet.getRange(1, 1, segRows.length, segHeader.length).setValues(segRows);
    segSheet.getRange(1, 1, 1, segHeader.length).setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
    segSheet.autoResizeColumns(1, segHeader.length);
  }

  // 異常停止イベントシート（「異常停止」ボタンを押すたびに1件記録される）
  const abnormalSheet = tempSs.insertSheet('異常停止イベントデータ');
  const abnormalHeader = ['日付', '設備名', '部品番号', '開始', '終了', '停止理由カテゴリ', '補足', '不良数(pcs)'];
  const abnormalRows = [abnormalHeader];
  records.forEach(rec => {
    (rec.abnormalStopEvents || []).forEach(ev => {
      abnormalRows.push([
        rec.date, rec.equipment || currentEquip, rec.partNo, ev.start || '', ev.end || '',
        ev.category || '未入力', ev.detail || '', ev.defects || 0,
      ]);
    });
  });
  if (abnormalRows.length > 1) {
    abnormalSheet.getRange(1, 1, abnormalRows.length, abnormalHeader.length).setValues(abnormalRows);
    abnormalSheet.getRange(1, 1, 1, abnormalHeader.length).setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
    abnormalSheet.autoResizeColumns(1, abnormalHeader.length);
  }
  SpreadsheetApp.flush();

  const fileId = tempSs.getId();
  const url = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx`;
  const token = ScriptApp.getOAuthToken();
  const response = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const blob = response.getBlob().setName(`プレス作業日報_${currentEquip}_${Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd')}.xlsx`);

  // 一時ファイルは不要なのでゴミ箱へ
  DriveApp.getFileById(fileId).setTrashed(true);

  return blob;
}

function secToHms(sec) {
  sec = sec || 0;
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/* =========================================================
   7) ダッシュボード生成（現場用・報告用）
   蓄積された「日報データ」「作業員区間データ」を集計し、
   2つのダッシュボードシートを作成・更新する。
   ライブ数式ではなく、実行時点の集計値を書き込むスナップショット方式。
   スプレッドシートのメニュー「PRESS MONITOR」→「ダッシュボードを更新」、
   または自動更新（1時間ごと）で最新化される。
   ========================================================= */
const DASHBOARD_FIELD_SHEET = 'ダッシュボード_現場用';
const DASHBOARD_REPORT_SHEET = 'ダッシュボード_報告用';
const DASHBOARD_ALL_EQUIPMENT = '(全設備)';
const DASHBOARD_ALL_PART = '(全品番)';

/** スプレッドシートを開いたときに専用メニューを追加する（シンプルトリガー） */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('PRESS MONITOR')
    .addItem('ダッシュボードを更新', 'buildDashboards')
    .addSeparator()
    .addItem('自動更新を設定（1時間ごと）', 'createDashboardTrigger')
    .addItem('自動更新を停止', 'removeDashboardTriggers')
    .addToUi();
}

/** 1時間ごとにダッシュボード（ライン長向けデータを含む）を自動更新するトリガーを設定する */
function createDashboardTrigger() {
  removeDashboardTriggers();
  ScriptApp.newTrigger('buildDashboards').timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert('1時間ごとに自動更新するよう設定しました。');
}

/** 自動更新トリガーを停止する */
function removeDashboardTriggers() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'buildDashboards') { ScriptApp.deleteTrigger(t); removed++; }
  });
  if (removed > 0) SpreadsheetApp.getUi().alert('自動更新を停止しました。');
}

/**
 * ダッシュボードの本体。メニュー・トリガー・手動実行のいずれからも呼び出せる。
 * Apps Scriptエディタで直接この関数を選んで実行することもできる。
 */
function buildDashboards() {
  const ss = getReportSpreadsheet_();
  const reportRows = readReportRows_(ss);
  const segmentRows = readSegmentRows_(ss);
  const abnormalStopRows = readAbnormalStopEventRows_(ss);
  const equipmentList = uniqueValues_(reportRows.map(r => r.equipment)).sort();
  const partList = uniqueValues_(reportRows.map(r => r.partNo)).sort();

  // 前回選んでいた設備・品番フィルタを可能な範囲で引き継ぐ
  const fieldSheetExisting = ss.getSheetByName(DASHBOARD_FIELD_SHEET);
  const previousEquip = fieldSheetExisting ? String(fieldSheetExisting.getRange('B2').getValue() || DASHBOARD_ALL_EQUIPMENT) : DASHBOARD_ALL_EQUIPMENT;
  const currentEquipFilter = (previousEquip === DASHBOARD_ALL_EQUIPMENT || equipmentList.indexOf(previousEquip) >= 0)
    ? previousEquip : DASHBOARD_ALL_EQUIPMENT;
  const previousPart = fieldSheetExisting ? String(fieldSheetExisting.getRange('D2').getValue() || DASHBOARD_ALL_PART) : DASHBOARD_ALL_PART;
  const currentPartFilter = (previousPart === DASHBOARD_ALL_PART || partList.indexOf(previousPart) >= 0)
    ? previousPart : DASHBOARD_ALL_PART;

  buildFieldDashboard_(ss, reportRows, segmentRows, abnormalStopRows, equipmentList, currentEquipFilter, currentPartFilter);
  buildReportDashboard_(ss, reportRows, equipmentList);
  buildLineLeaderData_(ss, equipmentList);
}

/**
 * ライン長向けデータの更新（ダッシュボード更新と同じタイミング＝手動メニュー／自動トリガーで実行）。
 * 「日報データ」シートの全行を、設備（ライン）ごとにタブを分けて
 * ライン長向けスプレッドシート（別ファイル）へそのままコピーする。
 * ライン長向け画面（line-leader.html）はこのスプレッドシートを参照する。
 * LINE_LEADER_SPREADSHEET_ID が未設定の間は何もしない（従来通りの単一ファイル運用のため）。
 */
function buildLineLeaderData_(reportSs, equipmentList) {
  if (!LINE_LEADER_SPREADSHEET_ID) return;

  const lineSs = getLineLeaderSpreadsheet_();
  const sourceSheet = reportSs.getSheetByName(SHEET_NAME);
  if (!sourceSheet || sourceSheet.getLastRow() < 2) return;

  const allValues = sourceSheet.getRange(2, 1, sourceSheet.getLastRow() - 1, HEADER_ROW.length).getValues();
  const equipColIdx = 3; // D列 = 設備名（0始まりの配列インデックス）

  // 「全ライン」タブ：他ラインとの比較用に、全設備のデータを1つにまとめて置く
  writeLineLeaderSheet_(lineSs, '全ライン（比較用）', allValues);

  equipmentList.forEach(eq => {
    if (!eq) return;
    const rows = allValues.filter(r => String(r[equipColIdx] || '') === eq);
    writeLineLeaderSheet_(lineSs, sanitizeSheetName_(eq), rows);
  });
}

function writeLineLeaderSheet_(ss, sheetName, rows) {
  let sheet = ss.getSheetByName(sheetName);
  if (sheet) ss.deleteSheet(sheet);
  sheet = ss.insertSheet(sheetName);
  sheet.appendRow(HEADER_ROW);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, HEADER_ROW.length).setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, HEADER_ROW.length).setValues(rows);
  }
}

function sanitizeSheetName_(name) {
  // スプレッドシートのシート名に使えない記号を除去し、長さを安全な範囲に収める
  return String(name).replace(/[\[\]\*\/\\\?:]/g, '').substring(0, 90) || '未設定';
}

/**
 * ライン長向け画面（line-leader.html）からのデータ取得リクエストに応答する。
 * equipment が空／未指定の場合は「全ライン（比較用）」タブを返す。
 */
function handleGetLineLeaderData(equipment) {
  if (!LINE_LEADER_SPREADSHEET_ID) {
    return jsonResponse({ status: 'error', message: 'ライン長向けデータ用のスプレッドシートがまだ設定されていません（管理者にご確認ください）' });
  }
  const lineSs = getLineLeaderSpreadsheet_();
  const sheetName = equipment ? sanitizeSheetName_(equipment) : '全ライン（比較用）';
  const sheet = lineSs.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) {
    return jsonResponse({ status: 'ok', records: [] });
  }
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADER_ROW.length).getValues();
  return jsonResponse({ status: 'ok', records: sheetRowsToRecords_(values) });
}

/**
 * HEADER_ROW（recordToRowと同じ列順）の生データを、
 * フロント側で扱いやすいレコード形式のオブジェクトに変換する。
 */
function sheetRowsToRecords_(values) {
  return values.map(r => ({
    id: r[1],
    date: formatDateCell_(r[2], 'yyyy/MM/dd'),
    equipment: String(r[3] || ''),
    operator: String(r[4] || ''),
    workerCount: Number(r[5]) || 0,
    partNo: String(r[6] || ''),
    start: formatDateCell_(r[7], 'HH:mm:ss'),
    end: formatDateCell_(r[8], 'HH:mm:ss'),
    settingSPM: r[9],
    count: Number(r[10]) || 0,
    materialCount: Number(r[11]) || 0,
    scrapCount: Number(r[12]) || 0,
    runningSec: Number(r[14]) || 0,
    moldSec: Number(r[15]) || 0,
    breakSec: Number(r[16]) || 0,
    stopSec: Number(r[17]) || 0,
    perfRate: r[18],
    abnormalStopCount: Number(r[20]) || 0,
    defectCount: Number(r[21]) || 0,
  })).filter(rec => rec.date);
}

/**
 * スプレッドシートのセル値を日付・時刻の文字列に整形する。
 * Googleスプレッドシートは "2026/09/25" や "08:00:00" のような文字列を書き込むと
 * 自動的に日付／時刻型（Dateオブジェクト）に変換してしまうことがあり、
 * そのままだと画面表示が "Fri Sep 25 2026 00:00:00 GMT+0900 ..." のように長くなってしまう。
 * ここでDateオブジェクトかどうかを判定し、指定フォーマットの短い文字列に統一する。
 */
function formatDateCell_(value, pattern) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'Asia/Tokyo', pattern);
  }
  return String(value || '');
}

/* ---------- データ読み込み ---------- */
function readReportRows_(ss) {
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADER_ROW.length).getValues();
  return values.map(r => ({
    date: String(r[2] || ''), equipment: String(r[3] || ''), operator: String(r[4] || ''),
    workerCount: Number(r[5]) || 0, partNo: String(r[6] || ''), settingSPM: Number(r[9]) || 0, count: Number(r[10]) || 0,
    materialCount: Number(r[11]) || 0, scrapCount: Number(r[12]) || 0, stopReason: String(r[13] || ''),
    runningSec: Number(r[14]) || 0, moldSec: Number(r[15]) || 0, breakSec: Number(r[16]) || 0,
    stopSec: Number(r[17]) || 0, perfRate: Number(r[18]) || 0, stopReasonCategory: String(r[19] || 'なし'),
    abnormalStopCount: Number(r[20]) || 0,
  })).filter(r => r.date);
}

function readSegmentRows_(ss) {
  const sheet = ss.getSheetByName(SEGMENT_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, SEGMENT_HEADER_ROW.length).getValues();
  return values.map(r => ({
    date: String(r[2] || ''), equipment: String(r[3] || ''), partNo: String(r[4] || ''),
    start: String(r[5] || ''), end: String(r[6] || ''), operator: String(r[7] || ''),
    workerCount: Number(r[8]) || 0, count: Number(r[9]) || 0, perfRate: Number(r[10]) || 0,
    runningSec: Number(r[11]) || 0, moldSec: Number(r[12]) || 0, breakSec: Number(r[13]) || 0, stopSec: Number(r[14]) || 0,
  })).filter(r => r.date);
}

/**
 * 異常停止イベントデータシートを読み込む。
 * 「開始」「終了」は "HH:MM:SS" の文字列で保存されているため、秒数の差分を計算して
 * durationSec として持たせる（日をまたぐ場合は考慮しない簡易計算）。
 */
function readAbnormalStopEventRows_(ss) {
  const sheet = ss.getSheetByName(ABNORMAL_STOP_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, ABNORMAL_STOP_HEADER_ROW.length).getValues();
  return values.map(r => {
    const start = String(r[5] || '');
    const end = String(r[6] || '');
    return {
      date: String(r[2] || ''), equipment: String(r[3] || ''), partNo: String(r[4] || ''),
      start, end, category: String(r[7] || '未入力'), detail: String(r[8] || ''),
      durationSec: timeStringDiffSec_(start, end),
    };
  }).filter(r => r.date);
}

function timeStringDiffSec_(start, end) {
  const toSec = (t) => {
    const parts = String(t).split(':').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  };
  const s = toSec(start);
  const e = toSec(end);
  if (s === null || e === null) return 0;
  const diff = e - s;
  return diff >= 0 ? diff : 0;
}

function uniqueValues_(arr) {
  return [...new Set(arr.filter(v => v))];
}

function filterByEquipment_(rows, equipment) {
  if (!equipment || equipment === DASHBOARD_ALL_EQUIPMENT) return rows;
  return rows.filter(r => r.equipment === equipment);
}

function filterByPart_(rows, partNo) {
  if (!partNo || partNo === DASHBOARD_ALL_PART) return rows;
  return rows.filter(r => r.partNo === partNo);
}

/* ---------- 集計 ---------- */
function aggregateAvgByKey_(rows, keyFn, valueFn) {
  const map = {};
  rows.forEach(r => {
    const k = keyFn(r);
    if (!k) return;
    if (!map[k]) map[k] = { sum: 0, n: 0 };
    map[k].sum += valueFn(r);
    map[k].n += 1;
  });
  return Object.keys(map).sort().map(k => [k, Math.round((map[k].sum / map[k].n) * 10) / 10, map[k].n]);
}

function aggregateStopReasons_(rows) {
  const map = {};
  rows.forEach(r => {
    const k = r.stopReasonCategory || 'なし';
    if (!map[k]) map[k] = { count: 0, sec: 0 };
    map[k].count += 1;
    map[k].sec += r.stopSec;
  });
  return Object.keys(map)
    .map(k => [k, map[k].count, Math.round(map[k].sec / 60)])
    .sort((a, b) => b[2] - a[2]);
}

/**
 * 停止理由カテゴリ別の集計（異常停止イベントデータより／件数＝ボタン押下回数）。
 * ダッシュボード③は、異常停止をイベント化して以降はこちらを使用する。
 */
function aggregateStopReasonsFromEvents_(eventRows) {
  const map = {};
  eventRows.forEach(r => {
    const k = r.category || '未入力';
    if (!map[k]) map[k] = { count: 0, sec: 0 };
    map[k].count += 1;
    map[k].sec += r.durationSec;
  });
  return Object.keys(map)
    .map(k => [k, map[k].count, Math.round(map[k].sec / 60)])
    .sort((a, b) => b[2] - a[2]);
}

function aggregateStatusTotals_(rows) {
  const totals = { running: 0, mold: 0, brk: 0, stop: 0 };
  rows.forEach(r => { totals.running += r.runningSec; totals.mold += r.moldSec; totals.brk += r.breakSec; totals.stop += r.stopSec; });
  return [
    ['稼働中', Math.round(totals.running / 60)],
    ['金型交換', Math.round(totals.mold / 60)],
    ['計画停止', Math.round(totals.brk / 60)],
    ['異常停止', Math.round(totals.stop / 60)],
  ];
}

/** 日別の推移表を作る（性能稼働率・基準SPM達成率・速度ロス時間） */
function aggregateDailyTrend_(rows) {
  const map = {};
  rows.forEach(r => {
    if (!r.date) return;
    if (!map[r.date]) map[r.date] = { perfSum: 0, achieveSum: 0, lossSecSum: 0, n: 0 };
    const actualSpm = r.runningSec > 0 ? (r.count * 60 / r.runningSec) : 0;
    const achieveRate = r.settingSPM > 0 ? (actualSpm / r.settingSPM * 100) : 0;
    const idealSec = r.settingSPM > 0 ? (r.count * 60 / r.settingSPM) : 0;
    const lossSec = Math.max(0, r.runningSec - idealSec);
    map[r.date].perfSum += r.perfRate;
    map[r.date].achieveSum += achieveRate;
    map[r.date].lossSecSum += lossSec;
    map[r.date].n += 1;
  });
  return Object.keys(map).sort().map(d => {
    const m = map[d];
    return [
      d,
      Math.round((m.perfSum / m.n) * 10) / 10,
      Math.round((m.achieveSum / m.n) * 10) / 10,
      Math.round((m.lossSecSum / m.n / 60) * 10) / 10,
      m.n,
    ];
  });
}

/** 人時生産性・時間稼働率のサマリー（対象行全体の平均） */
function aggregateProductivitySummary_(rows) {
  if (rows.length === 0) return { manHourProductivity: 0, availability: 0, achieveRate: 0 };
  let totalCount = 0, totalManHours = 0, totalAvailNumerator = 0, totalAvailDenominator = 0, achieveSum = 0, achieveN = 0;
  rows.forEach(r => {
    totalCount += r.count;
    totalManHours += (r.workerCount || 1) * (r.runningSec / 3600);
    totalAvailNumerator += r.runningSec;
    totalAvailDenominator += (r.runningSec + r.moldSec + r.breakSec + r.stopSec);
    if (r.settingSPM > 0 && r.runningSec > 0) {
      const actualSpm = r.count * 60 / r.runningSec;
      achieveSum += (actualSpm / r.settingSPM * 100);
      achieveN += 1;
    }
  });
  return {
    manHourProductivity: totalManHours > 0 ? Math.round((totalCount / totalManHours) * 10) / 10 : 0,
    availability: totalAvailDenominator > 0 ? Math.round((totalAvailNumerator / totalAvailDenominator) * 1000) / 10 : 0,
    achieveRate: achieveN > 0 ? Math.round((achieveSum / achieveN) * 10) / 10 : 0,
  };
}

/** 作業人数別の人時生産性（区間データより） */
function aggregateManHourProductivityByWorkerCount_(segRows) {
  const map = {};
  segRows.forEach(r => {
    const k = r.workerCount || 1;
    const manHours = k * (r.runningSec / 3600);
    if (manHours <= 0) return;
    if (!map[k]) map[k] = { count: 0, manHours: 0, n: 0 };
    map[k].count += r.count;
    map[k].manHours += manHours;
    map[k].n += 1;
  });
  return Object.keys(map).map(Number).sort((a, b) => a - b).map(k => [
    k + '名',
    map[k].manHours > 0 ? Math.round((map[k].count / map[k].manHours) * 10) / 10 : 0,
    map[k].n,
  ]);
}

/* ---------- シート構築ヘルパー ---------- */
function clearSheet_(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (sheet) {
    sheet.getCharts().forEach(c => sheet.removeChart(c));
    sheet.clear();
  } else {
    sheet = ss.insertSheet(name);
  }
  sheet.setTabColor('#0f9d63');
  return sheet;
}

function writeTable_(sheet, startRow, startCol, headers, rows, title) {
  let r = startRow;
  if (title) {
    sheet.getRange(r, startCol, 1, 1).setValue(title).setFontWeight('bold').setFontSize(11).setFontColor('#1a2233');
    r += 1;
  }
  sheet.getRange(r, startCol, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1a2233').setFontColor('#ffffff');
  r += 1;
  if (rows.length > 0) {
    sheet.getRange(r, startCol, rows.length, headers.length).setValues(rows);
  }
  return { headerRow: r - 1, firstDataRow: r, lastDataRow: r + Math.max(rows.length, 1) - 1 };
}

/* ---------- 現場用ダッシュボード ---------- */
function buildFieldDashboard_(ss, reportRows, segmentRows, abnormalStopRows, equipmentList, currentFilter, currentPartFilter) {
  const sheet = clearSheet_(ss, DASHBOARD_FIELD_SHEET);
  sheet.getRange('A1:H1').merge().setValue('現場用ダッシュボード').setFontWeight('bold').setFontSize(16).setFontColor('#ffffff').setBackground('#1a2233');

  sheet.getRange('A2').setValue('設備で絞り込み：').setFontWeight('bold');
  const b2 = sheet.getRange('B2').setValue(currentFilter);
  b2.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList([DASHBOARD_ALL_EQUIPMENT].concat(equipmentList), true).setAllowInvalid(false).build());

  const partList = uniqueValues_(reportRows.map(r => r.partNo)).sort();
  sheet.getRange('C2').setValue('品番で絞り込み：').setFontWeight('bold');
  const d2 = sheet.getRange('D2').setValue(currentPartFilter || DASHBOARD_ALL_PART);
  d2.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList([DASHBOARD_ALL_PART].concat(partList), true).setAllowInvalid(false).build());

  sheet.getRange('A3').setValue('最終更新: ' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm') +
    '　※設備・品番を変更した場合は「PRESS MONITOR」メニューから再度更新してください').setFontColor('#9AA5B1').setFontSize(9);

  const filteredByEquip = filterByEquipment_(reportRows, currentFilter);
  const filtered = filterByPart_(filteredByEquip, currentPartFilter);
  const filteredSeg = filterByPart_(filterByEquipment_(segmentRows, currentFilter), currentPartFilter);
  const filteredAbnormal = filterByPart_(filterByEquipment_(abnormalStopRows, currentFilter), currentPartFilter);

  // サマリー指標（画像の「良い状態」目安をあわせて表示）
  const summary = aggregateProductivitySummary_(filtered);
  const summaryRows = [
    ['平均性能稼働率(%)', filtered.length ? Math.round((filtered.reduce((s, r) => s + r.perfRate, 0) / filtered.length) * 10) / 10 : 0, '目安：95%以上'],
    ['平均基準SPM達成率(%)', summary.achieveRate, '目安：80%以上'],
    ['時間稼働率(%)', summary.availability, '稼働時間 ÷ 全体時間'],
    ['人時生産性(pcs/人時)', summary.manHourProductivity, '生産数 ÷ (人数×稼働時間)'],
  ];
  const t0 = writeTable_(sheet, 5, 1, ['指標', '値', '目安・補足'], summaryRows, 'サマリー指標');

  // ① 日別トレンド（性能稼働率・基準SPM達成率・速度ロス時間）
  const startRow1 = t0.lastDataRow + 3;
  const dailyTrend = aggregateDailyTrend_(filtered);
  const t1 = writeTable_(sheet, startRow1, 1,
    ['日付', '平均性能稼働率(%)', '平均基準SPM達成率(%)', '速度ロス時間(分/件)', '件数'], dailyTrend,
    '① 日別トレンド（性能稼働率／基準SPM達成率）');
  if (dailyTrend.length > 0) {
    sheet.insertChart(sheet.newChart().setChartType(Charts.ChartType.LINE)
      .addRange(sheet.getRange(t1.headerRow, 1, dailyTrend.length + 1, 3))
      .setPosition(startRow1, 6, 0, 0)
      .setOption('title', '日別トレンド：性能稼働率／基準SPM達成率')
      .setOption('legend', { position: 'top' })
      .setOption('vAxis', { title: '%', minValue: 0 })
      .build());
  }

  // ② 品番別 平均性能稼働率（品番フィルタが「全品番」のときのみ意味を持つ一覧）
  const startRow2 = t1.lastDataRow + 3;
  const byPart = aggregateAvgByKey_(filteredByEquip, r => r.partNo, r => r.perfRate);
  const t2 = writeTable_(sheet, startRow2, 1, ['品番', '平均性能稼働率(%)', '件数'], byPart, '② 品番別 平均性能稼働率');
  if (byPart.length > 0) {
    sheet.insertChart(sheet.newChart().setChartType(Charts.ChartType.COLUMN)
      .addRange(sheet.getRange(t2.headerRow, 1, byPart.length + 1, 2))
      .setPosition(startRow2, 6, 0, 0)
      .setOption('title', '品番別 平均性能稼働率')
      .setOption('legend', { position: 'none' })
      .build());
  }

  // ③ 停止理由カテゴリ別（異常停止イベントデータより／異常停止時間の多い順）
  const startRow3 = t2.lastDataRow + 3;
  const byReason = aggregateStopReasonsFromEvents_(filteredAbnormal);
  const t3 = writeTable_(sheet, startRow3, 1, ['停止理由カテゴリ', '発生回数', '異常停止合計(分)'], byReason, '③ 停止理由カテゴリ別（異常停止時間の多い順）');
  if (byReason.length > 0) {
    sheet.insertChart(sheet.newChart().setChartType(Charts.ChartType.BAR)
      .addRange(sheet.getRange(t3.headerRow, 1, byReason.length + 1, 1))
      .addRange(sheet.getRange(t3.headerRow, 3, byReason.length + 1, 1))
      .setPosition(startRow3, 6, 0, 0)
      .setOption('title', '停止理由カテゴリ別 異常停止時間(分)')
      .setOption('legend', { position: 'none' })
      .build());
  }

  // ④ 稼働時間の内訳
  const startRow4 = t3.lastDataRow + 3;
  const statusTotals = aggregateStatusTotals_(filtered);
  const t4 = writeTable_(sheet, startRow4, 1, ['区分', '合計時間(分)'], statusTotals, '④ 稼働時間の内訳');
  sheet.insertChart(sheet.newChart().setChartType(Charts.ChartType.PIE)
    .addRange(sheet.getRange(t4.headerRow, 1, statusTotals.length + 1, 2))
    .setPosition(startRow4, 6, 0, 0)
    .setOption('title', '稼働時間の内訳（分）')
    .build());

  // ⑤ 作業人数別 平均性能稼働率（区間データより）
  const startRow5 = t4.lastDataRow + 3;
  const byWorkerCount = aggregateAvgByKey_(filteredSeg, r => String(r.workerCount) + '名', r => r.perfRate)
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
  const t5 = writeTable_(sheet, startRow5, 1, ['作業人数', '平均性能稼働率(%)', '区間数'], byWorkerCount,
    '⑤ 作業人数別 平均性能稼働率（「人数変更を記録」区間データより）');
  if (byWorkerCount.length > 0) {
    sheet.insertChart(sheet.newChart().setChartType(Charts.ChartType.COLUMN)
      .addRange(sheet.getRange(t5.headerRow, 1, byWorkerCount.length + 1, 2))
      .setPosition(startRow5, 6, 0, 0)
      .setOption('title', '作業人数別 平均性能稼働率')
      .setOption('legend', { position: 'none' })
      .setOption('vAxis', { title: '%', minValue: 0 })
      .build());
  }

  // ⑥ 作業人数別 人時生産性（区間データより）
  const startRow6 = t5.lastDataRow + 3;
  const manHourByWorker = aggregateManHourProductivityByWorkerCount_(filteredSeg);
  const t6 = writeTable_(sheet, startRow6, 1, ['作業人数', '人時生産性(pcs/人時)', '区間数'], manHourByWorker,
    '⑥ 作業人数別 人時生産性（増員の効果を見る参考値）');
  if (manHourByWorker.length > 0) {
    sheet.insertChart(sheet.newChart().setChartType(Charts.ChartType.COLUMN)
      .addRange(sheet.getRange(t6.headerRow, 1, manHourByWorker.length + 1, 2))
      .setPosition(startRow6, 6, 0, 0)
      .setOption('title', '作業人数別 人時生産性')
      .setOption('legend', { position: 'none' })
      .build());
  }
  sheet.getRange(startRow6 + Math.max(manHourByWorker.length, 1) + 2, 1).setValue(
    '※⑤⑥は区間データ（人数ごとの実績を横並びで比較）に基づく参考値です。人数を増やしても数値が上がっていなければ、増員の効果が出ていない可能性があります。' +
    '区間数が少ないうちは参考値としてご覧ください。'
  ).setFontColor('#9AA5B1').setFontSize(9).setWrap(true);

  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidths(2, 4, 130);
}

/* ---------- 報告用ダッシュボード ---------- */
function buildReportDashboard_(ss, reportRows, equipmentList) {
  const sheet = clearSheet_(ss, DASHBOARD_REPORT_SHEET);
  sheet.getRange('A1:F1').merge().setValue('報告用ダッシュボード（サマリー）').setFontWeight('bold').setFontSize(16).setFontColor('#ffffff').setBackground('#1a2233');
  sheet.getRange('A2').setValue('最終更新: ' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')).setFontColor('#9AA5B1').setFontSize(9);

  const totalCount = reportRows.reduce((s, r) => s + r.count, 0);
  const avgRate = reportRows.length ? Math.round((reportRows.reduce((s, r) => s + r.perfRate, 0) / reportRows.length) * 10) / 10 : 0;
  const summary = [
    ['対象期間の日報件数', reportRows.length],
    ['総生産数(pcs)', totalCount],
    ['平均性能稼働率(%)', avgRate],
    ['対象設備数', equipmentList.length],
  ];
  const t0 = writeTable_(sheet, 4, 1, ['指標', '値'], summary, 'サマリー');

  // 月次 性能稼働率の推移
  const byMonth = aggregateAvgByKey_(reportRows, r => r.date.slice(0, 7), r => r.perfRate);
  const startRow1 = t0.lastDataRow + 3;
  const t1 = writeTable_(sheet, startRow1, 1, ['年月', '平均性能稼働率(%)', '件数'], byMonth, '月次 性能稼働率の推移');
  if (byMonth.length > 0) {
    sheet.insertChart(sheet.newChart().setChartType(Charts.ChartType.LINE)
      .addRange(sheet.getRange(t1.headerRow, 1, byMonth.length + 1, 2))
      .setPosition(startRow1, 4, 0, 0)
      .setOption('title', '月次 性能稼働率の推移')
      .setOption('legend', { position: 'none' })
      .setOption('vAxis', { title: '%', minValue: 0 })
      .build());
  }

  // 設備別比較
  const byEquip = aggregateAvgByKey_(reportRows, r => r.equipment, r => r.perfRate);
  const startRow2 = t1.lastDataRow + 3;
  const t2 = writeTable_(sheet, startRow2, 1, ['設備名', '平均性能稼働率(%)', '件数'], byEquip, '設備別 比較');
  if (byEquip.length > 0) {
    sheet.insertChart(sheet.newChart().setChartType(Charts.ChartType.COLUMN)
      .addRange(sheet.getRange(t2.headerRow, 1, byEquip.length + 1, 2))
      .setPosition(startRow2, 4, 0, 0)
      .setOption('title', '設備別 平均性能稼働率')
      .setOption('legend', { position: 'none' })
      .build());
  }

  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidths(2, 2, 110);
}
