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
    const authError = checkApiKey(e.parameter.apiKey);
    if (authError) {
      return jsonResponse({ success: false, error: authError });
    }

    const action = e.parameter.action;

    let data;

    // forceRefresh=1 なら、PropertiesServiceのマスタキャッシュ（180日）を先に破棄して
    // スプレッドシートから読み直す（アプリの設定画面「マスタを今すぐ更新」から使用。
    // 以前はGASエディタでrefreshMasterCacheを手動実行する必要があった作業の代替）
    const forceRefresh = e.parameter.forceRefresh === '1';

    switch (action) {
      case 'companies':
        if (forceRefresh) PropertiesService.getScriptProperties().deleteProperty('CACHE_COMPANIES');
        data = getCompanies();
        break;
      case 'paymentMethods':
        if (forceRefresh) PropertiesService.getScriptProperties().deleteProperty('CACHE_PAYMENT_METHODS');
        data = getPaymentMethods();
        break;
      case 'uploadStatus':
        data = getUploadStatus(e.parameter.requestId, Number(e.parameter.expectedCount) || 0);
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

    const authError = checkApiKey(body.apiKey);
    if (authError) {
      return jsonResponse({ success: false, error: authError });
    }

    if (body.action === 'backupReceipt') {
      const result = backupReceipt(body);
      return jsonResponse({ success: true, data: result });
    }

    const requestId = body.requestId || null;

    if (body.action !== 'upload') {
      return jsonResponse({ success: false, error: `不明なアクション: ${body.action}` });
    }

    // 通信断でレスポンスが届かなかった場合に doGet(action=uploadStatus) が
    // 「GASが受信したかどうか」を判定できるよう、処理開始前に短命な目印を残す
    // （結果そのものはアップロードログに記録するので、ここはあくまで受信マーカー）
    if (requestId) {
      CacheService.getScriptCache().put('UPLOAD_STARTED_' + requestId, String(Date.now()), 1200);
    }

    const results = processUpload(body.receipts, requestId);
    return jsonResponse({ success: true, data: results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('doPost error:', message);
    return jsonResponse({ success: false, error: message });
  }
}

/**
 * 撮影直後のバックグラウンドバックアップ処理。
 * freeeへは一切アクセスせず、Driveへの画像保存と「撮影記録」シートへの記録のみ行う。
 * PWA側のローカルデータが失われても、ここで残した記録から内容を追跡・復旧できるようにする。
 */
function backupReceipt(body) {
  const backupId = body.backupId || '';

  // 「既存チェック→Drive保存→記録」を直列化し、同じbackupIdの並行リクエストが
  // 二重にDriveファイルを作らないようにする（iOS停止時の再送信が並行しても安全）。
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // 既にこのbackupIdでバックアップ済みなら、新規作成せず既存のDriveファイルIDを返す（冪等）
    if (backupId) {
      const existing = findCaptureRecordByBackupId(backupId);
      if (existing) {
        return { driveFileId: existing, deduped: true };
      }
    }

    const companies = getCompanies();
    const company = companies.find(c => c.id === body.companyId);
    const companyName = company ? company.name : (body.companyName || '未分類');

    const driveFileId = saveImageToDrive(body.imageBase64, body.mimeType, companyName, body.capturedAt);

    appendCaptureRecord({
      timestamp: new Date().toISOString(),
      companyName: companyName,
      paymentMethod: body.paymentMethodName || '',
      groupName: body.groupName || '',
      amount: body.amount || '',
      memo: body.memo || '',
      capturedAt: body.capturedAt || '',
      driveFileId: driveFileId,
      backupId: backupId,
    });

    return { driveFileId: driveFileId };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 【手動実行用】撮影記録シートの重複を掃除する。
 * GASエディタで「dedupeCaptureRecords」を選択して ▶ 実行。
 *
 * 同一レシート（backupId、無い旧行は 撮影日時+金額+会社名 で判定）が複数行ある場合、
 * 最古の1件を残して余剰行のDriveファイルをゴミ箱へ移動し、シート行を削除する。
 * - freee登録に使ったDriveファイル（アップロードログに載っているID）は絶対に消さない。
 * - Driveはゴミ箱へ移動するだけ（30日間は復元可能）。freeeには一切触れない。
 */
function dedupeCaptureRecords() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('撮影記録');
  if (!sheet) { Logger.log('撮影記録シートがありません'); return; }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) { Logger.log('データ行がありません'); return; }

  // アップロードログで使用済みのDriveファイルIDを集める（これらは絶対に消さない）
  const usedDriveIds = {};
  const logSheet = ss.getSheetByName('アップロードログ');
  if (logSheet && logSheet.getLastRow() >= 2) {
    const logData = logSheet.getRange(2, 6, logSheet.getLastRow() - 1, 1).getValues(); // 6列目=Drive File ID
    logData.forEach(function(r) { if (r[0]) usedDriveIds[String(r[0])] = true; });
  }

  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  // グループごとに行番号を集める（行番号はシート上の実番号 = i+2）
  const groups = {};
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const backupId = lastCol >= 9 ? String(row[8] || '') : '';
    const key = backupId || (String(row[6]) + '|' + String(row[4]) + '|' + String(row[1])); // 撮影日時|金額|会社名
    if (!groups[key]) groups[key] = [];
    groups[key].push({ sheetRow: i + 2, timestamp: String(row[0]), driveFileId: String(row[7] || '') });
  }

  const rowsToDelete = [];
  let trashed = 0;
  let keptUsed = 0;

  Object.keys(groups).forEach(function(key) {
    const rows = groups[key];
    if (rows.length <= 1) return;
    // 最古（タイムスタンプ昇順の先頭）を残す
    rows.sort(function(a, b) { return a.timestamp < b.timestamp ? -1 : 1; });
    const keep = rows[0];
    for (let j = 1; j < rows.length; j++) {
      const dup = rows[j];
      // freeeで使ったファイル、または残す行と同じファイルは消さない（行だけ削除）
      if (dup.driveFileId && dup.driveFileId !== keep.driveFileId && !usedDriveIds[dup.driveFileId]) {
        try {
          DriveApp.getFileById(dup.driveFileId).setTrashed(true);
          trashed++;
          Logger.log('🗑️ ゴミ箱へ移動: ' + dup.driveFileId + ' (key=' + key + ')');
        } catch (e) {
          Logger.log('⚠️ Drive移動失敗(既に無い等): ' + dup.driveFileId + ' / ' + e.message);
        }
      } else if (usedDriveIds[dup.driveFileId]) {
        keptUsed++;
        Logger.log('🔒 freee使用中のため保持: ' + dup.driveFileId);
      }
      rowsToDelete.push(dup.sheetRow);
    }
  });

  // 行削除は下から（大きい行番号から）行うとインデックスがずれない
  rowsToDelete.sort(function(a, b) { return b - a; });
  rowsToDelete.forEach(function(r) { sheet.deleteRow(r); });

  Logger.log('🎉 完了: ' + rowsToDelete.length + '行を削除、' + trashed + '件をゴミ箱へ移動、' +
    keptUsed + '件はfreee使用中のため保持しました。');
}

