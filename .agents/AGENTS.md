# プロジェクトルール — 領収書撮影システム V2

## 🔴 Freee API 安全規則（最重要）

本プロジェクトは Freee 会計 API と連携しています。
Freee API への破壊的操作（DELETE、マスタ変更PUT）は、企業運営に致命的なダメージを与える可能性があるため、以下を厳守してください：

1. **Freee API への DELETE リクエストのコードを書いてはならない**
2. **Freee API への PUT リクエストのコードを書いてはならない**（マスタデータの変更に該当するもの）
   - 例外（2026-07-13 ユーザー承認）: `PUT /api/1/expense_applications/{id}` — **本アプリが作成した下書き(draft)申請の更新に限定**。マスタデータには一切触れない
3. **許可される POST は `receipts`（証憑アップロード）と `expense_applications`（経費精算下書き）のみ**
   - 例外（2026-07-13 ユーザー承認）: `POST /api/1/tags`（メモタグ新規作成のみ。破壊的変更なし）
4. **freeeAPIv2 ライブラリ自体を変更してはならない**（Script ID: `1qn-v2btDmxL4wIhqCsvb_2x4KZGopxWty6N5rSUg_uiv_TSAsIaJoZsm`）
5. GAS コードで新しい Freee API エンドポイントを追加する場合は、必ずユーザーの承認を得ること
   - 承認済みGETエンドポイント（2026-07-13）: `GET /api/1/receipts/{id}`（OCR結果）・`GET /api/1/sections`（部門）・`GET /api/1/tags`（メモタグ）・`GET /api/1/expense_applications`／`GET /api/1/expense_applications/{id}`（過去申請の類似調査・PUT前の行ID取得）

## コーディング規約

## 会話開始時のLearn確認

- 会話開始時、Obsidian MCPで `AI/_AIメモ規約.md` と `AI/_index.md` を確認する。
- 作業内容に関連する既存Learnノートを検索し、既知の解決策・注意点を先に適用する。
- Learn保存時は、Obsidian MCPを使い、規約に従って新規ノートと索引追記を行う。

- GAS バックエンドは `.js`（純粋 JavaScript）で記述する（`.ts` は clasp が認識しない）
- `clasp deploy` は必ず `-i <DEPLOYMENT_ID>` オプションで既存デプロイを上書きすること
  - 本番デプロイID: `AKfycbzL3-ILK03itxNzael4g4SylPk1vMiMC_u-uO-rWobtiqNAYWcB7KlADuZTaN3TH2c`
  - テスト用固定デプロイID（feature/auto-upload開発用。PWA側はlocalStorage `gasWebAppUrl` で切替）: `AKfycbyoUjdl_HJJug0Rv-155uR8vG7I5v4wmkNuol-WXAtNxFeW8quGU-MhOcy4ek4gAV4`
- GAS の `clasp push` と `clasp deploy` は `gas/` ディレクトリで実行すること（PowerShell では `&&` 不可）
- feature ブランチ開発中は本番デプロイIDへの `clasp deploy -i` を行わないこと（テスト用IDのみ更新。本番反映は main マージ後）
