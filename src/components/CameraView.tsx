import { useState, useRef, useCallback, useEffect } from 'react';
import { saveReceipt, getExistingGroupNames } from '../db';
import type { Company, PaymentMethod } from '../db';
import { getCachedCompanies, getCachedPaymentMethods } from '../api';
import ButtonPicker from './ButtonPicker';

interface CameraViewProps {
  onCapture: () => void;
}

const UNSET_COMPANY: Company = { id: '', name: '未選択', freeeCompanyId: 0, isMajor: false, shortName: '未選択' };

export default function CameraView({ onCapture }: CameraViewProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastCaptured, setLastCaptured] = useState<string | null>(null);
  const [captureCount, setCaptureCount] = useState(0);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const albumInputRef = useRef<HTMLInputElement>(null);

  // 支払い方法
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [selectedPayment, setSelectedPayment] = useState<PaymentMethod | null>(null);

  // 会社選択（任意）
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<Company | null>(null);

  // グループ選択（任意）
  const [existingGroups, setExistingGroups] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  // マスタデータ読み込み
  useEffect(() => {
    getCachedPaymentMethods().then((methods) => {
      setPaymentMethods(methods);
      // デフォルトは現金
      const defaultId = localStorage.getItem('defaultPaymentMethodId') || 'cash';
      const defaultMethod = methods.find(m => m.id === defaultId) || methods.find(m => m.name === '現金') || methods[0];
      if (defaultMethod) setSelectedPayment(defaultMethod);
    });
    getCachedCompanies().then(setCompanies);
    loadExistingGroups();
  }, []);

  // グループ名一覧を読み込み
  const loadExistingGroups = useCallback(async () => {
    const groups = await getExistingGroupNames();
    setExistingGroups(groups);
  }, []);

  // 会社選択時に支払い方法をフィルター
  const filteredPaymentMethods = selectedCompany
    ? paymentMethods.filter(m => m.companyId === null || m.companyId === selectedCompany.id)
    : paymentMethods;

  // 支払い方法選択時の会社自動選択
  const handlePaymentSelect = useCallback((method: PaymentMethod) => {
    setSelectedPayment(method);
    localStorage.setItem('defaultPaymentMethodId', method.id);
    // 会社固有の支払い方法 → 会社自動選択
    if (method.companyId) {
      const company = companies.find(c => c.id === method.companyId);
      if (company) setSelectedCompany(company);
    }
  }, [companies]);

  // 会社選択時に支払い方法を確認
  const handleCompanySelect = useCallback((item: Company) => {
    const company = item.id === '' ? null : item;
    setSelectedCompany(company);
    // 選択中の支払い方法がその会社で使えない場合、現金にリセット
    if (company && selectedPayment) {
      const isValid = selectedPayment.companyId === null || selectedPayment.companyId === company.id;
      if (!isValid) {
        const cash = paymentMethods.find(m => m.name === '現金') || paymentMethods[0];
        if (cash) setSelectedPayment(cash);
      }
    }
  }, [selectedPayment, paymentMethods]);

  // グループ選択
  const handleGroupSelect = useCallback((groupName: string | null) => {
    setSelectedGroup(prev => prev === groupName ? null : groupName);
  }, []);

  const handleCapture = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !selectedPayment) return;

      setIsProcessing(true);
      try {
        await saveReceipt(
          file,
          selectedPayment.id,
          selectedPayment.name,
          selectedCompany?.id || null,
          selectedCompany?.name || null,
          selectedGroup
        );
        setCaptureCount((prev) => prev + 1);

        const url = URL.createObjectURL(file);
        setLastCaptured(url);
        setTimeout(() => {
          setLastCaptured(null);
          URL.revokeObjectURL(url);
        }, 2000);

        // グループ一覧を更新（新しいグループが追加された可能性）
        loadExistingGroups();
        onCapture();
      } catch (err) {
        console.error('保存に失敗しました:', err);
        alert('保存に失敗しました。もう一度お試しください。');
      } finally {
        setIsProcessing(false);
        if (cameraInputRef.current) cameraInputRef.current.value = '';
        if (albumInputRef.current) albumInputRef.current.value = '';
      }
    },
    [onCapture, selectedPayment, selectedCompany, selectedGroup, loadExistingGroups]
  );

  const triggerCameraCapture = () => cameraInputRef.current?.click();
  const triggerAlbumPick = () => albumInputRef.current?.click();

  return (
    <div className="camera-view">
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleCapture}
        className="camera-input-hidden"
        id="camera-input"
      />
      <input
        ref={albumInputRef}
        type="file"
        accept="image/*"
        onChange={handleCapture}
        className="camera-input-hidden"
        id="album-input"
      />

      <div className="camera-content">
        {/* 会社選択 */}
        <div className="picker-section">
          <span className="picker-section-title">会社選択</span>
          <ButtonPicker
            items={[UNSET_COMPANY, ...companies]}
            selected={selectedCompany ?? UNSET_COMPANY}
            onSelect={handleCompanySelect}
          />
        </div>

        <div className="picker-divider" />

        {/* 支払い方法選択 */}
        <div className="picker-section">
          <span className="picker-section-title">支払い選択</span>
          <ButtonPicker
            items={filteredPaymentMethods}
            selected={selectedPayment}
            onSelect={handlePaymentSelect}
          />
        </div>

        {/* グループ選択（既存グループがある場合のみ表示） */}
        {existingGroups.length > 0 && (
          <div className="group-picker">
            <div className="group-picker-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span>グループ</span>
            </div>
            <div className="group-buttons">
              {existingGroups.map((name) => (
                <button
                  key={name}
                  className={`group-button ${selectedGroup === name ? 'active' : ''}`}
                  onClick={() => handleGroupSelect(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ステータス表示 */}
        {captureCount > 0 && (
          <div className="capture-badge">
            <span className="capture-badge-icon">✓</span>
            <span>本日 {captureCount} 枚撮影</span>
          </div>
        )}

        {/* 撮影エリア（タップで撮影） / プレビュー */}
        <button
          className="camera-preview-area"
          onClick={triggerCameraCapture}
          disabled={isProcessing || !selectedPayment}
          aria-label="撮影"
        >
          {lastCaptured ? (
            <div className="capture-success">
              <img src={lastCaptured} alt="撮影した領収書" className="capture-preview-img" />
              <div className="capture-success-overlay">
                <span className="capture-success-check">✓</span>
                <span>保存しました{selectedGroup ? ` → ${selectedGroup}` : ''}</span>
              </div>
            </div>
          ) : (
            <div className="camera-icon-area">
              {isProcessing ? (
                <div className="shutter-spinner" />
              ) : (
                <>
                  <div className="camera-icon">
                    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                      <circle cx="12" cy="13" r="3" />
                    </svg>
                  </div>
                  <p className="camera-hint">タップして領収書を撮影</p>
                </>
              )}
            </div>
          )}
        </button>

        {/* アルバムから選択ボタン */}
        <button
          className="album-button"
          onClick={triggerAlbumPick}
          disabled={isProcessing || !selectedPayment}
          aria-label="アルバムから選択"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span>アルバムから選択</span>
        </button>
      </div>
    </div>
  );
}
