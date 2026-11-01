# 打包字体

界面用的 Odyssey Paper 字体，都来自 [google/fonts](https://github.com/google/fonts)，SIL Open Font License 1.1（见同目录 `OFL-*.txt`）。

| 文件 | 来源 | 用在 |
| --- | --- | --- |
| `Alegreya-wght.woff2` | `ofl/alegreya/Alegreya[wght].ttf` | 西文单词、音标、例句；小型大写走它自带的 `smcp` |
| `Alegreya-Italic-wght.woff2` | `ofl/alegreya/Alegreya-Italic[wght].ttf` | 西文斜体 |
| `ZCOOLXiaoWei-subset.woff2` | `ofl/zcoolxiaowei/ZCOOLXiaoWei-Regular.ttf` | 中文标题和编号 |

中文正文（Noto Serif SC）太大，不打包，用系统宋体。

## 裁剪

Alegreya 只留拉丁字母、IPA 和常用标点；ZCOOL XiaoWei 只留界面标题用到的字（原文件 6.3 MB）。
**改了用 `--display-zh` / `--lct-display-zh` 显示的文字，要把新字加进下面的 `ZH_TEXT` 重新生成**，否则缺的字会落到系统宋体。

```bash
ZH_TEXT='划词翻译默认配置站点配置生词本连接与快捷键壹贰叁肆一二三四翻译暂时失败'
LATIN='U+0000-00FF,U+0100-017F,U+0131,U+0152-0153,U+0250-02FF,U+0300-036F,U+1D00-1DBF,U+2000-206F,U+2070-209F,U+20AC,U+2122,U+2190-2193,U+2212,U+2215,U+FEFF,U+FFFD'
python3 -m fontTools.subset ZCOOLXiaoWei-Regular.ttf --text="$ZH_TEXT" --unicodes='U+0020' --flavor=woff2 --output-file=fonts/ZCOOLXiaoWei-subset.woff2
python3 -m fontTools.subset 'Alegreya[wght].ttf' --unicodes="$LATIN" --layout-features='*' --flavor=woff2 --output-file=fonts/Alegreya-wght.woff2
python3 -m fontTools.subset 'Alegreya-Italic[wght].ttf' --unicodes="$LATIN" --layout-features='*' --flavor=woff2 --output-file=fonts/Alegreya-Italic-wght.woff2
```

需要 `fonttools` 和 `brotli`（`pip install fonttools brotli`）。

## 怎么加载

- popup / 设置页：`paper.css` 里的 `@font-face`。
- 网页上的划词面板：Shadow DOM 里的 `@font-face` 不生效，由 `content-panel.js` 第一次弹面板时 fetch 字体字节、用 `FontFace` 注册到 `document.fonts`。所以 `manifest.json` 的 `web_accessible_resources` 要包含 `fonts/*.woff2`。
