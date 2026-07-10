/**
 * GAS Web App API クライアント
 */

import type { Company, PaymentMethod } from './db';

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
  }[]
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
    }))
  );

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'upload', receipts }),
  });

  const json: ApiResponse<UploadResult[]> = await response.json();

  if (!json.success || !json.data) {
    throw new Error(json.error || 'アップロードに失敗しました');
  }

  return json.data;
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
