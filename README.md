# DSHpet

桌宠定制项目的工作区版本基线：包含 dsh-pet 源码、现有运行素材、素材制作工具与项目文档。

## 来源与许可

原作者：**PC2005-cloud**。原项目 GitHub 地址：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。

上游项目采用 MIT License；根目录 `LICENSE` 保留原始许可证全文及 `Copyright (c) 2026 PC2005-cloud` 声明，源码目录中的原始许可证也一并保留。第三方素材与字体如有各自授权，应按其各自授权处理。

## 目录

- `_repo/dsh-pet/`：桌宠 TypeScript 源码、Electron 桌面运行时、素材与测试。
- `_repo/scripts/`：素材处理流水线。
- `_repo/tools/`：视频生成和调试工具。
- `pet-pack/`：自定义宠物配置模板、安装脚本与素材制作工具。
- `启动桌宠.cmd`：现有本机启动入口。
- `AGENTS.md`：协作要求、版本管理规则及每轮修改记录。
- `PROGRESS.md`、`README-交接.md`、`制作自己的桌宠-实现指南.md`：已有项目资料。

## 版本管理

本仓库在项目根目录统一管理源码、工具与文档。实验截图、处理中的视频、备份、本机工具、依赖、构建输出及密钥不提交；忽略规则不会删除本地文件。`_repo/.gitignore` 继续负责源码子目录内的生成物筛选。

源码来自 `https://github.com/PC2005-cloud/dsh-pet`，本地导入基点为 `15e59d2a42fa0d674720dd813480bc7aea786e86`，导入时保留现有本地修改及原作者许可证。上游原始 Git 元数据保存在本机 `_backup/upstream-git-20261023/`，不上传。后续统一在本仓库提交，避免嵌套仓库只记录引用而遗漏源码。

每轮修改都应同步更新 `AGENTS.md`，验证后提交；功能开发使用独立分支。

## 现有入口与开发检查

`启动桌宠.cmd` 启动的是用户目录下已安装的插件。克隆本仓库不会自动恢复该安装及其用户配置；源码与实际安装内容需要分别核对。

源码包目录为 `_repo/dsh-pet/`，当前包版本为 `0.3.7`，声明 Node.js `>=22.12.0`。现有检查入口：

```powershell
Set-Location _repo/dsh-pet
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run lint
```

构建入口为 `pnpm run build`。首次版本整理仅建立文件基线；是否可构建、运行及素材是否与已安装桌宠一致，需另行验证。
