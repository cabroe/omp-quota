// Tests für manifest.json: Identität, Entry-Point und die Invariante aus
// AGENTS.md — defaults und schema[] müssen synchron sein (gleiche Keys,
// gleiche defaultValue, min/max wo relevant).
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

describe("manifest.json Identität", () => {
  test("schemaVersion 1 und id == Verzeichnisname", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.id).toBe(basename(ROOT));
  });

  test("Bar-Widget-Form: kinds, entryPoints, Sektion, Mehrfach-Instanzen", () => {
    expect(manifest.kinds).toContain("bar-widget");
    expect(manifest.entryPoints.barWidget).toBe("Panel.qml");
    expect(existsSync(join(ROOT, manifest.entryPoints.barWidget))).toBe(true);
    expect(manifest.barWidget.defaultSection).toBe("right");
    expect(manifest.barWidget.allowMultiple).toBe(false);
  });
});

describe("manifest.json defaults/schema-Sync", () => {
  const defaults = manifest.barWidget.defaults;
  const schema = manifest.barWidget.schema;

  test("defaults und schema decken dieselben Keys ab", () => {
    expect(Object.keys(defaults).sort()).toEqual(
      schema.map((s) => s.key).sort(),
    );
  });

  test("defaultValue je Schema-Eintrag entspricht defaults", () => {
    for (const entry of schema) {
      expect(defaults[entry.key]).toBe(entry.defaultValue);
    }
  });

  test("Integer-Settings haben min/max/step und DefaultValue in den Grenzen", () => {
    for (const entry of schema.filter((s) => s.type === "integer")) {
      expect(entry.min).toBeNumber();
      expect(entry.max).toBeNumber();
      expect(entry.step).toBeNumber();
      expect(entry.min).toBeLessThanOrEqual(entry.defaultValue);
      expect(entry.defaultValue).toBeLessThanOrEqual(entry.max);
      expect(entry.min).toBeLessThan(entry.max);
    }
  });

  test("refreshIntervalSec bleibt panel-tauglich (>= 60 s)", () => {
    const refresh = schema.find((s) => s.key === "refreshIntervalSec");
    expect(refresh.min).toBeGreaterThanOrEqual(60);
  });
});
