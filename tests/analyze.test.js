// Tests für scripts/analyze.js. Wir bauen jeweils ein temporäres Repo-
// Layout mit minimalen Dateien auf, rufen analyze() darüber auf und
// prüfen, welche Befunde erscheinen. So bleibt das Skript selbst der
// einzige Pfad zur Plugin-Realität — kein Snapshot-Vergleich gegen den
// eigenen Plugin-Tree, der morgen schon wieder anders aussehen kann.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// analyze.js exportiert die internen Helfer nicht; deshalb rufen wir das
// Skript als Subprozess auf und lesen die JSON-Ausgabe. Die `--root`-
// Option ist genau für diesen Fall gebaut. Pfad über import.meta.url statt
// import.meta.dir: Bun:test löst dir in 1.4.x auf das CWD des Aufrufers auf,
// nicht auf das Verzeichnis der Test-Datei.
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(TESTS_DIR);

async function runAnalyzer(root) {
  const script = join(PLUGIN_ROOT, "scripts", "analyze.js");
  const proc = Bun.spawn(["bun", script, "--root=" + root, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(
      "Analyzer lieferte kein JSON. exit=" + exit + " stderr=\n" + err + "\nstdout=\n" + out,
    );
  }
  // Diagnostik: bei fehlgeschlagenen expect() zeigen, was wir wirklich
  // bekommen haben — der Test meldet nur "expected false" ohne Details.
  parsed._debug = { exit, stderr: err };
  return { parsed, exit };
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    // mkdirSync auf den vollen Verzeichnisteil — dirname(rel), nicht den
    // substring-Trunc auf den letzten Slash. Bei Top-Level-Dateien wie
    // `Panel.qml` liefert dirname nur `""` → mkdirSync(root) (no-op);
    // bei `providers/A.js` liefert dirname `providers` → mkdirSync(root/providers).
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(abs, content);
  }
}

function byRule(findings, rule) {
  return findings.filter((f) => f.rule === rule);
}

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omp-quota-analyze-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("analyze.js: sauberes Repo", () => {
  test("echtes Plugin-Repo liefert keine Befunde", async () => {
    const { parsed, exit } = await runAnalyzer(PLUGIN_ROOT);
    expect(parsed.findings).toEqual([]);
    expect(exit).toBe(0);
  });
});

describe("analyze.js: Provider-Registry", () => {
  test("Plugin ohne .import in Providers.js wird gemeldet", async () => {
    writeTree(root, {
      "providers/A.js": `.pragma library\nvar descriptor = { id: "a", name: "A" };\n`,
      "providers/B.js": `.pragma library\nvar descriptor = { id: "b", name: "B" };\n`,
      "Providers.js": `.pragma library\n.import "providers/A.js" as APlugin\nvar PLUGINS = [ APlugin.descriptor ];\nfunction resolve(id) { return null; }\n`,
      "Panel.qml": `import QtQuick\nItem {}\n`,
      "usage.sh": `#!/bin/bash\nset -o pipefail\nOMP=$(command -v omp)\nrun_omp() { "$OMP" "$@"; }\nrun_omp usage --json\n`,
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        id: "t",
        kinds: ["bar-widget"],
        entryPoints: { barWidget: "Panel.qml" },
        barWidget: {
          defaultSection: "right",
          allowMultiple: false,
          defaults: {},
          schema: [],
        },
      }),
    });

    const { parsed, exit } = await runAnalyzer(root);
    const reg = byRule(parsed.findings, "provider-registry");
    expect(reg.some((f) => f.message.includes("B.js"))).toBe(true);
    expect(exit).toBe(1);
  });

  test(".import auf fehlende Datei wird gemeldet", async () => {
    writeTree(root, {
      "Providers.js": `.pragma library\n.import "providers/Missing.js" as MissingPlugin\nvar PLUGINS = [ MissingPlugin.descriptor ];\nfunction resolve(id) { return null; }\n`,
      "Panel.qml": `import QtQuick\nItem {}\n`,
      "usage.sh": `#!/bin/bash\nset -o pipefail\nOMP=$(command -v omp)\nrun_omp() { "$OMP" "$@"; }\nrun_omp usage --json\n`,
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        id: "t",
        kinds: ["bar-widget"],
        entryPoints: { barWidget: "Panel.qml" },
        barWidget: {
          defaultSection: "right",
          allowMultiple: false,
          defaults: {},
          schema: [],
        },
      }),
    });

    const { parsed } = await runAnalyzer(root);
    console.log(JSON.stringify(parsed, null, 2));
    expect(byRule(parsed.findings, "provider-registry").some((f) =>
      f.message.includes("Missing.js"),
    )).toBe(true);
  });
});

