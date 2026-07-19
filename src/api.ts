/**
 * GAS Web App API クライアント
 */


import { db, updateUploadStatus, updateReceiptDriveFileId, updateReceiptBackupId, updateReceiptFreeeIds, updateReceiptAmount, setEnrichState, getAutoHoldReason, generateId } from './db';
import type { Company, PaymentMethod, Receipt } from './db';

// GAS Web App のデプロイ URL（セットアップ時に設定）
const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzL3-ILK03itxNzael4g4SylPk1vMiMC_u-uO-rWobtiqNAYWcB7KlADuZTaN3TH2c/exec';

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

interface UploadResult {
  receiptIndex: number;
  driveFileId: string;
  freeeReceiptId?: number;
  freeeExpenseId?: number;
  status: 'completed' | 'partial' | 'error';
  error?: string;
}

interface UploadStatusResult {
  requestId: string;
  state: 'unknown' | 'processing' | 'done';
  results: UploadResult[] | null;
}

interface UploadReceiptItem {
  imageBase64: string;
  mimeType: string;
  companyId: string;
  paymentMethodId: string;
  paymentMethodName: string;
  groupName: string | null;
  amount: number;
  expenseDate?: string;
  memo: string;
  capturedAt: string;
  // 撮影直後のバックグラウンドバックアップで既にDriveへ保存済みならそのファイルID。
  // GAS側はこれがあればDriveへの再保存をスキップして再利用する
  driveFileId?: string | null;
  // レシート固有ID。driveFileIdが未保存でも、GAS側はこれで撮影記録シートを照会し、
  // バックアップ済み（または処理中に完了した）Driveファイルへ収束させる（重複作成防止）
  backupId?: string | null;
}

/**
 * アップロード試行ごとの一意なIDを生成する。
 * 通信断でレスポンスが届かなかった場合に、後からGASへ「本当はどうなったか」を
 * 問い合わせるためのキーとして使う。
 */
export function generateUploadRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 古いブラウザ向けの簡易UUID v4フォールバック
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * GAS API のベース URL を取得
 */
function getBaseUrl(): string {
  // LocalStorage から URL を取得（設定画面で保存可能にする）
  const stored = localStorage.getItem('gasWebAppUrl');
  return stored || GAS_WEB_APP_URL;
}

/**
 * APIキー（合言葉）。GAS側のScript Properties「API_KEY」と一致する必要がある。
 * GAS WebアプリのURLは公開リポジトリから知られうるため、URLの秘匿に頼らず
 * 第三者からの不正アップロードを防ぐための簡易認証として全リクエストに添付する。
 */
const API_KEY_STORAGE = 'apiKey';

function getStoredApiKey(): string {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}

/**
 * 未設定なら合言葉の入力を求める（アプリ起動時に一度だけ呼ぶ）。
 * キャンセルした場合は未設定のまま進む（GAS側でAPI_KEY未設定なら従来通り動く）。
 */
export function ensureApiKey(): void {
  if (localStorage.getItem(API_KEY_STORAGE)) return;
  const input = window.prompt('合言葉（APIキー）を入力してください');
  if (input && input.trim()) {
    localStorage.setItem(API_KEY_STORAGE, input.trim());
  }
}

/**
 * サーバーがAPIキー不一致を返した場合、保存済みのキーを破棄する
 * （次回アプリを開いたときに再入力を求めるため）。
 */
function clearApiKeyIfInvalid(errorMessage: string | undefined): void {
  if (errorMessage && errorMessage.includes('APIキーが一致しません')) {
    localStorage.removeItem(API_KEY_STORAGE);
  }
}

/**
 * 会社一覧を取得
 * @param forceRefresh trueならGAS側のマスタキャッシュも強制クリアしてスプシから読み直す
 */
export async function fetchCompanies(forceRefresh = false): Promise<Company[]> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    console.warn('GAS Web App URL が未設定です。SETUP.md を参照してください。');
    return [];
  }

  const response = await fetch(
    `${baseUrl}?action=companies&apiKey=${encodeURIComponent(getStoredApiKey())}${forceRefresh ? '&forceRefresh=1' : ''}`
  );
  const json: ApiResponse<Company[]> = await response.json();

  if (!json.success || !json.data) {
    clearApiKeyIfInvalid(json.error);
    throw new Error(json.error || '会社一覧の取得に失敗しました');
  }

  return json.data;
}

