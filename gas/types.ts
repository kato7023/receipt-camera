/**
 * 型定義 — 領収書撮影システム V2 GAS バックエンド
 */

/** 会社マスタ */
interface Company {
  id: string;
  name: string;
  freeeCompanyId: number;
  active: boolean;
}

/** 支払い方法マスタ */
interface PaymentMethod {
  id: string;
  name: string;
  companyId: string | null; // null = 全社共通
  isMajor: boolean;         // ボタン表示するか
  active: boolean;
}

/** アップロードリクエスト（PWA → GAS） */
interface UploadRequest {
  action: 'upload';
  receipts: ReceiptUploadItem[];
}

/** 個別レシートのアップロード情報 */
interface ReceiptUploadItem {
  imageBase64: string;       // base64エンコード画像
  mimeType: string;          // image/jpeg 等
  companyId: string;
  paymentMethodId: string;
  paymentMethodName: string;
  groupName: string | null;  // グループ化用
  memo: string;
  capturedAt: string;        // ISO 8601
}

/** GAS → PWA レスポンス */
interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** アップロード結果 */
interface UploadResult {
  receiptIndex: number;
  driveFileId: string;
  freeeReceiptId?: number;
  freeeExpenseId?: number;
  status: 'completed' | 'partial' | 'error';
  error?: string;
}

/** スプレッドシートのログ行 */
interface LogEntry {
  timestamp: string;
  action: string;
  companyName: string;
  paymentMethod: string;
  groupName: string;
  driveFileId: string;
  freeeReceiptId: string;
  freeeExpenseId: string;
  status: string;
  error: string;
}
