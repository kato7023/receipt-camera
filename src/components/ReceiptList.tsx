import { useState, useEffect, useCallback } from 'react';
import { db, updateReceiptGroup, updateReceiptsCompany, updateUploadStatus, updateReceiptDriveFileId, updateReceiptFreeeIds, deleteReceipts } from '../db';
import type { Receipt, Company } from '../db';
import { getCachedCompanies, uploadReceipts, generateUploadRequestId, scheduleAutoUpload } from '../api';
import CompanyAssigner from './CompanyAssigner';
import GroupManager from './GroupManager';

interface ReceiptListProps {
  onSelect: (receipt: Receipt) => void;
  refreshKey: number;
}

type FilterType = 'unuploaded' | 'unconfirmed' | 'completed' | 'error' | 'all';

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s　]/g, '');
}

function getReceiptCategory(receipt: Receipt): Exclude<FilterType, 'all'> {
  if (receipt.uploadStatus === 'error') return 'error';
  if (!receipt.companyId || receipt.uploadStatus !== 'completed') return 'unuploaded';
  if (receipt.amount === null) return 'unconfirmed';
  return 'completed';
}

export default function ReceiptList({ onSelect, refreshKey }: ReceiptListProps) {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [allReceipts, setAllReceipts] = useState<Receipt[]>([]);
  const [filter, setFilter] = useState<FilterType>('unuploaded');
  const [searchText, setSearchText] = useState('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [companyFilter, setCompanyFilter] = useState<string[]>([]);
  const [paymentFilter, setPaymentFilter] = useState<string[]>([]);
  const [groupFilter, setGroupFilter] = useState<string[]>([]);
  const [includeUngrouped, setIncludeUngrouped] = useState(false);
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [thumbnailUrls, setThumbnailUrls] = useState<Map<number, string>>(new Map());
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isUploading, setIsUploading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [showCompanyAssigner, setShowCompanyAssigner] = useState(false);
  const [showGroupManager, setShowGroupManager] = useState(false);

  useEffect(() => {
    getCachedCompanies().then(setCompanies);
  }, []);

  const loadReceipts = useCallback(async () => {
    const all = await db.receipts.orderBy('createdAt').reverse().toArray();
    setAllReceipts(all);

    let filtered: Receipt[];
    switch (filter) {
      case 'unuploaded':
        filtered = all.filter((r) => getReceiptCategory(r) === 'unuploaded');
        break;
      case 'unconfirmed':
        filtered = all.filter((r) => getReceiptCategory(r) === 'unconfirmed');
        break;
      case 'completed':
        filtered = all.filter((r) => r.uploadStatus === 'completed');
        break;
      case 'error':
        filtered = all.filter((r) => r.uploadStatus === 'error');
        break;
      default:
        filtered = all;
    }

    const search = normalizeSearch(searchText);
    if (search) {
      filtered = filtered.filter((r) => {
        const searchable = normalizeSearch([
          r.companyName || '',
          r.paymentMethodName || '',
          r.groupName || '',
          r.memo || '',
          r.amount !== null ? String(r.amount) : '',
          r.ocrPartnerName || '',
          r.ocrRegistrationNumber || '',
          r.ocrAmount !== null && r.ocrAmount !== undefined ? String(r.ocrAmount) : '',
          r.ocrIssueDate || '',
          r.expenseDate || '',
          formatDate(r.createdAt),
        ].join(' '));
        return searchable.includes(search);
      });
    }
    if (companyFilter.length) filtered = filtered.filter((r) => r.companyId !== null && companyFilter.includes(r.companyId));
    if (paymentFilter.length) filtered = filtered.filter((r) => paymentFilter.includes(r.paymentMethodName));
    if (groupFilter.length || includeUngrouped) {
      filtered = filtered.filter((r) => (r.groupName ? groupFilter.includes(r.groupName) : includeUngrouped));
    }
    const min = amountMin === '' ? null : Number(amountMin);
    const max = amountMax === '' ? null : Number(amountMax);
    if (min !== null && Number.isFinite(min)) filtered = filtered.filter((r) => r.amount !== null && r.amount >= min);
    if (max !== null && Number.isFinite(max)) filtered = filtered.filter((r) => r.amount !== null && r.amount <= max);
    setReceipts(filtered);

    setThumbnailUrls((prev) => {
      const nextUrls = new Map<number, string>();
      const prevCopy = new Map(prev);

      for (const receipt of filtered) {
        if (receipt.id !== undefined) {
          if (prevCopy.has(receipt.id)) {
            // 既存のオブジェクトURLを再利用
            nextUrls.set(receipt.id, prevCopy.get(receipt.id)!);
            prevCopy.delete(receipt.id); // 削除対象から除外
          } else {
            // 新規作成
            nextUrls.set(receipt.id, URL.createObjectURL(receipt.thumbnail));
          }
        }
      }

      // 不要になったURLのみ解放
      prevCopy.forEach((url) => URL.revokeObjectURL(url));
      return nextUrls;
    });
  }, [filter, searchText, companyFilter, paymentFilter, groupFilter, includeUngrouped, amountMin, amountMax]);

  useEffect(() => { loadReceipts(); }, [loadReceipts, refreshKey]);
  useEffect(() => {
    setSelectedIds(new Set());
    setShowDeleteConfirm(false);
  }, [filter, searchText, companyFilter, paymentFilter, groupFilter, includeUngrouped, amountMin, amountMax]);
  useEffect(() => {
    return () => { thumbnailUrls.forEach((url) => URL.revokeObjectURL(url)); };
  }, []);

  const toggleSelectMode = () => {
    if (selectMode) { setSelectedIds(new Set()); setShowDeleteConfirm(false); }
    setSelectMode(!selectMode);
  };

  const toggleSelection = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setShowDeleteConfirm(false);
  };

  const selectAll = () => {
    setSelectedIds(new Set(receipts.filter(r => r.id !== undefined).map(r => r.id as number)));
  };

  // 会社割当（選択中のレシートに会社を設定）
  const handleCompanyAssign = useCallback(async (company: Company | null) => {
    try {
      const ids = Array.from(selectedIds);
      await updateReceiptsCompany(ids, company?.id ?? null, company?.name ?? null);
    } catch (err) {
      console.error('会社割り当てに失敗しました:', err);
      const name = err instanceof DOMException ? err.name : (err as Error)?.name || 'UnknownError';
      const message = (err as Error)?.message || String(err);
      let storageInfo = '';
      try {
        if (navigator.storage?.estimate) {
          const { usage, quota } = await navigator.storage.estimate();
          const usageMB = ((usage || 0) / 1024 / 1024).toFixed(1);
          const quotaMB = ((quota || 0) / 1024 / 1024).toFixed(1);
          storageInfo = `\n\n使用容量: ${usageMB}MB / ${quotaMB}MB`;
        }
      } catch {
        // ストレージ情報取得に失敗しても無視
      }
      alert(`会社の割り当てに失敗しました。(v${__APP_VERSION__})\n\n[${name}] ${message}${storageInfo}`);
    } finally {
      setShowCompanyAssigner(false);
      setSelectedIds(new Set());
      setSelectMode(false);
      loadReceipts();
      // 会社が設定されたことで保留解除された可能性があるため、自動アップロードを予約
      scheduleAutoUpload(loadReceipts, 5000);
    }
  }, [selectedIds, loadReceipts]);

  // グループ化
  const handleGroupApply = useCallback(async (groupName: string) => {
    await updateReceiptGroup(Array.from(selectedIds), groupName);
    setShowGroupManager(false);
    setSelectedIds(new Set());
    setSelectMode(false);
    loadReceipts();
  }, [selectedIds, loadReceipts]);

  // 指定したレシートを実際にfreeeへアップロードする（新規アップロード・リトライ共通）
  const performUpload = useCallback(async (targetReceipts: Receipt[]) => {
    if (targetReceipts.length === 0) return;

    setIsUploading(true);
    const requestId = generateUploadRequestId();
    try {
      // ステータスをuploadingに更新（requestId・順番も保存し、通信断で
      // 応答が届かなかった場合に後からGASへ結果を問い合わせられるようにする）
      for (let i = 0; i < targetReceipts.length; i++) {
        await updateUploadStatus(targetReceipts[i].id!, 'uploading', null, requestId, i);
      }
      loadReceipts();

      // 上記のステータス更新でレコード（画像Blob含む）はDB上で作り直されている。
      // Safariでは書き換え前の古いBlobハンドルの読み取りが失敗することがあるため
      // （「Blobの読み取りに失敗しました」の原因）、必ずDBから取り直した新鮮な
      // オブジェクトの画像を使ってアップロードする。
      const freshReceipts = await db.receipts.bulkGet(targetReceipts.map(r => r.id!));

      const items = freshReceipts.map((fresh, i) => {
        const r = fresh ?? targetReceipts[i];
        return {
          image: r.image,
          companyId: r.companyId!,
          paymentMethodId: r.paymentMethodId,
          paymentMethodName: r.paymentMethodName,
          groupName: r.groupName,
          amount: r.amount,
          expenseDate: r.expenseDate,
          memo: r.memo,
          capturedAt: r.createdAt,
          driveFileId: r.driveFileId,
          backupId: r.backupId,
        };
      });

      const results = await uploadReceipts(items, requestId);

      // 結果を反映
      for (const result of results) {
        const receipt = targetReceipts[result.receiptIndex];
        if (receipt?.id) {
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
      }
    } catch (err) {
      console.error('アップロードエラー:', err);
      for (const r of targetReceipts) {
        if (r.id) await updateUploadStatus(r.id, 'error', (err as Error).message);
      }
      // エラー→エラーの場合など画面上の変化がないと「無反応」に見えるため、必ず通知する
      alert(`アップロードに失敗しました。\n\n${(err as Error).message}`);
    } finally {
      setIsUploading(false);
      loadReceipts();
    }
  }, [loadReceipts]);

  // アップロード（未アップロード・エラーどちらも対象にする。
  // エラータブで選択してのリトライもこの共通処理で行えるようにする）
  const handleUpload = useCallback(async () => {
    // 会社未設定のレシートがあるか確認
    const targetReceipts = receipts.filter(
      r => r.id !== undefined && (selectedIds.size === 0 || selectedIds.has(r.id!)) &&
        (r.uploadStatus === 'pending' || r.uploadStatus === 'error')
    );
    const noCompany = targetReceipts.filter(r => !r.companyId);
    if (noCompany.length > 0) {
      alert(`会社未設定のレシートが ${noCompany.length} 枚あります。先に会社を設定してください。`);
      return;
    }
    if (targetReceipts.length === 0) { alert('アップロード対象のレシートがありません。'); return; }

    await performUpload(targetReceipts);
    setSelectedIds(new Set());
    setSelectMode(false);
  }, [receipts, selectedIds, performUpload]);

  // リトライ（エラーのレシートを実際に再アップロードする）
  const handleRetry = useCallback(async () => {
    const errorReceipts = receipts.filter(r => r.id !== undefined && r.uploadStatus === 'error');
    await performUpload(errorReceipts);
  }, [receipts, performUpload]);

  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    await deleteReceipts(Array.from(selectedIds));
    setSelectedIds(new Set());
    setSelectMode(false);
    setShowDeleteConfirm(false);
    loadReceipts();
  }, [selectedIds, loadReceipts]);

  const formatDate = (date: Date) => {
    const d = new Date(date);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    return `${month}/${day} ${hours}:${minutes}`;
  };

  const unuploadedCount = allReceipts.filter(r => getReceiptCategory(r) === 'unuploaded').length;
  const unconfirmedCount = allReceipts.filter(r => getReceiptCategory(r) === 'unconfirmed').length;
  const completedCount = allReceipts.filter(r => getReceiptCategory(r) === 'completed').length;
  const errorCount = allReceipts.filter(r => r.uploadStatus === 'error').length;
  // グループ設定ありの未アップロード（自動アップロード対象外＝手動申請の対象）
  const groupedPendingReceipts = allReceipts.filter(r => r.uploadStatus === 'pending' && r.groupName);

  // グループ専用の手動申請（単票は自動アップロードされるため、手動はグループのみ）
  const handleGroupUpload = useCallback(async () => {
    const noCompany = groupedPendingReceipts.filter(r => !r.companyId);
    if (noCompany.length > 0) {
      alert(`会社未設定のレシートが ${noCompany.length} 枚あります。先に会社を設定してください。`);
      return;
    }
    if (groupedPendingReceipts.length === 0) return;
    await performUpload(groupedPendingReceipts);
  }, [groupedPendingReceipts, performUpload]);

  const getStatusBadgeClass = (receipt: Receipt) => {
    switch (getReceiptCategory(receipt)) {
      case 'unuploaded': return receipt.uploadStatus === 'uploading' ? 'status-badge uploading' : 'status-badge pending';
      case 'unconfirmed': return 'status-badge pending';
      case 'completed': return 'status-badge completed';
      case 'error': return 'status-badge error';
      default: return 'status-badge';
    }
  };

  const getStatusLabel = (receipt: Receipt) => {
    switch (getReceiptCategory(receipt)) {
      case 'unuploaded': return receipt.uploadStatus === 'uploading' ? 'アップロード中' : '未UP';
      case 'unconfirmed': return '未入力';
      case 'completed': return '完了';
      case 'error': return 'エラー';
      default: return '';
    }
  };

  const paymentNames = Array.from(new Set(allReceipts.map((r) => r.paymentMethodName).filter(Boolean))).sort();
  const hasAdvancedFilter = companyFilter.length > 0 || paymentFilter.length > 0 || groupFilter.length > 0 || includeUngrouped || amountMin !== '' || amountMax !== '';
  const clearAdvancedFilters = () => {
    setCompanyFilter([]);
    setPaymentFilter([]);
    setGroupFilter([]);
    setIncludeUngrouped(false);
    setAmountMin('');
    setAmountMax('');
  };

  return (
    <div className="receipt-list">
      {/* ヘッダー */}
      <div className="list-header">
        <button className={`select-mode-button ${selectMode ? 'active' : ''}`} onClick={toggleSelectMode}>
          {selectMode ? '完了' : '選択'}
        </button>
        {selectMode && <button className="select-all-button" onClick={selectAll}>全選択</button>}
        {filter === 'error' && errorCount > 0 && !selectMode && (
          <button className="retry-all-button" onClick={handleRetry} disabled={isUploading}>
            {isUploading ? 'リトライ中...' : '全てリトライ'}
          </button>
        )}
      </div>

      {/* アップロード中表示（通信断でポーリング中の場合も含め、処理が確定するまで表示） */}
      {isUploading && (
        <div className="uploading-banner">
          <div className="shutter-spinner small" />
          <span>アップロード中...</span>
        </div>
      )}

      {/* 検索・詳細フィルター */}
      <div className="list-search-row">
        <div className="list-search-input-wrap">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
          <input
            type="search"
            className="list-search-input"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="領収書を検索"
            aria-label="領収書を検索"
          />
          {searchText && <button className="list-search-clear" onClick={() => setSearchText('')} aria-label="検索をクリア">×</button>}
        </div>
        <button className={`list-filter-button ${showAdvancedFilters || hasAdvancedFilter ? 'active' : ''}`} onClick={() => setShowAdvancedFilters((v) => !v)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 5h16M7 12h10M10 19h4" />
          </svg>
          絞り込み
        </button>
      </div>

      {(searchText || hasAdvancedFilter) && (
        <div className="active-filter-chips">
          {searchText && <span className="active-filter-chip">検索: {searchText}<button onClick={() => setSearchText('')} aria-label="検索条件を削除">×</button></span>}
          {companyFilter.length > 0 && <span className="active-filter-chip">会社: {companyFilter.map((id) => companies.find((c) => c.id === id)?.name || id).join('・')}<button onClick={() => setCompanyFilter([])} aria-label="会社条件を削除">×</button></span>}
          {paymentFilter.length > 0 && <span className="active-filter-chip">支払い: {paymentFilter.join('・')}<button onClick={() => setPaymentFilter([])} aria-label="支払い方法条件を削除">×</button></span>}
          {(groupFilter.length > 0 || includeUngrouped) && <span className="active-filter-chip">グループ: {[...groupFilter, ...(includeUngrouped ? ['未設定'] : [])].join('・')}<button onClick={() => { setGroupFilter([]); setIncludeUngrouped(false); }} aria-label="グループ条件を削除">×</button></span>}
          {(amountMin !== '' || amountMax !== '') && <span className="active-filter-chip">金額: {amountMin || '0'}〜{amountMax || '上限なし'}円<button onClick={() => { setAmountMin(''); setAmountMax(''); }} aria-label="金額条件を削除">×</button></span>}
          {(searchText || hasAdvancedFilter) && <button className="clear-filters-button" onClick={() => { setSearchText(''); clearAdvancedFilters(); }}>すべて解除</button>}
        </div>
      )}

      {showAdvancedFilters && (
        <div className="advanced-filter-panel">
          <label>会社（複数選択）<select multiple value={companyFilter} onChange={(e) => setCompanyFilter(Array.from(e.target.selectedOptions, (o) => o.value))}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>支払い方法（複数選択）<select multiple value={paymentFilter} onChange={(e) => setPaymentFilter(Array.from(e.target.selectedOptions, (o) => o.value))}>{paymentNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
          <label>グループ（複数選択）<select multiple value={groupFilter} onChange={(e) => setGroupFilter(Array.from(e.target.selectedOptions, (o) => o.value))}>{Array.from(new Set(allReceipts.map((r) => r.groupName).filter((name): name is string => !!name))).sort().map((name) => <option key={name} value={name}>{name}</option>)}</select><span className="filter-checkbox"><input type="checkbox" checked={includeUngrouped} onChange={(e) => setIncludeUngrouped(e.target.checked)} /> グループ未設定を含む</span></label>
          <label>金額範囲（円）<div className="amount-range-inputs"><input type="number" min="0" placeholder="下限" value={amountMin} onChange={(e) => setAmountMin(e.target.value)} /><span>〜</span><input type="number" min="0" placeholder="上限" value={amountMax} onChange={(e) => setAmountMax(e.target.value)} /></div></label>
        </div>
      )}

      {/* フィルター */}
      <div className="filter-tabs">
        <button className={`filter-tab ${filter === 'unuploaded' ? 'active' : ''}`} onClick={() => setFilter('unuploaded')}>
          未UP<span className="filter-count pending">{unuploadedCount}</span>
        </button>
        <button className={`filter-tab ${filter === 'unconfirmed' ? 'active' : ''}`} onClick={() => setFilter('unconfirmed')}>
          未入力<span className="filter-count pending">{unconfirmedCount}</span>
        </button>
        <button className={`filter-tab ${filter === 'completed' ? 'active' : ''}`} onClick={() => setFilter('completed')}>
          完了<span className="filter-count completed">{completedCount}</span>
        </button>
        <button className={`filter-tab ${filter === 'error' ? 'active' : ''}`} onClick={() => setFilter('error')}>
          エラー<span className="filter-count error">{errorCount}</span>
        </button>
        <button className={`filter-tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
          すべて<span className="filter-count">{allReceipts.length}</span>
        </button>
      </div>

      {/* グリッド */}
      {receipts.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </div>
          <p className="empty-text">
            {filter === 'unuploaded' ? '未UPのレシートはありません'
              : filter === 'unconfirmed' ? '金額未入力のレシートはありません'
              : filter === 'completed' ? 'アップロード済のレシートはありません'
              : filter === 'error' ? 'エラーのレシートはありません'
              : 'レシートがまだありません'}
          </p>
          <p className="empty-hint">{searchText || hasAdvancedFilter ? '検索・絞り込み条件を変更してください' : 'カメラタブから撮影してください'}</p>
        </div>
      ) : (
        <div className="receipt-grid">
          {receipts.map((receipt) => (
            <button
              key={receipt.id}
              className={`receipt-card ${selectMode && selectedIds.has(receipt.id!) ? 'selected' : ''}`}
              onClick={() => selectMode ? toggleSelection(receipt.id!) : onSelect(receipt)}
            >
              <div className="receipt-card-image">
                <img src={thumbnailUrls.get(receipt.id!) || ''} alt={`領収書 ${receipt.id}`} loading="lazy" />
                {selectMode ? (
                  <span className={`select-checkbox ${selectedIds.has(receipt.id!) ? 'checked' : ''}`}>
                    {selectedIds.has(receipt.id!) && '✓'}
                  </span>
                ) : (
                  <div className="card-badges">
                    <span className={getStatusBadgeClass(receipt)}>
                      {getStatusLabel(receipt)}
                    </span>
                    {!receipt.companyId && receipt.uploadStatus === 'pending' && (
                      <span className="status-badge no-company">会社未設定</span>
                    )}
                    {getReceiptCategory(receipt) === 'unconfirmed' && (
                      <span className="status-badge no-company">金額確認</span>
                    )}
                    {receipt.groupName && (
                      <span className="group-label">{receipt.groupName}</span>
                    )}
                  </div>
                )}
              </div>
              <div className="receipt-card-info">
                <span className="receipt-date">{formatDate(receipt.createdAt)}</span>
                <span className={`receipt-amount ${receipt.amount === null ? 'no-amount' : ''}`}>
                  {receipt.amount !== null ? `¥${receipt.amount.toLocaleString()}` : '金額未入力'}
                </span>
                <span className="receipt-payment">{receipt.paymentMethodName}</span>
                {receipt.companyName && <span className="receipt-company">{receipt.companyName}</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* バッチアクションバー */}
      {selectMode && selectedIds.size > 0 && (
        <div className="batch-action-bar">
          <span className="batch-count">{selectedIds.size}枚 選択中</span>
          <div className="batch-buttons">
            {showDeleteConfirm ? (
              <>
                <button className="batch-button delete-confirm-button" onClick={handleBatchDelete}>削除する</button>
                <button className="batch-button cancel-button" onClick={() => setShowDeleteConfirm(false)}>取消</button>
              </>
            ) : (
              <>
                <button className="batch-button delete-button" onClick={() => setShowDeleteConfirm(true)} title="削除">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
                <button className="batch-button group-button" onClick={() => setShowGroupManager(true)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                    <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
                  </svg>
                  まとめる
                </button>
                <button className="batch-button company-button" onClick={() => setShowCompanyAssigner(true)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 21h18" />
                    <path d="M5 21V7l8-4v18" />
                    <path d="M19 21V11l-6-4" />
                  </svg>
                  会社設定
                </button>
                <button
                  className="batch-button upload-button"
                  onClick={handleUpload}
                  disabled={isUploading}
                >
                  {isUploading ? (
                    <div className="shutter-spinner small" />
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                  )}
                  アップロード
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* グループ専用の手動申請バー（単票は自動アップロードされるため手動はグループのみ） */}
      {!selectMode && filter === 'unuploaded' && groupedPendingReceipts.length > 0 && (
        <div className="upload-all-bar">
          <button className="upload-all-button" onClick={handleGroupUpload} disabled={isUploading}>
            {isUploading ? (
              <><div className="shutter-spinner small" /> アップロード中...</>
            ) : (
              <>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                グループを申請（{groupedPendingReceipts.length}枚）
              </>
            )}
          </button>
        </div>
      )}

      {/* 会社割当モーダル */}
      {showCompanyAssigner && (
        <CompanyAssigner
          companies={companies}
          selected={null}
          onSelect={handleCompanyAssign}
          onClose={() => setShowCompanyAssigner(false)}
        />
      )}

      {/* グループ化モーダル */}
      {showGroupManager && (
        <GroupManager
          selectedCount={selectedIds.size}
          onApply={handleGroupApply}
          onCancel={() => setShowGroupManager(false)}
        />
      )}
    </div>
  );
}
