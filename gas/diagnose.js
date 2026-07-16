/**
 * Phase 1 実測診断（GASエディタから手動実行）
 *
 * diagnosePhase1: 会社マスタの全有効事業所に対して
 *   1) 部門一覧をGETし「役員精算」の有無とIDをログ出力
 *   2) メモタグ一覧をGETし「現金一括」で始まる既存タグの実例をログ出力（表記の確認用）
 *   実際の会社には読み取り（GET）のみ。何も作成・変更しない。
 *
 * diagnosePhase1CreateTestTag: 「開発用テスト事業所」だけを対象に、
 *   getOrCreateCashTag を実行して「現金一括YYMM」タグの作成動作を実測する。
 */

function diagnosePhase1() {
  Logger.log('=== Phase 1 実測診断（読み取りのみ） ===');
  const companies = getCompanies();

  companies.forEach(function(company) {
    Logger.log('--- ' + company.name + ' (freeeCompanyId=' + company.freeeCompanyId + ') ---');

    // 1) 部門
    try {
      const req = new FreeeAPI.Request('sections').addParam('company_id', company.freeeCompanyId);
      const response = req.requestGET();
      const sections = (response && response.sections) || [];
      const exec = sections.find(function(s) { return s.name === '役員精算'; });
      if (exec) {
        Logger.log('  ✅ 部門「役員精算」あり (id=' + exec.id + ', available=' + exec.available + ')');
      } else {
        Logger.log('  ⚠️ 部門「役員精算」なし。既存部門: ' +
          (sections.length ? sections.map(function(s) { return s.name; }).join(', ') : '(部門なし)'));
      }
    } catch (e) {
      Logger.log('  ❌ 部門取得エラー: ' + e.message);
    }

    // 2) 現金一括タグの実例
    try {
      const req = new FreeeAPI.Request('tags')
        .addParam('company_id', company.freeeCompanyId)
        .addParam('limit', 3000);
      const response = req.requestGET();
      const tags = (response && response.tags) || [];
      const cashTags = tags.filter(function(t) { return t.name && t.name.indexOf('現金一括') === 0; });
      if (cashTags.length > 0) {
        Logger.log('  ✅ 既存の現金一括タグ: ' + cashTags.map(function(t) { return t.name + '(id=' + t.id + ')'; }).join(', '));
      } else {
        Logger.log('  ℹ️ 「現金一括」で始まるタグなし（総タグ数: ' + tags.length + '件）');
      }
    } catch (e) {
      Logger.log('  ❌ タグ取得エラー: ' + e.message);
    }
  });

  Logger.log('🎉 診断完了。ログをClaude Codeに貼り付けてください。');
}

function diagnosePhase1CreateTestTag() {
  Logger.log('=== 現金一括タグ作成テスト（開発用テスト事業所のみ） ===');
  const companies = getCompanies();
  const target = companies.find(function(c) {
    return c.name.indexOf('開発用テスト事業所') !== -1 && c.name.indexOf('削除') === -1;
  });
  if (!target) {
    Logger.log('❌ 「開発用テスト事業所」が会社マスタに見つかりません');
    return;
  }

  const tagId = getOrCreateCashTag(target.freeeCompanyId, new Date().toISOString());
  Logger.log(tagId
    ? '✅ タグ取得/作成成功: id=' + tagId + '（freee画面の「設定→タグ」で名前を確認してください）'
    : '❌ タグ取得/作成に失敗しました（上のログを確認）');
}
