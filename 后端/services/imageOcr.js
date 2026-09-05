const Tesseract = require('tesseract.js');

async function recognize(buffer) {
  const base64 = buffer.toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;
  const result = await Tesseract.recognize(dataUrl, 'chi_sim+eng', {
    logger: m => console.log(m)
  });
  return result.data.text;
}

module.exports = { recognize };