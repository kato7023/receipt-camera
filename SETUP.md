# 🛠️ セットアップガイド — レシートカメラ Pro

このガイドでは、領収書撮影システム V2 のバックエンド（Google Apps Script）とフロントエンド（PWA）のセットアップ手順を説明します。

---

## 📋 目次

1. [前提環境の確認](#1-前提環境の確認)
2. [Clasp とは？](#2-clasp-とは)
3. [Clasp のインストール](#3-clasp-のインストール)
4. [Google アカウントでログイン](#4-google-アカウントでログイン)
5. [GAS プロジェクトの作成](#5-gas-プロジェクトの作成)
6. [.clasp.json の設定](#6-claspjson-の設定)
7. [コードのプッシュ](#7-コードのプッシュ)
8. [Web App としてデプロイ](#8-web-app-としてデプロイ)
9. [スプレッドシートの設定](#9-スプレッドシートの設定)
10. [Freee API アプリの登録](#10-freee-api-アプリの登録)
11. [freeeAPIv2 ライブラリの設定](#11-freeapiv2-ライブラリの設定)
12. [PWA の設定](#12-pwa-の設定)
13. [動作確認](#13-動作確認)

---

## 1. 前提環境の確認

以下がインストールされていることを確認してください：

```bash
# Node.js のバージョン確認（v18 以上推奨）
node --version

# npm のバージョン確認
npm --version
```

> 💡 **Node.js が入っていない場合**
> [Node.js 公式サイト](https://nodejs.org/) から LTS 版をインストールしてください。

---

## 2. Clasp とは？

**Clasp**（Command Line Apps Script Projects）は、Google Apps Script をローカル環境で開発するためのコマンドラインツールです。

### Clasp を使うメリット
- 🔧 お気に入りのエディタ（VS Code 等）で GAS コードを編集できる
- 📦 Git でバージョン管理できる
- 🚀 コマンド一発でデプロイできる
- 🔄 チーム開発がしやすくなる

### 仕組み
```
ローカルPC          Google Cloud
┌──────────┐       ┌──────────────┐
│ gas/     │       │ Apps Script  │
│ ├ main.ts│ push  │ プロジェクト  │
│ ├ ...    │ ───→  │              │
│           │       │ Web App      │
│           │ pull  │ として公開   │
│           │ ←──── │              │
└──────────┘       └──────────────┘
```

---

## 3. Clasp のインストール

```bash
npm install -g @google/clasp
```

インストール確認：
```bash
clasp --version
```

---

## 4. Google アカウントでログイン

```bash
clasp login
```

ブラウザが開くので、Google アカウントでログインし、権限を許可してください。

> ⚠️ **Apps Script API を有効化**
> 初回は [Apps Script 設定](https://script.google.com/home/usersettings) で「Google Apps Script API」を**オン**にする必要があります。

---

## 5. GAS プロジェクトの作成

### 方法A: Google Apps Script エディタから作成（推奨）

1. [script.google.com](https://script.google.com/) を開く
2. 「新しいプロジェクト」をクリック
3. プロジェクト名を「レシートカメラ Pro API」に変更
4. URLバーから **Script ID** を確認
   - URL: `https://script.google.com/home/projects/XXXXX/edit`
   - `XXXXX` の部分が Script ID です

### 方法B: Clasp から作成
```bash
cd gas
clasp create --title "レシートカメラ Pro API" --type webapp
```

---

## 6. .clasp.json の設定

`gas/.clasp.json` を編集して、Script ID を設定：

```json
{
  "scriptId": "ここに Script ID を貼り付け",
  "rootDir": "."
}
```

---

## 7. コードのプッシュ

```bash
cd gas
clasp push
```

初回プッシュ時に `appsscript.json` の上書き確認が出る場合は `y` を入力してください。

プッシュ後、[Apps Script エディタ](https://script.google.com/) でコードが反映されていることを確認します。

---

## 8. Web App としてデプロイ

```bash
clasp deploy --description "初回デプロイ"
```

デプロイが成功すると、以下のような出力が表示されます：
```
Created version 1.
- AKfycb... @1.
```

### Web App URL の確認

Apps Script エディタで「デプロイ」→「デプロイを管理」から URL を確認できます。

> 💡 この URL を PWA の `src/api.ts` に設定します。

---

## 9. スプレッドシートの設定

GAS がデータ管理に使用するスプレッドシートを作成します。

### 9.1 スプレッドシートの作成

1. [Google スプレッドシート](https://sheets.google.com/) で新規作成
2. 名前を「レシートカメラ Pro - マスタ」に変更
3. URLからスプレッドシートIDを確認
   - URL: `https://docs.google.com/spreadsheets/d/XXXXX/edit`

### 9.2 会社マスタシートの作成

| 会社ID | 会社名 | Freee事業所ID | 有効 |
|--------|--------|--------------|------|
| c001 | 株式会社サンプル | 1234567 | TRUE |
| c002 | サンプル商事 | 7654321 | TRUE |

### 9.3 支払い方法マスタシートの作成

| 支払いID | 支払い方法名 | 会社ID | メジャー | 有効 |
|----------|------------|--------|---------|------|
| p001 | 現金 | | TRUE | TRUE |
| p002 | VISA | | TRUE | TRUE |
| p003 | JCB | | TRUE | TRUE |
| p004 | AMEX | | TRUE | TRUE |
| p005 | 交通系IC | | FALSE | TRUE |
| p006 | 会社カード | c001 | FALSE | TRUE |

> 💡 **会社ID が空** = 全社共通の支払い方法
> 💡 **メジャー = TRUE** → PWA でボタンとして表示

### 9.4 スクリプトプロパティの設定

Apps Script エディタで「プロジェクトの設定」→「スクリプト プロパティ」に以下を追加：

| プロパティ名 | 値 |
|---|---|
| SPREADSHEET_ID | （スプレッドシートのID） |
| DRIVE_ROOT_FOLDER_ID | （Google Drive のフォルダID） |

---

## 10. Freee API アプリの登録

1. [Freee アプリストア](https://app.secure.freee.co.jp/developers/applications) にアクセス
2. 「新規作成」からアプリを作成
3. 以下を設定：
   - アプリ名: レシートカメラ Pro
   - コールバックURL: `https://script.google.com/macros/d/（Script ID）/usercallback`
4. **Client ID** と **Client Secret** をメモ

---

## 11. freeeAPIv2 ライブラリの設定

Apps Script エディタで：

1. 「ライブラリ」→「ライブラリを追加」
2. Script ID: `1qn-v2btDmxL4wIhqCsvb_2x4KZGopxWty6N5rSUg_uiv_TSAsIaJoZsm`
3. バージョンを選択（最新）
4. 識別子: `FreeeAPI`

> 💡 `appsscript.json` に既に設定済みですが、エディタからも確認してください。

---

## 12. PWA の設定

### 12.1 依存関係のインストール

```bash
# Docker 使用時
docker compose run --rm app npm install

# Docker 不使用時
npm install
```

### 12.2 GAS Web App URL の設定

`src/api.ts` の `GAS_WEB_APP_URL` にデプロイした Web App の URL を設定します。

### 12.3 開発サーバーの起動

```bash
# Docker 使用時
docker compose up

# Docker 不使用時
npm run dev
```

ブラウザで `http://localhost:5173/receipt-camera/` を開きます。

---

## 13. 動作確認

### GAS API のテスト

ブラウザで以下の URL にアクセス：
```
https://script.google.com/macros/s/（デプロイID）/exec?action=companies
```

会社一覧が JSON で返ってくれば成功です。

### PWA のテスト

1. 開発サーバーを起動
2. 支払い方法を選択
3. 撮影ボタンをタップ（またはファイル選択）
4. 一覧タブで撮影したレシートを確認

---

## 🎉 完了！

セットアップが完了しました。以下のフローでシステムが動作します：

```
📱 撮影 → 💾 ローカル保存 → 🏢 会社設定 → ☁️ GAS API → 📁 Drive保存 → 💰 Freee下書き
```
