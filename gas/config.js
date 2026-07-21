/**
 * 設定管理 — スプレッドシートからマスタデータを読み取る
 * PropertiesService で永続キャッシュし、スプレッドシートへのアクセスを最小化
 * 自動更新: 180日（半年）経過で自動リフレッシュ
 * 手動更新: GAS エディタで refreshMasterCache を実行
 */

// スプレッドシートID（セットアップ時に設定）
const SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '';

// Google Drive 保存先フォルダID（セットアップ時に設定）
const DRIVE_ROOT_FOLDER_ID = PropertiesService.getScriptProperties().getProperty('DRIVE_ROOT_FOLDER_ID') || '';

// キャッシュ有効期間（ミリ秒）
const CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180日 = 約半年

/**
 * PropertiesService から取得、期限切れならスプレッドシートから再読み込み
 */
function getCachedOrFetch(propKey, fetchFn) {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty(propKey);

  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      // 有効期限チェック
      if (parsed._cachedAt && (Date.now() - parsed._cachedAt) < CACHE_TTL_MS) {
        return parsed.data;
      }
    } catch (e) {
      // キャッシュが壊れている場合はスルー
    }
  }

  // スプレッドシートから読み込み
  const data = fetchFn();

  // PropertiesService に保存（タイムスタンプ付き）
  const toStore = JSON.stringify({ data: data, _cachedAt: Date.now() });
  // PropertiesService の上限は 9KB/キー なので確認
  if (toStore.length < 9000) {
    props.setProperty(propKey, toStore);
  }

  return data;
}

/**
 * 会社一覧をスプレッドシートから取得（キャッシュ付き）
 */
function getCompanies() {
  return getCachedOrFetch('CACHE_COMPANIES', function() {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName('会社マスタ');
    if (!sheet) throw new Error('「会社マスタ」シートが見つかりません');

    const data = sheet.getDataRange().getValues();
    const companies = [];

    // ヘッダー行をスキップ（1行目）
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[0]) continue; // ID が空なら無視

      companies.push({
        id: String(row[0]),
        name: String(row[1]),
        freeeCompanyId: Number(row[2]),
        active: row[3] !== false && row[3] !== 'FALSE',
        isMajor: row[4] === true || row[4] === 'TRUE',
        shortName: row[5] ? String(row[5]) : '',
      });
    }

    return companies.filter(c => c.active);
  });
}

/**
 * 支払い方法一覧をスプレッドシートから取得（キャッシュ付き）
 */
function getPaymentMethods() {
  return getCachedOrFetch('CACHE_PAYMENT_METHODS', function() {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName('支払い方法マスタ');
    if (!sheet) throw new Error('「支払い方法マスタ」シートが見つかりません');

    const data = sheet.getDataRange().getValues();
    const methods = [];

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
  });
}

/**
 * 指定した事業所で利用可能な経費科目テンプレート一覧を取得する（キャッシュ付き、会社ごと）
 */
function getExpenseApplicationLineTemplates(freeeCompanyId) {
  return getCachedOrFetch('CACHE_EXPENSE_TEMPLATES_' + freeeCompanyId, function() {
    const req = new FreeeAPI.Request('expense_application_line_templates').addParam('company_id', freeeCompanyId);
    const response = req.requestGET();
    return (response && response.expense_application_line_templates) || [];
  });
}

/**
 * 経費申請作成時にデフォルトで使う経費科目テンプレートIDを取得する。
 *
 * このアプリには撮影時に経費科目(勘定科目)を選択するUIがまだ無いため、
 * 汎用的に使える「消耗品費」系のテンプレートを優先的に採用し、
 * 無ければ先頭のテンプレートにフォールバックする（暫定対応）。
 * @returns {number|null} テンプレートID。テンプレートが1件も無ければ null
 */
