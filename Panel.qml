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
  property var report: Usage.failed("")
  property bool loading: false
  property bool loadedOnce: false
  // Ein Abruf läuft und hat noch nichts geliefert. Trennt "wird geladen" von
  // "ist stillschweigend gescheitert" — und entscheidet, ob eine Antwort
  // überhaupt noch erwartet wird.
  property bool pending: false
  // Fehler des letzten Abrufs, getrennt vom Report: so bleiben die Zahlen
  // der letzten erfolgreichen Messung sichtbar, während der Fehler daneben
  // steht. Ein veralteter Stand ist brauchbar, eine leere Liste nicht.
  property string fetchError: ""
  // Eigene Uhr statt Date.now() in Bindings: die Reset-Countdowns müssen
  // sich bewegen, und eine Funktion allein löst keine Neuauswertung aus.
  property double nowMs: Date.now()

  // Eine Anfrage, die während eines laufenden Abrufs kommt, wird gemerkt und
  // danach ausgeführt. Sie fallen zu lassen heißt: Rechtsklick, `R` und ein
  // Wechsel der Redaktion sind im Abrufzeitfenster wirkungslos, ohne dass
  // irgendwas davon sichtbar wird.
  property bool queuedRefresh: false
  property bool queuedFresh: false
  // Mit welcher Redaktionseinstellung der laufende Abruf gestartet wurde.
  // Die Redaktion passiert in omp, also entscheidet der Aufruf, nicht die
  // Anzeige — ein Report von vorher zeigt genau die Konten, die gerade
  // verborgen werden sollen.
  property bool requestRedact: false

  readonly property string errorText: fetchError !== "" ? fetchError : String(report.error || "")
  readonly property bool hasError: errorText !== ""
  readonly property real worst: Number(report.worst)
  readonly property bool exhausted: report.exhausted === true
  readonly property bool alarming: worst >= alarmAt || exhausted
  readonly property string collector: decodeURIComponent(String(Qt.resolvedUrl("usage.sh")).replace(/^file:\/\//, ""))

  // Über den Index statt über das Array iterieren: `report` wird bei jedem
  // Abruf komplett ersetzt, und ein neues Array zerstört jeden Repeater-
  // Delegate. Ein neu gebautes Meter animiert nicht (Behavior greift beim
  // Initialwert nicht) und die Liste baut sich bei jedem Poll neu auf.
  // Index-Identität ist hier tragfähig, weil die Reihenfolge deterministisch
  // und ausdrücklich nicht füllstandsabhängig ist.
  readonly property var providers: report.providers instanceof Array ? report.providers : []
  readonly property int providerCount: providers.length

  function providerAt(index) {
    var list = root.providers
    return index >= 0 && index < list.length ? list[index] : null
  }

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
    // Ein erschöpftes Kontingent ist die Ansage, nicht der Prozentwert: der
    // steht bei 100 % und sagt nicht, dass gerade nichts mehr geht.
    if (exhausted)
      text += " (Kontingent erschöpft)"
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
    if (usageProcess.running) {
      root.queuedRefresh = true
      // `fresh` gewinnt: ein Rechtsklick darf nicht zum normalen Abruf
      // degradieren, nur weil gerade gepollt wurde.
      root.queuedFresh = root.queuedFresh || fresh === true
      return
    }
    // Der Aufruf läuft über /bin/bash statt über das Skript selbst. Damit
    // fällt das Ausführungsbit als Fehlerquelle weg, und der Host macht es
    // an jeder vergleichbaren Stelle genauso.
    var args = ["/bin/bash", root.collector]
    if (root.redact)
      args.push("--redact")
    if (fresh === true)
      args.push("--fresh")
    root.requestRedact = root.redact
    usageProcess.command = args
    root.loading = true
    root.pending = true
    watchdog.restart()
    usageProcess.running = true
  }

  // Die gemerkte Anfrage nachziehen, sobald der Prozess wirklich beendet ist.
  function drainQueue() {
    if (!root.queuedRefresh)
      return
    root.queuedRefresh = false
    var fresh = root.queuedFresh
    root.queuedFresh = false
    root.refresh(fresh)
  }

  function applyReport(raw) {
    // Niemand wartet mehr auf diese Antwort: der Watchdog hat den Abruf
    // abgeschrieben und den Prozess abgeschossen. Was jetzt noch aus der
    // Pipe fällt, ist ein Fragment und darf seine Meldung nicht ersetzen.
    if (!root.pending)
      return

    root.pending = false
    root.loading = false
    watchdog.stop()

    // Zwischen Start und Antwort hat der Bar-Host `redact` gesetzt. Dieser
    // Report zeigt dann die Konten, die verborgen werden sollen — also
    // verwerfen und mit der aktuellen Einstellung neu holen. Die Queue wird
    // dabei geleert: onRedactChanged hat genau diesen Nachzug längst als
    // Anfrage gemerkt, und ihr Eintrag würde nach dem nächsten Prozessende
    // noch einen zweiten, redundanten Abruf mit derselben Einstellung
    // auslösen.
    if (root.requestRedact !== root.redact) {
      root.queuedRefresh = false
      root.queuedFresh = false
      root.refresh(false)
      return
    }

    var parsed = Usage.parse(raw)
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
  // Programm gar nicht startet — dort fällt nur `running` zurück. Deshalb
  // wird der Übergang ausgewertet und nicht das Prozessende.
  function failFetch(message) {
    if (!root.pending)
      return
    root.pending = false
    root.loading = false
    watchdog.stop()
    root.fetchError = message
    if (!root.loadedOnce)
      root.report = Usage.failed(message)
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Der erste Abruf läuft sofort. Der Bar-Host injiziert `settings` erst
  // nach der Instanziierung, aber das braucht keinen geratenen Timer mehr:
  // schaltet die Injektion `redact` ein, verwirft applyReport() den
  // unredigierten Report und holt mit der neuen Einstellung nach.
  Component.onCompleted: root.refresh(false)

  // Die Redaktion passiert in omp, nicht hier. Ein Wechsel der Einstellung
  // muss darum neu abrufen — ohne loadedOnce-Guard, denn genau der hätte
  // die Injektion beim Start ausgesperrt.
  onRedactChanged: root.refresh(false)

  // Beim Öffnen zeigt das Panel echte Zahlen, nicht den Stand von vorhin.
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
    // Läuft nicht mehr, hat aber nichts geliefert: Skript fehlt, /bin/bash
    // fehlt oder der Prozess wurde abgeschossen. usage.sh selbst meldet
    // seine eigenen Fehler als JSON, die sind hier längst verarbeitet.
    onRunningChanged: {
      if (running)
        return
      root.failFetch("Abruf lieferte keine Ausgabe — usage.sh oder /bin/bash fehlt")
      root.drainQueue()
    }
  }

  // Deckt den Fall ab, den kein Signal meldet: ein Abruf, der hängt. Die
  // Frist liegt über dem Limit in usage.sh (20 s), damit im Normalfall das
  // Skript zuerst aufgibt und seinen genaueren Fehler melden kann.
  Timer {
    id: watchdog
    interval: 25000
    repeat: false
    onTriggered: {
      // Erst die Meldung, dann der Kill: der Kill läuft über
      // onRunningChanged, und failFetch() dort würde diese präzise Meldung
      // sonst durch die generische ersetzen.
      root.failFetch("omp hat nach 25 s nicht geantwortet")
      // Ohne den Kill blockiert der Hänger jeden weiteren Abruf für immer,
      // weil refresh() bei laufendem Prozess nur noch in die Queue schreibt.
      usageProcess.running = false
    }
  }

  Timer {
    id: pollTimer
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    onTriggered: root.refresh(false)
  }

  // Die Uhr für die Countdowns tickt, während jemand hinsieht — und im
  // Fehlerfall, weil dann der Tooltip die Alterung des letzten Abrufs
  // nennt. `WidgetButton` liest `tooltipText` genau einmal, bei
  // `onEntered`, und ein Binding auf `nowMs` liefert dort den zuletzt
  // gesetzten Wert: ohne diesen zweiten Fall zeigte der Tooltip die
  // Alterung so an, wie sie beim letzten Öffnen des Popups war. Bewusst
  // über den Zustand statt über ein Hover-Signal — das hinge an der
  // Reihenfolge von `containsMouse` und `entered()` innerhalb von Qt.
  // Sonst tickt hier nichts, was ohnehin niemand liest.
  Timer {
    interval: 30000
    repeat: true
    running: root.opened || root.hasError
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
              if (root.exhausted)
                return "Kontingent erschöpft"
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
            model: root.providerCount

            delegate: Column {
              id: providerBlock
              required property int index

              readonly property var provider: root.providerAt(providerBlock.index)
              readonly property int limitCount: provider && provider.limits instanceof Array ? provider.limits.length : 0

              function limitAt(position) {
                var list = providerBlock.provider ? providerBlock.provider.limits : null
                return list instanceof Array && position >= 0 && position < list.length ? list[position] : null
              }

              width: content.width
              spacing: Style.space(8)
              // Während eines Abrufs, der Provider entfernt, kann der Index
              // kurz ins Leere zeigen.
              visible: providerBlock.provider !== null

              PanelSeparator {
                foreground: root.foreground
              }

              Row {
                width: parent.width

                PanelSectionHeader {
                  text: providerBlock.provider ? providerBlock.provider.name : ""
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
                    var provider = providerBlock.provider
                    if (!provider)
                      return ""
                    var parts = []
                    if (String(provider.plan || "") !== "")
                      parts.push(provider.plan)
                    // Leer, solange alle Provider dasselbe Konto melden —
                    // das steht dann einmal in der Fußzeile.
                    if (String(provider.account || "") !== "")
                      parts.push(provider.account)
                    // Prepaid-Guthaben, mit dem sich ein gesperrtes Fenster
                    // vorzeitig zurücksetzen lässt.
                    if (Number(provider.resetCredits) >= 0)
                      parts.push(Usage.plural(provider.resetCredits, "Reset-Credit", "Reset-Credits"))
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
                model: providerBlock.limitCount

                delegate: LimitRow {
                  required property int index
                  width: providerBlock.width
                  limit: providerBlock.limitAt(index)
                }
              }
            }
          }

          PanelSeparator {
            foreground: root.foreground
            visible: root.providerCount > 0
          }

          // Zustand und Tastenkürzel in getrennten Zeilen, beide umbrechend.
          // Als eine Zeile mit `elide` fiel der Hinweis als erstes weg,
          // sobald ein geteiltes Konto oder ein Zähler dazukam — also genau
          // die Information, die man hier nachschlägt.
          Column {
            width: parent.width
            spacing: Style.space(2)

            Text {
              textFormat: Text.PlainText
              width: parent.width
              visible: text !== ""
              text: {
                var parts = []
                if (root.loading)
                  parts.push("wird aktualisiert")
                else if (isFinite(root.report.generatedAt))
                  parts.push("Stand " + Usage.agoText(root.report.generatedAt, root.nowMs))
                if (String(root.report.sharedAccount || "") !== "")
                  parts.push(root.report.sharedAccount)
                if (root.report.disabled > 0)
                  parts.push(Usage.plural(root.report.disabled, "Zugang deaktiviert", "Zugänge deaktiviert"))
                if (root.report.withoutUsage > 0)
                  parts.push(Usage.plural(root.report.withoutUsage, "Konto ohne Daten", "Konten ohne Daten"))
                return parts.join("  ·  ")
              }
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: "r neu laden · R Cache leeren"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }
        }
      }
    }
  }

  // Eine Kontingentzeile: Titel, Status und Absolutwert, Reset-Countdown,
  // Prozent, Meter. Der Meter zeigt den Verbrauch, füllt also in Richtung
  // Limit.
  component LimitRow: Column {
    id: limitRow
    property var limit: null

    readonly property real fraction: limit ? Number(limit.fraction) : -1
    // Erschöpft heißt erschöpft, unabhängig vom Füllstand: `fraction` ist
    // auf 1 begrenzt und ein überzogenes Kontingent sähe sonst aus wie ein
    // gerade eben volles.
    readonly property bool exhausted: limit ? limit.exhausted === true : false
    readonly property bool alarming: exhausted || (isFinite(fraction) && fraction >= root.alarmAt)
    readonly property string resetText: limit ? Usage.untilText(limit.resetsAt, root.nowMs) : ""
    // Status zuerst, dann der Absolutwert — letzterer nur, wo die Einheit
    // keine Prozent sind und der Prozentwert die Zahl verschweigt.
    readonly property string detailText: {
      if (!limitRow.limit)
        return ""
      var parts = []
      if (String(limitRow.limit.statusLabel || "") !== "")
        parts.push(limitRow.limit.statusLabel)
      if (String(limitRow.limit.amountText || "") !== "")
        parts.push(limitRow.limit.amountText)
      return parts.join(" · ")
    }

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
        // Prozent, Reset und Detail behalten ihren Platz; ein langer
        // Fenstername weicht zuerst.
        width: Math.min(implicitWidth, Math.max(0, parent.width - limitDetail.implicitWidth - limitReset.implicitWidth - limitPercent.implicitWidth - Style.space(12)))
      }

      Item {
        width: Math.max(0, parent.width - limitTitle.width - limitDetail.implicitWidth - limitReset.implicitWidth - limitPercent.implicitWidth)
        height: 1
      }

      Text {
        id: limitDetail
        textFormat: Text.PlainText
        text: limitRow.detailText
        visible: text !== ""
        color: limitRow.exhausted ? root.urgent : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        // Kein Platz reservieren, wenn nichts zu sagen ist.
        rightPadding: text !== "" ? Style.space(8) : 0
        anchors.baseline: limitTitle.baseline
      }

      Text {
        id: limitReset
        textFormat: Text.PlainText
        text: limitRow.resetText
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        rightPadding: text !== "" ? Style.space(8) : 0
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
