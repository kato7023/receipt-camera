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

### Step 0: 既存Learnとビルド前提の確認

作業開始時にObsidian MCPで、Vaultの以下を確認する。

- `AI/_AIメモ規約.md`
- `AI/_index.md`
- 今回の変更に関連する既存Learnノート

PWAのビルド前には、既存の生成物 `dist` が原因でVite/Rolldownが変換完了後に終了することがあるため、プロジェクト直下の `dist` だけを対象に安全なクリーンアップを行う。対象パスがプロジェクトルート配下であることを確認してから削除する。

```powershell
$root = (Resolve-Path .).Path
$dist = (Resolve-Path .\dist -ErrorAction SilentlyContinue).Path
if ($dist -and $dist.StartsWith($root + '\\')) { Remove-Item -LiteralPath $dist -Recurse -Force }
```

### Step 1: 変更差分の確認

```bash
git status
git diff --stat
```

変更内容をユーザーに簡潔に提示する。

### Step 2: Clasp Push & Deploy

`gas/.clasp.json` が存在する場合に実行する。

```bash
# GAS ディレクトリで clasp push（PowerShell では && 不可なので別コマンドで実行）
# appsscript.jsonを変更した場合は必ず --force を付ける
clasp push --force
# Cwd: gas/

# 既存デプロイIDを取得して、同じIDで上書きデプロイ
clasp deployments
# Cwd: gas/
```

**⚠️ 重要: 既存デプロイIDの上書き更新**

`clasp deploy` を引数なしで実行すると**毎回新しいデプロイIDが生成**され、PWA の API URL が壊れる。
必ず `-i` オプションで既存デプロイIDを指定して上書きすること：

```bash
# 既存デプロイIDを上書き更新（URLが変わらない）
clasp deploy -i <DEPLOYMENT_ID> --description "自動デプロイ: YYYY-MM-DD HH:MM"
# Cwd: gas/
```

- `<DEPLOYMENT_ID>` は `clasp deployments` の出力から、`@HEAD` 以外の**本番用デプロイID**を使用する
- 本番デプロイIDは `src/api.ts` の `GAS_WEB_APP_URL` に含まれるIDと一致するものを選ぶ

**デプロイID管理:**
- `clasp deploy -i` の実行結果からバージョン番号を確認する
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
