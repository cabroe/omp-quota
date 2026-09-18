pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Usage.js" as Usage

// Ein Bar-Widget und ein Popup für die Provider-Kontingente, die der
// omp-Agent verwaltet. Die Bar zeigt das knappste Kontingent über alle
// Provider, das Popup jedes einzelne Fenster mit Füllstand und Reset-Zeit.
//
// Datenquelle ist `usage.sh`, das `omp usage --json` PATH-robust aufruft.
// Die komplette Normalisierung steckt in Usage.js.
Panel {
  id: root
  moduleName: "cabroe.omp-quota"
  ipcTarget: "cabroe.omp-quota"

  // Tachometer (nf-fa-dashboard). Als Escape statt als literales Zeichen,
  // damit der Codepoint im Diff lesbar bleibt.
  readonly property string glyph: "\uf0e4"

  // ----------------------------------------------------------- Einstellungen
  //
  // Alle drei kommen aus dem shell.json-Eintrag dieses Widgets und lassen
  // sich mit `omarchy bar set cabroe.omp-quota <key> <value> --json` ändern.
  //
  // Bewusst direkt auf `settings` statt über die geerbte setting()-Funktion:
  // deren Property-Zugriff liegt in Ui/Panel.qml, also registriert ein
  // Binding hier keine Abhängigkeit auf `settings` und behält nach der
  // Injektion durch den Bar-Host seinen Startwert. Direkter Zugriff macht
  // die Bindings reaktiv — so lesen die First-Party-Panels ihre Werte auch.
  readonly property int refreshIntervalSec: {
    var raw = settings ? settings.refreshIntervalSec : undefined
    var value = Number(raw === undefined || raw === null ? 300 : raw)
    return isFinite(value) ? Math.max(60, Math.min(3600, Math.round(value))) : 300
  }
  // Wer früh gewarnt werden will, darf das: die Untergrenze verhindert nur
  // eine Schwelle von 0, die jedes Kontingent dauerhaft rot färben würde.
  readonly property real alarmAt: {
    var raw = settings ? settings.alarmThreshold : undefined
    var value = Number(raw === undefined || raw === null ? 90 : raw)
    if (!isFinite(value))
      return 0.9
    return Math.max(0.05, Math.min(1, value / 100))
  }
  readonly property bool redact: settings ? settings.redact === true : false

  // ------------------------------------------------------------------ Daten
  property var report: ({ error: "", providers: [], worst: -1, generatedAt: NaN })
  property bool loading: false
  property bool loadedOnce: false
  // Ein Abruf läuft und hat noch nichts geliefert. Trennt "wird geladen" von
  // "ist stillschweigend gescheitert".
  property bool pending: false
  // Fehler des letzten Abrufs, getrennt vom Report: so bleiben die Zahlen
  // der letzten erfolgreichen Messung sichtbar, während der Fehler daneben
  // steht. Ein veralteter Stand ist brauchbar, eine leere Liste nicht.
  property string fetchError: ""
  // Eigene Uhr statt Date.now() in Bindings: die Reset-Countdowns müssen
  // sich bewegen, und eine Funktion allein löst keine Neuauswertung aus.
  property double nowMs: Date.now()

  readonly property string errorText: fetchError !== "" ? fetchError : String(report.error || "")
  readonly property bool hasError: errorText !== ""
  readonly property real worst: Number(report.worst)
  readonly property bool alarming: worst >= alarmAt
  readonly property string collector: decodeURIComponent(String(Qt.resolvedUrl("usage.sh")).replace(/^file:\/\//, ""))

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color track: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.14)

  readonly property string barLabel: {
    if (hasError)
      return glyph + " !"
    if (!isFinite(worst) || worst < 0)
      return glyph
    // Eine vertikale Bar ist 28px breit — dort passt nur das Glyph.
    if (bar && bar.vertical)
      return glyph
    return glyph + " " + Math.round(worst * 100) + "%"
  }

  readonly property string barTooltip: {
    if (!isFinite(worst) || worst < 0)
      return hasError ? "omp: " + errorText : "omp-Kontingente"
    var text = "omp: " + Math.round(worst * 100) + "% — " + report.worstProvider + " · " + report.worstTitle
    // Mit Fehler daneben: die Zahl gilt weiter, sie ist nur nicht mehr neu.
    return hasError ? text + " (Stand " + Usage.agoText(report.generatedAt, nowMs) + ", Abruf fehlgeschlagen)" : text
  }

  function colorFor(fraction) {
    return isFinite(fraction) && fraction >= root.alarmAt ? root.urgent : root.foreground
  }

  // `fresh` verwirft zuerst omps Report-Cache, damit die Provider-APIs
  // wirklich neu befragt werden. Ohne das liefert ein Refresh innerhalb des
  // Cache-Fensters dieselben Zahlen zurück.
  function refresh(fresh) {
    if (usageProcess.running)
      return
    var args = [root.collector]
    if (root.redact)
      args.push("--redact")
    if (fresh === true)
      args.push("--fresh")
    usageProcess.command = args
    root.loading = true
    root.pending = true
    watchdog.restart()
    usageProcess.running = true
  }

  function applyReport(raw) {
    var parsed = Usage.parse(raw)
    root.pending = false
    root.loading = false
    watchdog.stop()
    // Ein Fehlerobjekt hat keine Provider — die letzte gute Messung wird
    // dann nicht überschrieben, sondern behalten und der Fehler daneben
    // gezeigt.
    if (String(parsed.error || "") !== "") {
      root.fetchError = parsed.error
      if (!root.loadedOnce)
        root.report = parsed
      return
    }
    root.fetchError = ""
    root.report = parsed
    root.nowMs = Date.now()
    root.loadedOnce = true
  }

  // Ein Abruf, der nichts geliefert hat, muss das sagen statt für immer
  // "wird geladen" anzuzeigen. Quickshell feuert kein onExited, wenn das
  // Programm gar nicht startet (fehlendes oder nicht ausführbares Skript) —
  // dort fällt nur `running` zurück. Deshalb wird hier der Übergang
  // ausgewertet und nicht das Prozessende.
  function failFetch(message) {
    if (!root.pending)
      return
    root.pending = false
    root.loading = false
    watchdog.stop()
    root.fetchError = message
    if (!root.loadedOnce)
      root.report = { error: message, providers: [], worst: -1, generatedAt: NaN }
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Kein Abruf in Component.onCompleted: der Bar-Host injiziert `settings`
  // erst nach der Instanziierung, ein sofortiger Abruf liefe also mit
  // Standardwerten — sichtbar an unredigierten Konten trotz aktiver
  // Redaktion. Ein Tick Verzögerung wartet die Injektion ab.
  Timer {
    interval: 250
    repeat: false
    running: true
    onTriggered: root.refresh(false)
  }

  // Die Redaktion passiert in omp, nicht hier. Ein Wechsel der Einstellung
  // muss darum neu abrufen, sonst stehen die Konten bis zum nächsten
  // Poll-Intervall weiter da.
  onRedactChanged: if (root.loadedOnce) root.refresh(false)

  // Beim Öffnen zeigt das Panel echte Zahlen, nicht den Stand von vorhin.
  // Ein laufender Abruf wird nicht verdoppelt — refresh() prüft `running`.
  onOpenedChanged: {
    if (opened) {
      nowMs = Date.now()
      flick.contentY = 0
      refresh(false)
    }
  }

  Process {
    id: usageProcess
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyReport(text)
    }
    // Läuft nicht mehr, hat aber nichts geliefert: Skript fehlt, ist nicht
    // ausführbar oder wurde abgeschossen. usage.sh selbst meldet seine
    // eigenen Fehler als JSON, die sind hier längst verarbeitet.
    onRunningChanged: if (!running) root.failFetch("usage.sh lieferte keine Ausgabe — Skript fehlt oder ist nicht ausführbar")
  }

  // Deckt den Fall ab, den kein Signal meldet: ein Abruf, der hängt. Die
  // Frist ist großzügig, weil `--fresh` alle Provider-APIs neu befragt.
  Timer {
    id: watchdog
    interval: 45000
    repeat: false
    onTriggered: root.failFetch("omp hat nach 45 s nicht geantwortet")
  }

  Timer {
    id: pollTimer
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    onTriggered: root.refresh(false)
  }

  // Die Countdowns laufen nur, während jemand hinsieht; sonst tickt hier
  // eine Minute lang nichts, was ohnehin niemand liest.
  Timer {
    interval: 30000
    repeat: true
    running: root.opened
    onTriggered: root.nowMs = Date.now()
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.barLabel
    active: root.alarming || root.hasError
    tooltipText: root.barTooltip

    onPressed: function (code) {
      if (code === Qt.RightButton)
        root.refresh(true)
      else if (code === Qt.MiddleButton)
        root.refresh(false)
      else if (root.opened)
        root.close()
      else
        root.open()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onCloseRequested: root.close()
      onTabRequested: function (direction) {
        root.switchPanel(direction)
      }
      onMoveRequested: function (dx, dy) {
        if (dy !== 0)
          flick.scrollBy(dy)
      }
      onActivateRequested: root.refresh(false)
      onTextKey: function (t) {
        if (t === "r")
          root.refresh(false)
        else if (t === "R" || t === "f")
          root.refresh(true)
      }

      Flickable {
        id: flick
        anchors.fill: parent
        contentHeight: content.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        function scrollBy(direction) {
          var step = Style.space(48) * direction
          var max = Math.max(0, contentHeight - height)
          contentY = Math.max(0, Math.min(max, contentY + step))
        }

        Column {
          id: content
          width: flick.width
          spacing: Style.space(12)

          PanelHero {
            title: "Kontingente"
            // Die Zahl bleibt stehen, solange es eine gibt — ein
            // fehlgeschlagener Abruf macht die letzte Messung nicht falsch,
            // nur alt. Das sagt die Fehlerkarte darunter.
            detail: isFinite(root.worst) && root.worst >= 0 ? Math.round(root.worst * 100) + "%" : ""
            meta: {
              if (isFinite(root.worst) && root.worst >= 0)
                return root.report.worstProvider + " · " + root.report.worstTitle
              if (root.hasError)
                return "omp nicht erreichbar"
              if (root.loading)
                return "wird geladen"
              return "keine Kontingente gemeldet"
            }
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconComponent: Component {
              Text {
                textFormat: Text.PlainText
                text: root.glyph
                color: root.alarming || root.hasError ? root.urgent : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }
            }
          }

          // Fehlerkarte. Steht auch dann da, wenn darunter noch Zahlen aus
          // dem letzten guten Abruf stehen — sonst hielte man einen alten
          // Stand für den aktuellen.
          BorderSurface {
            width: parent.width
            visible: root.hasError
            implicitHeight: errorLabel.implicitHeight + Style.space(20)
            color: "transparent"
            radius: Style.cornerRadius
            borderSpec: Border.controlSpec("normal", root.urgent, Color.accent)

            Text {
              id: errorLabel
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(12)
              anchors.rightMargin: Style.space(12)
              text: root.errorText
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
          }

          Repeater {
            model: root.report.providers

            delegate: Column {
              id: providerBlock
              required property var modelData
              width: content.width
              spacing: Style.space(8)

              PanelSeparator {
                foreground: root.foreground
              }

              Row {
                width: parent.width

                PanelSectionHeader {
                  text: providerBlock.modelData.name
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                }

                Item {
                  width: Math.max(0, parent.width - parent.children[0].implicitWidth - providerMeta.implicitWidth)
                  height: 1
                }

                PanelSectionHeader {
                  id: providerMeta
                  text: {
                    var parts = []
                    if (String(providerBlock.modelData.plan || "") !== "")
                      parts.push(providerBlock.modelData.plan)
                    if (String(providerBlock.modelData.account || "") !== "")
                      parts.push(providerBlock.modelData.account)
                    return parts.join(" · ")
                  }
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  font.bold: false
                  opacity: 0.75
                  elide: Text.ElideRight
                  // Der Providername hat Vorrang, wenn der Platz knapp wird.
                  width: Math.min(implicitWidth, parent.width * 0.6)
                }
              }

              Repeater {
                model: providerBlock.modelData.limits

                delegate: LimitRow {
                  required property var modelData
                  width: providerBlock.width
                  limit: modelData
                }
              }
            }
          }

          PanelSeparator {
            foreground: root.foreground
            visible: root.report.providers.length > 0
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: {
              var parts = []
              if (root.loading)
                parts.push("wird aktualisiert")
              else if (isFinite(root.report.generatedAt))
                parts.push("Stand " + Usage.agoText(root.report.generatedAt, root.nowMs))
              if (root.report.disabled > 0)
                parts.push(root.report.disabled + " Zugang deaktiviert")
              if (root.report.withoutUsage > 0)
                parts.push(root.report.withoutUsage + " Konto ohne Daten")
              parts.push("r neu laden · R Cache leeren")
              return parts.join("  ·  ")
            }
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }
      }
    }
  }

  // Eine Kontingentzeile: Titel, Prozent, Meter, Reset-Countdown. Der Meter
  // zeigt den Verbrauch, füllt also in Richtung Limit.
  component LimitRow: Column {
    id: limitRow
    property var limit: null

    readonly property real fraction: limit ? Number(limit.fraction) : -1
    readonly property bool alarming: isFinite(fraction) && fraction >= root.alarmAt
    readonly property string resetText: limit ? Usage.untilText(limit.resetsAt, root.nowMs) : ""

    spacing: Style.space(5)

    Row {
      width: parent.width

      Text {
        id: limitTitle
        textFormat: Text.PlainText
        text: limitRow.limit ? limitRow.limit.title : ""
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        elide: Text.ElideRight
        // Prozent und Reset behalten ihren Platz; ein langer Fenstername
        // weicht zuerst.
        width: Math.min(implicitWidth, Math.max(0, parent.width - limitReset.implicitWidth - limitPercent.implicitWidth - Style.space(12)))
      }

      Item {
        width: Math.max(0, parent.width - limitTitle.width - limitReset.implicitWidth - limitPercent.implicitWidth)
        height: 1
      }

      Text {
        id: limitReset
        textFormat: Text.PlainText
        text: limitRow.resetText !== "" ? limitRow.resetText : ""
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        rightPadding: Style.space(8)
        anchors.baseline: limitTitle.baseline
      }

      Text {
        id: limitPercent
        textFormat: Text.PlainText
        text: limitRow.limit ? limitRow.limit.percentText : "—"
        color: limitRow.alarming ? root.urgent : root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: limitRow.alarming
      }
    }

    Item {
      width: parent.width
      implicitHeight: Math.max(Style.space(4), Math.round(Style.spacing.controlHeight * 0.14))

      Rectangle {
        id: meterTrack
        anchors.fill: parent
        radius: height / 2
        color: root.track
      }

      Rectangle {
        anchors.left: meterTrack.left
        anchors.verticalCenter: meterTrack.verticalCenter
        height: meterTrack.height
        radius: meterTrack.radius
        width: meterTrack.width * Math.max(0, Math.min(1, limitRow.fraction))
        visible: limitRow.fraction >= 0
        color: limitRow.alarming ? root.urgent : root.foreground

        Behavior on width {
          NumberAnimation {
            duration: 160
            easing.type: Easing.OutCubic
          }
        }
      }
    }
  }
}
