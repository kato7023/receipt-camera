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

  // 金額（freeeの経費申請作成に必須。未入力の場合は1円で登録）
  amount: number;

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
  isMajor: boolean; // ボタンに表示するか（false = 「その他」ドロップダウン）
  shortName: string; // ボタン表示用の略称（未設定なら name を使う）
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
  companyName: string | null = null,
  groupName: string | null = null,
  amount: number = 1
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
    groupName,
    amount: amount > 0 ? amount : 1,
    uploadStatus: 'pending',
    uploadError: null,
    uploadedAt: null,
    memo: '',
  });
  return id as number;
}

/**
 * レコードのメタ情報を部分更新する内部ヘルパー。
 *
 * Safari の IndexedDB には、DBから読み出した Blob をそのまま同じレコードに
 * 書き戻すと「Error preparing Blob/File data to be stored in object store」で
 * 失敗する既知の不具合がある（1回目は成功し、2回目以降失敗し続けるのが典型症状）。
 * slice() による複製では内部参照が引き継がれて回避できなかったため、
 * arrayBuffer() でバイト列を実際に読み出し、完全に新しい Blob として
 * 再構築してから書き込む（IDBの内部Blobハンドルから完全に切り離す）。
 *
 * Blob の読み出し(arrayBuffer)はIDBトランザクションと無関係な非同期処理のため、
 * トランザクション内で await すると早期コミットのリスクがある。そのため
 * 読み出し・複製はトランザクションの外で完了させ、put() だけをトランザクション内で行う。
 */
async function updateReceiptFields(
  ids: number[],
  changes: Partial<Omit<Receipt, 'id' | 'image' | 'thumbnail'>>
): Promise<void> {
  const prepared: Receipt[] = [];
  for (const id of ids) {
    const rec = await db.receipts.get(id);
    if (!rec) continue;
    const [imageBuf, thumbBuf] = await Promise.all([
      rec.image.arrayBuffer(),
      rec.thumbnail.arrayBuffer(),
    ]);
    prepared.push({
      ...rec,
      ...changes,
      image: new Blob([imageBuf], { type: rec.image.type }),
      thumbnail: new Blob([thumbBuf], { type: rec.thumbnail.type }),
    });
  }

  await db.transaction('rw', db.receipts, async () => {
    for (const rec of prepared) {
      await db.receipts.put(rec);
    }
  });
}

/**
 * 領収書の会社を更新する
 */
export async function updateReceiptCompany(
  id: number,
  companyId: string,
  companyName: string
): Promise<void> {
  await updateReceiptFields([id], { companyId, companyName });
}

/**
 * 領収書の会社を一括更新する（複数選択時）
 */
export async function updateReceiptsCompany(
  ids: number[],
  companyId: string | null,
  companyName: string | null
): Promise<void> {
  await updateReceiptFields(ids, { companyId, companyName });
}

/**
 * 領収書のグループ名を更新する
 */
export async function updateReceiptGroup(
  ids: number[],
  groupName: string | null
): Promise<void> {
  await updateReceiptFields(ids, { groupName });
}

/**
 * 領収書のアップロードステータスを更新する
 */
export async function updateUploadStatus(
  id: number,
  status: Receipt['uploadStatus'],
  error: string | null = null
): Promise<void> {
  await updateReceiptFields([id], {
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
  await updateReceiptFields([id], { memo });
}

/**
 * 領収書の金額を更新する（0以下は1円に丸める。freeeの経費申請作成には1以上が必須）
 */
export async function updateReceiptAmount(
  id: number,
  amount: number
): Promise<void> {
  await updateReceiptFields([id], { amount: amount > 0 ? amount : 1 });
}

/**
 * 領収書の支払い方法を更新する
 */
export async function updateReceiptPaymentMethod(
  id: number,
  paymentMethodId: string,
  paymentMethodName: string
): Promise<void> {
  await updateReceiptFields([id], { paymentMethodId, paymentMethodName });
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
