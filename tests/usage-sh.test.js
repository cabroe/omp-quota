// Tests für usage.sh: stdout ist IMMER ein JSON-Objekt (AGENTS.md-Vertrag),
// Fehler landen als {"error": ...} auf stdout bei Exit 1 — inklusive Timeout
// (exit 124) und omp-stderr in der Meldung. Ein Fake-omp auf einem
// isolierten PATH macht das Verhalten deterministisch.
//
// Isolations-Rezept (mit Plugin-Agent abgestimmt, dort 3/3 grün verifiziert):
// PATH enthält nur die Tools, die usage.sh braucht (sed, mktemp, rm, timeout,
// für den Fake-omp zusätzlich sleep) plus einen mise-Stub mit exit 1 — sonst
// findet `mise which omp` das echte omp und der Test macht echte API-Calls.
// /usr/bin/omp und /usr/local/bin/omp sind absolute Kandidaten und auf diesem
// Host abwesend; HOME zeigt auf ein leeres Sandbox-Verzeichnis.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "bun";

const USAGE_SH = new URL("../usage.sh", import.meta.url).pathname;
// Absolut: Der isolierte PATH enthält bash bewusst nicht.
const BASH = which("bash");

let sandbox;

function makeOmp(body, name = "omp") {
  const omp = join(sandbox.isolated, name);
  writeFileSync(omp, `#!/bin/bash\n${body}\n`);
  chmodSync(omp, 0o755);
}

// usage.sh-Kopie mit verkürztem OMP_TIMEOUT, damit der Timeout-Fall in ~2 s
// statt 20 s durchläuft (vom Plugin-Agent so vorgesehen).
function makeFastUsageSh() {
  const variant = join(sandbox.root, "usage-fast.sh");
  const src = readFileSync(USAGE_SH, "utf8").replace(/^OMP_TIMEOUT=20$/m, "OMP_TIMEOUT=2");
  writeFileSync(variant, src, { mode: 0o755 });
  return variant;
}

