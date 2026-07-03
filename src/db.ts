import Dexie, { type Table } from 'dexie';

/**
 * 領収書レコード
 */
export interface Receipt {
  id?: number;
  image: Blob;
  thumbnail: Blob;
  createdAt: Date;

  // 支払い方法（撮影時に設定）
  paymentMethodId: string;
  paymentMethodName: string;

  // 会社（撮影時 or 整理ステップで設定）
  companyId: string | null;
  companyName: string | null;

  // グループ化（整理ステップで設定）
  groupName: string | null;

  // アップロード状態
  uploadStatus: 'pending' | 'uploading' | 'completed' | 'error';
  uploadError: string | null;
  uploadedAt: Date | null;

  memo: string;
}

/**
 * 会社マスタ（GAS APIから取得、ローカルキャッシュ）
 */
export interface Company {
  id: string;
  name: string;
  freeeCompanyId: number;
}

/**
 * 支払い方法マスタ（GAS APIから取得、ローカルキャッシュ）
 */
export interface PaymentMethod {
  id: string;
  name: string;
  companyId: string | null; // null = 全社共通
  isMajor: boolean;         // ボタンに表示するか
}

class ReceiptDB extends Dexie {
  receipts!: Table<Receipt>;

  constructor() {
    super('ReceiptCameraProDB');
    this.version(1).stores({
      receipts: '++id, createdAt, uploadStatus, companyId, groupName',
    });
  }
}

export const db = new ReceiptDB();

/**
 * 画像Blobからサムネイルを生成する
 */
export async function createThumbnail(
  imageBlob: Blob,
  maxSize = 200
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(imageBlob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      const ratio = Math.min(maxSize / img.width, maxSize / img.height);
      canvas.width = img.width * ratio;
      canvas.height = img.height * ratio;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas context not available'));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Thumbnail generation failed'));
        },
        'image/jpeg',
        0.7
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image load failed'));
    };
    img.src = url;
  });
}

/**
 * 領収書を保存する
 */
export async function saveReceipt(
  imageBlob: Blob,
  paymentMethodId: string,
  paymentMethodName: string,
  companyId: string | null = null,
  companyName: string | null = null
): Promise<number> {
  const thumbnail = await createThumbnail(imageBlob);
  const id = await db.receipts.add({
    image: imageBlob,
    thumbnail,
    createdAt: new Date(),
    paymentMethodId,
    paymentMethodName,
    companyId,
    companyName,
    groupName: null,
    uploadStatus: 'pending',
    uploadError: null,
    uploadedAt: null,
    memo: '',
  });
  return id as number;
}

/**
 * 領収書の会社を更新する
 */
export async function updateReceiptCompany(
  id: number,
  companyId: string,
  companyName: string
): Promise<void> {
  await db.receipts.update(id, { companyId, companyName });
}

/**
 * 領収書のグループ名を更新する
 */
export async function updateReceiptGroup(
  ids: number[],
  groupName: string | null
): Promise<void> {
  await db.receipts.where('id').anyOf(ids).modify({ groupName });
}

/**
 * 領収書のアップロードステータスを更新する
 */
export async function updateUploadStatus(
  id: number,
  status: Receipt['uploadStatus'],
  error: string | null = null
): Promise<void> {
  await db.receipts.update(id, {
    uploadStatus: status,
    uploadError: error,
    uploadedAt: status === 'completed' ? new Date() : null,
  });
}

/**
 * 領収書のメモを更新する
 */
export async function updateReceiptMemo(
  id: number,
  memo: string
): Promise<void> {
  await db.receipts.update(id, { memo });
}

/**
 * 領収書を削除する
 */
export async function deleteReceipt(id: number): Promise<void> {
  await db.receipts.delete(id);
}

/**
 * 領収書を一括削除する
 */
export async function deleteReceipts(ids: number[]): Promise<void> {
  await db.receipts.bulkDelete(ids);
}

/**
 * 未アップロードのグループ名一覧を取得する（サジェスト用）
 */
export async function getExistingGroupNames(): Promise<string[]> {
  const receipts = await db.receipts
    .where('uploadStatus')
    .equals('pending')
    .toArray();
  const names = new Set<string>();
  for (const r of receipts) {
    if (r.groupName) names.add(r.groupName);
  }
  return Array.from(names).sort();
}
