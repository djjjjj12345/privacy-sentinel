const express = require('express');
const router = express.Router();
const axios = require('axios');

// 火山引擎配置（从环境变量读取）
const VOLC_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses';
const VOLC_API_KEY = process.env.VOLC_API_KEY || 'ark-5c367b72-2bdb-4097-b705-d2a2461598d3-3571d';
const MODEL = 'doubao-seed-2-0-mini-260428';

router.post('/detect', async (req, res) => {
    const { image_url, question } = req.body;

    if (!image_url) {
        return res.status(400).json({ error: '缺少 image_url 参数' });
    }

    const payload = {
        model: MODEL,
        input: [
            {
                role: 'user',
                content: [
                    { type: 'input_image', image_url: image_url },
                    { type: 'input_text', text: question || '请识别图片中的所有敏感信息，包括身份证号、银行卡号、手机号等，直接输出结果。' }
                ]
            }
        ]
    };

    try {
        const response = await axios.post(VOLC_API_URL, payload, {
            headers: {
                'Authorization': `Bearer ${VOLC_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 60000 // 60秒超时
        });

        // 提取 AI 回复内容（根据实际返回结构调整）
        const data = response.data;
        let answer = '未提取到有效回复';
        if (data.output && data.output.length > 0) {
            const content = data.output[0]?.content;
            if (content && content.length > 0) {
                const textItem = content.find(item => item.type === 'output_text');
                if (textItem && textItem.text) {
                    answer = textItem.text;
                }
            }
        }

        res.json({
            success: true,
            result: answer,
            raw: data // 如需要完整原始数据可保留
        });

    } catch (error) {
        console.error('火山 API 调用失败:', error.response?.data || error.message);
        res.status(500).json({
            error: '调用 AI 服务失败',
            detail: error.response?.data || error.message
        });
    }
});

module.exports = router;