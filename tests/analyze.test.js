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

// Basis-Layout für die Abdeckungs-/Skill-Regeln: gültiges Providers.js mit
// echter Ableitung, damit nur der jeweils geprüfte Verstoß übrig bleibt.
function registryFixture(plugins) {
  const files = plugins.map((p) => p.file);
  return {
    "Providers.js":
      `.pragma library\n\n` +
      files.map((f) => `.import "providers/${f}" as ${f.replace(".js", "")}Plugin`).join("\n") +
      `\n\nvar PLUGINS = [\n` +
      files.map((f) => `  ${f.replace(".js", "")}Plugin.descriptor`).join(",\n") +
      `\n];\n\n` +
      `function fallbackName(id) {\n` +
      `  var parts = String(id == null ? "" : id).split(/[-_.]/);\n` +
      `  var out = [];\n` +
      `  for (var i = 0; i < parts.length; i++) {\n` +
      `    if (parts[i].length === 0) continue;\n` +
      `    out.push(parts[i].charAt(0).toUpperCase() + parts[i].slice(1));\n` +
      `  }\n` +
      `  return out.length > 0 ? out.join(" ") : "Unbekannt";\n` +
      `}\n`,
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
    ...Object.fromEntries(plugins.map((p) => [`providers/${p.file}`, p.source])),
  };
}

describe("analyze.js: Provider-Abdeckung", () => {
  test("Plugin, das nur den ableitbaren Namen wiederholt, ist ein Fehler", async () => {
    writeTree(root, registryFixture([
      {
        file: "Anthropic.js",
        // fallbackName("anthropic") === "Anthropic" und keine
        // unlimitedWindows: die Datei ändert nichts an resolve().
        source: `.pragma library\nvar descriptor = { id: "anthropic", name: "Anthropic" };\n`,
      },
    ]));

    const { parsed, exit } = await runAnalyzer(root);
    const cov = byRule(parsed.findings, "provider-coverage");
    expect(cov.some((f) => f.message.includes("anthropic"))).toBe(true);
    expect(exit).toBe(1);
  });

  test("abweichende Schreibweise rechtfertigt das Plugin", async () => {
    writeTree(root, registryFixture([
      {
        file: "Zai.js",
        source: `.pragma library\nvar descriptor = { id: "zai", name: "Z.ai" };\n`,
      },
    ]));

    const { parsed } = await runAnalyzer(root);
    const cov = byRule(parsed.findings, "provider-coverage");
    expect(cov.some((f) => f.message.includes("wiederholt"))).toBe(false);
  });

  test("Phantom-Fenster rechtfertigt das Plugin auch bei ableitbarem Namen", async () => {
    writeTree(root, registryFixture([
      {
        file: "Phantom.js",
        source: `.pragma library\nvar descriptor = { id: "phantom", name: "Phantom", unlimitedWindows: ["7d"] };\n`,
      },
    ]));

    const { parsed } = await runAnalyzer(root);
    expect(byRule(parsed.findings, "provider-coverage").some((f) =>
      f.message.includes("wiederholt"),
    )).toBe(false);
  });
});

describe("analyze.js: Skill", () => {
  test("fehlende Projekt-Skill wird gemeldet", async () => {
    writeTree(root, registryFixture([
      {
        file: "Zai.js",
        source: `.pragma library\nvar descriptor = { id: "zai", name: "Z.ai" };\n`,
      },
    ]));

    const { parsed } = await runAnalyzer(root);
    expect(byRule(parsed.findings, "skill").some((f) =>
      f.message.includes("fehlt"),
    )).toBe(true);
  });

  test("Skill, die eine nicht existierende Funktion nennt, wird gemeldet", async () => {
    const tree = registryFixture([
      {
        file: "Zai.js",
        source: `.pragma library\nvar descriptor = { id: "zai", name: "Z.ai" };\n`,
      },
    ]);
    tree["Usage.js"] = `.pragma library\nfunction parse(raw) { return null; }\nvar unlimitedWindows = 1;\n`;
    tree[".omp/skills/omp-quota-provider/SKILL.md"] =
      `---\nname: omp-quota-provider\ndescription: "x"\n---\n\n` +
      "Ruf `resolve(` und `weggefallen(` auf.\n";
    writeTree(root, tree);

    const { parsed } = await runAnalyzer(root);
    const skill = byRule(parsed.findings, "skill");
    expect(skill.some((f) => f.message.includes("weggefallen"))).toBe(true);
    // `resolve` existiert in diesem Fixture nicht als Deklaration ... doch:
    // Providers.js deklariert es nicht, also muss auch das auffallen.
    expect(skill.some((f) => f.message.includes("resolve"))).toBe(true);
  });

  test("Skill ohne Frontmatter-Namen wird gemeldet", async () => {
    const tree = registryFixture([
      {
        file: "Zai.js",
        source: `.pragma library\nvar descriptor = { id: "zai", name: "Z.ai" };\n`,
      },
    ]);
    tree[".omp/skills/omp-quota-provider/SKILL.md"] = "# Ohne Frontmatter\n";
    writeTree(root, tree);

    const { parsed } = await runAnalyzer(root);
    expect(byRule(parsed.findings, "skill").some((f) =>
      f.message.includes("Frontmatter"),
    )).toBe(true);
  });
});
