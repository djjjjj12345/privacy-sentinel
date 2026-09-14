const express = require('express');
const router = express.Router();
const axios = require('axios');

const VOLC_API_KEY = process.env.VOLC_API_KEY;
const VOLC_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses';
const MODEL = 'doubao-seed-2-0-mini-260428';

router.post('/detect', async (req, res) => {
    const { image_url, question } = req.body;

    if (!image_url) {
        return res.status(400).json({ error: '请提供图片URL' });
    }

    const payload = {
        model: MODEL,
        input: [{
            role: 'user',
            content: [
                { type: 'input_image', image_url: image_url },
                { type: 'input_text', text: question || '请识别图片中的所有敏感信息，包括身份证号、银行卡号、手机号等。' }
            ]
        }]
    };

    try {
        const response = await axios.post(VOLC_API_URL, payload, {
            headers: {
                'Authorization': `Bearer ${VOLC_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 60000
        });

        const data = response.data;
        let answer = '未能提取到有效信息。';
        if (data.output && data.output.length > 0) {
            const content = data.output[0]?.content;
            if (content && content.length > 0) {
                const textItem = content.find(item => item.type === 'output_text');
                if (textItem && textItem.text) {
                    answer = textItem.text;
                }
            }
        }

        res.json({ success: true, result: answer });
    } catch (error) {
        console.error('API调用失败:', error.response?.data || error.message);
        res.status(500).json({ error: 'AI服务调用失败，请检查图片地址是否正确。' });
    }
});

module.exports = router;