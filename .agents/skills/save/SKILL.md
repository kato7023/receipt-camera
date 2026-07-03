---
name: save
description: Clasp push/deploy、Git commit/push を一括実行するデプロイ・バージョン管理スキル
---

# Save スキル

ユーザーが `/save` と入力した際に、以下の手順を順番に実行する。

## 前提条件の確認

実行前に以下を確認する:
- Git リポジトリが初期化されていること（`git status` で確認）
- `gas/.clasp.json` が存在すること（GAS プロジェクトの Clasp 設定）

## 手順

### Step 1: 変更差分の確認

```bash
git status
git diff --stat
```

変更内容をユーザーに簡潔に提示する。

### Step 2: Clasp Push & Deploy

`gas/.clasp.json` が存在する場合に実行する。

```bash
# GAS プロジェクトディレクトリに移動してプッシュ
cd gas && clasp push

# 新しいバージョンとしてデプロイ
clasp deploy --description "自動デプロイ: YYYY-MM-DD HH:MM"
```

**デプロイID管理:**
- `clasp deploy` の実行結果からデプロイID とバージョン番号を取得する
- 取得した情報を `ChatLog/` の当日のログファイルに「デプロイ情報」セクションとして記録する
- 過去のデプロイIDの一覧は `clasp deployments` で確認可能

### Step 3: PWA ビルド

```bash
npm run build
```

ビルドが成功することを確認する。

### Step 4: Git Commit & Push

```bash
# すべての変更をステージング
git add .

# コミットメッセージを自動生成してコミット
git commit -m "自動生成されたコミットメッセージ"

# リモートにプッシュ
git push
```

**コミットメッセージの自動生成ルール:**
- `git diff --cached --stat` の内容から変更概要を推定する
- フォーマット: `[カテゴリ] 変更の要約`
- カテゴリ例:
  - `feat`: 新機能追加
  - `fix`: バグ修正
  - `style`: UI/デザイン変更
  - `refactor`: リファクタリング
  - `docs`: ドキュメント更新
  - `chore`: 設定・ツール変更
- 例: `[feat] Freee API 経費精算下書き作成機能を実装`
- 例: `[style] 支払い方法ボタンのレイアウトを調整`

### Step 5: 実行結果のサマリー表示

すべての手順が完了したら、以下の情報をまとめて表示する:

| 項目 | 結果 |
|---|---|
| Clasp Push | ✅ 成功 / ❌ 失敗 |
| Clasp Deploy | ✅ デプロイID: xxx / ❌ 失敗 |
| PWA Build | ✅ 成功 / ❌ 失敗 |
| Git Commit | ✅ コミットハッシュ: xxx |
| Git Push | ✅ プッシュ先: origin/main |

## エラー時の対応

- いずれかのステップでエラーが発生した場合は、**即座に停止**してエラー内容をユーザーに報告する。
- 自動的にリトライや強制実行は行わない。

## 注意事項

- `.env` ファイルやシークレット情報が `.gitignore` に含まれていることを確認してからコミットする。
- `git push` の前に、プッシュ先のブランチが正しいことを確認する。
- 初回の `git push` でリモートリポジトリが設定されていない場合は、ユーザーにリモートURLの設定を案内する。
