// Lädt eine QML-`.pragma library`-Datei für `bun test`.
//
// QML-Libraries sind keine ES-Module: `.pragma library` schaltet ein
// Modulverhalten ein, das ECMAScript nicht kennt, und `.import "pfad.js"
// as NS` ist die QML-Direktive, keine ES-`import`-Anweisung. `new
// Function(...)` parst das nicht — die Anweisung wirft einen SyntaxError
// und das Scheitern würde erst beim ersten Aufruf des Imports sichtbar.
// Deshalb muss dieser Loader die `.import`-Zeilen selbst auflösen: jede
// wird rekursiv geladen, ihre Exporte werden per Regex eingesammelt, und
// die Namen werden als lokale Konstanten in den Gültigkeitsbereich der
// importierenden Datei injiziert.
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// tests/ liegt im Plugin-Wurzelverzeichnis; Aufrufer reichen Pfade relativ
// zu tests/ rein, der Loader löst sie gegen den tests/-Pfad auf.
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

// Erkennt Top-Level-`var`/`function`-Exporte. QML-JS-Dialekt, kein ES6:
// nur diese zwei Deklarationsformen kommen laut AGENTS.md vor. `gm`
// wegen Mehrfachvorkommen; `m` würde `\n` zwischen Tokens falsch
// matchen.
const EXPORT_RE = /^(?:var|function)\s+([A-Za-z_$][\w$]*)/gm;

// Eine `.import "pfad.js" as NS`-Direktive. NS folgt den QML-Bezeichner-
// Regeln; wir setzen hier nur die minimale JavaScript-Teilmenge.
const IMPORT_RE = /^\.import\s+"([^"]+)"\s+as\s+([A-Za-z_$][\w$]*)\s*$/gm;

// Lädt eine Library; `dir` ist das Verzeichnis, gegen das relative
// `.import`-Pfade aufgelöst werden. Bei Aufrufern aus tests/ ist `dir`
// der tests/-Pfad; bei transitiven Importen ist `dir` das Verzeichnis
// der importierenden Datei. Memoisation verhindert Endlosschleifen bei
// zyklischen Importen.
function loadInternal(relativePath, dir, cache) {
  const absPath = isAbsolute(relativePath)
    ? relativePath
    : resolve(dir, relativePath);

  if (cache.has(absPath))
    return cache.get(absPath);

  let source = readFileSync(absPath, "utf8");

  // `.pragma library` ist die erste Zeile und nur ein Marker; weg damit.
  source = source.replace(/^\.pragma\s+library\s*\r?\n?/m, "");

  // Erst alle Importe auflösen und als lokale Konstanten einbringen. Wir
  // verarbeiten .import-Zeilen vor jeder anderen Substitution, damit
  // nachfolgende Zeilen die importierten Namen sehen.
  const imports = [];
  source = source.replace(IMPORT_RE, (_, depPath, ns) => {
    const resolved = loadInternal(depPath, dirname(absPath), cache);
    imports.push({ ns, resolved });
    // Platzhalter: der ursprüngliche Import-Ausdruck verschwindet aus dem
    // Funktionskörper, dafür werden die importierten Namen unten als
    // Funktionsargumente eingespeist.
    return "";
  });

  // Top-Level-Exporte einsammeln. Reihenfolge ist irrelevant, weil wir
  // sie unten einzeln als Funktionsrückgabe verpacken.
  const exportNames = [];
  const seen = new Set();
  let match;
  while ((match = EXPORT_RE.exec(source)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      exportNames.push(name);
    }
  }
  EXPORT_RE.lastIndex = 0;

  // JS-Strict-Mode ist QML-Libraries fremd; wir bleiben im Sloppy-Mode,
  // damit die Top-Level-Deklarationen per `var`/`function` wie in QML an
  // das IIFE-Funktionsobjekt gebunden werden.
  const fn = new Function(
    ...imports.map((i) => i.ns),
    source +
      "\nreturn {" +
      exportNames.map((n) => `${n}: ${n}`).join(",") +
      "};",
  );

  const exports = fn(...imports.map((i) => i.resolved));
  cache.set(absPath, exports);
  return exports;
}

// Lädt eine QML-Library und gibt nur die angeforderten Bindings zurück.
// `relativePath` ist relativ zum tests/-Verzeichnis; absolute Pfade sind
// ebenfalls erlaubt. Bei `names` ist jeder Name Pflicht: ein Tippfehler
// wird sofort sichtbar, statt als undefined-Binding unbemerkt durchzulaufen.
export function load(relativePath, names) {
  const cache = new Map();
  const exports = loadInternal(relativePath, TESTS_DIR, cache);
  const out = {};
  for (const name of names)
    out[name] = exports[name];
  return out;
}