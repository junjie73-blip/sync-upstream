import antfu from '@antfu/eslint-config'

export default antfu({
  rules: {
    // 测试标题以被测量的标识符（SyncOrchestrator / USE_SOURCE / BOM …）开头，小写化会破坏可读性
    'test/prefer-lowercase-title': 'off',
  },
})
