# Changelog

## [0.2.8-0](https://github.com/junjie73-blip/sync-upstream/compare/v0.2.7...v0.2.8-0) (2026-10-05)

### 🐛 Bug Fixes | Bug 修复

* 🐛 修复功能 ([6a5df0c](https://github.com/junjie73-blip/sync-upstream/commit/6a5df0cbfa9ce7a7fa168cfa6b68b3ce70a310f8))

## [0.2.7](https://github.com/flow-zy/sync-upstream/compare/v0.2.6...v0.2.7) (2025-08-18)

### ✨ Features | 新功能

* 优化缓存系统和同步流程 ([47536bb](https://github.com/flow-zy/sync-upstream/commit/47536bbb574b51a0a3adcc740c961d5f1905256a))
* **conflict:** 扩展冲突类型和解决策略，优化冲突检测逻辑 ([ebb652d](https://github.com/flow-zy/sync-upstream/commit/ebb652dbcfc28aa2b1af1e49a7e4defcf9a4f18e))

## [0.2.6](https://github.com/flow-zy/sync-upstream/compare/v0.2.5...v0.2.6) (2025-08-17)

### ✨ Features | 新功能

* **cache:** 添加缓存压缩和预热功能 ([d4c0876](https://github.com/flow-zy/sync-upstream/commit/d4c08761f851976e789d4fd596c1cd8f8a86edf9))
* **cache:** 增加基于内容类型的缓存过期时间和键前缀支持 ([bc14bf3](https://github.com/flow-zy/sync-upstream/commit/bc14bf366234d807239cf7adbca3e5cd781361fb))
* **webhook:** 增强webhook功能并添加安全配置 ([6b0ef87](https://github.com/flow-zy/sync-upstream/commit/6b0ef87c22d00e292ded9c165bcd0e2c04d89f7e))

## [0.2.5](https://github.com/flow-zy/sync-upstream/compare/v0.2.4...v0.2.5) (2025-08-16)

### ✨ Features | 新功能

* 新增高级缓存系统并优化性能 ([3a97c01](https://github.com/flow-zy/sync-upstream/commit/3a97c0163292d4403dd0c78f0461ceb217cb87dd))

## [0.2.5](https://github.com/flow-zy/sync-upstream/compare/v0.2.4...v0.2.5) (2025-08-17)

### ✨ Features | 新功能

* **webhook:** 增强Webhook功能，支持多平台签名验证和事件历史记录 ([#123](https://github.com/flow-zy/sync-upstream/pull/123))
* **conflict:** 改进冲突解决机制，实现智能合并算法和差异预览 ([#124](https://github.com/flow-zy/sync-upstream/pull/124))

### 🛠 Improvements | 改进

* **webhook:** 优化Webhook请求处理逻辑和错误处理 ([#123](https://github.com/flow-zy/sync-upstream/pull/123))
* **conflict:** 完善冲突解决日志记录和用户交互体验 ([#124](https://github.com/flow-zy/sync-upstream/pull/124))

### ♻ Code Refactoring | 代码重构

* **webhook:** 重构Webhook相关代码，提高可维护性 ([#123](https://github.com/flow-zy/sync-upstream/pull/123))
* **conflict:** 优化冲突检测和解决流程 ([#124](https://github.com/flow-zy/sync-upstream/pull/124))

## [0.2.4](https://github.com/flow-zy/sync-upstream/compare/v0.2.3...v0.2.4) (2025-08-16)

### ✨ Features | 新功能

* **config:** 添加对JSON5配置文件格式的支持 ([8f3399b](https://github.com/flow-zy/sync-upstream/commit/8f3399b8ada952f3badaab02185738341cbb575e))
* **webhook:** 实现Webhook集成功能并添加分支策略支持 ([e7f4076](https://github.com/flow-zy/sync-upstream/commit/e7f40763fd4a534bacbd401d9cabb85cb9f441f9))

## [0.2.3](https://github.com/flow-zy/sync-upstream/compare/v0.2.1...v0.2.3) (2025-08-15)

### ✨ Features | 新功能

* **灰度发布:** 实现灰度发布功能及相关文档更新 ([50cadfc](https://github.com/flow-zy/sync-upstream/commit/50cadfcd5fc0218cf3c70aaac1cd04aec7408adb))
* 添加灰度发布功能支持 ([ded4737](https://github.com/flow-zy/sync-upstream/commit/ded4737a0e8032ff8681cb288b0e0f3a0e82811b))
* **同步配置:** 添加全量发布、回滚和未知参数处理功能 ([86fabf8](https://github.com/flow-zy/sync-upstream/commit/86fabf85c85fa385778c8f1c74cc8ac87fca1e8a))

### 🎫 Chores | 其他更新

* 在.gitignore中添加.sync-temp和.sync-cache ([65459df](https://github.com/flow-zy/sync-upstream/commit/65459dffa55e69a692974b1c72705ecd09e4fdd0))
* **release:** 0.2.2 ([06a0c3c](https://github.com/flow-zy/sync-upstream/commit/06a0c3cf61185198586dbdbbc3d5e77473447968))

### 📝 Documentation | 文档

* 添加详细功能说明文档 FEATURES_DETAILED.md ([9c5a0ff](https://github.com/flow-zy/sync-upstream/commit/9c5a0ff92821283934d081c85a5c56580582e562))

### 💄 Styles | 风格

* 优化导入顺序并更新package.json元数据 ([f6ee7fa](https://github.com/flow-zy/sync-upstream/commit/f6ee7fa7aa36a81245dafd38dcd612ecbd5ab6e9))

### ♻ Code Refactoring | 代码重构

* 清理未使用的灰度发布相关代码并优化配置 ([5398ea8](https://github.com/flow-zy/sync-upstream/commit/5398ea88299a6335b3f725246ddfb6e772e29634))
* **gray-release:** 重构灰度发布相关代码并修复类型定义 ([3e2dc2b](https://github.com/flow-zy/sync-upstream/commit/3e2dc2b9ebe82d749ca6907247cf4d9a5925b4e1))

## [0.2.2](https://github.com/flow-zy/sync-upstream/compare/v0.2.1...v0.2.2) (2025-08-15)

### ✨ Features | 新功能

* 添加灰度发布功能支持 ([ded4737](https://github.com/flow-zy/sync-upstream/commit/ded4737a0e8032ff8681cb288b0e0f3a0e82811b))

### 💄 Styles | 风格

* 优化导入顺序并更新package.json元数据 ([f6ee7fa](https://github.com/flow-zy/sync-upstream/commit/f6ee7fa7aa36a81245dafd38dcd612ecbd5ab6e9))

## [0.2.1](https://github.com/flow-zy/sync-upstream/compare/v0.2.0...v0.2.1) (2025-08-14)

### 📝 Documentation | 文档

* 更新文档结构和配置参考 ([4258b57](https://github.com/flow-zy/sync-upstream/commit/4258b57b421f4d514e181fd7b38637f7491dc46c))

### 💄 Styles | 风格

* **cli:** 调整控制台输出颜色和格式 ([d6b26d3](https://github.com/flow-zy/sync-upstream/commit/d6b26d34af2c4350b0fb7083d2bfaa7f7d34f58f))
* **cli:** 为帮助信息添加颜色增强可读性 ([34f1071](https://github.com/flow-zy/sync-upstream/commit/34f1071c6d3440eed35d0d70490bef8f6d4786aa))

### ♻ Code Refactoring | 代码重构

* 优化构建配置和依赖管理 ([53bd0dd](https://github.com/flow-zy/sync-upstream/commit/53bd0dd86d643c6af8be1a0665f9e794700a03aa))

# [0.2.0](https://github.com/flow-zy/sync-upstream/compare/v0.1.0...v0.2.0) (2025-08-13)


### Bug Fixes

* **cli:** 修复非交互式模式下的参数处理逻辑 ([8af409c](https://github.com/flow-zy/sync-upstream/commit/8af409cd7b216d8192ef6ef23a766df6b947d4c0))


### Features

* 添加大文件处理和本地缓存功能 ([c4bab49](https://github.com/flow-zy/sync-upstream/commit/c4bab4938c6c93fc781fae7e2bc1a97c82bea9a3))
* **types:** 为 SyncOptions 添加大文件和缓存相关配置 ([ad88378](https://github.com/flow-zy/sync-upstream/commit/ad88378f1ab47190178a23ea572d813b9a860ee2))

# [0.1.0](https://github.com/flow-zy/sync-upstream/compare/v0.0.2...v0.1.0) (2025-08-13)


### Features

* 添加并行处理、认证支持和预览模式功能 ([eeae672](https://github.com/flow-zy/sync-upstream/commit/eeae672bbc5fab069cffe237e64e1e9886a4b250))
* 添加非交互式模式支持并迁移至tsup构建工具 ([863fa12](https://github.com/flow-zy/sync-upstream/commit/863fa12ef98e2b65be9d57e02e83c729ee387dd3))
* **docs:** 添加完整的文档结构和内容 ([092207d](https://github.com/flow-zy/sync-upstream/commit/092207dc4a090efdccdafcd6c1a6b49e7a94eb36))
