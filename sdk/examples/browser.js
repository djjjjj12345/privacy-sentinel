/**
 * 示例 3：浏览器（UMD）
 * 直接用 <script src="../dist/privacy-sentinel.js"></script>，之后全局变量 PrivacySentinel 可用。
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var lastMasked = '';

  $('run').addEventListener('click', function () {
    var text = $('src').value;
    var res = window.PrivacySentinel.analyzeAndMask(text);

    $('items').innerHTML = res.items.map(function (i) {
      return '<span class="item">L' + i.level + ' ' + i.label + '：' + i.masked + '</span>';
    }).join('') || '<span class="item">未检测到敏感信息</span>';

    lastMasked = res.masked;
    $('masked').textContent = res.summary + '\n\n' + lastMasked;
  });

  $('copy').addEventListener('click', function () {
    if (!lastMasked) { alert('先点「检测并脱敏」'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lastMasked).then(function () { alert('已复制脱敏文本'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = lastMasked;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      alert('已复制脱敏文本');
    }
  });
})();
