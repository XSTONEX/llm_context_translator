// 尽早套用外观，减少打开 popup / 设置页时的闪白或闪黑。
// MV3 扩展页不允许内联脚本，所以单独成文件，放在 <head> 里同步加载。
(function () {
  try {
    chrome.storage.local.get(['themeMode'], function (r) {
      var mode = r && r.themeMode;
      if (mode !== 'light' && mode !== 'dark') {
        mode = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      document.documentElement.dataset.theme = mode;
    });
  } catch (e) {
    // 非扩展环境（如直接打开 html）忽略
  }
})();
