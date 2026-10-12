/* ==========================================================
   PRESS MONITOR — 設定値・定数
   このファイルは他のどのJSファイルよりも先に読み込まれます。
   ========================================================== */

const STORAGE = {
  HISTORY: 'pm_history_v1',
  SETTINGS: 'pm_settings_v1',
  MASTERS: 'pm_masters_v2', // 品番／作業員マスタのローカルキャッシュ（クラウドから取得）
  SHIFT_STATE: 'pm_shift_state_v1', // 製造中のデータ（ブラウザ更新時の復元用）。製造終了保存 or クリア操作でのみ削除する
  LAST_OPERATORS: 'pm_last_operators_v1', // 前回選択した作業員（最大4名）。次回起動時に自動入力する
};

const CONFIG = {
  INITIAL_TARGET_COUNT: 1200,
  PERFORMANCE_GOOD_LIMIT: 95,
  PERFORMANCE_NORMAL_LIMIT: 85,
  SYNC_RETRY_INTERVAL_MS: 30000,
  MASTER_AUTO_REFRESH_MS: 10 * 60 * 1000, // 10分ごとにマスタをバックグラウンド再取得
  // 部品番号の候補として表示する工程名（品番マスタの「工程名」列に含まれる文字列）。
  // 工程名の列が無い／空欄の品番は絞り込み対象外（全設備で表示）。
  PART_PROCESS_FILTER: 'プレス',
};

// アプリ固有の設定（クラウド接続情報など）。gasUrl未設定時はクラウド機能は使えません。
const DEFAULT_SETTINGS = {
  gasUrl: '',
  defaultEmail: 'factory-report@example.com',
  // 設備名リストは端末側で管理（品番・作業員のようにクラウド化していません）
  equipmentList: ['1軸100tプレス', '2軸200tプレス', '高速300tプレス', 'Aライン プレス機', 'Bライン プレス機'],
};

// 品番・作業員・停止理由マスタの初期値（クラウド未接続時のフォールバック用）
const DEFAULT_MASTERS = {
  partMasters: [
    { part: 'SP-200', spm: 15.0, process: '', machine: '' },
    { part: 'SP-210', spm: 18.0, process: '', machine: '' },
  ],
  operators: ['山田', '佐藤', '鈴木', '田中'],
  stopReasons: ['なし', '段取り替え', '材料待ち', '品質確認・不良対応', '設備トラブル', '人員不足・応援待ち', '朝礼・清掃・保全', 'その他'],
  lastSyncedAt: null,
};
