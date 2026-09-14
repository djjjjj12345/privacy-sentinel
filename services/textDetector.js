const patterns = {
    id: /\b\d{17}[\dXx]\b|\b\d{15}\b/g,
    bankcard: /\b\d{16,19}\b/g,
    password: /\b(?:密码|pwd|password)\s*[:：]?\s*\S{4,20}\b/gi,
    otp: /\b\d{4,8}\b(?=\s*(?:验证码|OTP|动态码|短信码))/gi,
    phone: /\b1[3-9]\d{9}\b/g,
    address: /(?:北京市|上海市|广州市|深圳市|杭州市|成都市|武汉市|南京市|天津市|重庆市|西安市|长沙市|青岛市|郑州市|大连市|东莞市|宁波市|厦门市|合肥市|福州市|昆明市|沈阳市|济南市|无锡市|苏州市|南昌市|南宁市|长春市|哈尔滨市|太原市|石家庄市|兰州市|海口市|贵阳市|乌鲁木齐市|呼和浩特市|银川市|西宁市|拉萨市)\s*\S{2,20}(?:路|街|大道|巷|弄|号|大厦|小区|花园|苑|村|楼|层|室)/gi,
  };
  
  function detect(text) {
    const results = [];
    const labelMap = {
      id: '身份证号', bankcard: '银行卡号', password: '密码',
      otp: '短信验证码', phone: '手机号', address: '家庭住址'
    };
    const levelMap = {
      id: 1, bankcard: 2, password: 3, otp: 4, phone: 1, address: 1
    };
    for (const [type, regex] of Object.entries(patterns)) {
      const matches = text.match(regex) || [];
      for (const val of matches) {
        results.push({
          type,
          label: labelMap[type] || type,
          value: val,
          level: levelMap[type] || 1
        });
      }
    }
    // 去重
    const seen = new Set();
    return results.filter(r => {
      const key = r.type + '|' + r.value;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  
  function getMaxLevel(detections) {
    return detections.reduce((max, d) => Math.max(max, d.level), 0);
  }
  
  module.exports = { detect, getMaxLevel };