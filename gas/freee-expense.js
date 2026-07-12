/**
 * Freee API 連携 — 証憑アップロード & 経費精算下書き作成
 * freeeAPIv2 ライブラリの Request クラスを使用
 *
 * Freee API エンドポイント:
 *   - POST /api/1/receipts          → 証憑アップロード（multipart/form-data）
 *   - POST /api/1/expense_applications → 経費精算下書き作成
 */

/**
 * 安全なAPIエンドポイントのホワイトリスト
 * ここにないエンドポイントへの POST/PUT/DELETE は拒否される
 */
var ALLOWED_POST_ENDPOINTS = ['receipts', 'expense_applications'];

/**
 * Freee API リクエストの安全性を検証
 * DELETE/PUT は全面禁止、POST はホワイトリストのみ許可
 */
function validateFreeeRequest(method, endpoint) {
  method = method.toUpperCase();
  
  if (method === 'DELETE') {
    throw new Error('🔴 安全保護: Freee API への DELETE リクエストは禁止されています');
  }
  
  if (method === 'PUT') {
    throw new Error('🔴 安全保護: Freee API への PUT リクエストは禁止されています');
  }
  
  if (method === 'POST' && ALLOWED_POST_ENDPOINTS.indexOf(endpoint) === -1) {
    throw new Error('🔴 安全保護: エンドポイント "' + endpoint + '" への POST は許可されていません。許可リスト: ' + ALLOWED_POST_ENDPOINTS.join(', '));
  }
  
  return true;
}

/**
 * freeeAPIv2 の request___POST は失敗時、freeeからの実際のエラー本文を
 * console.log に出力するだけで呼び出し元には null しか返さない
 * （Stackdriver/Cloud Logging を見られないと原因が分からない）。
 * そのため、ライブラリが公開している url/token ゲッターのみを利用して
 * （ライブラリ自体は変更しない）独自にリクエストを行い、失敗時は
 * freeeからのレスポンス本文をそのまま例外メッセージに含める。
 * これによりスプレッドシートの「アップロードログ」にエラー詳細が残る。
 */
function postToFreeeWithDetail(endpoint, payload) {
  const req = new FreeeAPI.Request(endpoint);
  const url = req.url;
  const token = req.token;

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'accept': 'application/json',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const text = response.getContentText();

  if (String(status).match(/2\d\d/) === null) {
    throw new Error('Freee APIエラー (HTTP ' + status + ', ' + endpoint + '): ' + text + ' | 送信内容: ' + JSON.stringify(payload));
  }

  return text ? JSON.parse(text) : null;
}

/**
 * 証憑（領収書画像）を Freee にアップロード
 * @param {string} driveFileId Google Drive のファイル ID
 * @param {number} companyId Freee の事業所 ID
 * @returns {number} Freee の証憑 ID (receipt_id)
 */
function uploadReceiptToFreee(driveFileId, companyId) {
  // Drive からファイルを取得
  const file = DriveApp.getFileById(driveFileId);
  const blob = file.getBlob();

  validateFreeeRequest('POST', 'receipts');

  const req = new FreeeAPI.Request('receipts');
  const url = req.url;
  const token = req.token;

  // multipart/form-data（Content-Typeは指定せずUrlFetchAppにBlobから自動判定させる）
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + token },
    payload: {
      'company_id': String(companyId),
      'receipt': blob,
    },
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const text = response.getContentText();

  if (String(status).match(/2\d\d/) === null) {
    throw new Error('Freee APIエラー (HTTP ' + status + ', receipts): ' + text);
  }

  const result = text ? JSON.parse(text) : null;
  if (!result || !result.receipt) {
    throw new Error('Freee 証憑アップロードに失敗しました: ' + JSON.stringify(result));
  }

  return result.receipt.id;
}

/**
 * 複数の証憑（領収書画像）を Freee に並列アップロードする（グループアップロード高速化用）。
 * UrlFetchApp.fetchAll() で全件を同時送信することで、1枚ずつ順番に送る場合に比べて
 * 処理時間を大幅に短縮する（グループアップロードが数十秒かかり、その間の通信断で
 * クライアント側がエラー表示になりやすい問題への対策）。
 * @param {string[]} driveFileIds Google Drive のファイル ID の配列
 * @param {number} companyId Freee の事業所 ID
 * @returns {number[]} Freee の証憑 ID (receipt_id) の配列（driveFileIdsと同じ順序）
 */