/**
 * アップロード処理のメインロジック
 */
function processUpload(receipts, requestId) {
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
    const result = processSingleReceipt(index, item, companies, requestId);
    results.push(result);
  }

  // グループレシートを処理
  for (const [, group] of grouped) {
    const groupResults = processGroupReceipts(group.indices, group.items, companies, requestId);
    results.push(...groupResults);
  }

  return results;
}

/**
 * requestId宛のアップロード結果を問い合わせる（doGet action=uploadStatus）。
 * 結果はアップロードログシートが常に真実。CacheServiceの受信マーカーは
 * 「そもそも届いたかどうか」の短時間の判定にのみ使う。
 * @returns {{requestId:string, state:'unknown'|'processing'|'done', results:Array|null}}
 */
function getUploadStatus(requestId, expectedCount) {
  if (!requestId) {
    return { requestId: requestId || '', state: 'unknown', results: null };
  }

  const foundResults = findLoggedResultsByRequestId(requestId);
  // クライアントがexpectedCountを渡し忘れた/おかしな値を送ってきた場合の保険として、
  // 見つかった件数を下限に使う（結果を誤って切り捨てないため）
  const effectiveExpectedCount = Math.max(expectedCount || 0, foundResults.length);

  if (effectiveExpectedCount > 0 && foundResults.length >= effectiveExpectedCount) {
    return { requestId, state: 'done', results: foundResults };
  }

  const startedAtRaw = CacheService.getScriptCache().get('UPLOAD_STARTED_' + requestId);

  if (!startedAtRaw) {
    if (foundResults.length > 0) {
      // マーカーは消えたが記録は一部見つかった → GAS側で処理が途中終了したとみなし、
      // 未完了分はエラー扱いで補完して返す（もう待っても続きは来ない）
      return { requestId, state: 'done', results: fillMissingResultsAsError(foundResults, effectiveExpectedCount) };
    }
    return { requestId, state: 'unknown', results: null };
  }

  const elapsedMs = Date.now() - Number(startedAtRaw);
  const GAS_EXECUTION_CEILING_MS = 7 * 60 * 1000; // GASの実行上限(6分)に余裕を持たせた閾値

  if (elapsedMs < GAS_EXECUTION_CEILING_MS) {
    return { requestId, state: 'processing', results: null };
  }

  // マーカーはあるが実行上限を明確に超えている → 異常終了とみなす
  return { requestId, state: 'done', results: fillMissingResultsAsError(foundResults, effectiveExpectedCount) };
}

