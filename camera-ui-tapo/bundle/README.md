# TP-Link Tapo

Lokale TP-Link-Tapo-Integration für camera.ui.

## Unterstützte Funktionen

- Erkennung und Übernahme von Tapo-Kameras über ONVIF/WS-Discovery
- RTSP-Haupt- und Nebenstreams sowie ONVIF-Snapshots
- Native ONVIF-Ereignisse für Bewegung, Personen, Fahrzeuge, Tiere, Gesichter und Audio, sofern das Modell sie bereitstellt
- PTZ-Steuerung, sofern vom Modell über ONVIF angeboten
- Lokale Klingeltastenerkennung für Tapo-Türklingeln und den H200 über UDP-Port 20005
- Bildbasierte Bewegungserkennung als Fallback, wenn ein Gerät wie die D235 keine nutzbaren ONVIF-Bewegungsereignisse veröffentlicht

## Voraussetzungen

In der Tapo-App muss unter **Ich → Tapo Lab → Kompatibilität mit Drittanbietern** die Drittanbieter-Kompatibilität aktiviert sein. Für ONVIF und RTSP wird außerdem ein lokales Kamerakonto benötigt.

Für die Klingeltaste muss der camera.ui-Host UDP-Broadcasts des H200 auf Port 20005 empfangen können. Bei VLANs muss dieser Verkehr gezielt zwischen H200 und camera.ui freigegeben werden. Port 20005 darf nicht ins Internet weitergeleitet werden.

## D235 und H200

Die D235 wird wie jede andere Tapo-Kamera per ONVIF/RTSP übernommen. In den Plugin-Einstellungen wird zusätzlich die IPv4-Adresse des H200 eingetragen. Sie gilt standardmäßig für alle Türklingeln und kann in den Einstellungen des jeweiligen Türklingelsensors überschrieben werden. Ein Paket vom H200 löst anschließend den camera.ui-Türklingelsensor aus.

Der H200 wird dabei absichtlich nicht als leere Kamera angelegt: Das camera.ui-Plugin-SDK besitzt derzeit kein eigenständiges Hub-Gerätemodell. Er arbeitet innerhalb des Plugins als lokale Ereignisquelle für den Türklingelsensor der D235.

Die Einstellung **Quelle der Bewegungserkennung** steht standardmäßig auf `automatic`: Türklingeln wie die D235 verwenden die lokale Videobewegung, weil einige Firmwarestände zwar ONVIF-Ereignisse ankündigen, aber keine zuverlässigen Ereignisse zustellen. Normale Tapo-Kameras verwenden weiterhin ihre nativen ONVIF-Ereignisse. `onvif` und `video` können pro Kamera ausdrücklich erzwungen werden.

Wenn mehrere Türklingeln an demselben H200 hängen, kann die aktuelle Broadcast-Methode sie nicht sicher unterscheiden: Das Referenzverfahren wertet nur die Absenderadresse aus. In diesem Fall würden alle Kameras, die demselben Hub zugeordnet sind, ein Klingelereignis erhalten.

## Grenzen

- Akku- und Solarmodelle können RTSP/ONVIF einschränken oder im Schlafzustand abschalten.
- Die streambasierte Bewegungserkennung erkennt Bildänderungen und besitzt nicht die semantische Genauigkeit der geräteeigenen Tapo-Erkennung.
- Proprietäres Zwei-Wege-Audio, Cloud-Ereignisse, Aufnahmen auf dem H200 und Tapo-Care-Funktionen sind in dieser ersten Version nicht enthalten.

## Installation und Test

Das mit `npm run bundle` erzeugte `bundle.zip` kann über die lokale Plugin-Installation von camera.ui eingespielt werden. Vor dem Wechsel sollten vorhandene ONVIF-Kameras und ihre Zugangsdaten dokumentiert werden; die Kameras müssen anschließend dem Tapo-Plugin zugeordnet oder über dessen Netzwerkerkennung neu übernommen werden.

Für den ersten D235-/H200-Test:

1. In den Plugin-Einstellungen die IPv4-Adresse des H200 eintragen und UDP-Port 20005 beibehalten.
2. Die D235 als Türklingelkamera übernehmen beziehungsweise ihren Kameratyp auf Türklingel setzen.
3. Den Sensor **Tapo-Türklingel** der D235 zuweisen.
4. Für **Tapo-Videobewegung** den camera.ui-Frame-Worker aktivieren und den Sensor zuweisen.
5. Die Klingeltaste drücken und in den Plugin-Protokollen nach dem empfangenen H200-Ereignis suchen.
