Frontend Performance Recommendations

Summary
- Debounce search inputs (300ms) and require min-length (2-3 chars).
- Implement server-side pagination for lists (residents, flats, payments, ledger).
- Lazy-load heavy components: charts, payment history, reports.
- Cache lookups (blocks, small enums) in localStorage or in-memory with TTL.
- Use skeleton loaders for perceived performance.

Examples

1) Debounced search (React + hooks)

```jsx
import { useState, useEffect } from 'react'

function useDebounce(value, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}

// Usage
const [q, setQ] = useState('')
const debouncedQ = useDebounce(q, 300)
useEffect(() => { if (debouncedQ.length >= 2) fetch(`/api/search?q=${debouncedQ}`) }, [debouncedQ])
```

2) Server-side pagination request

```js
// Fetch page N with limit
fetch(`/api/residents?page=2&limit=25`)
```

3) Lazy load charts (React)

```jsx
const ChartPanel = React.lazy(() => import('./ChartPanel'))

<Suspense fallback={<ChartSkeleton/>}>
  <ChartPanel data={chartData} />
</Suspense>
```

4) Cache small lookups (blocks) in localStorage with TTL

```js
function getBlocks() {
  const cached = JSON.parse(localStorage.getItem('blocks') || 'null')
  if (cached && Date.now() < cached.expires) return Promise.resolve(cached.value)
  return fetch('/api/blocks').then(r => r.json()).then(data => { localStorage.setItem('blocks', JSON.stringify({ value: data, expires: Date.now() + 60*1000 })) ; return data })
}
```

5) Only fetch payment details on demand

- Show list with `hasDetails` flag and a `View details` button that fetches `/api/payments/:id` when clicked.

Other Tips
- Use compressed responses and ensure `Content-Encoding: gzip` or `br` is enabled (server-side compression is implemented).
- Instrument frontend metrics (TTFB, FCP, LCP) and report to a monitoring endpoint.
