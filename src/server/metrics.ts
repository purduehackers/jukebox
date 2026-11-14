import type { Database } from 'bun:sqlite';

const sources = ['youtube', 'spotify', 'apple_music', 'fixture'] as const;

/** Read retained admissions and live queue state in one SQLite snapshot. No mutations. */
export function metricsResponse(db: Database): Response {
  const rows = db.prepare(`
    select 'master' as queue, provider as source, count(*) as submitted,
      sum(case when removed = 0 and status in ('preparing','ready')
        and id is not (select current_id from playback where id = 1)
        and id is not (select json_extract(suspended, '$.itemId') from playback where id = 1)
        then 1 else 0 end) as waiting
    from master_items group by provider
    union all
    select 'request', provider, count(*),
      sum(case when status in ('preparing','ready')
        and night_id in (select id from nights where status = 'open') then 1 else 0 end)
    from requests group by provider
  `).all() as { queue: string; source: string; submitted: number; waiting: number }[];
  const lines = [
    '# HELP jukebox_queue_length Waiting songs, including preparation; excludes current and suspended playback.',
    '# TYPE jukebox_queue_length gauge',
  ];
  for (const queue of ['master', 'request']) {
    lines.push(`jukebox_queue_length{queue="${queue}"} ${rows.filter(row => row.queue === queue).reduce((n, row) => n + row.waiting, 0)}`);
  }
  lines.push('# HELP jukebox_songs_submitted_total Accepted queue additions since database creation, including subsequently removed or failed songs.',
    '# TYPE jukebox_songs_submitted_total counter');
  for (const queue of ['master', 'request']) {
    for (const source of sources) {
      const count = rows.find(row => row.queue === queue && row.source === source)?.submitted ?? 0;
      lines.push(`jukebox_songs_submitted_total{queue="${queue}",source="${source}"} ${count}`);
    }
  }
  return new Response(lines.join('\n') + '\n', { headers: {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'cache-control': 'no-store',
  } });
}
