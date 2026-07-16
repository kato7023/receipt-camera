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
 * tags は 2026-07-13 ユーザー承認（メモタグ新規作成のみ・破壊的変更なし。AGENTS.md参照）
 */
var ALLOWED_POST_ENDPOINTS = ['receipts', 'expense_applications', 'tags'];

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
 * 「役員精算」部門のIDを取得する（PropertiesServiceで会社ごとにキャッシュ）。
 * 本アプリが作成する経費申請の部門は必ず「役員精算」（ユーザー要件）。
 * 部門が見つからない事業所では null を返し、申請は部門なしで作成する（劣化許容）。
 * 使用エンドポイント: GET /api/1/sections（2026-07-13 ユーザー承認済み）
 */
function getExecutiveSectionId(freeeCompanyId) {
  return getCachedOrFetch('CACHE_SECTION_EXEC_' + freeeCompanyId, function() {
    const req = new FreeeAPI.Request('sections').addParam('company_id', freeeCompanyId);
    const response = req.requestGET();
    const sections = (response && response.sections) || [];
    const match = sections.find(function(s) { return s.name === '役員精算'; });
    if (!match) {
      Logger.log('⚠️ 部門「役員精算」が見つかりません (company_id=' + freeeCompanyId + ')。部門なしで申請を作成します。');
      return null;
    }
    return match.id;
  });
}

/**
 * 現金支払い用のメモタグ「現金一括YYMM」（例: 現金一括2607）を取得し、
 * 存在しなければ新規作成する（撮影日基準・会社ごと）。
 * 使用エンドポイント: GET /api/1/tags（承認済み）・POST /api/1/tags（承認済み・作成のみ）
 * @param {number} freeeCompanyId
 * @param {string} capturedAt 撮影日時 (ISO 8601)
 * @returns {number|null} メモタグID（失敗時はnull＝タグなしで申請を作成）
 */
/**
 * 事業所の全メモタグを取得する（ページング対応）。
 * タグが3000件を超える事業所（例: ファンテック）で取得漏れ→重複タグ作成を
 * 起こさないよう、limit件ちょうど返ってきた場合はoffsetを進めて続きを取得する。
 */
function fetchAllTags(freeeCompanyId) {
  const LIMIT = 3000;
  const MAX_PAGES = 10; // 3万件まで（安全上限）
  let all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const req = new FreeeAPI.Request('tags')
      .addParam('company_id', freeeCompanyId)
      .addParam('limit', LIMIT)
      .addParam('offset', page * LIMIT);
    const response = req.requestGET();
    const tags = (response && response.tags) || [];
    all = all.concat(tags);
    if (tags.length < LIMIT) break;
  }
  return all;
}

function getOrCreateCashTag(freeeCompanyId, capturedAt) {
  const yymm = Utilities.formatDate(new Date(capturedAt), 'Asia/Tokyo', 'yyMM');
  const tagName = '現金一括' + yymm;
  const cacheKey = 'CACHE_CASH_TAG_' + freeeCompanyId + '_' + yymm;

  try {
    return getCachedOrFetch(cacheKey, function() {
      // 既存タグを全件から検索（ページング対応）
      const tags = fetchAllTags(freeeCompanyId);
      const existing = tags.find(function(t) { return t.name === tagName; });
      if (existing) return existing.id;

      // 参考: 似た命名のタグをログに残す（表記ゆれの診断用）
      const similar = tags.filter(function(t) { return t.name && t.name.indexOf('現金一括') === 0; });
      if (similar.length > 0) {
        Logger.log('ℹ️ 既存の現金一括タグ: ' + similar.map(function(t) { return t.name; }).join(', '));
      }

      // 無ければ新規作成
      validateFreeeRequest('POST', 'tags');
      const created = postToFreeeWithDetail('tags', { company_id: freeeCompanyId, name: tagName });
      if (!created || !created.tag) {
        throw new Error('メモタグ作成に失敗しました: ' + JSON.stringify(created));
      }
      Logger.log('✅ メモタグを新規作成: ' + tagName + ' (id=' + created.tag.id + ')');
      return created.tag.id;
    });
  } catch (e) {
    // タグの取得/作成失敗で申請作成自体を止めない（タグなしで劣化継続）
    Logger.log('⚠️ 現金メモタグの取得/作成に失敗: ' + e.message);
    return null;
  }
}

/**
 * 経費申請ペイロードに部門（役員精算）と現金メモタグを付与する共通処理。
 * どちらも取得失敗時は付与せずに続行する（申請作成を優先）。
 */
function applySectionAndTags(payload, companyId, paymentMethodName, capturedAt) {
  try {
    const sectionId = getExecutiveSectionId(companyId);
    if (sectionId) payload.section_id = sectionId;
  } catch (e) {
    Logger.log('⚠️ 部門IDの取得に失敗（部門なしで続行）: ' + e.message);
  }

  if (paymentMethodName === '現金') {
    const tagId = getOrCreateCashTag(companyId, capturedAt);
    if (tagId) payload.tag_ids = [tagId];
  }
  return payload;
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
  applySectionAndTags(payload, companyId, paymentMethodName, capturedAt);

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
  applySectionAndTags(payload, companyId, paymentMethodName, capturedAt);

  validateFreeeRequest('POST', 'expense_applications');
  const response = postToFreeeWithDetail('expense_applications', payload);

  if (!response || !response.expense_application) {
    throw new Error('Freee グループ経費精算下書き作成に失敗しました: ' + JSON.stringify(response));
  }

  return response.expense_application.id;
}