function getDefaultExpenseApplicationLineTemplateId(freeeCompanyId) {
  const templates = getExpenseApplicationLineTemplates(freeeCompanyId);
  if (!templates.length) return null;

  const fallback = templates.find(function(t) { return t.name && t.name.indexOf('消耗品') !== -1; });
  return (fallback || templates[0]).id;
}

/**
 * マスタキャッシュを手動リフレッシュ
 * スプレッドシートでマスタデータを変更した後に実行してください
 * GAS エディタで「refreshMasterCache」を選択して ▶ 実行
 */
function refreshMasterCache() {
  const props = PropertiesService.getScriptProperties();

  // キャッシュをクリア
  props.deleteProperty('CACHE_COMPANIES');
  props.deleteProperty('CACHE_PAYMENT_METHODS');
  Logger.log('🗑️ キャッシュをクリアしました');

  // 再読み込み
  const companies = getCompanies();
  Logger.log('✅ 会社マスタを再読み込み: ' + companies.length + '件');

  const methods = getPaymentMethods();
  Logger.log('✅ 支払い方法マスタを再読み込み: ' + methods.length + '件');

  Logger.log('🎉 マスタキャッシュの更新完了！');
}

/**
 * ログをスプレッドシートに記録
 *
 * requestId・receiptIndexは、通信断でクライアントがレスポンスを受け取れなかった際に
 * doGet(action=uploadStatus)からこのシートを検索して結果を復元するためのキーとして使う
 * （CacheServiceは短命な「受信済みマーカー」にのみ使い、結果の真実は常にこのシートに残す）。
 */
function writeLog(entry) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName('アップロードログ');

  if (!sheet) {
    sheet = ss.insertSheet('アップロードログ');
    sheet.appendRow([
      'タイムスタンプ', 'アクション', '会社名', '支払い方法',
      'グループ名', 'Drive File ID', 'Freee Receipt ID',
      'Freee Expense ID', 'ステータス', 'エラー', 'Request ID', 'Receipt Index'
    ]);
  } else if (sheet.getLastColumn() < 12) {
    // 既存シートに新しい列を追加（自己修復。何度呼ばれても安全）
    sheet.getRange(1, 11, 1, 2).setValues([['Request ID', 'Receipt Index']]);
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
    entry.requestId || '',
    entry.receiptIndex !== undefined && entry.receiptIndex !== null ? entry.receiptIndex : '',
  ]);
}

/**
 * 撮影直後のバックグラウンドバックアップを「撮影記録」シートに記録する。
 * PWA側のローカルデータ（IndexedDB）が失われても、Drive上の画像とこのシートの記録から
 * 内容を追跡・復旧できるようにするための、アップロード操作とは独立した保全用の記録。
 */
function appendCaptureRecord(entry) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName('撮影記録');

  if (!sheet) {
    sheet = ss.insertSheet('撮影記録');
    sheet.appendRow([
      'タイムスタンプ', '会社名', '支払い方法', 'グループ名', '金額', 'メモ', '撮影日時', 'Drive File ID', 'Backup ID'
    ]);
    sheet.getRange(1, 1, 1, 9).setFontWeight('bold').setBackground('#4a86c8').setFontColor('white');
  } else if (sheet.getLastColumn() < 9) {
    // 既存シートに Backup ID 列を追加（自己修復。何度呼ばれても安全）
    sheet.getRange(1, 9, 1, 1).setValues([['Backup ID']]);
  }

  sheet.appendRow([
    entry.timestamp,
    entry.companyName,
    entry.paymentMethod,
    entry.groupName,
    entry.amount,
    entry.memo,
    entry.capturedAt,
    entry.driveFileId,
    entry.backupId || '',
  ]);
}

/**
 * backupIdをキーに「撮影記録」シートを検索し、既にバックアップ済みなら
 * そのDriveファイルIDを返す（見つからなければ null）。
 * backupReceipt の冪等化に使う（同じレシートを二重にDriveへ保存しないため）。
 */
