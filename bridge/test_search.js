import { runWebSearch } from './web/index.mjs';

async function testRuntime() {
  const runtime = {
    signal: new AbortController().signal,
    settings: {
      web: {
        search: {
          enabled: true,
          provider: 'duckduckgo'
        }
      }
    }
  };
  
  try {
    const res = await runWebSearch({ query: 'tesla q3 earnings release' }, runtime);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.error(e);
  }
}

testRuntime().catch(console.error);
