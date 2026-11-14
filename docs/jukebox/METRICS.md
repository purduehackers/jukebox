# Prometheus metrics

`GET /metrics` returns Prometheus text exposition 0.0.4, with `HELP` and `TYPE`
metadata and `Cache-Control: no-store`. It is available without a PH ID session
for scraping. It exports only aggregate counts, without identities or song URLs.

- `jukebox_queue_length{queue="request|master"}`: waiting entries, including those
  preparing. Requests count only preparing/ready entries in the open night.
  Masters count non-removed preparing/ready entries, excluding the current track
  and any suspended master mix. Master entries remain available between nights.
- `jukebox_songs_submitted_total{queue="request|master",source="youtube|spotify|apple_music|fixture"}`:
  accepted additions over the lifetime of the database. Counts the submitted
  provider, rather than the matched playback provider. Retries of the same command
  do not increment it; rejected submissions do not count. Removal, failure, refund
  and ending a night do not decrement it.

Both metrics read retained authoritative SQLite entries in one query; no migration
or process-local counter is needed. Counts survive service restarts. Restoring an
older database can reset counters; future entry-pruning work must preserve totals.
All supported queue/source combinations are emitted even when zero.

Example scrape configuration (replace the target with the reachable app address):

```yaml
scrape_configs:
  - job_name: jukebox
    scheme: https
    metrics_path: /metrics
    static_configs:
      - targets: ['jukebox.purduehackers.com']
```

Total waiting requests: `jukebox_queue_length{queue="request"}`.
Accepted additions per source over an hour:
`sum by (source) (increase(jukebox_songs_submitted_total[1h]))`.
No production scraper or Grafana dashboard has been configured by this change.
