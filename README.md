# 📸 レシートカメラ Pro — 領収書撮影システム V2

社員向け領収書撮影 → Freee 経費精算自動連携システム

## 概要

スマートフォンで領収書を撮影し、選択した会社の Freee 会計に経費精算の下書きとして自動登録する PWA アプリケーションです。

## アーキテクチャ

```
📱 PWA (React + Vite)
  ↓ 画像 + メタデータ
⚡ GAS Web App
  ├→ 📁 Google Drive（画像保存）
  ├→ 📊 スプレッドシート（ログ）
  └→ 🔗 Freee API（経費精算下書き）
```

## 主な機能

- 📷 **撮影**: 支払い方法をワンタップ選択 → 連続撮影
- 📋 **整理**: 会社割り当て、グループ化（複数レシートを1経費精算に）
- ☁️ **アップロード**: Freee に証憑 + 経費精算下書きを一括作成
- 🔄 **リトライ**: アップロード失敗時の自動画像保全 + リトライ機能

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | React 19 + TypeScript + Vite 8 |
| ストレージ | IndexedDB (Dexie) |
| バックエンド | Google Apps Script |
| API連携 | freeeAPIv2 ライブラリ |
| デプロイ | GitHub Pages (PWA) + Clasp (GAS) |

## セットアップ

詳細なセットアップ手順は [SETUP.md](./SETUP.md) を参照してください。

## 開発

```bash
# 開発サーバー起動
docker compose up

# GAS コードのプッシュ
cd gas && clasp push

# ビルド
npm run build
```

## ライセンス

Private
