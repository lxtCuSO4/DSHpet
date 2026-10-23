# DSHpet(自用存档)

可自定义角色与动画的桌宠项目，包含 TypeScript 源码、Electron 透明桌面窗口、原项目动画素材，以及素材制作和配置工具。

支持从源码独立运行，也可作为 DeepSeek Harness（DSH）插件使用。本仓库在现有项目基础上维护桌面动画换层修复、诊断工具和使用文档，所有内容统一保存在 `main` 主分支。

**[完整使用说明](本仓库使用说明.md)** · **[自定义角色指南](制作自己的桌宠-实现指南.md)** · **[素材工具说明](pet-pack/README.md)**

## 功能特性

- **桌面互动**：透明置顶窗口，支持待机动画、点击反馈、拖拽和右键菜单。
- **自定义角色**：通过本地配置与透明 WebM 动画添加宠物，无需修改播放器代码。
- **多宠物配置**：可分别设置宠物名称、大小、位置和显示方式。
- **桌宠管理页**：预览全部角色、独立开关、大小调整、位置记忆与找回；全部关闭后仍能从托盘打开。
- **全屏避让**：默认智能模式，Windows 全屏时暂时隐藏对应屏幕的桌宠；也可切换普通窗口或始终置顶。
- **两种运行方式**：独立桌面模式，或在 DSH 中使用浏览器浮层与桌面模式。
- **素材制作工具**：提供绿幕处理、透明视频转码、边缘清理和配置校验脚本。
- **桌面换层修复**：使用 visibility 控制视频层显隐，处理本机 Windows 环境中待机循环边界短暂消失的问题。

## 快速开始

以下步骤面向 Windows PowerShell，使用本仓库源码启动独立桌宠。

### 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | `>=22.12.0`，以源码包声明为准 |
| 包管理器 | pnpm；仓库提供 `pnpm-lock.yaml` |
| 版本管理 | Git |
| 网络 | 用于下载项目依赖和首次运行所需的 Electron |
| 素材制作依赖 | 仅制作素材时需要 Python、相关 Python 库及 FFmpeg |

仓库当前为私有，克隆前需要获得访问权限并完成 GitHub 身份验证。

### 安装与构建

```powershell
git clone --branch main https://github.com/lxtCuSO4/DSHpet.git
Set-Location .\DSHpet\_repo\dsh-pet
pnpm install --frozen-lockfile
pnpm run build
```

逐条执行，前一步成功后再继续。源码包当前版本为 `0.3.7`；构建产物不随 Git 上传，需要在本地生成。

### 检查与启动

在同一个终端、同一个源码包目录中执行：

```powershell
$env:DSH_HOME = Join-Path $env:LOCALAPPDATA 'DSHpet-demo'
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
node lib/standalone.js --check
pnpm run standalone
```

这里使用单独的数据目录。`--check` 只检查环境与配置；正式启动时如缺少 Electron，会尝试下载到该数据目录的 `electron/` 下。启动后保持终端运行，退出时按 `Ctrl+C`。

`DSH_HOME` 只对当前终端及其子进程生效；新开终端时需重新设置相同值。未设置时，程序使用当前用户的 `~/.dsh`，其中可能已有 DSH 配置。

根目录的 `启动桌宠.cmd` 调用用户目录下已安装的插件，不会启动当前克隆目录里的源码。首次使用请按上述命令操作；DSH 插件安装、端口设置和排错步骤见 [完整使用说明](本仓库使用说明.md)。本次文档整理未在全新环境重新验证完整安装与启动流程。

## 自定义角色与素材

仓库包含原项目自带动画，**不包含维护者的个人动画及实际个人配置**。初次运行可使用原项目角色；要使用自己的角色，需要另外准备透明视频和对应配置。

文件宠物的目录结构如下，`cat` 为示例种类名：

```text
<DSH_HOME>/dsh-pet/pet/
├── cat-config.json
└── cat-animation/
    ├── 待机呼吸.webm
    ├── 点击回应.webm
    └── 被抓起悬空.webm
```

配置中的动画名必须与文件名一致，WebM 直接放在种类素材目录中。素材保存在使用者本地即可，无需上传到 GitHub。

