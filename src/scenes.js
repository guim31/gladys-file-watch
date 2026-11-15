// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// "Is the folder accessible?" or "more than 100 files?" are already scene
// conditions on the device features. The action is about what a condition
// cannot do: put the state of a folder in a message ("Backups: 12 files,
// 45 GB, latest: nightly.tar.gz (14/11/26 03:12)"), for any watched path,
// added to Gladys or not. It scans again when the last scan is older than
// 15 seconds.
// -----------------------------------------------------------------------------

export const SCENE_ACTIONS = {
  async get_folder_status(hub, { fields = {} }) {
    return hub.folderStatus(fields.device);
  },
};
