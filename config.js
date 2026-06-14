// 插件全局配置（提交进仓库，不含任何密钥）
// 访问令牌请在扩展 popup 的「访问令牌」里填写：它会保存到 chrome.storage.sync，
// 并随你的 Chrome 账号自动同步到所有设备，无需在每台电脑手动配置。
// eslint-disable-next-line no-var
var DEFAULT_API_BASE = 'https://hover.sqw.org.cn';
// 本地后端调试时可改为 http://localhost:8000

// 从 chrome.storage.sync 读取访问令牌；content / background / popup / review 各上下文通用。
// eslint-disable-next-line no-unused-vars
function getAccessToken() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(['accessToken'], (r) => resolve((r && r.accessToken) || ''));
    } catch (e) {
      resolve('');
    }
  });
}
