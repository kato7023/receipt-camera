/**
 * GAS Web App API クライアント
 */


import { db, updateUploadStatus, updateReceiptDriveFileId } from './db';
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
  memo: string;
  capturedAt: string;
  // 撮影直後のバックグラウンドバックアップで既にDriveへ保存済みならそのファイルID。
  // GAS側はこれがあればDriveへの再保存をスキップして再利用する
  driveFileId?: string | null;
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
 * 会社一覧を取得
 */
export async function fetchCompanies(): Promise<Company[]> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    console.warn('GAS Web App URL が未設定です。SETUP.md を参照してください。');
    return [];
  }

  const response = await fetch(`${baseUrl}?action=companies`);
  const json: ApiResponse<Company[]> = await response.json();

  if (!json.success || !json.data) {
    throw new Error(json.error || '会社一覧の取得に失敗しました');
  }

  return json.data;
}

/**
 * 支払い方法一覧を取得
 */
export async function fetchPaymentMethods(): Promise<PaymentMethod[]> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    console.warn('GAS Web App URL が未設定です。SETUP.md を参照してください。');
    return getDefaultPaymentMethods();
  }

  const response = await fetch(`${baseUrl}?action=paymentMethods`);
  const json: ApiResponse<PaymentMethod[]> = await response.json();

  if (!json.success || !json.data) {
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
    `${baseUrl}?action=uploadStatus&requestId=${encodeURIComponent(requestId)}&expectedCount=${expectedCount}`
  );
  const json: ApiResponse<UploadStatusResult> = await response.json();
  if (!json.success || !json.data) {
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
    amount: number;
    memo: string;
    capturedAt: Date;
    driveFileId?: string | null;
  }[],
  requestId: string
): Promise<UploadResult[]> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new Error('GAS Web App URL が未設定です。SETUP.md を参照してセットアップしてください。');
  }

  // 画像を Base64 に変換
  const receipts: UploadReceiptItem[] = await Promise.all(
    items.map(async (item) => ({
      imageBase64: await blobToBase64(item.image),
      mimeType: item.image.type || 'image/jpeg',
      companyId: item.companyId,
      paymentMethodId: item.paymentMethodId,
      paymentMethodName: item.paymentMethodName,
      groupName: item.groupName,
      amount: item.amount > 0 ? item.amount : 1,
      memo: item.memo,
      capturedAt: item.capturedAt.toISOString(),
      driveFileId: item.driveFileId ?? null,
    }))
  );

  // fetch自体やレスポンス読み取りの失敗は「サーバーの応答を確認できなかった」だけで、
  // GAS側の処理（freeeへのアップロード含む）は継続・完了している可能性がある
  // （グループアップロードは数十秒かかることがあり、その間の通信断で起きやすい）。
  // その場合はすぐにエラーとせず、GASに直接問い合わせて本当の結果を確認する。
  let response: Response;
  try {
    response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'upload', requestId, receipts }),
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
        if (result.status === 'completed') {
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
export async function backupReceiptInBackground(receiptId: number): Promise<void> {
  try {
    const receipt = await db.receipts.get(receiptId);
    if (!receipt || receipt.driveFileId) return;

    const baseUrl = getBaseUrl();
    if (!baseUrl) return;

    const imageBase64 = await blobToBase64(receipt.image);
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'backupReceipt',
        imageBase64,
        mimeType: receipt.image.type || 'image/jpeg',
        companyId: receipt.companyId,
        companyName: receipt.companyName,
        paymentMethodName: receipt.paymentMethodName,
        groupName: receipt.groupName,
        amount: receipt.amount,
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
 * マスタデータをキャッシュから取得、なければAPIから取得
 */
const CACHE_KEY_COMPANIES = 'cache_companies';
const CACHE_KEY_PAYMENT_METHODS = 'cache_paymentMethods';
const CACHE_DURATION = 1000 * 60 * 30; // 30分

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export async function getCachedCompanies(): Promise<Company[]> {
  const cached = localStorage.getItem(CACHE_KEY_COMPANIES);
  if (cached) {
    const entry: CacheEntry<Company[]> = JSON.parse(cached);
    if (Date.now() - entry.timestamp < CACHE_DURATION) {
      return entry.data;
    }
  }

  try {
    const data = await fetchCompanies();
    localStorage.setItem(
      CACHE_KEY_COMPANIES,
      JSON.stringify({ data, timestamp: Date.now() })
    );
    return data;
  } catch {
    // APIエラー時はキャッシュがあれば返す
    if (cached) {
      return (JSON.parse(cached) as CacheEntry<Company[]>).data;
    }
    return [];
  }
}

export async function getCachedPaymentMethods(): Promise<PaymentMethod[]> {
  const cached = localStorage.getItem(CACHE_KEY_PAYMENT_METHODS);
  if (cached) {
    const entry: CacheEntry<PaymentMethod[]> = JSON.parse(cached);
    if (Date.now() - entry.timestamp < CACHE_DURATION) {
      return entry.data;
    }
  }

  try {
    const data = await fetchPaymentMethods();
    localStorage.setItem(
      CACHE_KEY_PAYMENT_METHODS,
      JSON.stringify({ data, timestamp: Date.now() })
    );
    return data;
  } catch {
    if (cached) {
      return (JSON.parse(cached) as CacheEntry<PaymentMethod[]>).data;
    }
    return getDefaultPaymentMethods();
  }
}
