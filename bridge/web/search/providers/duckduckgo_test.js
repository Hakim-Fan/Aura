const { fetchText } = await import('../../net/guardedFetch.mjs');

async function testDDG() {
  const url = 'https://html.duckduckgo.com/html/?q=tesla+latest+earnings&kl=wt-wt';
  console.log('Fetching', url);
  
  const { response, text } = await fetchText(
    url,
    {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml',
      },
    },
    {
      timeoutMs: 15000,
      maxRedirects: 3
    }
  );
  
  console.log('Status:', response.status);
  console.log('Headers:', Object.fromEntries(response.headers.entries()));
  console.log('Has Challenge:', /anomaly|challenge/i.test(text));
  console.log('Preview:', text.substring(0, 500));
}

testDDG().catch(console.error);