// Führt usage.sh mit isoliertem PATH/HOME aus; sammelt Exit-Code, stdout, stderr.
async function runUsage(args = [], { script = USAGE_SH, env = {} } = {}) {
  const proc = Bun.spawn([BASH, script, ...args], {
    cwd: sandbox.root,
    env: {
      ...process.env,
      HOME: sandbox.home,
      PATH: sandbox.isolated,
      OMP_CALLS: sandbox.calls,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function jsonOk(out) {
  const parsed = JSON.parse(out);
  expect(parsed).toBeObject();
  return parsed;
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "omp-quota-test-"));
  const isolated = join(root, "isolated");
  mkdirSync(isolated);
  mkdirSync(join(root, "home"));
  for (const tool of ["sed", "mktemp", "rm", "timeout", "sleep"]) {
    symlinkSync(which(tool), join(isolated, tool));
  }
  // Fängt den letzten Zweig von find_omp ab: `mise which omp` würde sonst das
  // echte Binary auflösen — unabhängig vom PATH.
  writeFileSync(join(isolated, "mise"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
  sandbox = { root, isolated, home: join(root, "home"), calls: join(root, "calls.log") };
});

afterEach(() => {
  rmSync(sandbox.root, { recursive: true, force: true });
});

describe("usage.sh JSON-Garantie", () => {
  test("erfolgreicher Lauf: Payload unverändert, Exit 0", async () => {
    makeOmp(`echo '{"reports":[]}'`);
    const { exitCode, stdout } = await runUsage();
    expect(exitCode).toBe(0);
    expect(jsonOk(stdout)).toEqual({ reports: [] });
  });

  test("Banner vor dem Payload wird abgeschnitten", async () => {
    makeOmp(`echo 'omp: warning, cache stale'; echo '{"reports":[{"provider":"zai"}]}'`);
    const { exitCode, stdout } = await runUsage();
    expect(exitCode).toBe(0);
    expect(stdout.startsWith("{")).toBe(true);
    expect(jsonOk(stdout).reports[0].provider).toBe("zai");
  });

  test("Ausgabe ohne JSON-Objekt: Fehler-JSON mit der Ausgabe als Kontext", async () => {
    makeOmp(`echo 'complete garbage, no braces here'`);
    const { exitCode, stdout } = await runUsage();
    expect(exitCode).toBe(1);
    const parsed = jsonOk(stdout);
    expect(parsed.error).toContain("lieferte kein JSON-Objekt");
    expect(parsed.error).toContain("complete garbage");
  });

  test("Exit != 0: Fehler-JSON mit Exit-Code und omp-stderr, Exit 1", async () => {
    makeOmp(`echo 'token expired' >&2; exit 3`);
    const { exitCode, stdout } = await runUsage();
    expect(exitCode).toBe(1);
    const parsed = jsonOk(stdout);
    expect(parsed.error).toContain("fehlgeschlagen (exit 3)");
    expect(parsed.error).toContain("token expired");
  });

  test("Exit != 0 ohne stderr: 'keine Fehlerausgabe'", async () => {
    makeOmp(`exit 2`);
    const { exitCode, stdout } = await runUsage();
    expect(exitCode).toBe(1);
    expect(jsonOk(stdout).error).toContain("keine Fehlerausgabe");
  });

  test("leerer Output bei Exit 0: Fehler-JSON, Exit 1", async () => {
    makeOmp(`exit 0`);
    const { exitCode, stdout } = await runUsage();
    expect(exitCode).toBe(1);
    expect(jsonOk(stdout).error).toContain("fehlgeschlagen (exit 0)");
  });

  test("mehrzeiliges stderr mit ANSI-Codes bleibt einzeilig und JSON-valide", async () => {
    makeOmp(`printf 'zeile eins\\nzeile zwei \\x1b[31mrot\\x1b[0m\\n' >&2; exit 1`);
    const { stdout } = await runUsage();
    const parsed = jsonOk(stdout);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).not.toContain("\\n");
    expect(parsed.error).not.toContain("\\u001b");
    expect(parsed.error).toContain("zeile eins zeile zwei");
  });

  test("Anführungszeichen und Backslashes im Fehlertext bleiben valides JSON", async () => {
    makeOmp(`printf 'er sagte "hi" und \\\\hard\\\\\\n' >&2; exit 1`);
    const { stdout } = await runUsage();
    const parsed = jsonOk(stdout);
    expect(parsed.error).toContain('er sagte "hi"');
    expect(parsed.error).toContain("\\hard");
  });

  test("fehlendes omp: Fehler-JSON 'omp nicht gefunden', Exit 1", async () => {
    // kein Fake-omp; leeres HOME + mise-Stub blockieren alle Suchpfade
    const { exitCode, stdout } = await runUsage();
    expect(exitCode).toBe(1);
    expect(jsonOk(stdout).error).toContain("omp nicht gefunden");
  });

  test("hängendes omp: Timeout bricht ab, Meldung nennt die Sekunden", async () => {
    makeOmp(`sleep 30`);
    const { exitCode, stdout } = await runUsage([], { script: makeFastUsageSh() });
    expect(exitCode).toBe(1);
    expect(jsonOk(stdout).error).toContain("hat nach 2 s nicht geantwortet");
  }, 15_000);
});

describe("usage.sh Argumente", () => {
  test("ohne Flags: genau 'usage --json'", async () => {
    makeOmp(`printf '%s\\n' "$*" >> "$OMP_CALLS"; echo '{"reports":[]}'`);
    await runUsage();
    expect(readFileSync(sandbox.calls, "utf8").trim()).toBe("usage --json");
  });

  test("--redact reicht den Flag an omp durch", async () => {
    makeOmp(`printf '%s\\n' "$*" >> "$OMP_CALLS"; echo '{"reports":[]}'`);
    await runUsage(["--redact"]);
    expect(readFileSync(sandbox.calls, "utf8").trim()).toBe("usage --json --redact");
  });

  test("--fresh ruft zuerst 'usage invalidate' auf, danach 'usage --json'", async () => {
    makeOmp(`printf '%s\\n' "$*" >> "$OMP_CALLS"; echo '{"reports":[]}'`);
    const { exitCode, stdout } = await runUsage(["--fresh"]);
    expect(exitCode).toBe(0);
    const calls = readFileSync(sandbox.calls, "utf8").trim().split("\n");
    expect(calls).toEqual(["usage invalidate", "usage --json"]);
    expect(jsonOk(stdout)).toEqual({ reports: [] });
  });

  test("unbekannte Flags brechen nichts", async () => {
    makeOmp(`printf '%s\\n' "$*" >> "$OMP_CALLS"; echo '{"reports":[]}'`);
    const { exitCode } = await runUsage(["--wat"]);
    expect(exitCode).toBe(0);
    expect(readFileSync(sandbox.calls, "utf8").trim()).toBe("usage --json");
  });
});
