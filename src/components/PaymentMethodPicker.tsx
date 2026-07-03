import { useState } from 'react';
import type { PaymentMethod } from '../db';

interface PaymentMethodPickerProps {
  methods: PaymentMethod[];
  selected: PaymentMethod | null;
  onSelect: (method: PaymentMethod) => void;
}

export default function PaymentMethodPicker({ methods, selected, onSelect }: PaymentMethodPickerProps) {
  const [showDropdown, setShowDropdown] = useState(false);

  const majorMethods = methods.filter(m => m.isMajor);
  const otherMethods = methods.filter(m => !m.isMajor);

  return (
    <div className="payment-picker">
      <div className="payment-buttons">
        {majorMethods.map((method) => (
          <button
            key={method.id}
            className={`payment-button ${selected?.id === method.id ? 'active' : ''}`}
            onClick={() => onSelect(method)}
          >
            {method.name}
          </button>
        ))}

        {otherMethods.length > 0 && (
          <div className="payment-dropdown-container">
            <button
              className={`payment-button payment-other ${otherMethods.some(m => m.id === selected?.id) ? 'active' : ''}`}
              onClick={() => setShowDropdown(!showDropdown)}
            >
              {otherMethods.find(m => m.id === selected?.id)?.name || 'その他'}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {showDropdown && (
              <div className="payment-dropdown">
                {otherMethods.map((method) => (
                  <button
                    key={method.id}
                    className={`payment-dropdown-item ${selected?.id === method.id ? 'active' : ''}`}
                    onClick={() => {
                      onSelect(method);
                      setShowDropdown(false);
                    }}
                  >
                    {method.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
