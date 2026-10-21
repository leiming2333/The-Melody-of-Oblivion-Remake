module.exports = function disabledDomain(_request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  response.status(410).json({ error: 'This hostname has been disabled.' });
};
