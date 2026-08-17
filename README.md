# dsh-image-preview

本地图床插件：让会话里的聊天能**内嵌显示图片**。

## 功能

- 在 web profile 自带的 HTTP 服务（`ctx.webServer`，同源 127.0.0.1:3080）上注册 `/preview/*` 路由，静态托管一个预览目录（默认 `~/.dsh/preview`）里的图片。同源 URL（`http://127.0.0.1:3080/preview/<name>`）在聊天里可直接渲染，无混合内容/CORS 问题。
- 注册模型工具 `preview_image(file_path)`：把已存在的本地图片复制进预览目录（已在目录内则直接引用），返回可内嵌的 URL。AI 截图/下载图片后，调它即可把图贴进会话。

## 安装

```powershell
# 本地路径
dsh plugin --profile web add ./plugins/dsh-image-preview

# 或从 GitHub 安装
dsh plugin --profile web add "github:ReiRui/dsh-image-preview#main"
```

安装后**重启 web profile** 生效。

## 配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里覆盖该行的 `config`：

```yaml
- id: image-preview
  config:
    root: !!js dshHomePath('preview')   # 预览目录，可改成项目目录
    prefix: /preview                    # URL 前缀
```

## 使用

1. 让 AI 生成/下载一张图（截图、渲染预览等）到本地；
2. AI 调用 `preview_image` 工具传入绝对路径；
3. 工具返回 `http://127.0.0.1:3080/preview/<name>`，AI 在回复里贴该链接；
4. 页面内联显示图片。

也可以直接访问 `http://127.0.0.1:3080/preview/<name>` 查看。

## AI 使用提示（给 agent 的约定）

- **必须调用 `preview_image` 工具**，禁止手动把文件复制进 `~/.dsh/preview`：新会话的文件沙箱默认是 `workspace-write`，AI 的文件工具写不进预览目录（会报"目录出错"）。工具内部不受该沙箱限制。
- 工具返回的 `url` 字段是**唯一有效**的 URL，AI 应原样内嵌（`![alt](url)`），不要自行拼接或猜文件名。
- 通过工具复制的文件名为 `8位随机-原名`（如 `7faf2295-theme-gallery.png`），这是与手动复制区分的特征。
- 工具返回 `ok:false` 时，把 `error` 原样报告给用户（文件不存在 / 类型不支持等）。

## 安全（自审声明）

- **零依赖、零安装期脚本**：只依赖 node 内置模块和 `ctx`；不联网、不读凭据、不起子进程、无 eval。
- **路径隔离**：所有响应都经 `realpath` 校验必须位于配置根目录内；拒绝 `..`、反斜杠、NUL。
- **类型白名单**：仅 png / jpg / jpeg / webp / gif / avif / bmp，其他扩展名返回 415。
- **无目录列表**；未知路径 404。
- 工具只复制**显式传入**的文件，不会暴露预览目录以外的任意路径。

## 已知限制

- URL 固定用 `127.0.0.1`；局域网访问需自行替换为本机 IP（并确保 web 服务绑定 0.0.0.0，如 `dsh-lan-access` 插件）。
- 预览目录内的文件不设清理策略，长期使用请定期手动清理。