function uploadReceiptsToFreeeBatch(driveFileIds, companyId) {
  validateFreeeRequest('POST', 'receipts');

  const req = new FreeeAPI.Request('receipts');
  const url = req.url;
  const token = req.token;

  const requests = driveFileIds.map(function(driveFileId) {
    const file = DriveApp.getFileById(driveFileId);
    const blob = file.getBlob();
    return {
      url: url,
      method: 'post',
      headers: { 'Authorization': 'Bearer ' + token },
      payload: {
        'company_id': String(companyId),
        'receipt': blob,
      },
      muteHttpExceptions: true,
    };
  });

  const responses = UrlFetchApp.fetchAll(requests);

  return responses.map(function(response, i) {
    const status = response.getResponseCode();
    const text = response.getContentText();

    if (String(status).match(/2\d\d/) === null) {
      throw new Error('Freee APIエラー (HTTP ' + status + ', receipts, ' + (i + 1) + '件目): ' + text);
    }

    const result = text ? JSON.parse(text) : null;
    if (!result || !result.receipt) {
      throw new Error('Freee 証憑アップロードに失敗しました(' + (i + 1) + '件目): ' + JSON.stringify(result));
    }

    return result.receipt.id;
  });
}

/**
 * 経費精算の下書きを作成（個別 = 1レシート → 1明細）
 * @param {number} companyId Freee の事業所 ID
 * @param {number} receiptId Freee の証憑 ID
 * @param {string} paymentMethodName 支払い方法名
 * @param {number} amount 金額（freeeのバリデーション上、1以上が必須）
 * @param {string} memo メモ
 * @param {string} capturedAt 撮影日時 (ISO 8601)
 * @returns {number} 経費精算ID
 */
function createExpenseDraft(companyId, receiptId, paymentMethodName, amount, memo, capturedAt) {
  const transactionDate = capturedAt.substring(0, 10);
  const templateId = getDefaultExpenseApplicationLineTemplateId(companyId);
  const expenseLine = {
    amount: amount > 0 ? amount : 1,
    description: memo || '領収書 (' + paymentMethodName + ')',
  };
  if (templateId) expenseLine.expense_application_line_template_id = templateId;

  const payload = {
    company_id: companyId,
    title: '領収書 (' + paymentMethodName + ') ' + transactionDate,
    issue_date: transactionDate,
    purchase_lines: [
      {
        transaction_date: transactionDate,
        receipt_id: receiptId,
        expense_application_lines: [expenseLine],
      }
    ],
  };

  validateFreeeRequest('POST', 'expense_applications');
  const response = postToFreeeWithDetail('expense_applications', payload);

  if (!response || !response.expense_application) {
    throw new Error('Freee 経費精算下書き作成に失敗しました: ' + JSON.stringify(response));
  }

  return response.expense_application.id;
}

/**
 * 経費精算の下書きを作成（グループ = N枚 → N明細を1経費精算に）
 * @param {number} companyId Freee の事業所 ID
 * @param {number[]} receiptIds Freee の証憑 ID の配列
 * @param {number[]} amounts 金額の配列（receiptIdsと同じ順序・同じ長さ）
 * @param {string} paymentMethodName 支払い方法名
 * @param {string} groupName グループ名
 * @param {string} capturedAt 撮影日時 (ISO 8601)
 * @returns {number} 経費精算ID
 */
function createGroupExpenseDraft(companyId, receiptIds, amounts, paymentMethodName, groupName, capturedAt) {
  const transactionDate = capturedAt.substring(0, 10);
  const templateId = getDefaultExpenseApplicationLineTemplateId(companyId);
  const purchaseLines = receiptIds.map(function(receiptId, index) {
    const amount = amounts[index];
    const expenseLine = {
      amount: amount > 0 ? amount : 1,
      description: groupName + ' (' + (index + 1) + '/' + receiptIds.length + ')',
    };
    if (templateId) expenseLine.expense_application_line_template_id = templateId;
    return {
      transaction_date: transactionDate,
      receipt_id: receiptId,
      expense_application_lines: [expenseLine],
    };
  });

  const payload = {
    company_id: companyId,
    title: groupName + ' (' + paymentMethodName + ') ' + transactionDate,
    issue_date: transactionDate,
    purchase_lines: purchaseLines,
  };

  validateFreeeRequest('POST', 'expense_applications');
  const response = postToFreeeWithDetail('expense_applications', payload);

  if (!response || !response.expense_application) {
    throw new Error('Freee グループ経費精算下書き作成に失敗しました: ' + JSON.stringify(response));
  }

  return response.expense_application.id;
}
