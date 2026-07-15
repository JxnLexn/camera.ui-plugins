## [1.1.5]

- Bugfixes and improvements
- Bump camera.ui engine and SDK

## [1.1.4]

- Bump camera.ui engine and SDK

## [1.1.3]

- Device URLs entered without a scheme (`192.168.1.100` or `192.168.1.100:8080`) no longer fail with `Invalid URL`; a genuinely broken stored URL now logs the offending value instead of a bare TypeError

## [1.1.2]

- Fixed motion/detection events never arriving on cameras that report an internal or wrong address for their event subscription — event polling now always uses the configured host and port
- Debug logging for incoming ONVIF events (topic, parsed motion state, dropped events) — enable the camera's debug log level to trace event delivery

## [1.1.1]

- Bugfixes and improvements

## [1.1.0]

- Bump camera.ui engine to v2

## [1.0.3]

- Bump camera.ui engine

## [1.0.2]

- Bugfixes and improvements

## [1.0.1]

- Bugfixes and improvements

## [1.0.0]

- Initial Release