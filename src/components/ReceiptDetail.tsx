import { useState, useEffect, useCallback, useRef } from 'react';
import {
  type Receipt,
  type Company,
  type PaymentMethod,
  db,
  updateReceiptMemo,
  updateUploadStatus,
  updateReceiptDriveFileId,
  updateReceiptFreeeIds,
  deleteReceipt,
  updateReceiptsCompany,
  updateReceiptGroup,
  updateReceiptPaymentMethod,
  updateReceiptAmount,
  updateReceiptExpenseDate
} from '../db';
import { getCachedCompanies, getCachedPaymentMethods, uploadReceipts, generateUploadRequestId, updateExpenseDraftAmount, updateExpenseDraftDate } from '../api';
import CompanyAssigner from './CompanyAssigner';

interface ReceiptDetailProps {
  receipt: Receipt;
  onClose: () => void;
  onUpdate: () => void;
}

export default function ReceiptDetail({ receipt, onClose, onUpdate }: ReceiptDetailProps) {
  const [currentReceipt, setCurrentReceipt] = useState<Receipt | null>(null);
  const [imageUrl, setImageUrl] = useState<string>('');
  const [showImageViewer, setShowImageViewer] = useState(false);
  const [imageZoom, setImageZoom] = useState(1);
  const [imagePan, setImagePan] = useState({ x: 0, y: 0 });
  const [memo, setMemo] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // マスタデータ
  const [companies, setCompanies] = useState<Company[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);

  // 編集用の状態
  const [showCompanySelector, setShowCompanySelector] = useState(false);
  const [showPaymentSelector, setShowPaymentSelector] = useState(false);
  const [isEditingGroup, setIsEditingGroup] = useState(false);
  const [groupInput, setGroupInput] = useState('');
  const [isEditingAmount, setIsEditingAmount] = useState(false);
  const [isSavingAmount, setIsSavingAmount] = useState(false);
  const [isEditingDate, setIsEditingDate] = useState(false);
  const [isSavingDate, setIsSavingDate] = useState(false);
  const [dateInput, setDateInput] = useState('');
  const [amountInput, setAmountInput] = useState('');

  const groupInputRef = useRef<HTMLInputElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);
  const viewerPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchDistanceRef = useRef<number | null>(null);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const resetImageView = useCallback(() => {
    setImageZoom(1);
    setImagePan({ x: 0, y: 0 });
  }, []);

  const closeImageViewer = useCallback(() => {
    setShowImageViewer(false);
    resetImageView();
  }, [resetImageView]);

  const changeImageZoom = useCallback((delta: number) => {
    setImageZoom((current) => Math.min(4, Math.max(1, Number((current + delta).toFixed(2)))));
    if (imageZoom + delta <= 1) setImagePan({ x: 0, y: 0 });
  }, [imageZoom]);

  const handleViewerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    viewerPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (viewerPointersRef.current.size === 2) {
      const points = Array.from(viewerPointersRef.current.values());
      pinchDistanceRef.current = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      panStartRef.current = null;
    } else if (imageZoom > 1) {
      panStartRef.current = { x: event.clientX, y: event.clientY, panX: imagePan.x, panY: imagePan.y };
    }
  };

  const handleViewerPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!viewerPointersRef.current.has(event.pointerId)) return;
    viewerPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = Array.from(viewerPointersRef.current.values());
    if (points.length === 2 && pinchDistanceRef.current) {
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      setImageZoom((current) => Math.min(4, Math.max(1, current * (distance / pinchDistanceRef.current!))));
      pinchDistanceRef.current = distance;
    } else if (panStartRef.current && imageZoom > 1) {
      setImagePan({
        x: panStartRef.current.panX + event.clientX - panStartRef.current.x,
        y: panStartRef.current.panY + event.clientY - panStartRef.current.y,
      });
    }
  };

  const handleViewerPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    viewerPointersRef.current.delete(event.pointerId);
    if (viewerPointersRef.current.size < 2) pinchDistanceRef.current = null;
    if (viewerPointersRef.current.size === 0) panStartRef.current = null;
  };

  const handleViewerWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    changeImageZoom(event.deltaY < 0 ? 0.25 : -0.25);
  };

  // 画像URLは開いた時点の receipt.image から一度だけ生成する
  // （メタ情報の編集のたびに IndexedDB から Blob を読み直すと、iOS Safari で
  //   Blob が破損して読めなくなる既知の不具合があるため、DB再取得はしない）
  useEffect(() => {
    const url = URL.createObjectURL(receipt.image);
    setImageUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [receipt.image]);

  // メタ情報（会社・支払い方法・グループ・メモ等）の読み込み
  const loadReceiptData = useCallback(async () => {
    if (!receipt.id) return;
    const data = await db.receipts.get(receipt.id);
    if (data) {
      setCurrentReceipt(data);
      setMemo(data.memo || '');
      setGroupInput(data.groupName || '');
      setAmountInput(data.amount !== null ? String(data.amount) : '');
      setDateInput(data.expenseDate || new Date(data.createdAt).toISOString().slice(0, 10));
    }
  }, [receipt.id]);

  useEffect(() => {
    loadReceiptData();
  }, [loadReceiptData]);

  useEffect(() => {
    getCachedCompanies().then(setCompanies);
    getCachedPaymentMethods().then(setPaymentMethods);
  }, []);

  useEffect(() => {
    if (isEditingGroup && groupInputRef.current) {
      groupInputRef.current.focus();
    }
  }, [isEditingGroup]);

  useEffect(() => {
    if (isEditingAmount && amountInputRef.current) {
      amountInputRef.current.focus();
      amountInputRef.current.select();
    }
  }, [isEditingAmount]);

  // メモ保存
  const handleMemoSave = useCallback(async () => {
    if (!receipt.id) return;
    await updateReceiptMemo(receipt.id, memo);
    await loadReceiptData();
    onUpdate();
  }, [receipt.id, memo, loadReceiptData, onUpdate]);

  // 会社選択
  const handleCompanySelect = useCallback(async (company: Company | null) => {
    if (!receipt.id) return;
    await updateReceiptsCompany([receipt.id], company?.id ?? null, company?.name ?? null);
    setShowCompanySelector(false);
    await loadReceiptData();
    onUpdate();
  }, [receipt.id, loadReceiptData, onUpdate]);

  // 支払い方法選択
  const handlePaymentSelect = useCallback(async (method: PaymentMethod) => {
    if (!receipt.id) return;
    await updateReceiptPaymentMethod(receipt.id, method.id, method.name);
    setShowPaymentSelector(false);
    await loadReceiptData();
    onUpdate();
  }, [receipt.id, loadReceiptData, onUpdate]);

  // グループ名保存
  const handleGroupSave = useCallback(async () => {
    if (!receipt.id) return;
    const trimmed = groupInput.trim();
    await updateReceiptGroup([receipt.id], trimmed ? trimmed : null);
    setIsEditingGroup(false);
    await loadReceiptData();
    onUpdate();
  }, [receipt.id, groupInput, loadReceiptData, onUpdate]);

  // グループ名編集キャンセル
  const handleGroupCancel = useCallback(() => {
    setGroupInput(currentReceipt?.groupName || '');
    setIsEditingGroup(false);
  }, [currentReceipt?.groupName]);

  // 金額保存
  const handleAmountSave = useCallback(async () => {
    if (!receipt.id) return;
    const parsed = parseInt(amountInput, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      alert('金額は1円以上で入力してください。');
      return;
    }

    setIsSavingAmount(true);
    try {
      const target = currentReceipt;
      if (target?.uploadStatus === 'completed' && target.companyId && target.freeeExpenseId) {
        await updateExpenseDraftAmount(target.companyId, target.freeeExpenseId, parsed);
      }
      await updateReceiptAmount(receipt.id, parsed);
      setIsEditingAmount(false);
      await loadReceiptData();
      onUpdate();
    } catch (err) {
      alert(`金額の保存に失敗しました。\n\n${(err as Error).message}`);
    } finally {
      setIsSavingAmount(false);
    }
  }, [receipt.id, amountInput, currentReceipt, loadReceiptData, onUpdate]);

  // 日付保存。アップロード済みの下書きはfreee側を先に更新し、成功後にローカルへ保存する。
  const handleDateSave = useCallback(async () => {
    if (!receipt.id || !/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      alert('日付をYYYY-MM-DD形式で入力してください。');
      return;
    }
    setIsSavingDate(true);
    try {
      const target = currentReceipt;
      if (target?.uploadStatus === 'completed' && target.companyId && target.freeeExpenseId && target.freeeReceiptId) {
        await updateExpenseDraftDate(target.companyId, target.freeeExpenseId, target.freeeReceiptId, dateInput);
      }
      await updateReceiptExpenseDate(receipt.id, dateInput);
      setIsEditingDate(false);
      await loadReceiptData();
      onUpdate();
    } catch (err) {
      alert(`日付の保存に失敗しました。\n\n${(err as Error).message}`);
    } finally {
      setIsSavingDate(false);
    }
  }, [receipt.id, dateInput, currentReceipt, loadReceiptData, onUpdate]);

  // 金額編集キャンセル
  const handleAmountCancel = useCallback(() => {
    setAmountInput(currentReceipt?.amount != null ? String(currentReceipt.amount) : '');
    setIsEditingAmount(false);
  }, [currentReceipt?.amount]);

  const handleRetry = useCallback(async () => {
    if (!receipt.id || !currentReceipt) return;
    setIsRetrying(true);
    const requestId = generateUploadRequestId();
    try {
      await updateUploadStatus(receipt.id, 'uploading', null, requestId, 0);
      await loadReceiptData();

      // ステータス更新でレコード（画像Blob含む）はDB上で作り直されている。
      // Safariでは古いBlobハンドルの読み取りが失敗することがあるため、
      // 必ずDBから取り直した新鮮なオブジェクトの画像を使う。
      const fresh = (await db.receipts.get(receipt.id)) ?? currentReceipt;

      const results = await uploadReceipts([{
        image: fresh.image,
        companyId: fresh.companyId!,
        paymentMethodId: fresh.paymentMethodId,
        paymentMethodName: fresh.paymentMethodName,
        groupName: fresh.groupName,
        amount: fresh.amount,
        memo: fresh.memo,
        capturedAt: fresh.createdAt,
        expenseDate: fresh.expenseDate,
        driveFileId: fresh.driveFileId,
        backupId: fresh.backupId,
      }], requestId);

      const result = results[0];
      // Drive保存済みのファイルIDは成否によらず保存し、リトライ時の再作成・再送信を防ぐ
      if (result?.driveFileId && !fresh.driveFileId) {
        await updateReceiptDriveFileId(receipt.id, result.driveFileId);
      }
      if (result?.status === 'completed') {
        await updateReceiptFreeeIds(receipt.id, result.freeeReceiptId ?? null, result.freeeExpenseId ?? null);
        await updateUploadStatus(receipt.id, 'completed');
      } else {
        await updateUploadStatus(receipt.id, 'error', result?.error || 'アップロードに失敗しました');
      }
    } catch (err) {
      await updateUploadStatus(receipt.id, 'error', (err as Error).message);
    } finally {
      setIsRetrying(false);
      await loadReceiptData();
      onUpdate();
    }
  }, [receipt.id, currentReceipt, loadReceiptData, onUpdate]);

  const handleDelete = useCallback(async () => {
    if (!receipt.id) return;
    setIsDeleting(true);
    try {
      await deleteReceipt(receipt.id);
      onUpdate();
      onClose();
    } catch (err) {
      console.error('削除に失敗:', err);
      setIsDeleting(false);
    }
  }, [receipt.id, onUpdate, onClose]);

  const formatDate = (date: Date) => {
    const d = new Date(date);
    return `${d.getFullYear()}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'pending': return '未UP';
      case 'uploading': return 'アップロード中...';
      case 'completed': return currentReceipt?.amount === null ? '未入力' : '完了';
      case 'error': return 'エラー';
      default: return status;
    }
  };

  if (!currentReceipt) {
    return (
      <div className="receipt-detail-overlay" onClick={onClose}>
        <div className="receipt-detail loading" onClick={(e) => e.stopPropagation()}>
          <div className="shutter-spinner"></div>
        </div>
      </div>
    );
  }

  // 選択している会社のオブジェクトを取得
  const currentCompany = companies.find(c => c.id === currentReceipt.companyId) || null;

  return (
    <div className="receipt-detail-overlay" onClick={onClose}>
      <div className="receipt-detail" onClick={(e) => e.stopPropagation()}>
        {/* ヘッダー */}
        <div className="detail-header">
          <button className="detail-back-button" onClick={onClose} aria-label="戻る">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div className="detail-header-info">
            <span className="detail-date">{formatDate(currentReceipt.createdAt)}</span>
            <span className={`status-badge ${currentReceipt.uploadStatus}`}>
              {getStatusLabel(currentReceipt.uploadStatus)}
            </span>
          </div>
        </div>

        {/* メタ情報 */}
        <div className="detail-meta">
          {/* 支払い方法 */}
          <div className="detail-meta-item editable" onClick={() => setShowPaymentSelector(true)}>
            <span className="detail-meta-label">支払い方法</span>
            <div className="detail-meta-value-container">
              <span className="detail-meta-value">{currentReceipt.paymentMethodName}</span>
              <svg className="edit-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
            </div>
          </div>

          {/* 会社 */}
          <div className="detail-meta-item editable" onClick={() => setShowCompanySelector(true)}>
            <span className="detail-meta-label">会社</span>
            <div className="detail-meta-value-container">
              {currentReceipt.companyName ? (
                <span className="detail-meta-value">{currentReceipt.companyName}</span>
              ) : (
                <span className="detail-meta-value unassigned">会社未設定</span>
              )}
              <svg className="edit-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
            </div>
          </div>

          {/* グループ */}
          <div className="detail-meta-item editable" onClick={() => !isEditingGroup && setIsEditingGroup(true)}>
            <span className="detail-meta-label">グループ</span>
            {isEditingGroup ? (
              <div className="detail-meta-input-container" onClick={(e) => e.stopPropagation()}>
                <input
                  ref={groupInputRef}
                  type="text"
                  className="detail-group-input"
                  value={groupInput}
                  onChange={(e) => setGroupInput(e.target.value)}
                  placeholder="グループ名を入力..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleGroupSave();
                    if (e.key === 'Escape') handleGroupCancel();
                  }}
                />
                <button className="group-save-btn" onClick={handleGroupSave}>✓</button>
                <button className="group-cancel-btn" onClick={handleGroupCancel}>×</button>
              </div>
            ) : (
              <div className="detail-meta-value-container">
                {currentReceipt.groupName ? (
                  <span className="detail-meta-value group-tag">{currentReceipt.groupName}</span>
                ) : (
                  <span className="detail-meta-value unassigned">グループ未設定</span>
                )}
                <svg className="edit-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
              </div>
            )}
          </div>

          {/* 経費精算日 */}
          <div className="detail-meta-item editable" onClick={() => !isEditingDate && setIsEditingDate(true)}>
            <span className="detail-meta-label">経費精算日</span>
            {isEditingDate ? (
              <div className="detail-meta-input-container" onClick={(e) => e.stopPropagation()}>
                <input
                  type="date"
                  className="detail-group-input"
                  value={dateInput}
                  onChange={(e) => setDateInput(e.target.value)}
                />
                <button className="group-save-btn" onClick={handleDateSave} disabled={isSavingDate}>{isSavingDate ? '…' : '✓'}</button>
                <button className="group-cancel-btn" onClick={() => { setDateInput(currentReceipt.expenseDate || new Date(currentReceipt.createdAt).toISOString().slice(0, 10)); setIsEditingDate(false); }}>×</button>
              </div>
            ) : (
              <div className="detail-meta-value-container">
                <span className="detail-meta-value">{dateInput}</span>
                <svg className="edit-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
              </div>
            )}
          </div>

          {/* 金額 */}
          <div className="detail-meta-item editable" onClick={() => !isEditingAmount && setIsEditingAmount(true)}>
            <span className="detail-meta-label">金額</span>
            {isEditingAmount ? (
              <div className="detail-meta-input-container" onClick={(e) => e.stopPropagation()}>
                <input
                  ref={amountInputRef}
                  type="number"
                  inputMode="numeric"
                  className="detail-group-input"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  placeholder="金額を入力..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAmountSave();
                    if (e.key === 'Escape') handleAmountCancel();
                  }}
                />
                <button className="group-save-btn" onClick={handleAmountSave} disabled={isSavingAmount}>{isSavingAmount ? '…' : '✓'}</button>
                <button className="group-cancel-btn" onClick={handleAmountCancel}>×</button>
              </div>
            ) : (
              <div className="detail-meta-value-container">
                <span className="detail-meta-value">
                  {currentReceipt.amount !== null ? `¥${currentReceipt.amount.toLocaleString()}` : '金額未入力'}
                </span>
                <svg className="edit-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
              </div>
            )}
          </div>
        </div>

        {/* 画像 */}
        <div className="detail-image-container">
          {imageUrl && (
            <button className="detail-image-button" onClick={() => setShowImageViewer(true)} aria-label="領収書画像を拡大">
              <img src={imageUrl} alt="領収書（タップで拡大）" className="detail-image" />
              <span className="detail-image-hint">タップして拡大</span>
            </button>
          )}
        </div>

        {/* メモ */}
        <div className="detail-memo">
          <label className="memo-label" htmlFor="receipt-memo">メモ</label>
          <div className="memo-input-group">
            <input
              id="receipt-memo"
              type="text"
              className="memo-input"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              onBlur={handleMemoSave}
              placeholder="メモを入力..."
            />
          </div>
        </div>

        {/* エラー表示 */}
        {currentReceipt.uploadStatus === 'error' && currentReceipt.uploadError && (
          <div className="detail-error">
            <span className="detail-error-text">エラー: {currentReceipt.uploadError}</span>
            <button className="action-button retry-button" onClick={handleRetry} disabled={isRetrying}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              {isRetrying ? 'リトライ中...' : 'リトライ'}
            </button>
          </div>
        )}

        {/* アクションボタン */}
        <div className="detail-actions">
          {showDeleteConfirm ? (
            <div className="delete-confirm">
              <span>本当に削除しますか？</span>
              <button className="action-button delete-yes" onClick={handleDelete} disabled={isDeleting}>
                {isDeleting ? '削除中...' : '削除する'}
              </button>
              <button className="action-button delete-no" onClick={() => setShowDeleteConfirm(false)}>
                キャンセル
              </button>
            </div>
          ) : (
            <button className="action-button delete-button" onClick={() => setShowDeleteConfirm(true)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              削除
            </button>
          )}
        </div>
      </div>

      {/* 会社選択モーダル */}
      {showCompanySelector && (
        <CompanyAssigner
          companies={companies}
          selected={currentCompany}
          onSelect={handleCompanySelect}
          onClose={() => setShowCompanySelector(false)}
        />
      )}

      {/* 支払い方法選択モーダル */}
      {showPaymentSelector && (
        <div className="modal-overlay" onClick={() => setShowPaymentSelector(false)}>
          <div className="modal-sheet compact" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>支払い方法を選択</h3>
              <button className="modal-close" onClick={() => setShowPaymentSelector(false)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="company-list">
              {paymentMethods.map((m) => (
                <button
                  key={m.id}
                  className={`company-card ${currentReceipt.paymentMethodId === m.id ? 'active' : ''}`}
                  onClick={() => handlePaymentSelect(m)}
                >
                  <span>{m.name}</span>
                  {currentReceipt.paymentMethodId === m.id && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="check-icon">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 画像ズームビューア */}
      {showImageViewer && imageUrl && (
        <div className="image-viewer-overlay" onClick={closeImageViewer}>
          <div
            className="image-viewer-stage"
            onClick={(e) => e.stopPropagation()}
            onWheel={handleViewerWheel}
            onPointerDown={handleViewerPointerDown}
            onPointerMove={handleViewerPointerMove}
            onPointerUp={handleViewerPointerUp}
            onPointerCancel={handleViewerPointerUp}
          >
            <img
              src={imageUrl}
              alt="領収書（拡大表示）"
              className="image-viewer-image"
              style={{ transform: `translate(${imagePan.x}px, ${imagePan.y}px) scale(${imageZoom})` }}
            />
            <button className="image-viewer-close" onClick={closeImageViewer} aria-label="画像ビューアを閉じる">×</button>
            <div className="image-viewer-controls" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => changeImageZoom(-0.25)} disabled={imageZoom <= 1} aria-label="縮小">−</button>
              <span>{Math.round(imageZoom * 100)}%</span>
              <button onClick={() => changeImageZoom(0.25)} disabled={imageZoom >= 4} aria-label="拡大">＋</button>
              <button className="image-viewer-reset" onClick={resetImageView}>リセット</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