/**
 * 見つかった結果に対し、expectedCount分に満たない receiptIndex を
 * 「サーバー側処理が完了しなかった」エラー結果で補完する。
 */
function fillMissingResultsAsError(foundResults, expectedCount) {
  const byIndex = {};
  foundResults.forEach(function(r) { byIndex[r.receiptIndex] = r; });

  const filled = [];
  for (let i = 0; i < expectedCount; i++) {
    if (byIndex[i]) {
      filled.push(byIndex[i]);
    } else {
      filled.push({
        receiptIndex: i,
        driveFileId: '',
        freeeReceiptId: '',
        freeeExpenseId: '',
        status: 'error',
        error: 'サーバー側の処理が完了しませんでした（タイムアウトの可能性があります）',
      });
    }
  }
  return filled;
}

/**
 * 個別レシートの処理
 */
function processSingleReceipt(index, item, companies, requestId) {
  const company = companies.find(c => c.id === item.companyId);
  if (!company) {
    return { receiptIndex: index, driveFileId: '', status: 'error', error: `会社ID ${item.companyId} が見つかりません` };
  }

  let driveFileId = item.driveFileId || '';
  let freeeReceiptId = '';

  try {
    // Step 1: Drive に保存（撮影直後のバックグラウンドバックアップで既に保存済みならそれを再利用し、
    // 同じ画像をDriveへ二重に保存しない。未保存（バックアップ失敗等）の場合はここで保存する）
    if (!driveFileId) {
      driveFileId = saveImageToDrive(item.imageBase64, item.mimeType, company.name, item.capturedAt);
    }

    // Step 2: Freee に証憑アップロード
    freeeReceiptId = uploadReceiptToFreee(driveFileId, company.freeeCompanyId);

    // Step 3: 経費精算下書き作成
    const freeeExpenseId = createExpenseDraft(
      company.freeeCompanyId,
      freeeReceiptId,
      item.paymentMethodName,
      item.amount,
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
      requestId: requestId,
      receiptIndex: index,
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
      freeeReceiptId: String(freeeReceiptId),
      freeeExpenseId: '',
      status: 'error',
      error: message,
      requestId: requestId,
      receiptIndex: index,
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
function processGroupReceipts(indices, items, companies, requestId) {
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
    // Step 1: 全画像を Drive に保存（撮影直後のバックグラウンドバックアップで
    // 既に保存済みならそれを再利用し、同じ画像をDriveへ二重に保存しない）
    for (const item of items) {
      const fileId = item.driveFileId || saveImageToDrive(item.imageBase64, item.mimeType, company.name, item.capturedAt);
      driveFileIds.push(fileId);
    }

    // Step 2: 全画像を Freee に証憑アップロード（並列実行で高速化）
    const uploadedReceiptIds = uploadReceiptsToFreeeBatch(driveFileIds, company.freeeCompanyId);
    freeeReceiptIds.push.apply(freeeReceiptIds, uploadedReceiptIds);

    // Step 3: グループ経費精算下書き作成（N明細を1経費精算に）
    const amounts = items.map(function(item) { return item.amount; });
    const freeeExpenseId = createGroupExpenseDraft(
      company.freeeCompanyId,
      freeeReceiptIds,
      amounts,
      firstItem.paymentMethodName,
      firstItem.groupName || 'グループ',
      firstItem.capturedAt
    );

    // ログ記録（グループ内のレシートごとに1行。freeeExpenseIdは全行共通のため
    // 同じ経費申請にまとまった複数レシートであることが後から分かる）
    items.forEach(function(item, i) {
      writeLog({
        timestamp: new Date().toISOString(),
        action: 'upload_group',
        companyName: company.name,
        paymentMethod: item.paymentMethodName,
        groupName: firstItem.groupName || '',
        driveFileId: driveFileIds[i],
        freeeReceiptId: String(freeeReceiptIds[i]),
        freeeExpenseId: String(freeeExpenseId),
        status: 'completed',
        error: '',
        requestId: requestId,
        receiptIndex: indices[i],
      });
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

    // ログ記録（グループ内のレシートごとに1行。Drive保存・証憑アップロードが
    // 完了していた分は各行にIDが残るので、どこまで進んでいたか後から分かる）
    items.forEach(function(item, i) {
      writeLog({
        timestamp: new Date().toISOString(),
        action: 'upload_group',
        companyName: company.name,
        paymentMethod: item.paymentMethodName,
        groupName: firstItem.groupName || '',
        driveFileId: driveFileIds[i] || '',
        freeeReceiptId: freeeReceiptIds[i] ? String(freeeReceiptIds[i]) : '',
        freeeExpenseId: '',
        status: 'error',
        error: message,
        requestId: requestId,
        receiptIndex: indices[i],
      });
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
 * APIキー（合言葉）チェック。
 * Script Properties に API_KEY が設定されている場合のみ有効になる
 * （未設定の間は従来通り全リクエストを許可するため、設定前にアプリが壊れることはない）。
 * GAS WebアプリのURLは公開リポジトリから知られうるため、URLの秘匿に頼らない防御として導入。
 * @returns {string|null} エラーメッセージ（認証OKなら null）
 */
function checkApiKey(provided) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!expected) return null;
  if (provided === expected) return null;
  return 'APIキーが一致しません。アプリを開き直して正しい合言葉を入力してください。';
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
      'Freee Expense ID', 'ステータス', 'エラー', 'Request ID', 'Receipt Index'
    ]);
    logSheet.getRange(1, 1, 1, 12).setFontWeight('bold').setBackground('#4a86c8').setFontColor('white');
    Logger.log('✅ アップロードログシートを作成しました');
  } else {
    Logger.log('ℹ️ アップロードログシートは既に存在します');
  }

  // --- 撮影記録 ---
  let captureSheet = ss.getSheetByName('撮影記録');
  if (!captureSheet) {
    captureSheet = ss.insertSheet('撮影記録');
    captureSheet.appendRow([
      'タイムスタンプ', '会社名', '支払い方法', 'グループ名', '金額', 'メモ', '撮影日時', 'Drive File ID', 'Backup ID'
    ]);
    captureSheet.getRange(1, 1, 1, 9).setFontWeight('bold').setBackground('#4a86c8').setFontColor('white');
    Logger.log('✅ 撮影記録シートを作成しました');
  } else {
    Logger.log('ℹ️ 撮影記録シートは既に存在します');
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

/**
 * 「開発用テスト事業所」で利用可能な経費科目テンプレート一覧を取得する（診断用・読み取り専用GET）
 * 経費申請作成(expense_applications)が「Purchase linesを入力してください」で失敗する原因が
 * expense_application_line_template_id（経費科目）の未指定である可能性を確認するために使用する。
 * GAS エディタで「listExpenseApplicationLineTemplates」を選択して ▶ 実行
 */
function listExpenseApplicationLineTemplates() {
  const companies = getCompanies();
  const target = companies.find(function(c) { return c.name.indexOf('開発用テスト事業所') !== -1 && c.name.indexOf('削除') === -1; });
  if (!target) {
    Logger.log('❌ 「開発用テスト事業所」が会社マスタに見つかりません');
    return;
  }
  Logger.log('対象事業所: ' + target.name + ' (freeeCompanyId: ' + target.freeeCompanyId + ')');

  const req = new FreeeAPI.Request('expense_application_line_templates').addParam('company_id', target.freeeCompanyId);
  const response = req.requestGET();

  Logger.log('--- expense_application_line_templates ---');
  Logger.log(JSON.stringify(response, null, 2));
}
