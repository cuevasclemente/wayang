import { lstatSync } from "node:fs";

function warning(message) {
  return { level: "warn", message };
}

/**
 * Inspect only conventional Linux user-bus filesystem metadata.
 * Returns null on non-Linux platforms so portable doctor runs stay quiet.
 */
export function diagnoseLinuxUserBus({
  platform = process.platform,
  getUid = process.getuid,
  lstat = lstatSync,
} = {}) {
  if (platform !== "linux") return null;
  if (typeof getUid !== "function") {
    return warning("Linux user bus metadata cannot be checked because the current uid is unavailable");
  }

  const uid = getUid();
  if (!Number.isInteger(uid) || uid < 0) {
    return warning("Linux user bus metadata cannot be checked because the current uid is invalid");
  }

  const runtimeDirectory = `/run/user/${uid}`;
  let runtimeMetadata;
  try {
    runtimeMetadata = lstat(runtimeDirectory);
  } catch {
    return warning(`Linux user runtime directory ${runtimeDirectory} is missing or unreadable`);
  }
  if (!runtimeMetadata.isDirectory()) {
    return warning(`Linux user runtime path ${runtimeDirectory} is not a directory`);
  }
  if (runtimeMetadata.uid !== uid) {
    return warning(`Linux user runtime directory ${runtimeDirectory} is owned by uid ${runtimeMetadata.uid}; expected uid ${uid}`);
  }

  const busPath = `${runtimeDirectory}/bus`;
  let busMetadata;
  try {
    busMetadata = lstat(busPath);
  } catch {
    return warning(`Linux user bus socket ${busPath} is missing or unreadable`);
  }
  if (!busMetadata.isSocket()) {
    return warning(`Linux user bus path ${busPath} is not a Unix socket`);
  }
  if (busMetadata.uid !== uid) {
    return warning(`Linux user bus socket ${busPath} is owned by uid ${busMetadata.uid}; expected uid ${uid}`);
  }

  return {
    level: "ok",
    message: `Linux user bus metadata is present at ${busPath} (owned by uid ${uid})`,
  };
}
