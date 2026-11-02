/**
 * 快捷键绑定的实现已经搬到 `shared/shortcuts/binding.ts`——主进程在
 * `before-input-event` 里也要判断「这次按键是不是保存」，两边必须用同一套
 * 解析与匹配，否则用户一改键，iframe 里就按不动了。
 *
 * 这里保留一层转发，让渲染层的引用路径（`../../shortcuts/binding`）保持不变。
 * 新代码直接引 `shared/shortcuts/binding` 也可以，两者是同一个模块的导出。
 */
export * from '../../shared/shortcuts/binding'
