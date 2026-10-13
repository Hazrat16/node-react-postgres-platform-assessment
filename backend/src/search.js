// Thin client for the OpenSearch REST API. Only a health call for now.
export function createSearch(searchUrl) {
  return {
    async health() {
      const res = await fetch(`${searchUrl}/_cluster/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`search returned ${res.status}`);
      return res.json();
    },
  };
}
