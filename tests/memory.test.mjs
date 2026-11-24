import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

test("loads and searches the full catalog in a memory-limited worker", async () => {
  const catalogModule = new URL("../src/catalog.mts", import.meta.url).href;
  const catalogAsset = new URL("../assets/catalog.json.gz", import.meta.url)
    .href;
  const worker = new Worker(
    new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { readFileSync } from "node:fs";
        import { parentPort, workerData } from "node:worker_threads";
        import { gunzipSync } from "node:zlib";
        import { createCatalog } from ${JSON.stringify(catalogModule)};

        const catalog = createCatalog(JSON.parse(gunzipSync(readFileSync(new URL(workerData)))));
        parentPort.postMessage([
          catalog.search("").total,
          catalog.search("cjk unified ideograph").page(100_000, 100).length,
          catalog.search("U+20000").page(0, 1)[0]?.name,
          catalog.search("nf-fa-github").page(0, 1)[0]?.name,
        ]);
      `)}`,
    ),
    {
      workerData: catalogAsset,
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    },
  );
  const [[results], [exitCode]] = await Promise.all([
    once(worker, "message"),
    once(worker, "exit"),
  ]);
  assert.equal(exitCode, 0);
  assert.ok(results[0] > 0);
  assert.deepEqual(results.slice(1), [
    100,
    "CJK UNIFIED IDEOGRAPH-20000",
    "nf-fa-github",
  ]);
});
