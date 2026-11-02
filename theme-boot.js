// 尽早套用外观和皮肤，减少打开 popup / 设置页 / 复习页时的闪白、闪黑或先闪一下另一套皮肤。
// MV3 扩展页不允许内联脚本，所以单独成文件，放在 <head> 里同步加载（此时 config.js 还没加载）。
(function () {
  try {
    chrome.storage.local.get(['themeMode', 'skin'], function (r) {
      var mode = r && r.themeMode;
      if (mode !== 'light' && mode !== 'dark') {
        mode = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      document.documentElement.dataset.theme = mode;
      document.documentElement.dataset.skin = r && r.skin === 'clear' ? 'clear' : 'paper';
    });
  } catch (e) {
    // 非扩展环境（如直接打开 html）忽略
  }
})();
