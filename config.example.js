// 插件全局配置模板（提交到仓库，不含密钥）
// 使用方法：复制本文件为 config.js，并填入与后端 service/.env 中
// LCT_ACCESS_TOKEN 完全一致的访问令牌。config.js 已被 .gitignore 忽略，
// 你填入的 token 只保存在本地，不会进入公开仓库。
//
// 生成一个随机 token： python3 -c "import secrets; print(secrets.token_urlsafe(32))"
// eslint-disable-next-line no-var
var DEFAULT_API_BASE = 'https://hover.sqw.org.cn';
var LCT_ACCESS_TOKEN = '';
// 本地后端调试时可改为 http://localhost:8000
