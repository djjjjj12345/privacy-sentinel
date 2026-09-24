/**
 * 兼容接口 POST /api/detect
 * ---------------------------------------------------------------
 * 这是第一版界面使用的老接口。保留它是为了不破坏已经部署的页面，
 * 但内部改为复用统一的 analyze 引擎，因此现在同样会返回结构化的 items。
 *
 * 老契约： { image_url, question }  -> { success, result }
 * 新契约： 在老字段之外，额外附带 items / maxLevel / advice 等结构化字段。
 */

const express = require('express');
const router = express.Router();

const analyzer = require('../services/analyzer');

router.post('/detect', async (req, res) => {
  const { image_url, question } = req.body || {};

  if (!image_url) {
    return res.status(400).json({ success: false, error: '请提供图片URL' });
  }

  try {
    const result = await analyzer.analyzeImage({
      imageUrl: image_url,
      question,
      profile: {},
    });

    if (!result.success) {
      return res.status(result.status || 500).json({
        success: false,
        error: result.error || 'AI服务调用失败，请检查图片地址是否正确。',
      });
    }

    // 老前端只认 result 字段，这里生成一份人类可读的文本摘要
    const lines = result.items.length
      ? result.items.map((i) => `- ${i.label}：${i.masked}（${i.level >= 3 ? '高风险' : '需注意'}）`)
      : ['未检测到敏感信息。'];

    const text = [`${result.summary}（${result.levelName}）`, ...lines, `建议：${result.advice}`].join('\n');

    return res.json({
      ...result,
      result: text,
    });
  } catch (error) {
    console.error('[/api/detect] 调用失败:', error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || 'AI服务调用失败，请检查图片地址是否正确。',
    });
  }
});

module.exports = router;
