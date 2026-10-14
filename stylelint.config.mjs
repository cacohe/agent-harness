/** 采用 Stylelint Standard 规则检查独立的 CSS 资源。 */
export default {
  extends: ['stylelint-config-standard'],
  rules: {
    // 跨组件比较选择器权重会产生误报；同一组件内仍由评审保证规则顺序。
    'no-descending-specificity': null,
    // Web Host 需要兼容较旧的本地浏览器，因此保留已广泛支持的 max-width 语法。
    'media-feature-range-notation': 'prefix',
  },
};
