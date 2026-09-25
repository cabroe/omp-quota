// Tests für scripts/sync-providers.js als Subprozess über Temp-Fixtures
// (dasselbe Muster wie tests/analyze.test.js). Verriegelt das
// Selbstheilungs-Verhalten:
//   - Inhaltsdrift zwischen intakten Markern wird zur kanonischen Form
//     zurückgeschrieben.
//   - Strukturelle Markerschäden (doppelt, fehlend) brechen ab, OHNE zu
//     schreiben — ein Ersetzen ab der ersten Marker-Zeile würde sonst den
//     echten Block herausschneiden (echter Bug, inzwischen gefixt).
//   - Ungültige Descriptoren brechen ab, ohne die Registry anzufassen.
import { describe, test, expect, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(repoRoot, "scripts", "sync-providers.js");

const BEGIN = "// >>> provider-plugins >>>";
const END = "// <<< provider-plugins <<<";

const PLUGIN_A = `.pragma library

var descriptor = {
  id: "alpha",
  name: "Alpha"
};
`;

const PLUGIN_B = `.pragma library

var descriptor = {
  id: "beta",
  name: "Beta"
};
`;

// Kanonischer Zustand, den der Sync für zwei Plugins schreiben muss.
function canonical() {
  return [
    BEGIN,
    '.import "providers/A.js" as APlugin',
    '.import "providers/B.js" as BPlugin',
    "",
    "var PLUGINS = [",
    "  APlugin.descriptor,",
    "  BPlugin.descriptor",
    "];",
    END,
    "",
  ].join("\n");
}

let root;
let providersJs;

function fixture(providersJsContent) {
  mkdirSync(join(root, "providers"), { recursive: true });
  writeFileSync(join(root, "providers", "A.js"), PLUGIN_A);
  writeFileSync(join(root, "providers", "B.js"), PLUGIN_B);
  writeFileSync(providersJs, providersJsContent);
}

function runSync(args = []) {
  const result = spawnSync("bun", [SCRIPT, ...args, `--root=${root}`], {
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "quota-sync-"));
  providersJs = join(root, "Providers.js");
});

describe("sync-providers.js", () => {
  test("Inhaltsdrift zwischen intakten Markern heilt zur kanonischen Form", () => {
    // Import und PLUGINS-Eintrag von B hand-editiert entfernt, Reihenfolge
    // verdreht — ein einziger Sync-Lauf muss beides zurückbringen.
    fixture(
      "header\n" +
        BEGIN +
        "\n" +
        '.import "providers/A.js" as APlugin\n' +
        "var PLUGINS = [\n  APlugin.descriptor\n];\n" +
        END +
        "\nrest\n",
    );
    const run = runSync();
    expect(run.status).toBe(0);
    const after = readFileSync(providersJs, "utf8");
    expect(after).toBe("header\n" + canonical() + "rest\n");
    // Idempotenz: ein zweiter Lauf ändert nichts, --check bleibt grün.
    expect(runSync().status).toBe(0);
    expect(runSync(["--check"]).status).toBe(0);
    expect(readFileSync(providersJs, "utf8")).toBe(after);
  });

  test("doppelte BEGIN-Marker: Abbruch ohne Schreiben, Ursache in der Meldung", () => {
    const broken =
      "header\n" + BEGIN + "\n" + BEGIN + "\nvar PLUGINS = [];\n" + END + "\nrest\n";
    fixture(broken);
    const run = runSync();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("2×");
    expect(readFileSync(providersJs, "utf8")).toBe(broken);
  });

  test("fehlender END-Marker: Abbruch ohne Schreiben", () => {
    const broken = "header\n" + BEGIN + "\nvar PLUGINS = [];\n";
    fixture(broken);
    const run = runSync();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("fehlt");
    expect(readFileSync(providersJs, "utf8")).toBe(broken);
  });

  test("Descriptor ohne name: Abbruch, Registry bleibt unangetastet", () => {
    const healthy = "header\n" + canonical() + "rest\n";
    fixture(healthy);
    writeFileSync(
      join(root, "providers", "B.js"),
      ".pragma library\n\nvar descriptor = {\n  id: \"beta\"\n};\n",
    );
    const run = runSync();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("B.js");
    expect(readFileSync(providersJs, "utf8")).toBe(healthy);
  });

  test("Dateiname ohne gültigen QML-Alias: Abbruch ohne Schreiben", () => {
    // `A-B.js` ergab den Alias `A-BPlugin` — in QML eine Subtraktion, also
    // ein Syntaxfehler, der erst nach `omarchy restart shell` aufgefallen
    // wäre. Der Sync muss ihn vorher abfangen.
    const healthy = "header\n" + canonical() + "rest\n";
    fixture(healthy);
    writeFileSync(join(root, "providers", "A-B.js"), PLUGIN_B);
    const run = runSync();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("A-B.js");
    expect(readFileSync(providersJs, "utf8")).toBe(healthy);
    rmSync(join(root, "providers", "A-B.js"));
  });

  test("Verzeichnis mit .js-Endung wird ignoriert, nicht geladen", () => {
    // Ein Verzeichnis `dir.js` ließ load() mit EISDIR und nacktem
    // Stacktrace abstürzen, statt den Sync normal durchlaufen zu lassen.
    fixture("header\n" + canonical() + "rest\n");
    mkdirSync(join(root, "providers", "dir.js"), { recursive: true });
    const run = runSync();
    expect(run.status).toBe(0);
    expect(readFileSync(providersJs, "utf8")).toBe("header\n" + canonical() + "rest\n");
    rmSync(join(root, "providers", "dir.js"), { recursive: true });
  });
});