/**
 * 支払い方法一覧を取得
 * @param forceRefresh trueならGAS側のマスタキャッシュも強制クリアしてスプシから読み直す
 */
export async function fetchPaymentMethods(forceRefresh = false): Promise<PaymentMethod[]> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    console.warn('GAS Web App URL が未設定です。SETUP.md を参照してください。');
    return getDefaultPaymentMethods();
  }

  const response = await fetch(
    `${baseUrl}?action=paymentMethods&apiKey=${encodeURIComponent(getStoredApiKey())}${forceRefresh ? '&forceRefresh=1' : ''}`
  );
  const json: ApiResponse<PaymentMethod[]> = await response.json();

  if (!json.success || !json.data) {
    clearApiKeyIfInvalid(json.error);
    throw new Error(json.error || '支払い方法一覧の取得に失敗しました');
  }

  return json.data;
}

/**
 * GAS API未設定時のデフォルト支払い方法
 */
function getDefaultPaymentMethods(): PaymentMethod[] {
  return [
    { id: 'cash', name: '現金', companyId: null, isMajor: true },
    { id: 'visa', name: 'VISA', companyId: null, isMajor: true },
    { id: 'jcb', name: 'JCB', companyId: null, isMajor: true },
    { id: 'amex', name: 'AMEX', companyId: null, isMajor: true },
  ];
}

/**
 * Blob を Base64 文字列に変換
 */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // data:image/jpeg;base64,XXXX の XXXX 部分を返す
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Blob の読み取りに失敗しました'));
    reader.readAsDataURL(blob);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GASへ「requestIdのアップロードが本当はどうなったか」を問い合わせる。
 * 結果の真実は常にGAS側のアップロードログシート（期限なし）にあり、
 * CacheServiceは「そもそも届いたか」の短時間の判定にのみ使われている。
 */
async function fetchUploadStatus(baseUrl: string, requestId: string, expectedCount: number): Promise<UploadStatusResult> {
  const response = await fetch(
    `${baseUrl}?action=uploadStatus&requestId=${encodeURIComponent(requestId)}&expectedCount=${expectedCount}&apiKey=${encodeURIComponent(getStoredApiKey())}`
  );
  const json: ApiResponse<UploadStatusResult> = await response.json();
  if (!json.success || !json.data) {
    clearApiKeyIfInvalid(json.error);
    throw new Error(json.error || 'アップロード状況の確認に失敗しました');
  }
  return json.data;
}

const POLL_INTERVAL_MS = 4000;
const POLL_MAX_TOTAL_MS = 5.5 * 60 * 1000; // GASの実行上限(6分)に収まる範囲
const UNKNOWN_GRACE_MS = 15000; // 受信直後のマーカー書き込みとの競合を避ける猶予

/**
 * fetch自体やレスポンス読み取りが失敗した（サーバーの応答を確認できなかった）際に、
 * doGet(action=uploadStatus)をポーリングして本当の結果を突き止める。
 * - GASが「受信済み」の記録を持っていない → サーバーに届いていない可能性が高く、安全に再試行可能
 * - 処理中 → 完了まで待つ（最大5.5分）
 * - 完了 → 実際の結果を返す（通常成功時と同じ戻り値になる）
 * それでも判定できない場合は、既存の慎重な警告メッセージにフォールバックする。
 */
async function resolveAmbiguousUpload(
  baseUrl: string,
  requestId: string,
  expectedCount: number,
  originalErrorMessage: string
): Promise<UploadResult[]> {
  const startedAt = Date.now();
  let sawProcessing = false;

  while (Date.now() - startedAt < POLL_MAX_TOTAL_MS) {
    await sleep(POLL_INTERVAL_MS);

    let status: UploadStatusResult;
    try {
      status = await fetchUploadStatus(baseUrl, requestId, expectedCount);
    } catch {
      // 状況確認自体が失敗（オフライン等）。時間内であれば再試行を続ける
      continue;
    }

    if (status.state === 'done') {
      if (status.results) return status.results;
      throw new Error('アップロードに失敗しました');
    }

    if (status.state === 'processing') {
      sawProcessing = true;
      continue;
    }

    // state === 'unknown'
    if (sawProcessing) {
      // 一度は処理中を確認していたのに急に見つからなくなった → 想定外の状態。安全側に倒す
      break;
    }
    if (Date.now() - startedAt < UNKNOWN_GRACE_MS) {
      continue;
    }
    throw new Error(
      '通信エラーによりサーバーに届いていない可能性が高いです。サーバー側では何も処理されていません。' +
      '安全に再度アップロードできます。' +
      '（詳細: ' + originalErrorMessage + '）'
    );
  }

  // タイムアウト、または想定外の状態遷移 → 判定できないので慎重な警告にフォールバック
  throw new Error(
    '通信エラーのためサーバーからの応答を確認できませんでした。処理自体はサーバー側で完了している可能性があります。' +
    'リトライする前に、freeeやスプレッドシートの「アップロードログ」で実際にアップロード・登録済みでないか確認してください。' +
    '（詳細: ' + originalErrorMessage + '）'
  );
}

