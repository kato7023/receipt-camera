import Dexie, { type Table } from 'dexie';

/**
 * 一意なID（UUID v4相当）を生成する。
 * api.ts の generateUploadRequestId と同等だが、api.ts が db.ts を import しており
 * 循環参照になるため、こちら側にも独立して置く。
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

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

  // 金額。null = 未入力（自動アップロードでは仮1円で申請を作成し、
  // Phase 2のOCR金額補完でPUT修正する。freeeの経費申請作成には1以上が必須）
  amount: number | null;

  // アップロード状態
  uploadStatus: 'pending' | 'uploading' | 'completed' | 'error';
  uploadError: string | null;
  uploadedAt: Date | null;

  // 直近のアップロード試行のリクエストID（'uploading'中のみ設定。
  // 通信断でレスポンスが届かなかった場合に、後からGASへ結果を問い合わせるためのキー）
  uploadRequestId: string | null;
  // そのリクエスト内でこのレシートが何番目だったか（0始まり）。
  // 後から結果を問い合わせた際、GASが返すreceiptIndexとこのレシートを正しく対応付けるために使う
  uploadRequestIndex: number | null;

  // 撮影直後にバックグラウンドでバックアップ済みのDriveファイルID。
  // ローカルDBが失われても、Drive+スプレッドシート「撮影記録」から復旧できるようにするため、
  // アップロードボタンを押す前の時点で撮影直後に非同期でバックアップを試みる。
  // アップロード時、これが設定済みならGAS側でDriveへの再アップロードをスキップして再利用する。
  driveFileId: string | null;

  // 撮影時点で発番する、この領収書に固定の一意なID。
  // バックアップ送信ごとにGASへ渡し、GASはこのIDで撮影記録シートを照会して
  // 既にバックアップ済みなら新しいDriveファイルを作らず既存のものを返す（冪等化）。
  // iOSのバックグラウンド停止でdriveFileId保存が失われても、Driveが重複しないようにするため。
  backupId: string | null;

  // アップロード完了時に保存するfreee側のID（Phase 2のOCR取得・申請PUT編集に使用）
  freeeReceiptId: number | null;
  freeeExpenseId: number | null;

  // AI推測（OCR→過去照合→申請PUT編集）の進行状態（Phase 2で使用）
  // none=未対象 / pending=OCR結果待ち / done=反映済み / given_up=OCR取得を諦めた
  enrichState: 'none' | 'pending' | 'done' | 'given_up';

  memo: string;
}

/**
 * 自動アップロードの保留理由を返す（null = 自動アップロード対象）。
 * - noCompany: 会社未設定（設定されたら自動キューに入る）
 * - group: グループ設定あり（全部揃ってからグループ専用ボタンで手動申請）
 * ※金額未入力は保留しない（仮1円で申請し、Phase 2のOCR補完でPUT修正する方針）
 */
export function getAutoHoldReason(receipt: Receipt): 'noCompany' | 'group' | null {
  if (receipt.groupName) return 'group';
  if (!receipt.companyId) return 'noCompany';
  return null;
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
  amount: number | null = null
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
    amount: amount !== null && amount > 0 ? amount : null,
    uploadStatus: 'pending',
    uploadError: null,
    uploadedAt: null,
    uploadRequestId: null,
    uploadRequestIndex: null,
    driveFileId: null,
    backupId: generateId(),
    freeeReceiptId: null,
    freeeExpenseId: null,
    enrichState: 'none',
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
 * 領収書のアップロードステータスを更新する。
 * status を 'uploading' にする際は requestId・requestIndex（そのアップロード
 * リクエスト内での0始まりの順番）を渡して保存しておくことで、通信断でアプリを
 * 閉じてしまった場合にも次回起動時にGASへ結果を問い合わせられる。
 * 'completed'/'error' になったら requestId・requestIndex はクリアする。
 */
export async function updateUploadStatus(
  id: number,
  status: Receipt['uploadStatus'],
  error: string | null = null,
  requestId: string | null = null,
  requestIndex: number | null = null
): Promise<void> {
  await updateReceiptFields([id], {
    uploadStatus: status,
    uploadError: error,
    uploadedAt: status === 'completed' ? new Date() : null,
    uploadRequestId: status === 'uploading' ? requestId : null,
    uploadRequestIndex: status === 'uploading' ? requestIndex : null,
  });
}

/**
 * 撮影直後のバックグラウンドバックアップが成功した際に、DriveファイルIDを記録する
 */
export async function updateReceiptDriveFileId(
  id: number,
  driveFileId: string
): Promise<void> {
  await updateReceiptFields([id], { driveFileId });
}

/**
 * backupId 未設定の旧レコードに、あとから backupId を発番して保存する
 */
export async function updateReceiptBackupId(
  id: number,
  backupId: string
): Promise<void> {
  await updateReceiptFields([id], { backupId });
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
 * 領収書の金額を更新する（0以下・未入力はnull=未入力扱い）
 */
export async function updateReceiptAmount(
  id: number,
  amount: number | null
): Promise<void> {
  await updateReceiptFields([id], { amount: amount !== null && amount > 0 ? amount : null });
}

/**
 * アップロード完了時にfreee側のIDを保存する（Phase 2のOCR取得・申請PUT編集に使用）
 */
export async function updateReceiptFreeeIds(
  id: number,
  freeeReceiptId: number | null,
  freeeExpenseId: number | null
): Promise<void> {
  await updateReceiptFields([id], { freeeReceiptId, freeeExpenseId });
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
