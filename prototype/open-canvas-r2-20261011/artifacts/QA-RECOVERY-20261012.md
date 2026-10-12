# Recovery independent cloud CUA QA — 2026-10-12

All results below are newly exercised on the recovered/rebuilt R2, not carried forward from yesterday. Cloud Chromium tested the local HTTP prototype at 127.0.0.1:48933 with isolated test data and a separate clean persistent page. No user computer was used.

## Newly passed actual interactions
- New-card tool waits for placement, then inline QA A title; Enter commits. N shortcut creates second card. Double-click title enters title editing, body opens editor.
- Body text editing; Enter creates second paragraph; separately typed beta undo followed by gamma stays in original second paragraph.
- Insert-block filter 表格 plus Down/Enter inserts table. Last cell input last then Tab creates third row.
- H2 section collapse/expand; collapse does not create a content undo. List item increase-indent creates nested list.
- Block-menu Escape initially returned focus to body after rail repaint. Reported, patched by author; fresh reload and delayed DOM check now confirm focus remains on same H2 block handle.
- Simplified 台积电 ALPHA matches original 臺積電 alpha; readiness reports OpenCC and Chinese segmentation. Rich preview retains heading/list/table. Next hit then explicit open continues existing editor at2/2.
- Ordinary A→B, repeat A→B and B→A produce3 paths; A→A rejected with explicit toast and still3 paths. Moving B updates all3 path endpoints.
- Card green color applied. Cross-project Ctrl+C/V copies QA B into INTC; Ctrl+X then switching back and Ctrl+V moves copied object back while retaining original B.
- Frame drawn around3 cards; Delete removes frame while retaining all3 cards; Ctrl+Z restores frame.
- Line property UI: start circle, dashed enabled, reverse markers -> start arrow/end circle, dashed still enabled. Escape closes and focuses Appearance; explicit X closes and focuses Appearance, selection retained.
- Onboarding first invite, skip, Help reopen, four steps/completion; Tab and Escape route is usable. Regular root skip→reload and completion→reload do not reopen invitation. Tutorial does not create content.
- Regular root QA persist card body survives full reload. Only own test card was deleted afterward; final root retains clean4-card seed and original2 projects.

## New evidence
- recovery-document-table.jpg: actual new paragraph/table test state.
- recovery-rich-search.jpg: final CSS, simplified/traditional query with highlighted original and rich H2/list preview.
- recovery-final-canvas.jpg: clean final regular root,1342x934 viewport,100% canvas zoom, selection tool. Native Chrome expanded to near full1364x1024 desktop.

## Not verified in this recovery pass
Images/import/crop, true OS IME, long-document reading position after reload, block drag reorder, mobile/narrow responsive states, code literal editing, exhaustive grouping/nested-frame/detached-frame-endpoint behavior, clipboard internal-edge set cloning, all AI candidate actions, all97 matrix requirements. Yesterday's records are historical only and must not be counted as recovered-version passes. Some property/model tests may cover these independently; this document makes no claim about their live CUA pass status.

## Final preview

http://127.0.0.1:48933/ is the clean persistent preview (not isolated QA). The cloud-local server remains running.

Screenshots were inspected during QA and are not included in this source commit.
