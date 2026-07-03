/**
 * Freee API 連携 — 証憑アップロード & 経費精算下書き作成
 * freeeAPIv2 ライブラリ（FreeeAPI）を使用
 */

/**
 * 証憑（領収書画像）を Freee にアップロード
 * @param driveFileId Google Drive のファイル ID
 * @param companyId Freee の事業所 ID
 * @returns Freee の証憑 ID (receipt_id)
 */
function uploadReceiptToFreee(
  driveFileId: string,
  companyId: number
): number {
  // Drive からファイルを取得
  const file = DriveApp.getFileById(driveFileId);
  const blob = file.getBlob();

  // freeeAPIv2 ライブラリで証憑アップロード
  // @ts-ignore - FreeeAPI is a GAS library
  const response = FreeeAPI.uploadReceipt(companyId, blob);

  if (!response || !response.receipt) {
    throw new Error('Freee 証憑アップロードに失敗しました');
  }

  return response.receipt.id;
}

/**
 * 経費精算の下書きを作成（個別 = 1レシート → 1明細）
 */
function createExpenseDraft(
  companyId: number,
  receiptId: number,
  paymentMethodName: string,
  memo: string,
  capturedAt: string
): number {
  const params = {
    company_id: companyId,
    title: `領収書 (${paymentMethodName}) ${capturedAt.substring(0, 10)}`,
    issue_date: capturedAt.substring(0, 10),
    expense_application_lines: [
      {
        description: memo || `領収書 (${paymentMethodName})`,
        receipt_id: receiptId,
      }
    ],
  };

  // @ts-ignore - FreeeAPI is a GAS library
  const response = FreeeAPI.createExpenseApplication(companyId, params);

  if (!response || !response.expense_application) {
    throw new Error('Freee 経費精算下書き作成に失敗しました');
  }

  return response.expense_application.id;
}

/**
 * 経費精算の下書きを作成（グループ = N枚 → N明細を1経費精算に）
 */
function createGroupExpenseDraft(
  companyId: number,
  receiptIds: number[],
  paymentMethodName: string,
  groupName: string,
  capturedAt: string
): number {
  const lines = receiptIds.map((receiptId, index) => ({
    description: `${groupName} (${index + 1}/${receiptIds.length})`,
    receipt_id: receiptId,
  }));

  const params = {
    company_id: companyId,
    title: `${groupName} (${paymentMethodName}) ${capturedAt.substring(0, 10)}`,
    issue_date: capturedAt.substring(0, 10),
    expense_application_lines: lines,
  };

  // @ts-ignore - FreeeAPI is a GAS library
  const response = FreeeAPI.createExpenseApplication(companyId, params);

  if (!response || !response.expense_application) {
    throw new Error('Freee グループ経費精算下書き作成に失敗しました');
  }

  return response.expense_application.id;
}
