const RELEASE_API = 'https://api.github.com/repos/leiming2333/The-Melody-of-Oblivion-Remake/releases/latest';

module.exports = async function latestRelease(_request, response) {
  try {
    const upstream = await fetch(RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'melody-of-oblivion-website'
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!upstream.ok) {
      response.status(502).json({ error: 'Release information is unavailable' });
      return;
    }
    const release = await upstream.json();
    response.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    response.status(200).json(release);
  } catch {
    response.status(502).json({ error: 'Release information is unavailable' });
  }
};
