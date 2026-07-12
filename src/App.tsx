import { useState, useCallback, useEffect } from 'react';
import CameraView from './components/CameraView';
import ReceiptList from './components/ReceiptList';
import ReceiptDetail from './components/ReceiptDetail';
import { reconcilePendingUploads, backupPendingReceipts } from './api';
import type { Receipt } from './db';

type TabType = 'camera' | 'list';

export default function App() {
  const [activeTab, setActiveTab] = useState<TabType>('camera');
  const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleCapture = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  const handleSelectReceipt = useCallback((receipt: Receipt) => {
    setSelectedReceipt(receipt);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedReceipt(null);
  }, []);

  const handleUpdate = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  // 起動時に「'uploading'のまま止まっているレシート」をGASへ問い合わせて解消する
  // （通信断発生直後にアプリを閉じてしまった場合の救済）
  useEffect(() => {
    reconcilePendingUploads().then(() => {
      setRefreshKey((prev) => prev + 1);
    });
  }, []);

  // 起動時に、撮影直後のバックグラウンドバックアップに失敗したままのレシートを再試行する
  useEffect(() => {
    backupPendingReceipts();
  }, []);

  return (
    <div className="app">
      {/* ヘッダー */}
      <header className="app-header">
        <div className="app-logo">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
            <path d="M8 10h8" />
            <path d="M8 14h4" />
          </svg>
          <h1>レシートカメラ Pro</h1>
        </div>
        <span className="app-version">v{__APP_VERSION__}</span>
      </header>

      {/* メインコンテンツ */}
      <main className="app-main">
        {activeTab === 'camera' ? (
          <CameraView onCapture={handleCapture} />
        ) : (
          <ReceiptList
            onSelect={handleSelectReceipt}
            refreshKey={refreshKey}
          />
        )}
      </main>

      {/* ボトムナビゲーション */}
      <nav className="bottom-nav">
        <button
          className={`nav-tab ${activeTab === 'camera' ? 'active' : ''}`}
          onClick={() => setActiveTab('camera')}
          aria-label="撮影"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
            <circle cx="12" cy="13" r="3" />
          </svg>
          <span>撮影</span>
        </button>
        <button
          className={`nav-tab ${activeTab === 'list' ? 'active' : ''}`}
          onClick={() => setActiveTab('list')}
          aria-label="一覧"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
          <span>一覧</span>
        </button>
      </nav>

      {/* 詳細画面オーバーレイ */}
      {selectedReceipt && (
        <ReceiptDetail
          receipt={selectedReceipt}
          onClose={handleCloseDetail}
          onUpdate={handleUpdate}
        />
      )}
    </div>
  );
}
