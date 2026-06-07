# Dashboard Worker Brief

This document is public-safe context for building `llama.nodrama`, a Go-based
operations dashboard for `llama.cpp`.

## Build Goal

Create a cross-platform Go binary that serves a dashboard for local/self-hosted
`llama.cpp` servers. The product should be useful during real operations:
debugging saturation, prompt-cache behavior, long contexts, slot concurrency,
and GPU pressure.

Do not commit changes automatically. The human owner reviews and commits.

## Dashboard Baseline

The embedded dashboard UI is served through the Go binary. The root `LICENSE`
contains the required third-party attribution for the UI baseline.

The product direction is still a Go-backed dashboard that keeps the original
compact slot/metric view while adding backend parsing, correlation, prompt-cache
diagnostics, and release-quality packaging.

## Data Sources

Poll/proxy these llama.cpp endpoints:

```text
/health
/props
/slots
/metrics
/v1/models
```

Also ingest logs from at least one of:

```text
--log-file PATH
--docker-container NAME
stdin
```

The logs are required for deeper slot/cache diagnosis because current
`/metrics` does not reliably expose direct KV-cache totals.

## `/slots` Notes

A live slot can include:

```json
{
  "id": 1,
  "n_ctx": 262144,
  "is_processing": true,
  "id_task": 31020,
  "n_prompt_tokens": 7366,
  "n_prompt_tokens_processed": 18923,
  "n_prompt_tokens_cache": 0,
  "params": {
    "temperature": 0.1,
    "top_k": 20,
    "top_p": 0.95,
    "repeat_penalty": 1,
    "max_tokens": 32768,
    "n_predict": 32768,
    "reasoning_format": "deepseek"
  },
  "next_token": [
    {
      "n_remain": 28493,
      "n_decoded": 4275
    }
  ]
}
```

Compatibility requirement: handle `next_token` as either an object or an array.

## Slot UI Requirements

Each slot card should show:

- slot id,
- task id,
- state,
- context capacity,
- prompt tokens,
- prompt processed tokens,
- prompt cache hits,
- decoded generation tokens,
- remaining generation tokens,
- generation progress,
- restored context checkpoint tokens,
- restored checkpoint size,
- prompt-processing rate,
- generation rate,
- checkpoint creation/restoration/invalidation,
- current sampler summary,
- last release tokens and truncation status.

Useful derived values:

- generation progress,
- context occupancy estimate,
- restored-context ratio,
- prompt-processing progress,
- queue pressure.

Use careful labels. If the value is inferred, call it an estimate.

## Log Events To Parse

Important patterns:

```text
slot launch_slot_: id 1 | task 36289 | processing task
slot update_slots: id 1 | task 36289 | restored context checkpoint (... n_tokens = 42800, n_past = 42800, size = 62.813 MiB)
slot update_slots: id 0 | task 31019 | forcing full prompt re-processing due to lack of cache data
slot update_slots: id 0 | task 31019 | erased invalidated context checkpoint (... n_tokens = 28072, size = 62.813 MiB)
slot create_check: id 1 | task 36289 | created context checkpoint 21 of 32 (... n_tokens = 45163, size = 62.813 MiB)
slot print_timing: id 1 | task 26541 | prompt processing, n_tokens = 18919, progress = 1.00, t = 11.89 s / 1591.70 tokens per second
slot print_timing: id 1 | task 40327 | prompt eval time = 2184.02 ms / 4201 tokens
slot print_timing: id 1 | task 31078 | n_decoded = 740, tg = 59.48 t/s
slot release: id 1 | task 40327 | stop processing: n_tokens = 32427, truncated = 0
srv prompt_save: - saving prompt with length 45273, total state size = 533.429 MiB
srv update: - cache state: 13 prompts, 7022.706 MiB (limits: 8192.000 MiB, 358400 tokens, 358400 est)
srv update: - prompt 0x71f808037d00: 23197 tokens, checkpoints: 3, 492.387 MiB
```

The most important slot/cache event is restored context:

```text
restored context checkpoint (... n_tokens = N, n_past = N, size = X MiB)
```

This tells the operator how much context was loaded before inference continued.

## Prompt Cache Panel

Build a separate prompt-cache panel from parsed logs:

- total prompt-cache MiB and limit,
- prompt count,
- token estimate and token limit,
- per-prompt entries,
- checkpoint counts,
- first seen / last seen,
- recent saves/restores/invalidations.

Make it obvious whether latency came from:

- prompt cache update time,
- full prompt reprocessing,
- checkpoint restore,
- generation.

## Overview Panel

Top-level cards should include:

- requests processing,
- requests deferred,
- prompt tok/s,
- generation tok/s,
- busy slots / total slots,
- prompt tokens total,
- generated tokens total,
- prompt-cache size,
- GPU memory/utilization when available,
- active model alias,
- context size,
- modalities.

GPU data should be optional. Prefer `nvidia-smi` if available, but show a clear
degraded state if unavailable.

## Suggested Milestones

1. Go server skeleton and embedded UI.
2. Endpoint proxy/polling for `/health`, `/props`, `/slots`, `/metrics`,
   `/v1/models`.
3. Slot cards using normalized `/slots`.
4. Log tailing from file/Docker/stdin.
5. Regex parser for slot lifecycle and prompt-cache events.
6. Slot timeline and prompt-cache panel.
7. Optional GPU panel.
8. Usability pass against a real llama.cpp workload.