describe("analyze.js: Plugin-Disziplin", () => {
  test("Plugin ohne id oder name wird gemeldet", async () => {
    writeTree(root, {
      "providers/A.js": `.pragma library\nvar descriptor = { id: "a" };\n`,
      "Providers.js": `.pragma library\n.import "providers/A.js" as APlugin\nvar PLUGINS = [ APlugin.descriptor ];\nfunction resolve(id) { return null; }\n`,
      "Panel.qml": `import QtQuick\nItem {}\n`,
      "usage.sh": `#!/bin/bash\nset -o pipefail\nOMP=$(command -v omp)\nrun_omp() { "$OMP" "$@"; }\nrun_omp usage --json\n`,
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        id: "t",
        kinds: ["bar-widget"],
        entryPoints: { barWidget: "Panel.qml" },
        barWidget: {
          defaultSection: "right",
          allowMultiple: false,
          defaults: {},
          schema: [],
        },
      }),
    });

    const { parsed } = await runAnalyzer(root);
    const dis = byRule(parsed.findings, "plugin-discipline");
    expect(dis.some((f) => f.message.includes("`name`"))).toBe(true);
  });

  test("Plugin mit strip wird gemeldet (Disziplinbruch)", async () => {
    writeTree(root, {
      "providers/A.js": `.pragma library\nvar descriptor = { id: "a", name: "A", strip: ["x"] };\n`,
      "Providers.js": `.pragma library\n.import "providers/A.js" as APlugin\nvar PLUGINS = [ APlugin.descriptor ];\nfunction resolve(id) { return null; }\n`,
      "Panel.qml": `import QtQuick\nItem {}\n`,
      "usage.sh": `#!/bin/bash\nset -o pipefail\nOMP=$(command -v omp)\nrun_omp() { "$OMP" "$@"; }\nrun_omp usage --json\n`,
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        id: "t",
        kinds: ["bar-widget"],
        entryPoints: { barWidget: "Panel.qml" },
        barWidget: {
          defaultSection: "right",
          allowMultiple: false,
          defaults: {},
          schema: [],
        },
      }),
    });

    const { parsed } = await runAnalyzer(root);
    expect(byRule(parsed.findings, "plugin-discipline").some((f) =>
      f.message.includes("strip"),
    )).toBe(true);
  });
});

describe("analyze.js: Panel.qml-Magic", () => {
  test("font.pixelSize und radius werden als warn gemeldet", async () => {
    writeTree(root, {
      "Panel.qml": `import QtQuick\nText { font.pixelSize: 99; radius: 7; color: "#ff0000" }\n`,
      "usage.sh": `#!/bin/bash\nset -o pipefail\nOMP=$(command -v omp)\nrun_omp() { "$OMP" "$@"; }\nrun_omp usage --json\n`,
      "Providers.js": `.pragma library\nvar PLUGINS = [];\nfunction resolve(id) { return null; }\n`,
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        id: "t",
        kinds: ["bar-widget"],
        entryPoints: { barWidget: "Panel.qml" },
        barWidget: {
          defaultSection: "right",
          allowMultiple: false,
          defaults: {},
          schema: [],
        },
      }),
    });

    const { parsed } = await runAnalyzer(root);
    const hard = byRule(parsed.findings, "panel-hardcoding");
    expect(hard.some((f) => f.message.includes("pixelSize"))).toBe(true);
    expect(hard.some((f) => f.message.includes("radius"))).toBe(true);
    expect(hard.some((f) => f.message.includes("Inline-Farbe"))).toBe(true);
  });
});

describe("analyze.js: usage.sh", () => {
  test("fehlendes set -o pipefail und direkter omp-Aufruf werden gemeldet", async () => {
    writeTree(root, {
      "Panel.qml": `import QtQuick\nItem {}\n`,
      "Providers.js": `.pragma library\nvar PLUGINS = [];\nfunction resolve(id) { return null; }\n`,
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        id: "t",
        kinds: ["bar-widget"],
        entryPoints: { barWidget: "Panel.qml" },
        barWidget: {
          defaultSection: "right",
          allowMultiple: false,
          defaults: {},
          schema: [],
        },
      }),
      "usage.sh": `#!/bin/bash\nOMP=$(command -v omp)\n"$OMP" usage --json\n`,
    });

    const { parsed } = await runAnalyzer(root);
    const sh = byRule(parsed.findings, "usage-sh");
    expect(sh.some((f) => f.message.includes("pipefail"))).toBe(true);
    expect(sh.some((f) => f.message.includes("run_omp"))).toBe(true);
  });
});

describe("analyze.js: Manifest-Bindings", () => {
  test("Setting ohne Referenz in Panel.qml wird gemeldet", async () => {
    writeTree(root, {
      "Panel.qml": `import QtQuick\nItem {}\n`,
      "Providers.js": `.pragma library\nvar PLUGINS = [];\nfunction resolve(id) { return null; }\n`,
      "usage.sh": `#!/bin/bash\nset -o pipefail\nOMP=$(command -v omp)\nrun_omp() { "$OMP" "$@"; }\nrun_omp usage --json\n`,
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        id: "t",
        kinds: ["bar-widget"],
        entryPoints: { barWidget: "Panel.qml" },
        barWidget: {
          defaultSection: "right",
          allowMultiple: false,
          defaults: { orphan: 1 },
          schema: [
            { key: "orphan", type: "integer", defaultValue: 1, min: 0, max: 10, step: 1 },
          ],
        },
      }),
    });

    const { parsed } = await runAnalyzer(root);
    expect(byRule(parsed.findings, "manifest-bindings").some((f) =>
      f.message.includes("orphan"),
    )).toBe(true);
  });
});