/**
 * レシートをアップロード
 */
export async function uploadReceipts(
  items: {
    image: Blob;
    companyId: string;
    paymentMethodId: string;
    paymentMethodName: string;
    groupName: string | null;
    amount: number | null;
    expenseDate?: string;
    memo: string;
    capturedAt: Date;
    driveFileId?: string | null;
    backupId?: string | null;
  }[],
  requestId: string
): Promise<UploadResult[]> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new Error('GAS Web App URL が未設定です。SETUP.md を参照してセットアップしてください。');
  }

  // 画像を Base64 に変換。
  // ローカルのBlobが読めなくても、撮影直後バックアップ済み（driveFileIdあり）なら
  // GAS側がDrive上のファイルを再利用するため、画像なしで続行できる（救済経路）。
  const receipts: UploadReceiptItem[] = await Promise.all(
    items.map(async (item) => {
      let imageBase64 = '';
      try {
        imageBase64 = await blobToBase64(item.image);
      } catch (err) {
        if (!item.driveFileId) {
          throw new Error(
            '画像の読み取りに失敗しました。Driveバックアップも未完了のため送信できません。' +
            '（詳細: ' + (err as Error).message + '）'
          );
        }
        console.warn('blobToBase64 failed; falling back to backed-up driveFileId:', item.driveFileId);
      }
      return {
        imageBase64,
        mimeType: item.image.type || 'image/jpeg',
        companyId: item.companyId,
        paymentMethodId: item.paymentMethodId,
        paymentMethodName: item.paymentMethodName,
        groupName: item.groupName,
        // 下書きは金額0で作成し、ユーザー確認後にupdateExpenseDraftAmountで確定する。
        amount: item.amount !== null && item.amount > 0 ? item.amount : 0,
        expenseDate: item.expenseDate,
        memo: item.memo,
        capturedAt: item.capturedAt.toISOString(),
        driveFileId: item.driveFileId ?? null,
        backupId: item.backupId ?? null,
      };
    })
  );

  // fetch自体やレスポンス読み取りの失敗は「サーバーの応答を確認できなかった」だけで、
  // GAS側の処理（freeeへのアップロード含む）は継続・完了している可能性がある
  // （グループアップロードは数十秒かかることがあり、その間の通信断で起きやすい）。
  // その場合はすぐにエラーとせず、GASに直接問い合わせて本当の結果を確認する。
  let response: Response;
  try {
    response = await fetch(baseUrl, {
      method: 'POST',
      // text/plainは「単純リクエスト」なのでCORSプリフライトが発生しない。
      // GAS WebアプリはOPTIONS(プリフライト)に405を返すため、application/jsonだと
      // 環境によってPOSTが「Failed to fetch」になる（実測で確認済み）。
      // GAS側はe.postData.contentsを読むだけなのでContent-Typeに依存しない。
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'upload', apiKey: getStoredApiKey(), requestId, receipts }),
    });
  } catch (err) {
    return resolveAmbiguousUpload(baseUrl, requestId, items.length, (err as Error).message);
  }

  let json: ApiResponse<UploadResult[]>;
  try {
    json = await response.json();
  } catch (err) {
    return resolveAmbiguousUpload(baseUrl, requestId, items.length, (err as Error).message);
  }

  if (!json.success || !json.data) {
    clearApiKeyIfInvalid(json.error);
    throw new Error(json.error || 'アップロードに失敗しました');
  }

  return json.data;
}

