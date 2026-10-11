const RELEASES_API = 'https://api.github.com/repos/leiming2333/The-Melody-of-Oblivion-Remake/releases?per_page=5';

module.exports = async function releases(_request, response) {
  try {
    const upstream = await fetch(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'melody-of-oblivion-website'
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!upstream.ok) {
      response.status(502).json({ error: 'Release notes are unavailable' });
      return;
    }
    const data = await upstream.json();
    if (!Array.isArray(data)) {
      response.status(502).json({ error: 'Release notes are unavailable' });
      return;
    }
    response.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
    response.status(200).json(data.slice(0, 5));
  } catch {
    response.status(502).json({ error: 'Release notes are unavailable' });
  }
};
