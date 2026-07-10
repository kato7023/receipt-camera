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
 */
function writeLog(entry) {
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
