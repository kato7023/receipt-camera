/**
 * メインエントリ — GAS Web App
 * doGet: マスタデータ取得（会社一覧、支払い方法一覧）
 * doPost: 画像アップロード → Drive保存 → Freee連携
 */

/**
 * GET リクエストハンドラ
 */
function doGet(e) {
  try {
    const action = e.parameter.action;

    let data;

    switch (action) {
      case 'companies':
        data = getCompanies();
        break;
      case 'paymentMethods':
        data = getPaymentMethods();
        break;
      default:
        return jsonResponse({ success: false, error: `不明なアクション: ${action}` });
    }

    return jsonResponse({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('doGet error:', message);
    return jsonResponse({ success: false, error: message });
  }
}

/**
 * POST リクエストハンドラ
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.action !== 'upload') {
      return jsonResponse({ success: false, error: `不明なアクション: ${body.action}` });
    }

    const results = processUpload(body.receipts);
    return jsonResponse({ success: true, data: results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('doPost error:', message);
    return jsonResponse({ success: false, error: message });
  }
}

/**
 * アップロード処理のメインロジック
 */
function processUpload(receipts) {
  const companies = getCompanies();
  const results = [];

  // グループ別にレシートを整理
  const grouped = new Map();
  const individuals = [];

  receipts.forEach((item, index) => {
    if (item.groupName) {
      const key = `${item.companyId}:${item.groupName}`;
      if (!grouped.has(key)) {
        grouped.set(key, { indices: [], items: [] });
      }
      const group = grouped.get(key);
      group.indices.push(index);
      group.items.push(item);
    } else {
      individuals.push({ index, item });
    }
  });

  // 個別レシートを処理
  for (const { index, item } of individuals) {
    const result = processSingleReceipt(index, item, companies);
    results.push(result);
  }

  // グループレシートを処理
  for (const [, group] of grouped) {
    const groupResults = processGroupReceipts(group.indices, group.items, companies);
    results.push(...groupResults);
  }

  return results;
}

/**
 * 個別レシートの処理
 */
function processSingleReceipt(index, item, companies) {
  const company = companies.find(c => c.id === item.companyId);
  if (!company) {
    return { receiptIndex: index, driveFileId: '', status: 'error', error: `会社ID ${item.companyId} が見つかりません` };
  }

  let driveFileId = '';

  try {
    // Step 1: Drive に保存（最優先 — 画像保全）
    driveFileId = saveImageToDrive(item.imageBase64, item.mimeType, company.name, item.capturedAt);

    // Step 2: Freee に証憑アップロード
    const freeeReceiptId = uploadReceiptToFreee(driveFileId, company.freeeCompanyId);

    // Step 3: 経費精算下書き作成
    const freeeExpenseId = createExpenseDraft(
      company.freeeCompanyId,
      freeeReceiptId,
      item.paymentMethodName,
      item.memo,
      item.capturedAt
    );

    // ログ記録
    writeLog({
      timestamp: new Date().toISOString(),
      action: 'upload_single',
      companyName: company.name,
      paymentMethod: item.paymentMethodName,
      groupName: '',
      driveFileId,
      freeeReceiptId: String(freeeReceiptId),
      freeeExpenseId: String(freeeExpenseId),
      status: 'completed',
      error: '',
    });

    return { receiptIndex: index, driveFileId, freeeReceiptId, freeeExpenseId, status: 'completed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    writeLog({
      timestamp: new Date().toISOString(),
      action: 'upload_single',
      companyName: company.name,
      paymentMethod: item.paymentMethodName,
      groupName: '',
      driveFileId,
      freeeReceiptId: '',
      freeeExpenseId: '',
      status: 'error',
      error: message,
    });

    return {
      receiptIndex: index,
      driveFileId,
      status: driveFileId ? 'partial' : 'error',
      error: message,
    };
  }
}

/**
 * グループレシートの処理
 */
function processGroupReceipts(indices, items, companies) {
  const firstItem = items[0];
  const company = companies.find(c => c.id === firstItem.companyId);
  if (!company) {
    return indices.map(index => ({
      receiptIndex: index,
      driveFileId: '',
      status: 'error',
      error: `会社ID ${firstItem.companyId} が見つかりません`,
    }));
  }

  const driveFileIds = [];
  const freeeReceiptIds = [];

  try {
    // Step 1: 全画像を Drive に保存（画像保全優先）
    for (const item of items) {
      const fileId = saveImageToDrive(item.imageBase64, item.mimeType, company.name, item.capturedAt);
      driveFileIds.push(fileId);
    }

    // Step 2: 全画像を Freee に証憑アップロード
    for (const fileId of driveFileIds) {
      const receiptId = uploadReceiptToFreee(fileId, company.freeeCompanyId);
      freeeReceiptIds.push(receiptId);
    }

    // Step 3: グループ経費精算下書き作成（N明細を1経費精算に）
    const freeeExpenseId = createGroupExpenseDraft(
      company.freeeCompanyId,
      freeeReceiptIds,
      firstItem.paymentMethodName,
      firstItem.groupName || 'グループ',
      firstItem.capturedAt
    );

    // ログ記録
    writeLog({
      timestamp: new Date().toISOString(),
      action: 'upload_group',
      companyName: company.name,
      paymentMethod: firstItem.paymentMethodName,
      groupName: firstItem.groupName || '',
      driveFileId: driveFileIds.join(','),
      freeeReceiptId: freeeReceiptIds.join(','),
      freeeExpenseId: String(freeeExpenseId),
      status: 'completed',
      error: '',
    });

    return indices.map((index, i) => ({
      receiptIndex: index,
      driveFileId: driveFileIds[i],
      freeeReceiptId: freeeReceiptIds[i],
      freeeExpenseId,
      status: 'completed',
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    writeLog({
      timestamp: new Date().toISOString(),
      action: 'upload_group',
      companyName: company.name,
      paymentMethod: firstItem.paymentMethodName,
      groupName: firstItem.groupName || '',
      driveFileId: driveFileIds.join(','),
      freeeReceiptId: freeeReceiptIds.join(','),
      freeeExpenseId: '',
      status: 'error',
      error: message,
    });

    return indices.map((index, i) => ({
      receiptIndex: index,
      driveFileId: driveFileIds[i] || '',
      status: driveFileIds[i] ? 'partial' : 'error',
      error: message,
    }));
  }
}

/**
 * JSON レスポンスを生成
 */
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 初回セットアップ用関数
// GAS エディタから手動実行してください
// ============================================================

/**
 * スプレッドシートにマスタシートを自動作成
 * GAS エディタで「setupMasterSheets」を選択して ▶ 実行
 */
function setupMasterSheets() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // --- 会社マスタ ---
  let companySheet = ss.getSheetByName('会社マスタ');
  if (!companySheet) {
    companySheet = ss.insertSheet('会社マスタ');
    // ヘッダー
    companySheet.appendRow(['会社ID', '会社名', 'Freee事業所ID', '有効', 'メインボタン', '略称']);
    // ヘッダー行を太字に
    companySheet.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#4a86c8').setFontColor('white');
    // 列幅調整
    companySheet.setColumnWidth(1, 100);
    companySheet.setColumnWidth(2, 200);
    companySheet.setColumnWidth(3, 150);
    companySheet.setColumnWidth(4, 80);
    companySheet.setColumnWidth(5, 100);
    companySheet.setColumnWidth(6, 80);
    // 説明行
    companySheet.appendRow(['c001', '（会社名を入力）', '（FreeeのURLから取得）', 'TRUE', 'TRUE', '（略称）']);
    Logger.log('✅ 会社マスタシートを作成しました');
  } else {
    Logger.log('ℹ️ 会社マスタシートは既に存在します');
  }

  // --- 支払い方法マスタ ---
  let paymentSheet = ss.getSheetByName('支払い方法マスタ');
  if (!paymentSheet) {
    paymentSheet = ss.insertSheet('支払い方法マスタ');
    // ヘッダー
    paymentSheet.appendRow(['支払いID', '支払い方法名', '会社ID', 'メジャー', '有効']);
    paymentSheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#4a86c8').setFontColor('white');
    // 列幅調整
    paymentSheet.setColumnWidth(1, 100);
    paymentSheet.setColumnWidth(2, 150);
    paymentSheet.setColumnWidth(3, 100);
    paymentSheet.setColumnWidth(4, 80);
    paymentSheet.setColumnWidth(5, 80);
    // デフォルト支払い方法
    const defaults = [
      ['p001', '現金',     '', true, true],
      ['p002', 'VISA',    '', true, true],
      ['p003', 'JCB',     '', true, true],
      ['p004', 'AMEX',    '', true, true],
      ['p005', '交通系IC', '', false, true],
      ['p006', 'QR決済',   '', false, true],
    ];
    for (const row of defaults) {
      paymentSheet.appendRow(row);
    }
    Logger.log('✅ 支払い方法マスタシートを作成しました（デフォルト6件）');
  } else {
    Logger.log('ℹ️ 支払い方法マスタシートは既に存在します');
  }

  // --- アップロードログ ---
  let logSheet = ss.getSheetByName('アップロードログ');
  if (!logSheet) {
    logSheet = ss.insertSheet('アップロードログ');
    logSheet.appendRow([
      'タイムスタンプ', 'アクション', '会社名', '支払い方法',
      'グループ名', 'Drive File ID', 'Freee Receipt ID',
      'Freee Expense ID', 'ステータス', 'エラー'
    ]);
    logSheet.getRange(1, 1, 1, 10).setFontWeight('bold').setBackground('#4a86c8').setFontColor('white');
    Logger.log('✅ アップロードログシートを作成しました');
  } else {
    Logger.log('ℹ️ アップロードログシートは既に存在します');
  }

  // デフォルトの「シート1」を削除
  const defaultSheet = ss.getSheetByName('シート1');
  if (defaultSheet && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
    Logger.log('🗑️ デフォルトの「シート1」を削除しました');
  }

  Logger.log('🎉 セットアップ完了！会社マスタに会社情報を入力してください。');
}

/**
 * freeeAPIv2 ライブラリの利用可能なメソッドを調べる
 * GAS エディタで「inspectFreeeAPI」を選択して ▶ 実行
 */
function inspectFreeeAPI() {
  Logger.log('=== FreeeAPI ライブラリの調査 ===');

  if (typeof FreeeAPI === 'undefined') {
    Logger.log('❌ FreeeAPI ライブラリが読み込まれていません');
    return;
  }

  Logger.log('✅ FreeeAPI ライブラリが見つかりました');

  // GASライブラリは Object.keys() で列挙できないので、よくあるメソッド名を直接チェック
  const candidates = [
    // OAuth 系
    'getService', 'createService', 'getAccessToken', 'authorize', 'authCallback',
    'setClientId', 'setClientSecret', 'isAuthorized', 'getAuthorizationUrl',
    'handleCallback', 'logout', 'reset',
    // API 呼び出し系
    'getCompanies', 'fetchCompanies', 'listCompanies',
    'getMe', 'getUserInfo', 'getUser',
    'fetch', 'request', 'call', 'api', 'get', 'post',
    'uploadReceipt', 'createExpenseApplication',
    // 設定系
    'init', 'setup', 'configure', 'setProperty', 'getProperty',
    'setScriptId', 'setCallbackFunction',
    // ユーティリティ
    'getToken', 'refreshToken', 'getOAuthURL', 'getRedirectUri',
    'showSidebar', 'showDialog',
  ];

  Logger.log('--- メソッド存在チェック ---');
  const found = [];
  for (const name of candidates) {
    try {
      const type = typeof FreeeAPI[name];
      if (type !== 'undefined') {
        Logger.log('  ✅ ' + name + ' (' + type + ')');
        found.push(name);
      }
    } catch (e) {
      // skip
    }
  }

  if (found.length === 0) {
    Logger.log('⚠️ 既知のメソッドが見つかりませんでした');
    Logger.log('FreeeAPI の型: ' + typeof FreeeAPI);
    Logger.log('FreeeAPI の文字列表現: ' + String(FreeeAPI));
    try {
      // for...in で列挙を試みる
      Logger.log('--- for...in 列挙 ---');
      var count = 0;
      for (var key in FreeeAPI) {
        Logger.log('  ' + key + ' (' + typeof FreeeAPI[key] + ')');
        count++;
        if (count > 50) break;
      }
      if (count === 0) Logger.log('  (列挙可能なプロパティなし)');
    } catch (e) {
      Logger.log('for...in エラー: ' + e.message);
    }
  } else {
    Logger.log('--- 検出されたメソッド: ' + found.join(', '));
  }
}

/**
 * 既存の会社マスタシートに「メインボタン」列（E列）を追加する。
 * 既にE列にヘッダーがある場合はヘッダー追加をスキップする（何度実行しても安全）。
 * 会社名に MAJOR_KEYWORDS のいずれかを含む場合は TRUE、それ以外は FALSE を設定する
 * （既にE列に値が入っている行はスキップし、上書きしない）。
 * GAS エディタで「addCompanyMajorColumn」を選択して ▶ 実行し、
 * 完了後に「refreshMasterCache」も実行してキャッシュを更新してください。
 */
function addCompanyMajorColumn() {
  const MAJOR_KEYWORDS = ['三国産業', 'ファンテック', '三国ホールディングス'];

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('会社マスタ');
  if (!sheet) {
    Logger.log('❌ 会社マスタシートが見つかりません');
    return;
  }

  // ヘッダー追加
  const header = sheet.getRange(1, 5).getValue();
  if (!header) {
    sheet.getRange(1, 5).setValue('メインボタン').setFontWeight('bold').setBackground('#4a86c8').setFontColor('white');
    sheet.setColumnWidth(5, 100);
    Logger.log('✅ ヘッダー「メインボタン」を追加しました');
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('ℹ️ 会社データがありません');
    return;
  }

  const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  let updated = 0;
  for (let i = 0; i < data.length; i++) {
    const name = String(data[i][1] || '');
    const existing = data[i][4];
    if (existing === '' || existing === null || existing === undefined) {
      const isMajor = MAJOR_KEYWORDS.some(function(k) { return name.indexOf(k) !== -1; });
      sheet.getRange(i + 2, 5).setValue(isMajor);
      Logger.log('  ' + name + ' → ' + (isMajor ? 'メインボタン' : 'その他'));
      updated++;
    }
  }

  Logger.log('🎉 ' + updated + '件を更新しました。続けて refreshMasterCache() を実行してください。');
}

/**
 * 既存の会社マスタシートに「略称」列（F列）を追加する。
 * 既にF列にヘッダーがある場合はヘッダー追加をスキップする（何度実行しても安全）。
 * 会社名が SHORT_NAME_MAP のキーワードを含む場合にその略称を設定する
 * （既にF列に値が入っている行はスキップし、上書きしない）。
 * キーワードは長い（より具体的な）ものを先に判定するよう順序に注意すること
 * （例: 「開発用テスト事業所削除用」は「開発用テスト事業所」の判定より前に置く）。
 * GAS エディタで「addCompanyShortNames」を選択して ▶ 実行し、
 * 完了後に「refreshMasterCache」も実行してキャッシュを更新してください。
 */
function addCompanyShortNames() {
  const SHORT_NAME_MAP = [
    { keyword: '三国産業', shortName: '三国' },
    { keyword: 'ファンテック', shortName: 'ファン' },
    { keyword: '三国ホールディングス', shortName: 'ＨＤ' },
    { keyword: 'DAチャレンジャーズ', shortName: 'ＤＡＣ' },
    { keyword: '開発用テスト事業所削除用', shortName: '削除' },
    { keyword: '開発用テスト事業所', shortName: '開発用' },
    { keyword: 'TCI', shortName: 'ＴＣＩ' },
  ];

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('会社マスタ');
  if (!sheet) {
    Logger.log('❌ 会社マスタシートが見つかりません');
    return;
  }

  // ヘッダー追加
  const header = sheet.getRange(1, 6).getValue();
  if (!header) {
    sheet.getRange(1, 6).setValue('略称').setFontWeight('bold').setBackground('#4a86c8').setFontColor('white');
    sheet.setColumnWidth(6, 80);
    Logger.log('✅ ヘッダー「略称」を追加しました');
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('ℹ️ 会社データがありません');
    return;
  }

  const data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  let updated = 0;
  for (let i = 0; i < data.length; i++) {
    const name = String(data[i][1] || '');
    const existing = data[i][5];
    if (existing !== '' && existing !== null && existing !== undefined) continue;

    const match = SHORT_NAME_MAP.find(function(m) { return name.indexOf(m.keyword) !== -1; });
    if (match) {
      sheet.getRange(i + 2, 6).setValue(match.shortName);
      Logger.log('  ' + name + ' → ' + match.shortName);
      updated++;
    } else {
      Logger.log('  ⚠️ ' + name + ' は略称マップに未登録のためスキップ');
    }
  }

  Logger.log('🎉 ' + updated + '件を更新しました。続けて refreshMasterCache() を実行してください。');
}

/**
 * Freee API で事業所一覧を取得し、会社マスタに書き込む
 * freeeAPIv2 の Request クラスを使用
 * GAS エディタで「fetchAndWriteFreeeCompanies」を選択して ▶ 実行
 */
function fetchAndWriteFreeeCompanies() {
  Logger.log('=== Freee 事業所一覧の取得 ===');

  try {
    // freeeAPIv2 の Request クラスで /api/1/companies を GET
    const response = new FreeeAPI.Request('companies').requestGET();

    if (!response || !response.companies) {
      Logger.log('❌ レスポンスが不正です: ' + JSON.stringify(response));
      return;
    }

    const companies = response.companies;
    Logger.log('✅ ' + companies.length + '件の事業所が見つかりました');

    // 会社マスタに書き込み
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName('会社マスタ');
    if (!sheet) {
      Logger.log('❌ 会社マスタシートが見つかりません。setupMasterSheets を先に実行してください');
      return;
    }

    // 既存データをクリア（ヘッダー以外）
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, 4).clearContent();
    }

    // 事業所を書き込み
    companies.forEach(function(company, index) {
      const id = 'c' + String(index + 1).padStart(3, '0');
      const name = company.display_name || company.name || '不明';
      const freeeId = company.id || '';

      sheet.getRange(index + 2, 1, 1, 4).setValues([[id, name, freeeId, true]]);
      Logger.log('  ' + id + ': ' + name + ' (Freee ID: ' + freeeId + ')');
    });

    Logger.log('🎉 会社マスタに ' + companies.length + '件を書き込みました！');

  } catch (e) {
    Logger.log('❌ エラー: ' + e.message);
    Logger.log('OAuth認証が必要な場合は、freeeAPIv2 プロジェクトで alertAuth() を実行してください');
  }
}
