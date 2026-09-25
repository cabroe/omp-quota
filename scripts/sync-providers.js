#!/usr/bin/env bun
// Schreibt den Registry-Block in Providers.js (Imports + PLUGINS-Array)
// automatisch aus providers/*.js zusammen. Ein neuer Provider ist damit eine
// einzige Datei plus `bun scripts/sync-providers.js` — die zwei handgeschrie-
// benen Zeilen (Import, PLUGINS-Eintrag) und ihre Tippfehlerfallen entfallen.
//
//   bun scripts/sync-providers.js           Registry-Block neu schreiben
//   bun scripts/sync-providers.js --check   nur prüfen (exit 1 bei Drift),
//                                           nichts schreiben; läuft in CI via
//                                           tests/providers.test.js
//
// Der Block steht zwischen Markern in Providers.js und wird komplett ersetzt;
// alles außerhalb der Marker bleibt unangetastet. Die Descriptoren werden über
// tests/load.js wirklich geladen — ein Plugin ohne id/name oder mit verbotenem
// strip bricht den Sync ab, statt eine kaputte Registry zu schreiben.
//
// Warum ein Generator statt Laufzeit-Autoerkennung: QML-JS-Libraries
// (.pragma library) können keine Verzeichnisse lesen, und dynamic imports
// gibt es im QML-Dialekt nicht. Der statische .import bleibt QML-Pflicht —
// dieser Script macht ihn nur wartungsfrei.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../tests/load.js";

// --root= erlaubt Tests, den Sync gegen ein Temp-Fixture zu fahren
// (dasselbe Muster wie scripts/analyze.js). Default: das echte Plugin.
const rootArg = process.argv.find((a) => a.startsWith("--root="));
const root = rootArg ? rootArg.slice("--root=".length) : dirname(dirname(fileURLToPath(import.meta.url)));
const providersDir = join(root, "providers");
const providersJs = join(root, "Providers.js");

const MARKER_BEGIN = "// >>> provider-plugins >>>";
const MARKER_END = "// <<< provider-plugins <<<";

const checkOnly = process.argv.includes("--check");
const allowed = ["--check", ...(rootArg ? [rootArg] : [])];
if (process.argv.slice(2).some((a) => !allowed.includes(a))) {
  console.error("usage: bun scripts/sync-providers.js [--check] [--root=<dir>]");
  process.exit(2);
}

function fail(message) {
  console.error(`sync-providers: ${message}`);
  process.exit(1);
}

// providers/*.js alphabetisch nach Dateiname — die Reihenfolge, die der
// Analyzer als stable Diffs fordert und der alte Handzustand schon hatte.
const files = readdirSync(providersDir)
  .filter((f) => f.endsWith(".js"))
  .sort();

const entries = [];
for (const file of files) {
  // Absoluter Pfad: load() löst relative Pfade gegen tests/ auf, der Sync
  // aber gegen sein --root — bei Temp-Fixtures sonst die falsche Datei.
  const plugin = load(join(providersDir, file), ["descriptor"]);
  const d = plugin.descriptor;
  if (!d.id || !d.name)
    fail(`providers/${file}: Descriptor braucht id und name.`);
  if ("strip" in d)
    fail(`providers/${file}: strip ist verboten — stripTokens() leitet ab.`);
  // Alias = Dateiname ohne Endung + "Plugin" (GitHubCopilot.js ->
  // GitHubCopilotPlugin). Kollisionen sind ausgeschlossen, weil der Alias
  // 1:1 aus dem eindeutigen Dateinamen entsteht.
  entries.push({ file, alias: file.replace(/\.js$/, "") + "Plugin" });
}

const block = [
  MARKER_BEGIN,
  ...entries.map((e) => `.import "providers/${e.file}" as ${e.alias}`),
  "",
  "var PLUGINS = [",
  ...entries.map((e, i) => `  ${e.alias}.descriptor${i < entries.length - 1 ? "," : ""}`),
  "];",
  MARKER_END,
].join("\n");

const source = readFileSync(providersJs, "utf8");
// Genau ein Paar Marker: eine doppelte Marker-Zeile (z. B. als Diff-
// Vorlage stehen geblieben) würde indexOf zum ersten Vorkommen greifen
// lassen und den echten Block beim Ersetzen herausschneiden — kaputte
// Providers.js, und ein erneuter Lauf heilt das nicht. Deshalb zählen
// statt nur finden, mit einer Meldung, die die Ursache nennt.
const countOf = (marker) =>
  source.split(marker).length - 1;
const beginCount = countOf(MARKER_BEGIN);
const endCount = countOf(MARKER_END);
if (beginCount !== 1)
  fail(
    beginCount === 0
      ? `${MARKER_BEGIN} fehlt in Providers.js.`
      : `${MARKER_BEGIN} steht ${beginCount}× in Providers.js — genau 1 erwartet, doppelte Marker-Zeile entfernen.`,
  );
if (endCount !== 1)
  fail(
    endCount === 0
      ? `${MARKER_END} fehlt in Providers.js.`
      : `${MARKER_END} steht ${endCount}× in Providers.js — genau 1 erwartet, doppelte Marker-Zeile entfernen.`,
  );

const begin = source.indexOf(MARKER_BEGIN);
const end = source.indexOf(MARKER_END);
if (end < begin)
  fail(`Providers.js: ${MARKER_END} steht vor ${MARKER_BEGIN} — Block-Reihenfolge kaputt.`);

const next =
  source.slice(0, begin) + block + source.slice(end + MARKER_END.length);

if (next === source) {
  console.log(`sync-providers: Registry in Sync (${entries.length} Plugins).`);
  process.exit(0);
}
if (checkOnly) {
  console.error(
    "sync-providers: Registry veraltet — `bun scripts/sync-providers.js` ausführen.",
  );
  process.exit(1);
}
writeFileSync(providersJs, next);
console.log(
  `sync-providers: Registry aktualisiert (${entries.length} Plugins): ${entries.map((e) => e.file).join(", ")}`,
);