/**
 * 通信断発生直後にアプリを閉じてしまった場合など、'uploading'のまま残っている
 * レシートを次回起動時に自動で解消する。requestIdごとにまとめてGASへ1回問い合わせ、
 * まだ処理中であればその場でポーリングを再開する。
 */
export async function reconcilePendingUploads(): Promise<void> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) return;

  const stuck = await db.receipts.where('uploadStatus').equals('uploading').toArray();
  if (stuck.length === 0) return;

  const groups = new Map<string, Receipt[]>();
  for (const receipt of stuck) {
    if (!receipt.uploadRequestId) continue; // requestIdの無い古いレコードは対象外
    const list = groups.get(receipt.uploadRequestId) || [];
    list.push(receipt);
    groups.set(receipt.uploadRequestId, list);
  }

  for (const [requestId, receiptsInGroup] of groups) {
    const byIndex = new Map<number, Receipt>();
    for (const receipt of receiptsInGroup) {
      if (receipt.uploadRequestIndex !== null && receipt.uploadRequestIndex !== undefined) {
        byIndex.set(receipt.uploadRequestIndex, receipt);
      }
    }

    const applyResults = async (results: UploadResult[]) => {
      for (const result of results) {
        const receipt = byIndex.get(result.receiptIndex);
        if (!receipt?.id) continue;
        // Drive保存済みのファイルIDは成否によらず保存し、リトライ時の再作成・再送信を防ぐ
        if (result.driveFileId && !receipt.driveFileId) {
          await updateReceiptDriveFileId(receipt.id, result.driveFileId);
        }
        if (result.status === 'completed') {
          await updateReceiptFreeeIds(receipt.id, result.freeeReceiptId ?? null, result.freeeExpenseId ?? null);
          await updateUploadStatus(receipt.id, 'completed');
        } else {
          await updateUploadStatus(receipt.id, 'error', result.error || 'アップロードに失敗しました');
        }
      }
    };

    try {
      const status = await fetchUploadStatus(baseUrl, requestId, receiptsInGroup.length);

      if (status.state === 'done' && status.results) {
        await applyResults(status.results);
      } else if (status.state === 'processing') {
        try {
          const results = await resolveAmbiguousUpload(
            baseUrl,
            requestId,
            receiptsInGroup.length,
            'アプリを再度開いたため状況を再確認しています'
          );
          await applyResults(results);
        } catch (err) {
          for (const receipt of receiptsInGroup) {
            if (receipt.id) await updateUploadStatus(receipt.id, 'error', (err as Error).message);
          }
        }
      } else {
        // 'unknown' または結果を伴わない 'done'
        for (const receipt of receiptsInGroup) {
          if (receipt.id) {
            await updateUploadStatus(
              receipt.id,
              'error',
              'サーバーに届いていない可能性が高いです。安全に再度アップロードできます。'
            );
          }
        }
      }
    } catch (err) {
      // 状況確認自体が失敗（オフライン等）。今回は諦めて次回起動時に再試行する
      console.error('reconcilePendingUploads: status check failed for', requestId, err);
    }
  }
}

/**
 * 撮影直後、アップロードボタンを待たずにバックグラウンドでDriveへ画像をバックアップする。
 * ベストエフォート（失敗しても撮影自体のUI・操作感には一切影響させない）。
 * freeeへは一切アクセスせず、Drive保存と「撮影記録」シートへの記録のみ行う。
 * 成功したらdriveFileIdをローカルに保存し、実際のアップロード時にDriveへの再保存を避ける。
 */
/**
 * 自動アップロード: 保留理由のない未アップロードレシートを1枚ずつ自動で
 * freeeへ申請する（証憑＋経費申請下書きの同時作成＝現行の一括フローと同じ経路）。
 * - グループ設定ありは対象外（グループ専用ボタンで手動申請）
 * - 会社未設定は対象外（設定された時点で次のトリガーで自動処理される）
 * - 金額未入力は仮1円で申請（Phase 2のOCR補完でPUT修正予定）
 * @returns 処理した枚数（成功・失敗問わず。0なら対象なし）
 */
let autoUploadRunning = false;

