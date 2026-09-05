const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const imageOcr = require('./imageOcr');

function analyze(buffer) {
  return new Promise((resolve, reject) => {
    // 保存为临时文件（实际生产建议使用流处理）
    const tmpDir = '/tmp/';
    const tmpFile = path.join(tmpDir, `video_${Date.now()}.mp4`);
    fs.writeFileSync(tmpFile, buffer);

    const frames = [];
    ffmpeg(tmpFile)
      .screenshots({
        count: 5,
        filename: 'frame-%d.png',
        folder: tmpDir
      })
      .on('end', async () => {
        const texts = [];
        for (let i = 1; i <= 5; i++) {
          const framePath = path.join(tmpDir, `frame-${i}.png`);
          if (fs.existsSync(framePath)) {
            const frameBuffer = fs.readFileSync(framePath);
            const text = await imageOcr.recognize(frameBuffer);
            texts.push(text);
            fs.unlinkSync(framePath);
          }
        }
        fs.unlinkSync(tmpFile);
        resolve(texts);
      })
      .on('error', (err) => {
        fs.unlinkSync(tmpFile);
        reject(err);
      });
  });
}

module.exports = { analyze };