function findCaptureRecordByBackupId(backupId) {
  if (!backupId) return null;
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('撮影記録');
  if (!sheet) return null;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  if (sheet.getLastColumn() < 9) return null; // Backup ID 列がまだ無い

  // 8列目=Drive File ID, 9列目=Backup ID
  const data = sheet.getRange(2, 8, lastRow - 1, 2).getValues();
  for (const row of data) {
    if (String(row[1]) === String(backupId)) {
      const driveFileId = String(row[0] || '');
      if (driveFileId) return driveFileId;
    }
  }
  return null;
}

/**
 * requestIdをキーに「アップロードログ」シートを検索し、UploadResult[]相当の形に復元する。
 * doGet(action=uploadStatus)から使用する（結果の真実は常にこのシート）。
 * @returns {Array<{receiptIndex:number, driveFileId:string, freeeReceiptId:string, freeeExpenseId:string, status:string, error:string}>}
 */
function findLoggedResultsByRequestId(requestId) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('アップロードログ');
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
  const results = [];

  for (const row of data) {
    const rowRequestId = row[10];
    if (String(rowRequestId) !== String(requestId)) continue;

    results.push({
      receiptIndex: Number(row[11]),
      driveFileId: String(row[5] || ''),
      freeeReceiptId: String(row[6] || ''),
      freeeExpenseId: String(row[7] || ''),
      status: String(row[8] || 'error'),
      error: String(row[9] || ''),
    });
  }

  return results;
}

/**
 * OCR同期用の最新状態シートを作成・取得する。
 * アップロードログは履歴として残し、OCRシートは証憑ID単位の最新値だけを保持する。
 */
function getOcrSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName('領収書OCR');
  const headers = [
    'Freee事業所ID', 'Freee Receipt ID', 'Freee Expense ID', '支払先会社名',
    'T番号', 'OCR金額', 'OCR発行日', 'OCR状態', '最終取得日時', 'エラー'
  ];
  if (!sheet) {
    sheet = ss.insertSheet('領収書OCR');
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#4a86c8').setFontColor('white');
  } else if (sheet.getLastColumn() < headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

function upsertOcrRecord_(record) {
  const sheet = getOcrSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const keys = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0]) === String(record.freeeCompanyId) && String(keys[i][1]) === String(record.freeeReceiptId)) {
        sheet.getRange(i + 2, 1, 1, 10).setValues([[record.freeeCompanyId, record.freeeReceiptId, record.freeeExpenseId || '', record.partnerName || '', record.registrationNumber || '', record.amount ?? '', record.issueDate || '', record.state, record.fetchedAt, record.error || '']]);
        return;
      }
    }
  }
  sheet.appendRow([record.freeeCompanyId, record.freeeReceiptId, record.freeeExpenseId || '', record.partnerName || '', record.registrationNumber || '', record.amount ?? '', record.issueDate || '', record.state, record.fetchedAt, record.error || '']);
}

/** アプリが差分取得するためのOCR状態一覧 */
function getOcrUpdates(since) {
  const sheet = getOcrSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const sinceMs = since ? new Date(since).getTime() : 0;
  return sheet.getRange(2, 1, lastRow - 1, 10).getValues().filter(function(row) {
    return !sinceMs || new Date(row[8]).getTime() > sinceMs;
  }).map(function(row) {
    return {
      freeeCompanyId: Number(row[0]),
      freeeReceiptId: Number(row[1]),
      freeeExpenseId: row[2] ? Number(row[2]) : null,
      partnerName: String(row[3] || ''),
      registrationNumber: String(row[4] || ''),
      amount: row[5] === '' ? null : Number(row[5]),
      issueDate: String(row[6] || ''),
      state: String(row[7] || 'done'),
      fetchedAt: row[8] instanceof Date ? row[8].toISOString() : String(row[8] || ''),
      error: String(row[9] || ''),
    };
  });
}
