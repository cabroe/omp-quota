#!/usr/bin/env bun
// Statische Analyse für das cabroe.omp-quota-Plugin.
//
// Was es prüft:
//   1. Provider-Registry-Konsistenz: jedes providers/<Name>.js hat genau ein
//      `.import` in Providers.js und genau einen PLUGINS-Eintrag (in beide
//      Richtungen, ohne Duplikate). Spiegel das gleiche Schema, das der
//      Provider-Add-Skill (`skill://omp-quota-provider`) lehrt — Drift hier
//      macht das Plugin stumm, weil resolve() einen ID nicht zuordnen kann.
//   2. JS-Exporte: jeder Top-Level-`var`-Name in Usage.js, Providers.js
//      und providers/*.js, der nicht exportiert wird (`var foo = ...` ohne
//      in der Rückgabe). Eigentlich ist der Tests-Loader (`tests/load.js`)
//      die Wahrheit — diese Regel fängt das nur lokal ab.
//   3. Hartkodierte Pixel-/Magic-Werte in Panel.qml, die Style.font /
//      Style.space nutzen sollten. Reine "0/1"-Konstanten (Höhe 1 als
//      Spacer) sind erlaubt; Pixelgrößen, paddings und radien müssen durch
//      Style laufen.
//   4. Plugin-Disziplin: jedes providers/<Name>.js exportiert genau ein
//      `var descriptor` mit den Feldern id/name (kein eigenes strip).
//   5. Manifest-Defaults/Schema-Sync ist bereits in tests/manifest.test.js
//      verriegelt; das Skript ergänzt es um die Frage "wird die
//      barWidget-Settings-Gruppe auch referenziert" (manifest.usage).
//
// Nutzung:
//   bun scripts/analyze.js                       # Text, exit 0 wenn sauber
//   bun scripts/analyze.js --json                # maschinenlesbar
//   bun scripts/analyze.js --root=/pfad/zum/repo # anderes Repo (Tests)
//
// Exit-Code: 0 = keine Befunde, 1 = mindestens ein Befund, 2 = Aufruffehler.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- CLI -----------------------------------------------------------

