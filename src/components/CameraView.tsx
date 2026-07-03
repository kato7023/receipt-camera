import { useState, useRef, useCallback, useEffect } from 'react';
import { saveReceipt } from '../db';
import type { Company, PaymentMethod } from '../db';
import { getCachedCompanies, getCachedPaymentMethods } from '../api';
import PaymentMethodPicker from './PaymentMethodPicker';
import CompanyAssigner from './CompanyAssigner';

interface CameraViewProps {
  onCapture: () => void;
}

export default function CameraView({ onCapture }: CameraViewProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastCaptured, setLastCaptured] = useState<string | null>(null);
  const [captureCount, setCaptureCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 支払い方法
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [selectedPayment, setSelectedPayment] = useState<PaymentMethod | null>(null);
  
  // 会社選択（任意）
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<Company | null>(null);
  const [showCompanySelector, setShowCompanySelector] = useState(false);

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
  const handleCompanySelect = useCallback((company: Company | null) => {
    setSelectedCompany(company);
    setShowCompanySelector(false);
    // 選択中の支払い方法がその会社で使えない場合、現金にリセット
    if (company && selectedPayment) {
      const isValid = selectedPayment.companyId === null || selectedPayment.companyId === company.id;
      if (!isValid) {
        const cash = paymentMethods.find(m => m.name === '現金') || paymentMethods[0];
        if (cash) setSelectedPayment(cash);
      }
    }
  }, [selectedPayment, paymentMethods]);

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
          selectedCompany?.name || null
        );
        setCaptureCount((prev) => prev + 1);

        const url = URL.createObjectURL(file);
        setLastCaptured(url);
        setTimeout(() => {
          setLastCaptured(null);
          URL.revokeObjectURL(url);
        }, 2000);

        onCapture();
      } catch (err) {
        console.error('保存に失敗しました:', err);
        alert('保存に失敗しました。もう一度お試しください。');
      } finally {
        setIsProcessing(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [onCapture, selectedPayment, selectedCompany]
  );

  const triggerCapture = () => fileInputRef.current?.click();

  return (
    <div className="camera-view">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleCapture}
        className="camera-input-hidden"
        id="camera-input"
      />

      <div className="camera-content">
        {/* 会社選択（任意） */}
        <button
          className={`company-selector-button ${selectedCompany ? 'selected' : ''}`}
          onClick={() => setShowCompanySelector(true)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 21h18" />
            <path d="M5 21V7l8-4v18" />
            <path d="M19 21V11l-6-4" />
            <path d="M9 9h1" />
            <path d="M9 13h1" />
            <path d="M9 17h1" />
          </svg>
          <span>{selectedCompany ? selectedCompany.name : '会社未選択'}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
        </button>

        {/* 支払い方法ボタン群 */}
        <PaymentMethodPicker
          methods={filteredPaymentMethods}
          selected={selectedPayment}
          onSelect={handlePaymentSelect}
        />

        {/* ステータス表示 */}
        {captureCount > 0 && (
          <div className="capture-badge">
            <span className="capture-badge-icon">✓</span>
            <span>本日 {captureCount} 枚撮影</span>
          </div>
        )}

        {/* プレビュー or アイコン */}
        <div className="camera-preview-area">
          {lastCaptured ? (
            <div className="capture-success">
              <img src={lastCaptured} alt="撮影した領収書" className="capture-preview-img" />
              <div className="capture-success-overlay">
                <span className="capture-success-check">✓</span>
                <span>保存しました</span>
              </div>
            </div>
          ) : (
            <div className="camera-icon-area">
              <div className="camera-icon">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                  <circle cx="12" cy="13" r="3" />
                </svg>
              </div>
              <p className="camera-hint">タップして領収書を撮影</p>
            </div>
          )}
        </div>

        {/* シャッターボタン */}
        <button
          className={`shutter-button ${isProcessing ? 'processing' : ''}`}
          onClick={triggerCapture}
          disabled={isProcessing || !selectedPayment}
          aria-label="撮影"
        >
          <div className="shutter-button-inner">
            {isProcessing ? (
              <div className="shutter-spinner" />
            ) : (
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                <circle cx="12" cy="13" r="3" fill="white" />
              </svg>
            )}
          </div>
        </button>
      </div>

      {/* 会社選択モーダル */}
      {showCompanySelector && (
        <CompanyAssigner
          companies={companies}
          selected={selectedCompany}
          onSelect={handleCompanySelect}
          onClose={() => setShowCompanySelector(false)}
        />
      )}
    </div>
  );
}