export async function autoProcessPendingReceipts(): Promise<number> {
  if (autoUploadRunning) return 0;
  autoUploadRunning = true;
  try {
    const pending = await db.receipts.where('uploadStatus').equals('pending').toArray();
    const targets = pending.filter((r) => r.id !== undefined && getAutoHoldReason(r) === null);
    let processed = 0;

    for (const target of targets) {
      const id = target.id!;
      const requestId = generateUploadRequestId();
      try {
        await updateUploadStatus(id, 'uploading', null, requestId, 0);
        // ステータス更新でレコードが作り直されるため、必ず新鮮なオブジェクトを使う
        const fresh = (await db.receipts.get(id)) ?? target;

        const results = await uploadReceipts([{
          image: fresh.image,
          companyId: fresh.companyId!,
          paymentMethodId: fresh.paymentMethodId,
          paymentMethodName: fresh.paymentMethodName,
          groupName: null,
          amount: fresh.amount,
          expenseDate: fresh.expenseDate,
          memo: fresh.memo,
          capturedAt: fresh.createdAt,
          driveFileId: fresh.driveFileId,
          backupId: fresh.backupId,
        }], requestId);

        const result = results[0];
        if (result?.driveFileId && !fresh.driveFileId) {
          await updateReceiptDriveFileId(id, result.driveFileId);
        }
        if (result?.status === 'completed') {
          await updateReceiptFreeeIds(id, result.freeeReceiptId ?? null, result.freeeExpenseId ?? null);
          await updateUploadStatus(id, 'completed');
        } else {
          await updateUploadStatus(id, 'error', result?.error || 'アップロードに失敗しました');
        }
      } catch (err) {
        // 自動処理は静かに失敗させ、エラータブとバッジで気付ける状態にする
        console.error('autoProcessPendingReceipts failed for', id, err);
        await updateUploadStatus(id, 'error', (err as Error).message).catch(() => {});
      }
      processed++;
    }

    return processed;
  } finally {
    autoUploadRunning = false;
  }
}

/**
 * AI推測（enrich）の後処理: アップロード完了済みでenrich待ちのレシートについて、
 * GASへOCR結果の取得と申請の補完（PUT編集）を依頼する。
 * OCRが未確定なら'pending'が返り、次のトリガー（起動時等）で再試行される。
 * アップロードから24時間経ってもOCRが確定しない場合は諦める（given_up）。
 * @returns 状態が変化した枚数
 */
const ENRICH_GIVE_UP_MS = 24 * 60 * 60 * 1000;
let enrichRunning = false;

export async function enrichPendingReceipts(): Promise<number> {
  if (enrichRunning) return 0;
  enrichRunning = true;
  try {
    const baseUrl = getBaseUrl();
    if (!baseUrl) return 0;

    const targets = await db.receipts
      .filter((r) =>
        r.uploadStatus === 'completed' &&
        r.enrichState === 'pending' &&
        !!r.freeeReceiptId &&
        !!r.freeeExpenseId
      )
      .toArray();

    let changed = 0;
    for (const r of targets) {
      const id = r.id!;

      if (r.uploadedAt && Date.now() - new Date(r.uploadedAt).getTime() > ENRICH_GIVE_UP_MS) {
        await setEnrichState(id, 'given_up');
        changed++;
        continue;
      }

      try {
        const response = await fetch(baseUrl, {
          method: 'POST',
          // text/plain=単純リクエスト（CORSプリフライト回避）。uploadReceiptsのコメント参照
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'enrichReceipt',
            apiKey: getStoredApiKey(),
            companyId: r.companyId,
            freeeReceiptId: r.freeeReceiptId,
            freeeExpenseId: r.freeeExpenseId,
            // ローカルの金額が未入力=仮1円で申請済み → OCR金額でPUT修正してよい
            amountProvisional: r.amount === null,
          }),
        });
        const json: ApiResponse<{ state: string; updatedAmount?: number | null }> = await response.json();

        if (!json.success || !json.data) {
          clearApiKeyIfInvalid(json.error);
          console.warn('enrichReceipt failed:', id, json.error);
          continue;
        }

        if (json.data.state === 'done') {
          if (json.data.updatedAmount) {
            await updateReceiptAmount(id, json.data.updatedAmount);
          }
          await setEnrichState(id, 'done');
          changed++;
        }
        // 'pending'は何もしない（次のトリガーで再試行）
      } catch (err) {
        // オフライン等。次のトリガーで再試行
        console.warn('enrichPendingReceipts failed for', id, err);
      }
    }
    return changed;
  } finally {
    enrichRunning = false;
  }
}

