# Emby Audio Bridge

Chrome 扩展，为 Emby 网页中无法原生播放的 AC3/EAC3/DTS 音轨提供本地解码。保留 Emby 的视频、字幕和播放控件。

当前版本：0.5.4。

## 使用

1. 下载或克隆仓库。
2. 打开 `chrome://extensions`，开启开发者模式。
3. 选择“加载未打包的扩展程序”，选择仓库目录。
4. 停用旧的 AbsolutePlayer，刷新 Emby 网页。

首次使用或添加服务器时，在 `chrome://extensions` 中打开本扩展的“扩展程序选项”，填写 Emby 地址并授予该站点访问权限。扩展只会在已添加并授权的服务器运行，不需要修改 manifest.json，也不会申请访问所有网站。扩展会自动处理地址中的端口和路径，并按域名匹配。

同一设置页的环境检测会验证扩展内 FFmpeg JS/WASM 文件可读、FFmpeg 解码 Worker 能初始化、已配置的 Emby 站点权限和浏览器 AudioContext。FFmpeg 已随扩展打包，不需要在 macOS 另行安装。添加服务器或检测通过后刷新 Emby 播放页。

设置页可调整向前缓存（默认 30 秒，10–120 秒）、已播放音频保留时间（默认 180 秒，0–600 秒）和 PCM 缓存上限（默认 96 MiB，32–512 MiB），并说明了各项取舍。较大的缓存能减少等待或回退时的重新读取，但会占用更多内存；内存上限可能使实际保留时长低于设置值。

目前处理已配置 Emby 站点的播放页，仅支持同源 MKV 直播放源。

## 播放行为

- 在浏览器本地通过 FFmpeg WASM 解码音频，无需服务器转码权限。
- 默认目标向前缓存约 30 秒，保留最近 3 分钟的已解码音频；默认 PCM 缓存上限 96 MiB。可在扩展选项中调整。
- 缓存内跳转复用音频；缓存外跳转重新读取。
- 同步优先：音频不足时暂停视频，准备好约 6 秒音频后恢复。
- AAC 等原生支持的音频在格式探测后退出补声流程。

## 限制

实验版本，仅支持已授权站点的同源 MKV 直播放源及 HTTP Range。站点权限按协议和主机名申请；Chrome 的主机匹配不区分端口，包含该主机同协议下的所有端口。当前仅使用第一条音轨，不保证跟随多音轨切换。网络较慢时会暂停等待；尚未完成整部影片的稳定性和主观口型同步验收。字幕仍由 Emby 处理。

## 开发

需要 Node.js 18+，无需安装 npm 依赖或构建。

```sh
npm test
npm run check
```

`src/` 存放扩展代码，`tests/` 存放回归测试，`vendor/core/` 存放现成的 FFmpeg WASM 解码库。开发验证记录见 docs/development-notes.md。

## 第三方代码

Range 读取 worker 改编自 [AbsolutePlayer](https://github.com/hiburn8/AbsolutePlayer)，GPL-3.0 许可证保留在 LICENSE 和 vendor/AbsolutePlayer-LICENSE。FFmpeg WASM 文件沿用现有本地包；公开分发前仍需核实其构建来源与对应源码义务。

不要提交服务器登录令牌、浏览器配置或媒体文件。

DTS-HD MA 使用 FFmpeg 的 DTS 解码路径，输出为 48 kHz 立体声，与现有补声格式一致；未承诺无损或 5.1 原样输出。
