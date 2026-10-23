# 2026-10-23：待机闪帧修复与部署

## 修复范围

承接前一轮的 opacity / visibility A/B/A 证据，本轮将桌面视频显隐正式改为
`visibility:hidden/visible`，两层 opacity 恒为 1，transition 为 none。
`is-front` 仍决定活动层；视频加载、双缓冲、ended、随机链及交互逻辑保持原样。
不添加淡化、混帧或素材重编码。

源码修改在 `_repo/dsh-pet/runtime/electron-helper/index.html`；sprite.js 仅同步注释。
安装包与源码内容不同，部署工具只替换安装 index.html 内两条主要视频规则，
保留 reduced-motion 规则及其他所有内容。不会整目录覆盖或替换已安装 sprite.js。

## 验证

先在未改动安装 helper 上运行新增回归，得到预期失败：非活动视频的 visibility 仍为 visible。
修复候选来自安装 helper 的本地副本，仅应用本轮正式补丁；没有注入实验 `!important` 样式。

- 浏览器实际计算样式：活动视频 visible、后台视频 hidden，opacity 均为 1，无过渡。
- 实际点击动画与媒体 EOF 回待机；DOM pointer 事件触发拖拽及松手。
- 随机链转向与 EOF 翻面；菜单点播移动、实际启动 moveRef 驱动和 EOF。
- 工作状态单候选原生 loop、多候选 EOF 轮换。
- 快速连续六次请求后最终请求成功播放。
- 不存在素材失败释放 pending；有效素材可恢复播放。
- bridge 不回复一条素材请求，实际等待 10 秒加载保护释放 pending，随后可恢复播放。
- 补丁工具四项测试：幂等、仅两条规则改变、保留其他样式、拒绝缺失/重复规则和意外效果。

用户素材没有转向/移动配置，工作状态功能未开启；对应回归只在一次性实例内，
将已有点击素材挂入临时转向、移动和工作状态池，未修改用户磁盘配置。
拖拽回归通过 DOM 派发 pointer 事件，未验证真实鼠标捕获和拖拽手感。
第一次 EOF 测试的 5 秒等待超时，改为与加载等待一致的 15 秒；扩展移动测试最初继承了
拖拽后的 customPos，调整隔离实例的中心位置后通过。菜单扩展回归还会等待移动驱动实际就绪，
避免在 pendingMove 仍存在时提前断言。最终十项回归已在修改后的实际安装 helper 再跑通过；
超时测试将旧视频临时设为原生 loop，避免把旧片 EOF 的后续请求误当成 10 秒保护生效。
以上均未修改应用行为来迁就测试。

### 候选版本的最终桌面

使用正式补丁后的 helper 副本、真实 bridge 媒体路径、软件合成、size 420、scale 1.5，
探针 245 秒、DDA 屏幕录制约 242 秒，覆盖 24 次自然待机换层。
逐帧比对 14,519 个桌面样本，未捕获循环边界角色消失；内部 5,874 个合成样本零 alpha 为 0。

只有开头 2.050～2.167、2.567～2.667 秒共 16 个高残差样本，回看为绿色鼠标指针经过
人物头部，人物仍可见，独立于约 10 秒一次的循环边界；不计为循环故障。
3 秒后最大主体不透明像素 RMSE 为 4.8317/255，候选阈值为 10/255。
使用录屏真实 PTS，不将帧序号除以 60。

## 本机部署

已备份原安装 index.html 到 `_backup/idle-video-visibility-20261023/index.html`，
并用工具写入正式补丁。通过已经验证的本机 inspector 路径，将磁盘上的两条规则同步到
当前窗口 CSSOM。读取计算样式核对成功，没有留下额外 style 节点或播放包装器。
为核对从磁盘完整加载的状态，随后重载了一次渲染页面；主进程 PID 27980 与 14:07:36 启动时间不变。
页面重载会把会话内拖拽位置恢复为配置位置。后续启动从已修改的磁盘文件读取相同样式。

原实例的一轮 80 秒内部观测覆盖 8 次换层，所记录 RAF 的两层 opacity/visibility 均与活动层一致；
观察器已清理。其桌面采集未计入通过证据：第一次固定 ROI 遇到用户拖拽，随后一次固定采集没有角色；
后续 Win32 前台检查发现窗口标题为“Windows 默认锁屏界面”。不能根据高基线 RMSE、无候选离群点
就宣称角色无闪帧，也不能将锁屏抓屏缺少角色归因于本轮修复。
本轮实际桌面通过证据来自此前未锁屏时的 24 次独立实例自然换层。

| 文件 | 部署后 SHA-256 |
| --- | --- |
| 安装 index.html | `c8e1cb94d7f34260753e9d40aacd4ecdeea8b2272d8483c75bbc80f099a03ce4` |
| 安装 sprite.js，未修改 | `c26741a10277ad741587f933eaea692a7b8bffa2c65357a255569c39ac48ad19` |
| 待机素材，未修改 | `15492586f8a5b24dae49b4a04a2dc70444999af5d7af937b9ef57894c8a55838` |

安装 index.html 原 SHA-256 为 `b92ce49ac60c2be20d738e6acdb035a955eff837ff18fa9f847b168eb9ee7bdb`。
部署备份与完整原始测试记录位于忽略目录，不推送私人配置或桌面录制。

## 维护与限制

部署命令必须明确传入安装 index.html 与一个尚不存在的备份文件路径：

```powershell
node tools/apply-desktop-video-visibility.mjs 'C:/Users/27913/.dsh/profiles/desktop/node_modules/dsh-pet/runtime/electron-helper/index.html' '_backup/idle-video-visibility-20261023/index.html'
node tools/apply-running-video-visibility.mjs 27980 --reload
```

第二条只适用于确认后的当前 PID；`--reload` 会重载渲染页面并恢复配置位置。
省略该选项只更新内存两条规则。此工具核对进程身份，并在计算样式校验失败时还原内存规则。
更新插件可能覆盖安装补丁，更新后应重新核对差异与规则，不能将旧版本整文件复制回新版。
需要回退时先核对当前哈希与备份，恢复原 index.html，再由原宿主重载桌宠使内存样式一致。

本轮没有构建或运行全项目测试：变更是直接加载的桌面 HTML 样式，已执行定向浏览器、
补丁工具和最终桌面验证。有限录制不能保证所有系统、所有动画或无限期运行均无闪帧。
尚未定位 Chromium/Electron/Windows 中的具体底层函数。
筛选后的数值记录见 `2026-10-23-idle-visibility-fix-measurements.json`。
