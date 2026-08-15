# 召唤物美术资源补全 · 完成概览

## 做了什么
本次将 v2.1 真实召唤物系统缺失的占位美术替换为真实概念立绘，并按成长等级接入战斗渲染。

## 生成资源
- `assets/wolf_pup.png` — 叙拉古狼崽
- `assets/wolf.png` — 叙拉古成年狼
- `assets/wolf_alpha.png` — 叙拉古狼王
- `assets/beast.png` — 令之岁兽眷属

## 代码改动
- `game.js`：`SUMMON_TEMPLATES.wolf` 增加 `levelSprites` 字段，`makeCombatSummon` 按等级 lv1-2/3-4/5 自动切换狼崽/成年狼/狼王立绘；岁兽固定 `beast.png`。
- `bonds_flavor.js`：`summon.wolf.stages` 与 `summon.beast` 补 `sprite` 字段，叙事层与资源路径对齐。
- `_test_summon_sprites.js`：新增回归测试，覆盖各级 avatar 路径与资源文件非占位。

## 验证结果
- `node --check bonds_flavor.js` OK
- `_test_summon_sprites.js`：14/14 PASS
- `_playtest_jsdom.js`：42/0 PASS

## 后续替换
AI 生成图带平台水印（"AI生成 WORKBUDDY"），适合作为占位美术跑通渲染管线；后续可由正式美术替换同路径文件，无需改代码。
