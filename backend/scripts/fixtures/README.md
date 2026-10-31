# 旧原型迁移夹具

`open-research-model.js` 提取自 Git `f2768cbc` 中 `prototype/forkwise-step-prototype.html` 的 `open-research-model` 脚本，仅去除脚本边界的空行，模型内容保留原样。它只供 `prototype-fixture.cjs` 在隔离 VM 中生成旧格式测试存档，不加载原型 UI，也不进入当前产品运行包。

迁移测试、迁移 smoke 和图片 smoke 共用此模型，保留旧导出格式、内容归属、材料与历史的回归覆盖。不要按当前 UI 模型重写这份历史输入。
