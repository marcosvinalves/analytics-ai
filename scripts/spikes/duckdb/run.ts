// SP-01 only: removable Node experiment, never imported by the web application.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Client } from "pg";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { validRawKey } from "../../../src/lib/storage/key.ts";

const execute = promisify(execFile);
const output = path.resolve(".local/spikes/duckdb");
const pythonScript = path.resolve("scripts/spikes/duckdb/ground_truth.py");
const encode = (value: unknown) =>
  JSON.stringify(
    value,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function main() {
  assert.equal(
    process.version,
    "v22.23.2",
    "Execute com Node 22.23.2 para reproduzir o ambiente do spike.",
  );
  const args = process.argv.slice(2);
  assert.equal(args[0], "--version-id");
  assert.equal(args.length, 2);
  assert.match(args[1], /^[0-9a-f-]{36}$/i);
  assert.ok(
    process.env.DATABASE_URL,
    "DATABASE_URL necessária somente para leitura de metadados.",
  );
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const snapshot = async () => {
      await client.query("BEGIN READ ONLY");
      try {
        const tables = [
          "organizations",
          "workspaces",
          "datasets",
          "dataset_versions",
          "dataset_columns",
        ];
        const digests: Record<string, string> = {};
        for (const table of tables) {
          const rows = await client.query(
            `SELECT * FROM app.${table} ORDER BY id`,
          );
          digests[table] = hash(encode(rows.rows));
        }
        const history = await client.query(
          "SELECT * FROM migration_metadata.history ORDER BY id",
        );
        digests.history = hash(encode(history.rows));
        const ref = await client.query(
          `SELECT v.*, d.workspace_id FROM app.dataset_versions v JOIN app.datasets d ON d.id = v.dataset_id WHERE v.id = $1`,
          [args[1]],
        );
        assert.equal(ref.rowCount, 1, "Versão inexistente");
        await client.query("COMMIT");
        return { digests, version: ref.rows[0] };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    };
    const before = await snapshot();
    assert.equal(before.version.source_type, "CSV");
    assert.equal(before.version.storage_namespace, "raw");
    assert.ok(validRawKey(before.version.storage_key));
    const root = path.resolve(
      process.env.LOCAL_STORAGE_ROOT || ".local/raw-storage",
    );
    const file = path.resolve(root, before.version.storage_key);
    assert.ok(path.relative(root, file).startsWith(`workspaces${path.sep}`));
    // Reject symlinks/junctions at every existing path component, including storage ancestors.
    let part = path.parse(file).root;
    for (const segment of file.slice(part.length).split(path.sep)) {
      part = path.join(part, segment);
      assert.equal((await lstat(part)).isSymbolicLink(), false);
    }
    assert.ok((await lstat(file)).isFile());
    assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
    const raw = await readFile(file);
    const hashBefore = hash(raw);
    assert.equal(String(raw.length), before.version.size_bytes);
    const truth = JSON.parse(
      (await execute("python", [pythonScript, file])).stdout,
    );
    assert.notEqual(
      truth.aggregate,
      null,
      "Fixture principal deve possuir produtos válidos.",
    );
    await mkdir(output, { recursive: true });
    const runs = [];
    for (let iteration = 1; iteration <= 2; iteration++) {
      const times: Record<string, number> = {};
      let start = performance.now();
      const instance = await DuckDBInstance.create(":memory:", {
        threads: "2",
        memory_limit: "256MB",
        enable_external_access: "true",
        autoinstall_known_extensions: "false",
        autoload_known_extensions: "false",
        temp_directory: path.join(output, "tmp"),
      });
      const connection = await instance.connect();
      times.openMs = performance.now() - start;
      try {
        const query = (sql: string, values?: DuckDBValue[]) =>
          connection.runAndReadAll(sql, values);
        const engine = (
          await query("SELECT version() AS version")
        ).getRowObjectsJson()[0];
        const csvOptions =
          "header=true, delim=',', sample_size=-1, nullstr='', allow_quoted_nulls=true, ignore_errors=false, strict_mode=true";
        start = performance.now();
        await query(
          `CREATE TEMP TABLE source AS SELECT * FROM read_csv($1, ${csvOptions})`,
          [file],
        );
        times.csvReadMs = performance.now() - start;
        start = performance.now();
        const schema = (await query("DESCRIBE source")).getRowObjectsJson();
        const columns = schema.map((row) => String(row.column_name));
        assert.deepEqual(columns, truth.columns);
        const count = (
          await query("SELECT count(*) AS n FROM source")
        ).getRowObjects()[0].n;
        assert.equal(String(count), String(truth.rowCount));
        const nullCounts = (
          await query(
            `SELECT ${columns.map((c) => `count(*) FILTER (WHERE ${identifier(c)} IS NULL) AS ${identifier(c)}`).join(", ")} FROM source`,
          )
        ).getRowObjectsJson()[0];
        for (const c of columns)
          assert.equal(String(nullCounts[c]), String(truth.nullCounts[c]));
        const preview = (
          await query("SELECT * FROM source ORDER BY ALL LIMIT 5")
        ).getRowObjectsJson();
        times.inspectMs = performance.now() - start;
        start = performance.now();
        const automaticReader = await query(
          "SELECT sum(quantidade * preco_unitario) AS total FROM source",
        );
        const automaticValue = automaticReader.getRowObjects()[0].total;
        const automatic = String(automaticValue);
        times.automaticAggregateMs = performance.now() - start;
        start = performance.now();
        // Re-read original text: never cast previously inferred DOUBLE values to DECIMAL.
        const decimalReader = await query(
          `SELECT sum(CAST(quantidade AS DECIMAL(18,0)) * CAST(preco_unitario AS DECIMAL(18,2))) AS total FROM read_csv($1, ${csvOptions}, all_varchar=true)`,
          [file],
        );
        const decimalValue = decimalReader.getRowObjects()[0].total;
        const decimal = String(decimalValue);
        times.decimalAggregateMs = performance.now() - start;
        // Python compares exact decimal strings, exposing rather than rounding differences.
        const comparison = await new Promise<
          Record<string, { equal: boolean; difference: string }>
        >((resolve, reject) => {
          const child = execFile(
            "python",
            [pythonScript, "--compare"],
            (error, stdout) => {
              if (error) reject(error);
              else {
                try {
                  resolve(JSON.parse(stdout));
                } catch (e) {
                  reject(e);
                }
              }
            },
          );
          child.stdin?.end(
            JSON.stringify({ expected: truth.aggregate, automatic, decimal }),
          );
        });
        assert.equal(
          comparison.decimal.equal,
          true,
          "DECIMAL diverge do ground truth: não aceitar silenciosamente.",
        );
        const typesFile = path.resolve(
          "scripts/spikes/duckdb/fixtures/types.csv",
        );
        await query(
          `CREATE TEMP TABLE type_probe AS SELECT * FROM read_csv($1, ${csvOptions})`,
          [typesFile],
        );
        const typesSchema = (
          await query("DESCRIBE type_probe")
        ).getRowObjectsJson();
        const typed = await query("SELECT * FROM type_probe ORDER BY id");
        const values = typed.getRowObjects();
        assert.equal(values[0].large_integer, BigInt("9007199254740993"));
        assert.equal(values[1].large_integer, BigInt("9223372036854775807"));
        assert.equal(values[0].enabled, true);
        assert.equal(values[1].enabled, false);
        assert.equal(values[0].label, "ação, café");
        assert.equal(values[1].label, 'aspas "duplas"');
        assert.equal(values[0].nullable_value, null);
        assert.equal(values[1].nullable_value, null);
        assert.equal(values[1].mixed, "invalid");
        let incompatibleRejected = false;
        try {
          await query("SELECT CAST(mixed AS INTEGER) FROM type_probe");
        } catch {
          incompatibleRejected = true;
        }
        assert.ok(incompatibleRejected);
        const numericProbe = (
          await query(
            `SELECT (SELECT sum(money) FROM type_probe) AS automatic, sum(CAST(money AS DECIMAL(18,2))) AS explicit FROM read_csv($1, ${csvOptions}, all_varchar=true)`,
            [typesFile],
          )
        ).getRowObjects();
        const typesTruth = JSON.parse(
          (await execute("python", [pythonScript, "--types", typesFile]))
            .stdout,
        );
        assert.equal(String(numericProbe[0].explicit), typesTruth.moneySum);
        const temporal = (
          await query("SELECT TIMESTAMPTZ '2026-09-20 12:00:00+00' AS instant")
        ).getRowObjects();
        const describeValue = (value: unknown) => ({
          jsType: typeof value,
          class:
            value === null
              ? null
              : typeof value === "object"
                ? value.constructor.name
                : null,
          text: String(value),
        });
        runs.push({
          iteration,
          engine,
          times,
          schema,
          rowCount: String(count),
          preview,
          nullCounts,
          automatic,
          decimal,
          comparison,
          monetaryJs: {
            automatic: describeValue(automaticValue),
            decimal: describeValue(decimalValue),
          },
          types: {
            python: typesTruth,
            schema: typesSchema,
            rows: typed.getRowObjectsJson(),
            js: Object.fromEntries(
              Object.entries(values[0]).map(([key, value]) => [
                key,
                describeValue(value),
              ]),
            ),
            numericProbe: numericProbe.map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  describeValue(value),
                ]),
              ),
            ),
            temporal: temporal.map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  describeValue(value),
                ]),
              ),
            ),
            incompatibleRejected,
          },
        });
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    }
    const after = await snapshot();
    const hashAfter = hash(await readFile(file));
    assert.equal(hashAfter, hashBefore);
    assert.deepEqual(after, before);
    const { iteration: firstIteration, times: firstTimes, ...first } = runs[0];
    const {
      iteration: secondIteration,
      times: secondTimes,
      ...second
    } = runs[1];
    assert.ok(firstIteration !== secondIteration && firstTimes && secondTimes);
    assert.deepEqual(second, first);
    const report = {
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        os: os.version(),
        release: os.release(),
        cpu: os.cpus()[0]?.model,
        python: truth.python,
        binding: JSON.parse(
          await readFile("node_modules/@duckdb/node-api/package.json", "utf8"),
        ).version,
      },
      source: {
        versionId: args[1],
        sizeBytes: raw.length,
        status: before.version.status,
        hashBefore,
        hashAfter,
      },
      metadataBefore: before.digests,
      metadataAfter: after.digests,
      metadataUnchanged: true,
      groundTruth: truth,
      runs,
      secondExecutionIdentical: true,
    };
    await writeFile(path.join(output, "result.json"), encode(report));
    console.log(encode(report));
  } finally {
    await client.end();
  }
}
main().catch(() => {
  console.error(
    "SP01_FAILED: experimento não concluído; nenhuma conclusão de aprovação. Verifique configuração, arquivo e assertions localmente.",
  );
  process.exitCode = 1;
});
