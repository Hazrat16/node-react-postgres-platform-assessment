// Thin client for the OpenSearch REST API (no SDK needed for this much).
const INDEX = "items";

export function createSearch(searchUrl) {
  async function call(path, options = {}) {
    const res = await fetch(`${searchUrl}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`search ${options.method || "GET"} ${path} returned ${res.status}`);
    return res.json();
  }

  return {
    health: () => call("/_cluster/health"),

    indexItem: (item) =>
      call(`/${INDEX}/_doc/${item.id}`, { method: "PUT", body: JSON.stringify(item) }),

    async searchItems(q) {
      const result = await call(`/${INDEX}/_search`, {
        method: "POST",
        body: JSON.stringify({ size: 20, query: { match: { name: { query: q, fuzziness: "AUTO" } } } }),
      });
      return result.hits.hits.map((hit) => hit._source);
    },
  };
}