创建模板、放置素材、校验配置和启用显示的完整步骤见 [本仓库使用说明](本仓库使用说明.md)；需要从绿幕视频制作透明动画时，参阅 [pet-pack 工具说明](pet-pack/README.md)。

## 项目结构

```text
DSHpet/
├── _repo/
│   ├── dsh-pet/                 # 桌宠源码包、Electron 运行时、素材与测试
│   ├── scripts/                 # 素材处理流水线
│   └── tools/                   # 原项目开发与视频工具
├── pet-pack/                    # 自定义宠物模板、安装和素材制作工具
├── tools/                       # 本仓库修复部署与诊断工具
├── docs/diagnostics/            # 闪帧调查、修复报告及筛选后的数值
├── 本仓库使用说明.md            # 安装、启动、配置与常见问题
├── 制作自己的桌宠-实现指南.md    # 角色制作资料
├── AGENTS.md                    # 协作规则与每轮修改记录
├── README.md
└── LICENSE
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [本仓库使用说明](本仓库使用说明.md) | 环境准备、源码启动、自定义素材、DSH 使用和更新方法 |
| [素材工具说明](pet-pack/README.md) | 素材处理脚本、配置模板及制作流程 |
| [桌宠管理说明](docs/desktop-manager.md) | 设置入口、独立开关、全屏避让、快捷键与安装补丁维护 |
| [制作自己的桌宠](制作自己的桌宠-实现指南.md) | 自定义角色与动画的实现资料 |
| [插件使用说明](_repo/dsh-pet/README.md) | 原有插件功能、DSH 集成和高级配置 |
| [桌面换层修复报告](docs/diagnostics/2026-10-23-idle-visibility-fix.md) | 修复方法、部署工具、回归结果与验证边界 |
| [协作与修改记录](AGENTS.md) | 版本管理约定和各轮实际验证记录 |

`PROGRESS.md` 保留了早期项目背景，其中的问题状态与方案可能已过时；当前使用方法以本仓库使用说明为准，修复结论以诊断报告和后续修改记录为准。

## 开发与验证

在 `_repo/dsh-pet/` 中安装依赖后，可运行：

```powershell
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run build
```

在仓库根目录，可运行本仓库的视频样式补丁测试：

```powershell
node --test tools/diagnostics/video-visibility-patch.test.mjs
```

以上为检查入口，不代表当前环境已经执行过全部检查。实际验证结果记录在 [AGENTS.md](AGENTS.md) 和对应报告中。

### 修复验证范围

桌面换层修复已在维护者的 Windows 环境进行对照实验与回归验证。修复后的常用实例连续两分钟监测覆盖 12 次自然待机换层，未捕获闪帧或发灰；该有限观测不代表所有平台和素材均已验证。

源码目录与 DSH 已安装插件目录可能存在内容差异，即使版本号相同也应分别核对。插件更新可能覆盖安装补丁，维护方法见 [修复报告](docs/diagnostics/2026-10-23-idle-visibility-fix.md)。

## 参与维护

修改前请阅读 [AGENTS.md](AGENTS.md)。每轮修改需记录目标、改动和实际验证结果，检查提交范围后再提交。

仓库当前仅保留 `main`。后续如使用临时开发分支，应在验证并合并后清理，保留完整提交历史。依赖缓存、构建产物、个人配置、密钥、实验录屏和本地备份不提交，具体规则见 [.gitignore](.gitignore)。

## 来源与许可

本项目基于 **PC2005-cloud** 的 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。源码导入基点为 `15e59d2a42fa0d674720dd813480bc7aea786e86`，导入时保留已有本地修改及原作者版权声明。

- **代码**：保留原项目 [MIT License](LICENSE) 及 `Copyright (c) 2026 PC2005-cloud` 声明。
- **原项目素材**：原项目文档对动画、提示词和源视频注明“允许开源使用，禁止商用”，详见 [原项目许可说明](_repo/README.md#许可)。
- **衍生作品**：原项目要求在介绍、展示和分发衍生作品时附上原作者 GitHub 地址：<https://github.com/PC2005-cloud/dsh-pet>。
- **其他素材与字体**：遵守各自授权；自行引入的角色和素材也应确认相应使用权限。