/**
 * ユーザーが確認した金額を、既存のfreee経費精算下書きへ反映する。
 * freee側の更新が成功してから、呼び出し元がIndexedDBの金額を確定する。
 */
export async function updateExpenseDraftAmount(
  companyId: string,
  freeeExpenseId: number,
  amount: number,
): Promise<void> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) throw new Error('GAS Web App URL が未設定です。');
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action: 'updateExpenseAmount',
      apiKey: getStoredApiKey(),
      companyId,
      freeeExpenseId,
      amount,
    }),
  });
  const json: ApiResponse<{ amount: number }> = await response.json();
  if (!json.success || !json.data) {
    clearApiKeyIfInvalid(json.error);
    throw new Error(json.error || '経費精算下書きの金額更新に失敗しました');
  }
}

/** ユーザーが確認した日付を既存のfreee経費精算下書きへ反映する */
export async function updateExpenseDraftDate(
  companyId: string,
  freeeExpenseId: number,
  freeeReceiptId: number,
  expenseDate: string,
): Promise<void> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) throw new Error('GAS Web App URL が未設定です。');
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action: 'updateExpenseDate',
      apiKey: getStoredApiKey(),
      companyId,
      freeeExpenseId,
      freeeReceiptId,
      expenseDate,
    }),
  });
  const json: ApiResponse<{ expenseDate: string }> = await response.json();
  if (!json.success || !json.data) {
    clearApiKeyIfInvalid(json.error);
    throw new Error(json.error || '経費精算下書きの日付更新に失敗しました');
  }
}

/**
 * 自動アップロードを遅延実行で予約する（デバウンス）。
 * 撮影後は連写を待ってまとめて処理するため30秒、入力変更後は5秒程度を想定。
 * アップロード後は下書き作成結果を画面へ反映する。
 * @param onDone 1枚以上処理した場合に呼ばれる（UI更新用）
 */
let autoUploadTimer: ReturnType<typeof setTimeout> | undefined;

export function scheduleAutoUpload(onDone: () => void, delayMs = 30000): void {
  if (autoUploadTimer !== undefined) clearTimeout(autoUploadTimer);
  autoUploadTimer = setTimeout(() => {
    autoUploadTimer = undefined;
    autoProcessPendingReceipts()
      .then((processed) => {
        if (processed > 0) onDone();
      });
  }, delayMs);
}

// このセッションでバックアップ処理中のreceiptId。並行に同じレシートを
// 二重送信しないためのガード（backupPendingReceiptsのPromise.allや、
// 撮影直後発火と起動時再試行が重なるケースで効く）。
const inFlightBackups = new Set<number>();

export async function backupReceiptInBackground(receiptId: number): Promise<void> {
  if (inFlightBackups.has(receiptId)) return;
  inFlightBackups.add(receiptId);
  try {
    const receipt = await db.receipts.get(receiptId);
    if (!receipt || receipt.driveFileId) return;

    const baseUrl = getBaseUrl();
    if (!baseUrl) return;

    // backupId は撮影時に発番済みだが、それ以前の旧レコードには無いので補完する。
    // GASはこのIDで撮影記録シートを照会し、既にバックアップ済みなら新規Driveファイルを
    // 作らず既存のものを返す（冪等化）。iOS停止でdriveFileId保存が失われても重複しない。
    let backupId = receipt.backupId;
    if (!backupId) {
      backupId = generateId();
      await updateReceiptBackupId(receiptId, backupId);
    }

    const imageBase64 = await blobToBase64(receipt.image);
    const response = await fetch(baseUrl, {
      method: 'POST',
      // text/plain=単純リクエスト（CORSプリフライト回避）。uploadReceiptsのコメント参照
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'backupReceipt',
        apiKey: getStoredApiKey(),
        backupId,
        imageBase64,
        mimeType: receipt.image.type || 'image/jpeg',
        companyId: receipt.companyId,
        companyName: receipt.companyName,
        paymentMethodName: receipt.paymentMethodName,
        groupName: receipt.groupName,
        amount: receipt.amount,
        expenseDate: receipt.expenseDate,
        memo: receipt.memo,
        capturedAt: receipt.createdAt.toISOString(),
      }),
    });

    const json: ApiResponse<{ driveFileId: string }> = await response.json();
    if (json.success && json.data?.driveFileId) {
      await updateReceiptDriveFileId(receiptId, json.data.driveFileId);
    }
  } catch (err) {
    // オフライン等で失敗しても、次回起動時にbackupPendingReceiptsが再試行する
    console.error('backupReceiptInBackground failed for', receiptId, err);
  } finally {
    inFlightBackups.delete(receiptId);
  }
}

