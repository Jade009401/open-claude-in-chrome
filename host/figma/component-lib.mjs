// exchange-web-nuxt(交易所主站)组件库描述符 —— 供 /figma 的 buildDevPrompt 注入,
// 让生成的提示词映射到主站真实组件(而非通用 HTML)。
// 依据:实读 src/plugins/components.js(全局注册)+ src/components/common 目录 + 子 agent 勘探。
export const exchangeWebNuxt = {
  repo: 'exchange-web-nuxt',
  location: 'exchange-web-nuxt(主站):全局组件见 src/plugins/components.js;按需组件在 src/components/common/*;页面放 src/pages/<name>/index.vue(Nuxt 目录即路由)',
  importConvention: '全局注册组件直接写标签免 import;其余 `import X from "components/common/xxx"`(别名 components→src/components,api→src/data/api)',
  components: [
    { name: '<page-container>', usage: '页面外层容器(title 等),活动页统一用它包裹' },
    { name: '<Button>', usage: '按钮:type=filled/outlined/primary/cancel,size=small/medium/large/giant,block/loading/disabled' },
    { name: '<btn-once>', usage: '带防抖按钮,防重复提交' },
    { name: '<Input>', usage: '输入框:clearable/showPassword,prepend/append/prefix/suffix 插槽' },
    { name: '<Form>/<FormItem>', usage: '表单' },
    { name: '<Modal>', usage: '弹窗' },
    { name: '<Overlay>', usage: '遮罩层' },
    { name: '<Space>', usage: '间距布局' },
    { name: '<SvgIcon>', usage: '图标' },
    { name: '<Scrollbar>', usage: '滚动容器' },
    { name: '<loading>/<my-loading>', usage: '加载态' },
    { name: '<no-result>', usage: '空状态' },
    { name: '<Link>/<CommonLink>', usage: '链接' },
    { name: '<img-tag>', usage: '图片(带占位/懒加载)' },
    { name: 'common/tabs·tab-pane', usage: '标签页(按需 import)' },
    { name: 'common/steps', usage: '步骤条(按需 import)' },
    { name: 'common/table·table-column / pagination', usage: '表格 + 分页(按需 import)' },
    { name: 'common/date-picker·mobile-date-picker / select / checkbox / slider / upload / popover / tooltip / count-to / CoinPair / ActivityEntry', usage: '其余按需 import components/common/xxx' },
  ],
};

export const stackText = 'exchange-web-nuxt:Nuxt 2.18 + Vue 2.7(Options API 为主)+ element-ui 2.15;自研 Bc* 组件(CSS 前缀 bc-);样式 SCSS + rem(移动端 rem 缩放);状态 Vuex(src/store);请求 src/utils/axios/*;国际化 @nuxtjs/i18n,文案走 $t()(src/locale)。参考现成活动页:src/pages/oil-activity/index.vue、src/pages/activity/_id/index.vue。';
