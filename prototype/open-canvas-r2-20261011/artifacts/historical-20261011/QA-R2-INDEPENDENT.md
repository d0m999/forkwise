# R2 independent actual cloud-browser QA

> 历史 R2 检查记录（2026-10-11），从执行记录恢复。适用于当时版本，不代替 2026-10-12 恢复重建版的重新验证。

Date: 2026-10-11 UTC. Target: localhost:48933, isolated QA only. R1 user data was not edited. This is bounded interaction evidence, not an assertion that all 97 matrix requirements pass.

## Verified
- H2 section collapse hides contents; expanding restores them. Collapse itself does not enable document undo.
- Nested list indentation; selecting/deleting parent removes its nested child; a single undo restores the tree.
- Block menu Escape initially leaked to canvas; fixed and retested: closes menu and returns focus to original block handle.
- Insert menu keyboard initially did not activate: fixed and retested auto-focus, filter 表格, Down, Enter inserts table.
- Table add-row/add-column commands produce 3x3 cells. Last-cell Tab initially failed; fixed and retested after entering endcell: adds a third row, caret in new first cell.
- Code block accepts literal const x = 1; and <b>literal</b>; Tab inserts spaces, no HTML interpretation.
- Undo caret initially jumped to document start; first fix still jumped to previous paragraph. Real Enter had duplicated data-block-id. Second fix deduplicates identities. Reloaded and retested: Enter new paragraph, type 臺積電 alpha, separately type beta, Ctrl+Z, type gamma -> final paragraph 臺積電 alpha gamma; prior paragraph unchanged.
- Simplified query 台积电 ALPHA matches original 臺積電 alpha. UI reports simplified/traditional matching and Chinese segmentation ready. Rich preview retains headings, lists, table and code text (earlier mixed-document run). Screenshot captures heading/list rich preview and two highlighted terms.
- Search next-hit then explicit open with editor already open continues at 2/2 in-document search.
- Link keyboard prompt can be canceled without inserting a link.
- Actual native Chrome narrow window approximately 752px wide: search becomes single-column; result click opens rich preview with return-results and explicit-open reachable; explicit open pans to card. Editor becomes full-width with reachable close. Restored desktop-sized window after test.

## Evidence

Screenshots listed below were inspected during QA but are intentionally not included in this source commit.
- qa-r2-rich-search.jpg: simplified/traditional rich preview and highlights after caret fix.
- qa-r2-table-keyboard.jpg: last-cell Tab created third row; also preserves the earlier caret bug diagnostic text, not final presentation copy.
- qa-r2-narrow-preview.jpg: native narrow-window preview, full desktop evidence.
- qa-r2-narrow-editor.jpg: native narrow-window full-width editor.

## Limits / not tested
- PNG/JPEG image insertion, resizing and crop were not verified. Upload approval was requested for an SVG fixture; no image appeared, no alternate upload was attempted after parent instruction. Worker confirms SVG document images are intentionally unsupported. Do not mark image acceptance complete.
- True OS IME composition was not exercised; ordinary Chinese text insertion is not a substitute.
- Block drag reorder, long-document reading position across reload, failed-storage paths, full mobile390 layout and exhaustive97 requirement coverage not verified here.
- Native cloud Chrome displayed a separate view/state from CDP tab12. Narrow tests were done by native visible UI on verified localhost48933/?isolated=1, not inferred from CDP viewport (which remained1348x934).
- Onboarding is awaiting integration; its QA and final clean-page handoff will be appended separately.

## Onboarding final addendum (17:18 UTC)
- v=r2-1715 actual first invite, skip, Help -> reopen, all four steps and completion verified.
- Tab reaches actionable location button; Escape exits guide and focuses Help.
- Opening search hides guide; Escape closing search restores a compact Continue guide strip.
- Regular root page tab13: skip then reload does not show invite; reopen/complete then reload also stays clean. Seed cards/projects unchanged and undo remains disabled. Isolated mode explicitly says guide persistence is only this page.
- Actual native window approx592px wide: invite and next/close buttons reachable, editor opening collapses guide to compact strip that does not cover body or close. Window restored to desktop size.
- qa-r2-onboarding-narrow.jpg captures compact guide alongside readable editor.
- qa-r2-final-canvas.jpg is final regular root clean1348x934 page,100% canvas zoom, selection tool active. Handoff targets tab13, not QA isolated tab12.
- No source changes, commits, pushes, deploys or Mac actions were made by independent QA.
