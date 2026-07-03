# プロジェクトルール — 領収書撮影システム V2

## 🔴 Freee API 安全規則（最重要）

本プロジェクトは Freee 会計 API と連携しています。
Freee API への破壊的操作（DELETE、マスタ変更PUT）は、企業運営に致命的なダメージを与える可能性があるため、以下を厳守してください：

1. **Freee API への DELETE リクエストのコードを書いてはならない**
2. **Freee API への PUT リクエストのコードを書いてはならない**（マスタデータの変更に該当するもの）
3. **許可される POST は `receipts`（証憑アップロード）と `expense_applications`（経費精算下書き）のみ**
4. **freeeAPIv2 ライブラリ自体を変更してはならない**（Script ID: `1qn-v2btDmxL4wIhqCsvb_2x4KZGopxWty6N5rSUg_uiv_TSAsIaJoZsm`）
5. GAS コードで新しい Freee API エンドポイントを追加する場合は、必ずユーザーの承認を得ること

## コーディング規約

- GAS バックエンドは `.js`（純粋 JavaScript）で記述する（`.ts` は clasp が認識しない）
- `clasp deploy` は必ず `-i <DEPLOYMENT_ID>` オプションで既存デプロイを上書きすること
- GAS の `clasp push` と `clasp deploy` は `gas/` ディレクトリで実行すること（PowerShell では `&&` 不可）
