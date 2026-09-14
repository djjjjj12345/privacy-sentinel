const speech = require('@google-cloud/speech');
const client = new speech.SpeechClient();

async function transcribe(buffer) {
  const audioBytes = buffer.toString('base64');
  const audio = { content: audioBytes };
  const config = {
    encoding: 'LINEAR16',
    sampleRateHertz: 16000,
    languageCode: 'zh-CN',
  };
  const request = { audio, config };
  const [response] = await client.recognize(request);
  const transcription = response.results
    .map(result => result.alternatives[0].transcript)
    .join('\n');
  return transcription;
}

module.exports = { transcribe };