// 全部样式收敛在 rf3- 前缀下，且选择器一律以宿主容器为作用域起点，
// 不写全局元素选择器，避免命中其它插件或宿主的节点。

export const CSS = `
.rf3-btn{
  display:inline-flex;align-items:center;gap:4px;
  height:22px;padding:0 8px;border-radius:6px;
  border:1px solid color-mix(in srgb, currentColor 22%, transparent);
  background:transparent;color:inherit;
  font:inherit;font-size:12px;line-height:1;
  cursor:pointer;opacity:.55;
  transition:opacity .12s, background-color .12s;
  white-space:nowrap;user-select:none;
}
.rf3-btn:hover{opacity:1;background:color-mix(in srgb, currentColor 8%, transparent)}
.rf3-btn:focus-visible{outline:2px solid color-mix(in srgb, currentColor 60%, transparent);outline-offset:1px}
.rf3-btn[data-active]{opacity:1;border-color:color-mix(in srgb, #e0a34a 60%, transparent);color:#e0a34a}

/* 悬浮操作条：绝对定位于消息容器内部，不参与文档流，不改动宿主布局 */
.rf3-bar{
  position:absolute;top:2px;right:6px;z-index:5;
  display:inline-flex;gap:4px;align-items:center;
  opacity:0;pointer-events:none;
  transition:opacity .14s;
}
.rf3-host:hover > .rf3-bar,
.rf3-host:focus-within > .rf3-bar,
.rf3-bar:focus-within{opacity:1;pointer-events:auto}

/* 消息容器需要定位上下文：只在被接管的容器上加，宿主其余节点不受影响 */
.rf3-host{position:relative}
.rf3-host[data-rf3-edited]{box-shadow:inset 2px 0 0 color-mix(in srgb, #e0a34a 70%, transparent)}

/* 编辑器要盖过操作条（bar z-index:5）——否则编辑器右上角的目标下拉被 bar
   压住，真机上「点不中/点不出光标」有它一份功劳。 */
.rf3-editor{
  display:flex;flex-direction:column;gap:8px;
  margin:6px 0;padding:10px;border-radius:10px;
  border:1px solid color-mix(in srgb, currentColor 18%, transparent);
  background:color-mix(in srgb, currentColor 4%, transparent);
  position:relative;z-index:6;
}
.rf3-editor textarea{
  width:100%;min-height:120px;resize:vertical;
  padding:8px 10px;border-radius:8px;
  border:1px solid color-mix(in srgb, currentColor 20%, transparent);
  background:color-mix(in srgb, currentColor 3%, transparent);
  color:inherit;font:inherit;font-size:13px;line-height:1.6;
}
.rf3-editor textarea:focus-visible{outline:2px solid color-mix(in srgb, currentColor 45%, transparent);outline-offset:1px}
.rf3-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rf3-spacer{flex:1 1 auto}
.rf3-hint{font-size:11px;opacity:.55}

/* 目标选择器（v3）：把宿主给的可编辑块清单列出来，思维链与折叠历史
   也能选中——它们走 seq+blockIndex 寻址，不依赖 DOM 形状。 */
.rf3-targets{display:flex;gap:6px;align-items:center}
.rf3-select{
  flex:1 1 auto;max-width:100%;
  height:24px;padding:0 6px;border-radius:6px;
  border:1px solid color-mix(in srgb, currentColor 20%, transparent);
  background:color-mix(in srgb, currentColor 3%, transparent);
  color:inherit;font:inherit;font-size:11px;
}
.rf3-select:focus-visible{outline:2px solid color-mix(in srgb, currentColor 45%, transparent);outline-offset:1px}
.rf3-select:disabled{opacity:.4}

/* 写入方式（v3.1）：在线/落盘两条路的前提差别太大，交给用户显式选。 */
.rf3-mode{
  flex:0 0 auto;
  height:24px;padding:0 6px;border-radius:6px;
  border:1px solid color-mix(in srgb, currentColor 20%, transparent);
  background:color-mix(in srgb, currentColor 3%, transparent);
  color:inherit;font:inherit;font-size:11px;
}
.rf3-mode:focus-visible{outline:2px solid color-mix(in srgb, currentColor 45%, transparent);outline-offset:1px}

/* 状态行：定位结果与写入结果都走这里。
   v1 的 .rf-primary / .rf-danger 是**类选择器**，而代码设的是 data-* 属性，
   选择器永远匹配不上（死样式）。v2 统一改成属性选择器。 */
.rf3-note{font-size:11px;line-height:1.5}
.rf3-note-ok{color:#4caf7d}
.rf3-note-warn{color:#e0a34a}
.rf3-note-info{color:#6aa9e8}
.rf3-note-hint{opacity:.5;word-break:break-all}

.rf3-btn[data-rf3-primary]{
  border-color:color-mix(in srgb, #4f8cff 55%, transparent);
  background:color-mix(in srgb, #4f8cff 14%, transparent);
  color:inherit;opacity:1;
}
.rf3-btn[data-danger]{opacity:.9}
.rf3-btn[data-danger]:hover{border-color:color-mix(in srgb, #d9534f 60%, transparent);color:#d9534f}
.rf3-btn:disabled{opacity:.3;cursor:not-allowed}
.rf3-btn:disabled:hover{background:transparent}

/* 已定位到落盘记录的块：操作条按钮带一个不易察觉的记号，
   让用户一眼看出「这条能写进记录」，而不是点开才发现写不了。 */
.rf3-btn[data-rf3-linked]::before{
  content:'';width:5px;height:5px;border-radius:50%;
  background:#4caf7d;flex:0 0 auto;
}
`
