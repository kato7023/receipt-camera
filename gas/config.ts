/**
 * 設定管理 — スプレッドシートからマスタデータを読み取る
 */

// スプレッドシートID（セットアップ時に設定）
const SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '';

// Google Drive 保存先フォルダID（セットアップ時に設定）
const DRIVE_ROOT_FOLDER_ID = PropertiesService.getScriptProperties().getProperty('DRIVE_ROOT_FOLDER_ID') || '';

/**
 * 会社一覧をスプレッドシートから取得
 */
function getCompanies(): Company[] {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('会社マスタ');
  if (!sheet) throw new Error('「会社マスタ」シートが見つかりません');

  const data = sheet.getDataRange().getValues();
  const companies: Company[] = [];

  // ヘッダー行をスキップ（1行目）
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue; // ID が空なら無視

    companies.push({
      id: String(row[0]),
      name: String(row[1]),
      freeeCompanyId: Number(row[2]),
      active: row[3] !== false && row[3] !== 'FALSE',
    });
  }

  return companies.filter(c => c.active);
}

/**
 * 支払い方法一覧をスプレッドシートから取得
 */
function getPaymentMethods(): PaymentMethod[] {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('支払い方法マスタ');
  if (!sheet) throw new Error('「支払い方法マスタ」シートが見つかりません');

  const data = sheet.getDataRange().getValues();
  const methods: PaymentMethod[] = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;

    methods.push({
      id: String(row[0]),
      name: String(row[1]),
      companyId: row[2] ? String(row[2]) : null,
      isMajor: row[3] === true || row[3] === 'TRUE',
      active: row[4] !== false && row[4] !== 'FALSE',
    });
  }

  return methods.filter(m => m.active);
}

/**
 * ログをスプレッドシートに記録
 */
function writeLog(entry: LogEntry): void {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName('アップロードログ');

  if (!sheet) {
    sheet = ss.insertSheet('アップロードログ');
    sheet.appendRow([
      'タイムスタンプ', 'アクション', '会社名', '支払い方法',
      'グループ名', 'Drive File ID', 'Freee Receipt ID',
      'Freee Expense ID', 'ステータス', 'エラー'
    ]);
  }

  sheet.appendRow([
    entry.timestamp,
    entry.action,
    entry.companyName,
    entry.paymentMethod,
    entry.groupName,
    entry.driveFileId,
    entry.freeeReceiptId,
    entry.freeeExpenseId,
    entry.status,
    entry.error,
  ]);
}
