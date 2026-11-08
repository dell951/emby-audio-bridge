# Emby Audio Bridge

Chrome 扩展，为 Emby 网页中无法原生播放的 AC3/EAC3 音轨提供本地解码。保留 Emby 的视频、字幕和播放控件。

## 使用

1. 下载或克隆仓库。
2. 打开 `chrome://extensions`，开启开发者模式。
3. 选择“加载未打包的扩展程序”，选择仓库目录。
4. 停用旧的 AbsolutePlayer，刷新 Emby 网页。

当前版本仅匹配 manifest.json 中指定的 Emby 站点。更换站点时，需要同时修改 manifest.json 的站点配置和 src/audio.js 中的 SITE。

## 播放行为

- 在浏览器本地通过 FFmpeg WASM 解码音频，无需服务器转码权限。
- 目标向前缓存约 30 秒，保留最近 3 分钟的已解码音频；PCM 缓存上限 96 MiB。
- 缓存内跳转复用音频；缓存外跳转重新读取。
- 同步优先：音频不足时暂停视频，准备好约 6 秒音频后恢复。
- AAC 等原生支持的音频在格式探测后退出补声流程。

## 限制

实验版本，仅支持指定站点的同源 MKV 直播放源及 HTTP Range。当前仅使用第一条音轨，不保证跟随多音轨切换。网络较慢时会暂停等待；尚未完成整部影片的稳定性和主观口型同步验收。字幕仍由 Emby 处理。

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
