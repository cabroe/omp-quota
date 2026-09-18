.pragma library

// Aggregiert die Provider-Plugins zu einer einzigen Lookup-Tabelle. Der
// Kern in `Usage.js` sieht ausschließlich `resolve(id)` und bekommt immer
// einen vollständigen Descriptor zurück — keine nachträgliche Prüfung auf
// fehlende Felder, kein Sonderfall im Kern.
//
// Ein Plugin trägt NUR, was omps Report nicht hergibt:
//
//   - `name`: der Report kennt keinen Anzeigenamen, nur die ID. Das
//     Titelcasing der ID (`fallbackName()`) trifft "Anthropic" und
//     "Google Antigravity", schreibt aber "Zai", "Minimax Code" und
//     "Openai Codex". Ein Plugin gibt es nur für die Provider, deren
//     Schreibweise davon abweicht — die beiden oben brauchen keins.
//   - `unlimitedWindows`: Fenster, die omp aus Anbieterfeldern ableitet,
//     die gar kein Kontingent beschreiben. Im JSON sind sie von einem
//     echten, frisch zurückgesetzten Fenster nicht unterscheidbar
//     (`usedFraction: 0`, `unit: "percent"`, kein `limit`, keine `notes`),
//     also ist das lokales Wissen und keine Ableitung.
//
// Die Strip-Tokens stehen NICHT im Plugin: sie sind aus ID und
// Anzeigenamen ableitbar, siehe `stripTokens()`.
//
// Einen neuen Provider anbinden kostet genau zwei Schritte:
//
//   1. Eine Datei in `providers/<Name>.js` mit `var descriptor = {...}`.
//   2. Hier einen `.import` plus einen Eintrag im `PLUGINS`-Array.
//
// Sortierung der Imports ist alphabetisch nach Dateiname, damit Diffs
// beim Hinzufügen stabil bleiben.

.import "providers/GitHubCopilot.js" as GitHubCopilotPlugin
.import "providers/MinimaxCode.js" as MinimaxCodePlugin
.import "providers/OpenAICodex.js" as OpenAICodexPlugin
.import "providers/OpenRouter.js" as OpenRouterPlugin
.import "providers/Zai.js" as ZaiPlugin

var PLUGINS = [
  GitHubCopilotPlugin.descriptor,
  MinimaxCodePlugin.descriptor,
  OpenAICodexPlugin.descriptor,
  OpenRouterPlugin.descriptor,
  ZaiPlugin.descriptor
];

// Tokens, die aus einem Limit-Label gestrichen werden, weil sie im
// Abschnittstitel schon stehen. Quelle sind ID und Anzeigename, nicht eine
// gepflegte Liste: omps Labels führen den Provider entweder als ID-Wort
// ("ZAI 5 Hours Token Quota" bei `zai`) oder gar nicht ("Claude 5 Hour"
// bei `anthropic`, "General 7 Day" bei `minimax-code`). Eine Handliste war
// deshalb zu 6 von 7 Einträgen tote Konfiguration.
//
// Beide Quellen sind nötig: die ID liefert "zai" für das Label-Token
// "ZAI" (der Strip matcht case-insensitiv), der Anzeigename liefert
// Schreibweisen, die in der ID nicht vorkommen ("Z.ai" mit Punkt).
function stripTokens(id, name) {
  var raw = String(id == null ? "" : id).split(/[-_.]/);
  var words = String(name == null ? "" : name).split(/\s+/);
  for (var w = 0; w < words.length; w++)
    raw.push(words[w]);

  var out = [];
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    var token = raw[i].trim();
    if (token.length === 0)
      continue;
    // Groß-/Kleinschreibung entscheidet beim Strippen nicht, also zählt
    // "zai" neben "ZAI" als derselbe Token und wird nur einmal angewandt.
    var key = token.toLowerCase();
    if (seen[key] === true)
      continue;
    seen[key] = true;
    out.push(token);
  }
  return out;
}

// Vollständige Descriptoren einmal beim Laden bauen: `resolve()` ist damit
// im Normalfall ein Map-Lookup ohne Allokation, und ein Plugin darf jedes
// Feld auslassen, das es nicht braucht.
var BY_ID = {};
for (var p = 0; p < PLUGINS.length; p++) {
  var plugin = PLUGINS[p];
  BY_ID[plugin.id] = {
    id: plugin.id,
    name: plugin.name,
    strip: stripTokens(plugin.id, plugin.name),
    unlimitedWindows: plugin.unlimitedWindows instanceof Array ? plugin.unlimitedWindows : []
  };
}

// Anzeigename für einen Provider ohne Plugin: "some-new-provider" ->
// "Some New Provider". Trenner sind "-", "_" und ".", leere Segmente
// fallen raus, jedes Segment beginnt mit Großbuchstabe. Leere oder
// fehlende ID wird zu "Unbekannt" — der Kern darf sich auf einen
// nicht-leeren Namen verlassen.
function fallbackName(id) {
  var parts = String(id == null ? "" : id).split(/[-_.]/);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].length === 0)
      continue;
    out.push(parts[i].charAt(0).toUpperCase() + parts[i].slice(1));
  }
  return out.length > 0 ? out.join(" ") : "Unbekannt";
}

// Liefert immer einen vollständigen Descriptor. Ohne Plugin greift das
// Titelcasing der ID, ohne Phantom-Fenster und mit den aus der ID
// abgeleiteten Strip-Tokens. Der synthetische Name geht NICHT in die
// Tokens: er ist selbst aus der ID gebaut, und für eine leere ID wäre
// "Unbekannt" ein Token, das in keinem Label vorkommt.
function resolve(id) {
  var key = String(id == null ? "" : id);
  var known = BY_ID[key];
  if (known !== undefined)
    return known;
  return {
    id: key,
    name: fallbackName(key),
    strip: stripTokens(key, ""),
    unlimitedWindows: []
  };
}