/**
 * まだバックアップされていない（driveFileIdが未設定の）レシートを、
 * アプリ起動時にまとめてベストエフォートで再試行する。
 * アップロード済み（'completed'）のレシートはDrive保存が既に確定しているので対象外。
 */
export async function backupPendingReceipts(): Promise<void> {
  const targets = await db.receipts
    .filter((r) => !r.driveFileId && r.uploadStatus !== 'completed')
    .toArray();

  await Promise.all(targets.map((r) => backupReceiptInBackground(r.id!)));
}

/**
 * マスタデータのキャッシュ（Stale-While-Revalidate方式）。
 *
 * 起動高速化のため、キャッシュがあれば年齢を問わず即座に返して画面をブロックしない。
 * 古いキャッシュを返した場合は、裏でGASから最新を取得してキャッシュだけ差し替える
 * （次回起動から反映。セッション中のUI差し替えは行わず、選択状態を壊さない）。
 * マスタは年に数回しか変わらないため、この設計で実用上の鮮度は十分。
 * スプシ編集を即時反映したい場合は設定画面の「マスタを今すぐ更新」を使う。
 */
const CACHE_KEY_COMPANIES = 'cache_companies';
const CACHE_KEY_PAYMENT_METHODS = 'cache_paymentMethods';
// キャッシュがこの時間より古ければ、即時返却した後にバックグラウンドで再取得する
const REVALIDATE_AFTER_MS = 1000 * 60 * 5;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

function readCache<T>(key: string): CacheEntry<T> | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CacheEntry<T>;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, data: T): void {
  localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
}

// バックグラウンド再取得の多重発火防止（同一セッション内）
const revalidatingKeys = new Set<string>();

async function getCachedMaster<T>(
  key: string,
  fetcher: () => Promise<T>,
  fallback: T
): Promise<T> {
  const cached = readCache<T>(key);

  if (cached) {
    // 即時返却。古ければ裏で更新（fire-and-forget、失敗は無視して次回に任せる）
    if (Date.now() - cached.timestamp > REVALIDATE_AFTER_MS && !revalidatingKeys.has(key)) {
      revalidatingKeys.add(key);
      fetcher()
        .then((data) => writeCache(key, data))
        .catch((err) => console.warn('マスタのバックグラウンド更新に失敗:', key, err))
        .finally(() => revalidatingKeys.delete(key));
    }
    return cached.data;
  }

  // キャッシュが無い初回起動のみ、取得完了を待つ
  try {
    const data = await fetcher();
    writeCache(key, data);
    return data;
  } catch {
    return fallback;
  }
}

export async function getCachedCompanies(): Promise<Company[]> {
  return getCachedMaster(CACHE_KEY_COMPANIES, () => fetchCompanies(), []);
}

export async function getCachedPaymentMethods(): Promise<PaymentMethod[]> {
  return getCachedMaster(CACHE_KEY_PAYMENT_METHODS, () => fetchPaymentMethods(), getDefaultPaymentMethods());
}

/**
 * 設定画面用: GAS側のマスタキャッシュ（PropertiesService・180日）も強制クリアした上で
 * 最新マスタを取得し直し、ローカルキャッシュを差し替える。
 * スプレッドシートのマスタを編集した直後に反映させたいときに使う。
 * @returns 取得できた件数（完了メッセージ表示用）
 */
export async function forceRefreshMasters(): Promise<{ companies: number; paymentMethods: number }> {
  const [companies, paymentMethods] = await Promise.all([
    fetchCompanies(true),
    fetchPaymentMethods(true),
  ]);
  writeCache(CACHE_KEY_COMPANIES, companies);
  writeCache(CACHE_KEY_PAYMENT_METHODS, paymentMethods);
  return { companies: companies.length, paymentMethods: paymentMethods.length };
}

/**
 * 設定画面用: 保存済みの合言葉（APIキー）を破棄して再入力を求める
 */
export function resetApiKey(): void {
  localStorage.removeItem(API_KEY_STORAGE);
  ensureApiKey();
}
