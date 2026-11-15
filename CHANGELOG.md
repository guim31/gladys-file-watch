# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-11-15

### Added

- One device per watched folder or file: number of files, total size, latest
  file and its date, time since the last change, accessible or not.
- Watched paths placed or mounted (NFS, SMB, bind mount) in the folder Gladys
  gives the integration, `/data/watch`; every top-level folder by default, or a
  list of paths.
- Include and exclude glob patterns, a depth limit, a scan interval from 30
  seconds to 1 hour; only names, sizes and dates are read.
- Scene triggers: new file (renames ignored, a batch in one event), folder not
  modified for 1 hour to 7 days, size above 100 MB to 1 TB.
- Scene action "State of a folder", with a ready-made sentence.
- Dashboard widget "Latest files".
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-file-watch/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-file-watch/releases/tag/v1.0.0
