# File watch for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that watches folders and files: the scans of a printer, the photos of a phone,
the recordings of a camera, the nightly backup copied to a NAS. Each watched
path becomes a device (files, total size, latest file and its date, time since
the last change, accessible), scenes react to a **new file**, a folder **not
modified for a while** and a size **above a threshold**, and a dashboard
widget lists the latest files. Local only: no cloud, no account.

> Tested for real in a Docker container locked down like the Gladys sandbox
> (creations, deletions, renames, 10,000 files, a folder deleted then created
> again, exclusion patterns), not yet in a real Gladys: feedback welcome in the
> [issues](https://github.com/guim31/gladys-file-watch/issues).

## Requirements

- Gladys Assistant 5.1.0 or later.
- Access to the machine that runs Gladys, to put or mount the folders to watch
  in the watch folder (below).

## Installation

In Gladys: **Integrations → Install from GitHub**, then paste
`https://github.com/guim31/gladys-file-watch`. Then follow the
[documentation](docs/en.md) ([français](docs/fr.md), [Deutsch](docs/de.md),
[español](docs/es.md)).

### Where to put the files

The Gladys supervisor mounts **a single folder of the host** in the container
of an integration, as `/data`, and the manifest cannot ask for another one
(the store schema derives every volume from that folder: no host path is ever
chosen by an integration). So the integration watches `/data/watch`, which is,
with a standard installation:

```
/var/lib/gladysassistant/external-integrations/ext-guim31-gladys-file-watch/watch
```

Write files there directly (a backup tool, a scanner, a Samba share of that
folder), or mount a share (NFS, SMB) or a folder of the host there, read-only,
then restart the integration (the container sees the mounts present at its
start). A symbolic link to a folder outside does not work.

## How it works

The folders are scanned at a regular interval (30 s to 1 h), not watched with
inotify: inotify sees nothing of what another machine writes on an NFS or SMB
share. A scan lists the files (depth limit, glob patterns, symbolic links
skipped) and reads their metadata only. A file is new when its path was not
in the previous scan, unless its inode belonged to a file that disappeared (a
rename), and only if it arrived after the newest file already seen (a share
remounted with its old files announces nothing). The newest arrival and the
thresholds already passed are kept in `/data`: after a restart, the files
arrived meanwhile are announced once.

The devices are published with `should_poll: false`: the container scans on
its own timer and publishes only the values that changed.

## Limits

- Not yet tested in a real Gladys: feedback welcome.
- No choice of a host folder (see above).
- A file created then deleted between two scans is not seen.
- 100,000 files per path (the sandbox has 256 MB), 50 paths.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests run against the fake Gladys of the SDK and real temporary folders.

## Credits

Built from the official
[integration template](https://github.com/GladysAssistant/integration-template-js)
and the [integration SDK](https://github.com/GladysAssistant/integration-sdk-js)
of Gladys Assistant. The structure follows
[guim31/gladys-healthchecks](https://github.com/guim31/gladys-healthchecks).
The folder pictogram of the cover is drawn for this project.

## License

[Apache-2.0](LICENSE)
