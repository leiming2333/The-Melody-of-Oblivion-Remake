const { publicDownloadConfig } = require('./download-authorization');

function createDownloadConfigHandler({ env = process.env } = {}) {
  return function downloadConfig(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      return response.status(405).json({ code: 'METHOD_NOT_ALLOWED', error: 'Use GET to read download configuration' });
    }
    return response.status(200).json(publicDownloadConfig(env));
  };
}

module.exports = createDownloadConfigHandler();
module.exports.createDownloadConfigHandler = createDownloadConfigHandler;
