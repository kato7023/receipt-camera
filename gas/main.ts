/**
 * メインエントリ — GAS Web App
 * doGet: マスタデータ取得（会社一覧、支払い方法一覧）
 * doPost: 画像アップロード → Drive保存 → Freee連携
 */

/**
 * GET リクエストハンドラ
 */
function doGet(e: GoogleAppsScript.Events.DoGet): GoogleAppsScript.Content.TextOutput {
  try {
    const action = e.parameter.action;

    let data: unknown;

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
function doPost(e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  try {
    const body = JSON.parse(e.postData.contents) as UploadRequest;

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
function processUpload(receipts: ReceiptUploadItem[]): UploadResult[] {
  const companies = getCompanies();
  const results: UploadResult[] = [];

  // グループ別にレシートを整理
  const grouped = new Map<string, { indices: number[]; items: ReceiptUploadItem[] }>();
  const individuals: { index: number; item: ReceiptUploadItem }[] = [];

  receipts.forEach((item, index) => {
    if (item.groupName) {
      const key = `${item.companyId}:${item.groupName}`;
      if (!grouped.has(key)) {
        grouped.set(key, { indices: [], items: [] });
      }
      const group = grouped.get(key)!;
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
function processSingleReceipt(
  index: number,
  item: ReceiptUploadItem,
  companies: Company[]
): UploadResult {
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
function processGroupReceipts(
  indices: number[],
  items: ReceiptUploadItem[],
  companies: Company[]
): UploadResult[] {
  const firstItem = items[0];
  const company = companies.find(c => c.id === firstItem.companyId);
  if (!company) {
    return indices.map(index => ({
      receiptIndex: index,
      driveFileId: '',
      status: 'error' as const,
      error: `会社ID ${firstItem.companyId} が見つかりません`,
    }));
  }

  const driveFileIds: string[] = [];
  const freeeReceiptIds: number[] = [];

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
      status: 'completed' as const,
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
      status: (driveFileIds[i] ? 'partial' : 'error') as 'partial' | 'error',
      error: message,
    }));
  }
}

/**
 * JSON レスポンスを生成
 */
function jsonResponse(data: ApiResponse): GoogleAppsScript.Content.TextOutput {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