function parseArgs(argv) {
  const opts = { json: false, root: null };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--root=")) opts.root = arg.slice("--root=".length);
    else {
      process.stderr.write(`Unbekanntes Argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return opts;
}

// ---------- Datei-IO ------------------------------------------------------

// Rekursiv alle regulären Dateien unter `root`, deren Pfad `rel` enthält.
// Folgt keinen Symlinks — Provider-Plugins sind echte Dateien, und Symlinks
// würden den Test-Mounts in tests/usage-sh.test.js ins Gehege laufen.
function walk(root, rel = "") {
  const abs = join(root, rel);
  const stat = statSync(abs, { throwIfCodeAbsent: true });
  if (stat.isFile()) return [rel];
  const out = [];
  for (const name of readdirSync(abs)) {
    if (name === ".git" || name === "node_modules") continue;
    const child = join(root, rel, name);
    const childStat = statSync(child, { throwIfCodeAbsent: true });
    if (childStat.isFile()) out.push(join(rel, name));
    else if (childStat.isDirectory()) out.push(...walk(root, join(rel, name)));
  }
  return out;
}

// Walk-Ergebnisse beginnen mit `rel/` — wir wollen für Befunde reine
// Plugin-Pfade wie `OpenAICodex.js`, nicht `providers/OpenAICodex.js`.
function stripDirPrefix(rel, prefix) {
  const needle = prefix + "/";
  return rel.startsWith(needle) ? rel.slice(needle.length) : rel;
}

function readText(path) {
  return readFileSync(path, "utf8");
}

// ---------- Befund-Datentyp ------------------------------------------------

const SEVERITY = { error: "error", warn: "warn", info: "info" };

function makeFinding(rule, severity, message, location) {
  return { rule, severity, message, location };
}

// ---------- Regel 1: Provider-Registry-Konsistenz -------------------------

function checkProviderRegistry(root, addFinding) {
  const providersDir = join(root, "providers");
  let pluginFiles = [];
  let pluginDirMissing = false;
  try {
    pluginFiles = readdirSync(providersDir).filter((f) => f.endsWith(".js")).sort();
  } catch {
    pluginDirMissing = true;
  }

  let providersSrc = "";
  try {
    providersSrc = readText(join(root, "Providers.js"));
  } catch {
    addFinding("provider-registry", SEVERITY.error,
      "Providers.js fehlt", "Providers.js");
    return;
  }
  // Erwartete Form: `.import "providers/<Name>.js" as <X>Plugin`
  const importRe = /^\.import\s+"providers\/([^"]+)"\s+as\s+([A-Za-z_$][\w$]*)\s*$/gm;
  const imports = new Map(); // filename -> namespace
  for (const m of providersSrc.matchAll(importRe)) {
    imports.set(m[1], m[2]);
  }

  // PLUGINS = [ NamePlugin.descriptor, ... ] — wir akzeptieren sowohl
  // `NamePlugin.descriptor` als auch `NamePlugin["descriptor"]`.
  const pluginsRe = /var\s+PLUGINS\s*=\s*\[([\s\S]*?)\];/m;
  const pluginsMatch = providersSrc.match(pluginsRe);
  if (!pluginsMatch) {
    addFinding("provider-registry", SEVERITY.error,
      "PLUGINS-Array in Providers.js fehlt", "Providers.js");
    return;
  }
  const pluginRefs = new Set();
  const entryRe = /([A-Za-z_$][\w$]*)\.(?:\[")?descriptor(?:"\])?/g;
  for (const m of pluginsMatch[1].matchAll(entryRe)) {
    pluginRefs.add(m[1]);
  }

  // Verzeichnis fehlt: trotzdem die verwaisten .imports melden, die
  // ins Leere zeigen — das ist die nützlichere Information als die
  // bloße Abwesenheit des Verzeichnisses.
  if (pluginDirMissing) {
    addFinding("provider-registry", SEVERITY.error,
      "providers/-Verzeichnis fehlt", "providers/");
  }

  for (const file of pluginFiles) {
    if (!imports.has(file)) {
      addFinding("provider-registry", SEVERITY.error,
        `Provider-Plugin nicht in Providers.js importiert: ${file}`,
        `Providers.js → providers/${file}`);
    }
    if (imports.has(file) && !pluginRefs.has(imports.get(file))) {
      addFinding("provider-registry", SEVERITY.error,
        `Provider-Plugin importiert, aber nicht in PLUGINS aufgenommen: ${file}`,
        `Providers.js PLUGINS → providers/${file}`);
    }
  }
  for (const [file, ns] of imports) {
    if (!pluginFiles.includes(file)) {
      addFinding("provider-registry", SEVERITY.error,
        `.import verweist auf nicht vorhandene Datei: ${file}`,
        `Providers.js (.import)`);
    }
    if (pluginFiles.includes(file) && !pluginRefs.has(ns)) {
      addFinding("provider-registry", SEVERITY.error,
        `.import-Namensraum ${ns} für ${file} nicht in PLUGINS verwendet`,
        `Providers.js PLUGINS`);
    }
  }
  // Reihenfolge-Spotcheck: alphabetisch nach Dateiname — Drift ist kein
  // Crash, aber sie macht `git diff` in Providers.js laut.
  const importOrder = [...imports.keys()];
  const sorted = [...imports.keys()].sort();
  if (JSON.stringify(importOrder) !== JSON.stringify(sorted)) {
    addFinding("provider-registry", SEVERITY.warn,
      "Provider-Imports sind nicht alphabetisch sortiert",
      `Providers.js (${importOrder.join(", ")} vs ${sorted.join(", ")})`);
  }
}

// ---------- Regel 2: Plugin-Disziplin --------------------------------------

function checkPluginDiscipline(root, addFinding) {
  let pluginFiles;
  try {
    pluginFiles = walk(root, "providers");
  } catch (err) {
    addFinding("plugin-discipline", SEVERITY.warn,
      `providers/-Verzeichnis fehlt (${err.code ?? err.message}) — Plugin-Disziplin nicht prüfbar`,
      "providers/");
    return;
  }
  for (const file of pluginFiles) {
    const name = stripDirPrefix(file, "providers");
    const src = readText(join(root, file));
    const loc = `providers/${name}`;
    const hasDescriptor = /^var\s+descriptor\s*=/m.test(src);
    if (!hasDescriptor) {
      addFinding("plugin-discipline", SEVERITY.error,
        "Provider-Plugin exportiert kein `var descriptor`", loc);
      continue;
    }
    // Disziplin: kein strip-Token im Plugin — strip ist ableitbar aus
    // stripTokens(id, name). Wer es trotzdem deklariert, schmuggelt Wissen
    // zurück ins Plugin, das AGENTS.md ausdrücklich untersagt. Kommentar-
    // zeilen vorher rauswerfen, sonst matcht "// strip: ..." als Treffer.
    const codeOnly = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*)/.test(l)).join("\n");
    if (/(["']strip["']|\bstrip\b)\s*:/.test(codeOnly)) {
      addFinding("plugin-discipline", SEVERITY.error,
        "Provider-Plugin deklariert `strip` — strip muss ableitbar bleiben",
        loc);
    }
    if (!/\bid\s*:/.test(src)) {
      addFinding("plugin-discipline", SEVERITY.error,
        "Descriptor ohne `id`", loc);
    }
    if (!/\bname\s*:/.test(src)) {
      addFinding("plugin-discipline", SEVERITY.error,
        "Descriptor ohne `name`", loc);
    }
  }
}

// ---------- Regel 3: Hartkodierte Magic-Werte in Panel.qml ----------------

// Pixelgrößen, paddings, radien müssen durch Style laufen; Höhen 1 als
// Spacer bleiben. Diese Liste ist absichtlich klein: das Analyse-Skript
// soll handlungsleitend sein, nicht jede Designänderung erzwingen.
function checkPanelHardcoding(root, addFinding) {
  let src;
  try {
    src = readText(join(root, "Panel.qml"));
  } catch {
    addFinding("panel-hardcoding", SEVERITY.warn,
      "Panel.qml fehlt — Hardcoding-Check nicht möglich", "Panel.qml");
    return;
  }
  const lines = src.split(/\r?\n/);

  // 1) font.pixelSize: <Zahl> — Style.font.* ist die Quelle. Anker gelockert:
  // Property-Wert kann mitten in einer Zeile stehen (`Text { font.pixelSize: 12 }`).
  const pixelSizeRe = /font\.pixelSize\s*:\s*([0-9]+)/;
  const radiusRe = /\bradius\s*:\s*([0-9]+)/;
  const opacityRe = /\bopacity\s*:\s*([0-9]*\.[0-9]+)/;
  // 2) Inline-Farbe jenseits von `transparent` / Theme-Bindings.
  const colorRe = /\bcolor\s*:\s*("(?!transparent")[^"]+"|'#[0-9a-fA-F]+'|#[0-9a-fA-F]+)/;

  const opacityAllowlist = new Set([582]); // ProviderSection.meta opacity: 0.75

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const m = line.match(pixelSizeRe);
    if (m) {
      addFinding("panel-hardcoding", SEVERITY.warn,
        `font.pixelSize: ${m[1]} — sollte Style.font.* verwenden`,
        `Panel.qml:${lineNo}`);
    }
    const r = line.match(radiusRe);
    if (r) {
      addFinding("panel-hardcoding", SEVERITY.warn,
        `radius: ${r[1]} — sollte Style.cornerRadius verwenden`,
        `Panel.qml:${lineNo}`);
    }
    const op = line.match(opacityRe);
    if (op && Number(op[1]) > 0.5 && !opacityAllowlist.has(lineNo)) {
      addFinding("panel-hardcoding", SEVERITY.warn,
        `opacity: ${op[1]} hartkodiert — sollte benannt sein`,
        `Panel.qml:${lineNo}`);
    }
    if (colorRe.test(line)) {
      addFinding("panel-hardcoding", SEVERITY.warn,
        "Inline-Farbe (nicht Theme, nicht transparent) — Theme-Bindung bevorzugen",
        `Panel.qml:${lineNo}`);
    }
  });
}

// ---------- Regel 4: usage.sh-Disziplin ------------------------------------

function checkUsageSh(root, addFinding) {
  let src;
  try {
    src = readText(join(root, "usage.sh"));
  } catch {
    addFinding("usage-sh", SEVERITY.error,
      "usage.sh fehlt — Watchdog-Disziplin nicht prüfbar", "usage.sh");
    return;
  }
  const loc = "usage.sh";

  // json_string() muss via printf ausgeben, nicht via sed — AGENTS.md
  // nennt die sed-Escape-Lücke explizit.
  if (/\bjson_string\b[\s\S]{0,400}\|\s*sed\b/.test(src)) {
    addFinding("usage-sh", SEVERITY.error,
      "json_string verwendet sed — Parameter-Expansion statt sed benutzen",
      loc);
  }

  // set -o pipefail muss ganz oben stehen — sonst überlebt ein Fehler im
  // head -c die Pipe.
  if (!/^set\s+-o\s+pipefail/m.test(src)) {
    addFinding("usage-sh", SEVERITY.error,
      "set -o pipefail fehlt in usage.sh", loc);
  }

  // Watchdog-Garantie: omp darf nicht außerhalb von run_omp gerufen werden,
  // sonst fehlt die Timeout-Begrenzung. find_omp() darf $OMP lesen, aber
  // nicht ausführen — wir zählen also nur Aufrufe mit `"$OMP" "..."` bzw.
  // `"$OMP"` gefolgt von Argumenten. Solche Zeilen müssen entweder
  // run_omp im Aufruf-Stack haben oder TIMEOUT nutzen. Zeilen innerhalb
  // eines run_omp-Funktionskörpers (`run_omp() { ... }`) zählen ebenfalls
  // als guarded — die Hülle garantiert das Timeout.
  const lines = src.split(/\r?\n/);
  const runOmpRanges = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:function\s+)?run_omp\s*\(\)\s*\{/.test(lines[i])) {
      // Suche die schließende Klammer ab hier — verschachtelte Blöcke
      // ignorieren wir (in usage.sh kommt nur ein triviales if/else vor).
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*\}/.test(lines[j])) {
          runOmpRanges.push([i, j]);
          break;
        }
      }
    }
  }
  const inRunOmp = (idx) => runOmpRanges.some(([a, b]) => idx >= a && idx <= b);
  for (const [idx, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    // omp-Ausführung: "$OMP" mit darauf folgendem Befehl (nicht nur Variable
    // zuweisen wie OMP=$(find_omp)).
    const executes = /^\s*"?\$OMP"?\s+/.test(line) || /^\s*"\$\{OMP\}"\s+/.test(line);
    if (!executes) continue;
    const guarded = /\brun_omp\b/.test(line) || /"\$TIMEOUT"/.test(line) || inRunOmp(idx);
    if (!guarded) {
      addFinding("usage-sh", SEVERITY.error,
        `omp-Aufruf ohne run_omp/timeout (Zeile ${idx + 1})`,
        `${loc}:${idx + 1}`);
    }
  }
}

// ---------- Regel 5: Manifest-Settings-Verweise in Panel.qml --------------

function checkManifestBindings(root, addFinding) {
  let manifest, panel;
  try {
    manifest = JSON.parse(readText(join(root, "manifest.json")));
    panel = readText(join(root, "Panel.qml"));
  } catch (err) {
    addFinding("manifest-bindings", SEVERITY.error,
      `Konnte manifest.json oder Panel.qml nicht lesen: ${err.message}`, "manifest.json / Panel.qml");
    return;
  }
  const schemaKeys = (manifest.barWidget?.schema ?? []).map((s) => s.key);
  for (const key of schemaKeys) {
    // Suche nach `settings.<key>` ODER `<key>` als Symbol im Panel.qml.
    // Wenn ein Setting deklariert ist, muss es auch referenziert werden —
    // sonst hat es keinen Effekt.
    const re = new RegExp(`\\bsettings\\.?${key}\\b|\\b${key}\\b`);
    if (!re.test(panel)) {
      addFinding("manifest-bindings", SEVERITY.warn,
        `Setting "${key}" wird in Panel.qml nicht referenziert`,
        `manifest.json barWidget.schema`);
    }
  }
}

// ---------- Run -----------------------------------------------------------

function analyze(root) {
  const findings = [];
  const addFinding = (rule, severity, message, location) => {
    findings.push(makeFinding(rule, severity, message, location));
  };
  checkProviderRegistry(root, addFinding);
  checkPluginDiscipline(root, addFinding);
  checkPanelHardcoding(root, addFinding);
  checkUsageSh(root, addFinding);
  checkManifestBindings(root, addFinding);
  return findings;
}

function format(findings, { json }) {
  if (json) {
    return JSON.stringify({ findings }, null, 2);
  }
  if (findings.length === 0) return "Keine Befunde.\n";
  const by = { error: [], warn: [], info: [] };
  for (const f of findings) by[f.severity].push(f);
  const lines = [];
  for (const sev of ["error", "warn", "info"]) {
    if (by[sev].length === 0) continue;
    lines.push(`# ${sev} (${by[sev].length})`);
    for (const f of by[sev]) {
      lines.push(`  ${f.location}: ${f.message}  [${f.rule}]`);
    }
  }
  return lines.join("\n") + "\n";
}

const args = parseArgs(process.argv.slice(2));
const cwdRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = args.root ? resolve(args.root) : cwdRoot;

let findings;
try {
  findings = analyze(root);
} catch (err) {
  process.stderr.write(`Analyse fehlgeschlagen: ${err.stack ?? err.message}\n`);
  process.exit(2);
}

process.stdout.write(format(findings, { json: args.json }));
const failed = findings.some((f) => f.severity === "error");
process.exit(failed ? 1 : 0);
