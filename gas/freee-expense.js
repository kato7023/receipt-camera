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
 * PUT expense_applications は 2026-07-13 ユーザー承認
 * （本アプリが作成した下書き申請の更新に限定。マスタデータには一切触れない。AGENTS.md参照）
 */
var ALLOWED_POST_ENDPOINTS = ['receipts', 'expense_applications', 'tags'];
var ALLOWED_PUT_ENDPOINT_PREFIXES = ['expense_applications/'];

/**
 * Freee API リクエストの安全性を検証
 * DELETE は全面禁止、POST/PUT はホワイトリストのみ許可
 */
function validateFreeeRequest(method, endpoint) {
  method = method.toUpperCase();

  if (method === 'DELETE') {
    throw new Error('🔴 安全保護: Freee API への DELETE リクエストは禁止されています');
  }

  if (method === 'PUT') {
    const allowed = ALLOWED_PUT_ENDPOINT_PREFIXES.some(function(prefix) {
      return endpoint.indexOf(prefix) === 0;
    });
    if (!allowed) {
      throw new Error('🔴 安全保護: エンドポイント "' + endpoint + '" への PUT は許可されていません。許可: ' + ALLOWED_PUT_ENDPOINT_PREFIXES.join(', '));
    }
    return true;
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
 * freee APIへのGET（パスパラメータ付きエンドポイント対応版）。
 * freeeAPIv2ライブラリのRequestクラスはURL末尾にスラッシュを付けるため
 * `receipts/{id}` のようなパスと相性が悪い。ライブラリのtokenゲッターのみ利用し
 * （ライブラリ自体は変更しない）、URLを自前で組み立てる。
 * @param {string} path 例: 'receipts/123', 'expense_applications'
 * @param {Object} params クエリパラメータ（company_id等）
 */
function getFromFreeeWithDetail(path, params) {
  const token = new FreeeAPI.Request('receipts').token;
  const query = Object.keys(params || {}).map(function(k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  const url = 'https://api.freee.co.jp/api/1/' + path + (query ? '?' + query : '');

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + token, 'accept': 'application/json' },
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const text = response.getContentText();
  if (String(status).match(/2\d\d/) === null) {
    throw new Error('Freee APIエラー (HTTP ' + status + ', GET ' + path + '): ' + text);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * freee APIへのPUT。expense_applications/{id}（本アプリ作成の下書き申請の更新）専用。
 * validateFreeeRequestの許可リスト検査を必ず通る。
 */
function putToFreeeWithDetail(path, payload) {
  validateFreeeRequest('PUT', path);

  const token = new FreeeAPI.Request('receipts').token;
  const url = 'https://api.freee.co.jp/api/1/' + path;

  const response = UrlFetchApp.fetch(url, {
    method: 'put',
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
    throw new Error('Freee APIエラー (HTTP ' + status + ', PUT ' + path + '): ' + text + ' | 送信内容: ' + JSON.stringify(payload));
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
 * 証憑のOCR解析結果（receipt_metadatum）を取得する。
 * OCRは証憑アップロード後に非同期で実行されるため、未確定の場合はnullを返す。
 * ※発行元(partner_name)の自動推測は上位プラン限定の可能性があり、
 *   金額・発行日だけが入るケースも正常系として扱う。
 * @returns {{partnerName:string, issueDate:string, amount:number|null}|null}
 */
function getReceiptMetadata(freeeReceiptId, freeeCompanyId) {
  const response = getFromFreeeWithDetail('receipts/' + freeeReceiptId, { company_id: freeeCompanyId });
  const receipt = response && response.receipt;
  const meta = receipt && receipt.receipt_metadatum;
  if (!meta) return null;

  const amount = (meta.amount !== undefined && meta.amount !== null) ? Number(meta.amount) : null;
  const partnerName = meta.partner_name ? String(meta.partner_name) : '';
  const issueDate = meta.issue_date ? String(meta.issue_date) : '';

  // 全項目が空ならOCR未確定とみなす
  if (!partnerName && !issueDate && (amount === null || isNaN(amount))) return null;

  return { partnerName: partnerName, issueDate: issueDate, amount: (amount !== null && !isNaN(amount)) ? amount : null };
}

/**
 * 過去の経費申請から類似のものを探し、経費科目テンプレートIDを推定する。
 * 優先順位: ①発行元名がタイトル/備考に含まれる直近の申請 ②金額が一致する直近の申請。
 * 見つからなければnull（呼び出し側で現行の消耗品費フォールバックを維持）。
 * @returns {{templateId:number, reason:string}|null}
 */
function findSimilarExpenseApplication(freeeCompanyId, partnerName, amount, excludeApplicationId) {
  try {
    // 直近の申請100件を取得（新しい順に返る想定。念のためissue_dateで降順ソート）
    const response = getFromFreeeWithDetail('expense_applications', {
      company_id: freeeCompanyId,
      limit: 100,
    });
    const apps = ((response && response.expense_applications) || [])
      .filter(function(a) { return a.id !== excludeApplicationId; })
      .sort(function(a, b) { return String(b.issue_date) < String(a.issue_date) ? -1 : 1; });

    const extractTemplateId = function(app) {
      const lines = app.purchase_lines || [];
      for (let i = 0; i < lines.length; i++) {
        const eaLines = lines[i].expense_application_lines || [];
        for (let j = 0; j < eaLines.length; j++) {
          if (eaLines[j].expense_application_line_template_id) {
            return eaLines[j].expense_application_line_template_id;
          }
        }
      }
      return null;
    };

    // ① 発行元名の一致（タイトルまたは備考に含まれる）
    if (partnerName) {
      for (let i = 0; i < apps.length; i++) {
        const app = apps[i];
        const haystack = String(app.title || '') + ' ' + String(app.description || '');
        if (haystack.indexOf(partnerName) !== -1) {
          const templateId = extractTemplateId(app);
          if (templateId) return { templateId: templateId, reason: '発行元「' + partnerName + '」が過去申請と一致' };
        }
      }
    }

    // ② 金額の一致
    if (amount !== null && amount > 0) {
      for (let i = 0; i < apps.length; i++) {
        const app = apps[i];
        if (Number(app.total_amount) === Number(amount)) {
          const templateId = extractTemplateId(app);
          if (templateId) return { templateId: templateId, reason: '金額' + amount + '円が過去申請と一致' };
        }
      }
    }

    return null;
  } catch (e) {
    Logger.log('⚠️ 過去申請の照合に失敗（推定なしで続行）: ' + e.message);
    return null;
  }
}

/**
 * OCR結果と過去照合をもとに、本アプリが作成した下書き申請をPUTで更新する。
 * - amountProvisional=true（仮1円で作成済み）かつOCR金額あり → 金額を修正
 * - 経費科目テンプレートの推定が得られた場合 → 明細のテンプレートを差し替え
 * - 備考にOCR情報と推定根拠を追記
 * purchase_linesは「IDを指定しない行は削除される」PUT仕様のため、
 * 必ずGETで現状を取得し、行ID・明細行IDを保持したまま送る。
 * @returns {{updatedAmount:number|null, note:string}}
 */
function enrichExpenseApplication(freeeCompanyId, freeeExpenseId, ocr, similar, amountProvisional) {
  const current = getFromFreeeWithDetail('expense_applications/' + freeeExpenseId, { company_id: freeeCompanyId });
  const app = current && current.expense_application;
  if (!app) throw new Error('経費申請の取得に失敗しました: ' + JSON.stringify(current));

  if (app.status !== 'draft' && app.status !== 'feedback') {
    // 既に申請中・承認済みなら触らない（安全側）
    return { updatedAmount: null, note: 'status=' + app.status + ' のため更新せず' };
  }

  const newAmount = (amountProvisional && ocr && ocr.amount !== null && ocr.amount > 0) ? ocr.amount : null;

  // 行ID・明細行IDを保持しつつ、必要な箇所だけ書き換える
  const purchaseLines = (app.purchase_lines || []).map(function(line) {
    const eaLines = (line.expense_application_lines || []).map(function(ea) {
      const updated = { id: ea.id, amount: ea.amount, description: ea.description };
      if (ea.expense_application_line_template_id) {
        updated.expense_application_line_template_id = ea.expense_application_line_template_id;
      }
      if (newAmount !== null) updated.amount = newAmount;
      if (similar && similar.templateId) updated.expense_application_line_template_id = similar.templateId;
      return updated;
    });
    const result = {
      id: line.id,
      transaction_date: line.transaction_date,
      expense_application_lines: eaLines,
    };
    if (line.receipt_id) result.receipt_id = line.receipt_id;
    return result;
  });

  // 備考にOCR情報・推定根拠を追記（既存の備考は保持）
  const noteParts = [];
  if (ocr) {
    if (ocr.partnerName) noteParts.push('発行元: ' + ocr.partnerName);
    if (ocr.issueDate) noteParts.push('発行日: ' + ocr.issueDate);
    if (ocr.amount !== null) noteParts.push('OCR金額: ' + ocr.amount + '円');
  }
  if (similar) noteParts.push('科目推定: ' + similar.reason);
  const enrichNote = noteParts.length ? '[自動補完] ' + noteParts.join(' / ') : '';
  const description = [String(app.description || ''), enrichNote].filter(Boolean).join('\n');

  const payload = {
    company_id: freeeCompanyId,
    title: app.title,
    issue_date: app.issue_date,
    description: description,
    purchase_lines: purchaseLines,
  };
  if (app.section_id) payload.section_id = app.section_id;
  if (app.tag_ids && app.tag_ids.length) payload.tag_ids = app.tag_ids;

  putToFreeeWithDetail('expense_applications/' + freeeExpenseId, payload);

  return { updatedAmount: newAmount, note: enrichNote };
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
