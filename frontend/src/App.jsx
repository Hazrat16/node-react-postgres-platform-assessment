import { useEffect, useState } from "react";

// Baked in at build time (build arg VITE_API_BASE_URL). The default "/api" is
// same-origin: nginx (Compose) or the Ingress (Kubernetes) routes it to the
// backend, so the browser never needs to know an internal hostname.
const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

export default function App() {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  async function loadItems() {
    try {
      const res = await fetch(`${API_BASE}/items`);
      if (!res.ok) throw new Error(`GET /items failed: ${res.status}`);
      setItems(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadItems();
  }, []);

  async function addItem(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`POST /items failed: ${res.status}`);
      // Use the row returned by the primary instead of re-reading the list:
      // the list comes from the read replica, which may lag behind and not
      // show the item yet (read-your-own-writes).
      const created = await res.json();
      setItems((prev) => [created, ...prev.filter((i) => i.id !== created.id)]);
      setName("");
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function search(e) {
    e.preventDefault();
    if (!query.trim()) return setResults(null);
    try {
      const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error(`search failed: ${res.status}`);
      setResults(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 520, margin: "40px auto", padding: "0 16px" }}>
      <h1>Node + React + Postgres</h1>
      <p>
        API base: <code>{API_BASE}</code>
      </p>
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      <form onSubmit={addItem} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New item name"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit">Add</button>
      </form>

      <form onSubmit={search} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search items (OpenSearch)"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit">Search</button>
      </form>

      {results && (
        <>
          <h3>Search results ({results.length})</h3>
          <ul>
            {results.map((item) => (
              <li key={item.id}>{item.name}</li>
            ))}
          </ul>
        </>
      )}

      <h3>Latest items</h3>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </div>
  );
}
