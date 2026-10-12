# 2026-10-12 R2恢复与重新验证

原云端执行环境恢复后，未推送的R2目录丢失。本目录结合原工具文本精确恢复和授权范围内重建；没有将整版冒称为逐字找回。

## 当前与冻结前Git blob SHA完全一致

- app.css
- app.js
- assets/favicon.ico
- assets/logo-mark.svg
- canvas.css
- index.html
- onboarding.css
- onboarding.js
- package-lock.json
- panels.css
- tests/canvas-r2-tests.cjs
- tests/canvas-unit-tests.cjs
- tests/onboarding-model.test.cjs
- vendor/LICENSE-opencc-data-Apache-2.0.txt
- vendor/LICENSE-opencc-js.txt
- vendor/NOTICE-search.txt
- vendor/THIRD_PARTY_LICENSES-opencc-js.md
- vendor/jieba/LICENSE.txt
- vendor/jieba/jieba_rs_wasm.js
- vendor/jieba/jieba_rs_wasm_bg.wasm
- vendor/opencc-t2cn.js

## 恢复性重建或本轮修改

- ONBOARDING.md
- README.md
- REVIEW-R2.md
- canvas.js
- clipboard.js
- objects.js
- package.json
- panels.js
- tests/clipboard-r2-tests.cjs
- tests/panels-model.test.cjs

panels.js与其测试最初已精确恢复，随后真实QA确认块菜单Esc后ResizeObserver重绘丢焦，因此作了局部修复；原精确快照另保留在recovered/panels-replay。objects/canvas/clipboard按重建版重新验收。package.json仅扩充测试命令。历史QA位于artifacts/historical-20261011，不是本次通过证据。

## 本轮重新执行

- npm ci --ignore-scripts：精确锁文件测试依赖安装完成
- npm test：34画布 + 13剪贴板 + 12引导 + 16对象层 + 3应用存储单项，以及8组正文/搜索测试通过
- npm run check：6份业务JavaScript语法通过
- 云端真实浏览器核心及引导重新验收完成，已发现并修复正文Esc异步重绘焦点问题；具体新通过项和未测项见 artifacts/QA-RECOVERY-20261012.md。图片、真实IME、窄屏等未在本次复测，不能沿用昨日结论

逐文件证据：artifacts/recovery-file-provenance.json；新模型输出：artifacts/recovery-unit-results.txt。
