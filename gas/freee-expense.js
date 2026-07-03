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
 * 証憑（領収書画像）を Freee にアップロード
 * @param {string} driveFileId Google Drive のファイル ID
 * @param {number} companyId Freee の事業所 ID
 * @returns {number} Freee の証憑 ID (receipt_id)
 */
function uploadReceiptToFreee(driveFileId, companyId) {
  // Drive からファイルを取得
  const file = DriveApp.getFileById(driveFileId);
  const blob = file.getBlob();

  // freeeAPIv2 の Request クラスで証憑アップロード（multipart/form-data）
  validateFreeeRequest('POST', 'receipts');
  const req = new FreeeAPI.Request('receipts');
  const response = req.request___POST({
    'company_id': String(companyId),
    'receipt': blob,
  }, true); // binary = true でmultipart送信

  if (!response || !response.receipt) {
    throw new Error('Freee 証憑アップロードに失敗しました: ' + JSON.stringify(response));
  }

  return response.receipt.id;
}

/**
 * 経費精算の下書きを作成（個別 = 1レシート → 1明細）
 * @param {number} companyId Freee の事業所 ID
 * @param {number} receiptId Freee の証憑 ID
 * @param {string} paymentMethodName 支払い方法名
 * @param {string} memo メモ
 * @param {string} capturedAt 撮影日時 (ISO 8601)
 * @returns {number} 経費精算ID
 */
function createExpenseDraft(companyId, receiptId, paymentMethodName, memo, capturedAt) {
  const payload = {
    company_id: companyId,
    title: '領収書 (' + paymentMethodName + ') ' + capturedAt.substring(0, 10),
    issue_date: capturedAt.substring(0, 10),
    expense_application_lines: [
      {
        description: memo || '領収書 (' + paymentMethodName + ')',
        receipt_id: receiptId,
      }
    ],
  };

  validateFreeeRequest('POST', 'expense_applications');
  const req = new FreeeAPI.Request('expense_applications');
  const response = req.request___POST(payload);

  if (!response || !response.expense_application) {
    throw new Error('Freee 経費精算下書き作成に失敗しました: ' + JSON.stringify(response));
  }

  return response.expense_application.id;
}

/**
 * 経費精算の下書きを作成（グループ = N枚 → N明細を1経費精算に）
 * @param {number} companyId Freee の事業所 ID
 * @param {number[]} receiptIds Freee の証憑 ID の配列
 * @param {string} paymentMethodName 支払い方法名
 * @param {string} groupName グループ名
 * @param {string} capturedAt 撮影日時 (ISO 8601)
 * @returns {number} 経費精算ID
 */
function createGroupExpenseDraft(companyId, receiptIds, paymentMethodName, groupName, capturedAt) {
  const lines = receiptIds.map(function(receiptId, index) {
    return {
      description: groupName + ' (' + (index + 1) + '/' + receiptIds.length + ')',
      receipt_id: receiptId,
    };
  });

  const payload = {
    company_id: companyId,
    title: groupName + ' (' + paymentMethodName + ') ' + capturedAt.substring(0, 10),
    issue_date: capturedAt.substring(0, 10),
    expense_application_lines: lines,
  };

  validateFreeeRequest('POST', 'expense_applications');
  const req = new FreeeAPI.Request('expense_applications');
  const response = req.request___POST(payload);

  if (!response || !response.expense_application) {
    throw new Error('Freee グループ経費精算下書き作成に失敗しました: ' + JSON.stringify(response));
  }

  return response.expense_application.id;
}
